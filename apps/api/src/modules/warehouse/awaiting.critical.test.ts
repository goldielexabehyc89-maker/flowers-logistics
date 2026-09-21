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
import { issueToCustomer, type PickupDeps } from '../pickup/service.js';
import { cancelIssueSession, checkOrderForIssue, confirmCourier, shipRoute } from './route-flow.js';
import { cancelShipment, shipRouteManually } from '../routing/lifecycle.js';
import { removeFromActiveRoute } from '../routing/service.js';
import { saveManualIssue } from '../settings/service.js';

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

describe('выданный самовывоз уходит из «Ожидают приёмки»', () => {
  it('выдача без ячейки исключает заказ из очереди приёмки (терминальный факт)', async () => {
    const pickup: PickupDeps = { db: ctx.db };
    const manager = await actorFor(['MANAGER']);
    const order = await seedAssembled({ deliveryMethodId: MOYSKLAD_IDS.deliveryMethodPickup });

    // До выдачи — собранный самовывоз без ячейки ждёт приёмки.
    expect(await awaitingNumbers()).toContain(order.number);

    // Выдача без ячейки (скан) — размещения не появляется.
    await issueToCustomer(pickup, manager, { orderNumber: order.number, source: 'SCAN' }, CONTEXT);

    // Существование OrderPickupIssue — терминальный факт: заказ покинул очередь
    // приёмки независимо от assemblyRound и отсутствия размещения.
    expect(await awaitingNumbers()).not.toContain(order.number);
    expect(await ctx.db.orderPlacement.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe('узкая граница «Ожидают приёмки» (PICKUP_WAREHOUSE_QUEUE_DATE_FROM)', () => {
  it('дата раньше границы скрыта, граница/позже видны, без даты остаётся — на всём отборе', async () => {
    const CUTOFF = '2029-03-13';
    // Уникальный префикс номеров изолирует строки в общей базе: и поиск, и
    // счётчик считаются по ВСЕМУ отбору с этим поиском — так проверяется сервер,
    // а не срез страницы (список сортирован по дате и обрезан лимитом).
    const tag = unique('AWCUT');
    const before = await seedAssembled({
      externalName: `${tag}-BEFORE`,
      deliveryDate: toDateColumn('2029-03-11'),
    });
    const onDate = await seedAssembled({
      externalName: `${tag}-ON`,
      deliveryDate: toDateColumn(CUTOFF),
    });
    const after = await seedAssembled({
      externalName: `${tag}-AFTER`,
      deliveryDate: toDateColumn('2029-03-14'),
    });
    const noDate = await seedAssembled({ externalName: `${tag}-NULL`, deliveryDate: null });

    const withCutoff = await listAwaitingIntake(ctx.db, {
      limit: 500,
      queueDateFrom: CUTOFF,
      search: tag,
    });
    const names = withCutoff.items.map((item) => item.orderNumber);
    expect(names).not.toContain(before.number); // 2029-03-11 < граница
    expect(names).toContain(onDate.number); // = граница
    expect(names).toContain(after.number); // позже
    expect(names).toContain(noDate.number); // без даты — не скрывается
    // Счётчик по всему отбору (поиск), а не по странице: скрытая строка не в нём.
    expect(withCutoff.counts.all).toBe(3);

    // Без переменной — прежнее поведение: до-граничная строка возвращается.
    const noCutoff = await listAwaitingIntake(ctx.db, { limit: 500, search: tag });
    expect(noCutoff.items.map((item) => item.orderNumber)).toContain(before.number);
    expect(noCutoff.counts.all).toBe(4);
  });
});

// --- Отгружен курьеру без ячейки ---------------------------------------------

/**
 * Подтверждённый лист с курьером, в котором стоят переданные заказы.
 *
 * Ячеек у заказов нет намеренно: проверяется именно коробка, которую передали
 * курьеру, ни разу не поставив на полку.
 */
async function seedConfirmedRoute(orderIds: string[]): Promise<{
  routeId: string;
  routeNumber: string;
  version: number;
  courier: AuthenticatedActor;
  keeper: AuthenticatedActor;
}> {
  const admin = await actorFor(['ADMIN']);
  const keeper = await actorFor(['WAREHOUSE']);
  const courierUser = await seedUser(ctx.db, { roles: ['COURIER'] });
  const courier = {
    userId: courierUser.id,
    roles: ['COURIER'],
    familyId: randomUUID(),
  } as AuthenticatedActor;

  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('AWR'),
      deliveryDate: toDateColumn(DAY),
      state: 'CONFIRMED',
      vehicleType: 'CAR',
      createdById: admin.userId,
      courierUserId: courier.userId,
    },
    select: { id: true, number: true, version: true },
  });
  let position = 1;
  for (const orderId of orderIds) {
    await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId, position, addedById: admin.userId },
    });
    position += 1;
  }
  return {
    routeId: route.id,
    routeNumber: route.number,
    version: route.version,
    courier,
    keeper,
  };
}

