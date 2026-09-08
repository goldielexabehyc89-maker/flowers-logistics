/**
 * Критические проверки: уже выданный покупателю самовывоз не возвращается в
 * работу флориста.
 *
 * Защищаемое свойство: существующий `OrderPickupIssue` — окончательный признак
 * выдачи. Такой заказ отсутствует в свободной очереди/поиске/счётчиках/AUTO, его
 * нельзя взять вручную, вернуть в работу, назначить на пересборку или отправить
 * в карантин «Нет товара»; изменение состава из МоегоСклада не переводит его в
 * NEEDS_REVIEW; открытый по ошибке карантин закрывается без возврата. Признак не
 * зависит от способа выдачи, ячейки, состояния, круга сборки и Flowwow. История
 * и факт выдачи сохраняются, ничего не удаляется.
 *
 * ВЛАДЕНИЕ ДАТАМИ: сентябрь 2029 (см. RESERVED_MONTHS).
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
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { snapshotHash, type FulfillmentSnapshot } from './composition.js';
import { claimOrder, reopenOrder, assignReassembly } from './assembly.js';
import { listDispatchableOrderIds, offerableConstraints, readQueue } from './queue-service.js';
import { quarantineNoFlowers, returnFromQuarantine } from './no-flowers.js';
import { floristDispatchStatus } from './dispatch-florist.js';
import { dispatchFlorists } from './dispatch.js';
import { applyFulfillmentSnapshot } from './service.js';
import { startShift } from './shifts.js';
import { issueToCustomer } from '../pickup/service.js';
import { readFloristDispatchMode, saveFloristDispatchMode } from '../settings/service.js';

let ctx: TestContext;
const CONTEXT = { ip: null, userAgent: null };
const NOW = new Date('2029-09-15T06:00:00.000Z');
const DAY = '2029-09-15';
const OPS = '2029-09-01';
const FLOWWOW = '058cf8c2-36a3-11ed-0a80-09e0001f1c70';
const PICKUP = MOYSKLAD_IDS.deliveryMethodPickup;
const DELIVERY = MOYSKLAD_IDS.deliveryMethodDelivery;

let admin: AuthenticatedActor;

beforeAll(async () => {
  ctx = await createTestContext();
  const adminUser = await seedUser(ctx.db, { roles: ['ADMIN'], fullName: 'Админ выдачи' });
  admin = { userId: adminUser.id, roles: ['ADMIN'], familyId: randomUUID() } as AuthenticatedActor;
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${seq}`;
}

function composition(externalId: string, qty: string): FulfillmentSnapshot {
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
        quantity: qty,
        uomId: null,
        uomName: 'шт',
        characteristicLabel: null,
        components: [],
      },
    ],
  };
}

interface SeedOpts {
  externalStateId?: string | null;
  deliveryMethodId?: string | null;
  salesChannelId?: string | null;
  state?: 'NEW' | 'IN_ASSEMBLY' | 'ASSEMBLED' | 'NEEDS_REVIEW';
  assignee?: string | null;
}

async function seedOrder(
  opts: SeedOpts = {},
): Promise<{ id: string; externalId: string; number: string }> {
  const number = unique('IP');
  const externalId = randomUUID();
  const snap = composition(externalId, '3');
  const state = opts.state ?? 'NEW';
  const assembled = state === 'ASSEMBLED' || state === 'NEEDS_REVIEW';
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId,
      externalName: number,
      externalUpdated: new Date('2029-09-01T00:00:00.000Z'),
      externalStateId: opts.externalStateId ?? null,
      deliveryDate: toDateColumn(DAY),
      intervalKind: 'RANGE',
      intervalStartMinute: 600,
      intervalEndMinute: 840,
      deliveryMethodId: opts.deliveryMethodId === undefined ? PICKUP : opts.deliveryMethodId,
      salesChannelId: opts.salesChannelId ?? null,
      address: null,
      recipient: 'Выдуманный получатель',
      inScope: false,
      fulfillmentInScope: true,
      fulfillmentProcessState: 'NEW',
      fulfillmentDescription: snap.description,
      fulfillmentSnapshotHash: snapshotHash(snap),
      fulfillmentCompositionState: 'READY',
      fulfillmentCompositionSyncedAt: new Date(),
      fulfillmentRevisions: {
        create: {
          externalUpdated: new Date('2029-09-01T00:00:00.000Z'),
          snapshot: snap as never,
          snapshotHash: snapshotHash(snap),
          changedFields: ['externalId', 'description', 'positions'],
          reason: 'INITIAL_IMPORT',
        },
      },
    },
    select: { id: true, fulfillmentRevisions: { select: { id: true } } },
  });
  if (state !== 'NEW') {
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: {
        fulfillmentProcessState: state,
        fulfillmentAssigneeId: opts.assignee ?? admin.userId,
        fulfillmentAssignedAt: new Date(),
        ...(assembled
          ? {
              fulfillmentAssembledAt: new Date(),
              fulfillmentAssembledById: admin.userId,
              fulfillmentAssembledRevisionId: order.fulfillmentRevisions[0]?.id ?? null,
            }
          : {}),
      },
    });
  }
  return { id: order.id, externalId, number };
}

/** Фиксирует выдачу покупателю: создаёт OrderPickupIssue (с ячейкой или без). */
async function issue(orderId: string, withCell: boolean): Promise<void> {
  let cellId: string | null = null;
  if (withCell) {
    const cell = await ctx.db.storageCell.create({
      data: {
        code: unique('C'),
        normalizedCode: unique('C'),
        kind: 'STORAGE',
        createdById: admin.userId,
      },
      select: { id: true },
    });
    cellId = cell.id;
  }
  await ctx.db.orderPickupIssue.create({
    data: { orderId, issuedById: admin.userId, cellId },
  });
}

