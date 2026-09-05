/**
 * Критические проверки нескольких маршрутных ячеек и доски сборки.
 *
 * Защищаемое свойство физическое: коробки одного листа лежат на нескольких
 * полках, и система обязана знать, на каких именно. Отсюда всё остальное —
 * запрет отдавать полку второму листу, идемпотентность повторного скана,
 * готовность только в ячейке СВОЕГО листа и порядок листов на доске.
 *
 * Дата подобрана так, чтобы не пересекаться с другими файлами набора.
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
import { bindRouteCell, pickOrderToRouteCell } from './route-flow.js';
import {
  compareRoutes,
  isAssembled,
  isRelocatable,
  issueReadiness,
  readAssemblyBoard,
  readIssueBoard,
} from './assembly-board.js';

let ctx: TestContext;
let flow: FlowDeps;
let cells: CellDeps;
const CONTEXT = { ip: null, userAgent: null };

/** День вне диапазонов остальных файлов набора. */
const DAY = '2027-12-06';

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
    { code: unique(kind === 'ROUTE' ? 'AR' : 'AS'), kind },
    CONTEXT,
  );
  return { id: created.id, code: created.normalizedCode };
}

async function seedOrder(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; number: string }> {
  const number = unique('AW');
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: number,
      externalUpdated: new Date(),
      deliveryDate: toDateColumn(DAY),
      inScope: true,
      ...overrides,
    },
    select: { id: true, externalName: true },
  });
  return { id: order.id, number: order.externalName };
}

async function seedRoute(
  orderIds: string[],
  options: { day?: string; courierId?: string } = {},
): Promise<{ id: string; number: string }> {
  const creator = await actorFor(['ADMIN']);
  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('ART'),
      deliveryDate: toDateColumn(options.day ?? DAY),
      state: 'CONFIRMED',
      vehicleType: 'CAR',
      createdById: creator.userId,
      // Курьер нужен доске выдачи: лист без него на ней не появляется.
      ...(options.courierId === undefined ? {} : { courierUserId: options.courierId }),
    },
    select: { id: true, number: true },
  });

  let position = 1;
  for (const orderId of orderIds) {
    await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId, position, addedById: creator.userId },
    });
    position += 1;
  }
  return route;
}

async function boardRoute(routeId: string) {
  const board = await readAssemblyBoard(ctx.db);
  const inActive = board.active.find((route) => route.routeId === routeId);
  const inRelocatable = board.relocatable.find((route) => route.routeId === routeId);
  const inAssembled = board.assembled.find((route) => route.routeId === routeId);

  // Лист обязан лежать РОВНО в одной группе: две группы читались бы как два
  // разных листа, и кладовщик пошёл бы собирать один и тот же дважды.
  const found = [inActive, inRelocatable, inAssembled].filter((route) => route !== undefined);
  expect(found).toHaveLength(1);

  return {
    route: inActive ?? inRelocatable ?? inAssembled ?? null,
    group:
      inActive !== undefined ? 'active' : inRelocatable !== undefined ? 'relocatable' : 'assembled',
  };
}

// --- Несколько маршрутных ячеек ----------------------------------------------

