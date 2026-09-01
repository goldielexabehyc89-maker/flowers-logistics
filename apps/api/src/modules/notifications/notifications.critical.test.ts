/**
 * Критические проверки уведомлений и пересборки.
 *
 * Защищаемое: уведомление создаётся только на реальном изменении и с верным
 * old → new; состав после сборки предлагает пересборку; «Ок» ничего не меняет;
 * назначение создаёт РОВНО одну пересборку выбранному флористу и идемпотентно к
 * гонке; пересборка считается отдельной работой; прочтение персональное.
 *
 * ВЛАДЕНИЕ ДАТАМИ: апрель 2029 (см. RESERVED_MONTHS).
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
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { snapshotHash, type FulfillmentSnapshot } from './../fulfillment/composition.js';
import { startShift } from '../fulfillment/shifts.js';
import { assembleOrder, claimOrder } from '../fulfillment/assembly.js';
import { buildFloristStatistics } from '../fulfillment/statistics.js';
import { recordOrderChangeNotification, NOTIFICATION_AUDIENCE } from './change-notify.js';
import {
  NOTIFICATION_ROLES as ROLES,
  countUnread,
  decideReassembly,
  listNotifications,
  markRead,
} from './service.js';

let ctx: TestContext;
const CONTEXT = { ip: null, userAgent: null };
const DAY = '2029-04-12';

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await closeTestContext(ctx);
});

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${seq}`;
}

function composition(externalId: string, quantity = '3'): FulfillmentSnapshot {
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
        quantity,
        uomId: null,
        uomName: 'шт',
        characteristicLabel: null,
        components: [],
      },
    ],
  };
}

async function seedOrder(): Promise<{ id: string; number: string; externalId: string }> {
  const number = unique('NF');
  const externalId = randomUUID();
  const snap = composition(externalId);
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId,
      externalName: number,
      externalUpdated: new Date('2029-04-01T00:00:00.000Z'),
      deliveryDate: toDateColumn(DAY),
      intervalKind: 'RANGE',
      intervalStartMinute: 600,
      intervalEndMinute: 840,
      inScope: true,
      fulfillmentInScope: true,
      fulfillmentDescription: snap.description,
      fulfillmentCardText: snap.cardText,
      fulfillmentSnapshotHash: snapshotHash(snap),
      fulfillmentCompositionState: 'READY',
      fulfillmentCompositionSyncedAt: new Date(),
      fulfillmentPositions: {
        create: snap.positions.map((p) => ({
          externalPositionId: p.externalPositionId,
          ordinal: p.ordinal,
          assortmentId: p.assortmentId,
          assortmentKind: p.assortmentKind,
          assortmentKindRaw: p.assortmentKindRaw,
          name: p.name,
          quantity: p.quantity,
          characteristicLabel: p.characteristicLabel,
        })),
      },
      fulfillmentRevisions: {
        create: {
          externalUpdated: new Date('2029-04-01T00:00:00.000Z'),
          snapshot: snap as never,
          snapshotHash: snapshotHash(snap),
          changedFields: ['externalId', 'description', 'positions'],
          reason: 'INITIAL_IMPORT',
        },
      },
    },
    select: { id: true },
  });
  return { id: order.id, number, externalId };
}

async function addOrderRevision(
  orderId: string,
  snapshot: Record<string, unknown>,
  at: string,
): Promise<void> {
  await ctx.db.deliveryOrderRevision.create({
    data: {
      orderId,
      externalUpdated: new Date(at),
      receivedAt: new Date(at),
      snapshot: snapshot as never,
      snapshotHash: unique('h'),
      changedFields: [],
      reason: 'EXTERNAL_UPDATE',
    },
  });
}

async function record(input: {
  orderId: string;
  orderOutcome: string;
  orderChangedFields: string[];
  fulfillmentOutcome?: string | null;
}): Promise<string | null> {
  return ctx.db.$transaction((tx) =>
    recordOrderChangeNotification(tx, {
      orderId: input.orderId,
      orderOutcome: input.orderOutcome,
      orderChangedFields: input.orderChangedFields,
      fulfillmentOutcome: input.fulfillmentOutcome ?? null,
    }),
  );
}

async function floristOnShift(name: string): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: name });
  const actor = {
    userId: user.id,
    roles: ['FLORIST'],
    familyId: randomUUID(),
  } as AuthenticatedActor;
  await startShift(ctx.db, actor, CONTEXT);
  return actor;
}

async function logist(): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
  return { userId: user.id, roles: ['LOGISTICIAN'], familyId: randomUUID() } as AuthenticatedActor;
}

describe('доступ', () => {
  it('вкладка — только логист, управляющий и админ', () => {
    expect([...ROLES].sort()).toEqual(['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'].sort());
    expect([...NOTIFICATION_AUDIENCE].sort()).toEqual(
      ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'].sort(),
    );
    for (const role of ['FLORIST', 'WAREHOUSE', 'COURIER', 'MANAGER']) {
      expect(ROLES).not.toContain(role);
    }
  });
});

describe('создание уведомления', () => {
  it('первый импорт и идентичный снимок не создают уведомления', async () => {
    const order = await seedOrder();
    expect(
      await record({ orderId: order.id, orderOutcome: 'CREATED', orderChangedFields: ['address'] }),
    ).toBeNull();
    expect(
      await record({ orderId: order.id, orderOutcome: 'UNCHANGED', orderChangedFields: [] }),
    ).toBeNull();
  });

  it('смена адреса, даты и интервала — одно уведомление с old → new', async () => {
    const order = await seedOrder();
    await addOrderRevision(
      order.id,
      { address: 'Старый, 1', deliveryDate: '2029-04-12', intervalRaw: '10-14' },
      '2029-04-02T00:00:00.000Z',
    );
    await addOrderRevision(
      order.id,
      { address: 'Новый, 2', deliveryDate: '2029-04-13', intervalRaw: '14-18' },
      '2029-04-03T00:00:00.000Z',
    );

    const id = await record({
      orderId: order.id,
      orderOutcome: 'UPDATED',
      orderChangedFields: ['address', 'deliveryDate', 'intervalRaw'],
    });
    expect(id).not.toBeNull();

    const notif = await ctx.db.orderChangeNotification.findUniqueOrThrow({
      where: { id: id ?? '' },
    });
    expect([...notif.categories].sort()).toEqual(['ADDRESS', 'DATE', 'INTERVAL']);
    expect(notif.kind).toBe('INFO');
    const payload = notif.payload as { fields: { category: string; old: string; new: string }[] };
    const address = payload.fields.find((f) => f.category === 'ADDRESS');
    expect(address).toMatchObject({ old: 'Старый, 1', new: 'Новый, 2' });
  });

  it('состав до сборки — уведомление есть, но БЕЗ предложения пересборки', async () => {
    const order = await seedOrder();
    const next = composition(order.externalId, '9');
    await ctx.db.orderFulfillmentRevision.create({
      data: {
        orderId: order.id,
        externalUpdated: new Date('2029-04-04T00:00:00.000Z'),
        receivedAt: new Date('2029-04-04T00:00:00.000Z'),
        snapshot: next as never,
        snapshotHash: snapshotHash(next),
        reason: 'EXTERNAL_UPDATE',
        changedFields: ['positions'],
      },
    });
    const id = await record({
      orderId: order.id,
      orderOutcome: 'UNCHANGED',
      orderChangedFields: [],
      fulfillmentOutcome: 'CHANGED',
    });
    expect(id).not.toBeNull();
    const notif = await ctx.db.orderChangeNotification.findUniqueOrThrow({
      where: { id: id ?? '' },
    });
    // Заказ не собран (нет печатного бланка) → обычное информирование.
    expect(notif.kind).toBe('INFO');
  });

  it('состав после сборки — COMPOSITION_AFTER_ASSEMBLY', async () => {
    const order = await seedOrder();
    const florist = await floristOnShift('Флорист Первый');
    const claimed = await claimOrder(ctx.db, florist, order.id, CONTEXT);
    await assembleOrder(
      ctx.db,
      florist,
      { orderId: order.id, expectedProcessVersion: claimed.processVersion },
      CONTEXT,
    );

    // Новая ревизия состава: количество изменилось.
    const next = composition(order.externalId, '9');
    await ctx.db.orderFulfillmentRevision.create({
      data: {
        orderId: order.id,
        externalUpdated: new Date('2029-04-05T00:00:00.000Z'),
        receivedAt: new Date('2029-04-05T00:00:00.000Z'),
        snapshot: next as never,
        snapshotHash: snapshotHash(next),
        reason: 'EXTERNAL_UPDATE',
        changedFields: ['positions'],
      },
    });

    const id = await record({
      orderId: order.id,
      orderOutcome: 'UNCHANGED',
      orderChangedFields: [],
      fulfillmentOutcome: 'CHANGED',
    });
    expect(id).not.toBeNull();
    const notif = await ctx.db.orderChangeNotification.findUniqueOrThrow({
      where: { id: id ?? '' },
    });
    expect(notif.kind).toBe('COMPOSITION_AFTER_ASSEMBLY');
    expect(notif.categories).toContain('COMPOSITION');
  });
});

describe('прочтение персональное', () => {
  it('прочтение одним логистом не скрывает уведомление у другого', async () => {
    const order = await seedOrder();
    await addOrderRevision(order.id, { address: 'A1' }, '2029-04-02T00:00:00.000Z');
    await addOrderRevision(order.id, { address: 'A2' }, '2029-04-03T00:00:00.000Z');
    const id = await record({
      orderId: order.id,
      orderOutcome: 'UPDATED',
      orderChangedFields: ['address'],
    });
    expect(id).not.toBeNull();

    const a = await logist();
    const b = await logist();
    const beforeA = await countUnread(ctx.db, a.userId);
    await markRead(ctx.db, a, id ?? '');
    expect(await countUnread(ctx.db, a.userId)).toBe(beforeA - 1);
    // У второго логиста счётчик не уменьшился этим прочтением.
    const listB = await listNotifications(ctx.db, { userId: b.userId });
    const rowB = listB.items.find((item) => item.id === id);
    expect(rowB?.read).toBe(false);
    const rowA = (await listNotifications(ctx.db, { userId: a.userId })).items.find(
      (i) => i.id === id,
    );
    expect(rowA?.read).toBe(true);
  });
});

describe('пересборка', () => {
  async function assembledOrderWithNotification(): Promise<{
    orderId: string;
    notificationId: string;
  }> {
    const order = await seedOrder();
    const florist = await floristOnShift('Флорист Сборщик');
    const claimed = await claimOrder(ctx.db, florist, order.id, CONTEXT);
    await assembleOrder(
      ctx.db,
      florist,
      { orderId: order.id, expectedProcessVersion: claimed.processVersion },
      CONTEXT,
    );
    const next = composition(order.externalId, '7');
    await ctx.db.orderFulfillmentRevision.create({
      data: {
        orderId: order.id,
        externalUpdated: new Date('2029-04-06T00:00:00.000Z'),
        receivedAt: new Date('2029-04-06T00:00:00.000Z'),
        snapshot: next as never,
        snapshotHash: snapshotHash(next),
        reason: 'EXTERNAL_UPDATE',
        changedFields: ['positions'],
      },
    });
    const notificationId = await record({
      orderId: order.id,
      orderOutcome: 'UNCHANGED',
      orderChangedFields: [],
      fulfillmentOutcome: 'CHANGED',
    });
    return { orderId: order.id, notificationId: notificationId ?? '' };
  }

  it('назначает ровно одну пересборку выбранному флористу; «Ок» не трогает заказ', async () => {
    const { orderId, notificationId } = await assembledOrderWithNotification();
    const before = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { assemblyRound: true, fulfillmentProcessState: true },
    });
    expect(before.fulfillmentProcessState).toBe('ASSEMBLED');

    // «Ок» (прочтение) не меняет состояние заказа.
    const reader = await logist();
    await markRead(ctx.db, reader, notificationId);
    const afterOk = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { assemblyRound: true, fulfillmentProcessState: true },
    });
    expect(afterOk).toEqual(before);

    const target = await floristOnShift('Флорист Пересборщик');
    const decider = await logist();
    const decision = await decideReassembly(
      ctx.db,
      decider,
      { notificationId, floristId: target.userId },
      CONTEXT,
    );
    expect(decision.created).toBe(true);
    expect(decision.assignedFloristId).toBe(target.userId);

    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { assemblyRound: true, fulfillmentProcessState: true, fulfillmentAssigneeId: true },
    });
    expect(after.assemblyRound).toBe(before.assemblyRound + 1);
    expect(after.fulfillmentProcessState).toBe('IN_ASSEMBLY');
    expect(after.fulfillmentAssigneeId).toBe(target.userId);

    // Ровно одна запись решения.
    expect(await ctx.db.orderReassemblyDecision.count({ where: { notificationId } })).toBe(1);
  });

  it('повторное решение идемпотентно: та же пересборка, без дубля', async () => {
    const { notificationId } = await assembledOrderWithNotification();
    const target = await floristOnShift('Флорист Повтор');
    const decider = await logist();
    const first = await decideReassembly(
      ctx.db,
      decider,
      { notificationId, floristId: target.userId },
      CONTEXT,
    );
    const second = await decideReassembly(
      ctx.db,
      decider,
      { notificationId, floristId: target.userId },
      CONTEXT,
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.assignedFloristId).toBe(first.assignedFloristId);
    expect(await ctx.db.orderReassemblyDecision.count({ where: { notificationId } })).toBe(1);
  });

  it('пересборка считается отдельной выполненной работой (+1 в статистике)', async () => {
    const { orderId, notificationId } = await assembledOrderWithNotification();
    const target = await floristOnShift('Флорист Статы');
    const decider = await logist();
    await decideReassembly(ctx.db, decider, { notificationId, floristId: target.userId }, CONTEXT);

    // Флорист собирает пересборку (новый круг).
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { fulfillmentProcessVersion: true },
    });
    const result = await assembleOrder(
      ctx.db,
      target,
      { orderId, expectedProcessVersion: order.fulfillmentProcessVersion },
      CONTEXT,
    );
    expect(result.printFormId).not.toBeNull();

    // Смены и аудиты сборки пишутся реальным временем, поэтому окно статистики
    // — сегодняшний московский день, а не день доставки заказа.
    const today = moscowToday();
    const stats = await buildFloristStatistics(ctx.db, { from: today, to: today });
    const row = stats.rows.find((r) => r.floristId === target.userId);
    expect(row).toBeDefined();
    expect(row?.uniqueAssembledCount).toBe(1);
    expect(row?.reassemblyCount).toBe(1);
  });
});
