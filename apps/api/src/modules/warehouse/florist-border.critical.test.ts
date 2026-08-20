/**
 * Граница двух вертикальных срезов: FLORIST и WAREHOUSE на одном заказе.
 *
 * Каждый срез по отдельности доказан своими файлами. Здесь проверяется то,
 * чего не видит ни один из них: что они не мешают друг другу, работая с одной
 * и той же строкой `DeliveryOrder`.
 *
 * Опасность конкретная. Склад принимает физическую коробку — если приёмка
 * начнёт задевать производственное состояние, флорист увидит чужой статус
 * на собранном заказе. И наоборот: изменение состава после сборки обязано
 * поднимать «Требует проверки», не стирая при этом историю складских операций,
 * иначе коробка окажется «нигде» ровно в тот момент, когда её место важнее
 * всего.
 *
 * Второй готовности здесь не заводится: складская приёмка — факт места, а не
 * ещё один производственный статус.
 *
 * ВЛАДЕНИЕ ДАТАМИ: май 2027 года, общий с `warehouse-flow.critical.test.ts`.
 */

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
import { snapshotHash, type FulfillmentSnapshot } from '../fulfillment/composition.js';
import { applyFulfillmentSnapshot } from '../fulfillment/service.js';
import { assembleOrder, claimOrder } from '../fulfillment/assembly.js';
import { startShift } from '../fulfillment/shifts.js';
import { readOrderCard } from '../fulfillment/card.js';
import { createStorageCell, unknownOccupancy, type CellDeps } from './service.js';
import { receiveOrder, type FlowDeps } from './placement.js';
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

/** День внутри месяца, которым владеют складские файлы. */
const DAY = '2027-05-18';

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
  return {
    userId: user.id,
    roles,
    familyId: '00000000-0000-4000-8000-000000000064',
    fullName: 'Тестовый пользователь',
    phone: user.phone,
  } as AuthenticatedActor;
}

function compositionOf(externalId: string, roses: string): FulfillmentSnapshot {
  return {
    externalId,
    description: 'Нижний комментарий заказа',
    cardText: 'С праздником!',
    positions: [
      {
        externalPositionId: '00000000-0000-4000-8000-000000000101',
        ordinal: 0,
        assortmentId: '00000000-0000-4000-8000-000000000102',
        assortmentKind: 'BUNDLE',
        assortmentKindRaw: 'bundle',
        name: 'Букет «Май»',
        quantity: '1',
        characteristicLabel: null,
        components: [
          {
            externalComponentId: '00000000-0000-4000-8000-000000000103',
            ordinal: 0,
            assortmentId: '00000000-0000-4000-8000-000000000104',
            assortmentKind: 'PRODUCT',
            assortmentKindRaw: 'product',
            name: 'Роза красная',
            quantity: roses,
          },
        ],
      },
    ],
  };
}

/** Производственный заказ с подтверждённым составом: то, что видит флорист. */
async function seedProductionOrder(): Promise<{
  id: string;
  number: string;
  externalId: string;
}> {
  const number = unique('BRD');
  const externalId = crypto.randomUUID();
  const snapshot = compositionOf(externalId, '11');

  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId,
      externalName: number,
      externalUpdated: new Date('2027-05-01T00:00:00.000Z'),
      deliveryDate: toDateColumn(DAY),
      intervalKind: 'RANGE',
      intervalStartMinute: 600,
      intervalEndMinute: 840,
      address: 'Москва, проверочный адрес границы',
      recipient: 'Проверочный Получатель',
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
          components: {
            create: position.components.map((component) => ({
              externalComponentId: component.externalComponentId,
              ordinal: component.ordinal,
              assortmentId: component.assortmentId,
              assortmentKind: component.assortmentKind,
              assortmentKindRaw: component.assortmentKindRaw,
              name: component.name,
              quantity: component.quantity,
            })),
          },
        })),
      },
      fulfillmentRevisions: {
        create: {
          externalUpdated: new Date('2027-05-01T00:00:00.000Z'),
          snapshot: snapshot as never,
          snapshotHash: snapshotHash(snapshot),
          changedFields: ['externalId', 'description', 'cardText', 'positions'],
          reason: 'INITIAL_IMPORT',
        },
      },
    },
    select: { id: true, externalName: true },
  });

  return { id: order.id, number: order.externalName, externalId };
}