describe('маршрутные ячейки листа', () => {
  it('лист принимает вторую ячейку, а повтор той же ничего не добавляет', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedOrder();
    const route = await seedRoute([order.id]);
    const first = await seedCell('ROUTE');
    const second = await seedCell('ROUTE');

    await bindRouteCell(flow, keeper, route.id, { cellCode: first.code }, CONTEXT);
    const added = await bindRouteCell(flow, keeper, route.id, { cellCode: second.code }, CONTEXT);
    expect(added.unchanged).toBe(false);

    // Повтор той же полки идемпотентен: второй привязки не появляется.
    const again = await bindRouteCell(flow, keeper, route.id, { cellCode: second.code }, CONTEXT);
    expect(again.unchanged).toBe(true);

    const bindings = await ctx.db.routeCellBinding.findMany({
      where: { routeId: route.id, releasedAt: null },
      select: { cellId: true },
    });
    expect(bindings).toHaveLength(2);
  });

  it('одна полка не достаётся двум активным листам', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const left = await seedRoute([(await seedOrder()).id]);
    const right = await seedRoute([(await seedOrder()).id]);
    const cell = await seedCell('ROUTE');

    await bindRouteCell(flow, keeper, left.id, { cellCode: cell.code }, CONTEXT);

    /*
     * На одной полке встретились бы коробки двух курьеров.
     *
     * Причина называется вместе с номером листа: кладовщику нужно знать,
     * куда делась полка, а не только что «нельзя».
     */
    await expect(
      bindRouteCell(flow, keeper, right.id, { cellCode: cell.code }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ROUTE_CELL_ALREADY_BOUND' } });
  });

  it('маршрутная ячейка не бывает полкой хранения', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const route = await seedRoute([(await seedOrder()).id]);
    const storage = await seedCell('STORAGE');

    await expect(
      bindRouteCell(flow, keeper, route.id, { cellCode: storage.code }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'CELL_KIND_MISMATCH' } });
  });

  it('комплектование принимает любую ячейку листа, но не чужую', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const first = await seedOrder();
    const second = await seedOrder();
    const route = await seedRoute([first.id, second.id]);
    const left = await seedCell('ROUTE');
    const right = await seedCell('ROUTE');
    const storage = await seedCell('STORAGE');

    await bindRouteCell(flow, keeper, route.id, { cellCode: left.code }, CONTEXT);
    await bindRouteCell(flow, keeper, route.id, { cellCode: right.code }, CONTEXT);

    await receiveOrder(
      flow,
      keeper,
      { orderNumber: first.number, cellCode: storage.code },
      CONTEXT,
    );
    await receiveOrder(
      flow,
      keeper,
      { orderNumber: second.number, cellCode: storage.code, allowRouteCell: false },
      CONTEXT,
    );

    // Первая коробка едет на одну полку листа, вторая — на другую.
    const one = await pickOrderToRouteCell(
      flow,
      keeper,
      route.id,
      { orderNumber: first.number, cellCode: left.code },
      CONTEXT,
    );
    const two = await pickOrderToRouteCell(
      flow,
      keeper,
      route.id,
      { orderNumber: second.number, cellCode: right.code },
      CONTEXT,
    );
    expect(one.picked).toBe(1);
    expect(two.picked).toBe(2);

    // Чужая маршрутная полка не принимается: ошибка называет ожидаемые.
    const foreignRoute = await seedRoute([(await seedOrder()).id]);
    const foreignCell = await seedCell('ROUTE');
    await bindRouteCell(flow, keeper, foreignRoute.id, { cellCode: foreignCell.code }, CONTEXT);

    await expect(
      pickOrderToRouteCell(
        flow,
        keeper,
        route.id,
        { orderNumber: first.number, cellCode: foreignCell.code },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ROUTE_CELL_MISMATCH' } });
  });

  it('свободная полка назначается и принимает коробку одной операцией', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedOrder();
    const route = await seedRoute([order.id]);
    const storage = await seedCell('STORAGE');
    const cell = await seedCell('ROUTE');

    await receiveOrder(
      flow,
      keeper,
      { orderNumber: order.number, cellCode: storage.code },
      CONTEXT,
    );

    /*
     * Кладовщик сканирует коробку и свободную полку — и всё.
     *
     * Отдельного шага «сначала привяжите ячейку» у него нет: между двумя
     * операциями оставался бы промежуток, в котором полка уже занята
     * листом, а коробка ещё лежит в хранении.
     */
    const result = await pickOrderToRouteCell(
      flow,
      keeper,
      route.id,
      { orderNumber: order.number, cellCode: cell.code, bindIfFree: true },
      CONTEXT,
    );

    expect(result.picked).toBe(1);
    const binding = await ctx.db.routeCellBinding.findFirst({
      where: { routeId: route.id, cellId: cell.id, releasedAt: null },
      select: { id: true },
    });
    expect(binding).not.toBeNull();

    const placement = await ctx.db.orderPlacement.findFirstOrThrow({
      where: { orderId: order.id, releasedAt: null },
      select: { cellId: true },
    });
    expect(placement.cellId).toBe(cell.id);
  });

  it('неудачный скан ячейки не назначает её и не двигает коробку', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedOrder();
    const route = await seedRoute([order.id]);
    const storage = await seedCell('STORAGE');
    const foreignRoute = await seedRoute([(await seedOrder()).id]);
    const taken = await seedCell('ROUTE');

    await receiveOrder(
      flow,
      keeper,
      { orderNumber: order.number, cellCode: storage.code },
      CONTEXT,
    );
    await bindRouteCell(flow, keeper, foreignRoute.id, { cellCode: taken.code }, CONTEXT);

    await expect(
      pickOrderToRouteCell(
        flow,
        keeper,
        route.id,
        { orderNumber: order.number, cellCode: taken.code, bindIfFree: true },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ROUTE_CELL_ALREADY_BOUND' } });

    // Ни привязки, ни перемещения: транзакция откатилась целиком.
    expect(
      await ctx.db.routeCellBinding.count({ where: { routeId: route.id, releasedAt: null } }),
    ).toBe(0);
    const placement = await ctx.db.orderPlacement.findFirstOrThrow({
      where: { orderId: order.id, releasedAt: null },
      select: { cellId: true },
    });
    expect(placement.cellId).toBe(storage.id);
  });
});

