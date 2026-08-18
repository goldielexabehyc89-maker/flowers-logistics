/**
 * Критические проверки отмены заказа.
 *
 * Отмена приходит из чужой системы и застаёт заказ на любой стадии: свободным
 * в «Сделках», у флориста, в ячейке, в маршрутном листе, в машине курьера и
 * даже после доставки. Проверяется не «поставился ли флажок», а то, что
 * на каждой стадии отменённый заказ перестаёт двигаться дальше и при этом
 * не исчезает: физический букет остаётся там, где лежит, и его судьбу решает
 * человек.
 *
 * Отдельно проверяется граница с МоимСкладом: наше решение действует сразу,
 * а исходящая отметка живёт своей жизнью и обязана быть видна честно.
 *
 * День подобран так, чтобы не пересекаться с другими файлами набора.
 */

import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../../auth/testing/harness.js';
import type { AuthenticatedActor } from '../../auth/guards.js';
import type { Role } from '@fl/shared';
import { toDateColumn } from './delivery-date.js';
import { applyCancellation, isCancelledInSource, isOtherUnsuccessful } from './cancellation.js';
import { createOrderCancelHandler, enqueueOrderCancel } from './cancel-outbox.js';
import { claimOrder } from '../../fulfillment/assembly.js';
import { blockingFlags, resolveOrderByNumber } from '../../warehouse/order-lookup.js';
import { decideCancel } from '../../returns/service.js';
import { recordDeliveryResult } from '../../delivery/service.js';

let ctx: TestContext;
const logger = pino({ level: 'silent' });
const CONTEXT = { ip: null, userAgent: null };

/** День вне диапазонов остальных файлов набора. */
const DAY = '2027-11-22';

beforeAll(async () => {
  ctx = await createTestContext();
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

async function seedOrder(
  extra: Record<string, unknown> = {},
): Promise<{ id: string; number: string }> {
  const number = unique('CNL');
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: number,
      externalUpdated: new Date(),
      deliveryDate: toDateColumn(DAY),
      inScope: true,
      address: 'синтетический адрес отмены',
      ...extra,
    },
    select: { id: true },
  });
  return { id: order.id, number };
}

async function cancel(orderId: string, cancelled = true): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    const order = await tx.deliveryOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { cancelledInSource: true },
    });
    await applyCancellation(tx, {
      orderId,
      cancelled,
      previous: order.cancelledInSource,
      now: new Date(),
    });
  });
}

async function seedCell(kind: 'STORAGE' | 'ROUTE'): Promise<{ id: string; code: string }> {
  const code = unique(kind === 'STORAGE' ? 'CS' : 'CR').toUpperCase();
  const author = await actorFor(['WAREHOUSE']);
  return ctx.db.storageCell.create({
    data: { code, normalizedCode: code, kind, createdById: author.userId },
    select: { id: true, code: true },
  });
}

// --- Распознавание ------------------------------------------------------------

describe('распознавание отмены', () => {
  it('отменой считается ровно согласованный статус, а не тип «неуспех»', () => {
    const cancelled = { externalStateId: '45533b00-2ea3-11ed-0a80-09c5000d6027' };
    const other = {
      externalStateId: '11111111-2222-3333-4444-555555555555',
      externalStateType: 'Unsuccessful',
    };

    expect(isCancelledInSource(cancelled)).toBe(true);
    expect(isCancelledInSource(other)).toBe(false);
    // Прочий «неуспех» виден отдельно и отменой не притворяется.
    expect(isOtherUnsuccessful(other)).toBe(true);
    expect(isOtherUnsuccessful({ ...cancelled, externalStateType: 'Unsuccessful' })).toBe(false);
  });
});

// --- Стадии -------------------------------------------------------------------

