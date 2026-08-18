/**
 * Что именно уходит в поток событий складской выдачи.
 *
 * Поток видит любой, кому событие адресовано, и живёт он дольше экрана.
 * Поэтому в нём нет ни адреса, ни получателя, ни телефона, ни номера заказа
 * и ни кода ячейки — только идентификаторы и вид действия. Экран идёт за
 * подробностями своим запросом, где права проверяются заново.
 *
 * Проверка идёт по БЕЛОМУ списку ключей, а не по чёрному: новое поле в
 * полезной нагрузке обязано ломать этот тест, а не тихо утекать в поток.
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
import { receiveOrder, type FlowDeps } from './placement.js';
import {
  bindRouteCell,
  checkOrderForIssue,
  confirmCourier,
  pickOrderToRouteCell,
  resetIssueChecks,
  shipRoute,
} from './route-flow.js';

let ctx: TestContext;
let flow: FlowDeps;
let cells: CellDeps;
const CONTEXT = { ip: null, userAgent: null };

/** День вне диапазонов остальных файлов набора. */
const DAY = '2028-01-31';

/** Приметы, которых в потоке быть не может. */
const ADDRESS = 'Москва, синтетическая улица потока, 7';
const RECIPIENT = 'Синтетический Получатель Потока';
const COMMENT = 'синтетический комментарий к доставке';

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
    { code: unique(kind === 'ROUTE' ? 'ER' : 'ES'), kind },
    CONTEXT,
  );
  return { id: created.id, code: created.normalizedCode };
}

/** Полный путь листа: полка, приёмка, комплектование, проверка, сброс, отгрузка. */
async function runWholeFlow(): Promise<{
  since: Date;
  orderNumbers: string[];
  cellCodes: string[];
  courierPhone: string;
}> {
  const keeper = await actorFor(['WAREHOUSE']);
  const admin = await actorFor(['ADMIN']);
  const courierUser = await seedUser(ctx.db, { roles: ['COURIER'] });

  const orders: { id: string; number: string }[] = [];
  for (let index = 0; index < 2; index += 1) {
    const order = await ctx.db.deliveryOrder.create({
      data: {
        externalId: randomUUID(),
        externalName: unique('EW'),
        externalUpdated: new Date(),
        deliveryDate: toDateColumn(DAY),
        inScope: true,
        address: ADDRESS,
        recipient: RECIPIENT,
        comment: COMMENT,
      },
      select: { id: true, externalName: true },
    });
    orders.push({ id: order.id, number: order.externalName });
  }

  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('ERT'),
      deliveryDate: toDateColumn(DAY),
      state: 'CONFIRMED',
      vehicleType: 'CAR',
      createdById: admin.userId,
      courierUserId: courierUser.id,
    },
    select: { id: true },
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
  const extraCell = await seedCell('ROUTE');

  // Отсечка ставится ПЕРЕД первым действием пакета: события соседних файлов
  // сюда попасть не должны.
  const since = new Date();
  await new Promise((resolve) => setTimeout(resolve, 5));

  await bindRouteCell(flow, keeper, route.id, { cellCode: routeCell.code }, CONTEXT);
  await bindRouteCell(flow, keeper, route.id, { cellCode: extraCell.code }, CONTEXT);
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
  await confirmCourier(flow, keeper, route.id, { courierUserId: courierUser.id }, CONTEXT);
  await checkOrderForIssue(flow, keeper, route.id, { orderNumber: orders[0]!.number }, CONTEXT);
  await resetIssueChecks(flow, keeper, route.id, CONTEXT);
  for (const order of orders) {
    await checkOrderForIssue(flow, keeper, route.id, { orderNumber: order.number }, CONTEXT);
  }
  await shipRoute(flow, keeper, route.id, CONTEXT);

  return {
    since,
    orderNumbers: orders.map((order) => order.number),
    cellCodes: [storage.code, routeCell.code, extraCell.code],
    courierPhone: courierUser.phone,
  };
}