// --- Доска сборки ------------------------------------------------------------

describe('доска сборки', () => {
  it('стадии считаются по действующему размещению и своей ячейке', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const notAssembled = await seedOrder();
    const awaiting = await seedOrder({
      fulfillmentInScope: true,
      fulfillmentCompositionState: 'READY',
      fulfillmentSnapshotHash: unique('h'),
      fulfillmentCompositionSyncedAt: new Date(),
    });
    const inStorage = await seedOrder();
    const ready = await seedOrder();

    const route = await seedRoute([notAssembled.id, awaiting.id, inStorage.id, ready.id]);
    const storage = await seedCell('STORAGE');
    const routeCell = await seedCell('ROUTE');

    // «Ожидает приёмки» — сборка завершена, коробки на складе ещё нет.
    const revision = await ctx.db.orderFulfillmentRevision.create({
      data: {
        orderId: awaiting.id,
        reason: 'INITIAL_IMPORT',
        externalUpdated: new Date(),
        snapshot: {},
        snapshotHash: unique('rev'),
        changedFields: [],
      },
      select: { id: true },
    });
    const florist = await actorFor(['FLORIST']);
    await ctx.db.deliveryOrder.update({
      where: { id: awaiting.id },
      data: {
        fulfillmentProcessState: 'ASSEMBLED',
        fulfillmentAssigneeId: florist.userId,
        fulfillmentAssignedAt: new Date(),
        fulfillmentAssembledAt: new Date(),
        fulfillmentAssembledById: florist.userId,
        fulfillmentAssembledRevisionId: revision.id,
      },
    });

    await receiveOrder(
      flow,
      keeper,
      { orderNumber: inStorage.number, cellCode: storage.code },
      CONTEXT,
    );
    await receiveOrder(
      flow,
      keeper,
      { orderNumber: ready.number, cellCode: storage.code },
      CONTEXT,
    );
    await bindRouteCell(flow, keeper, route.id, { cellCode: routeCell.code }, CONTEXT);
    await pickOrderToRouteCell(
      flow,
      keeper,
      route.id,
      { orderNumber: ready.number, cellCode: routeCell.code },
      CONTEXT,
    );

    const found = await boardRoute(route.id);
    const stages = new Map(found.route?.orders.map((order) => [order.orderNumber, order.stage]));

    expect(stages.get(notAssembled.number)).toBe('NOT_ASSEMBLED');
    expect(stages.get(awaiting.number)).toBe('AWAITING_INTAKE');
    expect(stages.get(inStorage.number)).toBe('IN_STORAGE');
    expect(stages.get(ready.number)).toBe('READY');
    expect(found.group).toBe('active');
  });

  it('готовность даёт только ячейка своего листа', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedOrder();
    const route = await seedRoute([order.id]);
    const foreignRoute = await seedRoute([(await seedOrder()).id]);
    const foreignCell = await seedCell('ROUTE');

    await bindRouteCell(flow, keeper, foreignRoute.id, { cellCode: foreignCell.code }, CONTEXT);
    // Коробка физически стоит в МАРШРУТНОЙ ячейке — но чужого листа.
    await receiveOrder(
      flow,
      keeper,
      { orderNumber: order.number, cellCode: foreignCell.code, allowRouteCell: true },
      CONTEXT,
    );

    const found = await boardRoute(route.id);
    expect(found.route?.orders[0]?.stage).toBe('IN_STORAGE');
    expect(found.group).toBe('active');
  });

  it('лист уходит в «Собранные» и возвращается обратно', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedOrder();
    const route = await seedRoute([order.id]);
    const storage = await seedCell('STORAGE');
    const routeCell = await seedCell('ROUTE');

    await receiveOrder(
      flow,
      keeper,
      { orderNumber: order.number, cellCode: storage.code },
      CONTEXT,
    );
    await bindRouteCell(flow, keeper, route.id, { cellCode: routeCell.code }, CONTEXT);
    await pickOrderToRouteCell(
      flow,
      keeper,
      route.id,
      { orderNumber: order.number, cellCode: routeCell.code },
      CONTEXT,
    );

    expect((await boardRoute(route.id)).group).toBe('assembled');

    /*
     * Готовность нарушена — лист возвращается в активные.
     *
     * Источник истины пересчитывается каждый раз: флаг пришлось бы гасить
     * при каждом исключении заказа и однажды он остался бы включённым.
     */
    const added = await seedOrder();
    const creator = await actorFor(['ADMIN']);
    await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId: added.id, position: 2, addedById: creator.userId },
    });

    expect((await boardRoute(route.id)).group).toBe('active');
  });

  it('отменённый заказ не даёт листу считаться собранным', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedOrder();
    const route = await seedRoute([order.id]);
    const storage = await seedCell('STORAGE');
    const routeCell = await seedCell('ROUTE');

    await receiveOrder(
      flow,
      keeper,
      { orderNumber: order.number, cellCode: storage.code },
      CONTEXT,
    );
    await bindRouteCell(flow, keeper, route.id, { cellCode: routeCell.code }, CONTEXT);
    await pickOrderToRouteCell(
      flow,
      keeper,
      route.id,
      { orderNumber: order.number, cellCode: routeCell.code },
      CONTEXT,
    );
    expect((await boardRoute(route.id)).group).toBe('assembled');

    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
    });

    const after = await boardRoute(route.id);
    expect(after.group).toBe('active');
    expect(after.route?.orders[0]?.cancelled).toBe(true);
  });

  it('порядок листов считает сервер: день, раннее время, номер', () => {
    /*
     * Проверяется чистое правило, а не выборка.
     *
     * Порядок обязан быть определён на ПОЛНОМ наборе: клиентская сортировка
     * упорядочила бы только загруженную страницу, и лист с самым ранним
     * временем оказался бы внизу второй.
     */
    const routes = [
      { deliveryDate: '2027-12-07', earliestMinute: 540, routeNumber: 'B' },
      { deliveryDate: '2027-12-06', earliestMinute: null, routeNumber: 'A' },
      { deliveryDate: '2027-12-06', earliestMinute: 600, routeNumber: 'C' },
      { deliveryDate: '2027-12-06', earliestMinute: 600, routeNumber: 'B' },
      { deliveryDate: '2027-12-06', earliestMinute: 540, routeNumber: 'D' },
    ];

    const sorted = [...routes].sort(compareRoutes).map((route) => route.routeNumber);
    // Ранний день выше; внутри дня — раннее время; без времени — в конец дня.
    expect(sorted).toEqual(['D', 'B', 'C', 'A', 'B']);
  });

  it('пустой лист собранным не считается', () => {
    expect(isAssembled({ total: 0, orders: [] })).toBe(false);
  });

  it('незавершённый лист вчерашнего дня с доски не исчезает', async () => {
    const order = await seedOrder({ deliveryDate: toDateColumn('2027-12-05') });
    const route = await seedRoute([order.id], { day: '2027-12-05' });

    const found = await boardRoute(route.id);
    // Коробки стоят на полках: спрятать лист — потерять их.
    expect(found.route).not.toBeNull();
    expect(found.group).toBe('active');
  });
});

