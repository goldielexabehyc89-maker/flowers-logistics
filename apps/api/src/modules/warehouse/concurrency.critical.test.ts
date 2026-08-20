/**
 * Одновременная работа над одним листом на НАСТОЯЩЕЙ PostgreSQL.
 *
 * Склад — это два человека у одной полки. Всё, что здесь проверяется, ломается
 * только вдвоём: два скана одного заказа, скан против сброса, две кнопки
 * «Отгрузить», отгрузка против смены курьера, отмены и правки состава, две
 * полки на один лист.
 *
 * Правило одно и физическое: исход обязан быть ОДИН и согласованный.
 * Частичной выдачи и второго размещения одной коробки не бывает — коробка
 * либо уехала целиком со своим листом, либо стоит на полке.
 *
 * Проверяется на живой базе намеренно: блокировки строк, порядок ожидания
 * и уровень изоляции — это поведение PostgreSQL, а не наших функций, и
 * подделанный клиент доказал бы лишь то, что мы сами придумали.
 *
 * День подобран так, чтобы не пересекаться с другими файлами набора.
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
import type { Role } from '@fl/shared';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { createStorageCell, unknownOccupancy, type CellDeps } from './service.js';
import { receiveOrder, withdrawOrder, type FlowDeps } from './placement.js';
import {
  bindRouteCell,
  checkOrderForIssue,
  confirmCourier,
  pickOrderToRouteCell,
  resetIssueChecks,
  shipRoute,
} from './route-flow.js';
import { setCourier } from '../routing/service.js';
import { returnToDraft } from '../routing/lifecycle.js';
import { applyCancellation } from '../integrations/moysklad/cancellation.js';

let ctx: TestContext;
let flow: FlowDeps;
let cells: CellDeps;
const CONTEXT = { ip: null, userAgent: null };

/** День вне диапазонов остальных файлов набора. */
const DAY = '2028-01-17';

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

async function seedCell(kind: 'STORAGE' | 'ROUTE'): Promise<{ id: string; code: string }> {
  const actor = await actorFor(['ADMIN']);
  const created = await createStorageCell(
    cells,
    actor,
    { code: unique(kind === 'ROUTE' ? 'CR' : 'CS'), kind },
    CONTEXT,
  );
  return { id: created.id, code: created.normalizedCode };
}

async function seedOrder(): Promise<{ id: string; number: string }> {
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: unique('CW'),
      externalUpdated: new Date(),
      deliveryDate: toDateColumn(DAY),
      inScope: true,
      address: 'синтетический адрес одновременной работы',
      recipient: 'синтетический получатель',
    },
    select: { id: true, externalName: true },
  });
  return { id: order.id, number: order.externalName };
}

interface Stand {
  routeId: string;
  routeNumber: string;
  version: number;
  orders: { id: string; number: string }[];
  storage: { id: string; code: string };
  routeCell: { id: string; code: string };
  keeper: AuthenticatedActor;
  second: AuthenticatedActor;
  courier: AuthenticatedActor;
  admin: AuthenticatedActor;
}

/** Лист, готовый к отгрузке: коробки в маршрутной ячейке, курьер подтверждён. */
async function seedReadyRoute(orderCount = 2, confirmed = true): Promise<Stand> {
  const keeper = await actorFor(['WAREHOUSE']);
  const second = await actorFor(['WAREHOUSE']);
  const admin = await actorFor(['ADMIN']);
  const courier = await actorFor(['COURIER']);

  const orders: { id: string; number: string }[] = [];
  for (let index = 0; index < orderCount; index += 1) {
    orders.push(await seedOrder());
  }

  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('CRT'),
      deliveryDate: toDateColumn(DAY),
      state: 'CONFIRMED',
      vehicleType: 'CAR',
      createdById: admin.userId,
      courierUserId: courier.userId,
    },
    select: { id: true, number: true, version: true },
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

  if (confirmed) {
    await confirmCourier(flow, keeper, route.id, { courierUserId: courier.userId }, CONTEXT);
  }

  const fresh = await ctx.db.deliveryRoute.findUniqueOrThrow({
    where: { id: route.id },
    select: { version: true },
  });

  return {
    routeId: route.id,
    routeNumber: route.number,
    version: fresh.version,
    orders,
    storage,
    routeCell,
    keeper,
    second,
    courier,
    admin,
  };
}

