/**
 * Критические проверки транзакционного outbox.
 *
 * Проверяются откат вместе с бизнес-транзакцией, захват без дублирования,
 * повторы с backoff, переход в DEAD, возврат зависших сообщений
 * и идемпотентность обработчика.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { enqueueOutbox, OutboxPayloadLeakError } from './producer.js';
import {
  backoffDelayMs,
  processOutboxOnce,
  recoverStaleMessages,
  sanitizeError,
} from './worker.js';
import type { OutboxHandler } from './worker.js';

let ctx: TestContext;
const logger = pino({ level: 'silent' });

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

function uniqueKey(prefix: string): string {
  return `${prefix}.${process.hrtime.bigint()}`;
}

async function enqueue(
  key: string,
  payload: Record<string, string | number | boolean | null> = {},
) {
  await ctx.db.$transaction(async (tx) =>
    enqueueOutbox(tx, { topic: 'test.ping', idempotencyKey: key, payload }),
  );
}

/** Сколько раз обработчик был вызван именно для этого сообщения. */
function callsFor(handler: { mock: { calls: unknown[][] } }, key: string): number {
  return handler.mock.calls.filter(
    (call) => (call[0] as { idempotencyKey?: string } | undefined)?.idempotencyKey === key,
  ).length;
}

async function messageByKey(key: string) {
  return ctx.db.outboxMessage.findUniqueOrThrow({ where: { idempotencyKey: key } });
}

