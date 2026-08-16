/**
 * Проверки геометрии маршрута.
 *
 * Защищаемые свойства: маршрут начинается со склада, порядок остановок равен
 * порядку маршрута, возврат не дорисовывается, а отказ маршрутизатора не
 * подменяется прямыми линиями и не блокирует ручную работу.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { applyOrderSnapshot } from '../integrations/moysklad/import-service.js';
import { mapOrder, type OrderSnapshot } from '../integrations/moysklad/mapper.js';
import { ValhallaError, type LatLon } from '../integrations/valhalla/client.js';
import { routeGeometry, type RouteGeometryRouter } from './geometry.js';

let ctx: TestContext;
const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;
const DAY = '2027-11-05';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

function snapshotOf(): OrderSnapshot {
  return mapOrder(
    {
      id: randomUUID(),
      name: `GEO-${process.hrtime.bigint() % 1_000_000n}`,
      updated: '2026-08-13 10:00:00.000',
      shipmentAddress: 'Москва, синтетическая улица, дом 1',
      deliveryPlannedMoment: `${DAY} 12:00:00.000`,
      sum: 100000,
      payedSum: 0,
      store: { meta: { href: href('store', IDS.store) } },
      attributes: [
        {
          id: IDS.deliveryMethodAttribute,
          value: {
            name: 'Доставка',
            meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
          },
        },
        { id: IDS.intervalAttribute, value: 'с 10:00 по 14:00' },
        { id: IDS.recipientAttribute, value: 'Получатель Синтетический' },
      ],
    } as never,
    IDS,
  ).snapshot;
}

async function seedOrder(lat: number, lon: number): Promise<string> {
  const snapshot = snapshotOf();
  await ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, new Date()));
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { externalId: snapshot.externalId },
    select: { id: true },
  });
  await ctx.db.deliveryOrder.update({
    where: { id: order.id },
    data: {
      needsAttention: false,
      attentionReasons: [],
      geoState: 'RESOLVED',
      geoSource: 'DADATA',
      geoPrecision: 'EXACT_HOUSE',
      geoLatMicro: Math.round(lat * 1_000_000),
      geoLonMicro: Math.round(lon * 1_000_000),
      geoResolvedAt: new Date(),
    },
  });
  return order.id;
}

/**
 * Основной склад дня.
 *
 * База общая: склад по умолчанию мог создать соседний файл проверок, и он
 * такой ровно один. Поэтому здесь не «свой» склад, а тот, который система
 * действительно возьмёт за начало маршрута — его координаты и проверяются.
 */
async function mainDepot(): Promise<{ name: string; lat: number; lon: number }> {
  await seedDepot();
  const depot = await ctx.db.depot.findFirstOrThrow({
    where: { defaultKey: { not: null }, isActive: true },
    select: { name: true, latMicro: true, lonMicro: true },
  });
  return {
    name: depot.name,
    lat: (depot.latMicro ?? 0) / 1_000_000,
    lon: (depot.lonMicro ?? 0) / 1_000_000,
  };
}

async function seedDepot(): Promise<string> {
  const creator = await seedUser(ctx.db, { roles: ['ADMIN'] });
  const existing = await ctx.db.depot.findFirst({ where: { defaultKey: { not: null } } });
  if (existing !== null) {
    return existing.id;
  }
  const depot = await ctx.db.depot.create({
    data: {
      name: 'Склад геометрии',
      address: 'Москва, складская улица, 1',
      latMicro: 55_700_000,
      lonMicro: 37_500_000,
      // Склад по умолчанию обязан иметь ПОДТВЕРЖДЁННУЮ точку: этого требует
      // ограничение `Depot_default_has_point`, и именно её рисует карта.
      pointConfirmedAt: new Date(),
      isActive: true,
      // Значение ключа закреплено ограничением `Depot_default_key_shape`:
      // склад по умолчанию ровно один, и опознаётся он этим значением.
      defaultKey: 'default',
      createdById: creator.id,
    },
    select: { id: true },
  });
  return depot.id;
}

