/**
 * Критические проверки ручных маршрутов-черновиков.
 *
 * Проверяется только то, что защищает данные, состояния, права и конкурентные
 * операции. Сетевых обращений нет: заказы строятся mapper'ом и применяются напрямую.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { TEST_SECRETS } from '../../platform/testing/secrets.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { applyOrderSnapshot, markSourceMissing } from '../integrations/moysklad/import-service.js';
import { mapOrder, type OrderSnapshot } from '../integrations/moysklad/mapper.js';
import type { Role } from '@fl/shared';

let ctx: TestContext;
const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;
const NOW = new Date('2026-08-10T09:00:00.000Z');
/** Даты подобраны так, чтобы не пересекаться с данными других файлов. */
const DAY = '2026-11-10';
const OTHER_DAY = '2026-11-11';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

// --- Фикстуры ---------------------------------------------------------------

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    name: `R-${process.hrtime.bigint() % 1_000_000n}`,
    updated: '2026-08-10 10:00:00.000',
    shipmentAddress: 'Москва, маршрутный адрес',
    deliveryPlannedMoment: `${DAY} 12:00:00.000`,
    sum: 499000,
    payedSum: 0,
    store: { meta: { href: href('store', IDS.store) } },
    state: {
      meta: { href: href('state', '22222222-2222-4222-8222-222222222222') },
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Новый',
      stateType: 'Regular',
    },
    attributes: [
      {
        id: IDS.deliveryMethodAttribute,
        value: {
          name: 'Доставка',
          meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
        },
      },
      { id: IDS.intervalAttribute, value: 'с 16:00 по 19:00' },
      { id: IDS.recipientAttribute, value: 'Получатель Маршрутный' },
    ],
    ...overrides,
  };
}

function snapshotOf(overrides: Record<string, unknown> = {}): OrderSnapshot {
  return mapOrder(source(overrides) as never, IDS).snapshot;
}

async function apply(snapshot: OrderSnapshot, at = NOW) {
  return ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, at));
}

/** Импортирует заказ и возвращает его идентификатор. */
async function seedOrder(overrides: Record<string, unknown> = {}): Promise<string> {
  const snapshot = snapshotOf(overrides);
  await apply(snapshot);
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { externalId: snapshot.externalId },
    select: { id: true },
  });
  return order.id;
}

async function tokenFor(roles: Role[], status: 'ACTIVE' | 'FROZEN' = 'ACTIVE'): Promise<string> {
  const { hashSecretCode } = await import('../auth/crypto.js');
  const { login } = await import('../auth/service.js');
  const pin = '1234';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles, status, pinHash });
  const session = await login(
    ctx,
    { phone: user.phone, pin },
    { ip: null, userAgent: 'vitest', deviceLabel: null },
  );
  return session.accessToken;
}

interface Injected {
  statusCode: number;
  json: () => unknown;
  body: string;
}

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  token: string | null,
  payload?: unknown,
): Promise<Injected> {
  return ctx.app.inject({
    method,
    url,
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    ...(payload === undefined ? {} : { payload }),
  });
}

interface RouteCard {
  id: string;
  number: string;
  version: number;
  state: string;
  courier: { id: string; fullName: string } | null;
  conflictCount: number;
  orders: {
    position: number;
    assignmentState: string;
    conflicts: { kind: string }[];
    order: { id: string; deliveryDateMatchesRoute: boolean };
  }[];
}

async function createRoute(
  token: string,
  deliveryDate = DAY,
): Promise<{ id: string; version: number }> {
  const response = await call('POST', '/api/routes', token, { deliveryDate, vehicleType: 'CAR' });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; version: number };
}

async function card(token: string, routeId: string): Promise<RouteCard> {
  const response = await call('GET', `/api/routes/${routeId}`, token);
  expect(response.statusCode).toBe(200);
  return response.json() as RouteCard;
}

// --- Инварианты базы --------------------------------------------------------

