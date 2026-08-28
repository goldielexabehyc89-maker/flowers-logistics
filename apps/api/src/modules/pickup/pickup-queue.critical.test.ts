/**
 * Критические проверки очереди самовывоза и правил выдачи.
 *
 * Защищаемое свойство физическое: коробка стоит на полке до тех пор, пока её
 * не забрал покупатель. Всё остальное — календарь, перестановка между
 * ячейками, архив источника — не имеет права убрать её с глаз менеджера.
 *
 * Отсюда правила очереди:
 *
 *  * день НЕ фильтр: вчерашний, сегодняшний и завтрашний стоят вместе;
 *  * исчезнуть можно ровно двумя способами — выдали либо отменили;
 *  * снятая с полки коробка остаётся в очереди с честной причиной;
 *  * счётчик считает ВЕСЬ отбор, а продолжение не теряет и не повторяет строки.
 *
 * ВЛАДЕНИЕ ДАТАМИ: август 2028 года.
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
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { createStorageCell, unknownOccupancy, type CellDeps } from '../warehouse/service.js';
import { receiveOrder, withdrawOrder, type FlowDeps } from '../warehouse/placement.js';
import { applyCancellation } from '../integrations/moysklad/cancellation.js';
import { saveWarehouseManualEntry, readWarehouseManualEntry } from '../settings/service.js';
import { issueToCustomer, type PickupDeps } from './service.js';
import { findPickupByNumber, listPickupQueue } from './views.js';

let ctx: TestContext;
let pickup: PickupDeps;
let flow: FlowDeps;
let cells: CellDeps;
const CONTEXT = { ip: null, userAgent: null };

/** Дни, забронированные этим файлом. */
const YESTERDAY = '2028-08-09';
const TODAY = '2028-08-10';
const TOMORROW = '2028-08-11';

beforeAll(async () => {
  ctx = await createTestContext();
  pickup = { db: ctx.db };
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

async function seedCell(): Promise<{ id: string; code: string }> {
  const admin = await actorFor(['ADMIN']);
  const cell = await createStorageCell(
    cells,
    admin,
    { code: unique('QS'), kind: 'STORAGE' },
    CONTEXT,
  );
  return { id: cell.id, code: cell.normalizedCode };
}

interface SeedOptions {
  day?: string | null;
  number?: string;
  deliveryMethodId?: string | null;
  fulfillmentInScope?: boolean;
  sourceArchived?: boolean;
  sourceMissing?: boolean;
}

async function seedOrder(options: SeedOptions = {}): Promise<{ id: string; number: string }> {
  const number = options.number ?? unique('QP');
  const day = options.day === undefined ? TODAY : options.day;
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: number,
      externalUpdated: new Date('2028-08-01T00:00:00.000Z'),
      deliveryDate: day === null ? null : toDateColumn(day),
      address: null,
      recipient: 'Синтетический Покупатель',
      storeId: MOYSKLAD_IDS.store,
      deliveryMethodId:
        options.deliveryMethodId === undefined
          ? MOYSKLAD_IDS.deliveryMethodPickup
          : options.deliveryMethodId,
      inScope: false,
      fulfillmentInScope: options.fulfillmentInScope ?? true,
      sourceArchived: options.sourceArchived ?? false,
      sourceMissing: options.sourceMissing ?? false,
    },
    select: { id: true, externalName: true },
  });
  return { id: order.id, number: order.externalName };
}

/** Заказ, принятый кладовщиком на полку: обычный складской путь. */
async function placed(options: SeedOptions = {}): Promise<{
  order: { id: string; number: string };
  cell: { id: string; code: string };
}> {
  const order = await seedOrder(options);
  const cell = await seedCell();
  const keeper = await actorFor(['WAREHOUSE']);
  await receiveOrder(flow, keeper, { orderNumber: order.number, cellCode: cell.code }, CONTEXT);
  return { order, cell };
}

async function queueNumbers(): Promise<string[]> {
  const page = await listPickupQueue(ctx.db, { limit: 200 });
  return page.items.map((item) => item.orderNumber);
}

async function cancel(orderId: string, cancelled: boolean): Promise<void> {
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { cancelledInSource: true },
  });
  await ctx.db.$transaction(async (tx) => {
    await applyCancellation(tx, {
      orderId,
      cancelled,
      previous: order.cancelledInSource,
      now: new Date(),
    });
  });
}

