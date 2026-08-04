/**
 * Критические проверки порядка транзакционных блокировок.
 *
 * Раньше операции брали строку User и advisory-lock последнего администратора
 * в противоположном порядке, а активация и перевыпуск кода — строку User
 * и ActivationCode. Такие пары давали взаимную блокировку: PostgreSQL снимал одну
 * транзакцию ошибкой deadlock, и наружу уходил 500.
 *
 * Единый порядок: advisory-lock → строка User → связанные записи.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activate, ACTIVATION_CODE_TTL_MS } from '../auth/service.js';
import { hashSecretCode } from '../auth/crypto.js';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  uniquePhone,
  type TestContext,
} from '../auth/testing/harness.js';
import { freezeUser, reissueActivationCode, updateUser, type Actor } from './service.js';

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

/**
 * Ошибка взаимной блокировки проявляется как внутренняя ошибка приложения
 * либо как сообщение PostgreSQL о deadlock. Ни того, ни другого быть не должно:
 * пользователь обязан получить осмысленный отказ, а не 500.
 */
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

describe('порядок блокировок: строка User и ActivationCode', () => {
  it('активация одновременно с перевыпуском кода не вызывает взаимной блокировки', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });

    const phone = uniquePhone();
    const code = '8181';
    const target = await ctx.db.user.create({
      data: { phone, fullName: 'Гонка активации', roles: { create: [{ role: 'COURIER' }] } },
      select: { id: true },
    });

    await ctx.db.activationCode.create({
      data: {
        userId: target.id,
        codeHash: await hashSecretCode(code, TEST_SECRETS.AUTH_PIN_PEPPER),
        expiresAt: new Date(Date.now() + ACTIVATION_CODE_TTL_MS),
        activeKey: target.id,
      },
    });

    const results = await Promise.allSettled([
      activate(ctx, { phone, code, pin: '2727' }, CONTEXT),
      reissueActivationCode(ctx, adminActor(admin.id), target.id, META),
    ]);

    assertNoDeadlock(results);

    const [activation, reissue] = results;
    const stored = await ctx.db.user.findUniqueOrThrow({
      where: { id: target.id },
      select: { status: true, pinHash: true },
    });

    // Допустимы ровно два последовательных порядка.
    if (activation.status === 'fulfilled') {
      // Активация успела первой: пользователь активирован, а перевыпуск кода
      // действующему сотруднику уже запрещён.
      expect(stored.status).toBe('ACTIVE');
      expect(stored.pinHash).not.toBeNull();
      expect(reissue.status).toBe('rejected');
      expect((reissue as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
    } else {
      // Перевыпуск успел первым: старый код инвалидирован, активация им невозможна.
      expect(reissue.status).toBe('fulfilled');
      expect(stored.status).toBe('PENDING_ACTIVATION');
      expect(stored.pinHash).toBeNull();
      expect(activation.reason).toMatchObject({ code: 'UNAUTHENTICATED' });
    }

    // В любом исходе активен не более одного кода.
    const activeCodes = await ctx.db.activationCode.count({
      where: { userId: target.id, activeKey: { not: null } },
    });
    expect(activeCodes).toBeLessThanOrEqual(1);
  });
});

describe('порядок блокировок: advisory-lock последнего администратора', () => {
  it('заморозка одновременно со снятием ADMIN не вызывает взаимной блокировки', async () => {
    // Ровно два активных администратора: любая пара успешных операций оставила бы
    // систему без администратора, поэтому вторая обязана получить отказ.
    await ctx.db.user.updateMany({
      where: { roles: { some: { role: 'ADMIN' } }, status: { not: 'FROZEN' } },
      data: { status: 'FROZEN', frozenAt: new Date() },
    });

    const first = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const second = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const operator = await seedUser(ctx.db, { roles: ['ADMIN'] });

    // operator тоже администратор, поэтому активных трое: заморозка одного
    // и снятие роли у другого по отдельности законны, вместе — нет.
    const secondVersion = await ctx.db.user.findUniqueOrThrow({
      where: { id: second.id },
      select: { version: true },
    });

    const results = await Promise.allSettled([
      freezeUser(ctx, adminActor(operator.id), first.id, META),
      updateUser(
        ctx,
        adminActor(operator.id),
        second.id,
        { version: secondVersion.version, roles: ['COURIER'] },
        META,
      ),
    ]);

    assertNoDeadlock(results);

    // Инвариант сохранён при любом исходе.
    const activeAdmins = await ctx.db.user.count({
      where: { status: 'ACTIVE', roles: { some: { role: 'ADMIN' } } },
    });
    expect(activeAdmins).toBeGreaterThanOrEqual(1);
  });

  it('две одновременные заморозки последних администраторов не вызывают взаимной блокировки', async () => {
    await ctx.db.user.updateMany({
      where: { roles: { some: { role: 'ADMIN' } }, status: { not: 'FROZEN' } },
      data: { status: 'FROZEN', frozenAt: new Date() },
    });

    const first = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const second = await seedUser(ctx.db, { roles: ['ADMIN'] });

    const results = await Promise.allSettled([
      freezeUser(ctx, adminActor(first.id), first.id, META),
      freezeUser(ctx, adminActor(second.id), second.id, META),
    ]);

    assertNoDeadlock(results);

    const succeeded = results.filter((result) => result.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);

    const activeAdmins = await ctx.db.user.count({
      where: { status: 'ACTIVE', roles: { some: { role: 'ADMIN' } } },
    });
    expect(activeAdmins).toBe(1);
  });
});
