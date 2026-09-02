/**
 * Критические проверки списка «Ожидают приёмки».
 *
 * Защищаемое свойство: склад видит РОВНО те собранные заказы, которых ещё нет
 * на полке. Приняли в ячейку — заказ ушёл; собрали заново — вернулся; отменили
 * или списали — не показывается. Ошибка здесь означает либо коробку, потерянную
 * из виду, либо приглашение принять то, что принимать нельзя.
 *
 * Заказы доводятся до состояния «Собран» доменными функциями (смена → захват →
 * сборка), а не прямой записью полей: только так снимок и ревизия сборки
 * оказываются согласованными с проверками базы.
 *
 * ВЛАДЕНИЕ ДАТАМИ: март 2029 года (см. RESERVED_MONTHS).
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
import { snapshotHash, type FulfillmentSnapshot } from '../fulfillment/composition.js';
import { assembleOrder, claimOrder, reopenOrder } from '../fulfillment/assembly.js';
import { startShift } from '../fulfillment/shifts.js';
import { createStorageCell, unknownOccupancy, type CellDeps } from './service.js';
import { receiveOrder, withdrawOrder, type FlowDeps } from './placement.js';
import { listAwaitingIntake, AWAITING_INTAKE_ROLES } from './awaiting.js';

let ctx: TestContext;
let flow: FlowDeps;
let cells: CellDeps;
const CONTEXT = { ip: null, userAgent: null };

/** День вне диапазонов остальных файлов набора. */
const DAY = '2029-03-12';

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

async function seedCell(): Promise<{ id: string; code: string }> {
  const actor = await actorFor(['ADMIN']);
  const created = await createStorageCell(
    cells,
    actor,
    { code: unique('WS'), kind: 'STORAGE' },
    CONTEXT,
  );
  return { id: created.id, code: created.normalizedCode };
}

function compositionOf(externalId: string): FulfillmentSnapshot {
  return {
    externalId,
    description: 'Комментарий заказа',
    cardText: 'С праздником!',
    positions: [
      {
        externalPositionId: randomUUID(),
        ordinal: 0,
        assortmentId: randomUUID(),
        assortmentKind: 'PRODUCT',
        assortmentKindRaw: 'product',
        name: 'Роза красная',
        quantity: '11',
        characteristicLabel: null,
        components: [],
      },
    ],
  };
}

/** Производственный заказ с подтверждённым составом (ещё не собран). */
async function seedProductionOrder(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; number: string }> {
  const number = unique('AW');
  const externalId = randomUUID();
  const snapshot = compositionOf(externalId);

  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId,
      externalName: number,
      externalUpdated: new Date('2029-03-01T00:00:00.000Z'),
      deliveryDate: toDateColumn(DAY),
      intervalKind: 'RANGE',
      intervalStartMinute: 600,
      intervalEndMinute: 840,
      inScope: true,
      fulfillmentInScope: true,
      fulfillmentDescription: snapshot.description,
      fulfillmentCardText: snapshot.cardText,
      fulfillmentSnapshotHash: snapshotHash(snapshot),
      fulfillmentCompositionState: 'READY',
      fulfillmentCompositionSyncedAt: new Date(),
      fulfillmentPositions: {
        create: snapshot.positions.map((position) => ({
          externalPositionId: position.externalPositionId,
          ordinal: position.ordinal,
          assortmentId: position.assortmentId,
          assortmentKind: position.assortmentKind,
          assortmentKindRaw: position.assortmentKindRaw,
          name: position.name,
          quantity: position.quantity,
          characteristicLabel: position.characteristicLabel,
        })),
      },
      fulfillmentRevisions: {
        create: {
          externalUpdated: new Date('2029-03-01T00:00:00.000Z'),
          snapshot: snapshot as never,
          snapshotHash: snapshotHash(snapshot),
          changedFields: ['externalId', 'description', 'cardText', 'positions'],
          reason: 'INITIAL_IMPORT',
        },
      },
      ...overrides,
    },
    select: { id: true, externalName: true },
  });
  return { id: order.id, number: order.externalName };
}

