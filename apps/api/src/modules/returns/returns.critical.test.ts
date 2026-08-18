/**
 * Критические проверки возврата букета и решения логиста.
 *
 * Защищаемое свойство одно и оно физическое: система обязана знать, ГДЕ
 * сейчас товар. Недоставленный букет лежит в машине курьера, и ни завершение
 * маршрута, ни решение логиста, ни отмена в МоемСкладе его оттуда не достают —
 * это делает только приёмка складом. Всё остальное здесь — следствия: две
 * задачи на один заказ, повторный скан, конфликт двух логистов и отмена
 * результата, за которой букет уже принят.
 *
 * Дни подобраны так, чтобы не пересекаться с другими файлами набора.
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
import {
  cancelDeliveryResult,
  recordDeliveryResult,
  type DeliveryDeps,
} from '../delivery/service.js';
import {
  acceptReturn,
  countUnresolved,
  decideCancel,
  decideReassemble,
  decideRedeliverSameBouquet,
  listPendingReturns,
  listResolutions,
  markReturning,
} from './service.js';

let ctx: TestContext;
let deps: DeliveryDeps;
const CONTEXT = { ip: null, userAgent: null };

/** День вне диапазонов остальных файлов набора. */
const DAY = '2027-11-08';

beforeAll(async () => {
  ctx = await createTestContext();
  deps = { db: ctx.db };
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

async function reasonByCode(code: string): Promise<{ id: string; name: string }> {
  return ctx.db.deliveryFailureReason.findFirstOrThrow({
    where: { code },
    select: { id: true, name: true },
  });
}

async function seedCell(
  kind: 'STORAGE' | 'ROUTE',
  isActive = true,
): Promise<{ id: string; code: string }> {
  const code = unique(kind === 'STORAGE' ? 'S' : 'R').toUpperCase();
  const author = await actorFor(['WAREHOUSE']);
  return ctx.db.storageCell.create({
    data: { code, normalizedCode: code, kind, isActive, createdById: author.userId },
    select: { id: true, code: true },
  });
}

/** Активный маршрут с одним заказом: ровно та точка, откуда начинается недоставка. */
async function seedActiveDelivery(courierId: string): Promise<{
  routeOrderId: string;
  orderId: string;
  orderNumber: string;
  routeId: string;
}> {
  const creator = await actorFor(['ADMIN']);
  const number = unique('RTN');
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: number,
      externalUpdated: new Date(),
      deliveryDate: toDateColumn(DAY),
      inScope: true,
      address: 'синтетический адрес возврата',
      recipient: 'синтетический получатель',
    },
    select: { id: true },
  });

  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('RR'),
      deliveryDate: toDateColumn(DAY),
      state: 'ACTIVE',
      vehicleType: 'CAR',
      createdById: creator.userId,
      courierUserId: courierId,
    },
    select: { id: true },
  });

  const participation = await ctx.db.routeOrder.create({
    data: { routeId: route.id, orderId: order.id, position: 1, addedById: creator.userId },
    select: { id: true },
  });

  return {
    routeOrderId: participation.id,
    orderId: order.id,
    orderNumber: number,
    routeId: route.id,
  };
}

/** Недоставка: результат курьера с причиной из справочника. */
async function failDelivery(
  courier: AuthenticatedActor,
  routeOrderId: string,
  at = new Date(),
): Promise<string> {
  const reason = await reasonByCode('NO_ANSWER');
  const result = await recordDeliveryResult(
    { db: ctx.db, clock: () => at },
    courier,
    routeOrderId,
    { outcome: 'NOT_DELIVERED', reasonId: reason.id },
    CONTEXT,
  );
  return result.attempt.id;
}

// --- 1. Обязательства появляются вместе с недоставкой ------------------------

