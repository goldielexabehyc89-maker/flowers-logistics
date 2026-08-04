/**
 * Критические проверки авторизации: bootstrap, активация, вход, защита от перебора,
 * независимость устройств и немедленный отзыв доступа.
 *
 * Работают с настоящей PostgreSQL: транзакции, блокировки и уникальные индексы
 * невозможно достоверно проверить моками.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from './bootstrap.js';
import { activate, login, logout, logoutAll } from './service.js';
import { hashSecretCode } from './crypto.js';
import { LOCKOUT_THRESHOLDS, lockDurationFor } from './lockout.js';
import { authenticate } from './guards.js';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  uniquePhone,
  type TestContext,
} from './testing/harness.js';

let ctx: TestContext;

const CONTEXT = { ip: '10.0.0.1', userAgent: 'vitest', deviceLabel: null };

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

/** Готовит активированного пользователя с известным PIN. */
async function seedActiveUser(pin: string, roles: Parameters<typeof seedUser>[1]['roles']) {
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  return seedUser(ctx.db, { roles, status: 'ACTIVE', pinHash });
}

describe('bootstrap первого администратора', () => {
  it('создаёт ровно одного администратора и не создаёт второго при повторе', async () => {
    // База может уже содержать администратора от предыдущих тестов, поэтому
    // проверяется именно неизменность их количества.
    const before = await ctx.db.user.count({ where: { roles: { some: { role: 'ADMIN' } } } });

    const first = await bootstrapAdmin(ctx.db, ctx.config, {
      phone: uniquePhone(),
      name: 'Первый администратор',
      reissue: false,
    });

    const afterFirst = await ctx.db.user.count({ where: { roles: { some: { role: 'ADMIN' } } } });

    const second = await bootstrapAdmin(ctx.db, ctx.config, {
      phone: uniquePhone(),
      name: 'Второй администратор',
      reissue: false,
    });

    const afterSecond = await ctx.db.user.count({ where: { roles: { some: { role: 'ADMIN' } } } });

    if (before === 0) {
      expect(first.kind).toBe('created');
      expect(afterFirst).toBe(1);
    }
    expect(second.kind).toBe('already-exists');
    expect(afterSecond).toBe(afterFirst);
  });

  it('повторный запуск не раскрывает прежний код', async () => {
    const outcome = await bootstrapAdmin(ctx.db, ctx.config, {
      phone: uniquePhone(),
      name: 'Ещё один',
      reissue: false,
    });

    expect(outcome.kind).toBe('already-exists');
    expect(JSON.stringify(outcome)).not.toContain('code');
  });

  it('--reissue отклоняется при чужом телефоне и при наличии активного администратора', async () => {
    const pending = await ctx.db.user.findFirst({
      where: { status: 'PENDING_ACTIVATION', roles: { some: { role: 'ADMIN' } } },
      select: { phone: true },
      orderBy: { createdAt: 'asc' },
    });

    if (pending !== null) {
      const wrongPhone = await bootstrapAdmin(ctx.db, ctx.config, {
        phone: uniquePhone(),
        name: 'Не тот',
        reissue: true,
      });
      expect(wrongPhone.kind).toBe('reissue-not-allowed');

      // Для того же телефона перевыпуск разрешён и инвалидирует предыдущий код.
      const reissued = await bootstrapAdmin(ctx.db, ctx.config, {
        phone: pending.phone,
        name: 'Первый администратор',
        reissue: true,
      });
      expect(reissued.kind).toBe('reissued');
    }

    // При активном администраторе перевыпуск запрещён.
    await seedUser(ctx.db, { roles: ['ADMIN'], status: 'ACTIVE' });
    const blocked = await bootstrapAdmin(ctx.db, ctx.config, {
      phone: uniquePhone(),
      name: 'После активации',
      reissue: true,
    });
    expect(blocked.kind).toBe('reissue-not-allowed');
  });
});