/**
 * Доводит заказ до «Собран» новым флористом (смена → захват → сборка) и
 * возвращает этого флориста: он остаётся исполнителем и после возврата в работу.
 */
async function assembleBy(
  orderId: string,
  fullName = 'Флорист Тестовый',
): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles: ['FLORIST'], fullName });
  const florist: AuthenticatedActor = {
    userId: user.id,
    roles: ['FLORIST'],
    familyId: randomUUID(),
  } as AuthenticatedActor;
  await startShift(ctx.db, florist, CONTEXT);
  const claimed = await claimOrder(ctx.db, florist, orderId, CONTEXT);
  await assembleOrder(
    ctx.db,
    florist,
    { orderId, expectedProcessVersion: claimed.processVersion },
    CONTEXT,
  );
  return florist;
}

/** Собранный заказ без ячейки — базовый кандидат «ожидает приёмки». */
async function seedAssembled(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; number: string }> {
  const order = await seedProductionOrder(overrides);
  await assembleBy(order.id);
  return order;
}

async function awaitingNumbers(search?: string): Promise<string[]> {
  const page = await listAwaitingIntake(ctx.db, { search });
  return page.items.map((item) => item.orderNumber);
}

describe('роли раздела', () => {
  it('раздел видят склад, админ, управляющий и менеджер выдачи', () => {
    expect([...AWAITING_INTAKE_ROLES].sort()).toEqual(
      ['ADMIN', 'MANAGER', 'SUPERVISOR', 'WAREHOUSE'].sort(),
    );
  });
});

describe('состав списка «Ожидают приёмки»', () => {
  it('собранный без ячейки показан с именем флориста, составом и способом', async () => {
    const order = await seedProductionOrder({
      deliveryMethodId: MOYSKLAD_IDS.deliveryMethodPickup,
    });
    await assembleBy(order.id, 'Флорист Именованный');

    const page = await listAwaitingIntake(ctx.db);
    const card = page.items.find((item) => item.orderNumber === order.number);
    expect(card).toBeDefined();
    expect(card?.floristName).toBe('Флорист Именованный');
    expect(card?.isPickup).toBe(true);
    expect(card?.positionCount).toBe(1);
    expect(card?.startMinute).toBe(600);
    expect(card?.assembledAt).not.toBeNull();
  });

  it('принятый в ячейку из списка уходит, счётчик уменьшается', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedAssembled();
    const cell = await seedCell();

    const before = await listAwaitingIntake(ctx.db);
    expect(before.items.map((item) => item.orderNumber)).toContain(order.number);

    await receiveOrder(flow, keeper, { orderNumber: order.number, cellCode: cell.code }, CONTEXT);

    const after = await listAwaitingIntake(ctx.db);
    expect(after.items.map((item) => item.orderNumber)).not.toContain(order.number);
    expect(after.page.total).toBe(before.page.total - 1);
  });

  it('несобранный заказ в списке не показывается', async () => {
    const order = await seedProductionOrder();
    expect(await awaitingNumbers()).not.toContain(order.number);
  });

  it('отменённый логистом заказ в списке не показывается', async () => {
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const order = await seedAssembled();
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: { cancelledByLogistAt: new Date(), cancelledByLogistById: logist.id },
    });
    expect(await awaitingNumbers()).not.toContain(order.number);
  });

  it('списанный заказ (изъятие WRITE_OFF, нет ячейки) не показывается', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedAssembled();
    const cell = await seedCell();
    await receiveOrder(flow, keeper, { orderNumber: order.number, cellCode: cell.code }, CONTEXT);
    await withdrawOrder(flow, keeper, { orderNumber: order.number, reason: 'WRITE_OFF' }, CONTEXT);
    expect(await awaitingNumbers()).not.toContain(order.number);
  });

  it('возвращённый флористу уходит, а собранный заново — возвращается', async () => {
    const admin = await actorFor(['ADMIN']);
    const order = await seedProductionOrder();
    const florist = await assembleBy(order.id);
    expect(await awaitingNumbers()).toContain(order.number);

    // Возврат в работу доменной функцией: состояние перестаёт быть ASSEMBLED,
    // заказ остаётся у того же флориста в работе.
    await reopenOrder(ctx.db, admin, { orderId: order.id, reason: 'пересборка' }, CONTEXT);
    expect(await awaitingNumbers()).not.toContain(order.number);

    // Тот же флорист собирает заново — заказ снова в списке.
    const reopened = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentProcessVersion: true },
    });
    await assembleOrder(
      ctx.db,
      florist,
      { orderId: order.id, expectedProcessVersion: reopened.fulfillmentProcessVersion },
      CONTEXT,
    );
    expect(await awaitingNumbers()).toContain(order.number);
  });

  it('поиск по части номера без учёта регистра', async () => {
    const order = await seedAssembled();
    const fragment = order.number.slice(-6).toLowerCase();
    expect(await awaitingNumbers(fragment)).toContain(order.number);
    expect(await awaitingNumbers('нет-такого-номера-zzz')).toEqual([]);
  });
});