it('все коробки в хранении — лист попадает в «Можно переносить»', async () => {
  const keeper = await actorFor(['WAREHOUSE']);
  const first = await seedOrder();
  const second = await seedOrder();
  const route = await seedRoute([first.id, second.id]);
  const storage = await seedCell('STORAGE');

  for (const order of [first, second]) {
    await receiveOrder(
      flow,
      keeper,
      { orderNumber: order.number, cellCode: storage.code },
      CONTEXT,
    );
  }

  const found = await boardRoute(route.id);
  expect(found.group).toBe('relocatable');
  expect(found.route?.orders.every((order) => order.stage === 'IN_STORAGE')).toBe(true);
});

it('смесь хранения и маршрутной ячейки — тоже «Можно переносить»', async () => {
  const keeper = await actorFor(['WAREHOUSE']);
  const stored = await seedOrder();
  const picked = await seedOrder();
  const route = await seedRoute([stored.id, picked.id]);
  const storage = await seedCell('STORAGE');
  const routeCell = await seedCell('ROUTE');

  await receiveOrder(flow, keeper, { orderNumber: stored.number, cellCode: storage.code }, CONTEXT);
  await receiveOrder(flow, keeper, { orderNumber: picked.number, cellCode: storage.code }, CONTEXT);
  await bindRouteCell(flow, keeper, route.id, { cellCode: routeCell.code }, CONTEXT);
  await pickOrderToRouteCell(
    flow,
    keeper,
    route.id,
    { orderNumber: picked.number, cellCode: routeCell.code },
    CONTEXT,
  );

  const found = await boardRoute(route.id);
  expect(found.group).toBe('relocatable');
});