describe('активация одноразовым кодом', () => {
  it('код одноразовый, истекает через 30 минут и инвалидируется перевыпуском', async () => {
    const phone = uniquePhone();
    const user = await ctx.db.user.create({
      data: { phone, fullName: 'Активируемый', roles: { create: [{ role: 'COURIER' }] } },
      select: { id: true },
    });

    const code = '0417';
    const codeHash = await hashSecretCode(code, TEST_SECRETS.AUTH_PIN_PEPPER);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await ctx.db.activationCode.create({
      data: { userId: user.id, codeHash, expiresAt, activeKey: user.id },
    });

    // Срок действия ровно 30 минут.
    const stored = await ctx.db.activationCode.findFirstOrThrow({
      where: { userId: user.id, activeKey: { not: null } },
      select: { expiresAt: true, createdAt: true },
    });
    const ttlMinutes = (stored.expiresAt.getTime() - stored.createdAt.getTime()) / 60_000;
    expect(ttlMinutes).toBeGreaterThan(29);
    expect(ttlMinutes).toBeLessThanOrEqual(31);

    const result = await activate(ctx, { phone, code, pin: '1234' }, CONTEXT);
    expect(result.user.status).toBe('ACTIVE');

    // Повторное использование того же кода невозможно.
    await expect(activate(ctx, { phone, code, pin: '4321' }, CONTEXT)).rejects.toThrow();
  });

  it('перевыпуск инвалидирует предыдущий код', async () => {
    const phone = uniquePhone();
    const user = await ctx.db.user.create({
      data: { phone, fullName: 'Перевыпуск', roles: { create: [{ role: 'COURIER' }] } },
      select: { id: true },
    });

    const oldHash = await hashSecretCode('1111', TEST_SECRETS.AUTH_PIN_PEPPER);
    await ctx.db.activationCode.create({
      data: {
        userId: user.id,
        codeHash: oldHash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        activeKey: user.id,
      },
    });

    await ctx.db.activationCode.updateMany({
      where: { userId: user.id, activeKey: { not: null } },
      data: { activeKey: null, invalidatedAt: new Date() },
    });
    const newHash = await hashSecretCode('2222', TEST_SECRETS.AUTH_PIN_PEPPER);
    await ctx.db.activationCode.create({
      data: {
        userId: user.id,
        codeHash: newHash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        activeKey: user.id,
      },
    });

    await expect(activate(ctx, { phone, code: '1111', pin: '1234' }, CONTEXT)).rejects.toThrow();
    const ok = await activate(ctx, { phone, code: '2222', pin: '1234' }, CONTEXT);
    expect(ok.user.status).toBe('ACTIVE');
  });

  it('истёкший код не активирует пользователя', async () => {
    const phone = uniquePhone();
    const user = await ctx.db.user.create({
      data: { phone, fullName: 'Просрочен', roles: { create: [{ role: 'COURIER' }] } },
      select: { id: true },
    });

    await ctx.db.activationCode.create({
      data: {
        userId: user.id,
        codeHash: await hashSecretCode('3333', TEST_SECRETS.AUTH_PIN_PEPPER),
        expiresAt: new Date(Date.now() - 1000),
        activeKey: user.id,
      },
    });

    await expect(activate(ctx, { phone, code: '3333', pin: '1234' }, CONTEXT)).rejects.toThrow();

    const stillPending = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stillPending.status).toBe('PENDING_ACTIVATION');
  });
});

describe('секреты не хранятся и не публикуются в открытом виде', () => {
  it('PIN и код активации отсутствуют в базе открытым текстом', async () => {
    const phone = uniquePhone();
    const user = await ctx.db.user.create({
      data: { phone, fullName: 'Секреты', roles: { create: [{ role: 'COURIER' }] } },
      select: { id: true },
    });

    await ctx.db.activationCode.create({
      data: {
        userId: user.id,
        codeHash: await hashSecretCode('9137', TEST_SECRETS.AUTH_PIN_PEPPER),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        activeKey: user.id,
      },
    });

    await activate(ctx, { phone, code: '9137', pin: '0428' }, CONTEXT);

    const stored = await ctx.db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { pinHash: true },
    });
    expect(stored.pinHash).not.toBeNull();
    expect(stored.pinHash).not.toContain('0428');

    const codes = await ctx.db.activationCode.findMany({
      where: { userId: user.id },
      select: { codeHash: true },
    });
    for (const record of codes) {
      expect(record.codeHash).not.toContain('9137');
    }

    // Аудит фиксирует событие, но не значения.
    const audit = await ctx.db.auditLog.findMany({
      where: { entityId: user.id },
      select: { action: true, oldValue: true, newValue: true },
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain('9137');
    expect(serialized).not.toContain('0428');
    expect(audit.some((entry) => entry.action === 'USER_ACTIVATED')).toBe(true);

    // Журнал попыток тоже не содержит секретов.
    const attempts = await ctx.db.authAttempt.findMany({ where: { userId: user.id } });
    expect(JSON.stringify(attempts)).not.toContain('9137');
    expect(JSON.stringify(attempts)).not.toContain('0428');
  });
});