async function setManualEntry(enabled: boolean): Promise<void> {
  const admin = await actorFor(['ADMIN']);
  const current = await readWarehouseManualEntry(ctx.db);
  if (current.value.enabled === enabled) {
    return;
  }
  await saveWarehouseManualEntry(ctx.db, admin, {
    value: { enabled },
    expectedVersion: current.version,
    ip: null,
    userAgent: null,
  });
}

// --- 1. Очередь не привязана к дню -------------------------------------------

describe('состав очереди', () => {
  it('вчерашний, сегодняшний, завтрашний и бездатный стоят в одной очереди', async () => {
    const yesterday = await placed({ day: YESTERDAY });
    const today = await placed({ day: TODAY });
    const tomorrow = await placed({ day: TOMORROW });
    const undated = await placed({ day: null });

    const numbers = await queueNumbers();
    for (const item of [yesterday, today, tomorrow, undated]) {
      expect(numbers, item.order.number).toContain(item.order.number);
    }

    /*
     * Порядок: сначала ранняя дата, потом номер, бездатные — последними.
     * Заказ без даты не «сегодня»: обещать по нему срочность нечем.
     */
    const page = await listPickupQueue(ctx.db, { limit: 200 });
    const positions = new Map(page.items.map((item, index) => [item.orderNumber, index]));
    expect(positions.get(yesterday.order.number)!).toBeLessThan(positions.get(today.order.number)!);
    expect(positions.get(today.order.number)!).toBeLessThan(positions.get(tomorrow.order.number)!);
    expect(positions.get(tomorrow.order.number)!).toBeLessThan(
      positions.get(undated.order.number)!,
    );
  });

  it('самовывоз виден сразу после импорта, до складской приёмки', async () => {
    const waiting = await seedOrder();

    // Наличие ячейки — не условие показа: заказ в очереди сразу, с честной
    // причиной «нет ячейки», но выдать его нельзя.
    const before = await listPickupQueue(ctx.db, { limit: 200 });
    const waitingRow = before.items.find((item) => item.orderNumber === waiting.number);
    expect(waitingRow, 'самовывоз без ячейки не показан').toBeDefined();
    expect(waitingRow?.cellCode).toBeNull();
    expect(waitingRow?.blockers).toContain('NOT_PLACED');

    // После приёмки складом в карточке появляется номер ячейки.
    const cell = await seedCell();
    const keeper = await actorFor(['WAREHOUSE']);
    await receiveOrder(flow, keeper, { orderNumber: waiting.number, cellCode: cell.code }, CONTEXT);

    const after = await listPickupQueue(ctx.db, { limit: 200 });
    const placedRow = after.items.find((item) => item.orderNumber === waiting.number);
    expect(placedRow?.cellCode).toBe(cell.code);
    expect(placedRow?.blockers).toEqual([]);
  });

  it('перемещение между ячейками из очереди не убирает', async () => {
    const { order } = await placed();
    const another = await seedCell();
    const keeper = await actorFor(['WAREHOUSE']);

    await receiveOrder(
      flow,
      keeper,
      { orderNumber: order.number, cellCode: another.code },
      CONTEXT,
    );

    const page = await listPickupQueue(ctx.db, { limit: 200 });
    const row = page.items.find((item) => item.orderNumber === order.number);
    expect(row?.cellCode).toBe(another.code);
    expect(row?.blockers).toEqual([]);
  });

  it('списанная коробка уходит из очереди, а после повторной приёмки возвращается', async () => {
    const { order } = await placed();
    const keeper = await actorFor(['WAREHOUSE']);

    // Списание — «выдавать нечего»: заказ уходит из ожидающих (требование пакета).
    await withdrawOrder(flow, keeper, { orderNumber: order.number, reason: 'WRITE_OFF' }, CONTEXT);
    expect(await queueNumbers()).not.toContain(order.number);
    // Но из базы не исчез — история осталась.
    expect(await ctx.db.deliveryOrder.count({ where: { id: order.id } })).toBe(1);

    // Если коробку всё же снова приняли на полку — заказ снова ожидает выдачи.
    const cell = await seedCell();
    await receiveOrder(flow, keeper, { orderNumber: order.number, cellCode: cell.code }, CONTEXT);
    expect(await queueNumbers()).toContain(order.number);
  });

  it('изъятая на пересборку коробка остаётся в очереди с честной причиной', async () => {
    const { order } = await placed();
    const keeper = await actorFor(['WAREHOUSE']);

    // Пересборка — это не списание: букет вернётся, и заказ прятать нельзя.
    await withdrawOrder(flow, keeper, { orderNumber: order.number, reason: 'REASSEMBLY' }, CONTEXT);

    const page = await listPickupQueue(ctx.db, { limit: 200 });
    const row = page.items.find((item) => item.orderNumber === order.number);
    expect(row, 'заказ исчез из очереди').toBeDefined();
    expect(row?.cellCode).toBeNull();
    expect(row?.blockers).toContain('NOT_PLACED');
  });

  it('архивированный и пропавший видны, но выдавать их нельзя', async () => {
    const archived = await placed({ sourceArchived: true, fulfillmentInScope: false });
    const missing = await placed({ sourceMissing: true });
    const manager = await actorFor(['MANAGER']);

    const page = await listPickupQueue(ctx.db, { limit: 200 });
    for (const item of [archived, missing]) {
      const row = page.items.find((card) => card.orderNumber === item.order.number);
      expect(row, item.order.number).toBeDefined();
      expect(row?.blockers).toContain('ORDER_BLOCKED');
      // Способом получения он остаётся самовывозом: «это не самовывоз»
      // отправило бы менеджера искать курьера, которого нет.
      expect(row?.blockers).not.toContain('NOT_PICKUP');
      expect(row?.isPickup).toBe(true);
    }

    await expect(
      issueToCustomer(
        pickup,
        manager,
        { orderNumber: archived.order.number, source: 'SCAN' },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_BLOCKED' } });
  });

  it('выданный уходит из очереди и помнит, откуда его забрали', async () => {
    const { order, cell } = await placed();
    const manager = await actorFor(['MANAGER']);

    await issueToCustomer(pickup, manager, { orderNumber: order.number, source: 'SCAN' }, CONTEXT);

    expect(await queueNumbers()).not.toContain(order.number);

    /*
     * Действующего размещения у выданного заказа нет, но вопрос «откуда
     * отдали» обязан иметь ответ: карточка показывает ячейку факта выдачи.
     */
    const card = await findPickupByNumber(ctx.db, order.number);
    expect(card.cellCode).toBe(cell.code);
    expect(card.blockers).toContain('ALREADY_ISSUED');
  });
});

// --- 2. Отмена ----------------------------------------------------------------

describe('отмена заказа', () => {
  it('убирает из очереди, но коробку с полки не снимает', async () => {
    const { order, cell } = await placed();

    await cancel(order.id, true);

    expect(await queueNumbers()).not.toContain(order.number);
    // Отмена не перемещает коробку: место осталось за ней.
    const placement = await ctx.db.orderPlacement.findFirst({
      where: { orderId: order.id, releasedAt: null },
      select: { cellId: true },
    });
    expect(placement?.cellId).toBe(cell.id);
  });

  it('запрещает выдачу и сканированием, и вручную', async () => {
    const { order } = await placed();
    const manager = await actorFor(['MANAGER']);
    await setManualEntry(true);
    await cancel(order.id, true);

    for (const source of ['SCAN', 'MANUAL'] as const) {
      await expect(
        issueToCustomer(pickup, manager, { orderNumber: order.number, source }, CONTEXT),
      ).rejects.toMatchObject({ conflict: { kind: 'ORDER_CANCELLED' } });
    }
    await setManualEntry(false);
  });

  it('снятая отмена возвращает заказ в очередь, пока он лежит в ячейке', async () => {
    const { order } = await placed();

    await cancel(order.id, true);
    expect(await queueNumbers()).not.toContain(order.number);

    await cancel(order.id, false);
    expect(await queueNumbers()).toContain(order.number);
  });

  it('отмена после выдачи факт выдачи не переписывает', async () => {
    const { order } = await placed();
    const manager = await actorFor(['MANAGER']);

    const issued = await issueToCustomer(
      pickup,
      manager,
      { orderNumber: order.number, source: 'SCAN' },
      CONTEXT,
    );
    await cancel(order.id, true);

    const fact = await ctx.db.orderPickupIssue.findUniqueOrThrow({
      where: { orderId: order.id },
      select: { id: true, issuedAt: true, issuedById: true },
    });
    expect(fact.id).toBe(issued.issueId);
    expect(fact.issuedById).toBe(manager.userId);
  });

  it('выдача и отмена в один миг дают один согласованный исход', async () => {
    const { order } = await placed();
    const manager = await actorFor(['MANAGER']);

    const results = await Promise.allSettled([
      issueToCustomer(pickup, manager, { orderNumber: order.number, source: 'SCAN' }, CONTEXT),
      ctx.db.$transaction(async (tx) => {
        await applyCancellation(tx, {
          orderId: order.id,
          cancelled: true,
          previous: false,
          now: new Date(),
        });
      }),
    ]);

    const issued = await ctx.db.orderPickupIssue.count({ where: { orderId: order.id } });
    const active = await ctx.db.orderPlacement.count({
      where: { orderId: order.id, releasedAt: null },
    });

    /*
     * Ровно два законных исхода: коробка уехала до отмены — тогда есть факт
     * выдачи и нет действующего размещения; отмена успела первой — тогда
     * факта нет, а коробка стоит на полке. Половины не бывает.
     */
    expect(issued === 1 ? active === 0 : active === 1).toBe(true);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
  });
});

// --- 3. Ручная выдача ---------------------------------------------------------

describe('ручная выдача', () => {
  it('запрещена сервером при выключенной настройке', async () => {
    await setManualEntry(false);
    const { order } = await placed();
    const manager = await actorFor(['MANAGER']);

    await expect(
      issueToCustomer(pickup, manager, { orderNumber: order.number, source: 'MANUAL' }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'MANUAL_ENTRY_DISABLED' } });

    // Отказ ничего не тронул: коробка на месте, факта выдачи нет.
    expect(
      await ctx.db.orderPlacement.count({ where: { orderId: order.id, releasedAt: null } }),
    ).toBe(1);
    expect(await ctx.db.orderPickupIssue.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('сканирование работает независимо от настройки', async () => {
    await setManualEntry(false);
    const { order } = await placed();
    const manager = await actorFor(['MANAGER']);

    const result = await issueToCustomer(
      pickup,
      manager,
      { orderNumber: order.number, source: 'SCAN' },
      CONTEXT,
    );
    expect(result.orderNumber).toBe(order.number);
  });

  it('работает при включённой настройке и пишет способ действия в аудит', async () => {
    await setManualEntry(true);
    const { order } = await placed();
    const manager = await actorFor(['MANAGER']);

    const result = await issueToCustomer(
      pickup,
      manager,
      { orderNumber: order.number, source: 'MANUAL' },
      CONTEXT,
    );

    const audit = await ctx.db.auditLog.findFirst({
      where: { action: 'PICKUP_ORDER_ISSUED', entityId: result.issueId },
      select: { newValue: true },
    });
    const value = audit?.newValue as { source?: string; orderId?: string } | null;
    expect(value?.source).toBe('MANUAL');
    // Ни номера заказа, ни кода полки: в аудите только идентификаторы.
    expect(JSON.stringify(value)).not.toContain(order.number);

    await setManualEntry(false);
  });
});

// --- 4. Постраничность --------------------------------------------------------

describe('продолжение очереди', () => {
  it('не теряет и не повторяет строки', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const seeded = await placed({ day: TOMORROW, number: unique('QQ') });
      ids.push(seeded.order.id);
    }

    // Собираем идентификаторы, а не номера: номер в источнике не уникален —
    // отдельная проверка неоднозначности намеренно заводит два заказа с одним
    // номером, и оба честно стоят в очереди. Строка очереди — это заказ (id),
    // и «не теряет, не повторяет» проверяется по нему.
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page: Awaited<ReturnType<typeof listPickupQueue>> = await listPickupQueue(ctx.db, {
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      seen.push(...page.items.map((item) => item.orderId));
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor !== null && guard < 100);

    expect(new Set(seen).size, 'строки повторились').toBe(seen.length);
    for (const id of ids) {
      expect(seen, id).toContain(id);
    }

    // Счётчик считает ВЕСЬ отбор, а не показанную страницу.
    const first = await listPickupQueue(ctx.db, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(seen.length);
  });

  it('испорченное продолжение отвергается понятным отказом', async () => {
    await expect(listPickupQueue(ctx.db, { cursor: 'не-ключ' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
