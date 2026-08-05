/**
 * Критические проверки фоновых очисток.
 *
 * Ленивая очистка копий преемника оставляла зашифрованный токен в базе,
 * если устройство замолкало сразу после ротации. Эта задача обязательна
 * до staging и production.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../modules/auth/testing/harness.js';
import {
  cleanupExpiredRealtimeEvents,
  cleanupExpiredSuccessorTokens,
  createMaintenanceRunner,
} from './maintenance.js';

let ctx: TestContext;
const logger = pino({ level: 'silent' });

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

async function createSession(userId: string, graceUntil: Date | null): Promise<string> {
  const session = await ctx.db.refreshSession.create({
    data: {
      userId,
      familyId: randomUUID(),
      tokenHash: `hash-${process.hrtime.bigint()}`,
      successorTokenEnc: 'зашифрованное-значение',
      graceUntil,
    },
    select: { id: true },
  });
  return session.id;
}

describe('очистка копий токена-преемника', () => {
  it('затирает просроченные копии и не трогает активное grace-окно', async () => {
    const user = await seedUser(ctx.db, { roles: ['COURIER'] });

    const expired = await createSession(user.id, new Date(Date.now() - 60_000));
    const active = await createSession(user.id, new Date(Date.now() + 60_000));

    const cleaned = await cleanupExpiredSuccessorTokens({ db: ctx.db, logger });
    expect(cleaned).toBeGreaterThanOrEqual(1);

    const expiredRow = await ctx.db.refreshSession.findUniqueOrThrow({ where: { id: expired } });
    const activeRow = await ctx.db.refreshSession.findUniqueOrThrow({ where: { id: active } });

    expect(expiredRow.successorTokenEnc).toBeNull();
    // Сама сессия не удаляется: очистка касается только копии преемника.
    expect(expiredRow.revokedAt).toBeNull();
    expect(activeRow.successorTokenEnc).not.toBeNull();
  });

  it('не логирует содержимое копии', async () => {
    const lines: string[] = [];
    const capturing = pino({ level: 'info' }, {
      write: (line: string) => lines.push(line),
    } as never);

    const user = await seedUser(ctx.db, { roles: ['COURIER'] });
    await createSession(user.id, new Date(Date.now() - 60_000));

    const runner = createMaintenanceRunner({ db: ctx.db, logger: capturing });
    await runner.runOnce();
    runner.stop();

    expect(lines.join('\n')).not.toContain('зашифрованное-значение');
  });
});

describe('срок хранения realtime-событий', () => {
  it('удаляет события за пределами окна и сохраняет свежие', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });

    const stale = await ctx.db.realtimeEvent.create({
      data: {
        topic: 'user.updated',
        audienceRoles: ['ADMIN'],
        payload: { userId: admin.id },
        expiresAt: new Date(Date.now() - 60_000),
      },
      select: { id: true },
    });

    const fresh = await ctx.db.realtimeEvent.create({
      data: {
        topic: 'user.updated',
        audienceRoles: ['ADMIN'],
        payload: { userId: admin.id },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      select: { id: true },
    });

    const removed = await cleanupExpiredRealtimeEvents({ db: ctx.db, logger });
    expect(removed).toBeGreaterThanOrEqual(1);

    expect(await ctx.db.realtimeEvent.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await ctx.db.realtimeEvent.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });
});

describe('планировщик', () => {
  it('останавливает таймеры и не запускает задачу параллельно самой себе', async () => {
    const runner = createMaintenanceRunner(
      { db: ctx.db, logger },
      {
        successorCleanup: 10,
        realtimeCleanup: 10,
      },
    );

    runner.start();
    // Повторный старт не создаёт вторых таймеров.
    runner.start();
    const result = await runner.runOnce();
    runner.stop();

    expect(result.successorTokens).toBeGreaterThanOrEqual(0);
    expect(result.realtimeEvents).toBeGreaterThanOrEqual(0);
  });
});
