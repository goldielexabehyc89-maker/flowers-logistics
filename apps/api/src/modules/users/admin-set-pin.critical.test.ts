/**
 * Администратор задаёт или меняет PIN сотрудника напрямую (без передачи кода).
 *
 * Проверяется САМ сервер, а не скрытие кнопок: право, переходы статуса, вход
 * старым и новым PIN, отзыв сессий, неприкосновенность заморозки и то, что ни
 * ответ API, ни аудит не раскрывают PIN или его хеш.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@fl/shared';
import { hashSecretCode } from '../auth/crypto.js';
import { activate, login } from '../auth/service.js';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  uniquePhone,
  type TestContext,
} from '../auth/testing/harness.js';
import { createUser, setEmployeePin, type Actor } from './service.js';

let ctx: TestContext;
const PEPPER = TEST_SECRETS.AUTH_PIN_PEPPER;
const META = { ip: '10.8.0.2', userAgent: 'vitest' };
const CTXT = { ip: null, userAgent: 'vitest', deviceLabel: null };

const adminActor = (userId: string): Actor => ({ userId, roles: ['ADMIN'] });

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

/** Активный администратор — «руки», которыми выполняется действие. */
async function admin(): Promise<Actor> {
  const user = await seedUser(ctx.db, { roles: ['ADMIN'], status: 'ACTIVE' });
  return adminActor(user.id);
}

/** Действующий сотрудник с известным PIN и живым токеном. */
async function tokenFor(
  roles: Role[],
  pin = '7315',
): Promise<{ id: string; phone: string; token: string }> {
  const pinHash = await hashSecretCode(pin, PEPPER);
  const user = await seedUser(ctx.db, { roles, status: 'ACTIVE', pinHash });
  const session = await login(ctx, { phone: user.phone, pin }, CTXT);
  return { id: user.id, phone: user.phone, token: session.accessToken };
}

async function setPinRoute(token: string, userId: string, pin: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/users/${userId}/pin`,
    headers: { authorization: `Bearer ${token}` },
    payload: { pin },
  });
}

async function statusOf(userId: string): Promise<string> {
  return (await ctx.db.user.findUniqueOrThrow({ where: { id: userId }, select: { status: true } }))
    .status;
}

async function sessionVersionOf(userId: string): Promise<number> {
  return (
    await ctx.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { sessionVersion: true },
    })
  ).sessionVersion;
}

describe('администратор задаёт PIN новому сотруднику', () => {
  it('PENDING становится ACTIVE и входит новым PIN сразу', async () => {
    const actor = await admin();
    const created = await createUser(
      ctx,
      actor,
      { phone: uniquePhone(), fullName: 'Новый сотрудник', roles: ['COURIER'] },
      META,
    );
    expect(created.user.status).toBe('PENDING_ACTIVATION');

    const result = await setEmployeePin(ctx, actor, created.user.id, { pin: '4416' }, META);
    expect(result.status).toBe('ACTIVE');
    expect(result.firstPin).toBe(true);
    expect(await statusOf(created.user.id)).toBe('ACTIVE');

    // Вход новым PIN работает немедленно.
    const session = await login(ctx, { phone: created.user.phone, pin: '4416' }, CTXT);
    expect(session.accessToken).toBeTruthy();
  });

  it('прежний временный код после задания PIN больше не активирует', async () => {
    const actor = await admin();
    const created = await createUser(
      ctx,
      actor,
      { phone: uniquePhone(), fullName: 'С кодом', roles: ['FLORIST'] },
      META,
    );

    await setEmployeePin(ctx, actor, created.user.id, { pin: '4416' }, META);

    // Код, выданный при создании, недействителен: активировать им нельзя.
    await expect(
      activate(ctx, { phone: created.user.phone, code: created.activationCode, pin: '9999' }, CTXT),
    ).rejects.toBeTruthy();
    // А новый PIN по-прежнему пускает.
    expect(
      (await login(ctx, { phone: created.user.phone, pin: '4416' }, CTXT)).accessToken,
    ).toBeTruthy();
  });
});

describe('администратор меняет PIN действующему сотруднику', () => {
  it('старый PIN перестаёт работать, новый работает сразу', async () => {
    const actor = await admin();
    const oldPin = '1111';
    const employee = await seedUser(ctx.db, {
      roles: ['FLORIST'],
      status: 'ACTIVE',
      pinHash: await hashSecretCode(oldPin, PEPPER),
    });
    // Старый PIN до смены — работает.
    expect(
      (await login(ctx, { phone: employee.phone, pin: oldPin }, CTXT)).accessToken,
    ).toBeTruthy();

    const result = await setEmployeePin(ctx, actor, employee.id, { pin: '2222' }, META);
    expect(result.firstPin).toBe(false);

    await expect(login(ctx, { phone: employee.phone, pin: oldPin }, CTXT)).rejects.toBeTruthy();
    expect(
      (await login(ctx, { phone: employee.phone, pin: '2222' }, CTXT)).accessToken,
    ).toBeTruthy();
  });

  it('прежние сессии отозваны, а выданный ранее токен больше не проходит', async () => {
    const actor = await admin();
    const employee = await tokenFor(['WAREHOUSE'], '1111');

    const me = () =>
      ctx.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${employee.token}` },
      });
    // До смены токен действует.
    expect((await me()).statusCode).toBe(200);

    const before = await sessionVersionOf(employee.id);
    await setEmployeePin(ctx, actor, employee.id, { pin: '2222' }, META);

    // sessionVersion вырос, refresh-сессии отозваны, старый токен отвергнут.
    expect(await sessionVersionOf(employee.id)).toBe(before + 1);
    expect(
      await ctx.db.refreshSession.count({
        where: { userId: employee.id, revokedAt: { not: null } },
      }),
    ).toBeGreaterThan(0);
    expect((await me()).statusCode).toBe(401);
  });
});