describe('отмена на разных стадиях', () => {
  it('флорист не может взять отменённый заказ в работу', async () => {
    const florist = await actorFor(['FLORIST']);
    const order = await seedOrder({
      fulfillmentInScope: true,
      fulfillmentCompositionState: 'READY',
      fulfillmentSnapshotHash: 'hash',
      fulfillmentCompositionSyncedAt: new Date(),
    });
    await ctx.db.floristShift.create({
      data: { userId: florist.userId, startedAt: new Date(), activeKey: florist.userId },
    });

    await cancel(order.id);

    await expect(
      claimOrder(ctx.db, florist, order.id, { ip: null, userAgent: null }),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_CANCELLED' } });

    // Заказ не тронут: состояние процесса осталось прежним.
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentProcessState: true, fulfillmentAssigneeId: true },
    });
    expect(stored.fulfillmentProcessState).toBe('NEW');
    expect(stored.fulfillmentAssigneeId).toBeNull();
  });

  it('склад видит запрет на комплектование и выдачу', async () => {
    const order = await seedOrder();
    await cancel(order.id);

    const resolved = await resolveOrderByNumber(ctx.db, order.number);
    expect(blockingFlags(resolved)).toContain('CANCELLED');
  });

  it('в маршрутной ячейке появляется требование перемещения, а заказ остаётся на месте', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedOrder();
    const routeCell = await seedCell('ROUTE');
    const placement = await ctx.db.orderPlacement.create({
      data: {
        orderId: order.id,
        cellId: routeCell.id,
        source: 'RECEIVED',
        placedById: keeper.userId,
      },
      select: { id: true },
    });

    await cancel(order.id);

    const stored = await ctx.db.orderPlacement.findUniqueOrThrow({
      where: { id: placement.id },
      select: { requiresRelocation: true, releasedAt: true, cellId: true },
    });
    // Помечен — но не увезён: товар двигают руками.
    expect(stored.requiresRelocation).toBe(true);
    expect(stored.releasedAt).toBeNull();
    expect(stored.cellId).toBe(routeCell.id);
  });

  it('обычная ячейка отмены не двигает вовсе', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedOrder();
    const cell = await seedCell('STORAGE');
    const placement = await ctx.db.orderPlacement.create({
      data: {
        orderId: order.id,
        cellId: cell.id,
        source: 'RECEIVED',
        placedById: keeper.userId,
      },
      select: { id: true },
    });

    await cancel(order.id);

    const stored = await ctx.db.orderPlacement.findUniqueOrThrow({
      where: { id: placement.id },
      select: { requiresRelocation: true, releasedAt: true },
    });
    expect(stored.requiresRelocation).toBe(false);
    expect(stored.releasedAt).toBeNull();
  });
});

// --- Отмена после доставки ----------------------------------------------------

describe('отмена уже доставленного заказа', () => {
  it('ничего не меняет автоматически, но создаёт задачу на коррекцию', async () => {
    const courier = await actorFor(['COURIER']);
    const creator = await actorFor(['ADMIN']);
    const order = await seedOrder();
    const route = await ctx.db.deliveryRoute.create({
      data: {
        number: unique('CRT'),
        deliveryDate: toDateColumn(DAY),
        state: 'ACTIVE',
        vehicleType: 'CAR',
        createdById: creator.userId,
        courierUserId: courier.userId,
      },
      select: { id: true },
    });
    const participation = await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId: order.id, position: 1, addedById: creator.userId },
      select: { id: true },
    });
    await recordDeliveryResult(
      { db: ctx.db },
      courier,
      participation.id,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );

    await cancel(order.id);

    const task = await ctx.db.orderResolution.findUniqueOrThrow({
      where: { activeKey: order.id },
      select: { kind: true, decision: true },
    });
    expect(task.kind).toBe('CANCELLED_AFTER_DELIVERY');
    expect(task.decision).toBeNull();

    // Результат доставки остался нетронутым: букет у клиента.
    const attempt = await ctx.db.deliveryAttempt.findFirstOrThrow({
      where: { orderId: order.id, activeKey: { not: null } },
      select: { outcome: true },
    });
    expect(attempt.outcome).toBe('DELIVERED');

    // Повторный проход импорта второй задачи не создаёт.
    await cancel(order.id, false);
    await cancel(order.id, true);
    expect(await ctx.db.orderResolution.count({ where: { orderId: order.id } })).toBe(1);
  });
});

// --- Снятие отмены ------------------------------------------------------------