describe('недоставка создаёт обязательства', () => {
  it('ровно одна задача логиста и ровно один возврат', async () => {
    const courier = await actorFor(['COURIER']);
    const delivery = await seedActiveDelivery(courier.userId);
    const attemptId = await failDelivery(courier, delivery.routeOrderId);

    const resolutions = await ctx.db.orderResolution.findMany({
      where: { orderId: delivery.orderId },
    });
    const returns = await ctx.db.orderReturn.findMany({ where: { orderId: delivery.orderId } });

    expect(resolutions).toHaveLength(1);
    expect(returns).toHaveLength(1);
    expect(resolutions[0]?.attemptId).toBe(attemptId);
    expect(resolutions[0]?.activeKey).toBe(delivery.orderId);
    // Букет у курьера: завершение маршрута доказательством возврата не служит.
    expect(returns[0]?.state).toBe('WITH_COURIER');
    expect(returns[0]?.activeKey).toBe(delivery.orderId);
    expect(returns[0]?.courierUserId).toBe(courier.userId);

    // Переход записан историей с самого начала.
    const transitions = await ctx.db.orderReturnTransition.findMany({
      where: { returnId: returns[0]?.id },
    });
    expect(transitions).toHaveLength(1);
  });

  it('повтор того же результата дубликатов не создаёт', async () => {
    const courier = await actorFor(['COURIER']);
    const delivery = await seedActiveDelivery(courier.userId);
    const reason = await reasonByCode('NO_ANSWER');

    const first = await recordDeliveryResult(
      deps,
      courier,
      delivery.routeOrderId,
      { outcome: 'NOT_DELIVERED', reasonId: reason.id },
      CONTEXT,
    );
    const repeat = await recordDeliveryResult(
      deps,
      courier,
      delivery.routeOrderId,
      { outcome: 'NOT_DELIVERED', reasonId: reason.id },
      CONTEXT,
    );

    expect(repeat.unchanged).toBe(true);
    expect(repeat.attempt.id).toBe(first.attempt.id);
    expect(await ctx.db.orderResolution.count({ where: { orderId: delivery.orderId } })).toBe(1);
    expect(await ctx.db.orderReturn.count({ where: { orderId: delivery.orderId } })).toBe(1);
  });

  it('обязательство переживает завершение маршрута', async () => {
    const courier = await actorFor(['COURIER']);
    const delivery = await seedActiveDelivery(courier.userId);
    await failDelivery(courier, delivery.routeOrderId);

    // Единственный заказ маршрута: его результат маршрут и завершает.
    const route = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: delivery.routeId },
      select: { state: true },
    });
    expect(route.state).toBe('COMPLETED');

    const active = await ctx.db.orderReturn.findUnique({
      where: { activeKey: delivery.orderId },
      select: { state: true },
    });
    expect(active?.state).toBe('WITH_COURIER');
  });
});

// --- 2. Отмена результата ----------------------------------------------------

describe('отмена ошибочного результата', () => {
  it('закрывает непринятые обязательства связанной записью, а не удалением', async () => {
    const courier = await actorFor(['COURIER']);
    const delivery = await seedActiveDelivery(courier.userId);
    const attemptId = await failDelivery(courier, delivery.routeOrderId);

    await cancelDeliveryResult(deps, courier, attemptId, {}, CONTEXT);

    const resolution = await ctx.db.orderResolution.findUniqueOrThrow({
      where: { attemptId },
      select: { activeKey: true, closedAt: true, closedReason: true },
    });
    const orderReturn = await ctx.db.orderReturn.findUniqueOrThrow({
      where: { attemptId },
      select: { state: true, activeKey: true },
    });

    expect(resolution.activeKey).toBeNull();
    expect(resolution.closedAt).not.toBeNull();
    expect(orderReturn.state).toBe('CANCELLED');
    expect(orderReturn.activeKey).toBeNull();
    // Записи остались: история недоставки не переписывается.
    expect(await ctx.db.orderReturn.count({ where: { orderId: delivery.orderId } })).toBe(1);
    expect(await ctx.db.orderResolution.count({ where: { orderId: delivery.orderId } })).toBe(1);
  });

  it('после приёмки складом результат отменить нельзя', async () => {
    const courier = await actorFor(['COURIER']);
    const keeper = await actorFor(['WAREHOUSE']);
    const delivery = await seedActiveDelivery(courier.userId);
    const attemptId = await failDelivery(courier, delivery.routeOrderId);
    const cell = await seedCell('STORAGE');

    await acceptReturn(
      { db: ctx.db },
      keeper,
      { orderNumber: delivery.orderNumber, cellCode: cell.code },
      CONTEXT,
    );

    /*
     * Товар уже в ячейке. «Развернуть» приёмку задним числом значило бы
     * соврать о том, где он лежит.
     */
    await expect(cancelDeliveryResult(deps, courier, attemptId, {}, CONTEXT)).rejects.toMatchObject(
      { conflict: { kind: 'RETURN_ALREADY_ACCEPTED' } },
    );
  });
});