describe('инварианты базы', () => {
  it('миграция создала частичные уникальные индексы и триггеры', async () => {
    const indexes = await ctx.db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'RouteOrder' AND indexname LIKE 'RouteOrder_active%'
    `;
    expect(indexes.map((row) => row.indexname).sort()).toEqual([
      'RouteOrder_active_order_unique',
      'RouteOrder_active_position_unique',
    ]);

    const triggers = await ctx.db.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgname IN (
        'delivery_route_no_delete', 'route_order_no_delete', 'route_order_conflict_no_delete',
        'route_order_conflict_no_update', 'delivery_route_delivery_date_immutable',
        'route_order_history_guard'
      )
    `;
    expect(triggers).toHaveLength(6);
  });

  it('физическое удаление маршрута и участия отклоняется базой', async () => {
    const token = await tokenFor(['ADMIN']);
    const route = await createRoute(token);
    const orderId = await seedOrder();
    await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });

    const participation = await ctx.db.routeOrder.findFirstOrThrow({
      where: { routeId: route.id },
      select: { id: true },
    });

    await expect(ctx.db.routeOrder.delete({ where: { id: participation.id } })).rejects.toThrow();
    await expect(ctx.db.deliveryRoute.delete({ where: { id: route.id } })).rejects.toThrow();
  });

  it('дата маршрута неизменна', async () => {
    const token = await tokenFor(['ADMIN']);
    const route = await createRoute(token);

    await expect(
      ctx.db.deliveryRoute.update({
        where: { id: route.id },
        data: { deliveryDate: new Date(`${OTHER_DAY}T00:00:00.000Z`) },
      }),
    ).rejects.toThrow();
  });

  it('история участия не переписывается', async () => {
    const token = await tokenFor(['ADMIN']);
    const route = await createRoute(token);
    const orderId = await seedOrder();
    await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });
    const participation = await ctx.db.routeOrder.findFirstOrThrow({
      where: { routeId: route.id, removedAt: null },
    });

    // Ни маршрут, ни заказ, ни автор добавления не подменяются.
    await expect(
      ctx.db.routeOrder.update({
        where: { id: participation.id },
        data: { orderId: await seedOrder() },
      }),
    ).rejects.toThrow();

    // Возврат заказа фиксирует удаление…
    await call('POST', `/api/routes/${route.id}/orders/return`, token, {
      orderIds: [orderId],
      expectedVersion: route.version + 1,
    });

    // …после чего удалённое участие нельзя ни оживить, ни переписать.
    await expect(
      ctx.db.routeOrder.update({ where: { id: participation.id }, data: { removedAt: null } }),
    ).rejects.toThrow();
    await expect(
      ctx.db.routeOrder.update({
        where: { id: participation.id },
        data: { removalReason: 'MOVED_TO_ANOTHER_ROUTE' },
      }),
    ).rejects.toThrow();
  });

  it('половинчатое удаление и невозможная позиция отклоняются', async () => {
    const token = await tokenFor(['ADMIN']);
    const route = await createRoute(token);
    const orderId = await seedOrder();
    await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });
    const participation = await ctx.db.routeOrder.findFirstOrThrow({
      where: { routeId: route.id, removedAt: null },
      select: { id: true },
    });

    await expect(
      ctx.db.routeOrder.update({
        where: { id: participation.id },
        data: { removedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      ctx.db.routeOrder.update({ where: { id: participation.id }, data: { position: 0 } }),
    ).rejects.toThrow();
    await expect(
      ctx.db.deliveryRoute.update({ where: { id: route.id }, data: { version: -1 } }),
    ).rejects.toThrow();
  });
});

// --- Права ------------------------------------------------------------------