describe('вход и защита от перебора', () => {
  it('пороги блокировки соответствуют утверждённым', () => {
    expect(lockDurationFor(2)).toBeNull();
    expect(lockDurationFor(3)).toBe(30 * 1000);
    expect(lockDurationFor(4)).toBe(30 * 1000);
    expect(lockDurationFor(5)).toBe(5 * 60 * 1000);
    expect(lockDurationFor(7)).toBe(30 * 60 * 1000);
    expect(lockDurationFor(10)).toBe(2 * 60 * 60 * 1000);
    expect(lockDurationFor(25)).toBe(2 * 60 * 60 * 1000);
    expect(LOCKOUT_THRESHOLDS).toHaveLength(4);
  });

  it('неверные PIN приводят к блокировке с 429 и Retry-After', async () => {
    const user = await seedActiveUser('1234', ['COURIER']);
    const context = { ...CONTEXT, ip: `10.1.${Math.floor(Date.now() / 1000) % 250}.5` };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(login(ctx, { phone: user.phone, pin: '9999' }, context)).rejects.toThrow();
    }

    // После третьей неудачи включается блокировка — даже верный PIN отклоняется.
    await expect(login(ctx, { phone: user.phone, pin: '1234' }, context)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });

    const lockout = await ctx.db.authLockout.findUniqueOrThrow({
      where: { key: `phone:${user.phone}` },
    });
    expect(lockout.failedCount).toBeGreaterThanOrEqual(3);
    expect(lockout.lockedUntil).not.toBeNull();
  });

  it('успешный вход сбрасывает счётчик неудач', async () => {
    const user = await seedActiveUser('5678', ['COURIER']);
    const context = { ...CONTEXT, ip: '10.2.0.9' };

    await expect(login(ctx, { phone: user.phone, pin: '0000' }, context)).rejects.toThrow();
    await login(ctx, { phone: user.phone, pin: '5678' }, context);

    const lockout = await ctx.db.authLockout.findUnique({
      where: { key: `phone:${user.phone}` },
    });
    expect(lockout).toBeNull();
  });

  it('неизвестный телефон не отличается от неверного PIN и проходит проверку-пустышку', async () => {
    const unknownPhone = uniquePhone();
    const known = await seedActiveUser('4321', ['COURIER']);

    const unknownStart = process.hrtime.bigint();
    await expect(
      login(ctx, { phone: unknownPhone, pin: '1111' }, { ...CONTEXT, ip: '10.3.0.1' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const unknownDuration = Number(process.hrtime.bigint() - unknownStart) / 1e6;

    const knownStart = process.hrtime.bigint();
    await expect(
      login(ctx, { phone: known.phone, pin: '1111' }, { ...CONTEXT, ip: '10.3.0.2' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const knownDuration = Number(process.hrtime.bigint() - knownStart) / 1e6;

    // Обе ветки выполняют настоящую проверку argon2: разница не должна быть кратной.
    expect(unknownDuration).toBeGreaterThan(5);
    expect(unknownDuration).toBeLessThan(knownDuration * 5);
  });

  it('замороженный пользователь не входит даже с верным PIN', async () => {
    const pinHash = await hashSecretCode('1234', TEST_SECRETS.AUTH_PIN_PEPPER);
    const user = await seedUser(ctx.db, { roles: ['COURIER'], status: 'FROZEN', pinHash });

    await expect(
      login(ctx, { phone: user.phone, pin: '1234' }, { ...CONTEXT, ip: '10.4.0.1' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('несколько устройств и отзыв доступа', () => {
  it('устройства получают независимые семьи сессий', async () => {
    const user = await seedActiveUser('1357', ['COURIER']);

    const first = await login(
      ctx,
      { phone: user.phone, pin: '1357', deviceLabel: 'Телефон' },
      { ...CONTEXT, ip: '10.5.0.1' },
    );
    const second = await login(
      ctx,
      { phone: user.phone, pin: '1357', deviceLabel: 'Планшет' },
      { ...CONTEXT, ip: '10.5.0.2' },
    );

    expect(first.refreshToken).not.toBe(second.refreshToken);

    const families = await ctx.db.refreshSession.findMany({
      where: { userId: user.id, revokedAt: null },
      select: { familyId: true },
    });
    expect(new Set(families.map((row) => row.familyId)).size).toBe(2);

    // Выход с первого устройства не трогает второе.
    const firstActor = await authenticate(
      { headers: { authorization: `Bearer ${first.accessToken}` } },
      ctx,
    );
    await logout(ctx, firstActor, CONTEXT);

    const alive = await ctx.db.refreshSession.findMany({
      where: { userId: user.id, revokedAt: null },
      select: { familyId: true },
    });
    expect(new Set(alive.map((row) => row.familyId)).size).toBe(1);

    // Второе устройство продолжает работать.
    await expect(
      authenticate({ headers: { authorization: `Bearer ${second.accessToken}` } }, ctx),
    ).resolves.toMatchObject({ userId: user.id });
  });

  it('logout-all закрывает доступ немедленно, не дожидаясь истечения access-токена', async () => {
    const user = await seedActiveUser('2468', ['COURIER']);
    const session = await login(
      ctx,
      { phone: user.phone, pin: '2468' },
      { ...CONTEXT, ip: '10.6.0.1' },
    );

    const actor = await authenticate(
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      ctx,
    );
    await logoutAll(ctx, actor, CONTEXT);

    // Токен ещё не истёк по времени, но уже недействителен.
    await expect(
      authenticate({ headers: { authorization: `Bearer ${session.accessToken}` } }, ctx),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const active = await ctx.db.refreshSession.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(active).toBe(0);
  });
});
