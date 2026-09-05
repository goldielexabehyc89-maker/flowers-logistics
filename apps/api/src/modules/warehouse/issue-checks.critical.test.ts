/**
 * Критические проверки отгрузки листа целиком.
 *
 * Защищаемое свойство одно и физическое: коробки одного листа уезжают
 * ВМЕСТЕ и только тогда, когда лист по-прежнему годен. Отсюда всё
 * остальное — скан ничего не выдаёт, прогресс общий и не считается дважды,
 * сброс не трогает полки, а изменившийся перед финалом состав отменяет
 * выдачу целиком, а не наполовину.
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

let ctx: TestContext;
let flow: FlowDeps;
let cells: CellDeps;
const CONTEXT = { ip: null, userAgent: null };

/** День вне диапазонов остальных файлов набора. */
const DAY = '2027-12-20';

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

async function seedCourier(): Promise<AuthenticatedActor> {
  // Профиль курьера заводится вместе с пользователем: повторное создание
  // отвергается уникальным ключом, и это правильно.
  return actorFor(['COURIER']);
}

async function seedCell(kind: 'STORAGE' | 'ROUTE'): Promise<{ id: string; code: string }> {
  const actor = await actorFor(['ADMIN']);
  const created = await createStorageCell(
    cells,
    actor,
    { code: unique(kind === 'ROUTE' ? 'IR' : 'IS'), kind },
    CONTEXT,
  );
  return { id: created.id, code: created.normalizedCode };
}

async function seedOrder(): Promise<{ id: string; number: string }> {
  const number = unique('IW');
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: number,
      externalUpdated: new Date(),
      deliveryDate: toDateColumn(DAY),
      inScope: true,
      address: 'синтетический адрес выдачи',
      recipient: 'синтетический получатель',
    },
    select: { id: true, externalName: true },
  });
  return { id: order.id, number: order.externalName };
}

/** Лист, готовый к отгрузке: коробки стоят в маршрутной ячейке, курьер подтверждён. */
async function seedReadyRoute(orderCount = 2): Promise<{
  routeId: string;
  routeNumber: string;
  orders: { id: string; number: string }[];
  cellId: string;
  cellCode: string;
  keeper: AuthenticatedActor;
  courier: AuthenticatedActor;
}> {
  const keeper = await actorFor(['WAREHOUSE']);
  const admin = await actorFor(['ADMIN']);
  const courier = await seedCourier();

  const orders: { id: string; number: string }[] = [];
  for (let index = 0; index < orderCount; index += 1) {
    orders.push(await seedOrder());
  }

  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('IRT'),
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

  await confirmCourier(flow, keeper, route.id, { courierUserId: courier.userId }, CONTEXT);

  return {
    routeId: route.id,
    routeNumber: route.number,
    orders,
    cellId: routeCell.id,
    cellCode: routeCell.code,
    keeper,
    courier,
  };
}

/**
 * Лист, часть коробок которого осталась в ячейке хранения.
 *
 * Именно та смесь, ради которой отгрузка из хранения и вводилась: половина
 * коробок перенесена на маршрутную полку, половина стоит там, куда её
 * приняли.
 */
async function seedMixedRoute(
  inStorage: number,
  inRouteCell: number,
): Promise<{
  routeId: string;
  orders: { id: string; number: string }[];
  storageCellId: string;
  routeCellId: string;
  keeper: AuthenticatedActor;
  courier: AuthenticatedActor;
}> {
  const keeper = await actorFor(['WAREHOUSE']);
  const admin = await actorFor(['ADMIN']);
  const courier = await seedCourier();

  const orders: { id: string; number: string }[] = [];
  for (let index = 0; index < inStorage + inRouteCell; index += 1) {
    orders.push(await seedOrder());
  }

  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('MIX'),
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

  orders.forEach(() => undefined);
  for (const [index, order] of orders.entries()) {
    await receiveOrder(
      flow,
      keeper,
      { orderNumber: order.number, cellCode: storage.code },
      CONTEXT,
    );
    if (index >= inStorage) {
      await pickOrderToRouteCell(
        flow,
        keeper,
        route.id,
        { orderNumber: order.number, cellCode: routeCell.code },
        CONTEXT,
      );
    }
  }

  await confirmCourier(flow, keeper, route.id, { courierUserId: courier.userId }, CONTEXT);

  return {
    routeId: route.id,
    orders,
    storageCellId: storage.id,
    routeCellId: routeCell.id,
    keeper,
    courier,
  };
}

