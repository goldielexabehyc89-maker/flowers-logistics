/**
 * Критические проверки исключения статуса «Новый» из рабочих очередей.
 *
 * Защищаемое свойство: заказ в статусе источника «Новый» не попадает НИ В ОДНУ
 * очередь новой операционной работы — ни во «Сделки», ни во флористскую очередь
 * (список, поиск, счётчики, ручное взятие, AUTO), ни в «Ожидают выдачи», ни в
 * «Ожидают приёмки». Исключение действует независимо от способа получения,
 * канала, Flowwow, операционного самовывоза и оплаты. Смена статуса на
 * допустимый возвращает заказ; отсутствие переменной сохраняет прежнее
 * поведение; отменённые/архивные этим фильтром не воскресают.
 *
 * ВЛАДЕНИЕ ДАТАМИ: август 2029 (см. RESERVED_MONTHS).
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
import { snapshotHash, type FulfillmentSnapshot } from '../fulfillment/composition.js';
import { startShift } from '../fulfillment/shifts.js';
import { claimOrder } from '../fulfillment/assembly.js';
import { listDispatchableOrderIds, readQueue } from '../fulfillment/queue-service.js';
import { listPickupQueue } from '../pickup/views.js';
import { listAwaitingIntake } from '../warehouse/awaiting.js';
import { dealsIds, dealsCount } from './deals-scope.js';
import { excludeNewStateSql, excludeNewStateWhere, isNewState } from './new-state.js';
import { Prisma } from '../../generated/prisma/client.js';

let ctx: TestContext;
const CONTEXT = { ip: null, userAgent: null };

/** Полдень августа 2029 по Москве: заказы этого дня — «сегодня» для очередей. */
const NOW = new Date('2029-08-15T06:00:00.000Z');
const DAY = '2029-08-15';
const OPS = '2029-08-01';

/** Синтетические UUID: сопоставление идёт по идентификатору, значение не важно. */
const NEW_STATE = '4553382b-2ea3-11ed-0a80-09c5000d6021';
const ALLOWED_STATE = '8469afed-4dff-11ed-0a80-023800307bee';
const FLOWWOW = '058cf8c2-36a3-11ed-0a80-09e0001f1c70';
const PICKUP = MOYSKLAD_IDS.deliveryMethodPickup;
const DELIVERY = MOYSKLAD_IDS.deliveryMethodDelivery;

let admin: AuthenticatedActor;