/** Сколько заказов листа реально уехало курьеру. */
async function issuedCount(routeId: string): Promise<number> {
  return ctx.db.orderPlacement.count({
    where: { issueSession: { routeId }, releaseReason: 'ISSUED_TO_COURIER' },
  });
}

async function activeChecks(routeId: string): Promise<number> {
  return ctx.db.routeIssueCheck.count({ where: { session: { routeId }, clearedAt: null } });
}

async function routeState(routeId: string): Promise<string> {
  const route = await ctx.db.deliveryRoute.findUniqueOrThrow({
    where: { id: routeId },
    select: { state: true },
  });
  return route.state;
}

/** Действующие размещения заказа: их не может быть два. */
async function placementsOf(orderId: string): Promise<{ cellId: string }[]> {
  return ctx.db.orderPlacement.findMany({
    where: { orderId, releasedAt: null },
    select: { cellId: true },
  });
}

// --- 1. Два скана одного заказа ----------------------------------------------

describe('два кладовщика над одним листом', () => {
  it('одновременный скан одного заказа даёт ровно одну отметку', async () => {
    const stand = await seedReadyRoute(2);
    const order = stand.orders[0]!;

    const results = await Promise.allSettled([
      checkOrderForIssue(flow, stand.keeper, stand.routeId, { orderNumber: order.number }, CONTEXT),
      checkOrderForIssue(flow, stand.second, stand.routeId, { orderNumber: order.number }, CONTEXT),
    ]);

    // Оба ответа законны: повтор — это успех, а не ошибка.
    for (const result of results) {
      expect(result.status, JSON.stringify(result)).toBe('fulfilled');
    }
    expect(await activeChecks(stand.routeId)).toBe(1);

    // И прогресс у обоих один и тот же: он считается по базе, а не по экрану.
    const values = results.map((result) =>
      result.status === 'fulfilled' ? result.value.checked : -1,
    );
    expect(values.every((value) => value === 1)).toBe(true);
  });

  it('скан одновременно со сбросом не оставляет полупроверенного листа', async () => {
    const stand = await seedReadyRoute(2);
    const [first, second] = stand.orders;
    await checkOrderForIssue(
      flow,
      stand.keeper,
      stand.routeId,
      { orderNumber: first!.number },
      CONTEXT,
    );

    const results = await Promise.allSettled([
      checkOrderForIssue(
        flow,
        stand.keeper,
        stand.routeId,
        { orderNumber: second!.number },
        CONTEXT,
      ),
      resetIssueChecks(flow, stand.second, stand.routeId, CONTEXT),
    ]);
    for (const result of results) {
      expect(result.status, JSON.stringify(result)).toBe('fulfilled');
    }

    /*
     * Исход один из двух и оба согласованы: либо сброс успел позже скана
     * и отметок не осталось вовсе, либо скан лёг после сброса и отметка
     * ровно одна. Полки при этом не двигались ни при каком порядке.
     */
    const checks = await activeChecks(stand.routeId);
    expect([0, 1]).toContain(checks);
    expect(await issuedCount(stand.routeId)).toBe(0);
    for (const order of stand.orders) {
      expect(await placementsOf(order.id)).toHaveLength(1);
    }
  });
});

// --- 2. Две кнопки «Отгрузить» ------------------------------------------------

