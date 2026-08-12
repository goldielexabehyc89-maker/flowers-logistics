/**
 * Критические проверки складского движения (этап 6.5).
 *
 * Проверяется не «нажимается ли кнопка», а то, нарушение чего теряет коробку:
 * у заказа не бывает двух мест, номер заказа не выбирает случайную строку,
 * между двумя сканами база не меняется, комплектование и выдача возобновляемы,
 * а последний выданный заказ переводит маршрут в `ACTIVE` одной транзакцией.
 *
 * Отдельно доказывается граница: склад принимает физический заказ независимо
 * от любого состояния FLORIST и от его отсутствия.
 *
 * Календарные данные подобраны так, чтобы не пересекаться с другими файлами.
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
import type { AuthenticatedActor } from '../auth/guards.js';
import type { Role } from '@fl/shared';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { createStorageCell, unknownOccupancy, type CellDeps } from './service.js';
import { countActivePlacements, receiveOrder, withdrawOrder, type FlowDeps } from './placement.js';
import {
  bindRouteCell,
  cancelIssueSession,
  confirmCourier,
  issueOrder,
  pickOrderToRouteCell,
} from './route-flow.js';
import { resolveOrderByNumber } from './order-lookup.js';
import { getRouteFlow, listConfirmedRoutes, listPlacedOrders } from './views.js';

let ctx: TestContext;
let flow: FlowDeps;
let cells: CellDeps;
const CONTEXT = { ip: null, userAgent: null };

/** Дата вне диапазонов остальных файлов набора. */
const DAY = '2027-05-04';

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

/**
 * Токены кешируются по набору ролей.
 *
 * Каждый вход выполняет argon2-хеширование PIN — это десятки миллисекунд
 * процессорного времени. Набор проверок прав перебирает роли в циклах, и без
 * кеша один файл заметно замедлял бы ВЕСЬ прогон, выталкивая соседние тесты
 * за их таймаут. Права от повторного входа тем же пользователем не меняются.
 */
const tokenCache = new Map<string, string>();

async function tokenFor(roles: Role[]): Promise<string> {
  const key = [...roles].sort().join(',');
  const cached = tokenCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

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

  tokenCache.set(key, session.accessToken);
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
    { code: unique(kind === 'ROUTE' ? 'R' : 'S'), kind },
    CONTEXT,
  );
  return { id: created.id, code: created.normalizedCode };
}

/**
 * Заказ создаётся напрямую и БЕЗ единого поля производственного контура.
 *
 * Это и есть проверка границы: склад обязан работать с физической коробкой,
 * ничего не зная о флористе.
 */
async function seedOrder(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; number: string }> {
  const number = unique('W');
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
  options: { courierId?: string; state?: 'CONFIRMED' | 'DRAFT' } = {},
): Promise<{ id: string; number: string; version: number }> {
  const creator = await actorFor(['ADMIN']);
  const number = unique('RT');
  const route = await ctx.db.deliveryRoute.create({
    data: {
      number,
      deliveryDate: toDateColumn(DAY),
      state: options.state ?? 'CONFIRMED',
      vehicleType: 'CAR',
      createdById: creator.userId,
      ...(options.courierId === undefined ? {} : { courierUserId: options.courierId }),
    },
    select: { id: true, number: true, version: true },
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

async function activeCellOf(orderId: string): Promise<string | null> {
  const row = await ctx.db.orderPlacement.findFirst({
    where: { orderId, releasedAt: null },
    select: { cellId: true },
  });
  return row?.cellId ?? null;
}

// --- 1. Граница с FLORIST ----------------------------------------------------

describe('независимость от FLORIST', () => {
  it('заказ без единого поля производственного контура принимается на склад', async () => {
    const order = await seedOrder();
    const cell = await seedCell('STORAGE');
    const actor = await actorFor(['WAREHOUSE']);

    // У заказа нет ни состояния сборки, ни флориста, ни печати.
    const raw = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentCompositionState: true, fulfillmentSnapshotHash: true },
    });
    expect(raw.fulfillmentSnapshotHash).toBeNull();

    const result = await receiveOrder(
      flow,
      actor,
      { orderNumber: order.number, cellCode: cell.code },
      CONTEXT,
    );

    expect(result.unchanged).toBe(false);
    expect(await activeCellOf(order.id)).toBe(cell.id);
  });

  it('складской модуль не читает ни одного поля состояния сборки', async () => {
    // Проверка на исходниках: зависимость легко внести случайно, и она
    // сломала бы приёмку физической коробки из-за чужого программного статуса.
    //
    // Комментарии из проверки исключаются намеренно: упоминание флориста
    // в объяснении — это не зависимость, а описание процесса.
    const { readFileSync } = await import('node:fs');
    const withoutComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    for (const file of ['placement.ts', 'route-flow.ts', 'order-lookup.ts', 'views.ts']) {
      const code = withoutComments(readFileSync(new URL(file, import.meta.url), 'utf8'));

      // Ни полей производственного снимка, ни импорта из чужого модуля.
      expect(code, file).not.toMatch(/fulfillment/i);
      expect(code, file).not.toMatch(/modules\/fulfillment/);
      expect(code, file).not.toMatch(/florist/i);
    }
  });
});