beforeAll(async () => {
  ctx = await createTestContext();
  const adminUser = await seedUser(ctx.db, { roles: ['ADMIN'], fullName: 'Админ статуса Новый' });
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

function composition(externalId: string): FulfillmentSnapshot {
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
        quantity: '3',
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
  /** Собран: для очереди «Ожидают приёмки». */
  assembled?: boolean;
  /** Логистическая область: для «Сделок». По умолчанию — как у доставки. */
  inScope?: boolean;
  cancelled?: boolean;
  archived?: boolean;
}

async function seedOrder(opts: SeedOpts = {}): Promise<{ id: string; number: string }> {
  const number = unique('NS');
  const externalId = randomUUID();
  const snap = composition(externalId);
  const method = opts.deliveryMethodId === undefined ? DELIVERY : opts.deliveryMethodId;
  // Самовывоз в логистическую область не входит; доставка — входит.
  const inScope = opts.inScope ?? method !== PICKUP;
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId,
      externalName: number,
      externalUpdated: new Date('2029-08-01T00:00:00.000Z'),
      externalStateId: opts.externalStateId === undefined ? ALLOWED_STATE : opts.externalStateId,
      externalStateName: 'состояние',
      deliveryDate: toDateColumn(DAY),
      intervalKind: 'RANGE',
      intervalStartMinute: 600,
      intervalEndMinute: 840,
      deliveryMethodId: method,
      salesChannelId: opts.salesChannelId ?? null,
      address: method === PICKUP ? null : 'Москва, выдуманная улица, 1',
      recipient: 'Выдуманный получатель',
      inScope,
      // geoState вне RESOLVED: точка не нужна (проверяем group ALL), а
      // constraint запрещает RESOLVED без полного набора гео-полей.
      geoState: 'PENDING',
      needsAttention: false,
      sourceArchived: opts.archived ?? false,
      cancelledInSource: opts.cancelled ?? false,
      cancelledInSourceAt: (opts.cancelled ?? false) ? new Date() : null,
      fulfillmentInScope: true,
      fulfillmentProcessState: 'NEW',
      fulfillmentDescription: snap.description,
      fulfillmentCardText: snap.cardText,
      fulfillmentSnapshotHash: snapshotHash(snap),
      fulfillmentCompositionState: 'READY',
      fulfillmentCompositionSyncedAt: new Date(),
      fulfillmentRevisions: {
        create: {
          externalUpdated: new Date('2029-08-01T00:00:00.000Z'),
          snapshot: snap as never,
          snapshotHash: snapshotHash(snap),
          changedFields: ['externalId', 'description', 'positions'],
          reason: 'INITIAL_IMPORT',
        },
      },
    },
    select: { id: true, fulfillmentRevisions: { select: { id: true } } },
  });
  if (opts.assembled ?? false) {
    // Собранное состояние ставится отдельным обновлением: ссылка на ревизию
    // сборки известна только после создания, а constraint требует её вместе
    // с исполнителем и временем.
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: {
        fulfillmentProcessState: 'ASSEMBLED',
        fulfillmentAssigneeId: admin.userId,
        fulfillmentAssignedAt: new Date(),
        fulfillmentAssembledAt: new Date(),
        fulfillmentAssembledById: admin.userId,
        fulfillmentAssembledRevisionId: order.fulfillmentRevisions[0]?.id ?? null,
      },
    });
  }
  return { id: order.id, number };
}

/** Свободная очередь флориста (список идентификаторов «сегодня»). */
async function floristQueueIds(newStateId: string | null | undefined): Promise<Set<string>> {
  const result = await readQueue(
    ctx.db,
    { userId: admin.userId, roles: ['ADMIN'] },
    {
      day: 'today',
      scope: 'general',
      includeAssigned: false,
      operationsStartDate: OPS,
      flowwowChannelId: FLOWWOW,
      newStateId,
    },
    NOW,
  );
  return new Set(result.items.map((item) => item.id));
}

async function pickupQueueNumbers(newStateId: string | null | undefined): Promise<Set<string>> {
  const page = await listPickupQueue(ctx.db, {
    operationsStartDate: OPS,
    flowwowChannelId: FLOWWOW,
    newStateId,
  });
  return new Set(page.items.map((card) => card.orderNumber));
}

async function awaitingNumbers(newStateId: string | null | undefined): Promise<Set<string>> {
  const result = await listAwaitingIntake(ctx.db, {
    flowwowChannelId: FLOWWOW,
    newStateId,
  });
  return new Set(result.items.map((item) => item.orderNumber));
}

async function dealsRoutableIds(newStateId: string | null | undefined): Promise<Set<string>> {
  const ids = await dealsIds(ctx.db, {
    deliveryDate: DAY,
    operationsStartDate: OPS,
    flowwowChannelId: FLOWWOW,
    newStateId,
    group: 'ALL',
  });
  return new Set(ids);
}

// --- Чистый предикат ----------------------------------------------------------

describe('предикат исключения «Новый»', () => {
  it('без переменной — пусто, поведение прежнее', () => {
    expect(excludeNewStateWhere(undefined)).toEqual({});
    expect(excludeNewStateWhere(null)).toEqual({});
    expect(excludeNewStateWhere('')).toEqual({});
    expect(isNewState({ externalStateId: NEW_STATE }, undefined)).toBe(false);
  });

  it('с переменной — исключает ровно заданный статус, NULL оставляет', () => {
    expect(excludeNewStateWhere(NEW_STATE)).toEqual({ externalStateId: { not: NEW_STATE } });
    expect(isNewState({ externalStateId: NEW_STATE }, NEW_STATE)).toBe(true);
    expect(isNewState({ externalStateId: ALLOWED_STATE }, NEW_STATE)).toBe(false);
    expect(isNewState({ externalStateId: null }, NEW_STATE)).toBe(false);
  });

  it('raw-SQL: TRUE без переменной, IS DISTINCT FROM с ней', () => {
    expect(JSON.stringify(excludeNewStateSql(undefined))).toContain('TRUE');
    const sql = excludeNewStateSql(NEW_STATE);
    expect(sql).toBeInstanceOf(Prisma.Sql);
    expect(JSON.stringify(sql)).toContain('IS DISTINCT FROM');
  });
});