describe('счётчик вкладки «Ожидают приёмки»', () => {
  it('полный счётчик не зависит от строки поиска', async () => {
    const order = await seedAssembled();

    const full = await listAwaitingIntake(ctx.db);
    // Поиск сужает список и его total, но полный счётчик остаётся прежним:
    // это число всех ожидающих, а не найденных по строке.
    const searched = await listAwaitingIntake(ctx.db, { search: order.number });
    expect(searched.page.total).toBe(1);
    expect(searched.items.map((item) => item.orderNumber)).toEqual([order.number]);
    expect(searched.fullTotal).toBe(full.fullTotal);
    expect(full.fullTotal).toBe(full.page.total);
  });

  it('countOnly отдаёт полное число без списка, тем же условием', async () => {
    const order = await seedAssembled();

    const list = await listAwaitingIntake(ctx.db);
    const count = await listAwaitingIntake(ctx.db, { countOnly: true });
    expect(count.items).toEqual([]);
    // Счётчик и список считает одно бизнес-условие — числа совпадают.
    expect(count.fullTotal).toBe(list.fullTotal);
    expect(count.page.total).toBe(list.page.total);

    // Даже с поиском countOnly отдаёт ПОЛНОЕ число ожидающих, а не найденных.
    const countWithSearch = await listAwaitingIntake(ctx.db, {
      countOnly: true,
      search: order.number,
    });
    expect(countWithSearch.fullTotal).toBe(count.fullTotal);
  });

  it('заказ без способа получения — доставка: счётчики сходятся с полным числом', async () => {
    const tag = unique('NOMETHOD');
    // Заказ БЕЗ deliveryMethodId (NULL) — должен считаться доставкой, а не выпасть
    // из счётчиков третьей группой.
    const noMethod = await seedProductionOrder({
      externalName: `${tag}-d`,
      deliveryMethodId: null,
    });
    await assembleBy(noMethod.id);
    const pickup = await seedProductionOrder({
      externalName: `${tag}-p`,
      deliveryMethodId: MOYSKLAD_IDS.deliveryMethodPickup,
    });
    await assembleBy(pickup.id);

    const page = await listAwaitingIntake(ctx.db, { search: tag });
    // Сумма самовывоза и доставки == полному набору отбора (без «потерянной» группы).
    expect(page.counts.all).toBe(page.counts.delivery + page.counts.pickup);
    expect(page.counts.all).toBe(2);
    expect(page.counts.pickup).toBe(1);
    expect(page.counts.delivery).toBe(1); // NULL-способ учтён в доставке
  });

  it('приёмка уменьшает полный счётчик', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedAssembled();
    const cell = await seedCell();

    const before = await listAwaitingIntake(ctx.db, { countOnly: true });
    await receiveOrder(flow, keeper, { orderNumber: order.number, cellCode: cell.code }, CONTEXT);
    const after = await listAwaitingIntake(ctx.db, { countOnly: true });
    expect(after.fullTotal).toBe(before.fullTotal - 1);
  });
});