it('один заказ без размещения оставляет лист в активных', async () => {
  const keeper = await actorFor(['WAREHOUSE']);
  const stored = await seedOrder();
  const missing = await seedOrder();
  const route = await seedRoute([stored.id, missing.id]);
  const storage = await seedCell('STORAGE');

  await receiveOrder(flow, keeper, { orderNumber: stored.number, cellCode: storage.code }, CONTEXT);

  const found = await boardRoute(route.id);
  expect(found.group).toBe('active');
});

it('перенос последней коробки уводит лист из «Можно переносить» в «Собранные»', async () => {
  const keeper = await actorFor(['WAREHOUSE']);
  const order = await seedOrder();
  const route = await seedRoute([order.id]);
  const storage = await seedCell('STORAGE');
  const routeCell = await seedCell('ROUTE');

  await receiveOrder(flow, keeper, { orderNumber: order.number, cellCode: storage.code }, CONTEXT);
  expect((await boardRoute(route.id)).group).toBe('relocatable');

  await bindRouteCell(flow, keeper, route.id, { cellCode: routeCell.code }, CONTEXT);
  await pickOrderToRouteCell(
    flow,
    keeper,
    route.id,
    { orderNumber: order.number, cellCode: routeCell.code },
    CONTEXT,
  );

  expect((await boardRoute(route.id)).group).toBe('assembled');
});

it('чужая маршрутная полка переносом не считается', () => {
  // Стадия «в хранении» одна на два случая, и тип ячейки их различает.
  expect(
    isRelocatable({
      total: 1,
      orders: [
        { stage: 'IN_STORAGE', cellKind: 'ROUTE', requiresRelocation: true, cancelled: false },
      ],
    }),
  ).toBe(false);
  expect(
    isRelocatable({
      total: 1,
      orders: [
        { stage: 'IN_STORAGE', cellKind: 'STORAGE', requiresRelocation: true, cancelled: false },
      ],
    }),
  ).toBe(true);
});

it('отменённый заказ выводит лист из «Можно переносить»', () => {
  expect(
    isRelocatable({
      total: 2,
      orders: [
        { stage: 'IN_STORAGE', cellKind: 'STORAGE', requiresRelocation: true, cancelled: false },
        { stage: 'READY', cellKind: 'ROUTE', requiresRelocation: false, cancelled: true },
      ],
    }),
  ).toBe(false);
});

it('пустой лист и полностью собранный в перенос не попадают', () => {
  expect(isRelocatable({ total: 0, orders: [] })).toBe(false);
  expect(
    isRelocatable({
      total: 1,
      orders: [{ stage: 'READY', cellKind: 'ROUTE', requiresRelocation: false, cancelled: false }],
    }),
  ).toBe(false);
});

