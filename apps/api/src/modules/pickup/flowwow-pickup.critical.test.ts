/**
 * Критические проверки: Flowwow как ОПЕРАЦИОННЫЙ самовывоз.
 *
 * Заказы канала Flowwow приходят из МоегоСклада способом получения «Доставка»,
 * но внутри ERP обслуживаются как самовывоз. Опознаётся канал ТОЛЬКО по UUID.
 * Исходный `deliveryMethodId` не переписывается — операционный самовывоз выводит
 * единый предикат {@link isOperationalPickup}. Проверяется, что Flowwow ведёт
 * себя как самовывоз во всех рабочих потоках, но НЕ попадает в «Сделки»/
 * маршрутизацию/курьеров/МКАД, и что обычные доставка и самовывоз не изменились.
 *
 * Месяц 2029-06 забронирован за файлом в реестре тестовых дней.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowToday } from '@fl/shared';
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
import { assembleOrder, claimOrder } from '../fulfillment/assembly.js';
import { startShift } from '../fulfillment/shifts.js';
import { offerableConstraints } from '../fulfillment/queue-service.js';
import { createStorageCell, unknownOccupancy, type CellDeps } from '../warehouse/service.js';
import { receiveOrder, type FlowDeps } from '../warehouse/placement.js';
import { listAwaitingIntake } from '../warehouse/awaiting.js';
import { dealsIds } from '../orders/deals-scope.js';
import { isOperationalPickup } from '../orders/operational-pickup.js';
import { issueToCustomer, isPickupOrder, type PickupDeps } from './service.js';
import { listPickupQueue, listIssuedOfDay } from './views.js';

/** Реальный UUID канала Flowwow (та же константа, что задаётся переменной). */
const FLOWWOW = '058cf8c2-36a3-11ed-0a80-09e0001f1c70';
const DAY = '2029-06-15';
const OPS = '2029-06-01';

let ctx: TestContext;
let flow: FlowDeps;
let cells: CellDeps;
const CONTEXT = { ip: null, userAgent: null };

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

function compositionOf(externalId: string): FulfillmentSnapshot {
  return {
    externalId,
    description: 'Букет',
    cardText: null,
    positions: [
      {
        externalPositionId: randomUUID(),
        ordinal: 0,
        assortmentId: randomUUID(),
        assortmentKind: 'PRODUCT',
        assortmentKindRaw: 'product',
        name: 'Роза',
        quantity: '5',
        characteristicLabel: null,
        components: [],
      },
    ],
  };
}

interface SeedInput {
  deliveryMethodId?: string | null;
  salesChannelId?: string | null;
  externalStateId?: string | null;
  day?: string | null;
  number?: string;
}

/** Производственный заказ с подтверждённым составом (можно собрать). */
async function seedOrder(input: SeedInput = {}): Promise<{ id: string; number: string }> {
  const number = input.number ?? unique('FW');
  const externalId = randomUUID();
  const snapshot = compositionOf(externalId);
  const day = input.day === undefined ? DAY : input.day;
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId,
      externalName: number,
      externalUpdated: new Date('2029-06-01T00:00:00.000Z'),
      deliveryDate: day === null ? null : toDateColumn(day),
      intervalKind: 'RANGE',
      intervalStartMinute: 600,
      intervalEndMinute: 840,
      inScope: true,
      fulfillmentInScope: true,
      deliveryMethodId:
        input.deliveryMethodId === undefined
          ? MOYSKLAD_IDS.deliveryMethodDelivery
          : input.deliveryMethodId,
      salesChannelId: input.salesChannelId ?? null,
      externalStateId: input.externalStateId ?? null,
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
          externalUpdated: new Date('2029-06-01T00:00:00.000Z'),
          snapshot: snapshot as never,
          snapshotHash: snapshotHash(snapshot),
          changedFields: ['externalId', 'description', 'positions'],
          reason: 'INITIAL_IMPORT',
        },
      },
    },
    select: { id: true, externalName: true },
  });
  return { id: order.id, number: order.externalName };
}

/** Flowwow-заказ: способ «Доставка», канал Flowwow. */
async function seedFlowwow(input: SeedInput = {}): Promise<{ id: string; number: string }> {
  return seedOrder({
    ...input,
    deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery,
    salesChannelId: FLOWWOW,
  });
}

