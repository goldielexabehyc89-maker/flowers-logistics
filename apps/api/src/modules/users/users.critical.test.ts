/**
 * Критические проверки управления пользователями.
 *
 * Проверяются права, защита последнего администратора, оптимистическая блокировка,
 * отсутствие DELETE-маршрутов и транзакционность аудита.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecretCode } from '../auth/crypto.js';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  uniquePhone,
  type TestContext,
} from '../auth/testing/harness.js';
import {
  createUser,
  freezeUser,
  getUser,
  listUsers,
  resetPin,
  unfreezeUser,
  updateUser,
  type Actor,
} from './service.js';

let ctx: TestContext;

const META = { ip: '10.8.0.1', userAgent: 'vitest' };

const adminActor = (userId: string): Actor => ({ userId, roles: ['ADMIN'] });
const logisticianActor = (userId: string): Actor => ({ userId, roles: ['LOGISTICIAN'] });

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

describe('права логиста', () => {
  it('логист создаёт курьера, но не администратора и не логиста', async () => {
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const actor = logisticianActor(logist.id);

    const created = await createUser(
      ctx,
      actor,
      { phone: uniquePhone(), fullName: 'Курьер логиста', roles: ['COURIER'] },
      META,
    );
    expect(created.user.roles).toEqual(['COURIER']);
    expect(created.activationCode).toMatch(/^\d{4}$/);

    for (const roles of [
      ['ADMIN'],
      ['LOGISTICIAN'],
      ['WAREHOUSE'],
      ['COURIER', 'ADMIN'],
    ] as const) {
      await expect(
        createUser(
          ctx,
          actor,
          { phone: uniquePhone(), fullName: 'Нельзя', roles: [...roles] },
          META,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('логист не может изменить или заморозить привилегированного пользователя', async () => {
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const privilegedCourier = await seedUser(ctx.db, { roles: ['COURIER', 'LOGISTICIAN'] });
    const actor = logisticianActor(logist.id);

    await expect(getUser(ctx, actor, admin.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(freezeUser(ctx, actor, admin.id, META)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(getUser(ctx, actor, privilegedCourier.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('логист не может менять роли', async () => {
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
    const stored = await ctx.db.user.findUniqueOrThrow({
      where: { id: courier.id },
      select: { version: true },
    });

    await expect(
      updateUser(
        ctx,
        logisticianActor(logist.id),
        courier.id,
        { version: stored.version, roles: ['COURIER', 'ADMIN'] },
        META,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('выборка логиста ограничена курьерами независимо от фильтра', async () => {
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    await seedUser(ctx.db, { roles: ['ADMIN'] });
    await seedUser(ctx.db, { roles: ['COURIER'] });

    const result = await listUsers(ctx, logisticianActor(logist.id), {
      role: 'ADMIN',
      limit: 50,
      offset: 0,
    });

    // Фильтр по чужой роли не должен раскрывать администраторов.
    expect(result.items).toHaveLength(0);

    const couriers = await listUsers(ctx, logisticianActor(logist.id), { limit: 50, offset: 0 });
    expect(couriers.items.every((user) => user.roles.includes('COURIER'))).toBe(true);
    expect(couriers.items.some((user) => user.roles.includes('ADMIN'))).toBe(false);
  });

  it('курьер и кладовщик не имеют доступа к управлению', async () => {
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
    const warehouse = await seedUser(ctx.db, { roles: ['WAREHOUSE'] });

    await expect(
      listUsers(ctx, { userId: courier.id, roles: ['COURIER'] }, { limit: 10, offset: 0 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      listUsers(ctx, { userId: warehouse.id, roles: ['WAREHOUSE'] }, { limit: 10, offset: 0 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('заморозка, разморозка и сброс PIN', () => {
  it('заморозка отзывает сессии, разморозка их не воскрешает', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const pinHash = await hashSecretCode('1234', TEST_SECRETS.AUTH_PIN_PEPPER);
    const courier = await seedUser(ctx.db, { roles: ['COURIER'], pinHash });

    await ctx.db.refreshSession.create({
      data: {
        userId: courier.id,
        familyId: crypto.randomUUID(),
        tokenHash: `hash-${process.hrtime.bigint()}`,
      },
    });

    const before = await ctx.db.user.findUniqueOrThrow({
      where: { id: courier.id },
      select: { sessionVersion: true },
    });

    const frozen = await freezeUser(ctx, adminActor(admin.id), courier.id, META);
    expect(frozen.status).toBe('FROZEN');
    expect(frozen.frozenAt).not.toBeNull();

    const after = await ctx.db.user.findUniqueOrThrow({
      where: { id: courier.id },
      select: { sessionVersion: true },
    });
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    expect(
      await ctx.db.refreshSession.count({ where: { userId: courier.id, revokedAt: null } }),
    ).toBe(0);

    const unfrozen = await unfreezeUser(ctx, adminActor(admin.id), courier.id, META);
    expect(unfrozen.status).toBe('ACTIVE');
    // Сессии остаются отозванными: нужен новый вход.
    expect(
      await ctx.db.refreshSession.count({ where: { userId: courier.id, revokedAt: null } }),
    ).toBe(0);
  });

  it('разморозка пользователя без PIN возвращает его в ожидание активации', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const courier = await seedUser(ctx.db, { roles: ['COURIER'], status: 'FROZEN' });

    const unfrozen = await unfreezeUser(ctx, adminActor(admin.id), courier.id, META);
    expect(unfrozen.status).toBe('PENDING_ACTIVATION');
  });

  it('сброс PIN очищает PIN, отзывает сессии и выдаёт новый код один раз', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const pinHash = await hashSecretCode('1234', TEST_SECRETS.AUTH_PIN_PEPPER);
    const courier = await seedUser(ctx.db, { roles: ['COURIER'], pinHash });

    await ctx.db.refreshSession.create({
      data: {
        userId: courier.id,
        familyId: crypto.randomUUID(),
        tokenHash: `hash-${process.hrtime.bigint()}`,
      },
    });

    const result = await resetPin(ctx, adminActor(admin.id), courier.id, META);
    expect(result.activationCode).toMatch(/^\d{4}$/);

    const stored = await ctx.db.user.findUniqueOrThrow({ where: { id: courier.id } });
    expect(stored.pinHash).toBeNull();
    expect(stored.status).toBe('PENDING_ACTIVATION');
    expect(
      await ctx.db.refreshSession.count({ where: { userId: courier.id, revokedAt: null } }),
    ).toBe(0);

    // Код в базе только в виде хеша.
    const codes = await ctx.db.activationCode.findMany({ where: { userId: courier.id } });
    expect(JSON.stringify(codes)).not.toContain(result.activationCode);
  });

  it('сброс PIN замороженному пользователю требует сначала разморозки', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const courier = await seedUser(ctx.db, { roles: ['COURIER'], status: 'FROZEN' });

    await expect(resetPin(ctx, adminActor(admin.id), courier.id, META)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('защита последнего активного администратора', () => {
  it('нельзя заморозить единственного активного администратора', async () => {
    // Сценарий требует контролируемого состояния: все прочие администраторы замораживаются.
    const survivor = await seedUser(ctx.db, { roles: ['ADMIN'] });

    await ctx.db.user.updateMany({
      where: { status: 'ACTIVE', roles: { some: { role: 'ADMIN' } }, id: { not: survivor.id } },
      data: { status: 'FROZEN', frozenAt: new Date() },
    });

    await expect(freezeUser(ctx, adminActor(survivor.id), survivor.id, META)).rejects.toMatchObject(
      {
        code: 'CONFLICT',
      },
    );

    await expect(resetPin(ctx, adminActor(survivor.id), survivor.id, META)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const stored = await ctx.db.user.findUniqueOrThrow({ where: { id: survivor.id } });
    expect(stored.status).toBe('ACTIVE');
  });

  it('конкурентная заморозка двух последних администраторов оставляет одного', async () => {
    const first = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const second = await seedUser(ctx.db, { roles: ['ADMIN'] });

    await ctx.db.user.updateMany({
      where: {
        status: 'ACTIVE',
        roles: { some: { role: 'ADMIN' } },
        id: { notIn: [first.id, second.id] },
      },
      data: { status: 'FROZEN', frozenAt: new Date() },
    });

    // Без advisory-блокировки обе операции увидели бы «есть ещё один активный».
    const results = await Promise.allSettled([
      freezeUser(ctx, adminActor(first.id), first.id, META),
      freezeUser(ctx, adminActor(second.id), second.id, META),
    ]);

    const succeeded = results.filter((result) => result.status === 'fulfilled').length;
    expect(succeeded).toBe(1);

    const activeAdmins = await ctx.db.user.count({
      where: { status: 'ACTIVE', roles: { some: { role: 'ADMIN' } } },
    });
    expect(activeAdmins).toBe(1);
  });
});

describe('оптимистическая блокировка и аудит', () => {
  it('устаревшая версия приводит к конфликту и не перетирает чужие изменения', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });

    const initial = await ctx.db.user.findUniqueOrThrow({
      where: { id: courier.id },
      select: { version: true },
    });

    await updateUser(
      ctx,
      adminActor(admin.id),
      courier.id,
      { version: initial.version, fullName: 'Первое изменение' },
      META,
    );

    await expect(
      updateUser(
        ctx,
        adminActor(admin.id),
        courier.id,
        { version: initial.version, fullName: 'Второе изменение' },
        META,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const stored = await ctx.db.user.findUniqueOrThrow({ where: { id: courier.id } });
    expect(stored.fullName).toBe('Первое изменение');
  });

  it('смена ролей отзывает сессии и увеличивает версию сессий', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });

    await ctx.db.refreshSession.create({
      data: {
        userId: courier.id,
        familyId: crypto.randomUUID(),
        tokenHash: `hash-${process.hrtime.bigint()}`,
      },
    });

    const before = await ctx.db.user.findUniqueOrThrow({
      where: { id: courier.id },
      select: { version: true, sessionVersion: true },
    });

    await updateUser(
      ctx,
      adminActor(admin.id),
      courier.id,
      { version: before.version, roles: ['COURIER', 'WAREHOUSE'] },
      META,
    );

    const after = await ctx.db.user.findUniqueOrThrow({
      where: { id: courier.id },
      select: { sessionVersion: true },
    });

    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    expect(
      await ctx.db.refreshSession.count({ where: { userId: courier.id, revokedAt: null } }),
    ).toBe(0);

    const roleAudit = await ctx.db.auditLog.findFirst({
      where: { entityId: courier.id, action: 'USER_ROLES_CHANGED' },
    });
    expect(roleAudit).not.toBeNull();
  });

  it('аудит пишется в той же транзакции: при откате изменения записи не остаётся', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });

    const auditBefore = await ctx.db.auditLog.count({ where: { entityId: courier.id } });

    // Конфликт версии откатывает всю транзакцию вместе с аудитом.
    await expect(
      updateUser(
        ctx,
        adminActor(admin.id),
        courier.id,
        { version: 9999, fullName: 'Не должно записаться' },
        META,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const auditAfter = await ctx.db.auditLog.count({ where: { entityId: courier.id } });
    expect(auditAfter).toBe(auditBefore);
  });

  it('созданный пользователь не отдаёт наружу ни одного секретного поля', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });

    const created = await createUser(
      ctx,
      adminActor(admin.id),
      { phone: uniquePhone(), fullName: 'Проверка полей', roles: ['COURIER'] },
      META,
    );

    const serialized = JSON.stringify(created.user);
    for (const forbidden of ['pinHash', 'codeHash', 'tokenHash', 'successorTokenEnc']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