describe('готовность листа к выдаче', () => {
  /*
   * Состояние считает сервер по полному составу. Два положительных значения
   * различаются не правом отгрузить, а тем, где стоят коробки: «собран»
   * означает, что ходить по хранению не придётся.
   */
  it('все коробки в хранении — «Можно выдать»', () => {
    expect(
      issueReadiness([
        { ready: true, inRouteCell: false },
        { ready: true, inRouteCell: false },
      ]),
    ).toBe('CAN_ISSUE');
  });

  it('смесь хранения и маршрутных ячеек — «Можно выдать»', () => {
    expect(
      issueReadiness([
        { ready: true, inRouteCell: true },
        { ready: true, inRouteCell: false },
      ]),
    ).toBe('CAN_ISSUE');
  });

  it('все коробки в ячейках листа — «Собран — можно выдавать»', () => {
    expect(
      issueReadiness([
        { ready: true, inRouteCell: true },
        { ready: true, inRouteCell: true },
      ]),
    ).toBe('ASSEMBLED');
  });

  it('один заказ без размещения снимает оба положительных состояния', () => {
    expect(
      issueReadiness([
        { ready: true, inRouteCell: true },
        { ready: false, inRouteCell: false },
      ]),
    ).toBe('NOT_READY');
  });

  it('пустой лист готовым не бывает', () => {
    expect(issueReadiness([])).toBe('NOT_READY');
  });
});

describe('счётчик готовых листов курьера', () => {
  /*
   * Кладовщик смотрит на это число, чтобы решить, подходить ли к курьеру.
   * Считается оно по полному набору листов и включает ОБА положительных
   * состояния: право отгрузить у них одинаковое.
   */
  it('считает и «Можно выдать», и «Собран — можно выдавать»', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const courier = await actorFor(['COURIER']);

    // Лист целиком на маршрутной полке — «Собран».
    const assembledOrder = await seedOrder();
    const assembledRoute = await seedRoute([assembledOrder.id], { courierId: courier.userId });
    const storage = await seedCell('STORAGE');
    const routeCell = await seedCell('ROUTE');
    await receiveOrder(
      flow,
      keeper,
      { orderNumber: assembledOrder.number, cellCode: storage.code },
      CONTEXT,
    );
    await bindRouteCell(flow, keeper, assembledRoute.id, { cellCode: routeCell.code }, CONTEXT);
    await pickOrderToRouteCell(
      flow,
      keeper,
      assembledRoute.id,
      { orderNumber: assembledOrder.number, cellCode: routeCell.code },
      CONTEXT,
    );

    // Лист в хранении — «Можно выдать».
    const storedOrder = await seedOrder();
    await seedRoute([storedOrder.id], { courierId: courier.userId });
    await receiveOrder(
      flow,
      keeper,
      { orderNumber: storedOrder.number, cellCode: storage.code },
      CONTEXT,
    );

    // Лист без коробки — тоже «Можно выдать»: место коробки больше не запрет,
    // а настоящий гейт — скан каждого заказа. Раньше такой лист был «не готов».
    const emptyOrder = await seedOrder();
    await seedRoute([emptyOrder.id], { courierId: courier.userId });

    // Не готов остаётся ровно отменённый: его выдавать нельзя.
    const cancelledOrder = await seedOrder({
      cancelledInSource: true,
      cancelledInSourceAt: new Date(),
    });
    await seedRoute([cancelledOrder.id], { courierId: courier.userId });
    await receiveOrder(
      flow,
      keeper,
      { orderNumber: cancelledOrder.number, cellCode: storage.code },
      CONTEXT,
    );

    const board = await readIssueBoard(ctx.db);
    const view = board.find((item) => item.courierUserId === courier.userId);
    expect(view).toBeDefined();
    expect(view!.routes).toHaveLength(4);
    // Готовы все, кроме отменённого: собранный, в хранении и без коробки.
    expect(view!.readyRoutes).toBe(3);

    const states = view!.routes.map((route) => route.readiness).sort();
    expect(states).toEqual(['ASSEMBLED', 'CAN_ISSUE', 'CAN_ISSUE', 'NOT_READY']);
  });
});