async function offerableCount(orderId: string): Promise<number> {
  return ctx.db.deliveryOrder.count({
    where: { id: orderId, ...offerableConstraints(OPS, FLOWWOW), fulfillmentProcessState: 'NEW' },
  });
}

async function floristOnShift(name: string): Promise<AuthenticatedActor & { shiftId: string }> {
  const user = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: name });
  const actor = {
    userId: user.id,
    roles: ['FLORIST'],
    familyId: randomUUID(),
  } as AuthenticatedActor;
  await startShift(ctx.db, actor, CONTEXT);
  const shift = await ctx.db.floristShift.findFirstOrThrow({
    where: { activeKey: user.id },
    select: { id: true },
  });
  return Object.assign(actor, { shiftId: shift.id });
}

// --- Очередь / AUTO / поиск / счётчики ---------------------------------------

describe('выданный заказ отсутствует в очереди и AUTO', () => {
  it('доставка, самовывоз (с ячейкой и без), Flowwow — все выданные исключены', async () => {
    const deliveryIssued = await seedOrder({ deliveryMethodId: DELIVERY });
    await issue(deliveryIssued.id, true);
    const pickupNoCell = await seedOrder({ deliveryMethodId: PICKUP });
    await issue(pickupNoCell.id, false);
    const pickupWithCell = await seedOrder({ deliveryMethodId: PICKUP });
    await issue(pickupWithCell.id, true);
    const flowwowIssued = await seedOrder({ deliveryMethodId: DELIVERY, salesChannelId: FLOWWOW });
    await issue(flowwowIssued.id, false);
    const clean = await seedOrder({ deliveryMethodId: DELIVERY });

    const dispatchable = await listDispatchableOrderIds(ctx.db, NOW, OPS, FLOWWOW);
    for (const o of [deliveryIssued, pickupNoCell, pickupWithCell, flowwowIssued]) {
      expect(await offerableCount(o.id)).toBe(0);
      expect(dispatchable).not.toContain(o.id);
    }
    // Обычный невыданный — виден и назначаем.
    expect(await offerableCount(clean.id)).toBe(1);
  });

  it('противоречивое состояние NEW/NEEDS_REVIEW при наличии выдачи — не работа', async () => {
    const asNew = await seedOrder({ deliveryMethodId: PICKUP, state: 'NEW' });
    await issue(asNew.id, false);
    const asReview = await seedOrder({ deliveryMethodId: PICKUP, state: 'NEEDS_REVIEW' });
    await issue(asReview.id, true);

    expect(await offerableCount(asNew.id)).toBe(0);
    expect(await listDispatchableOrderIds(ctx.db, NOW, OPS, FLOWWOW)).not.toContain(asNew.id);
    // NEEDS_REVIEW с выдачей не показывается активной работой во «внимании».
    const review = await ctx.db.deliveryOrder.count({
      where: { id: asReview.id, ...offerableConstraints(OPS, FLOWWOW) },
    });
    expect(review).toBe(0);
  });
});