async function activePlacementCell(orderId: string): Promise<string | null> {
  const row = await ctx.db.orderPlacement.findFirst({
    where: { orderId, releasedAt: null },
    select: { cellId: true },
  });
  return row?.cellId ?? null;
}

// --- 1. Скан только отмечает --------------------------------------------------

describe('внесение заказа в лист', () => {
  it('скан не выдаёт заказ и не закрывает размещение', async () => {
    const route = await seedReadyRoute(2);
    const first = route.orders[0]!;

    const result = await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: first.number },
      CONTEXT,
    );

    expect(result.checked).toBe(1);
    expect(result.total).toBe(2);

    // Коробка по-прежнему стоит в ячейке: проверка — это ещё не передача.
    expect(await activePlacementCell(first.id)).toBe(route.cellId);
    const stored = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: route.routeId },
      select: { state: true },
    });
    expect(stored.state).toBe('CONFIRMED');
  });

  it('повторный скан того же заказа прогресс не увеличивает', async () => {
    const route = await seedReadyRoute(2);
    const first = route.orders[0]!;

    const once = await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: first.number },
      CONTEXT,
    );
    const twice = await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: first.number },
      CONTEXT,
    );

    expect(once.unchanged).toBe(false);
    expect(twice.unchanged).toBe(true);
    expect(twice.checked).toBe(1);
  });

  it('две складские сессии считают один и тот же прогресс', async () => {
    const route = await seedReadyRoute(2);
    const second = await actorFor(['WAREHOUSE']);
    const [left, right] = route.orders;

    await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: left!.number },
      CONTEXT,
    );
    // Второй кладовщик продолжает с того же места, а не начинает заново.
    const continued = await checkOrderForIssue(
      flow,
      second,
      route.routeId,
      { orderNumber: right!.number },
      CONTEXT,
    );

    expect(continued.checked).toBe(2);
    expect(continued.total).toBe(2);
  });

  it('конкурентный скан одной коробки даёт ровно одну отметку', async () => {
    const route = await seedReadyRoute(2);
    const second = await actorFor(['WAREHOUSE']);
    const first = route.orders[0]!;

    /*
     * Два кладовщика сканируют одну коробку одновременно.
     *
     * «Сначала найти, потом вставить» такую гонку не ловит: параллельные
     * транзакции не видят чужих незафиксированных вставок. Ловит её
     * уникальный индекс.
     */
    const [one, two] = await Promise.all([
      checkOrderForIssue(flow, route.keeper, route.routeId, { orderNumber: first.number }, CONTEXT),
      checkOrderForIssue(flow, second, route.routeId, { orderNumber: first.number }, CONTEXT),
    ]);

    expect(Math.max(one.checked, two.checked)).toBe(1);
    const marks = await ctx.db.routeIssueCheck.count({
      where: { orderId: first.id, clearedAt: null },
    });
    expect(marks).toBe(1);
  });

  it('отменённый заказ внести нельзя', async () => {
    const route = await seedReadyRoute(1);
    const only = route.orders[0]!;

    await ctx.db.deliveryOrder.update({
      where: { id: only.id },
      data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
    });

    await expect(
      checkOrderForIssue(flow, route.keeper, route.routeId, { orderNumber: only.number }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_BLOCKED' } });
  });

  it('коробку, унесённую обратно в хранение, внести МОЖНО', async () => {
    /*
     * Прежде это было отказом: выдача требовала маршрутной ячейки листа.
     * Лист всё равно проверяется заказ за заказом и уезжает целиком, поэтому
     * коробку берут с той полки, где она стоит, — перекладывать её ради
     * перекладывания незачем.
     */
    const route = await seedReadyRoute(1);
    const only = route.orders[0]!;
    const storage = await seedCell('STORAGE');

    await receiveOrder(
      flow,
      route.keeper,
      { orderNumber: only.number, cellCode: storage.code },
      CONTEXT,
    );

    const progress = await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: only.number },
      CONTEXT,
    );
    expect(progress.checked).toBe(1);
  });
});

