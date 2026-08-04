/**
 * Критические проверки гонок между входом и административными операциями.
 *
 * Вход выполняет медленную проверку argon2 вне транзакции. За это время
 * администратор может заморозить пользователя или сбросить ему PIN, отозвав все
 * сессии. Без повторной проверки под блокировкой вход создавал бы новую живую
 * сессию уже после отзыва — и после разморозки она продолжила бы работать.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, logoutAll } from './service.js';
import { hashSecretCode } from './crypto.js';
import { freezeUser, resetPin, type Actor } from '../users/service.js';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from './testing/harness.js';

let ctx: TestContext;

const CONTEXT = { ip: null, userAgent: 'vitest', deviceLabel: null };
const META = { ip: null, userAgent: 'vitest' };

const adminActor = (userId: string): Actor => ({ userId, roles: ['ADMIN'] });

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

/** Взаимная блокировка проявляется как INTERNAL_ERROR или сообщение о deadlock. */
function assertNoDeadlock(results: PromiseSettledResult<unknown>[]): void {
  for (const result of results) {
    if (result.status !== 'rejected') {
      continue;
    }
    const reason = result.reason as { code?: string; message?: string };
    expect(reason.code).not.toBe('INTERNAL_ERROR');
    expect(String(reason.message ?? '').toLowerCase()).not.toContain('deadlock');
  }
}

/** Число сессий пользователя, которые всё ещё действуют. */
async function aliveSessions(userId: string): Promise<number> {
  return ctx.db.refreshSession.count({ where: { userId, revokedAt: null } });
}

async function seedActiveCourier(pin: string) {
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  return seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE', pinHash });
}

describe('вход одновременно с административной операцией', () => {
  it('А. вход одновременно со сбросом PIN не оставляет действующих сессий', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const pin = '1234';
    const user = await seedActiveCourier(pin);

    const results = await Promise.allSettled([
      login(ctx, { phone: user.phone, pin }, CONTEXT),
      resetPin(ctx, adminActor(admin.id), user.id, META),
    ]);

    assertNoDeadlock(results);

    const stored = await ctx.db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { status: true, pinHash: true },
    });

    // Сброс PIN выполняется независимо от исхода входа.
    expect(stored.status).toBe('PENDING_ACTIVATION');
    expect(stored.pinHash).toBeNull();

    // Любой порядок обязан оставить ноль действующих сессий: либо вход отклонён,
    // либо созданная им сессия отозвана сбросом PIN.
    expect(await aliveSessions(user.id)).toBe(0);
  });

  it('Б. вход одновременно с заморозкой не оставляет действующих сессий', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const pin = '5678';
    const user = await seedActiveCourier(pin);

    const results = await Promise.allSettled([
      login(ctx, { phone: user.phone, pin }, CONTEXT),
      freezeUser(ctx, adminActor(admin.id), user.id, META),
    ]);

    assertNoDeadlock(results);

    const stored = await ctx.db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { status: true },
    });

    expect(stored.status).toBe('FROZEN');
    expect(await aliveSessions(user.id)).toBe(0);
  });

  it('вход после заморозки отклоняется и не создаёт сессию', async () => {
    // Детерминированный контрольный случай к сценариям выше.
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const pin = '4321';
    const user = await seedActiveCourier(pin);

    await freezeUser(ctx, adminActor(admin.id), user.id, META);

    await expect(login(ctx, { phone: user.phone, pin }, CONTEXT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(await aliveSessions(user.id)).toBe(0);

    // Успешной попытки входа и аудита не появилось.
    expect(
      await ctx.db.authAttempt.count({ where: { userId: user.id, kind: 'LOGIN', success: true } }),
    ).toBe(0);
    expect(
      await ctx.db.auditLog.count({ where: { entityId: user.id, action: 'AUTH_LOGIN_SUCCEEDED' } }),
    ).toBe(0);
  });
});

describe('выход со всех устройств одновременно со сбросом PIN', () => {
  it('В. не вызывает взаимной блокировки и не оставляет действующих сессий', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const pin = '9090';
    const user = await seedActiveCourier(pin);

    const session = await login(ctx, { phone: user.phone, pin }, CONTEXT);
    expect(await aliveSessions(user.id)).toBe(1);

    const results = await Promise.allSettled([
      logoutAll(ctx, { userId: user.id, roles: ['COURIER'] }, CONTEXT),
      resetPin(ctx, adminActor(admin.id), user.id, META),
    ]);

    assertNoDeadlock(results);

    const stored = await ctx.db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { status: true, pinHash: true },
    });

    // Обе операции самостоятельны и обе обязаны выполниться.
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(stored.status).toBe('PENDING_ACTIVATION');
    expect(stored.pinHash).toBeNull();
    expect(await aliveSessions(user.id)).toBe(0);

    // Токен, выданный до операций, больше не действует.
    expect(session.refreshToken).toBeTruthy();
  });
});