// --- Операции возврата в работу ----------------------------------------------

describe('операции возврата выданного заказа в работу отклоняются', () => {
  it('ручное взятие → ORDER_ALREADY_ISSUED', async () => {
    const order = await seedOrder({ deliveryMethodId: PICKUP, state: 'NEW' });
    await issue(order.id, false);
    const florist = await floristOnShift('Взятие выданного');
    await expect(claimOrder(ctx.db, florist, order.id, CONTEXT)).rejects.toMatchObject({
      conflict: { kind: 'ORDER_ALREADY_ISSUED' },
    });
  });

  it('возврат собранного в работу → ORDER_ALREADY_ISSUED, заказ не тронут', async () => {
    const order = await seedOrder({ deliveryMethodId: PICKUP, state: 'ASSEMBLED' });
    await issue(order.id, true);
    await expect(
      reopenOrder(ctx.db, admin, { orderId: order.id, reason: 'вернуть в работу' }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_ALREADY_ISSUED' } });
    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentProcessState: true },
    });
    expect(after.fulfillmentProcessState).toBe('ASSEMBLED');
  });

  it('назначение пересборки → ORDER_ALREADY_ISSUED', async () => {
    const order = await seedOrder({ deliveryMethodId: PICKUP, state: 'ASSEMBLED' });
    await issue(order.id, false);
    const florist = await floristOnShift('Пересборка выданного');
    await expect(
      assignReassembly(ctx.db, admin, { orderId: order.id, floristId: florist.userId }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_ALREADY_ISSUED' } });
  });

  it('отказ «Нет товара» на выданном → ORDER_ALREADY_ISSUED', async () => {
    const order = await seedOrder({ deliveryMethodId: PICKUP, state: 'IN_ASSEMBLY' });
    await issue(order.id, false);
    await expect(
      ctx.db.$transaction((tx) =>
        quarantineNoFlowers(
          tx,
          admin,
          { id: order.id, externalName: order.number, assemblyRound: 1 },
          'нет роз',
          CONTEXT,
        ),
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_ALREADY_ISSUED' } });
  });
});

// --- Карантин выданного заказа -----------------------------------------------

describe('открытый карантин выданного заказа', () => {
  /** Создаёт открытый карантин напрямую — воспроизводит ошибочное состояние до фикса. */
  async function openQuarantine(orderId: string): Promise<string> {
    const notification = await ctx.db.orderChangeNotification.create({
      data: {
        orderId,
        source: 'FLORIST',
        categories: [],
        kind: 'NO_FLOWERS_QUARANTINE',
        payload: {},
      },
      select: { id: true },
    });
    const q = await ctx.db.orderNoFlowersQuarantine.create({
      data: {
        orderId,
        floristId: admin.userId,
        assemblyRound: 1,
        reason: 'INSUFFICIENT_GOODS',
        comment: null,
        activeKey: orderId,
        notificationId: notification.id,
      },
      select: { id: true },
    });
    return q.id;
  }

  it('возврат из «Решения» закрывает задачу без возврата в очередь', async () => {
    const order = await seedOrder({ deliveryMethodId: PICKUP, state: 'NEW' });
    await issue(order.id, false);
    const qId = await openQuarantine(order.id);

    const result = await returnFromQuarantine(ctx.db, admin, qId, CONTEXT);
    expect(result.returned).toBe(false);
    expect(result.closedIssued).toBe(true);
    expect(result.closedUnfit).toBe(true);

    // Карантин закрыт, заказ в очередь не вернулся (нет маркера приоритета).
    const q = await ctx.db.orderNoFlowersQuarantine.findUniqueOrThrow({
      where: { id: qId },
      select: { activeKey: true, closedReason: true },
    });
    expect(q.activeKey).toBeNull();
    expect(q.closedReason).toBe('ORDER_ALREADY_ISSUED');
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { dispatchRequeuedAt: true },
    });
    expect(stored.dispatchRequeuedAt).toBeNull();
    // Идемпотентность: повтор ничего не создаёт.
    const again = await returnFromQuarantine(ctx.db, admin, qId, CONTEXT);
    expect(again.alreadyClosed).toBe(true);
  });
});

// --- Синхронизация состава после выдачи --------------------------------------

describe('изменение состава после выдачи', () => {
  it('выданный ASSEMBLED не переводится в NEEDS_REVIEW; невыданный — переводится', async () => {
    const issued = await seedOrder({ deliveryMethodId: PICKUP, state: 'ASSEMBLED' });
    await issue(issued.id, true);
    const notIssued = await seedOrder({ deliveryMethodId: PICKUP, state: 'ASSEMBLED' });

    const apply = (externalId: string) =>
      ctx.db.$transaction((tx) =>
        applyFulfillmentSnapshot(
          tx,
          {
            externalId,
            externalUpdated: new Date('2029-09-02T00:00:00.000Z'),
            texts: { description: 'Букет', cardText: null },
            snapshot: composition(externalId, '5'), // было 3 — состав изменился
            failure: null,
          },
          new Date('2029-09-02T00:00:00.000Z'),
        ),
      );

    await apply(issued.externalId);
    await apply(notIssued.externalId);

    const issuedAfter = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: issued.id },
      select: { fulfillmentProcessState: true },
    });
    const notIssuedAfter = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: notIssued.id },
      select: { fulfillmentProcessState: true },
    });
    expect(issuedAfter.fulfillmentProcessState).toBe('ASSEMBLED');
    expect(notIssuedAfter.fulfillmentProcessState).toBe('NEEDS_REVIEW');
  });
});

