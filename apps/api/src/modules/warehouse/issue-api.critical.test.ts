/**
 * Публичные маршруты выдачи: права и доверие к клиенту.
 *
 * Проверяется не «есть ли guard в файле», а поведение сервера: аноним не
 * работает вовсе, чужая роль получает отказ, а всё, что присылает клиент —
 * номер, состав, версия, признак «уже проверено», — заново проверяется на
 * сервере. Клиент видит экран, а решение принимает база.
 *
 * Отдельно закреплено, что прежнего поштучного пути выдачи больше нет:
 * лист уезжает целиком или не уезжает вовсе.
 *
 * День подобран так, чтобы не пересекаться с другими файлами набора.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from '../auth/testing/harness.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import type { Role } from '@fl/shared';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { createStorageCell, unknownOccupancy, type CellDeps } from './service.js';
import { receiveOrder, type FlowDeps } from './placement.js';
import { bindRouteCell, pickOrderToRouteCell } from './route-flow.js';

let ctx: TestContext;
let flow: FlowDeps;
let cells: CellDeps;
const CONTEXT = { ip: null, userAgent: null };

/** День вне диапазонов остальных файлов набора. */
const DAY = '2028-01-24';

beforeAll(async () => {
  ctx = await createTestContext();
  flow = { db: ctx.db };
  cells = { db: ctx.db, occupancy: unknownOccupancy };
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${sequence}`;
}

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return { userId: user.id, roles, familyId: randomUUID() } as AuthenticatedActor;
}

async function tokenFor(roles: Role[]): Promise<string> {
  const { hashSecretCode } = await import('../auth/crypto.js');
  const { login } = await import('../auth/service.js');
  const pin = '1234';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles, pinHash });
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
  }) as unknown as Promise<Injected>;
}

async function seedCell(kind: 'STORAGE' | 'ROUTE'): Promise<{ id: string; code: string }> {
  const actor = await actorFor(['ADMIN']);
  const created = await createStorageCell(
    cells,
    actor,
    { code: unique(kind === 'ROUTE' ? 'AR' : 'AS'), kind },
    CONTEXT,
  );
  return { id: created.id, code: created.normalizedCode };
}

async function seedOrder(): Promise<{ id: string; number: string }> {
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: unique('AW'),
      externalUpdated: new Date(),
      deliveryDate: toDateColumn(DAY),
      inScope: true,
      address: 'синтетический адрес прав',
      recipient: 'синтетический получатель',
    },
    select: { id: true, externalName: true },
  });
  return { id: order.id, number: order.externalName };
}

interface Stand {
  routeId: string;
  routeNumber: string;
  orders: { id: string; number: string }[];
  routeCell: { id: string; code: string };
  storage: { id: string; code: string };
  courierUserId: string;
  keeperToken: string;
}

/** Лист с коробками в маршрутной ячейке и назначенным курьером. */
async function seedRoute(orderCount = 2): Promise<Stand> {
  const keeper = await actorFor(['WAREHOUSE']);
  const admin = await actorFor(['ADMIN']);
  const courier = await actorFor(['COURIER']);

  const orders: { id: string; number: string }[] = [];
  for (let index = 0; index < orderCount; index += 1) {
    orders.push(await seedOrder());
  }

  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('ART'),
      deliveryDate: toDateColumn(DAY),
      state: 'CONFIRMED',
      vehicleType: 'CAR',
      createdById: admin.userId,
      courierUserId: courier.userId,
    },
    select: { id: true, number: true },
  });

  let position = 1;
  for (const order of orders) {
    await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId: order.id, position, addedById: admin.userId },
    });
    position += 1;
  }

  const storage = await seedCell('STORAGE');
  const routeCell = await seedCell('ROUTE');
  await bindRouteCell(flow, keeper, route.id, { cellCode: routeCell.code }, CONTEXT);
  for (const order of orders) {
    await receiveOrder(
      flow,
      keeper,
      { orderNumber: order.number, cellCode: storage.code },
      CONTEXT,
    );
    await pickOrderToRouteCell(
      flow,
      keeper,
      route.id,
      { orderNumber: order.number, cellCode: routeCell.code },
      CONTEXT,
    );
  }

  return {
    routeId: route.id,
    routeNumber: route.number,
    orders,
    routeCell,
    storage,
    courierUserId: courier.userId,
    keeperToken: await tokenFor(['WAREHOUSE']),
  };
}

/** Все новые пути раздела в одном месте: матрица проверяется целиком. */
function endpointsOf(stand: Stand): { method: 'GET' | 'POST'; url: string; payload?: unknown }[] {
  return [
    { method: 'GET', url: '/api/warehouse/settings' },
    { method: 'GET', url: '/api/warehouse/assembly' },
    { method: 'GET', url: '/api/warehouse/issue-board' },
    {
      method: 'POST',
      url: `/api/warehouse/routes/${stand.routeId}/issue/check`,
      payload: { orderNumber: stand.orders[0]?.number ?? '' },
    },
    {
      method: 'POST',
      url: `/api/warehouse/routes/${stand.routeId}/issue/checks/reset`,
      payload: {},
    },
    { method: 'POST', url: `/api/warehouse/routes/${stand.routeId}/ship`, payload: {} },
  ];
}

// --- 1. Роли -----------------------------------------------------------------

describe('права на новые маршруты выдачи', () => {
  it('аноним не проходит ни на один путь', async () => {
    const stand = await seedRoute(1);

    for (const endpoint of endpointsOf(stand)) {
      const response = await call(endpoint.method, endpoint.url, null, endpoint.payload);
      expect(response.statusCode, endpoint.url).toBe(401);
    }
  });

  it('логист, курьер, флорист и менеджер получают отказ', async () => {
    const stand = await seedRoute(1);

    for (const roles of [['LOGISTICIAN'], ['COURIER'], ['FLORIST'], ['MANAGER']] as Role[][]) {
      const token = await tokenFor(roles);
      for (const endpoint of endpointsOf(stand)) {
        const response = await call(endpoint.method, endpoint.url, token, endpoint.payload);
        expect(response.statusCode, `${roles.join()} ${endpoint.url}`).toBe(403);
      }
    }
  });

  it('кладовщик и администратор работают', async () => {
    // Лист нужен, чтобы доски были не пустыми: пустой ответ 200 доказал бы
    // только маршрутизацию Fastify.
    await seedRoute(1);

    for (const roles of [['WAREHOUSE'], ['ADMIN']] as Role[][]) {
      const token = await tokenFor(roles);
      for (const url of [
        '/api/warehouse/settings',
        '/api/warehouse/assembly',
        '/api/warehouse/issue-board',
      ]) {
        expect((await call('GET', url, token)).statusCode, `${roles.join()} ${url}`).toBe(200);
      }
    }
  });

  it('прежнего поштучного пути выдачи не существует ни для кого', async () => {
    const stand = await seedRoute(1);

    for (const roles of [['WAREHOUSE'], ['ADMIN']] as Role[][]) {
      const token = await tokenFor(roles);
      const response = await call('POST', `/api/warehouse/routes/${stand.routeId}/issue`, token, {
        orderNumber: stand.orders[0]?.number ?? '',
      });
      expect(response.statusCode, roles.join()).toBe(404);
    }

    // И ни одна коробка не покинула полку от такой попытки.
    expect(
      await ctx.db.orderPlacement.count({
        where: { orderId: stand.orders[0]?.id ?? '', releasedAt: null },
      }),
    ).toBe(1);
  });

  it('ручной ввод номеров включает только администратор', async () => {
    const admin = await tokenFor(['ADMIN']);
    const current = (await call('GET', '/api/settings/planning', admin)).json() as {
      warehouseManualEntry: { value: { enabled: boolean }; version: number };
    };

    for (const roles of [['WAREHOUSE'], ['LOGISTICIAN'], ['MANAGER']] as Role[][]) {
      const token = await tokenFor(roles);
      const response = await call('PUT', '/api/settings/warehouse/manual-entry', token, {
        value: { enabled: true },
        expectedVersion: current.warehouseManualEntry.version,
      });
      expect(response.statusCode, roles.join()).toBe(403);
    }
    expect(
      (
        await call('PUT', '/api/settings/warehouse/manual-entry', null, {
          value: { enabled: true },
          expectedVersion: current.warehouseManualEntry.version,
        })
      ).statusCode,
    ).toBe(401);

    // Настройка по-прежнему та же: отказы её не изменили.
    const after = (await call('GET', '/api/settings/planning', admin)).json() as {
      warehouseManualEntry: { version: number };
    };
    expect(after.warehouseManualEntry.version).toBe(current.warehouseManualEntry.version);
  });
});

// --- 2. Клиент не источник истины --------------------------------------------

describe('сервер не верит клиенту на слово', () => {
  it('отгрузка не принимает состав и счётчик из тела запроса', async () => {
    const stand = await seedRoute(2);

    // Курьер подтверждён, но внесён только один заказ из двух.
    await call('POST', `/api/warehouse/routes/${stand.routeId}/courier`, stand.keeperToken, {
      courierUserId: stand.courierUserId,
    });
    await call('POST', `/api/warehouse/routes/${stand.routeId}/issue/check`, stand.keeperToken, {
      orderNumber: stand.orders[0]?.number ?? '',
    });

    const response = await call(
      'POST',
      `/api/warehouse/routes/${stand.routeId}/ship`,
      stand.keeperToken,
      {
        // Всё это клиент присылает зря: сервер считает сам.
        issued: 2,
        checked: 2,
        total: 2,
        orderIds: stand.orders.map((order) => order.id),
        expectedVersion: 99,
        force: true,
      },
    );

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('ещё не внесён');

    // Ни одна коробка не уехала: полувыдачи не бывает.
    for (const order of stand.orders) {
      expect(
        await ctx.db.orderPlacement.count({ where: { orderId: order.id, releasedAt: null } }),
      ).toBe(1);
    }
    const route = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: stand.routeId },
      select: { state: true },
    });
    expect(route.state).toBe('CONFIRMED');
  });

  it('внести можно только заказ ЭТОГО листа', async () => {
    const stand = await seedRoute(1);
    const foreign = await seedRoute(1);

    await call('POST', `/api/warehouse/routes/${stand.routeId}/courier`, stand.keeperToken, {
      courierUserId: stand.courierUserId,
    });

    const response = await call(
      'POST',
      `/api/warehouse/routes/${stand.routeId}/issue/check`,
      stand.keeperToken,
      { orderNumber: foreign.orders[0]?.number ?? '' },
    );
    expect(response.statusCode).toBe(409);
    expect(
      await ctx.db.routeIssueCheck.count({ where: { session: { routeId: stand.routeId } } }),
    ).toBe(0);
  });

  it('внесение до подтверждения курьера отвергается', async () => {
    const stand = await seedRoute(1);

    const response = await call(
      'POST',
      `/api/warehouse/routes/${stand.routeId}/issue/check`,
      stand.keeperToken,
      { orderNumber: stand.orders[0]?.number ?? '' },
    );

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('курьер');
  });

  it('чужая полка не становится своей от признака в запросе', async () => {
    const stand = await seedRoute(1);
    const foreign = await seedRoute(1);

    const response = await call(
      'POST',
      `/api/warehouse/routes/${stand.routeId}/pick`,
      stand.keeperToken,
      {
        orderNumber: stand.orders[0]?.number ?? '',
        cellCode: foreign.routeCell.code,
        // Признак «займи свободную» не делает занятую полку свободной.
        bindIfFree: true,
      },
    );

    expect(response.statusCode).toBe(409);
    const bindings = await ctx.db.routeCellBinding.findMany({
      where: { cellId: foreign.routeCell.id, releasedAt: null },
      select: { routeId: true },
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.routeId).toBe(foreign.routeId);
  });

  it('сброс проверки не трогает размещения и доступен только своему листу', async () => {
    const stand = await seedRoute(2);
    await call('POST', `/api/warehouse/routes/${stand.routeId}/courier`, stand.keeperToken, {
      courierUserId: stand.courierUserId,
    });
    for (const order of stand.orders) {
      await call('POST', `/api/warehouse/routes/${stand.routeId}/issue/check`, stand.keeperToken, {
        orderNumber: order.number,
      });
    }

    const response = await call(
      'POST',
      `/api/warehouse/routes/${stand.routeId}/issue/checks/reset`,
      stand.keeperToken,
      {},
    );
    expect(response.statusCode).toBe(200);

    // Коробки на месте, отметки закрыты, а не стёрты.
    for (const order of stand.orders) {
      expect(
        await ctx.db.orderPlacement.count({ where: { orderId: order.id, releasedAt: null } }),
      ).toBe(1);
    }
    expect(
      await ctx.db.routeIssueCheck.count({ where: { session: { routeId: stand.routeId } } }),
    ).toBe(2);
    expect(
      await ctx.db.routeIssueCheck.count({
        where: { session: { routeId: stand.routeId }, clearedAt: null },
      }),
    ).toBe(0);
  });
});