/** Ключи, которые разрешено класть в полезную нагрузку складских событий. */
const ALLOWED_KEYS = new Set([
  'routeId',
  'orderId',
  'cellId',
  'action',
  'state',
  'issued',
  'checked',
  'total',
]);

describe('поток событий выдачи', () => {
  it('несёт только идентификаторы: ни адреса, ни получателя, ни телефона', async () => {
    const flowRun = await runWholeFlow();

    const events = await ctx.db.realtimeEvent.findMany({
      where: {
        occurredAt: { gte: flowRun.since },
        topic: {
          in: ['warehouse.route_flow_changed', 'warehouse.placement_changed', 'route.updated'],
        },
      },
      select: { topic: true, payload: true, audienceRoles: true, audienceUserId: true },
    });

    // Путь пройден целиком: событий заведомо больше горстки.
    expect(events.length).toBeGreaterThan(5);

    const forbidden = [
      ADDRESS,
      RECIPIENT,
      COMMENT,
      flowRun.courierPhone,
      ...flowRun.orderNumbers,
      ...flowRun.cellCodes,
    ];

    for (const event of events) {
      const text = JSON.stringify(event.payload);
      for (const secret of forbidden) {
        expect(text, `${event.topic}: ${text}`).not.toContain(secret);
      }

      for (const key of Object.keys(event.payload as Record<string, unknown>)) {
        expect(ALLOWED_KEYS.has(key), `${event.topic}: неизвестный ключ ${key}`).toBe(true);
      }
    }
  });

  it('все действия пути действительно попали в поток', async () => {
    const flowRun = await runWholeFlow();

    const events = await ctx.db.realtimeEvent.findMany({
      where: { occurredAt: { gte: flowRun.since }, topic: 'warehouse.route_flow_changed' },
      select: { payload: true },
    });
    const actions = new Set(
      events.map((event) => (event.payload as { action?: string }).action ?? ''),
    );

    // Пропущенное событие — это экран, который не обновится у второго
    // кладовщика, поэтому список закреплён целиком.
    for (const action of [
      'CELL_BOUND',
      'PICKED',
      'COURIER_CONFIRMED',
      'ISSUE_CHECKED',
      'ISSUE_CHECKS_RESET',
      'ROUTE_ACTIVATED',
    ]) {
      expect(actions.has(action), action).toBe(true);
    }
  });

  it('ход комплектования курьеру и менеджеру не рассылается', async () => {
    const flowRun = await runWholeFlow();

    const events = await ctx.db.realtimeEvent.findMany({
      where: { occurredAt: { gte: flowRun.since }, topic: 'warehouse.route_flow_changed' },
      select: { audienceRoles: true },
    });

    for (const event of events) {
      expect(event.audienceRoles).not.toContain('COURIER');
      expect(event.audienceRoles).not.toContain('MANAGER');
      expect(event.audienceRoles).not.toContain('FLORIST');
    }
  });

  it('движение коробки видит менеджер самовывоза, но не курьер', async () => {
    const flowRun = await runWholeFlow();

    const events = await ctx.db.realtimeEvent.findMany({
      where: { occurredAt: { gte: flowRun.since }, topic: 'warehouse.placement_changed' },
      select: { audienceRoles: true },
    });

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      // Самовывозный заказ появляется у менеджера ровно тогда, когда его
      // положили в ячейку.
      expect(event.audienceRoles).toContain('MANAGER');
      expect(event.audienceRoles).not.toContain('COURIER');
    }
  });

  it('об отгрузке узнаёт курьер: маршрут появляется у него сам', async () => {
    const flowRun = await runWholeFlow();

    const events = await ctx.db.realtimeEvent.findMany({
      where: { occurredAt: { gte: flowRun.since }, topic: 'route.updated' },
      select: { audienceRoles: true, payload: true },
    });

    expect(events.length).toBeGreaterThan(0);
    const shipped = events.filter(
      (event) => (event.payload as { state?: string }).state === 'ACTIVE',
    );
    expect(shipped.length).toBeGreaterThan(0);
    for (const event of shipped) {
      expect(event.audienceRoles).toContain('COURIER');
    }
  });
});