describe('заморозка неприкосновенна', () => {
  it('у FROZEN PIN обновляется, но статус остаётся FROZEN и вход запрещён', async () => {
    const actor = await admin();
    const frozen = await seedUser(ctx.db, {
      roles: ['COURIER'],
      status: 'FROZEN',
      pinHash: await hashSecretCode('1111', PEPPER),
    });

    const result = await setEmployeePin(ctx, actor, frozen.id, { pin: '2222' }, META);
    expect(result.status).toBe('FROZEN');
    expect(await statusOf(frozen.id)).toBe('FROZEN');

    // Даже с новым верным PIN замороженный не входит.
    await expect(login(ctx, { phone: frozen.phone, pin: '2222' }, CTXT)).rejects.toBeTruthy();
  });
});

describe('право: только администратор и не по администратору', () => {
  it('управляющий, логист и прочие роли получают 403, аноним — 401', async () => {
    const target = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE' });

    for (const roles of [
      ['SUPERVISOR'],
      ['LOGISTICIAN'],
      ['FLORIST'],
      ['WAREHOUSE'],
      ['MANAGER'],
      ['COURIER'],
    ] as Role[][]) {
      const { token } = await tokenFor(roles);
      const res = await setPinRoute(token, target.id, '4416');
      expect(res.statusCode, roles.join('+')).toBe(403);
    }

    const anon = await ctx.app.inject({
      method: 'POST',
      url: `/api/users/${target.id}/pin`,
      payload: { pin: '4416' },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('PIN другого администратора изменить нельзя ни маршрутом, ни сервисом', async () => {
    const actingAdmin = await tokenFor(['ADMIN']);
    const otherAdmin = await seedUser(ctx.db, { roles: ['ADMIN'], status: 'ACTIVE' });

    const res = await setPinRoute(actingAdmin.token, otherAdmin.id, '4416');
    expect(res.statusCode).toBe(403);

    await expect(
      setEmployeePin(ctx, adminActor(actingAdmin.id), otherAdmin.id, { pin: '4416' }, META),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('PIN и его хеш нигде не раскрываются', () => {
  it('ни ответ API, ни карточка, ни история, ни аудит не содержат PIN или хеш', async () => {
    const adminToken = (await tokenFor(['ADMIN'])).token;
    const employee = await seedUser(ctx.db, { roles: ['MANAGER'], status: 'ACTIVE' });

    const response = await setPinRoute(adminToken, employee.id, '4416');
    expect(response.statusCode).toBe(200);
    // Ответ — только статус и признак первого PIN.
    expect(response.body).not.toContain('4416');
    expect(response.body.toLowerCase()).not.toContain('pinhash');

    const view = await ctx.app.inject({
      method: 'GET',
      url: `/api/users/${employee.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(view.body).not.toContain('4416');
    expect(view.body.toLowerCase()).not.toContain('pinhash');

    const history = await ctx.app.inject({
      method: 'GET',
      url: `/api/users/${employee.id}/history`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(history.body).not.toContain('4416');
    expect(history.body.toLowerCase()).not.toContain('pinhash');

    // Аудит: действие записано с признаком первого PIN, но без PIN, хеша и телефона.
    const pinHash = (
      await ctx.db.user.findUniqueOrThrow({ where: { id: employee.id }, select: { pinHash: true } })
    ).pinHash;
    const phone = (
      await ctx.db.user.findUniqueOrThrow({ where: { id: employee.id }, select: { phone: true } })
    ).phone;
    const audits = await ctx.db.auditLog.findMany({
      where: { entityId: employee.id, action: 'USER_PIN_SET_BY_ADMIN' },
      select: { oldValue: true, newValue: true },
    });
    expect(audits.length).toBeGreaterThan(0);
    for (const row of audits) {
      const blob = JSON.stringify(row.oldValue) + JSON.stringify(row.newValue);
      expect(blob).not.toContain('4416');
      expect(blob).not.toContain(pinHash);
      expect(blob).not.toContain(phone);
      expect(JSON.stringify(row.newValue)).toContain('firstPin');
    }
  });
});

describe('одновременное повторное сохранение', () => {
  it('не оставляет два разных действующих состояния', async () => {
    const actor = await admin();
    const employee = await seedUser(ctx.db, {
      roles: ['COURIER'],
      status: 'ACTIVE',
      pinHash: await hashSecretCode('1111', PEPPER),
    });

    // Два параллельных сохранения разными PIN.
    const settled = await Promise.allSettled([
      setEmployeePin(ctx, actor, employee.id, { pin: '2222' }, META),
      setEmployeePin(ctx, actor, employee.id, { pin: '3333' }, META),
    ]);
    // Строка сериализована блокировкой `FOR UPDATE`: оба доходят до конца.
    expect(settled.every((entry) => entry.status === 'fulfilled')).toBe(true);

    // Действует РОВНО один из двух новых PIN — единое состояние, а не два.
    const logins = await Promise.allSettled([
      login(ctx, { phone: employee.phone, pin: '2222' }, CTXT),
      login(ctx, { phone: employee.phone, pin: '3333' }, CTXT),
    ]);
    expect(logins.filter((entry) => entry.status === 'fulfilled').length).toBe(1);

    // Старый PIN не работает никогда, а сам сотрудник — в одном ACTIVE-состоянии.
    await expect(login(ctx, { phone: employee.phone, pin: '1111' }, CTXT)).rejects.toBeTruthy();
    expect(await statusOf(employee.id)).toBe('ACTIVE');
  });
});