describe('постановка сообщений', () => {
  it('откат бизнес-транзакции не оставляет сообщения', async () => {
    const key = uniqueKey('rollback');

    await expect(
      ctx.db.$transaction(async (tx) => {
        await enqueueOutbox(tx, { topic: 'test.ping', idempotencyKey: key, payload: {} });
        throw new Error('откат');
      }),
    ).rejects.toThrow();

    expect(await ctx.db.outboxMessage.findUnique({ where: { idempotencyKey: key } })).toBeNull();
  });

  it('повторная постановка того же ключа не создаёт дубликат', async () => {
    const key = uniqueKey('idempotent-enqueue');
    await enqueue(key);
    await enqueue(key);

    expect(await ctx.db.outboxMessage.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it('секретные поля в payload запрещены', async () => {
    await expect(
      ctx.db.$transaction(async (tx) =>
        enqueueOutbox(tx, {
          topic: 'test.ping',
          idempotencyKey: uniqueKey('secret'),
          payload: { token: 'abc' },
        }),
      ),
    ).rejects.toBeInstanceOf(OutboxPayloadLeakError);
  });
});

describe('обработка очереди', () => {
  it('успешная обработка переводит в DONE и фиксирует идемпотентность', async () => {
    const key = uniqueKey('success');
    await enqueue(key, { value: 1 });

    const handler = vi.fn<OutboxHandler>(async () => undefined);
    await processOutboxOnce({ db: ctx.db, logger, handlers: { 'test.ping': handler } });

    const message = await messageByKey(key);
    expect(message.status).toBe('DONE');
    expect(callsFor(handler, key)).toBe(1);

    expect(
      await ctx.db.outboxProcessedMessage.count({
        where: { handlerName: 'test.ping', idempotencyKey: key },
      }),
    ).toBe(1);
  });

  it('обработчик не выполняется дважды для одного ключа идемпотентности', async () => {
    const key = uniqueKey('twice');
    await enqueue(key);

    const handler = vi.fn<OutboxHandler>(async () => undefined);
    await processOutboxOnce({ db: ctx.db, logger, handlers: { 'test.ping': handler } });

    // Сообщение возвращают в очередь вручную: имитация повторной доставки.
    await ctx.db.outboxMessage.update({
      where: { idempotencyKey: key },
      data: { status: 'PENDING', nextAttemptAt: new Date() },
    });
    await processOutboxOnce({ db: ctx.db, logger, handlers: { 'test.ping': handler } });

    expect(callsFor(handler, key)).toBe(1);
    expect((await messageByKey(key)).status).toBe('DONE');
  });

  it('два одновременных прохода не выполняют один обработчик дважды', async () => {
    const key = uniqueKey('concurrent');
    await enqueue(key);

    const handler = vi.fn<OutboxHandler>(async () => undefined);

    // FOR UPDATE SKIP LOCKED: второй проход не увидит захваченное сообщение.
    await Promise.all([
      processOutboxOnce({ db: ctx.db, logger, handlers: { 'test.ping': handler }, workerId: 'a' }),
      processOutboxOnce({ db: ctx.db, logger, handlers: { 'test.ping': handler }, workerId: 'b' }),
    ]);

    expect(callsFor(handler, key)).toBe(1);
  });

  it('ошибка обработчика даёт повтор с растущей задержкой, затем DEAD', async () => {
    const key = uniqueKey('failing');
    await ctx.db.$transaction(async (tx) =>
      enqueueOutbox(tx, {
        topic: 'test.ping',
        idempotencyKey: key,
        payload: { shouldFail: true },
        maxAttempts: 2,
      }),
    );

    const handler: OutboxHandler = async () => {
      throw new Error('подключение postgresql://user:sup3r-s3cret@db:5432/x отклонено');
    };

    // Часы инъецируются: настоящих пауз в тестах нет.
    let now = new Date();
    const deps = { db: ctx.db, logger, handlers: { 'test.ping': handler }, now: () => now };

    await processOutboxOnce(deps);
    const afterFirst = await messageByKey(key);
    expect(afterFirst.status).toBe('ERROR');
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    // Текст ошибки очищен от строки подключения.
    expect(afterFirst.lastError).not.toContain('sup3r-s3cret');

    now = new Date(afterFirst.nextAttemptAt.getTime() + 1000);
    await processOutboxOnce(deps);

    const afterSecond = await messageByKey(key);
    expect(afterSecond.status).toBe('DEAD');
    expect(afterSecond.attempts).toBe(2);
  });

  it('тема без обработчика не выполняется', async () => {
    const key = uniqueKey('no-handler');
    await enqueue(key);

    await processOutboxOnce({ db: ctx.db, logger, handlers: {} });

    const message = await messageByKey(key);
    expect(message.status).not.toBe('DONE');
    expect(message.lastError).toContain('нет обработчика');
  });

  it('зависшее сообщение возвращается в очередь по истечении аренды', async () => {
    const key = uniqueKey('stale');
    await enqueue(key);

    await ctx.db.outboxMessage.update({
      where: { idempotencyKey: key },
      data: {
        status: 'PROCESSING',
        lockedAt: new Date(Date.now() - 10 * 60 * 1000),
        lockedBy: 'умерший-процесс',
      },
    });

    const recovered = await recoverStaleMessages({ db: ctx.db, logger, handlers: {} });
    expect(recovered).toBeGreaterThanOrEqual(1);
    expect((await messageByKey(key)).status).toBe('PENDING');
  });

  it('задержка повторов растёт и ограничена', () => {
    expect(backoffDelayMs(1)).toBeLessThan(backoffDelayMs(3));
    expect(backoffDelayMs(3)).toBeLessThan(backoffDelayMs(6));
    expect(backoffDelayMs(50)).toBe(backoffDelayMs(60));
  });

  it('текст ошибки очищается и ограничивается по длине', () => {
    const message = sanitizeError(new Error(`пароль password=sup3r-s3cret ${'x'.repeat(2000)}`));
    expect(message).not.toContain('sup3r-s3cret');
    expect(message.length).toBeLessThanOrEqual(500);
  });
});

describe('административный доступ к очереди', () => {
  it('только администратор видит ошибки и может повторить отправку', async () => {
    const key = uniqueKey('admin-retry');
    await enqueue(key);
    await ctx.db.outboxMessage.update({
      where: { idempotencyKey: key },
      data: { status: 'DEAD', attempts: 5, lastError: 'ошибка' },
    });

    const message = await messageByKey(key);

    const roles = [
      { roles: ['LOGISTICIAN'] as const, expected: 403 },
      { roles: ['COURIER'] as const, expected: 403 },
      { roles: ['WAREHOUSE'] as const, expected: 403 },
    ];

    for (const variant of roles) {
      const token = await tokenFor([...variant.roles]);
      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/outbox/failures',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.statusCode).toBe(variant.expected);
    }

    const adminToken = await tokenFor(['ADMIN']);
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/outbox/failures',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    // Исходный payload наружу не отдаётся.
    expect(list.body).not.toContain('payload');

    const retry = await ctx.app.inject({
      method: 'POST',
      url: `/api/outbox/failures/${message.id}/retry`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(retry.statusCode).toBe(200);
    expect((await messageByKey(key)).status).toBe('PENDING');

    // Ручной повтор фиксируется в аудите.
    expect(
      await ctx.db.auditLog.count({
        where: { entityType: 'OutboxMessage', action: 'OUTBOX_MESSAGE_RETRIED' },
      }),
    ).toBeGreaterThanOrEqual(1);
  });
});

/** Выдаёт access-токен для роли: вход выполняется через настоящий сервис. */
async function tokenFor(roles: Parameters<typeof seedUser>[1]['roles']): Promise<string> {
  const { hashSecretCode } = await import('../auth/crypto.js');
  const { login } = await import('../auth/service.js');
  const { TEST_SECRETS } = await import('../../platform/testing/secrets.js');

  const pin = '1234';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles, status: 'ACTIVE', pinHash });
  const session = await login(
    ctx,
    { phone: user.phone, pin },
    { ip: null, userAgent: 'vitest', deviceLabel: null },
  );
  return session.accessToken;
}