// --- 2. Сброс ----------------------------------------------------------------

describe('сброс проверки', () => {
  it('очищает прогресс, не трогая полки и маршрут, и остаётся в истории', async () => {
    const route = await seedReadyRoute(2);
    const first = route.orders[0]!;

    await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: first.number },
      CONTEXT,
    );

    const reset = await resetIssueChecks(flow, route.keeper, route.routeId, CONTEXT);
    expect(reset.cleared).toBe(1);
    expect(reset.checked).toBe(0);

    // Полка и маршрут не изменились.
    expect(await activePlacementCell(first.id)).toBe(route.cellId);
    const stored = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: route.routeId },
      select: { state: true },
    });
    expect(stored.state).toBe('CONFIRMED');

    // Отметка не исчезла бесследно: она закрыта и видна в истории.
    const closed = await ctx.db.routeIssueCheck.findFirstOrThrow({
      where: { orderId: first.id },
      select: { clearedAt: true, clearedById: true },
    });
    expect(closed.clearedAt).not.toBeNull();
    expect(closed.clearedById).toBe(route.keeper.userId);

    const audit = await ctx.db.auditLog.findFirst({
      where: { action: 'WAREHOUSE_ISSUE_CHECKS_RESET' },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: { newValue: true },
    });
    expect(audit).not.toBeNull();

    // После сброса ту же коробку можно внести заново.
    const again = await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: first.number },
      CONTEXT,
    );
    expect(again.unchanged).toBe(false);
    expect(again.checked).toBe(1);
  });

  it('сброс одного листа не трогает соседний', async () => {
    const left = await seedReadyRoute(1);
    const right = await seedReadyRoute(1);

    await checkOrderForIssue(
      flow,
      left.keeper,
      left.routeId,
      { orderNumber: left.orders[0]!.number },
      CONTEXT,
    );
    await checkOrderForIssue(
      flow,
      right.keeper,
      right.routeId,
      { orderNumber: right.orders[0]!.number },
      CONTEXT,
    );

    await resetIssueChecks(flow, left.keeper, left.routeId, CONTEXT);

    const untouched = await ctx.db.routeIssueCheck.count({
      where: { orderId: right.orders[0]!.id, clearedAt: null },
    });
    expect(untouched).toBe(1);
  });
});

// --- 3. Финальная отгрузка ----------------------------------------------------

