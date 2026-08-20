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
  checkOrderForIssue,
  confirmCourier,
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

    for (const file of [
      'placement.ts',
      'route-flow.ts',
      'route-cells.ts',
      'order-lookup.ts',
      'views.ts',
    ]) {
      const code = withoutComments(readFileSync(new URL(file, import.meta.url), 'utf8'));

      // Ни полей производственного снимка, ни импорта из чужого модуля.
      expect(code, file).not.toMatch(/fulfillment/i);
      expect(code, file).not.toMatch(/modules\/fulfillment/);
      expect(code, file).not.toMatch(/florist/i);
    }
  });

  it('доска сборки читает состояние сборки, но ничего им не запрещает', async () => {
    /*
     * Граница проведена по НАЗНАЧЕНИЮ файла, а не по слову в тексте.
     *
     * Физические операции обязаны оставаться независимыми: коробку
     * принимают потому, что она стоит перед кладовщиком. Доска сборки —
     * это экран: кладовщику нужно знать, идти ли за букетом к флористу
     * или ждать, пока его донесут. Поэтому читать состояние сборки ей
     * можно, а звать операции чужого модуля — нет.
     */
    const { readFileSync } = await import('node:fs');
    const board = readFileSync(new URL('assembly-board.ts', import.meta.url), 'utf8');

    expect(board).not.toMatch(/modules\/fulfillment/);
    expect(board).not.toMatch(/claimOrder|completeAssembly|printForm/);

    // И сама доска ничего не меняет: только запросы на чтение.
    expect(board).not.toMatch(/\.(create|update|updateMany|delete|deleteMany)\(/);
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

  it('коробка, которой на складе ещё не было, кладётся в ячейку листа сразу', async () => {
    /*
     * Кладовщик держит её в руках: заказ приехал от флориста и идёт на
     * полку своего листа. Промежуточная приёмка в хранение означала бы
     * «положите на случайную полку, чтобы через секунду забрать».
     */
    const order = await seedOrder();
    const routeCell = await seedCell('ROUTE');
    const actor = await actorFor(['WAREHOUSE']);
    const route = await seedRoute([order.id]);
    await bindRouteCell(flow, actor, route.id, { cellCode: routeCell.code }, CONTEXT);

    const result = await pickOrderToRouteCell(
      flow,
      actor,
      route.id,
      { orderNumber: order.number, cellCode: routeCell.code },
      CONTEXT,
    );

    expect(result.picked).toBe(1);
    expect(await activeCellOf(order.id)).toBe(routeCell.id);

    // История честная: это приёмка, а не перемещение из ниоткуда.
    const placement = await ctx.db.orderPlacement.findFirstOrThrow({
      where: { orderId: order.id, releasedAt: null },
      select: { source: true, fromCellId: true },
    });
    expect(placement.source).toBe('RECEIVED');
    expect(placement.fromCellId).toBeNull();
  });

  it('чужой заказ и чужая ячейка отказывают', async () => {
    const mine = await seedOrder();
    const foreign = await seedOrder();
    const storage = await seedCell('STORAGE');
    const routeCell = await seedCell('ROUTE');
    const otherCell = await seedCell('ROUTE');
    const actor = await actorFor(['WAREHOUSE']);
    const route = await seedRoute([mine.id]);

    await bindRouteCell(flow, actor, route.id, { cellCode: routeCell.code }, CONTEXT);

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
  it('без подтверждения курьера внести заказ в лист нельзя', async () => {
    const { route, orders, actor } = await readyRoute(1);

    await expect(
      checkOrderForIssue(flow, actor, route.id, { orderNumber: orders[0]?.number ?? '' }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ISSUE_SESSION_REQUIRED' } });
  });

  it('поштучной выдачи из HTTP больше нет', async () => {
    /*
     * Отрицательная проверка, и она существенна.
     *
     * Пока публичный путь «выдать один заказ» существовал, лист можно было
     * отдать курьеру по частям, обойдя повторную проверку состава: половина
     * коробок уезжала, половина оставалась на полке. Теперь физическая
     * передача происходит только целиком, и старого пути нет вовсе —
     * не «закрыт правами», а не зарегистрирован.
     */
    const { route, orders, courierId, actor } = await readyRoute(2);
    const token = await tokenFor(['WAREHOUSE']);
    await confirmCourier(flow, actor, route.id, { courierUserId: courierId }, CONTEXT);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/warehouse/routes/${route.id}/issue`,
      headers: { authorization: `Bearer ${token}` },
      payload: { orderNumber: orders[0]?.number ?? '' },
    });
    expect(response.statusCode).toBe(404);

    // И ни одна коробка не уехала.
    for (const order of orders) {
      expect(await activeCellOf(order.id)).not.toBeNull();
    }
  });

  it('заказ вне маршрута и не принятый на склад в лист не вносятся', async () => {
    const { route, courierId, actor } = await readyRoute(1);
    await confirmCourier(flow, actor, route.id, { courierUserId: courierId }, CONTEXT);

    const foreign = await seedOrder();
    await expect(
      checkOrderForIssue(flow, actor, route.id, { orderNumber: foreign.number }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_IN_ROUTE' } });
  });

  it('отмену сессии выполняет только администратор', async () => {
    const { route, courierId, actor } = await readyRoute(1);
    await confirmCourier(flow, actor, route.id, { courierUserId: courierId }, CONTEXT);

    // Право проверяется на границе HTTP: сама операция вызывается уже
    // после проверки роли, и обратное означало бы две разные политики.
    const keeperToken = await tokenFor(['WAREHOUSE']);
    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: `/api/warehouse/routes/${route.id}/issue/cancel`,
      headers: { authorization: `Bearer ${keeperToken}` },
      payload: { reason: 'проверка' },
    });
    expect(forbidden.statusCode).toBe(403);

    const admin = await actorFor(['ADMIN']);
    const cancelled = await cancelIssueSession(
      flow,
      admin,
      route.id,
      { reason: 'курьер не приехал' },
      CONTEXT,
    );
    expect(cancelled.cancelled).toBe(true);
  });
});

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

describe('складской список читается целиком, а не первой сотней', () => {
  /*
   * Прежде интерфейс просил ровно сто строк и на этом останавливался: коробка
   * под сто первым номером исчезала из списка, хотя стояла на полке. Проверка
   * идёт по одной ячейке — так набор строк принадлежит только этому тесту и не
   * зависит от того, что оставили на складе соседние сценарии.
   */
  const PAGE = 100;

  async function fillCell(
    cellId: string,
    count: number,
  ): Promise<{ oldest: { id: string; number: string }; relocation: number; cancelled: number }> {
    const keeper = await actorFor(['WAREHOUSE']);
    let oldest = { id: '', number: '' };
    let relocation = 0;
    let cancelled = 0;

    for (let index = 0; index < count; index += 1) {
      // Отменённых и требующих перемещения кладём вперемешку и в оба конца
      // списка: иначе «полный счётчик» нельзя было бы отличить от счётчика
      // первой страницы.
      const isCancelled = index % 7 === 0;
      const needsMove = index % 11 === 0 && !isCancelled;
      const order = await seedOrder(
        isCancelled
          ? { cancelledInSource: true, cancelledInSourceAt: new Date('2027-02-01T09:00:00.000Z') }
          : {},
      );
      if (isCancelled) cancelled += 1;
      if (needsMove) relocation += 1;

      await ctx.db.orderPlacement.create({
        data: {
          orderId: order.id,
          cellId,
          placedById: keeper.userId,
          source: 'RECEIVED',
          // Чем больше индекс, тем старее коробка: список идёт от свежих.
          placedAt: new Date(Date.now() - index * 60_000),
          requiresRelocation: needsMove,
        },
      });
      if (index === count - 1) {
        oldest = order;
      }
    }

    return { oldest, relocation, cancelled };
  }

  it('первая страница, дочитывание и полные счётчики групп сходятся', async () => {
    const cell = await seedCell('STORAGE');
    const seeded = await fillCell(cell.id, PAGE + 1);

    const first = await listPlacedOrders(ctx.db, { cellId: cell.id, limit: PAGE, offset: 0 });
    expect(first.items).toHaveLength(PAGE);
    expect(first.total).toBe(PAGE + 1);
    // Самая старая коробка в первую сотню не поместилась.
    expect(first.items.map((row) => row.orderId)).not.toContain(seeded.oldest.id);

    // Счётчики считают ВЕСЬ склад, а не загруженную страницу.
    expect(first.groupTotals.relocation).toBe(seeded.relocation);
    expect(first.groupTotals.cancelled).toBe(seeded.cancelled);
    expect(first.groupTotals.rest).toBe(PAGE + 1 - seeded.relocation - seeded.cancelled);
    expect(
      first.groupTotals.relocation + first.groupTotals.cancelled + first.groupTotals.rest,
    ).toBe(first.total);

    const second = await listPlacedOrders(ctx.db, { cellId: cell.id, limit: PAGE, offset: PAGE });
    expect(second.items.map((row) => row.orderId)).toContain(seeded.oldest.id);

    // Ни одна строка не пришла дважды и ни одна не потерялась.
    const ids = [...first.items, ...second.items].map((row) => row.orderId);
    expect(new Set(ids).size).toBe(PAGE + 1);
  });

  it('снятое с хранения размещение уходит из списка и из счётчиков', async () => {
    const cell = await seedCell('STORAGE');
    await fillCell(cell.id, 3);

    const before = await listPlacedOrders(ctx.db, { cellId: cell.id, limit: PAGE, offset: 0 });
    const victim = before.items[0];
    expect(victim).toBeDefined();

    const actor = await actorFor(['WAREHOUSE']);
    await withdrawOrder(
      flow,
      actor,
      { orderNumber: victim!.orderNumber, reason: 'REASSEMBLY' },
      CONTEXT,
    );

    const after = await listPlacedOrders(ctx.db, { cellId: cell.id, limit: PAGE, offset: 0 });
    expect(after.total).toBe(before.total - 1);
    expect(after.items.map((row) => row.orderId)).not.toContain(victim!.orderId);
    expect(
      after.groupTotals.relocation + after.groupTotals.cancelled + after.groupTotals.rest,
    ).toBe(after.total);
  });

  it('старая коробка находится сканированием так же, как свежая', async () => {
    const cell = await seedCell('STORAGE');
    const seeded = await fillCell(cell.id, PAGE + 1);

    const found = await listPlacedOrders(ctx.db, { cellId: cell.id, limit: PAGE, offset: PAGE });
    const row = found.items.find((item) => item.orderId === seeded.oldest.id);
    expect(row?.orderNumber).toBe(seeded.oldest.number);
    expect(row?.cellCode).toBe(cell.code);
  });
});

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

/*
 * Прежний блок «частичная выдача и смена курьера» удалён вместе с самим
 * поштучным путём: частичной выдачи больше не существует, и проверять
 * её возобновляемость нечего. Свойства, которые остались настоящими —
 * общий прогресс, повторный и конкурентный скан, изменившийся состав
 * и передача листа другому курьеру, — живут в `issue-checks.critical.test.ts`,
 * где они относятся к действующей операции.
 */
