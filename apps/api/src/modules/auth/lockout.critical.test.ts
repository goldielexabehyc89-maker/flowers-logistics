/**
 * Критические проверки прогрессивной блокировки.
 *
 * Проверяется поведение через настоящий сервис и настоящую базу: раньше счётчик
 * обнулялся по истечении блокировки, из-за чего пороги 5, 7 и 10 были недостижимы,
 * а параллельные попытки теряли часть счёта.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login } from './service.js';
import { hashSecretCode } from './crypto.js';
import { phoneKey, registerFailure, resetFailures } from './lockout.js';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from './testing/harness.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

/** Снимает текущую блокировку, сохраняя накопленный счётчик неудач. */
async function expireLock(key: string): Promise<void> {
  await ctx.db.authLockout.update({
    where: { key },
    data: { lockedUntil: new Date(Date.now() - 1000) },
  });
}

async function lockoutOf(key: string) {
  return ctx.db.authLockout.findUniqueOrThrow({
    where: { key },
    select: { failedCount: true, lockedUntil: true },
  });
}

describe('прогрессивная блокировка через реальный сервис', () => {
  it('последовательно достигает всех порогов: 3 → 30 с, 5 → 5 мин, 7 → 30 мин, 10 → 2 ч', async () => {
    const pinHash = await hashSecretCode('1234', TEST_SECRETS.AUTH_PIN_PEPPER);
    const user = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE', pinHash });
    const key = phoneKey(user.phone);
    const context = { ip: null, userAgent: 'vitest', deviceLabel: null };

    const expectations = [
      { attempts: 3, seconds: 30 },
      { attempts: 5, seconds: 5 * 60 },
      { attempts: 7, seconds: 30 * 60 },
      { attempts: 10, seconds: 2 * 60 * 60 },
    ];

    let made = 0;
    for (const stage of expectations) {
      while (made < stage.attempts) {
        // Блокировка снимается по времени, но счётчик обязан сохраняться:
        // иначе, переждав 30 секунд, злоумышленник вечно оставался бы на первом пороге.
        const existing = await ctx.db.authLockout.findUnique({ where: { key } });
        if (existing?.lockedUntil !== null && existing !== null) {
          await expireLock(key);
        }

        await expect(login(ctx, { phone: user.phone, pin: '0000' }, context)).rejects.toThrow();
        made += 1;
      }

      const state = await lockoutOf(key);
      expect(state.failedCount).toBe(stage.attempts);
      expect(state.lockedUntil).not.toBeNull();

      const lockSeconds = Math.round(((state.lockedUntil as Date).getTime() - Date.now()) / 1000);
      // Допуск на время выполнения запросов.
      expect(lockSeconds).toBeGreaterThan(stage.seconds - 20);
      expect(lockSeconds).toBeLessThanOrEqual(stage.seconds + 5);
    }
  });

  it('истечение блокировки не обнуляет счётчик', async () => {
    const pinHash = await hashSecretCode('1234', TEST_SECRETS.AUTH_PIN_PEPPER);
    const user = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE', pinHash });
    const key = phoneKey(user.phone);
    const context = { ip: null, userAgent: 'vitest', deviceLabel: null };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(login(ctx, { phone: user.phone, pin: '0000' }, context)).rejects.toThrow();
    }
    expect((await lockoutOf(key)).failedCount).toBe(3);

    await expireLock(key);
    await expect(login(ctx, { phone: user.phone, pin: '0000' }, context)).rejects.toThrow();

    expect((await lockoutOf(key)).failedCount).toBe(4);
  });

  it('успешный вход сбрасывает счётчик', async () => {
    const pinHash = await hashSecretCode('1234', TEST_SECRETS.AUTH_PIN_PEPPER);
    const user = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE', pinHash });
    const key = phoneKey(user.phone);
    const context = { ip: null, userAgent: 'vitest', deviceLabel: null };

    await expect(login(ctx, { phone: user.phone, pin: '0000' }, context)).rejects.toThrow();
    await login(ctx, { phone: user.phone, pin: '1234' }, context);

    expect(await ctx.db.authLockout.findUnique({ where: { key } })).toBeNull();
  });

  it('параллельные неудачи не теряют счётчик', async () => {
    const key = `phone:+7900${process.hrtime.bigint() % 10_000_000n}`;
    await resetFailures(ctx.db, [key]);

    const attempts = 8;
    await Promise.all(
      Array.from({ length: attempts }, () =>
        ctx.db.$transaction(async (tx) => registerFailure(tx, [key])),
      ),
    );

    // Без сериализации инкремента часть попыток читала бы одно и то же значение
    // и счётчик оказался бы меньше числа попыток.
    expect((await lockoutOf(key)).failedCount).toBe(attempts);
  });
});