// --- 3. Решения логиста ------------------------------------------------------

describe('решение логиста', () => {
  it('двое одновременно не принимают разные решения', async () => {
    const courier = await actorFor(['COURIER']);
    const first = await actorFor(['LOGISTICIAN']);
    const second = await actorFor(['LOGISTICIAN']);
    const delivery = await seedActiveDelivery(courier.userId);
    await failDelivery(courier, delivery.routeOrderId);

    const task = await ctx.db.orderResolution.findUniqueOrThrow({
      where: { activeKey: delivery.orderId },
      select: { id: true },
    });

    const [cancelled, redelivered] = await Promise.allSettled([
      decideCancel({ db: ctx.db }, first, task.id, CONTEXT),
      decideReassemble({ db: ctx.db }, second, task.id, CONTEXT),
    ]);

    // Ровно одно решение принято, второму назван конфликт.
    const outcomes = [cancelled.status, redelivered.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    const rejected = [cancelled, redelivered].find((item) => item.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      conflict: { kind: 'RESOLUTION_ALREADY_DECIDED' },
    });

    const stored = await ctx.db.orderResolution.findUniqueOrThrow({
      where: { id: task.id },
      select: { decision: true, activeKey: true },
    });
    expect(stored.decision).not.toBeNull();
    expect(stored.activeKey).toBeNull();
  });

  it('счётчик и список показывают ровно нерешённые', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    const delivery = await seedActiveDelivery(courier.userId);
    await failDelivery(courier, delivery.routeOrderId);

    const before = await countUnresolved(ctx.db);
    const list = await listResolutions(ctx.db, { limit: 100, offset: 0 });
    expect(list.unresolved).toBe(before);
    const row = list.items.find((item) => item.orderId === delivery.orderId);
    expect(row?.orderNumber).toBe(delivery.orderNumber);
    expect(row?.returnState).toBe('WITH_COURIER');
    expect(row?.decision).toBeNull();

    const task = await ctx.db.orderResolution.findUniqueOrThrow({
      where: { activeKey: delivery.orderId },
      select: { id: true },
    });
    await decideReassemble({ db: ctx.db }, logist, task.id, CONTEXT);

    expect(await countUnresolved(ctx.db)).toBe(before - 1);
  });
});

// --- 4. Приёмка складом ------------------------------------------------------

