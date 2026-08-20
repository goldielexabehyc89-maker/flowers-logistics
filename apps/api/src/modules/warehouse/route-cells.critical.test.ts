/**
 * Критические проверки жизни маршрутной ячейки.
 *
 * Полка — вещь физическая, и привязка обязана повторять её состояние, а не
 * состояние программы. Отсюда четыре свойства: отгрузка освобождает; отмена
 * листа, возврат в черновик и исключение заказа НЕ освобождают, пока коробки
 * стоят; уход последней коробки закрывает привязку сам.
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
  shipRoute,
} from './route-flow.js';

let ctx: TestContext;
let flow: FlowDeps;
let cells: CellDeps;
const CONTEXT = { ip: null, userAgent: null };

/** День вне диапазонов остальных файлов набора. */
const DAY = '2027-12-27';

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
    { code: unique(kind === 'ROUTE' ? 'LR' : 'LS'), kind },
    CONTEXT,
  );
  return { id: created.id, code: created.normalizedCode };
}

async function seedOrder(): Promise<{ id: string; number: string }> {
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: unique('LW'),
      externalUpdated: new Date(),
      deliveryDate: toDateColumn(DAY),
      inScope: true,
      address: 'синтетический адрес ячеек',
      recipient: 'синтетический получатель',
    },
    select: { id: true, externalName: true },
  });
  return { id: order.id, number: order.externalName };
}

interface Stand {
  routeId: string;
  orders: { id: string; number: string }[];
  storage: { id: string; code: string };
  routeCell: { id: string; code: string };
  keeper: AuthenticatedActor;
  courier: AuthenticatedActor;
}

/** Лист, коробки которого стоят в его маршрутной ячейке. */
async function seedPickedRoute(orderCount = 2): Promise<Stand> {
  const keeper = await actorFor(['WAREHOUSE']);
  const admin = await actorFor(['ADMIN']);
  const courier = await actorFor(['COURIER']);

  const orders: { id: string; number: string }[] = [];
  for (let index = 0; index < orderCount; index += 1) {
    orders.push(await seedOrder());
  }

  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('LRT'),
      deliveryDate: toDateColumn(DAY),
      state: 'CONFIRMED',
      vehicleType: 'CAR',
      createdById: admin.userId,
      courierUserId: courier.userId,
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

  return { routeId: route.id, orders, storage, routeCell, keeper, courier };
}

async function boundCells(routeId: string): Promise<string[]> {
  const rows = await ctx.db.routeCellBinding.findMany({
    where: { routeId, releasedAt: null },
    select: { cellId: true },
  });
  return rows.map((row) => row.cellId).sort();
}

// --- 1. Отгрузка освобождает --------------------------------------------------

describe('отгрузка листа', () => {
  it('освобождает все маршрутные ячейки листа', async () => {
    const stand = await seedPickedRoute(2);
    const second = await seedCell('ROUTE');
    await bindRouteCell(flow, stand.keeper, stand.routeId, { cellCode: second.code }, CONTEXT);
    // Вторая полка не пустая: иначе она освободилась бы по другому правилу.
    await pickOrderToRouteCell(
      flow,
      stand.keeper,
      stand.routeId,
      { orderNumber: stand.orders[1]!.number, cellCode: second.code },
      CONTEXT,
    );
    expect(await boundCells(stand.routeId)).toHaveLength(2);

    await confirmCourier(
      flow,
      stand.keeper,
      stand.routeId,
      { courierUserId: stand.courier.userId },
      CONTEXT,
    );
    for (const order of stand.orders) {
      await checkOrderForIssue(
        flow,
        stand.keeper,
        stand.routeId,
        { orderNumber: order.number },
        CONTEXT,
      );
    }
    await shipRoute(flow, stand.keeper, stand.routeId, CONTEXT);

    // Коробок на полках нет — обе свободны для следующего листа.
    expect(await boundCells(stand.routeId)).toEqual([]);
  });
});

// --- 2. Пока коробки стоят, полка занята --------------------------------------