describe('права', () => {
  it('маршруты доступны только ADMIN и LOGISTICIAN', async () => {
    for (const roles of [['ADMIN'], ['LOGISTICIAN']] as Role[][]) {
      const response = await call('GET', '/api/routes', await tokenFor(roles));
      expect(response.statusCode, roles.join()).toBe(200);
    }

    for (const roles of [['COURIER'], ['WAREHOUSE']] as Role[][]) {
      const token = await tokenFor(roles);
      expect((await call('GET', '/api/routes', token)).statusCode, roles.join()).toBe(403);
      expect(
        (await call('POST', '/api/routes', token, { deliveryDate: DAY, vehicleType: 'CAR' }))
          .statusCode,
        roles.join(),
      ).toBe(403);
    }

    expect((await call('GET', '/api/routes', null)).statusCode).toBe(401);
    expect((await call('POST', '/api/routes/move', null, {})).statusCode).toBe(401);
  });
});

// --- Состав маршрута --------------------------------------------------------

describe('состав маршрута', () => {
  it('заказ добавляется, позиции идут подряд и порядок устойчив', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);
    const first = await seedOrder();
    const second = await seedOrder();
    const third = await seedOrder();

    const added = await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [first, second, third],
      expectedVersion: route.version,
    });
    expect(added.statusCode).toBe(200);

    const view = added.json() as RouteCard;
    expect(view.orders.map((item) => item.position)).toEqual([1, 2, 3]);
    expect(view.orders.map((item) => item.order.id)).toEqual([first, second, third]);
    expect(view.orders.every((item) => item.assignmentState === 'IN_DRAFT')).toBe(true);
    // Версия увеличивается ровно один раз за операцию, сколько бы заказов ни было.
    expect(view.version).toBe(route.version + 1);

    const reordered = await call('PUT', `/api/routes/${route.id}/orders/reorder`, token, {
      orderIds: [third, first, second],
      expectedVersion: view.version,
    });
    expect(reordered.statusCode).toBe(200);
    const afterReorder = reordered.json() as RouteCard;
    expect(afterReorder.orders.map((item) => item.order.id)).toEqual([third, first, second]);
    expect(afterReorder.orders.map((item) => item.position)).toEqual([1, 2, 3]);

    // Повторный запрос отдаёт тот же порядок: он хранится, а не вычисляется случайно.
    expect((await card(token, route.id)).orders.map((item) => item.order.id)).toEqual([
      third,
      first,
      second,
    ]);
  });

  it('частичная перестановка отклоняется целиком', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);
    const first = await seedOrder();
    const second = await seedOrder();
    const added = await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [first, second],
      expectedVersion: route.version,
    });
    const version = (added.json() as RouteCard).version;

    for (const orderIds of [[first], [first, second, first], [first, second, await seedOrder()]]) {
      const response = await call('PUT', `/api/routes/${route.id}/orders/reorder`, token, {
        orderIds,
        expectedVersion: version,
      });
      expect(response.statusCode, JSON.stringify(orderIds)).toBe(409);
    }

    const unchanged = await card(token, route.id);
    expect(unchanged.orders.map((item) => item.order.id)).toEqual([first, second]);
    expect(unchanged.version).toBe(version);
  });

  it('возврат заказа сохраняет историю и освобождает заказ', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);
    const orderId = await seedOrder();
    const added = await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });

    const returned = await call('POST', `/api/routes/${route.id}/orders/return`, token, {
      orderIds: [orderId],
      expectedVersion: (added.json() as RouteCard).version,
    });
    expect(returned.statusCode).toBe(200);
    expect((returned.json() as RouteCard).orders).toHaveLength(0);

    const history = await ctx.db.routeOrder.findMany({ where: { orderId } });
    expect(history).toHaveLength(1);
    expect(history[0]?.removalReason).toBe('RETURNED_TO_UNASSIGNED');
    expect(history[0]?.removedById).not.toBeNull();

    // Освобождённый заказ можно добавить снова — новой записью, а не оживлением старой.
    const again = await createRoute(token);
    await call('POST', `/api/routes/${again.id}/orders`, token, {
      orderIds: [orderId],
      expectedVersion: again.version,
    });
    expect(await ctx.db.routeOrder.count({ where: { orderId } })).toBe(2);
  });
});