// --- Очереди -----------------------------------------------------------------

describe('статус «Новый» исключён из всех рабочих очередей', () => {
  it('доставка «Новый» отсутствует в очереди флориста, «Сделках» и приёмке', async () => {
    const newDelivery = await seedOrder({ externalStateId: NEW_STATE, deliveryMethodId: DELIVERY });
    const okDelivery = await seedOrder({
      externalStateId: ALLOWED_STATE,
      deliveryMethodId: DELIVERY,
    });

    const queue = await floristQueueIds(NEW_STATE);
    expect(queue.has(newDelivery.id)).toBe(false);
    expect(queue.has(okDelivery.id)).toBe(true);

    const deals = await dealsRoutableIds(NEW_STATE);
    expect(deals.has(newDelivery.id)).toBe(false);
    expect(deals.has(okDelivery.id)).toBe(true);
  });

  it('обычный самовывоз «Новый» отсутствует в очереди флориста и «Ожидают выдачи»', async () => {
    const newPickup = await seedOrder({ externalStateId: NEW_STATE, deliveryMethodId: PICKUP });
    const okPickup = await seedOrder({ externalStateId: ALLOWED_STATE, deliveryMethodId: PICKUP });

    const queue = await floristQueueIds(NEW_STATE);
    expect(queue.has(newPickup.id)).toBe(false);
    expect(queue.has(okPickup.id)).toBe(true);

    const pickup = await pickupQueueNumbers(NEW_STATE);
    expect(pickup.has(newPickup.number)).toBe(false);
    expect(pickup.has(okPickup.number)).toBe(true);
  });

  it('Flowwow «Новый» не возвращается правилом операционного самовывоза', async () => {
    // Flowwow приходит способом «Доставка», но обслуживается как самовывоз.
    const newFlowwow = await seedOrder({
      externalStateId: NEW_STATE,
      deliveryMethodId: DELIVERY,
      salesChannelId: FLOWWOW,
    });
    const okFlowwow = await seedOrder({
      externalStateId: ALLOWED_STATE,
      deliveryMethodId: DELIVERY,
      salesChannelId: FLOWWOW,
    });

    const queue = await floristQueueIds(NEW_STATE);
    expect(queue.has(newFlowwow.id)).toBe(false);
    expect(queue.has(okFlowwow.id)).toBe(true);

    const pickup = await pickupQueueNumbers(NEW_STATE);
    expect(pickup.has(newFlowwow.number)).toBe(false);
    expect(pickup.has(okFlowwow.number)).toBe(true);
  });

  it('собранный «Новый» отсутствует в «Ожидают приёмки»', async () => {
    const newAssembled = await seedOrder({
      externalStateId: NEW_STATE,
      deliveryMethodId: DELIVERY,
      assembled: true,
    });
    const okAssembled = await seedOrder({
      externalStateId: ALLOWED_STATE,
      deliveryMethodId: DELIVERY,
      assembled: true,
    });

    const awaiting = await awaitingNumbers(NEW_STATE);
    expect(awaiting.has(newAssembled.number)).toBe(false);
    expect(awaiting.has(okAssembled.number)).toBe(true);
  });
});