/** Складская отгрузка со сканированием: подтверждение курьера, отметки, выдача. */
async function shipByScanning(
  route: { routeId: string; courier: AuthenticatedActor; keeper: AuthenticatedActor },
  orderNumbers: string[],
): Promise<void> {
  await confirmCourier(
    flow,
    route.keeper,
    route.routeId,
    { courierUserId: route.courier.userId },
    CONTEXT,
  );
  for (const orderNumber of orderNumbers) {
    await checkOrderForIssue(flow, route.keeper, route.routeId, { orderNumber }, CONTEXT);
  }
  await shipRoute(flow, route.keeper, route.routeId, CONTEXT);
}

async function setManualIssue(enabled: boolean): Promise<void> {
  const admin = await actorFor(['ADMIN']);
  const current = await ctx.db.systemSetting.findUnique({
    where: { currentKey: 'routing.manualIssue' },
    select: { version: true, value: true },
  });
  if ((current?.value as { enabled?: boolean } | null)?.enabled === enabled) {
    return;
  }
  await saveManualIssue(ctx.db, admin, {
    value: { enabled },
    expectedVersion: current?.version ?? 0,
    ip: null,
    userAgent: null,
  });
}

/** Курсор ленты событий: идентификатор растёт монотонно. */
async function lastEventId(): Promise<bigint> {
  const row = await ctx.db.realtimeEvent.findFirst({
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  return row?.id ?? 0n;
}

/** Аудитории событий очереди приёмки, опубликованных после курсора. */
async function awaitingEventsFor(cursor: bigint): Promise<string[][]> {
  const events = await ctx.db.realtimeEvent.findMany({
    where: { topic: 'warehouse.awaiting_changed', id: { gt: cursor } },
    select: { audienceRoles: true },
  });
  return events.map((event) => [...event.audienceRoles]);
}

/** Полная картина по одному заказу: список, поиск, счётчики, бейдж. */
async function presence(order: { id: string; number: string }): Promise<{
  listed: boolean;
  found: boolean;
  countedInAll: number;
  fullTotal: number;
}> {
  const page = await listAwaitingIntake(ctx.db, {});
  const search = await listAwaitingIntake(ctx.db, { search: order.number });
  return {
    listed: page.items.some((item) => item.orderId === order.id),
    found: search.items.some((item) => item.orderId === order.id),
    countedInAll: search.counts.all,
    fullTotal: page.fullTotal,
  };
}

describe('отгружен курьеру без ячейки', () => {
  it('до отгрузки виден; скан без отгрузки не скрывает; складская отгрузка скрывает везде', async () => {
    /*
     * Коробку передали курьеру, ни разу не поставив на полку: размещения нет,
     * выдачи покупателю нет — и заказ оставался в «Ожидают приёмки», хотя
     * физически уехал. Факт отгрузки — переход листа в «отгружен».
     */
    const order = await seedAssembled();
    const route = await seedConfirmedRoute([order.id]);

    // 1. Собран, ни разу не размещён, лист ещё не отгружен — виден.
    expect(await presence(order)).toMatchObject({ listed: true, found: true, countedInAll: 1 });
    const before = (await presence(order)).fullTotal;

    // 2. Подтверждение курьера и отметка — это ещё не отгрузка: виден.
    await confirmCourier(
      flow,
      route.keeper,
      route.routeId,
      { courierUserId: route.courier.userId },
      CONTEXT,
    );
    await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: order.number },
      CONTEXT,
    );
    expect(await presence(order)).toMatchObject({ listed: true, found: true, countedInAll: 1 });

    // 3. Завершённая отгрузка: ушёл из списка, поиска и счётчиков — одним условием.
    await shipRoute(flow, route.keeper, route.routeId, CONTEXT);
    const after = await presence(order);
    expect(after).toMatchObject({ listed: false, found: false, countedInAll: 0 });
    expect(after.fullTotal).toBe(before - 1);

    // Размещения так и не появилось: скрыт именно фактом отгрузки.
    expect(await ctx.db.orderPlacement.count({ where: { orderId: order.id } })).toBe(0);

    // 5. Повтор запроса и «перезагрузка» (новый запрос) заказ не возвращают.
    expect(await presence(order)).toMatchObject({ listed: false, found: false });
    const countOnly = await listAwaitingIntake(ctx.db, { countOnly: true });
    expect(countOnly.fullTotal).toBe(after.fullTotal);
  });

  it('ручная отгрузка логистом без ячейки скрывает так же', async () => {
    /*
     * Ручная отгрузка сессии не открывает и отметок не ставит — поэтому одной
     * проверки завершённой сессии было бы недостаточно. Оба пути сходятся
     * к переходу листа в «отгружен», и очередь смотрит на него.
     */
    const order = await seedAssembled();
    const route = await seedConfirmedRoute([order.id]);
    const logist = await actorFor(['LOGISTICIAN']);
    await setManualIssue(true);
    expect(await presence(order)).toMatchObject({ listed: true });

    await shipRouteManually(
      { db: ctx.db },
      logist,
      route.routeId,
      { expectedVersion: route.version },
      CONTEXT,
    );

    expect(await presence(order)).toMatchObject({ listed: false, found: false, countedInAll: 0 });
    expect(await ctx.db.orderPlacement.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('отменённая незавершённая сессия заказ не скрывает', async () => {
    const order = await seedAssembled();
    const route = await seedConfirmedRoute([order.id]);

    await confirmCourier(
      flow,
      route.keeper,
      route.routeId,
      { courierUserId: route.courier.userId },
      CONTEXT,
    );
    await checkOrderForIssue(
      flow,
      route.keeper,
      route.routeId,
      { orderNumber: order.number },
      CONTEXT,
    );
    await cancelIssueSession(
      flow,
      route.keeper,
      route.routeId,
      { reason: 'курьер уехал без листа' },
      CONTEXT,
    );

    // Лист остался неотгруженным — коробка по-прежнему ждёт приёмки.
    expect(await presence(order)).toMatchObject({ listed: true, found: true, countedInAll: 1 });
  });

  it('отмена отгрузки возвращает заказ: факт больше не действует', async () => {
    /*
     * Исключение держится РОВНО пока действует факт отгрузки. Лист вернули в
     * «не отгружен» — коробка снова на складе и снова ждёт приёмки.
     */
    const order = await seedAssembled();
    const route = await seedConfirmedRoute([order.id]);
    await shipByScanning(route, [order.number]);
    expect(await presence(order)).toMatchObject({ listed: false });

    const admin = await actorFor(['ADMIN']);
    const shipped = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: route.routeId },
      select: { version: true },
    });
    const cursor = await lastEventId();
    await cancelShipment(
      { db: ctx.db },
      admin,
      route.routeId,
      { expectedVersion: shipped.version, mode: 'ALL', reason: 'лист не уехал' },
      CONTEXT,
    );

    expect(await presence(order)).toMatchObject({ listed: true, found: true, countedInAll: 1 });

    /*
     * Обратное изменение очереди рассылается тем же ролям, что и отгрузка.
     * Одного `route.updated` мало: управляющий и менеджер выдачи его не
     * получают и до перезагрузки не видели вернувшийся заказ.
     */
    expect(await awaitingEventsFor(cursor)).toEqual(
      expect.arrayContaining([expect.arrayContaining([...AWAITING_INTAKE_ROLES])]),
    );
  });

  it('снятие заказа из отгруженного листа возвращает его в приёмку и рассылает событие очереди', async () => {
    const order = await seedAssembled();
    const route = await seedConfirmedRoute([order.id]);
    await shipByScanning(route, [order.number]);
    expect(await presence(order)).toMatchObject({ listed: false });

    const admin = await actorFor(['ADMIN']);
    const shipped = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: route.routeId },
      select: { version: true },
    });
    const cursor = await lastEventId();
    await removeFromActiveRoute(
      { db: ctx.db },
      admin,
      route.routeId,
      { orderId: order.id, expectedVersion: shipped.version },
      CONTEXT,
    );

    // Участие снято — коробка снова ждёт приёмки, и об этом узнают все роли раздела.
    expect(await presence(order)).toMatchObject({ listed: true, found: true });
    expect(await awaitingEventsFor(cursor)).toEqual(
      expect.arrayContaining([expect.arrayContaining([...AWAITING_INTAKE_ROLES])]),
    );
  });

  it('новый круг сборки после отгрузки появляется в приёмке, прежняя отгрузка не мешает', async () => {
    /*
     * Пересборка участие в листе не снимает — круги разводит сравнение. Без
     * привязки факта отгрузки ко времени сборки текущего круга заказ, собранный
     * заново после отгрузки, не появился бы в приёмке никогда.
     */
    const order = await seedProductionOrder();
    const florist = await assembleBy(order.id);
    const route = await seedConfirmedRoute([order.id]);
    await shipByScanning(route, [order.number]);
    expect(await presence(order)).toMatchObject({ listed: false });

    // Штатный возврат в работу и новая сборка того же заказа.
    const admin = await actorFor(['ADMIN']);
    await reopenOrder(ctx.db, admin, { orderId: order.id, reason: 'пересборка' }, CONTEXT);
    expect(await presence(order)).toMatchObject({ listed: false });
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

    // Лист по-прежнему отгружен, но собрано ПОСЛЕ отгрузки — коробка ждёт приёмки.
    const active = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: route.routeId },
      select: { state: true },
    });
    expect(active.state).toBe('ACTIVE');
    expect(await presence(order)).toMatchObject({ listed: true, found: true, countedInAll: 1 });
  });

  it('снятие из активного маршрута администратором возвращает заказ в приёмку', async () => {
    /*
     * Правило снятия не меняется: участие закрывается, а очередь смотрит на
     * АКТУАЛЬНОЕ участие — прежняя отгрузка на снятый заказ больше не давит.
     */
    const order = await seedAssembled();
    const route = await seedConfirmedRoute([order.id]);
    await shipByScanning(route, [order.number]);
    expect(await presence(order)).toMatchObject({ listed: false });

    const admin = await actorFor(['ADMIN']);
    await ctx.db.routeOrder.updateMany({
      where: { routeId: route.routeId, orderId: order.id, removedAt: null },
      data: {
        removedAt: new Date(),
        removedById: admin.userId,
        removalReason: 'RETURNED_TO_UNASSIGNED',
      },
    });

    expect(await presence(order)).toMatchObject({ listed: true, found: true, countedInAll: 1 });
  });

  it('отгрузка из ячейки и выданный самовывоз работают как прежде', async () => {
    // Из ячейки: скрывает уже размещение текущего круга — отгрузка ничего не ломает.
    const placed = await seedAssembled();
    const keeper = await actorFor(['WAREHOUSE']);
    const cell = await seedCell();
    await receiveOrder(flow, keeper, { orderNumber: placed.number, cellCode: cell.code }, CONTEXT);
    const route = await seedConfirmedRoute([placed.id]);
    await shipByScanning(route, [placed.number]);
    expect(await presence(placed)).toMatchObject({ listed: false, found: false });

    // Самовывоз: выданный покупателю без ячейки исключён терминальным фактом.
    const pickup = await seedAssembled({ deliveryMethodId: MOYSKLAD_IDS.deliveryMethodPickup });
    const manager = await actorFor(['MANAGER']);
    const pickups: PickupDeps = { db: ctx.db };
    await issueToCustomer(
      pickups,
      manager,
      { orderNumber: pickup.number, source: 'SCAN' },
      CONTEXT,
    );
    expect(await presence(pickup)).toMatchObject({ listed: false, found: false });
  });
});