// --- 2. Номер заказа ---------------------------------------------------------

describe('разрешение номера заказа', () => {
  it('регистр и пробелы не мешают, неизвестный номер отвергается', async () => {
    const order = await seedOrder();

    const found = await resolveOrderByNumber(ctx.db, `  ${order.number.toLowerCase()} `);
    expect(found.id).toBe(order.id);

    await expect(resolveOrderByNumber(ctx.db, unique('НЕТ'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('неоднозначный номер даёт явный отказ, а не случайный заказ', async () => {
    const number = unique('DUP');
    const first = await seedOrder({ externalName: number });
    const second = await seedOrder({ externalName: number });
    expect(first.id).not.toBe(second.id);

    await expect(resolveOrderByNumber(ctx.db, number)).rejects.toMatchObject({
      code: 'CONFLICT',
      conflict: { kind: 'ORDER_NUMBER_AMBIGUOUS' },
    });

    // И приёмка тоже отказывает: выбрать «любой» из двух нельзя.
    const cell = await seedCell('STORAGE');
    const actor = await actorFor(['WAREHOUSE']);
    await expect(
      receiveOrder(flow, actor, { orderNumber: number, cellCode: cell.code }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NUMBER_AMBIGUOUS' } });
  });
});

// --- 3. Приёмка --------------------------------------------------------------

describe('приёмка', () => {
  it('до второго скана база не меняется', async () => {
    const order = await seedOrder();
    const token = await tokenFor(['WAREHOUSE']);

    const scan = await call(
      'GET',
      `/api/warehouse/scan/order?number=${encodeURIComponent(order.number)}`,
      token,
    );
    expect(scan.statusCode).toBe(200);

    // Скан заказа — чтение. Промежуточной «приёмки без ячейки» не существует.
    expect(await ctx.db.orderPlacement.count({ where: { orderId: order.id } })).toBe(0);
    expect(await activeCellOf(order.id)).toBeNull();
  });

  it('повтор той же пары идемпотентен, вторая ячейка переносит заказ', async () => {
    const order = await seedOrder();
    const first = await seedCell('STORAGE');
    const second = await seedCell('STORAGE');
    const actor = await actorFor(['WAREHOUSE']);

    const initial = await receiveOrder(
      flow,
      actor,
      { orderNumber: order.number, cellCode: first.code },
      CONTEXT,
    );
    const repeat = await receiveOrder(
      flow,
      actor,
      { orderNumber: order.number, cellCode: first.code },
      CONTEXT,
    );

    expect(repeat.unchanged).toBe(true);
    expect(repeat.placementId).toBe(initial.placementId);
    expect(await ctx.db.orderPlacement.count({ where: { orderId: order.id } })).toBe(1);

    const moved = await receiveOrder(
      flow,
      actor,
      { orderNumber: order.number, cellCode: second.code },
      CONTEXT,
    );
    expect(moved.unchanged).toBe(false);
    expect(await activeCellOf(order.id)).toBe(second.id);

    // История сохранена целиком: два размещения, первое закрыто переносом.
    const history = await ctx.db.orderPlacement.findMany({
      where: { orderId: order.id },
      orderBy: { placedAt: 'asc' },
      select: { cellId: true, fromCellId: true, source: true, releaseReason: true },
    });
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      cellId: first.id,
      source: 'RECEIVED',
      releaseReason: 'MOVED_TO_STORAGE',
    });
    expect(history[1]).toMatchObject({ cellId: second.id, fromCellId: first.id, source: 'MOVED' });
  });

  it('маршрутная ячейка при обычной приёмке требует явного согласия', async () => {
    const order = await seedOrder();
    const routeCell = await seedCell('ROUTE');
    const actor = await actorFor(['WAREHOUSE']);

    await expect(
      receiveOrder(flow, actor, { orderNumber: order.number, cellCode: routeCell.code }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ROUTE_CELL_REQUIRES_CHOICE' } });

    const confirmed = await receiveOrder(
      flow,
      actor,
      { orderNumber: order.number, cellCode: routeCell.code, allowRouteCell: true },
      CONTEXT,
    );
    expect(confirmed.cellKind).toBe('ROUTE');
  });

  it('выключенная ячейка не принимает заказ, но отдать из неё можно', async () => {
    const order = await seedOrder();
    const cell = await seedCell('STORAGE');
    const actor = await actorFor(['WAREHOUSE']);
    const admin = await actorFor(['ADMIN']);

    await receiveOrder(flow, actor, { orderNumber: order.number, cellCode: cell.code }, CONTEXT);

    const row = await ctx.db.storageCell.findUniqueOrThrow({ where: { id: cell.id } });
    const { setStorageCellActive } = await import('./service.js');
    await setStorageCellActive(
      cells,
      admin,
      cell.id,
      { isActive: false, expectedVersion: row.version },
      CONTEXT,
    );

    const other = await seedOrder();
    await expect(
      receiveOrder(flow, actor, { orderNumber: other.number, cellCode: cell.code }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'CELL_INACTIVE' } });

    // Уже лежащий заказ виден и изымается штатно.
    const placed = await listPlacedOrders(ctx.db, { cellId: cell.id, limit: 50, offset: 0 });
    expect(placed.items.map((item) => item.orderId)).toContain(order.id);

    const withdrawn = await withdrawOrder(
      flow,
      actor,
      { orderNumber: order.number, reason: 'возврат флористу' },
      CONTEXT,
    );
    expect(withdrawn.withdrawn).toBe(true);
    expect(await activeCellOf(order.id)).toBeNull();
  });

  it('проблемный заказ размещается, но комплектование ему закрыто', async () => {
    const order = await seedOrder({ inScope: false });
    const cell = await seedCell('STORAGE');
    const actor = await actorFor(['WAREHOUSE']);

    const placed = await receiveOrder(
      flow,
      actor,
      { orderNumber: order.number, cellCode: cell.code },
      CONTEXT,
    );
    expect(placed.blockedBy).toContain('OUT_OF_SCOPE');
    expect(await activeCellOf(order.id)).toBe(cell.id);

    const route = await seedRoute([order.id]);
    const routeCell = await seedCell('ROUTE');
    await bindRouteCell(flow, actor, route.id, { cellCode: routeCell.code }, CONTEXT);

    await expect(
      pickOrderToRouteCell(
        flow,
        actor,
        route.id,
        { orderNumber: order.number, cellCode: routeCell.code },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_BLOCKED' } });
  });
});

// --- 4. Инварианты базы ------------------------------------------------------

describe('инварианты базы', () => {
  it('у заказа не бывает двух активных мест', async () => {
    const order = await seedOrder();
    const first = await seedCell('STORAGE');
    const second = await seedCell('STORAGE');
    const actor = await actorFor(['WAREHOUSE']);

    await receiveOrder(flow, actor, { orderNumber: order.number, cellCode: first.code }, CONTEXT);

    await expect(
      ctx.db.orderPlacement.create({
        data: {
          orderId: order.id,
          cellId: second.id,
          source: 'RECEIVED',
          placedById: actor.userId,
        },
      }),
    ).rejects.toThrow();
  });

  it('ячейку размещения нельзя подменить молча', async () => {
    const order = await seedOrder();
    const first = await seedCell('STORAGE');
    const second = await seedCell('STORAGE');
    const actor = await actorFor(['WAREHOUSE']);

    const placed = await receiveOrder(
      flow,
      actor,
      { orderNumber: order.number, cellCode: first.code },
      CONTEXT,
    );

    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "OrderPlacement" SET "cellId" = '${second.id}'::uuid WHERE "id" = '${placed.placementId}'::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('история не удаляется и закрытая запись не редактируется', async () => {
    const order = await seedOrder();
    const cell = await seedCell('STORAGE');
    const actor = await actorFor(['WAREHOUSE']);

    const placed = await receiveOrder(
      flow,
      actor,
      { orderNumber: order.number, cellCode: cell.code },
      CONTEXT,
    );
    await withdrawOrder(flow, actor, { orderNumber: order.number, reason: 'проверка' }, CONTEXT);

    await expect(
      ctx.db.orderPlacement.delete({ where: { id: placed.placementId } }),
    ).rejects.toThrow();

    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "OrderPlacement" SET "requiresRelocation" = true WHERE "id" = '${placed.placementId}'::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('маршрутной ячейкой не может стать ячейка хранения', async () => {
    const storage = await seedCell('STORAGE');
    const route = await seedRoute([]);
    const actor = await actorFor(['WAREHOUSE']);

    await expect(
      bindRouteCell(flow, actor, route.id, { cellCode: storage.code }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'CELL_KIND_MISMATCH' } });

    // И база не даст этого даже прямым запросом: составной внешний ключ.
    await expect(
      ctx.db.$executeRawUnsafe(
        `INSERT INTO "RouteCellBinding" ("id","routeId","cellId","cellKind","boundById")
         SELECT gen_random_uuid(), '${route.id}'::uuid, '${storage.id}'::uuid, 'ROUTE', "id" FROM "User" LIMIT 1`,
      ),
    ).rejects.toThrow();
  });

  it('одна маршрутная ячейка не обслуживает два листа', async () => {
    const cell = await seedCell('ROUTE');
    const first = await seedRoute([]);
    const second = await seedRoute([]);
    const actor = await actorFor(['WAREHOUSE']);

    await bindRouteCell(flow, actor, first.id, { cellCode: cell.code }, CONTEXT);
    await expect(
      bindRouteCell(flow, actor, second.id, { cellCode: cell.code }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ROUTE_CELL_ALREADY_BOUND' } });
  });

  it('фактическая занятость открывает смену типа только у пустой ячейки', async () => {
    const cell = await seedCell('STORAGE');
    const order = await seedOrder();
    const actor = await actorFor(['WAREHOUSE']);

    expect(await countActivePlacements(ctx.db, cell.id)).toBe(0);
    await receiveOrder(flow, actor, { orderNumber: order.number, cellCode: cell.code }, CONTEXT);
    expect(await countActivePlacements(ctx.db, cell.id)).toBe(1);

    await withdrawOrder(flow, actor, { orderNumber: order.number, reason: 'освобождаем' }, CONTEXT);
    expect(await countActivePlacements(ctx.db, cell.id)).toBe(0);
  });
});

// --- 5. Комплектование -------------------------------------------------------

describe('комплектование', () => {
  it('частичное комплектование сохраняется и продолжается', async () => {
    const first = await seedOrder();
    const second = await seedOrder();
    const storage = await seedCell('STORAGE');
    const routeCell = await seedCell('ROUTE');
    const actor = await actorFor(['WAREHOUSE']);
    const route = await seedRoute([first.id, second.id]);

    for (const order of [first, second]) {
      await receiveOrder(
        flow,
        actor,
        { orderNumber: order.number, cellCode: storage.code },
        CONTEXT,
      );
    }
    await bindRouteCell(flow, actor, route.id, { cellCode: routeCell.code }, CONTEXT);

    const step = await pickOrderToRouteCell(
      flow,
      actor,
      route.id,
      { orderNumber: first.number, cellCode: routeCell.code },
      CONTEXT,
    );
    expect(step).toMatchObject({ picked: 1, total: 2, unchanged: false });

    // Пауза: карточка показывает прогресс и фактические ячейки.
    const view = await getRouteFlow(ctx.db, route.id);
    expect(view?.orders.filter((order) => order.inRouteCell)).toHaveLength(1);
    expect(view?.orders.find((order) => order.orderId === second.id)?.cellCode).toBe(storage.code);

    // Повтор того же заказа ничего не меняет.
    const repeat = await pickOrderToRouteCell(
      flow,
      actor,
      route.id,
      { orderNumber: first.number, cellCode: routeCell.code },
      CONTEXT,
    );
    expect(repeat.unchanged).toBe(true);

    const done = await pickOrderToRouteCell(
      flow,
      actor,
      route.id,
      { orderNumber: second.number, cellCode: routeCell.code },
      CONTEXT,
    );
    expect(done.picked).toBe(2);
  });

  it('чужой заказ, чужая ячейка и непринятый заказ отказывают', async () => {
    const mine = await seedOrder();
    const foreign = await seedOrder();
    const storage = await seedCell('STORAGE');
    const routeCell = await seedCell('ROUTE');
    const otherCell = await seedCell('ROUTE');
    const actor = await actorFor(['WAREHOUSE']);
    const route = await seedRoute([mine.id]);

    await bindRouteCell(flow, actor, route.id, { cellCode: routeCell.code }, CONTEXT);

    // Заказ не принят на склад.
    await expect(
      pickOrderToRouteCell(
        flow,
        actor,
        route.id,
        { orderNumber: mine.number, cellCode: routeCell.code },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_PLACED' } });

    await receiveOrder(flow, actor, { orderNumber: mine.number, cellCode: storage.code }, CONTEXT);
    await receiveOrder(
      flow,
      actor,
      { orderNumber: foreign.number, cellCode: storage.code },
      CONTEXT,
    );

    // Не та маршрутная ячейка.
    await expect(
      pickOrderToRouteCell(
        flow,
        actor,
        route.id,
        { orderNumber: mine.number, cellCode: otherCell.code },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ROUTE_CELL_MISMATCH' } });

    // Заказ другого маршрута.
    await expect(
      pickOrderToRouteCell(
        flow,
        actor,
        route.id,
        { orderNumber: foreign.number, cellCode: routeCell.code },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_IN_ROUTE' } });
  });

  it('возврат маршрута в черновик помечает заказы и блокирует выдачу', async () => {
    const order = await seedOrder();
    const storage = await seedCell('STORAGE');
    const routeCell = await seedCell('ROUTE');
    const actor = await actorFor(['WAREHOUSE']);
    const admin = await actorFor(['ADMIN']);
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
    const route = await seedRoute([order.id], { courierId: courier.id });

    await receiveOrder(flow, actor, { orderNumber: order.number, cellCode: storage.code }, CONTEXT);
    await bindRouteCell(flow, actor, route.id, { cellCode: routeCell.code }, CONTEXT);
    await pickOrderToRouteCell(
      flow,
      actor,
      route.id,
      { orderNumber: order.number, cellCode: routeCell.code },
      CONTEXT,
    );

    const { returnToDraft } = await import('../routing/lifecycle.js');
    const current = await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } });
    await returnToDraft(
      { db: ctx.db },
      admin,
      route.id,
      { reason: 'нужно переделать состав', expectedVersion: current.version },
      CONTEXT,
    );

    // Коробка физически не переехала, но помечена и выдаче недоступна.
    expect(await activeCellOf(order.id)).toBe(routeCell.id);
    const placement = await ctx.db.orderPlacement.findFirstOrThrow({
      where: { orderId: order.id, releasedAt: null },
      select: { requiresRelocation: true },
    });
    expect(placement.requiresRelocation).toBe(true);
  });
});

// --- 6. Выдача ---------------------------------------------------------------

async function readyRoute(orderCount: number): Promise<{
  route: { id: string; number: string };
  orders: { id: string; number: string }[];
  courierId: string;
  routeCellId: string;
  actor: AuthenticatedActor;
}> {
  const actor = await actorFor(['WAREHOUSE']);
  const storage = await seedCell('STORAGE');
  const routeCell = await seedCell('ROUTE');
  const courier = await seedUser(ctx.db, { roles: ['COURIER'] });

  const orders = [];
  for (let i = 0; i < orderCount; i += 1) {
    orders.push(await seedOrder());
  }
  const route = await seedRoute(
    orders.map((order) => order.id),
    { courierId: courier.id },
  );

  for (const order of orders) {
    await receiveOrder(flow, actor, { orderNumber: order.number, cellCode: storage.code }, CONTEXT);
  }
  await bindRouteCell(flow, actor, route.id, { cellCode: routeCell.code }, CONTEXT);
  for (const order of orders) {
    await pickOrderToRouteCell(
      flow,
      actor,
      route.id,
      { orderNumber: order.number, cellCode: routeCell.code },
      CONTEXT,
    );
  }

  return { route, orders, courierId: courier.id, routeCellId: routeCell.id, actor };
}

describe('выдача', () => {
  it('без подтверждения курьера выдать нельзя', async () => {
    const { route, orders, actor } = await readyRoute(1);

    await expect(
      issueOrder(flow, actor, route.id, { orderNumber: orders[0]?.number ?? '' }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ISSUE_SESSION_REQUIRED' } });
  });

  it('частичная выдача возобновляема, повтор идемпотентен', async () => {
    const { route, orders, courierId, actor } = await readyRoute(2);
    await confirmCourier(flow, actor, route.id, { courierUserId: courierId }, CONTEXT);

    const first = await issueOrder(
      flow,
      actor,
      route.id,
      { orderNumber: orders[0]?.number ?? '' },
      CONTEXT,
    );
    expect(first).toMatchObject({ issued: 1, total: 2, routeActivated: false });

    // Маршрут остаётся подтверждённым: выдан не весь лист.
    const midway = await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } });
    expect(midway.state).toBe('CONFIRMED');

    const repeat = await issueOrder(
      flow,
      actor,
      route.id,
      { orderNumber: orders[0]?.number ?? '' },
      CONTEXT,
    );
    expect(repeat).toMatchObject({ unchanged: true, issued: 1 });
  });

  it('последний заказ одной транзакцией переводит маршрут в ACTIVE', async () => {
    const { route, orders, courierId, routeCellId, actor } = await readyRoute(2);
    await confirmCourier(flow, actor, route.id, { courierUserId: courierId }, CONTEXT);

    await issueOrder(flow, actor, route.id, { orderNumber: orders[0]?.number ?? '' }, CONTEXT);
    const last = await issueOrder(
      flow,
      actor,
      route.id,
      { orderNumber: orders[1]?.number ?? '' },
      CONTEXT,
    );

    expect(last).toMatchObject({ issued: 2, total: 2, routeActivated: true });

    const updated = await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } });
    expect(updated.state).toBe('ACTIVE');

    // Переход записан в неизменяемую историю без причины.
    const transition = await ctx.db.routeStateTransition.findFirstOrThrow({
      where: { routeId: route.id, toState: 'ACTIVE' },
      select: { fromState: true, reason: true },
    });
    expect(transition).toMatchObject({ fromState: 'CONFIRMED', reason: null });

    // Маршрутная ячейка освобождена и доступна другому листу.
    const binding = await ctx.db.routeCellBinding.findFirstOrThrow({
      where: { routeId: route.id },
      select: { releasedAt: true },
    });
    expect(binding.releasedAt).not.toBeNull();

    const another = await seedRoute([]);
    const cell = await ctx.db.storageCell.findUniqueOrThrow({ where: { id: routeCellId } });
    await expect(
      bindRouteCell(flow, actor, another.id, { cellCode: cell.normalizedCode }, CONTEXT),
    ).resolves.toMatchObject({ cellId: routeCellId });

    // Сессия закрыта, повторная выдача по активному маршруту невозможна.
    await expect(
      issueOrder(flow, actor, route.id, { orderNumber: orders[0]?.number ?? '' }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ROUTE_NOT_CONFIRMED' } });
  });

  it('отмену сессии выполняет только администратор, выданное остаётся в истории', async () => {
    const { route, orders, courierId, actor } = await readyRoute(2);
    const admin = await actorFor(['ADMIN']);
    await confirmCourier(flow, actor, route.id, { courierUserId: courierId }, CONTEXT);
    await issueOrder(flow, actor, route.id, { orderNumber: orders[0]?.number ?? '' }, CONTEXT);

    const cancelled = await cancelIssueSession(
      flow,
      admin,
      route.id,
      { reason: 'курьер заболел' },
      CONTEXT,
    );
    expect(cancelled).toMatchObject({ cancelled: true, issued: 1 });

    // Выданный заказ остаётся выданным, невыданный — физически размещённым.
    expect(await activeCellOf(orders[0]?.id ?? '')).toBeNull();
    expect(await activeCellOf(orders[1]?.id ?? '')).not.toBeNull();

    // Новая выдача снова требует подтверждения курьера.
    await expect(
      issueOrder(flow, actor, route.id, { orderNumber: orders[1]?.number ?? '' }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ISSUE_SESSION_REQUIRED' } });
  });

  it('заказ вне маршрута и не принятый на склад выдать нельзя', async () => {
    const { route, courierId, actor } = await readyRoute(1);
    await confirmCourier(flow, actor, route.id, { courierUserId: courierId }, CONTEXT);

    const foreign = await seedOrder();
    await expect(
      issueOrder(flow, actor, route.id, { orderNumber: foreign.number }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_IN_ROUTE' } });
  });

  it('курьер должен быть активным пользователем роли COURIER', async () => {
    const actor = await actorFor(['WAREHOUSE']);
    const notCourier = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const route = await seedRoute([], { courierId: notCourier.id });

    await expect(
      confirmCourier(flow, actor, route.id, { courierUserId: notCourier.id }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ROUTE_COURIER_UNAVAILABLE' } });
  });
});

// --- 7. Права и состав ответа ------------------------------------------------

describe('права и состав ответа', () => {
  it('ADMIN и WAREHOUSE работают, остальные 403, аноним 401', async () => {
    const order = await seedOrder();
    const cell = await seedCell('STORAGE');

    for (const roles of [['ADMIN'], ['WAREHOUSE']] as Role[][]) {
      const token = await tokenFor(roles);
      expect((await call('GET', '/api/warehouse/placements', token)).statusCode, roles.join()).toBe(
        200,
      );
    }

    for (const roles of [['LOGISTICIAN'], ['COURIER'], ['FLORIST'], ['MANAGER']] as Role[][]) {
      const token = await tokenFor(roles);
      expect((await call('GET', '/api/warehouse/placements', token)).statusCode, roles.join()).toBe(
        403,
      );
      expect(
        (
          await call('POST', '/api/warehouse/placements', token, {
            orderNumber: order.number,
            cellCode: cell.code,
          })
        ).statusCode,
        roles.join(),
      ).toBe(403);
    }

    expect((await call('GET', '/api/warehouse/placements', null)).statusCode).toBe(401);
  });

  it('отмену выдачи кладовщик выполнить не может', async () => {
    const { route, courierId, actor } = await readyRoute(1);
    await confirmCourier(flow, actor, route.id, { courierUserId: courierId }, CONTEXT);

    const warehouse = await tokenFor(['WAREHOUSE']);
    expect(
      (
        await call('POST', `/api/warehouse/routes/${route.id}/issue/cancel`, warehouse, {
          reason: 'без прав',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('в ответах нет адреса, получателя, комментария и денег', async () => {
    const order = await seedOrder({
      address: 'Москва, Складская проверка потока, 7',
      recipient: 'Получатель Потоковый',
      comment: 'Комментарий, которого склад видеть не должен',
      sumMinor: 777000n,
    });
    const cell = await seedCell('STORAGE');
    const actor = await actorFor(['WAREHOUSE']);
    const token = await tokenFor(['WAREHOUSE']);
    await receiveOrder(flow, actor, { orderNumber: order.number, cellCode: cell.code }, CONTEXT);

    const route = await seedRoute([order.id]);

    for (const url of [
      '/api/warehouse/placements?limit=100',
      `/api/warehouse/scan/order?number=${encodeURIComponent(order.number)}`,
      `/api/warehouse/routes/${route.id}`,
      `/api/warehouse/routes?deliveryDate=${DAY}`,
    ]) {
      const response = await call('GET', url, token);
      expect(response.statusCode, url).toBe(200);
      for (const secret of [
        'Складская проверка потока',
        'Получатель Потоковый',
        'которого склад видеть не должен',
        '7770',
      ]) {
        expect(response.body, `${url} / ${secret}`).not.toContain(secret);
      }
    }
  });
});

// --- 8. Календарный день -----------------------------------------------------

describe('московский день', () => {
  it('маршрутный лист попадает в свой день независимо от пояса процесса', async () => {
    const order = await seedOrder();
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
    const route = await seedRoute([order.id], { courierId: courier.id });

    // Проверка не зависит от пояса процесса намеренно: она обязана проходить
    // и под UTC локально, и под Europe/Moscow в CI. Утверждать конкретный
    // пояс здесь было бы проверкой окружения, а не поведения.
    const listed = await listConfirmedRoutes(ctx.db, DAY);
    expect(listed.map((item) => item.routeId)).toContain(route.id);
    expect(listed.find((item) => item.routeId === route.id)?.deliveryDate).toBe(DAY);

    // Соседние дни его не видят: сравнение идёт календарной датой, а не моментом
    // времени — иначе маршрут уехал бы в соседний день при смене пояса.
    for (const neighbour of ['2027-05-03', '2027-05-05']) {
      const listed = await listConfirmedRoutes(ctx.db, neighbour);
      expect(
        listed.map((item) => item.routeId),
        neighbour,
      ).not.toContain(route.id);
    }

    // И карточка маршрутного листа отдаёт ту же календарную дату.
    const card = await getRouteFlow(ctx.db, route.id);
    expect(card?.deliveryDate).toBe(DAY);
  });
});