describe('место коробки на доске выдачи — сведение, а не запрет', () => {
  /*
   * Каждый заказ показывает фактическую полку и остаётся годным: своя
   * маршрутная ячейка, чужая, хранение или «без ячейки». Негодным делает
   * только отмена. «Требуется перемещение» — предупреждение в поле, а не
   * снятие готовности.
   */
  it('несёт место каждой коробки и не роняет готовность из-за него', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const courier = await actorFor(['COURIER']);
    const storage = await seedCell('STORAGE');
    const ownCell = await seedCell('ROUTE');
    const relocCell = await seedCell('ROUTE');

    const own = await seedOrder();
    const stored = await seedOrder();
    const none = await seedOrder();
    const foreign = await seedOrder();
    const reloc = await seedOrder();

    const route = await seedRoute([own.id, stored.id, none.id, foreign.id, reloc.id], {
      courierId: courier.userId,
    });
    await bindRouteCell(flow, keeper, route.id, { cellCode: ownCell.code }, CONTEXT);
    await bindRouteCell(flow, keeper, route.id, { cellCode: relocCell.code }, CONTEXT);

    // Своя маршрутная полка.
    await receiveOrder(flow, keeper, { orderNumber: own.number, cellCode: storage.code }, CONTEXT);
    await pickOrderToRouteCell(
      flow,
      keeper,
      route.id,
      { orderNumber: own.number, cellCode: ownCell.code },
      CONTEXT,
    );

    // Хранение.
    await receiveOrder(
      flow,
      keeper,
      { orderNumber: stored.number, cellCode: storage.code },
      CONTEXT,
    );

    // `none` — без размещения вовсе, коробку не принимали.

    // Чужая маршрутная полка: у соседнего листа своя ячейка, наш заказ стоит в ней.
    const foreignRoute = await seedRoute([], { courierId: courier.userId });
    const foreignCell = await seedCell('ROUTE');
    await bindRouteCell(flow, keeper, foreignRoute.id, { cellCode: foreignCell.code }, CONTEXT);
    await receiveOrder(
      flow,
      keeper,
      { orderNumber: foreign.number, cellCode: foreignCell.code, allowRouteCell: true },
      CONTEXT,
    );

    // Своя маршрутная полка, но с пометкой «требуется перемещение».
    await receiveOrder(
      flow,
      keeper,
      { orderNumber: reloc.number, cellCode: storage.code },
      CONTEXT,
    );
    await pickOrderToRouteCell(
      flow,
      keeper,
      route.id,
      { orderNumber: reloc.number, cellCode: relocCell.code },
      CONTEXT,
    );
    await ctx.db.orderPlacement.updateMany({
      where: { orderId: reloc.id, releasedAt: null },
      data: { requiresRelocation: true },
    });

    const board = await readIssueBoard(ctx.db);
    const view = board.find((item) => item.courierUserId === courier.userId);
    expect(view).toBeDefined();
    const routeView = view!.routes.find((item) => item.routeId === route.id);
    expect(routeView).toBeDefined();
    const orders = new Map(routeView!.orders.map((order) => [order.orderNumber, order]));

    // Своя маршрутная ячейка.
    expect(orders.get(own.number)).toMatchObject({
      ready: true,
      cellKind: 'ROUTE',
      inRouteCell: true,
      routeCellNumber: route.number,
      requiresRelocation: false,
    });
    // Хранение.
    expect(orders.get(stored.number)).toMatchObject({
      ready: true,
      cellKind: 'STORAGE',
      inRouteCell: false,
      routeCellNumber: null,
    });
    // Без ячейки.
    expect(orders.get(none.number)).toMatchObject({
      ready: true,
      cellCode: null,
      cellKind: null,
      routeCellNumber: null,
    });
    // Чужая маршрутная ячейка: владелец — соседний лист.
    expect(orders.get(foreign.number)).toMatchObject({
      ready: true,
      cellKind: 'ROUTE',
      inRouteCell: false,
      routeCellNumber: foreignRoute.number,
    });
    // Требуется перемещение — предупреждение, готовность цела.
    expect(orders.get(reloc.number)).toMatchObject({
      ready: true,
      requiresRelocation: true,
    });

    // Ни отмен, ни пустого листа: отгрузить лист можно, состояние — «Можно выдать».
    expect(routeView!.shippable).toBe(true);
    expect(routeView!.readiness).toBe('CAN_ISSUE');
  });
});