/** Освобождает действующее размещение заказа (без активного взамен). */
async function releaseCurrentPlacement(orderId: string, byUserId: string): Promise<void> {
  await ctx.db.orderPlacement.updateMany({
    where: { orderId, releasedAt: null },
    data: {
      releasedAt: new Date(),
      releasedById: byUserId,
      releaseReason: 'WITHDRAWN',
    },
  });
}

describe('текущий круг сборки, а не «нет активного размещения»', () => {
  it('размещённый и затем освобождённый заказ текущего круга не возвращается', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedProductionOrder();
    await assembleBy(order.id);
    const cell = await seedCell();
    await receiveOrder(flow, keeper, { orderNumber: order.number, cellCode: cell.code }, CONTEXT);
    // Размещение освобождается (например, выдан курьеру), но заказ остаётся
    // ASSEMBLED — раньше он тут же возвращался в список. Теперь круг уже был в
    // ячейке, и повторно принимать его нечего.
    await releaseCurrentPlacement(order.id, keeper.userId);
    expect(await awaitingNumbers()).not.toContain(order.number);
  });

  it('новый круг сборки появляется, а после его размещения исчезает', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedProductionOrder();
    await assembleBy(order.id);
    const cell = await seedCell();

    // Круг 1: размещён и освобождён → в списке нет.
    await receiveOrder(flow, keeper, { orderNumber: order.number, cellCode: cell.code }, CONTEXT);
    await releaseCurrentPlacement(order.id, keeper.userId);
    expect(await awaitingNumbers()).not.toContain(order.number);

    // Новый круг сборки (повторная доставка/пересборка увеличивает `assemblyRound`
    // заказа). Историческое размещение прошлого круга приёмке не мешает: у него
    // другой круг — заказ снова ожидает приёмки.
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: { assemblyRound: { increment: 1 } },
    });
    expect(await awaitingNumbers()).toContain(order.number);

    // Разместили новый круг — снова уходит из списка (у размещения тот же круг).
    const cell2 = await seedCell();
    await receiveOrder(flow, keeper, { orderNumber: order.number, cellCode: cell2.code }, CONTEXT);
    expect(await awaitingNumbers()).not.toContain(order.number);
  });
});

describe('сортировка списка', () => {
  it('новые даты выше старых, без даты — в конце', async () => {
    const tag = unique('SORT');
    const oldDay = await seedProductionOrder({
      externalName: `${tag}-old`,
      deliveryDate: toDateColumn('2029-03-05'),
    });
    await assembleBy(oldDay.id);
    const newDay = await seedProductionOrder({
      externalName: `${tag}-new`,
      deliveryDate: toDateColumn('2029-03-20'),
    });
    await assembleBy(newDay.id);
    const noDay = await seedProductionOrder({ externalName: `${tag}-none`, deliveryDate: null });
    await assembleBy(noDay.id);

    const numbers = (await listAwaitingIntake(ctx.db, { search: tag })).items.map(
      (item) => item.orderNumber,
    );
    expect(numbers).toEqual([`${tag}-new`, `${tag}-old`, `${tag}-none`]);
  });

  it('внутри одной даты позднее собранное выше', async () => {
    const tag = unique('SAMEDAY');
    const first = await seedProductionOrder({
      externalName: `${tag}-first`,
      deliveryDate: toDateColumn('2029-03-14'),
    });
    await assembleBy(first.id); // собран раньше
    const second = await seedProductionOrder({
      externalName: `${tag}-second`,
      deliveryDate: toDateColumn('2029-03-14'),
    });
    await assembleBy(second.id); // собран позже

    const numbers = (await listAwaitingIntake(ctx.db, { search: tag })).items.map(
      (item) => item.orderNumber,
    );
    expect(numbers).toEqual([`${tag}-second`, `${tag}-first`]);
  });
});

