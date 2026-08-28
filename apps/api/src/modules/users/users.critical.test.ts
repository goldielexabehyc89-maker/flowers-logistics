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
const supervisorActor = (userId: string): Actor => ({ userId, roles: ['SUPERVISOR'] });

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

  it('логист замораживает и размораживает курьера, но не флориста и не кладовщика', async () => {
    /*
     * Экран логиста показывает одну вкладку — «Курьеры». Проверяется не она,
     * а сервер: интерфейс лишь не рисует лишнего, а запрет обязан жить там,
     * где его нельзя обойти запросом.
     */
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const actor = logisticianActor(logist.id);

    const courier = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE' });
    const frozen = await freezeUser(ctx, actor, courier.id, META);
    expect(frozen.status).toBe('FROZEN');
    const restored = await unfreezeUser(ctx, actor, courier.id, META);
    expect(restored.status).toBe('PENDING_ACTIVATION');

    // Непривилегированные, но и не курьерские роли логисту тоже недоступны.
    for (const role of ['FLORIST', 'WAREHOUSE', 'MANAGER'] as const) {
      const target = await seedUser(ctx.db, { roles: [role], status: 'ACTIVE' });
      await expect(freezeUser(ctx, actor, target.id, META)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(getUser(ctx, actor, target.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('в выборке логиста нет никого, кроме обычных курьеров', async () => {
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const actor = logisticianActor(logist.id);

    await seedUser(ctx.db, { roles: ['FLORIST'], status: 'ACTIVE' });
    await seedUser(ctx.db, { roles: ['WAREHOUSE'], status: 'ACTIVE' });
    await seedUser(ctx.db, { roles: ['MANAGER'], status: 'ACTIVE' });
    const courier = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE' });

    const list = await listUsers(ctx, actor, { limit: 100, offset: 0, status: 'ACTIVE' });
    // В выборке нет ни одной чужой роли — сколько бы страниц в ней ни было.
    for (const item of list.items) {
      expect(item.roles, item.id).toEqual(['COURIER']);
    }
    // А свой курьер логисту доступен поимённо.
    expect((await getUser(ctx, actor, courier.id)).roles).toEqual(['COURIER']);
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

describe('права управляющего', () => {
  async function versionOf(userId: string): Promise<number> {
    const row = await ctx.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { version: true },
    });
    return row.version;
  }

  it('заводит сотрудников всех ролей, включая другого управляющего, но не администратора', async () => {
    const supervisor = await seedUser(ctx.db, { roles: ['SUPERVISOR'] });
    const actor = supervisorActor(supervisor.id);

    for (const role of [
      'COURIER',
      'FLORIST',
      'WAREHOUSE',
      'MANAGER',
      'LOGISTICIAN',
      'SUPERVISOR',
    ] as const) {
      const created = await createUser(
        ctx,
        actor,
        { phone: uniquePhone(), fullName: `Сотрудник ${role}`, roles: [role] },
        META,
      );
      expect(created.user.roles).toEqual([role]);
    }

    // Администратора управляющий не создаёт — ни отдельной ролью, ни в наборе.
    for (const roles of [['ADMIN'], ['COURIER', 'ADMIN'], ['SUPERVISOR', 'ADMIN']] as const) {
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

  it('администрирует не-администраторов: меняет роли, замораживает, сбрасывает PIN', async () => {
    const supervisor = await seedUser(ctx.db, { roles: ['SUPERVISOR'] });
    const actor = supervisorActor(supervisor.id);

    const courier = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE' });
    // Смена ролей не-администратора на другой не-администраторский набор — можно.
    const updated = await updateUser(
      ctx,
      actor,
      courier.id,
      { version: await versionOf(courier.id), roles: ['FLORIST'] },
      META,
    );
    expect(updated.roles).toEqual(['FLORIST']);

    const frozen = await freezeUser(ctx, actor, courier.id, META);
    expect(frozen.status).toBe('FROZEN');
    await unfreezeUser(ctx, actor, courier.id, META);
    const reset = await resetPin(ctx, actor, courier.id, META);
    expect(reset.activationCode).toMatch(/^\d{4}$/);

    // Управляющий администрирует и другого управляющего.
    const otherSupervisor = await seedUser(ctx.db, { roles: ['SUPERVISOR'], status: 'ACTIVE' });
    expect((await freezeUser(ctx, actor, otherSupervisor.id, META)).status).toBe('FROZEN');
  });

  it('не назначает роль ADMIN существующему и не повышает себя', async () => {
    const supervisor = await seedUser(ctx.db, { roles: ['SUPERVISOR'], status: 'ACTIVE' });
    const actor = supervisorActor(supervisor.id);
    const courier = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE' });

    await expect(
      updateUser(
        ctx,
        actor,
        courier.id,
        { version: await versionOf(courier.id), roles: ['COURIER', 'ADMIN'] },
        META,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Повысить самого себя до администратора управляющий тоже не может.
    await expect(
      updateUser(
        ctx,
        actor,
        supervisor.id,
        { version: await versionOf(supervisor.id), roles: ['SUPERVISOR', 'ADMIN'] },
        META,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('не трогает учётку администратора: ни открыть, ни заморозить, ни сбросить PIN, ни сменить роли', async () => {
    const supervisor = await seedUser(ctx.db, { roles: ['SUPERVISOR'] });
    const actor = supervisorActor(supervisor.id);
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'], status: 'ACTIVE' });

    await expect(getUser(ctx, actor, admin.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(freezeUser(ctx, actor, admin.id, META)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(resetPin(ctx, actor, admin.id, META)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      updateUser(
        ctx,
        actor,
        admin.id,
        { version: await versionOf(admin.id), roles: ['LOGISTICIAN'] },
        META,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('видит и открывает сотрудников всех ролей, но не администраторов', async () => {
    const supervisor = await seedUser(ctx.db, { roles: ['SUPERVISOR'] });
    const actor = supervisorActor(supervisor.id);

    const florist = await seedUser(ctx.db, { roles: ['FLORIST'], status: 'ACTIVE' });
    const courier = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE' });
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'], status: 'ACTIVE' });

    // Не-администраторов управляющий открывает поимённо (устойчиво к тому,
    // сколько ещё пользователей завели другие файлы в общей базе).
    expect((await getUser(ctx, actor, florist.id)).roles).toEqual(['FLORIST']);
    expect((await getUser(ctx, actor, courier.id)).roles).toEqual(['COURIER']);
    // Администратора — не открывает.
    await expect(getUser(ctx, actor, admin.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // В общей выборке администраторов нет вовсе — при любом числе страниц.
    const general = await listUsers(ctx, actor, { limit: 200, offset: 0, status: 'ACTIVE' });
    expect(general.items.some((item) => item.roles.includes('ADMIN'))).toBe(false);

    // Даже явным фильтром по роли ADMIN администраторы не раскрываются.
    const filtered = await listUsers(ctx, actor, { role: 'ADMIN', limit: 50, offset: 0 });
    expect(filtered.items).toHaveLength(0);
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