// --- Пригодность заказа -----------------------------------------------------

describe('пригодность заказа', () => {
  async function expectRejected(orderId: string): Promise<void> {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);
    const response = await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { conflict: { kind: string } } }).error.conflict.kind).toBe(
      'ORDER_NOT_ELIGIBLE',
    );
    expect(await ctx.db.routeOrder.count({ where: { orderId } })).toBe(0);
  }

  it('заказ другого дня не добавляется', async () => {
    await expectRejected(await seedOrder({ deliveryPlannedMoment: `${OTHER_DAY} 12:00:00.000` }));
  });

  it('заказ без распознанной даты не добавляется', async () => {
    await expectRejected(await seedOrder({ deliveryPlannedMoment: null }));
  });

  it('заказ вне области не добавляется', async () => {
    const orderId = await seedOrder();
    const snapshot = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: orderId } });
    await ctx.db.deliveryOrder.update({
      where: { id: snapshot.id },
      data: { inScope: false, scopeExitReason: 'STORE_CHANGED' },
    });
    await expectRejected(orderId);
  });

  it('архивированный и пропавший заказ не добавляются', async () => {
    const archived = await seedOrder();
    await ctx.db.deliveryOrder.update({ where: { id: archived }, data: { sourceArchived: true } });
    await expectRejected(archived);

    const missing = await seedOrder();
    await ctx.db.deliveryOrder.update({
      where: { id: missing },
      data: { sourceMissing: true, inScope: false, scopeExitReason: 'SOURCE_MISSING' },
    });
    await expectRejected(missing);
  });

  it('«Требует внимания» и ручной интервал добавлению не мешают', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);
    // Заказ без распознанного интервала: он в «Требует внимания».
    const orderId = await seedOrder({
      attributes: [
        {
          id: IDS.deliveryMethodAttribute,
          value: {
            name: 'Доставка',
            meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
          },
        },
        { id: IDS.intervalAttribute, value: 'уточнить у клиента' },
        { id: IDS.recipientAttribute, value: 'Получатель Маршрутный' },
      ],
    });
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(stored.needsAttention).toBe(true);

    await ctx.db.deliveryOrder.update({
      where: { id: orderId },
      data: {
        manualIntervalStartMinute: 600,
        manualIntervalEndMinute: 720,
        manualIntervalSetAt: new Date(),
      },
    });

    const response = await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });
    expect(response.statusCode).toBe(200);
  });
});

// --- Конкурентность ---------------------------------------------------------

describe('конкурентность', () => {
  it('один заказ не попадает в два маршрута: второй запрос получает номер первого', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const first = await createRoute(token);
    const second = await createRoute(token);
    const orderId = await seedOrder();

    const [a, b] = await Promise.all([
      call('POST', `/api/routes/${first.id}/orders`, token, {
        orderIds: [orderId],
        expectedVersion: first.version,
      }),
      call('POST', `/api/routes/${second.id}/orders`, token, {
        orderIds: [orderId],
        expectedVersion: second.version,
      }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const loser = a.statusCode === 409 ? a : b;
    const body = loser.json() as {
      error: { conflict: { kind: string; routeNumber?: string } };
    };
    expect(body.error.conflict.kind).toBe('ORDER_ALREADY_IN_ROUTE');
    expect(body.error.conflict.routeNumber).toMatch(/^R-\d{4}-\d{2}-\d{2}-\d{3}$/);

    expect(await ctx.db.routeOrder.count({ where: { orderId, removedAt: null } })).toBe(1);
  });

  it('устаревшая версия отклоняется без частичной записи', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);
    const first = await seedOrder();
    const second = await seedOrder();

    await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [first],
      expectedVersion: route.version,
    });

    const stale = await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [second],
      expectedVersion: route.version,
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { conflict: { kind: string } } }).error.conflict.kind).toBe(
      'STALE_VERSION',
    );
    expect(await ctx.db.routeOrder.count({ where: { orderId: second } })).toBe(0);
  });

  it('синхронизация и возврат заказа не создают взаимной блокировки', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);
    const snapshot = snapshotOf();
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
      select: { id: true },
    });
    const added = await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [order.id],
      expectedVersion: route.version,
    });
    const version = (added.json() as RouteCard).version;

    // Пользовательская операция берёт маршрут, затем заказ; синхронизация —
    // только заказ. Обратного порядка нет, поэтому обе завершаются без ожидания.
    const [returned, synced] = await Promise.allSettled([
      call('POST', `/api/routes/${route.id}/orders/return`, token, {
        orderIds: [order.id],
        expectedVersion: version,
      }),
      apply({
        ...snapshot,
        address: 'Москва, обновлённый адрес',
        externalUpdated: '2026-08-10 11:00:00.000',
      }),
    ]);

    expect(returned.status).toBe('fulfilled');
    expect(synced.status).toBe('fulfilled');
    if (synced.status === 'rejected') {
      expect(String(synced.reason)).not.toContain('deadlock');
    }
    expect(await ctx.db.routeOrder.count({ where: { orderId: order.id, removedAt: null } })).toBe(
      0,
    );
  });
});