describe('свыше 500 без молчаливого предела и расхождения счётчиков', () => {
  it('501 ожидающий доступен догрузкой, счётчики совпадают', async () => {
    const tag = unique('BULK');
    const florist = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: 'Массовый сборщик' });
    const COUNT = 501;
    for (let i = 0; i < COUNT; i += 1) {
      const externalId = randomUUID();
      const snapshot = compositionOf(externalId);
      const created = await ctx.db.deliveryOrder.create({
        data: {
          externalId,
          externalName: `${tag}-${i}`,
          externalUpdated: new Date('2029-03-01T00:00:00.000Z'),
          deliveryDate: toDateColumn(DAY),
          intervalKind: 'RANGE',
          intervalStartMinute: 600,
          intervalEndMinute: 840,
          inScope: true,
          fulfillmentInScope: true,
          fulfillmentDescription: snapshot.description,
          fulfillmentCardText: snapshot.cardText,
          fulfillmentSnapshotHash: snapshotHash(snapshot),
          fulfillmentCompositionState: 'READY',
          fulfillmentCompositionSyncedAt: new Date(),
          fulfillmentRevisions: {
            create: {
              externalUpdated: new Date('2029-03-01T00:00:00.000Z'),
              snapshot: snapshot as never,
              snapshotHash: snapshotHash(snapshot),
              changedFields: ['externalId'],
              reason: 'INITIAL_IMPORT',
            },
          },
        },
        select: { id: true, fulfillmentRevisions: { select: { id: true } } },
      });
      await ctx.db.deliveryOrder.update({
        where: { id: created.id },
        data: {
          fulfillmentProcessState: 'ASSEMBLED',
          fulfillmentAssigneeId: florist.id,
          fulfillmentAssignedAt: new Date(),
          fulfillmentAssembledAt: new Date(),
          fulfillmentAssembledById: florist.id,
          fulfillmentAssembledRevisionId: created.fulfillmentRevisions[0]?.id,
        },
      });
    }

    // Счётчик по этому набору — ровно 501, а не молчаливые 500.
    const counted = await listAwaitingIntake(ctx.db, { search: tag, countOnly: true });
    expect(counted.counts.all).toBe(COUNT);

    // Догрузка страницами по 100 отдаёт ВСЕ 501 без потерь и дублей.
    const seen = new Set<string>();
    let offset = 0;
    for (;;) {
      const page = await listAwaitingIntake(ctx.db, { search: tag, limit: 100, offset });
      for (const item of page.items) {
        seen.add(item.orderNumber);
      }
      expect(page.page.total).toBe(COUNT);
      if (!page.page.hasMore) {
        break;
      }
      offset += page.page.limit;
    }
    expect(seen.size).toBe(COUNT);
    // Посев 501 заказа — это 1002 последовательных запроса к БД: под нагрузкой
    // CI дефолтные 5 с не хватает на подготовку, поэтому даём запас. Проверка
    // про счётчики и постраничную догрузку, а не про скорость посева.
  }, 30_000);
});

describe('исходящий статус сборки в МойСклад (change 4)', () => {
  it('доставка → awaiting_shipment, самовывоз → ready_for_pickup в очереди статусов', async () => {
    const delivery = await seedProductionOrder({
      deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery,
    });
    await assembleBy(delivery.id);
    const pickup = await seedProductionOrder({
      deliveryMethodId: MOYSKLAD_IDS.deliveryMethodPickup,
    });
    await assembleBy(pickup.id);

    const dMsg = await ctx.db.outboxMessage.findFirstOrThrow({
      where: {
        topic: 'moysklad.order_state',
        idempotencyKey: { contains: `${delivery.id}:assembled` },
      },
      select: { payload: true },
    });
    expect((dMsg.payload as { target?: string }).target).toBe('awaiting_shipment');

    const pMsg = await ctx.db.outboxMessage.findFirstOrThrow({
      where: {
        topic: 'moysklad.order_state',
        idempotencyKey: { contains: `${pickup.id}:assembled` },
      },
      select: { payload: true },
    });
    expect((pMsg.payload as { target?: string }).target).toBe('ready_for_pickup');
  });
});