// --- Регрессия PR #127: невыданный возврат сохраняет приоритет ----------------

describe('невыданный заказ из карантина сохраняет высший приоритет', () => {
  it('обычный возврат из «Решения» ставит маркер приоритета и возвращает заказ', async () => {
    const order = await seedOrder({ deliveryMethodId: PICKUP, state: 'NEW' });
    // Открытый карантин НЕ выданного заказа.
    const notification = await ctx.db.orderChangeNotification.create({
      data: {
        orderId: order.id,
        source: 'FLORIST',
        categories: [],
        kind: 'NO_FLOWERS_QUARANTINE',
        payload: {},
      },
      select: { id: true },
    });
    const q = await ctx.db.orderNoFlowersQuarantine.create({
      data: {
        orderId: order.id,
        floristId: admin.userId,
        assemblyRound: 1,
        reason: 'INSUFFICIENT_GOODS',
        comment: null,
        activeKey: order.id,
        notificationId: notification.id,
      },
      select: { id: true },
    });

    const result = await returnFromQuarantine(ctx.db, admin, q.id, CONTEXT);
    expect(result.returned).toBe(true);
    expect(result.closedIssued).toBe(false);
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { dispatchRequeuedAt: true },
    });
    expect(stored.dispatchRequeuedAt).not.toBeNull();
  });
});

// --- Реальные функции чтения очереди / «Моих заказов» / статуса AUTO ---------

async function setAuto(auto: boolean): Promise<void> {
  const current = await readFloristDispatchMode(ctx.db);
  await saveFloristDispatchMode(ctx.db, admin, {
    value: { auto },
    expectedVersion: current.version,
    ip: null,
    userAgent: null,
  });
}

