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
  const response = await call('POST', '/api/routes/empty', token, {
    deliveryDate,
    vehicleType: 'CAR',
  });
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

describe('календарная дата маршрута', () => {
  it('несуществующая дата отклоняется и ничего не создаёт', async () => {
    const token = await tokenFor(['ADMIN']);
    const routesBefore = await ctx.db.deliveryRoute.count();
    const countersBefore = await ctx.db.routeNumberCounter.count();
    const auditBefore = await ctx.db.auditLog.count({ where: { entityType: 'DeliveryRoute' } });
    const eventsBefore = await ctx.db.realtimeEvent.count();

    for (const deliveryDate of ['2026-02-30', '2026-13-01', '2025-02-29']) {
      const response = await call('POST', '/api/routes/empty', token, {
        deliveryDate,
        vehicleType: 'CAR',
      });
      expect(response.statusCode, deliveryDate).toBe(400);
      expect((response.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    }

    expect(await ctx.db.deliveryRoute.count()).toBe(routesBefore);
    expect(await ctx.db.routeNumberCounter.count()).toBe(countersBefore);
    expect(await ctx.db.auditLog.count({ where: { entityType: 'DeliveryRoute' } })).toBe(
      auditBefore,
    );
    expect(await ctx.db.realtimeEvent.count()).toBe(eventsBefore);
  });

  it('високосный день принимается', async () => {
    const token = await tokenFor(['ADMIN']);
    const response = await call('POST', '/api/routes/empty', token, {
      deliveryDate: '2024-02-29',
      vehicleType: 'CAR',
    });

    expect(response.statusCode).toBe(201);
    expect((response.json() as { number: string }).number).toBe('R-2024-02-29-001');
  });

  it('сервисный слой отвергает несуществующую дату и без HTTP', async () => {
    const { createEmptyDraft } = await import('./service.js');
    const actor = {
      userId: (await seedUser(ctx.db, { roles: ['ADMIN'] })).id,
      familyId: randomUUID(),
      roles: ['ADMIN'] as Role[],
      fullName: 'Проверка',
      phone: '+79990000000',
    };

    await expect(
      createEmptyDraft(
        { db: ctx.db },
        actor,
        { deliveryDate: '2026-02-30', vehicleType: 'CAR' },
        { ip: null, userAgent: null },
      ),
    ).rejects.toThrow();
  });

  it('несуществующая дата в фильтре списка не подменяется соседним днём', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    // Маршрут первого марта существует: нормализованная «30 февраля» вернула бы его.
    const march = await createRoute(token, '2026-03-01');

    const invalid = await call('GET', '/api/routes?deliveryDate=2026-02-30', token);
    expect(invalid.statusCode).toBe(400);

    const valid = await call('GET', '/api/routes?deliveryDate=2026-03-01', token);
    expect(valid.statusCode).toBe(200);
    expect((valid.json() as { items: { id: string }[] }).items.map((item) => item.id)).toContain(
      march.id,
    );
  });
});

describe('выборка нераспределённых заказов для экрана', () => {
  async function tokenFor(roles: Role[]): Promise<string> {
    const { hashSecretCode } = await import('../auth/crypto.js');
    const { login } = await import('../auth/service.js');
    const pin = '1234';
    const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
    const user = await seedUser(ctx.db, { roles, status: 'ACTIVE', pinHash });
    const session = await login(
      ctx,
      { phone: user.phone, pin },
      { ip: null, userAgent: 'vitest', deviceLabel: null },
    );
    return session.accessToken;
  }

  async function unassigned(token: string, day: string): Promise<string[]> {
    const response = await call(
      'GET',
      `/api/orders?unassigned=true&deliveryDate=${day}&limit=100`,
      token,
    );
    expect(response.statusCode).toBe(200);
    return (response.json() as { items: { id: string }[] }).items.map((item) => item.id);
  }

  it('отдаёт только пригодные и действительно свободные заказы', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const day = '2026-11-20';
    const at = (date: string): Record<string, unknown> => ({
      deliveryPlannedMoment: `${date} 12:00:00.000`,
    });

    const free = await seedOrder(at(day));
    const otherDay = await seedOrder(at('2026-11-21'));
    const withoutDate = await seedOrder({ deliveryPlannedMoment: null });

    const outOfScope = await seedOrder(at(day));
    await ctx.db.deliveryOrder.update({
      where: { id: outOfScope },
      data: { inScope: false, scopeExitReason: 'STORE_CHANGED' },
    });

    const missing = await seedOrder(at(day));
    await ctx.db.deliveryOrder.update({ where: { id: missing }, data: { sourceMissing: true } });

    const archived = await seedOrder(at(day));
    await ctx.db.deliveryOrder.update({ where: { id: archived }, data: { sourceArchived: true } });

    // Уже распределённый заказ в выборку попадать не должен.
    const assigned = await seedOrder(at(day));
    const route = await createRoute(token, day);
    await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [assigned],
      expectedVersion: route.version,
    });

    const ids = await unassigned(token, day);

    expect(ids).toContain(free);
    for (const [name, id] of [
      ['другой день', otherDay],
      ['без даты', withoutDate],
      ['вне области', outOfScope],
      ['пропавший', missing],
      ['архивный', archived],
      ['уже распределён', assigned],
    ] as const) {
      expect(ids, name).not.toContain(id);
    }
  });

  it('возвращённый заказ снова становится доступным', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const day = '2026-11-22';
    const orderId = await seedOrder({ deliveryPlannedMoment: `${day} 12:00:00.000` });
    const route = await createRoute(token, day);

    const added = await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });
    expect(await unassigned(token, day)).not.toContain(orderId);

    await call('POST', `/api/routes/${route.id}/orders/return`, token, {
      orderIds: [orderId],
      expectedVersion: (added.json() as RouteCard).version,
    });
    expect(await unassigned(token, day)).toContain(orderId);
  });

  it('нераспределённые нельзя запросить вне нашей области', async () => {
    const token = await tokenFor(['LOGISTICIAN']);

    // Несовместимые параметры отклоняются, а не «выигрывает последний».
    const response = await call(
      'GET',
      '/api/orders?unassigned=true&inScope=false&deliveryDate=2026-11-20',
      token,
    );
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  it('поиск не отменяет ограничение выбранного дня', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const day = '2026-11-24';
    const marker = `Маркер-${Date.now()}`;

    const sameDay = await seedOrder({
      deliveryPlannedMoment: `${day} 12:00:00.000`,
      shipmentAddress: `Москва, ${marker}`,
    });
    const otherDay = await seedOrder({
      deliveryPlannedMoment: '2026-11-25 12:00:00.000',
      shipmentAddress: `Москва, ${marker}`,
    });

    const found = await call(
      'GET',
      `/api/orders?unassigned=true&deliveryDate=${day}&search=${encodeURIComponent(marker)}`,
      token,
    );
    expect(found.statusCode).toBe(200);
    const ids = (found.json() as { items: { id: string }[] }).items.map((item) => item.id);

    expect(ids).toContain(sameDay);
    // Заказ соседнего дня с тем же адресом в выборку попасть не должен:
    // иначе он оказался бы в маршруте чужой даты.
    expect(ids).not.toContain(otherDay);
  });

  it('курьер и склад выборку не получают', async () => {
    for (const roles of [['COURIER'], ['WAREHOUSE']] as Role[][]) {
      const response = await call(
        'GET',
        '/api/orders?unassigned=true&deliveryDate=2026-11-20',
        await tokenFor(roles),
      );
      expect(response.statusCode, roles.join()).toBe(403);
    }
  });

  it('карточка маршрута отдаёт сумму к получению строкой и без лишних финансов', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const day = '2026-11-23';
    const orderId = await seedOrder({
      deliveryPlannedMoment: `${day} 12:00:00.000`,
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
        {
          id: IDS.paymentTypeAttribute,
          value: {
            name: 'Наличные/карта на ТТ',
            meta: { href: href('customentity', IDS.paymentTypeCash) },
          },
        },
      ],
    });
    const route = await createRoute(token, day);
    const added = await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });

    const body = added.json() as {
      orders: { order: { cashToCollect: string | null } }[];
    };
    expect(body.orders[0]?.order.cashToCollect).toBe('4990.00');

    const serialized = added.body;
    // Ни сырого снимка, ни копеек, ни хешей: печатному листу нужна одна сумма.
    expect(serialized).not.toContain('sumMinor');
    expect(serialized).not.toContain('snapshotHash');
    expect(serialized).not.toContain('payedSum');
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
        (await call('POST', '/api/routes/empty', token, { deliveryDate: DAY, vehicleType: 'CAR' }))
          .statusCode,
        roles.join(),
      ).toBe(403);
    }

    expect((await call('GET', '/api/routes', null)).statusCode).toBe(401);
    expect((await call('POST', '/api/routes/move', null, {})).statusCode).toBe(401);
  });
});