describe('приёмка возврата складом', () => {
  it('повторный скан той же пары идемпотентен', async () => {
    const courier = await actorFor(['COURIER']);
    const keeper = await actorFor(['WAREHOUSE']);
    const delivery = await seedActiveDelivery(courier.userId);
    await failDelivery(courier, delivery.routeOrderId);
    const cell = await seedCell('STORAGE');

    const first = await acceptReturn(
      { db: ctx.db },
      keeper,
      { orderNumber: delivery.orderNumber, cellCode: cell.code },
      CONTEXT,
    );
    const repeat = await acceptReturn(
      { db: ctx.db },
      keeper,
      { orderNumber: delivery.orderNumber, cellCode: cell.code },
      CONTEXT,
    );

    expect(first.unchanged).toBe(false);
    expect(repeat.unchanged).toBe(true);
    expect(repeat.placementId).toBe(first.placementId);
    // Второго размещения не появилось: место у заказа одно.
    expect(
      await ctx.db.orderPlacement.count({ where: { orderId: delivery.orderId, releasedAt: null } }),
    ).toBe(1);
  });

  it('приёмка в другую ячейку не создаёт второе действующее размещение', async () => {
    const courier = await actorFor(['COURIER']);
    const keeper = await actorFor(['WAREHOUSE']);
    const delivery = await seedActiveDelivery(courier.userId);
    await failDelivery(courier, delivery.routeOrderId);
    const first = await seedCell('STORAGE');
    const second = await seedCell('STORAGE');

    await acceptReturn(
      { db: ctx.db },
      keeper,
      { orderNumber: delivery.orderNumber, cellCode: first.code },
      CONTEXT,
    );

    await expect(
      acceptReturn(
        { db: ctx.db },
        keeper,
        { orderNumber: delivery.orderNumber, cellCode: second.code },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_ALREADY_PLACED' } });

    expect(
      await ctx.db.orderPlacement.count({ where: { orderId: delivery.orderId, releasedAt: null } }),
    ).toBe(1);
  });

  it('маршрутная, выключенная и несуществующая ячейки отвергаются', async () => {
    const courier = await actorFor(['COURIER']);
    const keeper = await actorFor(['WAREHOUSE']);
    const delivery = await seedActiveDelivery(courier.userId);
    await failDelivery(courier, delivery.routeOrderId);

    const routeCell = await seedCell('ROUTE');
    const disabled = await seedCell('STORAGE', false);

    await expect(
      acceptReturn(
        { db: ctx.db },
        keeper,
        { orderNumber: delivery.orderNumber, cellCode: routeCell.code },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'CELL_KIND_MISMATCH' } });

    await expect(
      acceptReturn(
        { db: ctx.db },
        keeper,
        { orderNumber: delivery.orderNumber, cellCode: disabled.code },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'CELL_INACTIVE' } });

    await expect(
      acceptReturn(
        { db: ctx.db },
        keeper,
        { orderNumber: delivery.orderNumber, cellCode: 'НЕТ-ТАКОЙ-ЯЧЕЙКИ' },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Ни одна неудача места букета не изменила: он всё ещё у курьера.
    const active = await ctx.db.orderReturn.findUnique({
      where: { activeKey: delivery.orderId },
      select: { state: true },
    });
    expect(active?.state).toBe('WITH_COURIER');
  });

  it('очередь возвратов показывает ожидающие и пустеет после приёмки', async () => {
    const courier = await actorFor(['COURIER']);
    const keeper = await actorFor(['WAREHOUSE']);
    const delivery = await seedActiveDelivery(courier.userId);
    await failDelivery(courier, delivery.routeOrderId);
    const cell = await seedCell('STORAGE');

    const waiting = await listPendingReturns(ctx.db);
    expect(waiting.some((item) => item.orderId === delivery.orderId)).toBe(true);

    // Курьер объявил, что везёт: повтор ничего не меняет.
    await markReturning({ db: ctx.db }, courier, delivery.orderId);
    const again = await markReturning({ db: ctx.db }, courier, delivery.orderId);
    expect(again.state).toBe('RETURNING');
    expect(
      await ctx.db.orderReturnTransition.count({
        where: { return: { orderId: delivery.orderId }, toState: 'RETURNING' },
      }),
    ).toBe(1);

    await acceptReturn(
      { db: ctx.db },
      keeper,
      { orderNumber: delivery.orderNumber, cellCode: cell.code },
      CONTEXT,
    );

    const after = await listPendingReturns(ctx.db);
    expect(after.some((item) => item.orderId === delivery.orderId)).toBe(false);
  });
});

// --- 5. Повторная доставка ---------------------------------------------------

describe('повторная доставка', () => {
  it('тот же букет нельзя отправить, пока он у курьера, и можно после приёмки', async () => {
    const courier = await actorFor(['COURIER']);
    const keeper = await actorFor(['WAREHOUSE']);
    const logist = await actorFor(['LOGISTICIAN']);
    const delivery = await seedActiveDelivery(courier.userId);
    await failDelivery(courier, delivery.routeOrderId);

    const task = await ctx.db.orderResolution.findUniqueOrThrow({
      where: { activeKey: delivery.orderId },
      select: { id: true },
    });

    /*
     * Пока букет в машине, «тот же букет» отправлять нечем.
     *
     * Это не придирка к порядку: маршрут из товара, лежащего в чужой машине,
     * — обещание, которое некому выполнить.
     */
    await expect(
      decideRedeliverSameBouquet({ db: ctx.db }, logist, task.id, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'RETURN_NOT_ACCEPTED' } });

    // Задача осталась нерешённой: отказ ничего не записал.
    const still = await ctx.db.orderResolution.findUniqueOrThrow({
      where: { id: task.id },
      select: { decision: true, activeKey: true },
    });
    expect(still.decision).toBeNull();
    expect(still.activeKey).toBe(delivery.orderId);

    const cell = await seedCell('STORAGE');
    await acceptReturn(
      { db: ctx.db },
      keeper,
      { orderNumber: delivery.orderNumber, cellCode: cell.code },
      CONTEXT,
    );

    const result = await decideRedeliverSameBouquet({ db: ctx.db }, logist, task.id, CONTEXT);
    expect(result.decision).toBe('REDELIVER_SAME_BOUQUET');

    const { activeReturnsOf } = await import('./service.js');
    const free = await activeReturnsOf(ctx.db, [delivery.orderId]);
    expect(free.has(delivery.orderId)).toBe(false);

    // Прежнее участие в маршруте закрыто: двух активных не бывает.
    expect(
      await ctx.db.routeOrder.count({ where: { orderId: delivery.orderId, removedAt: null } }),
    ).toBe(0);
  });
});

// --- 6. Персональные данные --------------------------------------------------

describe('персональные данные не расходятся по журналам', () => {
  it('аудит и события возврата не содержат адреса, получателя и телефона', async () => {
    const courier = await actorFor(['COURIER']);
    const keeper = await actorFor(['WAREHOUSE']);
    const logist = await actorFor(['LOGISTICIAN']);
    const delivery = await seedActiveDelivery(courier.userId);
    await failDelivery(courier, delivery.routeOrderId);

    const task = await ctx.db.orderResolution.findUniqueOrThrow({
      where: { activeKey: delivery.orderId },
      select: { id: true },
    });
    await decideCancel({ db: ctx.db }, logist, task.id, CONTEXT);

    const cell = await seedCell('STORAGE');
    await acceptReturn(
      { db: ctx.db },
      keeper,
      { orderNumber: delivery.orderNumber, cellCode: cell.code },
      CONTEXT,
    );

    const audit = await ctx.db.auditLog.findMany({
      where: { entityId: { in: [delivery.orderId, task.id] } },
      select: { newValue: true, oldValue: true },
    });
    const events = await ctx.db.realtimeEvent.findMany({
      where: { topic: { in: ['order.return_changed', 'order.resolution_changed'] } },
      select: { payload: true },
    });

    const serialized = JSON.stringify({ audit, events });
    expect(serialized).not.toContain('синтетический адрес возврата');
    expect(serialized).not.toContain('синтетический получатель');
    // Номера заказа в событиях тоже нет: клиент перечитывает свой список сам.
    expect(JSON.stringify(events)).not.toContain(delivery.orderNumber);
  });
});