describe('поиск, счётчики, ручное взятие и AUTO', () => {
  it('поиск руководителя не находит свободный «Новый»', async () => {
    const newDelivery = await seedOrder({ externalStateId: NEW_STATE, deliveryMethodId: DELIVERY });

    const result = await readQueue(
      ctx.db,
      { userId: admin.userId, roles: ['ADMIN'] },
      {
        day: 'today',
        scope: 'general',
        includeAssigned: true,
        search: newDelivery.number,
        operationsStartDate: OPS,
        flowwowChannelId: FLOWWOW,
        newStateId: NEW_STATE,
      },
      NOW,
    );
    expect(result.items.map((item) => item.id)).not.toContain(newDelivery.id);
  });

  it('счётчик «Сделок» и очередь не учитывают «Новый»', async () => {
    const before = await dealsCount(ctx.db, {
      deliveryDate: DAY,
      operationsStartDate: OPS,
      flowwowChannelId: FLOWWOW,
      newStateId: NEW_STATE,
      group: 'ALL',
    });
    await seedOrder({ externalStateId: NEW_STATE, deliveryMethodId: DELIVERY });
    const after = await dealsCount(ctx.db, {
      deliveryDate: DAY,
      operationsStartDate: OPS,
      flowwowChannelId: FLOWWOW,
      newStateId: NEW_STATE,
      group: 'ALL',
    });
    expect(after).toBe(before);
  });

  it('ручное взятие «Новый» отклоняется', async () => {
    const floristUser = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: 'Флорист статуса' });
    const florist = {
      userId: floristUser.id,
      roles: ['FLORIST'],
      familyId: randomUUID(),
    } as AuthenticatedActor;
    await startShift(ctx.db, florist, CONTEXT);

    const newOrder = await seedOrder({ externalStateId: NEW_STATE, deliveryMethodId: DELIVERY });

    await expect(
      claimOrder(ctx.db, florist, newOrder.id, CONTEXT, NEW_STATE),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_ASSEMBLABLE' } });

    // Заказ не тронут: остался свободным.
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: newOrder.id },
      select: { fulfillmentProcessState: true, fulfillmentAssigneeId: true },
    });
    expect(stored.fulfillmentProcessState).toBe('NEW');
    expect(stored.fulfillmentAssigneeId).toBeNull();
  });

  it('AUTO-кандидаты не включают «Новый»', async () => {
    const newOrder = await seedOrder({ externalStateId: NEW_STATE, deliveryMethodId: DELIVERY });
    const okOrder = await seedOrder({ externalStateId: ALLOWED_STATE, deliveryMethodId: DELIVERY });

    const ids = await listDispatchableOrderIds(ctx.db, NOW, OPS, FLOWWOW, NEW_STATE);
    expect(ids).not.toContain(newOrder.id);
    expect(ids).toContain(okOrder.id);
  });
});

describe('смена статуса, отсутствие переменной и отменённые', () => {
  it('после смены «Новый» → допустимый заказ появляется', async () => {
    const order = await seedOrder({ externalStateId: NEW_STATE, deliveryMethodId: DELIVERY });
    expect((await floristQueueIds(NEW_STATE)).has(order.id)).toBe(false);

    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: { externalStateId: ALLOWED_STATE },
    });
    expect((await floristQueueIds(NEW_STATE)).has(order.id)).toBe(true);
  });

  it('без переменной «Новый» виден как раньше', async () => {
    const order = await seedOrder({ externalStateId: NEW_STATE, deliveryMethodId: DELIVERY });
    // Переменная не задана — исключения нет, поведение прежнее.
    expect((await floristQueueIds(undefined)).has(order.id)).toBe(true);
    expect((await dealsRoutableIds(undefined)).has(order.id)).toBe(true);
  });

  it('отменённые и архивные фильтром «Новый» не воскресают', async () => {
    const cancelled = await seedOrder({
      externalStateId: ALLOWED_STATE,
      deliveryMethodId: DELIVERY,
      cancelled: true,
    });
    const archived = await seedOrder({
      externalStateId: ALLOWED_STATE,
      deliveryMethodId: DELIVERY,
      archived: true,
    });

    const queue = await floristQueueIds(NEW_STATE);
    expect(queue.has(cancelled.id)).toBe(false);
    expect(queue.has(archived.id)).toBe(false);

    const deals = await dealsRoutableIds(NEW_STATE);
    // Отменённый в «Сделках» остаётся виден (его место — внизу списка), архивный — нет.
    expect(deals.has(archived.id)).toBe(false);
  });
});
