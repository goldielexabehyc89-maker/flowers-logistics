/**
 * Проверки назначения курьера маршрутному листу.
 *
 * Защищаемое свойство: курьера меняют, пока лист не уехал. После отгрузки
 * курьер — уже факт, а не намерение, и подменять его записью в базе значило бы
 * потерять след того, кто увёз заказы.
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
import { setCourier } from './service.js';

let ctx: TestContext;
const CONTEXT = { ip: '127.0.0.1', userAgent: 'critical-test' };
const DAY = '2027-12-25';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

const deps = () => ({ db: ctx.db });

async function actorWith(role: 'LOGISTICIAN' | 'ADMIN' | 'FLORIST'): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles: [role] });
  return { userId: user.id, roles: [role], familyId: randomUUID() };
}

async function courier(): Promise<string> {
  const user = await seedUser(ctx.db, { roles: ['COURIER'] });
  return user.id;
}

async function seedRoute(
  state: 'DRAFT' | 'CONFIRMED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED',
  courierUserId: string | null = null,
): Promise<{ id: string; version: number }> {
  const creator = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
  return ctx.db.deliveryRoute.create({
    data: {
      number: `CA-${process.hrtime.bigint() % 1_000_000n}`,
      deliveryDate: new Date(`${DAY}T00:00:00.000Z`),
      vehicleType: 'CAR',
      createdById: creator.id,
      state,
      ...(courierUserId === null ? {} : { courierUserId }),
    },
    select: { id: true, version: true },
  });
}

async function courierOf(routeId: string): Promise<string | null> {
  const route = await ctx.db.deliveryRoute.findUniqueOrThrow({
    where: { id: routeId },
    select: { courierUserId: true },
  });
  return route.courierUserId;
}

describe('неотгруженный лист принимает курьера', () => {
  it('назначение, замена и снятие работают', async () => {
    const first = await courier();
    const second = await courier();
    const route = await seedRoute('CONFIRMED');

    const assigned = await setCourier(
      deps(),
      await actorWith('LOGISTICIAN'),
      route.id,
      { courierUserId: first, expectedVersion: route.version },
      CONTEXT,
    );
    expect(await courierOf(route.id)).toBe(first);

    const replaced = await setCourier(
      deps(),
      await actorWith('LOGISTICIAN'),
      route.id,
      { courierUserId: second, expectedVersion: assigned.version },
      CONTEXT,
    );
    expect(await courierOf(route.id)).toBe(second);

    await setCourier(
      deps(),
      await actorWith('ADMIN'),
      route.id,
      { courierUserId: null, expectedVersion: replaced.version },
      CONTEXT,
    );
    expect(await courierOf(route.id)).toBeNull();
  });

  it('аудит называет прежнего и нового курьера', async () => {
    const first = await courier();
    const route = await seedRoute('CONFIRMED');

    await setCourier(
      deps(),
      await actorWith('LOGISTICIAN'),
      route.id,
      { courierUserId: first, expectedVersion: route.version },
      CONTEXT,
    );

    const audit = await ctx.db.auditLog.findFirstOrThrow({
      where: { entityId: route.id, action: 'ROUTE_COURIER_ASSIGNED' },
      select: { newValue: true },
    });
    const value = audit.newValue as { previousCourierUserId: string | null; courierUserId: string };
    expect(value.previousCourierUserId).toBeNull();
    expect(value.courierUserId).toBe(first);
    // Телефона в аудите нет: достаточно идентификатора.
    expect(JSON.stringify(value)).not.toContain('+7');
  });

  it('пользователь неподходящей роли курьером не становится', async () => {
    const notCourier = await seedUser(ctx.db, { roles: ['FLORIST'] });
    const route = await seedRoute('CONFIRMED');

    await expect(
      setCourier(
        deps(),
        await actorWith('LOGISTICIAN'),
        route.id,
        { courierUserId: notCourier.id, expectedVersion: route.version },
        CONTEXT,
      ),
    ).rejects.toThrow();
    expect(await courierOf(route.id)).toBeNull();
  });

  it('чужая версия отклоняет изменение', async () => {
    const route = await seedRoute('CONFIRMED');

    await expect(
      setCourier(
        deps(),
        await actorWith('LOGISTICIAN'),
        route.id,
        { courierUserId: await courier(), expectedVersion: route.version + 4 },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'STALE_VERSION' } });
    expect(await courierOf(route.id)).toBeNull();
  });
});

describe('после отгрузки курьер не меняется', () => {
  for (const state of ['ACTIVE', 'COMPLETED', 'CANCELLED'] as const) {
    it(`состояние ${state} изменение запрещает`, async () => {
      const previous = await courier();
      const route = await seedRoute(state, previous);

      await expect(
        setCourier(
          deps(),
          await actorWith('ADMIN'),
          route.id,
          { courierUserId: await courier(), expectedVersion: route.version },
          CONTEXT,
        ),
      ).rejects.toMatchObject({ conflict: { kind: 'ROUTE_NOT_DRAFT' } });

      expect(await courierOf(route.id)).toBe(previous);
    });
  }
});