// --- Перемещение ------------------------------------------------------------

describe('перемещение между черновиками', () => {
  it('перемещение атомарно и видно в истории обоих маршрутов', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const from = await createRoute(token);
    const to = await createRoute(token);
    const first = await seedOrder();
    const second = await seedOrder();

    const added = await call('POST', `/api/routes/${from.id}/orders`, token, {
      orderIds: [first, second],
      expectedVersion: from.version,
    });
    const fromVersion = (added.json() as RouteCard).version;

    const moved = await call('POST', '/api/routes/move', token, {
      fromRouteId: from.id,
      toRouteId: to.id,
      orderIds: [first, second],
      expectedSourceVersion: fromVersion,
      expectedTargetVersion: to.version,
    });
    expect(moved.statusCode).toBe(200);

    expect((await card(token, from.id)).orders).toHaveLength(0);
    expect((await card(token, to.id)).orders.map((item) => item.position)).toEqual([1, 2]);

    const closed = await ctx.db.routeOrder.findMany({
      where: { routeId: from.id, removedAt: { not: null } },
    });
    expect(closed).toHaveLength(2);
    expect(closed.every((item) => item.removalReason === 'MOVED_TO_ANOTHER_ROUTE')).toBe(true);
    expect(closed.every((item) => item.movedToRouteId === to.id)).toBe(true);

    for (const routeId of [from.id, to.id]) {
      const history = (
        (await call('GET', `/api/routes/${routeId}/history`, token)).json() as {
          items: { action: string }[];
        }
      ).items;
      expect(
        history.some((entry) => entry.action === 'ROUTE_ORDERS_MOVED'),
        routeId,
      ).toBe(true);
    }
  });

  it('ошибка в середине перемещения откатывает данные, аудит и события', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const from = await createRoute(token);
    const to = await createRoute(token, OTHER_DAY);
    const first = await seedOrder();
    const second = await seedOrder();

    const added = await call('POST', `/api/routes/${from.id}/orders`, token, {
      orderIds: [first, second],
      expectedVersion: from.version,
    });
    const fromVersion = (added.json() as RouteCard).version;

    const auditBefore = await ctx.db.auditLog.count({ where: { entityType: 'DeliveryRoute' } });
    const eventsBefore = await ctx.db.realtimeEvent.count();

    // Целевой маршрут другого дня: перемещение обязано провалиться целиком.
    const response = await call('POST', '/api/routes/move', token, {
      fromRouteId: from.id,
      toRouteId: to.id,
      orderIds: [first, second],
      expectedSourceVersion: fromVersion,
      expectedTargetVersion: to.version,
    });
    expect(response.statusCode).toBe(409);

    const sourceCard = await card(token, from.id);
    expect(sourceCard.orders.map((item) => item.order.id)).toEqual([first, second]);
    expect(sourceCard.version).toBe(fromVersion);
    expect((await card(token, to.id)).orders).toHaveLength(0);
    expect(await ctx.db.auditLog.count({ where: { entityType: 'DeliveryRoute' } })).toBe(
      auditBefore,
    );
    expect(await ctx.db.realtimeEvent.count()).toBe(eventsBefore);
  });
});