// --- Состав маршрута --------------------------------------------------------

describe('пустой черновик', () => {
  it('создаётся ровно один черновик выбранного дня: без заказов и без курьера', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const before = (
      await call('GET', `/api/routes?deliveryDate=${DAY}&state=DRAFT`, token)
    ).json() as {
      total: number;
    };

    const response = await call('POST', '/api/routes/empty', token, {
      deliveryDate: DAY,
      vehicleType: 'CAR',
      creationKey: randomUUID(),
    });
    expect(response.statusCode).toBe(201);
    const created = response.json() as { id: string; repeated: boolean };
    expect(created.repeated).toBe(false);

    const view = await card(token, created.id);
    expect(view.state).toBe('DRAFT');
    expect(view.orders).toHaveLength(0);
    expect(view.courier).toBeNull();

    const after = (
      await call('GET', `/api/routes?deliveryDate=${DAY}&state=DRAFT`, token)
    ).json() as {
      total: number;
      items: { id: string; deliveryDate: string }[];
    };
    expect(after.total).toBe(before.total + 1);
    expect(after.items.find((item) => item.id === created.id)?.deliveryDate).toBe(DAY);
  });

  it('повтор одного запроса возвращает прежний черновик, а не создаёт второй', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const creationKey = randomUUID();
    const body = { deliveryDate: DAY, vehicleType: 'CAR', creationKey };

    const first = await call('POST', '/api/routes/empty', token, body);
    expect(first.statusCode).toBe(201);
    const second = await call('POST', '/api/routes/empty', token, body);
    // 200, а не 201: второго черновика не появилось.
    expect(second.statusCode).toBe(200);

    const one = first.json() as { id: string; number: string };
    const two = second.json() as { id: string; number: string; repeated: boolean };
    expect(two.id).toBe(one.id);
    expect(two.number).toBe(one.number);
    expect(two.repeated).toBe(true);
  });

  it('два нажатия дают два черновика, а повтор первого — по-прежнему два', async () => {
    /*
     * Ключ принадлежит НАЖАТИЮ, а не дню и не экрану.
     *
     * Осознанное второе нажатие — это второй черновик: логист заводит их
     * столько, сколько нужно машин. Повторно ушедший тот же запрос — это
     * по-прежнему одно нажатие, и третьего черновика он не создаёт.
     */
    const token = await tokenFor(['LOGISTICIAN']);
    const day = '2026-09-14';
    const countDrafts = async (): Promise<number> =>
      (
        (await call('GET', `/api/routes?deliveryDate=${day}&state=DRAFT`, token)).json() as {
          total: number;
        }
      ).total;

    expect(await countDrafts()).toBe(0);

    const firstPress = { deliveryDate: day, vehicleType: 'CAR', creationKey: randomUUID() };
    const secondPress = { deliveryDate: day, vehicleType: 'CAR', creationKey: randomUUID() };

    const first = await call('POST', '/api/routes/empty', token, firstPress);
    const second = await call('POST', '/api/routes/empty', token, secondPress);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    const one = first.json() as { id: string; number: string };
    const two = second.json() as { id: string; number: string };
    expect(two.id).not.toBe(one.id);
    expect(two.number).not.toBe(one.number);
    expect(await countDrafts()).toBe(2);

    // Повтор запроса ПЕРВОГО нажатия: тот же черновик, третьего нет.
    const repeat = await call('POST', '/api/routes/empty', token, firstPress);
    expect(repeat.statusCode).toBe(200);
    expect((repeat.json() as { id: string }).id).toBe(one.id);
    expect(await countDrafts()).toBe(2);
  });

  it('одинаковые дата и тип машины сами по себе повтором не считаются', async () => {
    // Ключа нет вовсе — значит, нажатий было столько, сколько запросов.
    const token = await tokenFor(['LOGISTICIAN']);
    const one = await createRoute(token);
    const two = await createRoute(token);

    expect(two.id).not.toBe(one.id);
  });

  it('в пустой черновик перекладывается нераспределённый заказ', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);
    const orderId = await seedOrder();

    const added = await call('POST', `/api/routes/${route.id}/orders`, token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });
    expect(added.statusCode).toBe(200);
    expect((added.json() as RouteCard).orders.map((item) => item.order.id)).toEqual([orderId]);
  });

  it('пустой черновик отменяется с причиной', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);

    const cancelled = await call('POST', `/api/routes/${route.id}/cancel`, token, {
      expectedVersion: route.version,
      reason: 'Заведён по ошибке',
    });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as RouteCard).state).toBe('CANCELLED');
  });

  it('общий контракт создания из выбора не ослаблен пустым составом', async () => {
    /*
     * Пустой черновик появляется только явным действием. Пустой `orderIds`
     * в создании из выбора по-прежнему ошибка: иначе случайно снятая галочка
     * молча заводила бы маршрут без заказов.
     */
    const token = await tokenFor(['LOGISTICIAN']);
    const response = await call('POST', '/api/routes/from-selection', token, {
      deliveryDate: DAY,
      vehicleType: 'CAR',
      orderIds: [],
    });

    expect(response.statusCode).toBe(400);
  });

  it('создание пустого черновика записывается в аудит', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);

    const entries = await ctx.db.auditLog.findMany({
      where: { entityId: route.id, action: 'ROUTE_CREATED' },
      select: { newValue: true },
    });
    expect(entries).toHaveLength(1);
    expect((entries[0]?.newValue as { totalOrders?: number; state?: string }).totalOrders).toBe(0);
    expect((entries[0]?.newValue as { state?: string }).state).toBe('DRAFT');
  });
});

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