describe('финальная отгрузка', () => {
  it('два одновременных запроса выдают лист ровно один раз', async () => {
    const stand = await seedReadyRoute(2);
    for (const order of stand.orders) {
      await checkOrderForIssue(
        flow,
        stand.keeper,
        stand.routeId,
        { orderNumber: order.number },
        CONTEXT,
      );
    }

    const results = await Promise.allSettled([
      shipRoute(flow, stand.keeper, stand.routeId, CONTEXT),
      shipRoute(flow, stand.second, stand.routeId, CONTEXT),
    ]);

    const shipped = results.filter(
      (result) => result.status === 'fulfilled' && !result.value.unchanged,
    );
    expect(shipped).toHaveLength(1);

    expect(await routeState(stand.routeId)).toBe('ACTIVE');
    // Каждая коробка уехала РОВНО один раз.
    expect(await issuedCount(stand.routeId)).toBe(2);
    for (const order of stand.orders) {
      expect(await placementsOf(order.id)).toHaveLength(0);
    }
    // Полка освободилась один раз и осталась освобождённой.
    expect(
      await ctx.db.routeCellBinding.count({
        where: { routeId: stand.routeId, releasedAt: null },
      }),
    ).toBe(0);
  });

  it('отгрузка и смена курьера не расходятся: коробки едут тому, кого подтвердили', async () => {
    const stand = await seedReadyRoute(2);
    for (const order of stand.orders) {
      await checkOrderForIssue(
        flow,
        stand.keeper,
        stand.routeId,
        { orderNumber: order.number },
        CONTEXT,
      );
    }
    const other = await actorFor(['COURIER']);

    const results = await Promise.allSettled([
      shipRoute(flow, stand.keeper, stand.routeId, CONTEXT),
      setCourier(
        { db: ctx.db },
        stand.admin,
        stand.routeId,
        { courierUserId: other.userId, expectedVersion: stand.version },
        CONTEXT,
      ),
    ]);

    const shipOk = results[0]!.status === 'fulfilled';
    const state = await routeState(stand.routeId);
    const route = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: stand.routeId },
      select: { courierUserId: true },
    });

    if (shipOk) {
      // Лист уехал с ПОДТВЕРЖДЁННЫМ курьером, смена отвергнута.
      expect(state).toBe('ACTIVE');
      expect(route.courierUserId).toBe(stand.courier.userId);
      expect(await issuedCount(stand.routeId)).toBe(2);
    } else {
      // Курьера сменили первым — ни одна коробка не уехала.
      expect(state).toBe('CONFIRMED');
      expect(route.courierUserId).toBe(other.userId);
      expect(await issuedCount(stand.routeId)).toBe(0);
      for (const order of stand.orders) {
        expect(await placementsOf(order.id)).toHaveLength(1);
      }
    }
  });

  it('отгрузка и возврат листа в черновик исключают друг друга без полувыдачи', async () => {
    const stand = await seedReadyRoute(2);
    for (const order of stand.orders) {
      await checkOrderForIssue(
        flow,
        stand.keeper,
        stand.routeId,
        { orderNumber: order.number },
        CONTEXT,
      );
    }

    const results = await Promise.allSettled([
      shipRoute(flow, stand.keeper, stand.routeId, CONTEXT),
      returnToDraft(
        { db: ctx.db },
        stand.admin,
        stand.routeId,
        { expectedVersion: stand.version, reason: 'состав листа изменился' },
        CONTEXT,
      ),
    ]);

    const state = await routeState(stand.routeId);
    expect(['ACTIVE', 'DRAFT']).toContain(state);
    // Полувыдачи нет ни при каком порядке: либо обе коробки уехали, либо ни одной.
    expect(await issuedCount(stand.routeId)).toBe(state === 'ACTIVE' ? 2 : 0);
    expect(results.filter((result) => result.status === 'fulfilled').length).toBeGreaterThan(0);
  });

  it('отменённый в тот же миг заказ не уезжает с курьером', async () => {
    const stand = await seedReadyRoute(2);
    for (const order of stand.orders) {
      await checkOrderForIssue(
        flow,
        stand.keeper,
        stand.routeId,
        { orderNumber: order.number },
        CONTEXT,
      );
    }
    const cancelled = stand.orders[0]!;

    const results = await Promise.allSettled([
      shipRoute(flow, stand.keeper, stand.routeId, CONTEXT),
      ctx.db.$transaction(async (tx) => {
        await applyCancellation(tx, {
          orderId: cancelled.id,
          cancelled: true,
          previous: false,
          now: new Date(),
        });
      }),
    ]);

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: cancelled.id },
      select: { cancelledInSource: true },
    });
    const issued = await issuedCount(stand.routeId);

    if (order.cancelledInSource) {
      /*
       * Отмена дошла — отменённая коробка обязана остаться на полке.
       *
       * Выдать её курьеру означало бы повезти покупателю заказ, которого
       * больше нет, и обнаружить это только на адресе.
       */
      expect(issued, `отгружено ${issued} при дошедшей отмене`).toBe(0);
      expect(await placementsOf(cancelled.id)).toHaveLength(1);
    } else {
      expect(issued).toBe(2);
    }
    expect(results.filter((result) => result.status === 'fulfilled').length).toBeGreaterThan(0);
  });
});

