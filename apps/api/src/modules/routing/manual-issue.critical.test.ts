/**
 * Проверки ручной отгрузки маршрутного листа.
 *
 * Защищаемые свойства: отгрузка — это ТОТ ЖЕ доменный переход, что у склада,
 * без курьера её не бывает, выключенная настройка её запрещает, а повтор
 * команды не создаёт второй переход.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { saveManualIssue } from '../settings/service.js';
import { shipRouteManually } from './lifecycle.js';

let ctx: TestContext;
const CONTEXT = { ip: '127.0.0.1', userAgent: 'critical-test' };
const DAY = '2027-12-03';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

const deps = () => ({ db: ctx.db });

async function logistician(): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
  return { userId: user.id, roles: ['LOGISTICIAN'], familyId: randomUUID() };
}

async function admin(): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles: ['ADMIN'] });
  return { userId: user.id, roles: ['ADMIN'], familyId: randomUUID() };
}

/** Подтверждённый маршрутный лист. Курьер назначается по требованию проверки. */
async function seedSheet(options: { withCourier: boolean }): Promise<{
  id: string;
  version: number;
}> {
  const creator = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
  const courier = options.withCourier ? await seedUser(ctx.db, { roles: ['COURIER'] }) : null;

  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: `MI-${process.hrtime.bigint() % 1_000_000n}`,
      deliveryDate: new Date(`${DAY}T00:00:00.000Z`),
      vehicleType: 'CAR',
      createdById: creator.id,
      state: 'CONFIRMED',
      ...(courier === null ? {} : { courierUserId: courier.id }),
    },
    select: { id: true, version: true },
  });
  return route;
}

async function transitionsOf(routeId: string): Promise<string[]> {
  const rows = await ctx.db.routeStateTransition.findMany({
    where: { routeId },
    orderBy: { occurredAt: 'asc' },
    select: { toState: true },
  });
  return rows.map((row) => row.toState);
}

async function setManualIssue(enabled: boolean): Promise<void> {
  const actor = await admin();
  const current = await ctx.db.systemSetting.findUnique({
    where: { currentKey: 'routing.manualIssue' },
    select: { version: true },
  });
  await saveManualIssue(ctx.db, actor, {
    value: { enabled },
    expectedVersion: current?.version ?? 0,
    ip: null,
    userAgent: null,
  });
}

describe('ручная отгрузка', () => {
  it('без курьера отгрузить нельзя', async () => {
    // Иначе маршрут «уехал» бы неизвестно с кем.
    const sheet = await seedSheet({ withCourier: false });

    await expect(
      shipRouteManually(
        deps(),
        await logistician(),
        sheet.id,
        { expectedVersion: sheet.version },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ROUTE_COURIER_REQUIRED' } });

    expect(await transitionsOf(sheet.id)).toEqual([]);
  });

  it('переводит лист в отгруженный тем же переходом, что и склад', async () => {
    const sheet = await seedSheet({ withCourier: true });

    const result = await shipRouteManually(
      deps(),
      await logistician(),
      sheet.id,
      { expectedVersion: sheet.version },
      CONTEXT,
    );

    expect(result.state).toBe('ACTIVE');
    expect(await transitionsOf(sheet.id)).toEqual(['ACTIVE']);

    // Переход ровно тот же, что у склада: из подтверждённого в отгруженный
    // и без причины — правило базы, история состояний хранит состояния.
    const transition = await ctx.db.routeStateTransition.findFirstOrThrow({
      where: { routeId: sheet.id },
      select: { fromState: true, toState: true, reason: true },
    });
    expect(transition.fromState).toBe('CONFIRMED');
    expect(transition.reason).toBeNull();

    // Тот же аудит, что у складской выдачи, и в нём назван способ.
    const audit = await ctx.db.auditLog.findFirstOrThrow({
      where: { entityId: sheet.id, action: 'ROUTE_ISSUED_TO_COURIER' },
      select: { newValue: true },
    });
    expect((audit.newValue as { manual?: boolean }).manual).toBe(true);
  });

  it('повтор команды не создаёт второй переход', async () => {
    const sheet = await seedSheet({ withCourier: true });
    const actor = await logistician();

    await shipRouteManually(deps(), actor, sheet.id, { expectedVersion: sheet.version }, CONTEXT);
    const repeat = await shipRouteManually(
      deps(),
      actor,
      sheet.id,
      { expectedVersion: sheet.version },
      CONTEXT,
    );

    expect(repeat.unchanged).toBe(true);
    expect(await transitionsOf(sheet.id)).toEqual(['ACTIVE']);
  });

  it('чужая версия отклоняется целиком', async () => {
    const sheet = await seedSheet({ withCourier: true });

    await expect(
      shipRouteManually(
        deps(),
        await logistician(),
        sheet.id,
        { expectedVersion: sheet.version + 5 },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'STALE_VERSION' } });

    expect(await transitionsOf(sheet.id)).toEqual([]);
  });

  it('выключенная настройка запрещает ручную отгрузку', async () => {
    const sheet = await seedSheet({ withCourier: true });
    await setManualIssue(false);

    try {
      await expect(
        shipRouteManually(
          deps(),
          await logistician(),
          sheet.id,
          { expectedVersion: sheet.version },
          CONTEXT,
        ),
      ).rejects.toMatchObject({ conflict: { kind: 'MANUAL_ISSUE_DISABLED' } });
      expect(await transitionsOf(sheet.id)).toEqual([]);
    } finally {
      await setManualIssue(true);
    }
  });

  it('включённая настройка — значение по умолчанию', async () => {
    // Без склада в смене логист иначе не может отправить курьера вовсе.
    const fresh = await ctx.db.systemSetting.findUnique({
      where: { currentKey: 'routing.manualIssue' },
      select: { value: true },
    });
    const sheet = await seedSheet({ withCourier: true });

    const result = await shipRouteManually(
      deps(),
      await logistician(),
      sheet.id,
      { expectedVersion: sheet.version },
      CONTEXT,
    );

    expect(result.state).toBe('ACTIVE');
    expect(fresh === null || (fresh.value as { enabled: boolean }).enabled).toBe(true);
  });
});