async function assembleBy(orderId: string): Promise<void> {
  const user = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: 'Флорист Flowwow' });
  const florist = {
    userId: user.id,
    roles: ['FLORIST'],
    familyId: randomUUID(),
  } as AuthenticatedActor;
  await startShift(ctx.db, florist, CONTEXT);
  const claimed = await claimOrder(ctx.db, florist, orderId, CONTEXT);
  await assembleOrder(
    ctx.db,
    florist,
    { orderId, expectedProcessVersion: claimed.processVersion, flowwowChannelId: FLOWWOW },
    CONTEXT,
  );
}

async function seedCell(): Promise<{ id: string; code: string }> {
  const admin = await actorFor(['ADMIN']);
  const cell = await createStorageCell(
    cells,
    admin,
    { code: unique('S'), kind: 'STORAGE' },
    CONTEXT,
  );
  return { id: cell.id, code: cell.normalizedCode };
}

/** Заказ «пригоден к раздаче» (в очереди/поиске/счётчиках/автораздаче). */
async function offerable(orderId: string, flowwowChannelId: string | undefined): Promise<boolean> {
  const n = await ctx.db.deliveryOrder.count({
    where: {
      id: orderId,
      fulfillmentProcessState: 'NEW',
      ...offerableConstraints(OPS, flowwowChannelId),
    },
  });
  return n === 1;
}

const pickupDeps = (): PickupDeps => ({ db: ctx.db, flowwowChannelId: FLOWWOW });

describe('единый предикат isOperationalPickup', () => {
  it('Flowwow-канал и точный способ-самовывоз — да; обычная доставка — нет', () => {
    expect(
      isOperationalPickup(
        { deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery, salesChannelId: FLOWWOW },
        FLOWWOW,
      ),
    ).toBe(true);
    expect(
      isOperationalPickup(
        { deliveryMethodId: MOYSKLAD_IDS.deliveryMethodPickup, salesChannelId: null },
        FLOWWOW,
      ),
    ).toBe(true);
    expect(
      isOperationalPickup(
        { deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery, salesChannelId: null },
        FLOWWOW,
      ),
    ).toBe(false);
    // Без переменной Flowwow — прежнее поведение (только способ).
    expect(
      isOperationalPickup(
        { deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery, salesChannelId: FLOWWOW },
        undefined,
      ),
    ).toBe(false);
  });

  it('isPickupOrder распространяется на Flowwow', async () => {
    const fw = await seedFlowwow();
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: fw.id },
      select: { deliveryMethodId: true, salesChannelId: true, fulfillmentInScope: true },
    });
    expect(isPickupOrder(order, FLOWWOW)).toBe(true);
  });
});

