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

/**
 * Ищет деньги в разобранном ответе и возвращает путь до находки.
 *
 * Проверять деньги подстрокой в тексте ответа нельзя: идентификаторы UUIDv7
 * и номера содержат случайные цифры, и любая короткая сумма рано или поздно
 * встретится в них сама по себе. Разбор отвечает на настоящий вопрос —
 * есть ли в ответе поле про деньги или значение, равное сумме заказа.
 */
function moneyLeak(value: unknown, amountMinor: bigint, path = 'ответ'): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = moneyLeak(item, amountMinor, `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }

  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (/sum|cash|amount|price|minor/i.test(key)) return `${path}.${key}`;
      const found = moneyLeak(item, amountMinor, `${path}.${key}`);
      if (found !== null) return found;
    }
    return null;
  }

  if (typeof value === 'number' || typeof value === 'string') {
    if (String(value) === String(amountMinor)) return path;
  }
  return null;
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
      { orderNumber: order.number, reason: 'REASSEMBLY' },
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
    await withdrawOrder(flow, actor, { orderNumber: order.number, reason: 'WRITE_OFF' }, CONTEXT);

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

    await withdrawOrder(flow, actor, { orderNumber: order.number, reason: 'REASSEMBLY' }, CONTEXT);
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

    // Ни один отказ не сдвинул коробку: оба заказа лежат там же, где лежали.
    // Это и есть смысл второго физического скана — ошибиться ячейкой можно,
    // а переместить заказ ошибкой нельзя.
    expect(await activeCellOf(mine.id)).toBe(storage.id);
    expect(await activeCellOf(foreign.id)).toBe(storage.id);

    // Правильная пара переносит ровно один заказ.
    const picked = await pickOrderToRouteCell(
      flow,
      actor,
      route.id,
      { orderNumber: mine.number, cellCode: routeCell.code },
      CONTEXT,
    );
    expect(picked).toMatchObject({ picked: 1, total: 1 });
    expect(await activeCellOf(mine.id)).toBe(routeCell.id);
    expect(await activeCellOf(foreign.id)).toBe(storage.id);
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
      ]) {
        expect(response.body, `${url} / ${secret}`).not.toContain(secret);
      }

      // Деньги ищутся по разобранному ответу, а не подстрокой в тексте.
      // Подстрока «7770» встречается в случайных идентификаторах сама по себе:
      // проверка обвиняла бы склад в утечке суммы из-за совпадения в UUID.
      expect(moneyLeak(JSON.parse(response.body), 777000n), url).toBeNull();
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

// --- 9. Восстановление после частичной выдачи --------------------------------

describe('частичная выдача и смена курьера', () => {
  it('сквозной сценарий: A выдал один из трёх, ADMIN передал остаток B, третий даёт ACTIVE', async () => {
    const actor = await actorFor(['WAREHOUSE']);
    const admin = await actorFor(['ADMIN']);
    const storage = await seedCell('STORAGE');
    const routeCell = await seedCell('ROUTE');
    const courierA = await seedUser(ctx.db, { roles: ['COURIER'] });
    const courierB = await seedUser(ctx.db, { roles: ['COURIER'] });

    const orders = [await seedOrder(), await seedOrder(), await seedOrder()];
    const route = await seedRoute(
      orders.map((order) => order.id),
      { courierId: courierA.id },
    );

    for (const order of orders) {
      await receiveOrder(
        flow,
        actor,
        { orderNumber: order.number, cellCode: storage.code },
        CONTEXT,
      );
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

    // 2. Курьер A подтверждён, выдан первый заказ: общий прогресс 1/3.
    await confirmCourier(flow, actor, route.id, { courierUserId: courierA.id }, CONTEXT);
    const first = await issueOrder(
      flow,
      actor,
      route.id,
      { orderNumber: orders[0]?.number ?? '' },
      CONTEXT,
    );
    expect(first).toMatchObject({ issued: 1, total: 3, routeActivated: false });

    // 3. Обычные операции над маршрутом закрыты: выдача уже началась.
    const { returnToDraft, cancelRoute } = await import('../routing/lifecycle.js');
    const { setCourier } = await import('../routing/service.js');
    const current = await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } });

    await expect(
      returnToDraft(
        { db: ctx.db },
        admin,
        route.id,
        { reason: 'попытка обойти выдачу', expectedVersion: current.version },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(
      cancelRoute(
        { db: ctx.db },
        admin,
        route.id,
        { reason: 'попытка обойти выдачу', expectedVersion: current.version },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(
      setCourier(
        { db: ctx.db },
        admin,
        route.id,
        { courierUserId: courierB.id, expectedVersion: current.version },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // Маршрут не сдвинулся ни на версию: ни одна попытка не прошла частично.
    const afterAttempts = await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } });
    expect(afterAttempts).toMatchObject({
      state: 'CONFIRMED',
      version: current.version,
      courierUserId: courierA.id,
    });

    // 4. Кладовщик отменить выдачу не может; администратор — может, с курьером B.
    const warehouseToken = await tokenFor(['WAREHOUSE']);
    expect(
      (
        await call('POST', `/api/warehouse/routes/${route.id}/issue/cancel`, warehouseToken, {
          reason: 'без прав',
        })
      ).statusCode,
    ).toBe(403);

    const cancelled = await cancelIssueSession(
      flow,
      admin,
      route.id,
      { reason: 'курьер A заболел', nextCourierUserId: courierB.id },
      CONTEXT,
    );
    expect(cancelled).toMatchObject({ cancelled: true, issued: 1, courierUserId: courierB.id });

    // 5. Выдача первого заказа осталась в истории A, активного размещения нет.
    const issuedPlacement = await ctx.db.orderPlacement.findFirstOrThrow({
      where: { orderId: orders[0]?.id ?? '', releaseReason: 'ISSUED_TO_COURIER' },
      select: { issueSession: { select: { courierUserId: true, state: true } } },
    });
    expect(issuedPlacement.issueSession).toMatchObject({
      courierUserId: courierA.id,
      state: 'CANCELLED',
    });
    expect(await activeCellOf(orders[0]?.id ?? '')).toBeNull();

    // Карточка между сессиями обязана помнить выданное: открытой сессии нет,
    // но заказ у курьера, и экран не имеет права звать его к выдаче заново.
    const between = await getRouteFlow(ctx.db, route.id);
    expect(between?.issueSession).toBeNull();
    expect(between?.orders.filter((row) => row.issued).map((row) => row.orderId)).toEqual([
      orders[0]?.id,
    ]);

    // 6. Курьер B подтверждён; повтор первого QR идемпотентен и даёт 1/3.
    await confirmCourier(flow, actor, route.id, { courierUserId: courierB.id }, CONTEXT);
    const repeat = await issueOrder(
      flow,
      actor,
      route.id,
      { orderNumber: orders[0]?.number ?? '' },
      CONTEXT,
    );
    expect(repeat).toMatchObject({ unchanged: true, issued: 1, total: 3, routeActivated: false });

    const second = await issueOrder(
      flow,
      actor,
      route.id,
      { orderNumber: orders[1]?.number ?? '' },
      CONTEXT,
    );
    expect(second).toMatchObject({ issued: 2, total: 3, routeActivated: false });
    expect((await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } })).state).toBe(
      'CONFIRMED',
    );

    // 7. Только третий переводит маршрут в ACTIVE и освобождает ячейку.
    const third = await issueOrder(
      flow,
      actor,
      route.id,
      { orderNumber: orders[2]?.number ?? '' },
      CONTEXT,
    );
    expect(third).toMatchObject({ issued: 3, total: 3, routeActivated: true });

    const finished = await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } });
    expect(finished.state).toBe('ACTIVE');

    // Уехавший маршрут не редактируется ни одним обычным путём, и отказ
    // называет причину честно: «переданы курьеру», а не «уже отменён».
    await expect(
      returnToDraft(
        { db: ctx.db },
        admin,
        route.id,
        { reason: 'передумали', expectedVersion: finished.version },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      cancelRoute(
        { db: ctx.db },
        admin,
        route.id,
        { reason: 'передумали', expectedVersion: finished.version },
        CONTEXT,
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      publicMessage: 'Заказы переданы курьеру: маршрут больше не отменяется.',
    });
    await expect(
      setCourier(
        { db: ctx.db },
        admin,
        route.id,
        { courierUserId: courierA.id, expectedVersion: finished.version },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const session = await ctx.db.routeIssueSession.findFirstOrThrow({
      where: { routeId: route.id, courierUserId: courierB.id },
      select: { state: true },
    });
    expect(session.state).toBe('COMPLETED');

    const binding = await ctx.db.routeCellBinding.findFirstOrThrow({
      where: { routeId: route.id },
      select: { releasedAt: true },
    });
    expect(binding.releasedAt).not.toBeNull();

    // Переход записан ровно один раз.
    expect(
      await ctx.db.routeStateTransition.count({ where: { routeId: route.id, toState: 'ACTIVE' } }),
    ).toBe(1);

    // Карточка завершённого маршрута считает выданными все три заказа, хотя
    // открытой сессии больше нет: клиентский прогресс строится на этом поле.
    const done = await getRouteFlow(ctx.db, route.id);
    expect(done?.state).toBe('ACTIVE');
    expect(done?.orders.every((row) => row.issued)).toBe(true);

    // 8. Логистическое чтение показывает ACTIVE и не теряет лист.
    const token = await tokenFor(['LOGISTICIAN']);
    const listed = await call(
      'GET',
      `/api/routes?deliveryDate=${DAY}&state=ACTIVE&limit=100`,
      token,
    );
    expect(listed.statusCode).toBe(200);
    expect(
      (listed.json() as { items: { id: string; state: string }[] }).items.some(
        (item) => item.id === route.id && item.state === 'ACTIVE',
      ),
    ).toBe(true);
  });

  it('недопустимый следующий курьер откатывает всю отмену целиком', async () => {
    const actor = await actorFor(['WAREHOUSE']);
    const admin = await actorFor(['ADMIN']);
    const storage = await seedCell('STORAGE');
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
    const frozen = await seedUser(ctx.db, { roles: ['COURIER'], status: 'FROZEN' });
    const notCourier = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });

    const order = await seedOrder();
    const route = await seedRoute([order.id], { courierId: courier.id });
    await receiveOrder(flow, actor, { orderNumber: order.number, cellCode: storage.code }, CONTEXT);
    await confirmCourier(flow, actor, route.id, { courierUserId: courier.id }, CONTEXT);

    for (const candidate of [randomUUID(), frozen.id, notCourier.id]) {
      await expect(
        cancelIssueSession(
          flow,
          admin,
          route.id,
          { reason: 'проверка отката', nextCourierUserId: candidate },
          CONTEXT,
        ),
        candidate,
      ).rejects.toThrow();

      // Ни отмены, ни переназначения: сессия открыта, курьер прежний.
      const session = await ctx.db.routeIssueSession.findFirstOrThrow({
        where: { routeId: route.id },
        select: { state: true },
      });
      expect(session.state, candidate).toBe('OPEN');
      expect(
        (await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } })).courierUserId,
        candidate,
      ).toBe(courier.id);
    }
  });

  it('до первой выдачи прежний путь возврата и отмены не сломан', async () => {
    const actor = await actorFor(['WAREHOUSE']);
    const admin = await actorFor(['ADMIN']);
    const storage = await seedCell('STORAGE');
    const routeCell = await seedCell('ROUTE');
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });

    const order = await seedOrder();
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

    // Курьер подтверждён, но ни один заказ не выдан: обычный путь ещё открыт.
    await confirmCourier(flow, actor, route.id, { courierUserId: courier.id }, CONTEXT);
    await cancelIssueSession(flow, admin, route.id, { reason: 'передумали' }, CONTEXT);

    const current = await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } });
    const { returnToDraft } = await import('../routing/lifecycle.js');
    const returned = await returnToDraft(
      { db: ctx.db },
      admin,
      route.id,
      { reason: 'нужно поправить состав', expectedVersion: current.version },
      CONTEXT,
    );
    expect(returned.state).toBe('DRAFT');

    // И прежняя пометка «требуется перемещение» по-прежнему ставится.
    const placement = await ctx.db.orderPlacement.findFirstOrThrow({
      where: { orderId: order.id, releasedAt: null },
      select: { requiresRelocation: true },
    });
    expect(placement.requiresRelocation).toBe(true);
  });

  it('выдача в ДРУГОМ маршруте идемпотентным успехом не становится', async () => {
    const actor = await actorFor(['WAREHOUSE']);
    const admin = await actorFor(['ADMIN']);
    const storage = await seedCell('STORAGE');
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });

    const order = await seedOrder();
    const first = await seedRoute([order.id], { courierId: courier.id });
    await receiveOrder(flow, actor, { orderNumber: order.number, cellCode: storage.code }, CONTEXT);
    await confirmCourier(flow, actor, first.id, { courierUserId: courier.id }, CONTEXT);
    await issueOrder(flow, actor, first.id, { orderNumber: order.number }, CONTEXT);

    // Заказ выведен из состава первого маршрута и добавлен во второй: один
    // заказ не может состоять в двух активных составах — это держит база.
    await ctx.db.routeOrder.updateMany({
      where: { routeId: first.id, orderId: order.id, removedAt: null },
      data: {
        removedAt: new Date(),
        removedById: admin.userId,
        removalReason: 'RETURNED_TO_UNASSIGNED',
      },
    });
    const second = await seedRoute([order.id], { courierId: courier.id });
    await confirmCourier(flow, actor, second.id, { courierUserId: courier.id }, CONTEXT);

    // Факт выдачи принадлежит ПЕРВОМУ маршруту, поэтому второй его не засчитывает:
    // молчаливое согласие здесь означало бы, что коробки нет ни у кого.
    await expect(
      issueOrder(flow, actor, second.id, { orderNumber: order.number }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_PLACED' } });

    // И прогресс второго маршрута не увидел чужую выдачу.
    const view = await getRouteFlow(ctx.db, second.id);
    expect(view?.orders.filter((row) => row.issued)).toHaveLength(0);
  });

  it('параллельная выдача последнего заказа даёт один переход, а не два', async () => {
    const actor = await actorFor(['WAREHOUSE']);
    const storage = await seedCell('STORAGE');
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });

    const order = await seedOrder();
    const route = await seedRoute([order.id], { courierId: courier.id });
    await receiveOrder(flow, actor, { orderNumber: order.number, cellCode: storage.code }, CONTEXT);
    await confirmCourier(flow, actor, route.id, { courierUserId: courier.id }, CONTEXT);

    // Два одновременных скана одного и того же последнего заказа.
    const results = await Promise.allSettled([
      issueOrder(flow, actor, route.id, { orderNumber: order.number }, CONTEXT),
      issueOrder(flow, actor, route.id, { orderNumber: order.number }, CONTEXT),
    ]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);

    // Независимо от исхода гонки переход ровно один, и маршрут активен.
    expect(
      await ctx.db.routeStateTransition.count({ where: { routeId: route.id, toState: 'ACTIVE' } }),
    ).toBe(1);
    expect((await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } })).state).toBe(
      'ACTIVE',
    );
  });

  it('аудит и realtime отмены не несут номера заказа и кода ячейки', async () => {
    const actor = await actorFor(['WAREHOUSE']);
    const admin = await actorFor(['ADMIN']);
    const storage = await seedCell('STORAGE');
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
    const nextCourier = await seedUser(ctx.db, { roles: ['COURIER'] });

    const order = await seedOrder();
    const route = await seedRoute([order.id], { courierId: courier.id });
    await receiveOrder(flow, actor, { orderNumber: order.number, cellCode: storage.code }, CONTEXT);
    await confirmCourier(flow, actor, route.id, { courierUserId: courier.id }, CONTEXT);
    await cancelIssueSession(
      flow,
      admin,
      route.id,
      { reason: 'проверка следов', nextCourierUserId: nextCourier.id },
      CONTEXT,
    );

    const audit = await ctx.db.auditLog.findFirstOrThrow({
      where: { action: 'WAREHOUSE_ISSUE_CANCELLED' },
      orderBy: { id: 'desc' },
      select: { newValue: true },
    });
    const auditText = JSON.stringify(audit.newValue);
    expect(auditText).not.toContain(order.number);
    expect(auditText).not.toContain(storage.code);
    // Причина живёт в защищённой строке сессии, а не в общем журнале.
    expect(auditText).not.toContain('проверка следов');

    const events = await ctx.db.realtimeEvent.findMany({
      where: { topic: 'warehouse.route_flow_changed' },
      orderBy: { id: 'desc' },
      take: 3,
      select: { payload: true },
    });
    for (const event of events) {
      const text = JSON.stringify(event.payload);
      expect(text).not.toContain(order.number);
      expect(text).not.toContain(storage.code);
    }
  });
});