async function seedRoute(orderIds: readonly string[]): Promise<string> {
  const user = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: `GEO-${process.hrtime.bigint() % 1_000_000n}`,
      deliveryDate: new Date(`${DAY}T00:00:00.000Z`),
      vehicleType: 'CAR',
      createdById: user.id,
    },
    select: { id: true },
  });
  let position = 0;
  for (const orderId of orderIds) {
    position += 1;
    await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId, position, addedById: user.id },
    });
  }
  return route.id;
}

/** Маршрутизатор, который запоминает запрос и отдаёт заданную линию. */
function router(
  behaviour: 'ok' | 'fail' | 'off' = 'ok',
): RouteGeometryRouter & { asked: LatLon[] } {
  const asked: LatLon[] = [];
  return {
    asked,
    configured: behaviour !== 'off',
    async route(points) {
      asked.push(...points);
      if (behaviour === 'fail') {
        throw new ValhallaError('TRANSPORT_ERROR');
      }
      return {
        line: points.map((point) => [point.lon, point.lat] as [number, number]),
        timeSeconds: 600,
        distanceMeters: 12_000,
      };
    },
  };
}

describe('геометрия маршрута', () => {
  it('маршрут начинается со склада и идёт по порядку остановок', async () => {
    const depot = await mainDepot();
    const first = await seedOrder(55.751244, 37.618423);
    const second = await seedOrder(55.76, 37.64);
    const routeId = await seedRoute([first, second]);
    const valhalla = router();

    const view = await routeGeometry(ctx.db, valhalla, routeId);

    expect(view.depot?.name).toBe(depot.name);
    expect(view.stops.map((stop) => stop.position)).toEqual([1, 2]);
    expect(view.stops.map((stop) => stop.orderId)).toEqual([first, second]);
    // Первой точкой в маршрутизатор уходит именно склад.
    expect(valhalla.asked[0]).toEqual({ lat: depot.lat, lon: depot.lon });
    expect(valhalla.asked).toHaveLength(3);
    expect(view.unavailableReason).toBeNull();
    expect(view.line).toHaveLength(3);
  });

  it('возврат на склад не дорисовывается', async () => {
    // Дорисованный возврат изменил бы длину пути, которую логист принимает
    // за факт. У ручного черновика склада конца нет.
    await seedDepot();
    const only = await seedOrder(55.751244, 37.618423);
    const routeId = await seedRoute([only]);
    const valhalla = router();

    await routeGeometry(ctx.db, valhalla, routeId);

    expect(valhalla.asked).toHaveLength(2);
  });

  it('отказ маршрутизатора не подменяется прямыми линиями', async () => {
    await seedDepot();
    const only = await seedOrder(55.751244, 37.618423);
    const routeId = await seedRoute([only]);

    const view = await routeGeometry(ctx.db, router('fail'), routeId);

    expect(view.line).toEqual([]);
    expect(view.unavailableReason).toContain('связаться с маршрутизатором');
    // Состав и порядок при этом остаются: ручная работа не блокируется.
    expect(view.stops).toHaveLength(1);
  });

  it('ненастроенный маршрутизатор назван прямо', async () => {
    await seedDepot();
    const only = await seedOrder(55.751244, 37.618423);
    const routeId = await seedRoute([only]);

    const view = await routeGeometry(ctx.db, router('off'), routeId);

    expect(view.line).toEqual([]);
    expect(view.unavailableReason).toContain('не настроен');
  });

  it('заказ без подтверждённой точки в линию не входит', async () => {
    await seedDepot();
    const good = await seedOrder(55.751244, 37.618423);
    const bad = await seedOrder(55.76, 37.64);
    await ctx.db.deliveryOrder.update({
      where: { id: bad },
      data: {
        geoState: 'PENDING',
        geoSource: null,
        geoPrecision: null,
        geoLatMicro: null,
        geoLonMicro: null,
        geoResolvedAt: null,
      },
    });
    const routeId = await seedRoute([good, bad]);
    const valhalla = router();

    const view = await routeGeometry(ctx.db, valhalla, routeId);

    expect(view.stops.map((stop) => stop.orderId)).toEqual([good]);
    expect(valhalla.asked).toHaveLength(2);
  });
});