async function assembleBy(orderId: string): Promise<AuthenticatedActor> {
  const florist = await actorFor(['FLORIST']);
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

/** Производственное состояние заказа целиком: срез «до» и «после». */
async function productionStateOf(orderId: string): Promise<Record<string, unknown>> {
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      fulfillmentProcessState: true,
      fulfillmentProcessVersion: true,
      fulfillmentAssigneeId: true,
      fulfillmentAssignedAt: true,
      fulfillmentShiftId: true,
      fulfillmentAssembledAt: true,
      fulfillmentAssembledById: true,
      fulfillmentAssembledRevisionId: true,
      fulfillmentCompositionState: true,
      fulfillmentSnapshotHash: true,
    },
  });
  const printForms = await ctx.db.orderPrintForm.count({ where: { orderId } });
  const printJobs = await ctx.db.orderPrintJob.count({ where: { orderId } });
  const revisions = await ctx.db.orderFulfillmentRevision.count({ where: { orderId } });

  return { ...order, printForms, printJobs, revisions };
}

/** Тот же заказ, но состав в МоёмСкладе изменился. */
async function changeComposition(
  externalId: string,
  roses: string,
  externalUpdated: string,
): Promise<void> {
  const snapshot = compositionOf(externalId, roses);
  await ctx.db.$transaction(async (tx) => {
    await applyFulfillmentSnapshot(
      tx,
      {
        externalId,
        externalUpdated: new Date(externalUpdated),
        texts: { description: snapshot.description, cardText: snapshot.cardText },
        snapshot,
        failure: null,
      },
      new Date(externalUpdated),
    );
  });
}