describe('перенос между черновиками с арендой обоих', () => {
  async function tokenFor(roles: Role[]): Promise<string> {
    const { hashSecretCode } = await import('../auth/crypto.js');
    const { login } = await import('../auth/service.js');
    const pin = '1234';
    const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
    const user = await seedUser(ctx.db, { roles, status: 'ACTIVE', pinHash });
    const session = await login(
      ctx,
      { phone: user.phone, pin },
      { ip: null, userAgent: 'vitest', deviceLabel: null },
    );
    return session.accessToken;
  }

  it('захват целевого маршрута делает перенос выполнимым', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const from = await createRoute(token);
    const to = await createRoute(token);
    const orderId = await seedOrder();

    const added = await call('POST', `/api/routes/${from.id}/orders`, token, {
      orderIds: [orderId],
      expectedVersion: from.version,
    });

    // Целевой маршрут берётся в работу ровно так, как это делает интерфейс.
    const acquired = await call('POST', `/api/routes/${to.id}/edit-lock/acquire`, token, {});
    expect(acquired.statusCode).toBe(200);
    // Аренда была выдана этой операцией, а не продлена: её нужно вернуть после.
    expect((acquired.json() as { granted: boolean }).granted).toBe(false);

    const target = (await call('GET', `/api/routes/${to.id}`, token)).json() as {
      version: number;
    };

    const moved = await call('POST', '/api/routes/move', token, {
      fromRouteId: from.id,
      toRouteId: to.id,
      orderIds: [orderId],
      expectedSourceVersion: (added.json() as RouteCard).version,
      expectedTargetVersion: target.version,
    });
    expect(moved.statusCode).toBe(200);

    expect(await ctx.db.routeOrder.count({ where: { routeId: to.id, removedAt: null } })).toBe(1);
    expect(await ctx.db.routeOrder.count({ where: { routeId: from.id, removedAt: null } })).toBe(0);
  });

  it('без аренды целевого маршрута перенос не выполняется и состав не меняется', async () => {
    const owner = await tokenFor(['LOGISTICIAN']);
    const rival = await tokenFor(['LOGISTICIAN']);
    const from = await createRoute(owner);
    const to = await createRoute(rival);
    const orderId = await seedOrder();

    const added = await call('POST', `/api/routes/${from.id}/orders`, owner, {
      orderIds: [orderId],
      expectedVersion: from.version,
    });

    // Целевой маршрут держит другой редактор: захват отказывает.
    const acquire = await call('POST', `/api/routes/${to.id}/edit-lock/acquire`, owner, {});
    expect(acquire.statusCode).toBe(409);

    const moved = await call('POST', '/api/routes/move', owner, {
      fromRouteId: from.id,
      toRouteId: to.id,
      orderIds: [orderId],
      expectedSourceVersion: (added.json() as RouteCard).version,
      expectedTargetVersion: to.version,
    });
    expect(moved.statusCode).toBe(409);

    expect(await ctx.db.routeOrder.count({ where: { routeId: from.id, removedAt: null } })).toBe(1);
    expect(await ctx.db.routeOrder.count({ where: { routeId: to.id } })).toBe(0);
  });

  it('повторный захват собственного маршрута не выдаёт новую аренду', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const route = await createRoute(token);

    // Создатель уже держит маршрут: интерфейс не должен освобождать его после операции.
    const acquired = await call('POST', `/api/routes/${route.id}/edit-lock/acquire`, token, {});
    expect(acquired.statusCode).toBe(200);
    expect((acquired.json() as { granted: boolean }).granted).toBe(false);
  });
});

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