describe('отгрузка листа', () => {
  it('выдаёт все заказы одной транзакцией и освобождает ячейки', async () => {
    const route = await seedReadyRoute(2);

    for (const order of route.orders) {
      await checkOrderForIssue(
        flow,
        route.keeper,
        route.routeId,
        { orderNumber: order.number },
        CONTEXT,
      );
    }

    const shipped = await shipRoute(flow, route.keeper, route.routeId, CONTEXT);
    expect(shipped.issued).toBe(2);
    expect(shipped.unchanged).toBe(false);

    const stored = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: route.routeId },
      select: { state: true },
    });
    expect(stored.state).toBe('ACTIVE');

    // Все размещения закрыты выдачей, ни одной коробки на полке.
    for (const order of route.orders) {
      expect(await activePlacementCell(order.id)).toBeNull();
    }

    // Освободившаяся полка снова доступна другому листу.
    const binding = await ctx.db.routeCellBinding.findFirst({
      where: { routeId: route.routeId, releasedAt: null },
      select: { id: true },
    });
    expect(binding).toBeNull();

    const session = await ctx.db.routeIssueSession.findFirstOrThrow({
      where: { routeId: route.routeId },
      select: { state: true, openKey: true },
    });
    expect(session.state).toBe('COMPLETED');
    expect(session.openKey).toBeNull();
  });

  it('повтор финального запроса не выдаёт лист второй раз', async () => {
    const route = await seedReadyRoute(1);
    await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: route.orders[0]!.number },
      CONTEXT,
    );

    await shipRoute(flow, route.keeper, route.routeId, CONTEXT);
    const repeat = await shipRoute(flow, route.keeper, route.routeId, CONTEXT);

    expect(repeat.unchanged).toBe(true);
    const issued = await ctx.db.orderPlacement.count({
      where: { orderId: route.orders[0]!.id, releaseReason: 'ISSUED_TO_COURIER' },
    });
    // Ровно одна запись о передаче: второй выдачи не произошло.
    expect(issued).toBe(1);
  });

  it('непроверенный заказ отменяет отгрузку целиком', async () => {
    const route = await seedReadyRoute(2);
    const [first, second] = route.orders;

    await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: first!.number },
      CONTEXT,
    );

    await expect(shipRoute(flow, route.keeper, route.routeId, CONTEXT)).rejects.toMatchObject({
      conflict: { kind: 'ORDER_NOT_CHECKED' },
    });

    /*
     * Ни одной выданной коробки.
     *
     * Частично отгруженный лист означает заказы, разъехавшиеся по двум
     * машинам: половина у курьера, половина на полке.
     */
    expect(await activePlacementCell(first!.id)).toBe(route.cellId);
    expect(await activePlacementCell(second!.id)).toBe(route.cellId);
    const stored = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: route.routeId },
      select: { state: true },
    });
    expect(stored.state).toBe('CONFIRMED');
  });

  it('состав, изменившийся после проверки, отменяет отгрузку', async () => {
    const route = await seedReadyRoute(1);
    const admin = await actorFor(['ADMIN']);

    await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: route.orders[0]!.number },
      CONTEXT,
    );

    // Логист добавил заказ в лист уже после проверки.
    const added = await seedOrder();
    await ctx.db.routeOrder.create({
      data: { routeId: route.routeId, orderId: added.id, position: 5, addedById: admin.userId },
    });

    await expect(shipRoute(flow, route.keeper, route.routeId, CONTEXT)).rejects.toMatchObject({
      conflict: { kind: 'ORDER_NOT_CHECKED' },
    });
    expect(await activePlacementCell(route.orders[0]!.id)).toBe(route.cellId);
  });

  it('отменённый после проверки заказ отменяет отгрузку', async () => {
    const route = await seedReadyRoute(2);
    for (const order of route.orders) {
      await checkOrderForIssue(
        flow,
        route.keeper,
        route.routeId,
        { orderNumber: order.number },
        CONTEXT,
      );
    }

    await ctx.db.deliveryOrder.update({
      where: { id: route.orders[1]!.id },
      data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
    });

    await expect(shipRoute(flow, route.keeper, route.routeId, CONTEXT)).rejects.toMatchObject({
      conflict: { kind: 'ORDER_BLOCKED' },
    });
    expect(await activePlacementCell(route.orders[0]!.id)).toBe(route.cellId);
  });

  it('коробка в маршрутной ячейке другого листа выдаётся, а опустевшая полка освобождается', async () => {
    /*
     * Раньше это было отказом. Теперь место коробки — сведение, а не запрет:
     * коробку нашего заказа нашли в маршрутной ячейке соседнего листа, скан
     * её принимает, лист уезжает целиком. Старое размещение закрывается как
     * ISSUED_TO_COURIER независимо от того, чья это была полка, и опустевшая
     * привязка соседнего листа освобождается — на ней больше ничего нет.
     */
    const route = await seedReadyRoute(1);
    const only = route.orders[0]!;

    const admin = await actorFor(['ADMIN']);
    const foreignRoute = await ctx.db.deliveryRoute.create({
      data: {
        number: unique('FRT'),
        deliveryDate: toDateColumn(DAY),
        state: 'CONFIRMED',
        vehicleType: 'CAR',
        createdById: admin.userId,
      },
      select: { id: true },
    });
    const foreignCell = await seedCell('ROUTE');
    await bindRouteCell(
      flow,
      route.keeper,
      foreignRoute.id,
      { cellCode: foreignCell.code },
      CONTEXT,
    );
    await receiveOrder(
      flow,
      route.keeper,
      { orderNumber: only.number, cellCode: foreignCell.code, allowRouteCell: true },
      CONTEXT,
    );

    // Скан принимает коробку из чужой ячейки.
    const checked = await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: only.number },
      CONTEXT,
    );
    expect(checked.checked).toBe(1);

    const shipped = await shipRoute(flow, route.keeper, route.routeId, CONTEXT);
    expect(shipped.issued).toBe(1);

    const stored = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: route.routeId },
      select: { state: true },
    });
    expect(stored.state).toBe('ACTIVE');

    // Размещение закрыто выдачей.
    expect(await activePlacementCell(only.id)).toBeNull();
    const released = await ctx.db.orderPlacement.findFirst({
      where: { orderId: only.id, releaseReason: 'ISSUED_TO_COURIER' },
      select: { id: true },
    });
    expect(released).not.toBeNull();

    // Опустевшая чужая привязка освобождена.
    const foreignBinding = await ctx.db.routeCellBinding.findFirst({
      where: { cellId: foreignCell.id, releasedAt: null },
      select: { id: true },
    });
    expect(foreignBinding).toBeNull();
  });

  it('перенос коробки в хранение после проверки отгрузку не отменяет', async () => {
    const route = await seedReadyRoute(1);
    const only = route.orders[0]!;
    await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: only.number },
      CONTEXT,
    );

    const storage = await seedCell('STORAGE');
    await receiveOrder(
      flow,
      route.keeper,
      { orderNumber: only.number, cellCode: storage.code },
      CONTEXT,
    );

    const shipped = await shipRoute(flow, route.keeper, route.routeId, CONTEXT);
    expect(shipped.issued).toBe(1);
    expect(await activePlacementCell(only.id)).toBeNull();
  });

  it('замороженный курьер отгрузку не получает', async () => {
    const route = await seedReadyRoute(1);
    await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: route.orders[0]!.number },
      CONTEXT,
    );

    await ctx.db.user.update({
      where: { id: route.courier.userId },
      data: { status: 'FROZEN' },
    });

    await expect(shipRoute(flow, route.keeper, route.routeId, CONTEXT)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await activePlacementCell(route.orders[0]!.id)).toBe(route.cellId);
  });

  it('отгрузка относится только к выбранному листу', async () => {
    const left = await seedReadyRoute(1);
    const right = await seedReadyRoute(1);

    for (const route of [left, right]) {
      await checkOrderForIssue(
        flow,
        route.keeper,
        route.routeId,
        { orderNumber: route.orders[0]!.number },
        CONTEXT,
      );
    }

    await shipRoute(flow, left.keeper, left.routeId, CONTEXT);

    const untouched = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: right.routeId },
      select: { state: true },
    });
    expect(untouched.state).toBe('CONFIRMED');
    expect(await activePlacementCell(right.orders[0]!.id)).toBe(right.cellId);
  });

  it('в отметках, аудите и событиях нет адресов и получателей', async () => {
    const route = await seedReadyRoute(1);
    await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: route.orders[0]!.number },
      CONTEXT,
    );
    await shipRoute(flow, route.keeper, route.routeId, CONTEXT);

    const checks = await ctx.db.routeIssueCheck.findMany({
      where: { orderId: route.orders[0]!.id },
    });
    const audit = await ctx.db.auditLog.findMany({
      where: { action: { in: ['WAREHOUSE_ISSUE_CHECKED', 'WAREHOUSE_ORDER_ISSUED'] } },
      select: { newValue: true, oldValue: true },
    });
    const events = await ctx.db.realtimeEvent.findMany({
      where: { topic: 'warehouse.route_flow_changed' },
      select: { payload: true },
    });

    const serialized = JSON.stringify({ checks, audit, events });
    expect(serialized).not.toContain('синтетический адрес выдачи');
    expect(serialized).not.toContain('синтетический получатель');
    // Номера заказа в событиях тоже нет: клиент перечитывает список сам.
    expect(JSON.stringify(events)).not.toContain(route.orders[0]!.number);
  });
});