// --- Курьер -----------------------------------------------------------------

describe('назначение курьера', () => {
  it('назначается только активный курьер', async () => {
    const token = await tokenFor(['ADMIN']);
    const route = await createRoute(token);

    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
    const frozen = await seedUser(ctx.db, { roles: ['COURIER'], status: 'FROZEN' });
    const warehouse = await seedUser(ctx.db, { roles: ['WAREHOUSE'] });

    const ok = await call('PUT', `/api/routes/${route.id}/courier`, token, {
      courierUserId: courier.id,
      expectedVersion: route.version,
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as RouteCard).courier?.id).toBe(courier.id);
    // Назначение курьера состояние маршрута не меняет.
    expect((ok.json() as RouteCard).state).toBe('DRAFT');

    const version = (ok.json() as RouteCard).version;
    for (const candidate of [frozen.id, warehouse.id]) {
      const response = await call('PUT', `/api/routes/${route.id}/courier`, token, {
        courierUserId: candidate,
        expectedVersion: version,
      });
      expect(response.statusCode, candidate).toBe(400);
    }

    const unassigned = await call('PUT', `/api/routes/${route.id}/courier`, token, {
      courierUserId: null,
      expectedVersion: version,
    });
    expect(unassigned.statusCode).toBe(200);
    expect((unassigned.json() as RouteCard).courier).toBeNull();
  });

  it('логист не назначает привилегированного курьера, администратор назначает', async () => {
    const privileged = await seedUser(ctx.db, { roles: ['COURIER', 'ADMIN'] });

    const logistician = await tokenFor(['LOGISTICIAN']);
    const logisticianRoute = await createRoute(logistician);
    const refused = await call('PUT', `/api/routes/${logisticianRoute.id}/courier`, logistician, {
      courierUserId: privileged.id,
      expectedVersion: logisticianRoute.version,
    });
    expect(refused.statusCode).toBe(403);

    const admin = await tokenFor(['ADMIN']);
    const adminRoute = await createRoute(admin);
    const allowed = await call('PUT', `/api/routes/${adminRoute.id}/courier`, admin, {
      courierUserId: privileged.id,
      expectedVersion: adminRoute.version,
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('один курьер может вести несколько маршрутов', async () => {
    const token = await tokenFor(['ADMIN']);
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
    const first = await createRoute(token);
    const second = await createRoute(token);

    for (const route of [first, second]) {
      const response = await call('PUT', `/api/routes/${route.id}/courier`, token, {
        courierUserId: courier.id,
        expectedVersion: route.version,
      });
      expect(response.statusCode).toBe(200);
    }

    expect(await ctx.db.deliveryRoute.count({ where: { courierUserId: courier.id } })).toBe(2);
  });
});

// --- Конфликты распределённого заказа ---------------------------------------

describe('конфликты распределённого заказа', () => {
  it('смена даты создаёт конфликт, но не удаляет участие', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);
    const snapshot = snapshotOf();
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
      select: { id: true },
    });
    await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [order.id],
      expectedVersion: route.version,
    });

    const eventsBefore = await ctx.db.realtimeEvent.count({
      where: { topic: 'route.conflict_detected' },
    });

    await apply({
      ...snapshot,
      deliveryDate: OTHER_DAY,
      deliveryDateRaw: `${OTHER_DAY} 12:00:00.000`,
      externalUpdated: '2026-08-10 12:00:00.000',
    });

    const view = await card(token, route.id);
    expect(view.orders).toHaveLength(1);
    expect(view.conflictCount).toBe(1);
    expect(view.orders[0]?.conflicts.map((item) => item.kind)).toContain('DELIVERY_DATE_CHANGED');
    // Расхождение видно явно, а не выводится читателем из двух дат.
    expect(view.orders[0]?.order.deliveryDateMatchesRoute).toBe(false);

    expect(await ctx.db.realtimeEvent.count({ where: { topic: 'route.conflict_detected' } })).toBe(
      eventsBefore + 1,
    );
    expect(
      await ctx.db.auditLog.count({
        where: { entityId: route.id, action: 'ROUTE_ORDER_CONFLICT_DETECTED' },
      }),
    ).toBe(1);

    // Повторная синхронизация того же расхождения не уведомляет второй раз.
    await apply({
      ...snapshot,
      deliveryDate: OTHER_DAY,
      deliveryDateRaw: `${OTHER_DAY} 12:00:00.000`,
      address: 'Москва, ещё раз изменённый адрес',
      externalUpdated: '2026-08-10 13:00:00.000',
    });
    expect(
      await ctx.db.auditLog.count({
        where: { entityId: route.id, action: 'ROUTE_ORDER_CONFLICT_DETECTED' },
      }),
    ).toBe(1);
    // Счёт ограничен этим маршрутом: база критических тестов общая.
    expect(
      await ctx.db.routeOrderConflict.count({
        where: { kind: 'DELIVERY_DATE_CHANGED', routeOrder: { routeId: route.id } },
      }),
    ).toBe(1);
  });

  it('выход из области фиксируется отдельным видом конфликта', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);
    const snapshot = snapshotOf();
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
      select: { id: true },
    });
    await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [order.id],
      expectedVersion: route.version,
    });

    await apply({
      ...snapshot,
      storeId: '33333333-3333-4333-8333-333333333333',
      inScope: false,
      scopeExitReason: 'STORE_CHANGED',
      externalUpdated: '2026-08-10 14:00:00.000',
    });

    const view = await card(token, route.id);
    expect(view.orders).toHaveLength(1);
    expect(view.orders[0]?.conflicts.map((item) => item.kind)).toContain('SCOPE_LOST');
  });

  it('контрольная сверка помечает пропавший распределённый заказ', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);
    const orderId = await seedOrder();
    await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });

    // markSourceMissing не проходит через applyOrderSnapshot: отдельный путь.
    await ctx.db.$transaction((tx) => markSourceMissing(tx, orderId, new Date()));

    const view = await card(token, route.id);
    expect(view.orders).toHaveLength(1);
    expect(view.orders[0]?.conflicts.map((item) => item.kind)).toContain('SOURCE_MISSING');
  });

  it('в аудите и событиях маршрутов нет персональных данных', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);
    const marker = `Секрет-${Date.now()}`;
    const snapshot = snapshotOf({ shipmentAddress: `Москва, ${marker}` });
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
      select: { id: true },
    });
    await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [order.id],
      expectedVersion: route.version,
    });
    await apply({
      ...snapshot,
      deliveryDate: OTHER_DAY,
      deliveryDateRaw: `${OTHER_DAY} 12:00:00.000`,
      externalUpdated: '2026-08-10 15:00:00.000',
    });

    const audit = await ctx.db.auditLog.findMany({ where: { entityId: route.id } });
    const events = await ctx.db.realtimeEvent.findMany({
      where: { topic: { startsWith: 'route.' } },
    });

    // Денежные поля хранятся в BigInt, поэтому сериализация с заменителем.
    const serialize = (value: unknown): string =>
      JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));

    const serialized = `${serialize(audit)}${serialize(events)}`;
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain('Москва');
    expect(serialized).not.toContain('Получатель');
    // Номер маршрута в realtime не передаётся: событие несёт только идентификаторы.
    expect(serialize(events)).not.toContain(
      (await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } })).number,
    );
  });
});