describe('снятие отмены', () => {
  it('возвращает заказ нераспределённым и не восстанавливает прежний маршрут', async () => {
    const creator = await actorFor(['ADMIN']);
    const order = await seedOrder();
    const route = await ctx.db.deliveryRoute.create({
      data: {
        number: unique('CDR'),
        deliveryDate: toDateColumn(DAY),
        state: 'DRAFT',
        vehicleType: 'CAR',
        createdById: creator.userId,
      },
      select: { id: true },
    });
    const participation = await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId: order.id, position: 1, addedById: creator.userId },
      select: { id: true },
    });

    await cancel(order.id);
    // Во время отмены заказ из маршрута НЕ исчезает: он там виден и помечен.
    const during = await ctx.db.routeOrder.findUniqueOrThrow({
      where: { id: participation.id },
      select: { removedAt: true },
    });
    expect(during.removedAt).toBeNull();

    await cancel(order.id, false);

    const after = await ctx.db.routeOrder.findUniqueOrThrow({
      where: { id: participation.id },
      select: { removedAt: true, removalReason: true },
    });
    expect(after.removedAt).not.toBeNull();
    expect(after.removalReason).toBe('SOURCE_CANCELLATION_WITHDRAWN');
    // Автора нет намеренно: участие закрыл проход импорта, а не человек.
    const author = await ctx.db.routeOrder.findUniqueOrThrow({
      where: { id: participation.id },
      select: { removedById: true },
    });
    expect(author.removedById).toBeNull();

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { cancelledInSource: true },
    });
    expect(stored.cancelledInSource).toBe(false);
  });

  it('маршрут с уже полученным результатом не переписывается', async () => {
    const courier = await actorFor(['COURIER']);
    const creator = await actorFor(['ADMIN']);
    const order = await seedOrder();
    const route = await ctx.db.deliveryRoute.create({
      data: {
        number: unique('CKR'),
        deliveryDate: toDateColumn(DAY),
        state: 'ACTIVE',
        vehicleType: 'CAR',
        createdById: creator.userId,
        courierUserId: courier.userId,
      },
      select: { id: true },
    });
    const participation = await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId: order.id, position: 1, addedById: creator.userId },
      select: { id: true },
    });
    await recordDeliveryResult(
      { db: ctx.db },
      courier,
      participation.id,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );

    await cancel(order.id);
    await cancel(order.id, false);

    const after = await ctx.db.routeOrder.findUniqueOrThrow({
      where: { id: participation.id },
      select: { removedAt: true },
    });
    // История доставки неприкосновенна.
    expect(after.removedAt).toBeNull();
  });
});

// --- Исходящая отметка --------------------------------------------------------