describe('реальные функции чтения не показывают выданный заказ работой', () => {
  it('readQueue «Мои заказы»: выданный NEEDS_REVIEW не в активной работе, но собранный — в истории', async () => {
    const florist = await floristOnShift('Мои заказы выдачи');
    // Ошибочное состояние: выдан, но по прежней ошибке в NEEDS_REVIEW за флористом.
    const stuck = await seedOrder({
      deliveryMethodId: PICKUP,
      state: 'NEEDS_REVIEW',
      assignee: florist.userId,
    });
    await issue(stuck.id, false);
    // Нормальная история: собран и выдан — остаётся в «Собранных».
    const assembledIssued = await seedOrder({
      deliveryMethodId: PICKUP,
      state: 'ASSEMBLED',
      assignee: florist.userId,
    });
    await issue(assembledIssued.id, true);

    const work = await readQueue(
      ctx.db,
      { userId: florist.userId, roles: ['FLORIST'] },
      {
        day: 'today',
        scope: 'mine',
        group: 'work',
        includeAssigned: false,
        operationsStartDate: OPS,
      },
      NOW,
    );
    expect(work.items.map((i) => i.id)).not.toContain(stuck.id);

    const assembled = await readQueue(
      ctx.db,
      { userId: florist.userId, roles: ['FLORIST'] },
      {
        day: 'today',
        scope: 'mine',
        group: 'assembled',
        includeAssigned: false,
        operationsStartDate: OPS,
      },
      NOW,
    );
    // Собранный выданный заказ сохраняется как история (не пропал).
    expect(assembled.items.map((i) => i.id)).toContain(assembledIssued.id);
    expect(assembled.assembledTotal ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('floristDispatchStatus: выданный NEEDS_REVIEW не показывается активным заданием', async () => {
    const florist = await floristOnShift('AUTO-панель выдачи');
    const stuck = await seedOrder({
      deliveryMethodId: PICKUP,
      state: 'NEEDS_REVIEW',
      assignee: florist.userId,
    });
    await issue(stuck.id, false);

    const status = await floristDispatchStatus(ctx.db, florist, NOW, OPS, FLOWWOW);
    expect(status.activeOrder).toBeNull();
  });

  it('AUTO: флорист с одним лишь выданным заказом считается свободным и получает работу', async () => {
    const florist = await floristOnShift('AUTO занятость выдачи');
    await ctx.db.floristShift.update({
      where: { id: florist.shiftId },
      data: { dispatchReadyAt: new Date('2029-09-15T05:00:00.000Z') },
    });
    // За флористом — только ВЫДАННЫЙ IN_ASSEMBLY (фантом): занятостью быть не должен.
    const phantom = await seedOrder({
      deliveryMethodId: PICKUP,
      state: 'IN_ASSEMBLY',
      assignee: florist.userId,
    });
    await issue(phantom.id, false);
    // Свободный обычный заказ на раздачу.
    const fresh = await seedOrder({ deliveryMethodId: DELIVERY });
    // Изоляция общей базы: остальные свободные заказы выводим из области, чтобы
    // единственным кандидатом раздачи был `fresh` (иначе флорист получил бы
    // чужой NEW-заказ из соседнего теста, и проверка «получил работу» плавала).
    await ctx.db.deliveryOrder.updateMany({
      where: { fulfillmentProcessState: 'NEW', id: { not: fresh.id } },
      data: { inScope: false, fulfillmentInScope: false },
    });

    try {
      await setAuto(true);
      await dispatchFlorists(ctx.db, NOW, OPS, FLOWWOW);
    } finally {
      await setAuto(false);
    }

    const assigned = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: fresh.id },
      select: { fulfillmentAssigneeId: true, fulfillmentProcessState: true },
    });
    expect(assigned.fulfillmentAssigneeId).toBe(florist.userId);
    expect(assigned.fulfillmentProcessState).toBe('IN_ASSEMBLY');
    // Выданный фантом при этом никому не выдавался повторно и остался как был.
    const phantomAfter = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: phantom.id },
      select: { fulfillmentProcessState: true },
    });
    expect(phantomAfter.fulfillmentProcessState).toBe('IN_ASSEMBLY');
  });
});