describe('лист перестал быть действующим', () => {
  it('отмена листа НЕ освобождает ячейку: коробки физически стоят на ней', async () => {
    const stand = await seedPickedRoute(2);

    await ctx.db.deliveryRoute.update({
      where: { id: stand.routeId },
      data: { state: 'CANCELLED', version: { increment: 1 } },
    });

    expect(await boundCells(stand.routeId)).toEqual([stand.routeCell.id]);
  });

  it('возврат в черновик НЕ освобождает ячейку', async () => {
    const stand = await seedPickedRoute(2);

    await ctx.db.deliveryRoute.update({
      where: { id: stand.routeId },
      data: { state: 'DRAFT', version: { increment: 1 } },
    });

    expect(await boundCells(stand.routeId)).toEqual([stand.routeCell.id]);
  });

  it('исключение заказа из листа НЕ освобождает ячейку, пока на ней есть другие', async () => {
    const stand = await seedPickedRoute(2);

    await ctx.db.routeOrder.updateMany({
      where: { routeId: stand.routeId, orderId: stand.orders[0]!.id },
      data: {
        removedAt: new Date(),
        removalReason: 'RETURNED_TO_UNASSIGNED',
        removedById: stand.keeper.userId,
      },
    });

    expect(await boundCells(stand.routeId)).toEqual([stand.routeCell.id]);
  });
});

// --- 3. Уход последней коробки закрывает привязку -----------------------------

describe('последняя коробка ушла с полки', () => {
  it('перенос последнего заказа на другую полку закрывает опустевшую привязку', async () => {
    const stand = await seedPickedRoute(1);
    const second = await seedCell('ROUTE');
    await bindRouteCell(flow, stand.keeper, stand.routeId, { cellCode: second.code }, CONTEXT);

    await pickOrderToRouteCell(
      flow,
      stand.keeper,
      stand.routeId,
      { orderNumber: stand.orders[0]!.number, cellCode: second.code },
      CONTEXT,
    );

    // Первая полка опустела и отпущена, вторая занята коробкой.
    expect(await boundCells(stand.routeId)).toEqual([second.id]);
  });

  it('пока на полке остаётся хоть одна коробка, привязка держится', async () => {
    const stand = await seedPickedRoute(2);
    const second = await seedCell('ROUTE');
    await bindRouteCell(flow, stand.keeper, stand.routeId, { cellCode: second.code }, CONTEXT);

    await pickOrderToRouteCell(
      flow,
      stand.keeper,
      stand.routeId,
      { orderNumber: stand.orders[0]!.number, cellCode: second.code },
      CONTEXT,
    );

    expect(await boundCells(stand.routeId)).toEqual([stand.routeCell.id, second.id].sort());
  });

  it('возврат коробки в обычное хранение закрывает опустевшую привязку', async () => {
    const stand = await seedPickedRoute(1);

    await receiveOrder(
      flow,
      stand.keeper,
      { orderNumber: stand.orders[0]!.number, cellCode: stand.storage.code },
      CONTEXT,
    );

    expect(await boundCells(stand.routeId)).toEqual([]);
  });

  it('снятие последней коробки с хранения закрывает опустевшую привязку', async () => {
    const stand = await seedPickedRoute(1);

    await withdrawOrder(
      flow,
      stand.keeper,
      { orderNumber: stand.orders[0]!.number, reason: 'WRITE_OFF' },
      CONTEXT,
    );

    expect(await boundCells(stand.routeId)).toEqual([]);
  });

  it('только что назначенная пустая ячейка не закрывается сама', async () => {
    const stand = await seedPickedRoute(1);
    const second = await seedCell('ROUTE');
    await bindRouteCell(flow, stand.keeper, stand.routeId, { cellCode: second.code }, CONTEXT);

    // На второй полке коробок не было ни разу — закрывать нечего: кладовщик
    // назначил её заранее и понесёт коробку туда следующим действием.
    await receiveOrder(
      flow,
      stand.keeper,
      { orderNumber: stand.orders[0]!.number, cellCode: stand.storage.code },
      CONTEXT,
    );

    expect(await boundCells(stand.routeId)).toEqual([second.id]);
  });

  it('освобождённую полку можно отдать другому листу', async () => {
    const stand = await seedPickedRoute(1);
    const other = await seedPickedRoute(1);

    await withdrawOrder(
      flow,
      stand.keeper,
      { orderNumber: stand.orders[0]!.number, reason: 'WRITE_OFF' },
      CONTEXT,
    );

    await bindRouteCell(
      flow,
      other.keeper,
      other.routeId,
      { cellCode: stand.routeCell.code },
      CONTEXT,
    );

    expect(await boundCells(other.routeId)).toEqual(
      [other.routeCell.id, stand.routeCell.id].sort(),
    );
  });
});