describe('исходящая отметка об отмене', () => {
  async function taskFor(orderId: string): Promise<string> {
    const courier = await actorFor(['COURIER']);
    const creator = await actorFor(['ADMIN']);
    const route = await ctx.db.deliveryRoute.create({
      data: {
        number: unique('COR'),
        deliveryDate: toDateColumn(DAY),
        state: 'ACTIVE',
        vehicleType: 'CAR',
        createdById: creator.userId,
        courierUserId: courier.userId,
      },
      select: { id: true },
    });
    const participation = await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId, position: 1, addedById: creator.userId },
      select: { id: true },
    });
    const reason = await ctx.db.deliveryFailureReason.findFirstOrThrow({
      where: { code: 'NO_ANSWER' },
      select: { id: true },
    });
    await recordDeliveryResult(
      { db: ctx.db },
      courier,
      participation.id,
      { outcome: 'NOT_DELIVERED', reasonId: reason.id },
      CONTEXT,
    );
    const resolution = await ctx.db.orderResolution.findUniqueOrThrow({
      where: { activeKey: orderId },
      select: { id: true },
    });
    return resolution.id;
  }

  it('решение логиста ставит ровно одно сообщение и не обещает отметку в источнике', async () => {
    const logist = await actorFor(['LOGISTICIAN']);
    const order = await seedOrder();
    const taskId = await taskFor(order.id);

    const result = await decideCancel({ db: ctx.db }, logist, taskId, CONTEXT);
    expect(result.sourceCancel).toBe('QUEUED');

    const messages = await ctx.db.outboxMessage.findMany({
      where: { idempotencyKey: `moysklad-cancel:${order.id}` },
      select: { id: true, topic: true, payload: true },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.topic).toBe('moysklad.order_cancel');
    // В сообщении только идентификаторы: ни адреса, ни получателя, ни телефона.
    expect(JSON.stringify(messages[0]?.payload)).not.toContain('синтетический адрес отмены');

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { sourceCancelState: true, sourceCancelSentAt: true },
    });
    expect(stored.sourceCancelState).toBe('QUEUED');
    expect(stored.sourceCancelSentAt).toBeNull();

    // Повторная постановка того же события дубликата не создаёт.
    await ctx.db.$transaction(async (tx) => {
      await enqueueOrderCancel(tx, {
        orderId: order.id,
        externalId: randomUUID(),
        now: new Date(),
      });
    });
    expect(
      await ctx.db.outboxMessage.count({
        where: { idempotencyKey: `moysklad-cancel:${order.id}` },
      }),
    ).toBe(1);
  });

  it('при запрещённой записи наружу ничего не уходит, а состояние честное', async () => {
    const order = await seedOrder();
    await ctx.db.$transaction(async (tx) => {
      await enqueueOrderCancel(tx, {
        orderId: order.id,
        externalId: randomUUID(),
        now: new Date(),
      });
    });

    const handler = createOrderCancelHandler({ db: ctx.db, logger, transport: null });
    await handler({
      id: randomUUID(),
      topic: 'moysklad.order_cancel',
      idempotencyKey: `moysklad-cancel:${order.id}`,
      payload: { orderId: order.id, externalId: randomUUID() },
      attempts: 1,
      maxAttempts: 5,
    });

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { sourceCancelState: true, sourceCancelSentAt: true, sourceCancelError: true },
    });
    // Ключевое: НЕ «SENT». Интерфейс не вправе говорить «отменён в МоемСкладе».
    expect(stored.sourceCancelState).toBe('BLOCKED');
    expect(stored.sourceCancelSentAt).toBeNull();
    expect(stored.sourceCancelError).toContain('запрещена');

    const audit = await ctx.db.auditLog.findFirst({
      where: { entityId: order.id, action: 'ORDER_CANCEL_NOT_SENT' },
      select: { id: true },
    });
    expect(audit).not.toBeNull();
  });

  it('удачная отправка отмечается временем, неудачная — причиной и повтором', async () => {
    const order = await seedOrder();
    const calls: string[] = [];
    await ctx.db.$transaction(async (tx) => {
      await enqueueOrderCancel(tx, {
        orderId: order.id,
        externalId: randomUUID(),
        now: new Date(),
      });
    });

    const failing = createOrderCancelHandler({
      db: ctx.db,
      logger,
      transport: async () => {
        calls.push('fail');
        throw new Error('поддельный МойСклад ответил 503');
      },
    });

    const message = {
      id: randomUUID(),
      topic: 'moysklad.order_cancel',
      idempotencyKey: `moysklad-cancel:${order.id}`,
      payload: { orderId: order.id, externalId: randomUUID() },
      attempts: 1,
      maxAttempts: 5,
    };

    // Ошибка перебрасывается: без исключения очередь считала бы дело сделанным.
    await expect(failing(message)).rejects.toThrow('503');
    const failed = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { sourceCancelState: true, sourceCancelError: true },
    });
    expect(failed.sourceCancelState).toBe('FAILED');
    expect(failed.sourceCancelError).toContain('503');

    const succeeding = createOrderCancelHandler({
      db: ctx.db,
      logger,
      transport: async () => {
        calls.push('ok');
        return { alreadyCancelled: false };
      },
    });
    await succeeding(message);

    const sent = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { sourceCancelState: true, sourceCancelSentAt: true, sourceCancelError: true },
    });
    expect(sent.sourceCancelState).toBe('SENT');
    expect(sent.sourceCancelSentAt).not.toBeNull();
    expect(sent.sourceCancelError).toBeNull();
    expect(calls).toEqual(['fail', 'ok']);
  });
});