// --- Конкурентные гонки штатной issueToCustomer с производственными действиями -

describe('гонка выдачи и производственного действия (оба порядка)', () => {
  const pickupDeps = () => ({ db: ctx.db, flowwowChannelId: FLOWWOW });
  const issueReal = (orderNumber: string) =>
    issueToCustomer(pickupDeps(), admin, { orderNumber, source: 'SCAN' }, CONTEXT);

  /** Инвариант: выданный заказ не остаётся доступным к производству. */
  async function assertNotProductionAvailable(orderId: string): Promise<void> {
    expect(await offerableCount(orderId)).toBe(0);
    const dispatchable = await listDispatchableOrderIds(ctx.db, NOW, OPS, FLOWWOW);
    expect(dispatchable).not.toContain(orderId);
    // Завершить сборку выданного нельзя даже при IN_ASSEMBLY.
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { fulfillmentProcessState: true, fulfillmentProcessVersion: true },
    });
    if (stored.fulfillmentProcessState === 'IN_ASSEMBLY') {
      await expect(
        assembleOrderForRace(orderId, stored.fulfillmentProcessVersion),
      ).rejects.toMatchObject({ conflict: { kind: 'ORDER_ALREADY_ISSUED' } });
    }
  }
  async function assembleOrderForRace(orderId: string, version: number): Promise<unknown> {
    const { assembleOrder } = await import('./assembly.js');
    return assembleOrder(
      ctx.db,
      admin,
      { orderId, expectedProcessVersion: version, flowwowChannelId: FLOWWOW },
      CONTEXT,
    );
  }

  it('порядок A (выдача → взятие): взятие отклонено, заказ выдан', async () => {
    const order = await seedOrder({ deliveryMethodId: PICKUP, state: 'NEW' });
    const florist = await floristOnShift('Гонка A');
    await issueReal(order.number);
    await expect(claimOrder(ctx.db, florist, order.id, CONTEXT)).rejects.toMatchObject({
      conflict: { kind: 'ORDER_ALREADY_ISSUED' },
    });
    await assertNotProductionAvailable(order.id);
  });

  it('порядок B (взятие → выдача): выдача проходит, заказ недоступен к сборке', async () => {
    const order = await seedOrder({ deliveryMethodId: PICKUP, state: 'NEW' });
    const florist = await floristOnShift('Гонка B');
    await claimOrder(ctx.db, florist, order.id, CONTEXT);
    await issueReal(order.number);
    await assertNotProductionAvailable(order.id);
  });

  it('порядок B (возврат в работу → выдача): выдача проходит, сборка недоступна', async () => {
    const order = await seedOrder({ deliveryMethodId: PICKUP, state: 'ASSEMBLED' });
    await reopenOrder(ctx.db, admin, { orderId: order.id, reason: 'вернуть до выдачи' }, CONTEXT);
    await issueReal(order.number);
    await assertNotProductionAvailable(order.id);
  });

  it('истинно конкурентно (взятие ∥ выдача): один результат, инвариант сохранён', async () => {
    for (let round = 0; round < 6; round += 1) {
      const order = await seedOrder({ deliveryMethodId: PICKUP, state: 'NEW' });
      const florist = await floristOnShift(`Гонка concurrent ${round}`);
      const [claimRes, issueRes] = await Promise.allSettled([
        claimOrder(ctx.db, florist, order.id, CONTEXT),
        issueReal(order.number),
      ]);
      // Выдача штатной операцией под блокировкой строки не срывается.
      expect(issueRes.status).toBe('fulfilled');
      // Заказ выдан — и в производство как работа не попадает ни при каком исходе взятия.
      expect(await ctx.db.orderPickupIssue.count({ where: { orderId: order.id } })).toBe(1);
      await assertNotProductionAvailable(order.id);
      void claimRes;
    }
  });
});