describe('отгрузка прямо из хранения', () => {
  /*
   * Перекладывать коробку на маршрутную полку ради самого перекладывания
   * незачем: лист всё равно проверяется заказ за заказом и уезжает целиком.
   * Раньше выдача требовала, чтобы каждая коробка стояла в ячейке листа,
   * и кладовщик носил их дважды.
   */
  it('лист со смесью хранения и маршрутной ячейки выдаётся целиком', async () => {
    const route = await seedMixedRoute(2, 1);

    for (const order of route.orders) {
      await checkOrderForIssue(
        flow,
        route.keeper,
        route.routeId,
        { orderNumber: order.number },
        CONTEXT,
      );
    }

    const shipped = await shipRoute(flow, route.keeper, route.routeId, CONTEXT);
    expect(shipped.issued).toBe(3);

    // Ни одной коробки на полках: освобождены размещения обоих видов.
    for (const order of route.orders) {
      expect(await activePlacementCell(order.id)).toBeNull();
    }

    // Опустевшая маршрутная полка отдана обратно.
    const binding = await ctx.db.routeCellBinding.findFirst({
      where: { routeId: route.routeId, releasedAt: null },
      select: { id: true },
    });
    expect(binding).toBeNull();

    const stored = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: route.routeId },
      select: { state: true },
    });
    expect(stored.state).toBe('ACTIVE');
  });

  it('лист целиком из хранения тоже выдаётся', async () => {
    const route = await seedMixedRoute(2, 0);

    for (const order of route.orders) {
      await checkOrderForIssue(
        flow,
        route.keeper,
        route.routeId,
        { orderNumber: order.number },
        CONTEXT,
      );
    }

    const shipped = await shipRoute(flow, route.keeper, route.routeId, CONTEXT);
    expect(shipped.issued).toBe(2);
    for (const order of route.orders) {
      expect(await activePlacementCell(order.id)).toBeNull();
    }
  });

  it('повтор финала по-прежнему идемпотентен', async () => {
    const route = await seedMixedRoute(1, 0);
    await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: route.orders[0]!.number },
      CONTEXT,
    );

    await shipRoute(flow, route.keeper, route.routeId, CONTEXT);
    const repeat = await shipRoute(flow, route.keeper, route.routeId, CONTEXT);

    expect(repeat.unchanged).toBe(true);
    const issued = await ctx.db.orderPlacement.count({
      where: { orderId: route.orders[0]!.id, releaseReason: 'ISSUED_TO_COURIER' },
    });
    expect(issued).toBe(1);
  });

  it('заказ без размещения сканируется и выдаётся, не заводя фиктивной ячейки', async () => {
    /*
     * Раньше это было отказом ORDER_NOT_PLACED. Теперь «нет действующего
     * размещения» — разрешённый случай: коробку сняли с полки соседним
     * процессом, но лист проверяется под сканом и уезжает целиком. Фиктивную
     * ячейку под такой заказ не заводим — факт его выдачи держит действующая
     * отметка в завершённой сессии, а не выдуманное размещение.
     */
    const route = await seedMixedRoute(2, 0);
    const withoutPlacement = route.orders[1]!;
    for (const order of route.orders) {
      await checkOrderForIssue(
        flow,
        route.keeper,
        route.routeId,
        { orderNumber: order.number },
        CONTEXT,
      );
    }

    // Коробку унесли между проверкой и финалом: действующего размещения нет.
    await withdrawOrder(
      flow,
      route.keeper,
      { orderNumber: withoutPlacement.number, reason: 'REASSEMBLY' },
      CONTEXT,
    );

    const shipped = await shipRoute(flow, route.keeper, route.routeId, CONTEXT);
    expect(shipped.issued).toBe(2);

    const stored = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: route.routeId },
      select: { state: true },
    });
    expect(stored.state).toBe('ACTIVE');

    // Никакого фиктивного размещения: ни действующего, ни закрытого выдачей.
    expect(await activePlacementCell(withoutPlacement.id)).toBeNull();
    const fabricated = await ctx.db.orderPlacement.count({
      where: { orderId: withoutPlacement.id, releaseReason: 'ISSUED_TO_COURIER' },
    });
    expect(fabricated).toBe(0);

    // Факт выдачи живёт действующей отметкой в ЗАВЕРШЁННОЙ сессии.
    const proof = await ctx.db.routeIssueCheck.findFirst({
      where: {
        orderId: withoutPlacement.id,
        clearedAt: null,
        session: { routeId: route.routeId, state: 'COMPLETED' },
      },
      select: { id: true },
    });
    expect(proof).not.toBeNull();

    // И аудит фиксирует выдачу заказа без размещения.
    const audit = await ctx.db.auditLog.findFirst({
      where: { action: 'WAREHOUSE_ORDER_ISSUED', entityType: 'RouteIssueSession' },
      orderBy: { occurredAt: 'desc' },
      select: { newValue: true },
    });
    const serializedAudit = JSON.stringify(audit?.newValue);
    expect(serializedAudit).toContain('withoutPlacement');
    expect(serializedAudit).toContain(withoutPlacement.id);
  });

  it('чужая маршрутная полка со своими коробками при нашей выдаче не освобождается', async () => {
    /*
     * Ячейку соседнего листа мы не трогаем без нужды. Наш заказ уезжает,
     * но в чужой полке осталась ещё одна коробка — её привязку не снимаем:
     * система не двигает и не освобождает чужое молча.
     */
    const route = await seedMixedRoute(1, 0);
    const ours = route.orders[0]!;
    const foreignAdmin = await actorFor(['ADMIN']);
    const stayer = await seedOrder();
    const foreignRoute = await ctx.db.deliveryRoute.create({
      data: {
        number: unique('FRT'),
        deliveryDate: toDateColumn(DAY),
        state: 'CONFIRMED',
        vehicleType: 'CAR',
        createdById: foreignAdmin.userId,
      },
      select: { id: true },
    });
    await ctx.db.routeOrder.create({
      data: {
        routeId: foreignRoute.id,
        orderId: stayer.id,
        position: 1,
        addedById: foreignAdmin.userId,
      },
    });
    const foreignCell = await seedCell('ROUTE');
    await bindRouteCell(
      flow,
      route.keeper,
      foreignRoute.id,
      { cellCode: foreignCell.code },
      CONTEXT,
    );

    // Обе коробки — наша и чужая — стоят в маршрутной ячейке соседнего листа.
    for (const order of [ours, stayer]) {
      await receiveOrder(
        flow,
        route.keeper,
        { orderNumber: order.number, cellCode: foreignCell.code, allowRouteCell: true },
        CONTEXT,
      );
    }

    // Наш заказ сканируется из чужой ячейки и уезжает.
    await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: ours.number },
      CONTEXT,
    );
    const shipped = await shipRoute(flow, route.keeper, route.routeId, CONTEXT);
    expect(shipped.issued).toBe(1);

    // Чужая коробка на месте — привязка соседнего листа сохранена.
    expect(await activePlacementCell(stayer.id)).toBe(foreignCell.id);
    const foreignBinding = await ctx.db.routeCellBinding.findFirst({
      where: { cellId: foreignCell.id, releasedAt: null },
      select: { id: true },
    });
    expect(foreignBinding).not.toBeNull();
  });

  it('коробка с пометкой «требуется перемещение» выдаётся без запрета', async () => {
    /*
     * Пометка перестала быть предохранителем-запретом: теперь она
     * предупреждение на экране. Стоит на маршрутной полке или в хранении —
     * лист всё равно уезжает.
     */
    const route = await seedReadyRoute(1);
    const only = route.orders[0]!;
    await ctx.db.orderPlacement.updateMany({
      where: { orderId: only.id, releasedAt: null },
      data: { requiresRelocation: true },
    });

    await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: only.number },
      CONTEXT,
    );
    const shipped = await shipRoute(flow, route.keeper, route.routeId, CONTEXT);
    expect(shipped.issued).toBe(1);
    expect(await activePlacementCell(only.id)).toBeNull();
  });
});