describe('Flowwow в работе флориста и очередях самовывоза', () => {
  it('Flowwow с исходной «Доставкой» пригоден флористам и собирается как самовывоз', async () => {
    const fw = await seedFlowwow();
    // Пригоден к раздаче (в очереди/поиске/счётчиках/автораздаче).
    expect(await offerable(fw.id, FLOWWOW)).toBe(true);

    await assembleBy(fw.id);

    // После «Собран» намерение статуса — «Готов к самовывозу», а не «Ожидает отправку».
    const msg = await ctx.db.outboxMessage.findFirstOrThrow({
      where: { topic: 'moysklad.order_state', payload: { path: ['orderId'], equals: fw.id } },
      select: { payload: true },
    });
    expect((msg.payload as { target: string }).target).toBe('ready_for_pickup');
  });

  it('Flowwow «Принят, Не оплачен» остаётся доступен, обычная доставка — нет', async () => {
    const fw = await seedFlowwow({ externalStateId: MOYSKLAD_IDS.states.acceptedUnpaid });
    const delivery = await seedOrder({
      deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery,
      externalStateId: MOYSKLAD_IDS.states.acceptedUnpaid,
    });
    expect(await offerable(fw.id, FLOWWOW)).toBe(true); // Flowwow = самовывоз → доступен
    expect(await offerable(delivery.id, FLOWWOW)).toBe(false); // доставка + unpaid → исключён
  });

  it('после сборки Flowwow виден в «Ожидают выдачи» и «Ожидают приёмки» как самовывоз', async () => {
    const fw = await seedFlowwow({ number: unique('FWQ') });
    await assembleBy(fw.id);

    // «Самовывоз → Ожидают выдачи».
    const pickupQueue = await listPickupQueue(ctx.db, {
      limit: 200,
      flowwowChannelId: FLOWWOW,
      search: fw.number,
    });
    expect(pickupQueue.items.map((i) => i.orderNumber)).toContain(fw.number);
    expect(pickupQueue.items[0]?.isPickup).toBe(true);

    // «Склад → Ожидают приёмки» — карточка помечена самовывозом.
    const awaiting = await listAwaitingIntake(ctx.db, {
      limit: 500,
      flowwowChannelId: FLOWWOW,
      search: fw.number,
    });
    const card = awaiting.items.find((i) => i.orderNumber === fw.number);
    expect(card).toBeDefined();
    expect(card?.isPickup).toBe(true);
    expect(awaiting.counts.pickup).toBeGreaterThanOrEqual(1);
  });

  it('Flowwow можно принять в ячейку, затем выдать без ячейки — уходит из обеих очередей', async () => {
    const fw = await seedFlowwow({ number: unique('FWISS') });
    await assembleBy(fw.id);

    // Приёмка в ячейку работает.
    const keeper = await actorFor(['WAREHOUSE']);
    const cell = await seedCell();
    await receiveOrder(flow, keeper, { orderNumber: fw.number, cellCode: cell.code }, CONTEXT);

    // Выдача (кнопкой) — с ячейкой; закрывает размещение.
    const manager = await actorFor(['MANAGER']);
    await issueToCustomer(
      pickupDeps(),
      manager,
      { orderNumber: fw.number, source: 'CARD' },
      CONTEXT,
    );

    // Ушёл из «Ожидают выдачи» и «Ожидают приёмки».
    const pickupQueue = await listPickupQueue(ctx.db, {
      limit: 200,
      flowwowChannelId: FLOWWOW,
      search: fw.number,
    });
    expect(pickupQueue.items.map((i) => i.orderNumber)).not.toContain(fw.number);
    const awaiting = await listAwaitingIntake(ctx.db, {
      limit: 500,
      flowwowChannelId: FLOWWOW,
      search: fw.number,
    });
    expect(awaiting.items.map((i) => i.orderNumber)).not.toContain(fw.number);

    // В «Выданы сегодня» (список по московскому дню ВЫДАЧИ, а не доставки).
    const issued = await listIssuedOfDay(ctx.db, moscowToday(new Date()), FLOWWOW);
    expect(issued.issued.map((i) => i.orderNumber)).toContain(fw.number);
  });

  it('Flowwow без ячейки выдаётся сканом (как самовывоз)', async () => {
    const fw = await seedFlowwow({ number: unique('FWSCAN') }); // ни разу не принят на полку
    const manager = await actorFor(['MANAGER']);
    const result = await issueToCustomer(
      pickupDeps(),
      manager,
      { orderNumber: fw.number, source: 'SCAN' },
      CONTEXT,
    );
    expect(result.cellId).toBeNull();
    expect(await ctx.db.orderPickupIssue.count({ where: { orderId: fw.id } })).toBe(1);
  });
});

describe('Flowwow не идёт в «Сделки»/маршрутизацию/курьеров/МКАД', () => {
  it('Flowwow отсутствует в «Сделках» и не может быть добавлен в маршрут', async () => {
    const fw = await seedFlowwow({ number: unique('FWDEAL') });
    const scope = {
      deliveryDate: DAY,
      operationsStartDate: OPS,
      flowwowChannelId: FLOWWOW,
      group: 'ALL' as const,
    };
    const ids = await dealsIds(ctx.db, scope, { limit: 500, offset: 0 });
    expect(ids).not.toContain(fw.id);
    // Он и не в маршрутах: строк RouteOrder нет — значит ни курьеров, ни mkad.distance.
    expect(await ctx.db.routeOrder.count({ where: { orderId: fw.id } })).toBe(0);
    expect(
      await ctx.db.outboxMessage.count({
        where: { topic: 'mkad.distance', payload: { path: ['routeOrderId'], equals: fw.id } },
      }),
    ).toBe(0);
  });

  it('обычная доставка того же дня в «Сделках» остаётся (Flowwow-условие её не трогает)', async () => {
    const delivery = await seedOrder({
      deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery,
      number: unique('FWDLV'),
    });
    const ids = await dealsIds(
      ctx.db,
      {
        deliveryDate: DAY,
        operationsStartDate: OPS,
        flowwowChannelId: FLOWWOW,
        group: 'ALL' as const,
      },
      { limit: 500, offset: 0 },
    );
    expect(ids).toContain(delivery.id);
  });
});