describe('склад и флорист на одном заказе', () => {
  it('весь складской путь не трогает ни одного производственного поля', async () => {
    const order = await seedProductionOrder();
    await assembleBy(order.id);

    const before = await productionStateOf(order.id);
    expect(before['fulfillmentProcessState']).toBe('ASSEMBLED');
    expect(before['printJobs']).toBe(1);

    const admin = await actorFor(['ADMIN']);
    const keeper = await actorFor(['WAREHOUSE']);
    const storage = await createStorageCell(
      cells,
      admin,
      { code: unique('S'), kind: 'STORAGE' },
      CONTEXT,
    );
    const routeCell = await createStorageCell(
      cells,
      admin,
      { code: unique('R'), kind: 'ROUTE' },
      CONTEXT,
    );

    // Приёмка собранного заказа.
    const received = await receiveOrder(
      flow,
      keeper,
      { orderNumber: order.number, cellCode: storage.code },
      CONTEXT,
    );
    expect(received.unchanged).toBe(false);

    // Комплектование и выдача по подтверждённому маршруту.
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
    const route = await ctx.db.deliveryRoute.create({
      data: {
        number: unique('BR'),
        deliveryDate: toDateColumn(DAY),
        state: 'CONFIRMED',
        vehicleType: 'CAR',
        createdById: admin.userId,
        courierUserId: courier.id,
      },
      select: { id: true },
    });
    await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId: order.id, position: 1, addedById: admin.userId },
    });

    await bindRouteCell(flow, keeper, route.id, { cellCode: routeCell.code }, CONTEXT);
    await pickOrderToRouteCell(
      flow,
      keeper,
      route.id,
      { orderNumber: order.number, cellCode: routeCell.code },
      CONTEXT,
    );
    await confirmCourier(flow, keeper, route.id, { courierUserId: courier.id }, CONTEXT);
    // Лист вносится в проверку и отгружается целиком: поштучной выдачи нет.
    await checkOrderForIssue(flow, keeper, route.id, { orderNumber: order.number }, CONTEXT);
    const shipped = await shipRoute(flow, keeper, route.id, CONTEXT);
    expect(shipped.issued).toBe(1);

    // Ни одно производственное поле не сдвинулось: ни статус, ни версия
    // процесса, ни исполнитель, ни бланк, ни задание печати, ни ревизии.
    expect(await productionStateOf(order.id)).toEqual(before);
  });

  it('карточка флориста не знает о складе, а склад — о сборке', async () => {
    const order = await seedProductionOrder();
    await assembleBy(order.id);
    const admin = await actorFor(['ADMIN']);
    const keeper = await actorFor(['WAREHOUSE']);

    const storage = await createStorageCell(
      cells,
      admin,
      { code: unique('S'), kind: 'STORAGE' },
      CONTEXT,
    );
    await receiveOrder(
      flow,
      keeper,
      { orderNumber: order.number, cellCode: storage.code },
      CONTEXT,
    );

    // В карточке флориста складского места нет: он собирает букет, а не ищет
    // полку, и лишнее поле здесь стало бы вторым источником правды о месте.
    const card = await readOrderCard(ctx.db, order.id);
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain(storage.code);
    expect(serialized.toLowerCase()).not.toContain('placement');
  });

  it('изменение состава после сборки поднимает NEEDS_REVIEW и не стирает складскую историю', async () => {
    const order = await seedProductionOrder();
    await assembleBy(order.id);

    const admin = await actorFor(['ADMIN']);
    const keeper = await actorFor(['WAREHOUSE']);
    const storage = await createStorageCell(
      cells,
      admin,
      { code: unique('S'), kind: 'STORAGE' },
      CONTEXT,
    );
    await receiveOrder(
      flow,
      keeper,
      { orderNumber: order.number, cellCode: storage.code },
      CONTEXT,
    );

    const placedBefore = await ctx.db.orderPlacement.findMany({
      where: { orderId: order.id },
      select: { id: true, cellId: true, releasedAt: true, placedAt: true },
      orderBy: { placedAt: 'asc' },
    });
    expect(placedBefore).toHaveLength(1);

    // Состав изменился в МоёмСкладе уже после «Собран».
    await changeComposition(order.externalId, '15', '2027-05-02T00:00:00.000Z');

    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentProcessState: true },
    });
    expect(after.fulfillmentProcessState).toBe('NEEDS_REVIEW');

    // История склада на месте: коробка не «потерялась» из-за чужого статуса.
    const placedAfter = await ctx.db.orderPlacement.findMany({
      where: { orderId: order.id },
      select: { id: true, cellId: true, releasedAt: true, placedAt: true },
      orderBy: { placedAt: 'asc' },
    });
    expect(placedAfter).toEqual(placedBefore);
  });

  it('заказ в NEEDS_REVIEW склад всё равно принимает: коробка физически приехала', async () => {
    const order = await seedProductionOrder();
    await assembleBy(order.id);
    await changeComposition(order.externalId, '21', '2027-05-03T00:00:00.000Z');

    const admin = await actorFor(['ADMIN']);
    const keeper = await actorFor(['WAREHOUSE']);
    const storage = await createStorageCell(
      cells,
      admin,
      { code: unique('S'), kind: 'STORAGE' },
      CONTEXT,
    );

    const received = await receiveOrder(
      flow,
      keeper,
      { orderNumber: order.number, cellCode: storage.code },
      CONTEXT,
    );

    expect(received.unchanged).toBe(false);
    expect(
      (
        await ctx.db.deliveryOrder.findUniqueOrThrow({
          where: { id: order.id },
          select: { fulfillmentProcessState: true },
        })
      ).fulfillmentProcessState,
    ).toBe('NEEDS_REVIEW');
  });
});
