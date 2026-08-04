/**
 * Критические проверки злоупотребления кодом активации.
 *
 * Код активации предназначен только для первого входа. Если бы им можно было
 * воспользоваться для действующего сотрудника, любой, кто получил код, менял бы
 * чужой PIN в обход администратора и сброса PIN.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activate } from './service.js';
import { hashSecretCode } from './crypto.js';
import { reissueActivationCode } from '../users/service.js';
import { ACTIVATION_CODE_TTL_MS } from './service.js';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  uniquePhone,
  type TestContext,
} from './testing/harness.js';

let ctx: TestContext;

const CONTEXT = { ip: null, userAgent: 'vitest', deviceLabel: null };
const META = { ip: null, userAgent: 'vitest' };

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

/** Создаёт пользователя в ожидании активации с известным кодом. */
async function seedPendingWithCode(code: string) {
  const phone = uniquePhone();
  const user = await ctx.db.user.create({
    data: { phone, fullName: 'Ожидает активации', roles: { create: [{ role: 'COURIER' }] } },
    select: { id: true },
  });

  await ctx.db.activationCode.create({
    data: {
      userId: user.id,
      codeHash: await hashSecretCode(code, TEST_SECRETS.AUTH_PIN_PEPPER),
      expiresAt: new Date(Date.now() + ACTIVATION_CODE_TTL_MS),
      activeKey: user.id,
    },
  });

  return { id: user.id, phone };
}

describe('код активации нельзя применить к действующему сотруднику', () => {
  it('активному пользователю нельзя перевыпустить код активации', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const pinHash = await hashSecretCode('1234', TEST_SECRETS.AUTH_PIN_PEPPER);
    const active = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE', pinHash });

    await expect(
      reissueActivationCode(ctx, { userId: admin.id, roles: ['ADMIN'] }, active.id, META),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // Ни одного активного кода у действующего сотрудника не появилось.
    expect(
      await ctx.db.activationCode.count({ where: { userId: active.id, activeKey: { not: null } } }),
    ).toBe(0);
  });

  it('ожидающему активации пользователю код перевыпускается', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const pending = await seedUser(ctx.db, { roles: ['COURIER'], status: 'PENDING_ACTIVATION' });

    const result = await reissueActivationCode(
      ctx,
      { userId: admin.id, roles: ['ADMIN'] },
      pending.id,
      META,
    );

    expect(result.activationCode).toMatch(/^\d{4}$/);
  });

  it('даже искусственно созданный код не меняет PIN активного пользователя', async () => {
    const pin = '1234';
    const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
    const active = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE', pinHash });

    // Код кладётся в базу напрямую, минуя API: проверяется защита самой активации.
    const code = '4242';
    await ctx.db.activationCode.create({
      data: {
        userId: active.id,
        codeHash: await hashSecretCode(code, TEST_SECRETS.AUTH_PIN_PEPPER),
        expiresAt: new Date(Date.now() + ACTIVATION_CODE_TTL_MS),
        activeKey: active.id,
      },
    });

    await expect(
      activate(ctx, { phone: active.phone, code, pin: '9999' }, CONTEXT),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    // PIN не изменился, статус прежний.
    const stored = await ctx.db.user.findUniqueOrThrow({ where: { id: active.id } });
    expect(stored.status).toBe('ACTIVE');
    expect(stored.pinHash).toBe(pinHash);
  });

  it('замороженному пользователю активация недоступна', async () => {
    const code = '5151';
    const target = await seedPendingWithCode(code);
    await ctx.db.user.update({
      where: { id: target.id },
      data: { status: 'FROZEN', frozenAt: new Date() },
    });

    await expect(
      activate(ctx, { phone: target.phone, code, pin: '1111' }, CONTEXT),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('конкурентная активация одним кодом', () => {
  it('из двух одновременных запросов успешен ровно один', async () => {
    const code = '7373';
    const target = await seedPendingWithCode(code);

    const results = await Promise.allSettled([
      activate(ctx, { phone: target.phone, code, pin: '1212' }, CONTEXT),
      activate(ctx, { phone: target.phone, code, pin: '3434' }, CONTEXT),
    ]);

    const succeeded = results.filter((result) => result.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);

    // Вторая попытка не создала ни сессии, ни успешной записи аудита.
    const sessions = await ctx.db.refreshSession.count({ where: { userId: target.id } });
    expect(sessions).toBe(1);

    const activatedAudit = await ctx.db.auditLog.count({
      where: { entityId: target.id, action: 'USER_ACTIVATED' },
    });
    expect(activatedAudit).toBe(1);

    const successfulAttempts = await ctx.db.authAttempt.count({
      where: { userId: target.id, kind: 'ACTIVATION', success: true },
    });
    expect(successfulAttempts).toBe(1);

    // Код погашен и больше не активен.
    expect(
      await ctx.db.activationCode.count({ where: { userId: target.id, activeKey: { not: null } } }),
    ).toBe(0);
  });
});
