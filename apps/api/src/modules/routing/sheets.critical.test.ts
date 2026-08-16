/**
 * Проверки экрана маршрутных листов.
 *
 * Защищаемые свойства: разделы не смешиваются, листы без курьера видны первыми,
 * а фильтр и поиск работают на ПОЛНОМ серверном наборе — иначе лист со второй
 * страницы исчезал бы из поиска вовсе.
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
import { listSheets } from './sheets.js';

let ctx: TestContext;
const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;
const TODAY = '2027-12-20';
const YESTERDAY = '2027-12-19';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

function snapshotOf(day: string): OrderSnapshot {
  return mapOrder(
    {
      id: randomUUID(),
      name: `SH-${process.hrtime.bigint() % 1_000_000n}`,
      updated: '2026-08-13 10:00:00.000',
      shipmentAddress: 'Москва, синтетическая улица, дом 1',
      deliveryPlannedMoment: `${day} 12:00:00.000`,
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

async function seedSheet(input: {
  day: string;
  state: 'CONFIRMED' | 'ACTIVE' | 'COMPLETED';
  courier?: { fullName: string; phone: string } | null;
  orders?: number;
  delivered?: number;
}): Promise<{ id: string; number: string; orderNumbers: string[] }> {
  const creator = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
  const courier =
    input.courier === undefined || input.courier === null
      ? null
      : await seedUser(ctx.db, {
          roles: ['COURIER'],
          fullName: input.courier.fullName,
          phone: input.courier.phone,
        });

  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: `SH-${process.hrtime.bigint() % 1_000_000n}`,
      deliveryDate: new Date(`${input.day}T00:00:00.000Z`),
      vehicleType: 'CAR',
      createdById: creator.id,
      state: input.state,
      ...(courier === null ? {} : { courierUserId: courier.id }),
    },
    select: { id: true, number: true },
  });

  const orderNumbers: string[] = [];
  for (let index = 0; index < (input.orders ?? 1); index += 1) {
    const snapshot = snapshotOf(input.day);
    await ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, new Date()));
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
      select: { id: true, externalName: true },
    });
    orderNumbers.push(order.externalName);
    const participation = await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId: order.id, position: index + 1, addedById: creator.id },
      select: { id: true },
    });

    if (index < (input.delivered ?? 0) && courier !== null) {
      await ctx.db.deliveryAttempt.create({
        data: {
          routeOrderId: participation.id,
          orderId: order.id,
          routeId: route.id,
          outcome: 'DELIVERED',
          courierUserId: courier.id,
          activeKey: participation.id,
        },
      });
    }
  }

  return { ...route, orderNumbers };
}

const page = { limit: 50, offset: 0 };

describe('разделы экрана', () => {
  it('каждое состояние попадает в свой раздел и не смешивается', async () => {
    const unshipped = await seedSheet({ day: TODAY, state: 'CONFIRMED' });
    const shipped = await seedSheet({
      day: TODAY,
      state: 'ACTIVE',
      courier: { fullName: 'Курьеров Курьер', phone: '+79995550001' },
    });
    const delivered = await seedSheet({
      day: TODAY,
      state: 'COMPLETED',
      courier: { fullName: 'Доставкин Пётр', phone: '+79995550002' },
      delivered: 1,
    });

    const one = await listSheets(ctx.db, { section: 'UNSHIPPED', deliveryDate: TODAY, ...page });
    const two = await listSheets(ctx.db, { section: 'SHIPPED', deliveryDate: TODAY, ...page });
    const three = await listSheets(ctx.db, { section: 'DELIVERED', deliveryDate: TODAY, ...page });

    const numbersOf = (result: { days: { sheets: { number: string }[] }[] }): string[] =>
      result.days.flatMap((day) => day.sheets.map((sheet) => sheet.number));

    expect(numbersOf(one)).toContain(unshipped.number);
    expect(numbersOf(one)).not.toContain(shipped.number);
    expect(numbersOf(two)).toContain(shipped.number);
    expect(numbersOf(three)).toContain(delivered.number);
    expect(numbersOf(three)).not.toContain(shipped.number);
  });

  it('в неотгруженных лист без курьера идёт первым', async () => {
    // Именно он требует решения логиста; искать его прокруткой — работа ради работы.
    const day = '2027-12-18';
    await seedSheet({
      day,
      state: 'CONFIRMED',
      courier: { fullName: 'Скорый Курьер', phone: '+79995550003' },
    });
    const orphan = await seedSheet({ day, state: 'CONFIRMED' });

    const result = await listSheets(ctx.db, { section: 'UNSHIPPED', deliveryDate: day, ...page });

    expect(result.days[0]?.sheets[0]?.number).toBe(orphan.number);
    expect(result.days[0]?.sheets[0]?.courier).toBeNull();
  });

  it('листы разложены по московским дням, свежие дни впереди', async () => {
    await seedSheet({
      day: YESTERDAY,
      state: 'ACTIVE',
      courier: { fullName: 'Вчерашний', phone: '+79995550004' },
    });
    await seedSheet({
      day: TODAY,
      state: 'ACTIVE',
      courier: { fullName: 'Сегодняшний', phone: '+79995550005' },
    });

    const result = await listSheets(ctx.db, { section: 'SHIPPED', ...page });
    const days = result.days.map((day) => day.date);

    expect(days).toContain(TODAY);
    expect(days).toContain(YESTERDAY);
    expect(days.indexOf(TODAY)).toBeLessThan(days.indexOf(YESTERDAY));
  });
});

describe('фильтр и поиск работают на всём серверном наборе', () => {
  it('фильтр даты оставляет только свой день', async () => {
    const day = '2027-12-17';
    const own = await seedSheet({ day, state: 'CONFIRMED' });
    await seedSheet({ day: '2027-12-16', state: 'CONFIRMED' });

    const result = await listSheets(ctx.db, { section: 'UNSHIPPED', deliveryDate: day, ...page });

    expect(result.days).toHaveLength(1);
    expect(result.days[0]?.date).toBe(day);
    expect(result.days[0]?.sheets.map((sheet) => sheet.number)).toContain(own.number);
  });

  it('поиск находит по номеру листа, номеру заказа, имени и телефону курьера', async () => {
    const day = '2027-12-15';
    const sheet = await seedSheet({
      day,
      state: 'ACTIVE',
      courier: { fullName: 'Иванов Иван Иванович', phone: '+79997771234' },
      orders: 2,
    });

    const byNumber = await listSheets(ctx.db, {
      section: 'SHIPPED',
      search: sheet.number,
      ...page,
    });
    const byOrder = await listSheets(ctx.db, {
      section: 'SHIPPED',
      search: sheet.orderNumbers[0] ?? '',
      ...page,
    });
    const byName = await listSheets(ctx.db, { section: 'SHIPPED', search: 'иванов', ...page });
    const byPhone = await listSheets(ctx.db, { section: 'SHIPPED', search: '7771234', ...page });

    for (const result of [byNumber, byOrder, byName, byPhone]) {
      expect(result.days.flatMap((item) => item.sheets.map((row) => row.number))).toContain(
        sheet.number,
      );
    }
  });

  it('поиск не ограничен загруженной страницей', async () => {
    // Лист со второй страницы обязан находиться поиском, а не исчезать из него.
    const day = '2027-12-14';
    for (let index = 0; index < 3; index += 1) {
      await seedSheet({ day, state: 'CONFIRMED' });
    }
    const hidden = await seedSheet({ day, state: 'CONFIRMED' });

    const firstPage = await listSheets(ctx.db, {
      section: 'UNSHIPPED',
      deliveryDate: day,
      limit: 2,
      offset: 0,
    });
    const found = await listSheets(ctx.db, {
      section: 'UNSHIPPED',
      deliveryDate: day,
      search: hidden.number,
      limit: 2,
      offset: 0,
    });

    expect(firstPage.total).toBeGreaterThan(2);
    expect(firstPage.hasMore).toBe(true);
    expect(found.days.flatMap((item) => item.sheets.map((row) => row.number))).toEqual([
      hidden.number,
    ]);
  });

  it('доставленные заказы названы номерами: их показывает предупреждение об отмене', async () => {
    const day = '2027-12-13';
    const sheet = await seedSheet({
      day,
      state: 'ACTIVE',
      courier: { fullName: 'Частичный Курьер', phone: '+79995550006' },
      orders: 3,
      delivered: 2,
    });

    const result = await listSheets(ctx.db, { section: 'SHIPPED', deliveryDate: day, ...page });
    const view = result.days[0]?.sheets.find((row) => row.number === sheet.number);

    expect(view?.totalOrders).toBe(3);
    expect(view?.deliveredOrders).toBe(2);
    expect(view?.deliveredNumbers).toHaveLength(2);
    // Ни адресов, ни получателей, ни телефонов — только номера заказов.
    expect(JSON.stringify(view)).not.toContain('улица');
  });
});