// --- 3. Полки ------------------------------------------------------------------

describe('маршрутные полки под одновременной работой', () => {
  it('одну полку двум листам одновременно назначить нельзя', async () => {
    const first = await seedReadyRoute(1, false);
    const second = await seedReadyRoute(1, false);
    const free = await seedCell('ROUTE');

    const results = await Promise.allSettled([
      bindRouteCell(flow, first.keeper, first.routeId, { cellCode: free.code }, CONTEXT),
      bindRouteCell(flow, second.keeper, second.routeId, { cellCode: free.code }, CONTEXT),
    ]);

    const ok = results.filter((result) => result.status === 'fulfilled');
    expect(ok).toHaveLength(1);

    const bindings = await ctx.db.routeCellBinding.findMany({
      where: { cellId: free.id, releasedAt: null },
      select: { routeId: true },
    });
    expect(bindings).toHaveLength(1);
  });

  it('уход последней коробки и приход новой не теряют ни коробку, ни полку', async () => {
    const stand = await seedReadyRoute(1);
    const newcomer = await seedOrder();
    await ctx.db.routeOrder.create({
      data: {
        routeId: stand.routeId,
        orderId: newcomer.id,
        position: 2,
        addedById: stand.admin.userId,
      },
    });
    await receiveOrder(
      flow,
      stand.keeper,
      { orderNumber: newcomer.number, cellCode: stand.storage.code },
      CONTEXT,
    );

    const results = await Promise.allSettled([
      // Последнюю коробку снимают с полки.
      withdrawOrder(
        flow,
        stand.keeper,
        { orderNumber: stand.orders[0]!.number, reason: 'WRITE_OFF' },
        CONTEXT,
      ),
      // И в тот же миг на неё ставят другую.
      pickOrderToRouteCell(
        flow,
        stand.second,
        stand.routeId,
        { orderNumber: newcomer.number, cellCode: stand.routeCell.code },
        CONTEXT,
      ),
    ]);

    for (const result of results) {
      expect(result.status, JSON.stringify(result)).toBe('fulfilled');
    }

    // Коробка ровно одна и ровно в одном месте: второго размещения нет.
    const placements = await placementsOf(newcomer.id);
    expect(placements).toHaveLength(1);
    expect(placements[0]?.cellId).toBe(stand.routeCell.id);

    /*
     * И полка по-прежнему принадлежит листу: на ней стоит его коробка.
     *
     * Освобождённая привязка при занятой полке означала бы, что лист
     * считает коробку непринятой, а соседний лист может занять ту же полку.
     */
    const binding = await ctx.db.routeCellBinding.findFirst({
      where: { cellId: stand.routeCell.id, releasedAt: null },
      select: { routeId: true },
    });
    expect(binding?.routeId).toBe(stand.routeId);
  });
});
