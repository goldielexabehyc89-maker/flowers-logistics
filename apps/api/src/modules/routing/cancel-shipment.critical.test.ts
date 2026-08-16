/**
 * Проверки отмены отгрузки маршрутного листа.
 *
 * Защищаемые свойства: доставленный заказ не исчезает ни при каком варианте,
 * разделение листа атомарно и прослеживаемо, а возврат доставленных в работу
 * требует причины и остаётся в истории отменённой коррекцией.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { applyOrderSnapshot } from '../integrations/moysklad/import-service.js';
import { mapOrder, type OrderSnapshot } from '../integrations/moysklad/mapper.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { cancelShipment } from './lifecycle.js';

let ctx: TestContext;
const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;
const CONTEXT = { ip: '127.0.0.1', userAgent: 'critical-test' };
const DAY = '2027-12-11';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

const deps = () => ({ db: ctx.db });

async function logistician(): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
  return { userId: user.id, roles: ['LOGISTICIAN'], familyId: randomUUID() };
}

function snapshotOf(): OrderSnapshot {
  return mapOrder(
    {
      id: randomUUID(),
      name: `CS-${process.hrtime.bigint() % 1_000_000n}`,
      updated: '2026-08-13 10:00:00.000',
      shipmentAddress: 'Москва, синтетическая улица, дом 1',
      deliveryPlannedMoment: `${DAY} 12:00:00.000`,
      sum: 100000,
      payedSum: 0,
      store: { meta: { href: href('store', IDS.store) } },
      attributes: [
        {
          id: IDS.deliveryMethodAttribute,
          value: {
            name: 'Доставка',
            meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
          },
        },
        { id: IDS.intervalAttribute, value: 'с 10:00 по 14:00' },
        { id: IDS.recipientAttribute, value: 'Получатель Синтетический' },
      ],
    } as never,
    IDS,
  ).snapshot;
}

async function seedOrder(): Promise<string> {
  const snapshot = snapshotOf();
  await ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, new Date()));
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { externalId: snapshot.externalId },
    select: { id: true },
  });
  await ctx.db.deliveryOrder.update({
    where: { id: order.id },
    data: {
      needsAttention: false,
      attentionReasons: [],
      geoState: 'RESOLVED',
      geoSource: 'DADATA',
      geoPrecision: 'EXACT_HOUSE',
      geoLatMicro: 55_751_244,
      geoLonMicro: 37_618_423,
      geoResolvedAt: new Date(),
    },
  });
  return order.id;
}

/** Отгруженный лист: заказы в составе, состояние ACTIVE, курьер назначен. */
async function seedShipped(orderCount: number): Promise<{
  id: string;
  number: string;
  version: number;
  courierId: string;
  participations: { id: string; orderId: string }[];
}> {
  const creator = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
  const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: `CS-${process.hrtime.bigint() % 1_000_000n}`,
      deliveryDate: new Date(`${DAY}T00:00:00.000Z`),
      vehicleType: 'CAR',
      createdById: creator.id,
      courierUserId: courier.id,
      state: 'ACTIVE',
    },
    select: { id: true, number: true, version: true },
  });

  const participations: { id: string; orderId: string }[] = [];
  for (let index = 0; index < orderCount; index += 1) {
    const orderId = await seedOrder();
    const participation = await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId, position: index + 1, addedById: creator.id },
      select: { id: true, orderId: true },
    });
    participations.push(participation);
  }

  return { ...route, courierId: courier.id, participations };
}

/** Отмечает заказ доставленным. Попытка остаётся фактом навсегда. */
async function markDelivered(
  route: { id: string; courierId: string },
  participation: { id: string; orderId: string },
): Promise<string> {
  const attempt = await ctx.db.deliveryAttempt.create({
    data: {
      routeOrderId: participation.id,
      orderId: participation.orderId,
      routeId: route.id,
      outcome: 'DELIVERED',
      courierUserId: route.courierId,
      // Ключ действующего результата равен участию: этого требует ограничение
      // `DeliveryAttempt_activeKey_matches_participation`.
      activeKey: participation.id,
    },
    select: { id: true },
  });
  return attempt.id;
}

async function activeOrdersOf(routeId: string): Promise<{ orderId: string; position: number }[]> {
  return ctx.db.routeOrder.findMany({
    where: { routeId, removedAt: null },
    orderBy: { position: 'asc' },
    select: { orderId: true, position: true },
  });
}

describe('отмена отгрузки без доставленных заказов', () => {
  it('лист целиком возвращается в неотгруженное состояние', async () => {
    const sheet = await seedShipped(2);

    const result = await cancelShipment(
      deps(),
      await logistician(),
      sheet.id,
      { expectedVersion: sheet.version, mode: 'UNFINISHED' },
      CONTEXT,
    );

    expect(result.state).toBe('CONFIRMED');
    // Разделение не потребовалось: нового листа нет.
    expect(result.createdSheet).toBeNull();
    expect(await activeOrdersOf(sheet.id)).toHaveLength(2);
  });

  it('повтор команды ничего не меняет', async () => {
    const sheet = await seedShipped(1);
    const actor = await logistician();
    await cancelShipment(
      deps(),
      actor,
      sheet.id,
      { expectedVersion: sheet.version, mode: 'UNFINISHED' },
      CONTEXT,
    );

    const repeat = await cancelShipment(
      deps(),
      actor,
      sheet.id,
      { expectedVersion: sheet.version, mode: 'UNFINISHED' },
      CONTEXT,
    );

    expect(repeat.unchanged).toBe(true);
    expect(repeat.createdSheet).toBeNull();
  });
});

describe('отмена незавершённых делит лист', () => {
  it('доставленные остаются в исходном листе, незавершённые уезжают в новый', async () => {
    const sheet = await seedShipped(3);
    const [first, second, third] = sheet.participations;
    await markDelivered(sheet, first!);

    const result = await cancelShipment(
      deps(),
      await logistician(),
      sheet.id,
      { expectedVersion: sheet.version, mode: 'UNFINISHED' },
      CONTEXT,
    );

    // Исходный лист сохранил номер и ушёл в «Доставленные».
    expect(result.state).toBe('COMPLETED');
    const original = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: sheet.id },
      select: { number: true, state: true },
    });
    expect(original.number).toBe(sheet.number);
    expect(original.state).toBe('COMPLETED');
    expect((await activeOrdersOf(sheet.id)).map((row) => row.orderId)).toEqual([first!.orderId]);

    // Новый лист неотгружен, с новым номером и тем же курьером.
    expect(result.createdSheet).not.toBeNull();
    const created = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: result.createdSheet!.id },
      select: { number: true, state: true, courierUserId: true },
    });
    expect(created.number).not.toBe(sheet.number);
    expect(created.state).toBe('CONFIRMED');
    expect(created.courierUserId).toBe(sheet.courierId);

    // Относительный порядок незавершённых сохранён.
    expect((await activeOrdersOf(result.createdSheet!.id)).map((row) => row.orderId)).toEqual([
      second!.orderId,
      third!.orderId,
    ]);
  });

  it('связь между листами прослеживается и в участии, и в аудите', async () => {
    const sheet = await seedShipped(2);
    await markDelivered(sheet, sheet.participations[0]!);

    const result = await cancelShipment(
      deps(),
      await logistician(),
      sheet.id,
      { expectedVersion: sheet.version, mode: 'UNFINISHED' },
      CONTEXT,
    );

    // Участие закрыто существующей причиной переноса со ссылкой на новый лист.
    const moved = await ctx.db.routeOrder.findFirstOrThrow({
      where: { routeId: sheet.id, removedAt: { not: null } },
      select: { removalReason: true, movedToRouteId: true },
    });
    expect(moved.removalReason).toBe('MOVED_TO_ANOTHER_ROUTE');
    expect(moved.movedToRouteId).toBe(result.createdSheet!.id);

    // В истории обоих листов виден встречный номер.
    const audits = await ctx.db.auditLog.findMany({
      where: {
        action: 'ROUTE_SPLIT_FROM_SHIPMENT',
        entityId: { in: [sheet.id, result.createdSheet!.id] },
      },
      select: { entityId: true, newValue: true },
    });
    expect(audits).toHaveLength(2);
    for (const record of audits) {
      const value = record.newValue as { counterpartRouteNumber?: string };
      expect(value.counterpartRouteNumber).toBeTruthy();
    }
  });

  it('факт доставки не изменяется и не удаляется', async () => {
    const sheet = await seedShipped(2);
    const attemptId = await markDelivered(sheet, sheet.participations[0]!);

    await cancelShipment(
      deps(),
      await logistician(),
      sheet.id,
      { expectedVersion: sheet.version, mode: 'UNFINISHED' },
      CONTEXT,
    );

    const attempt = await ctx.db.deliveryAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: { outcome: true, activeKey: true, cancellation: { select: { id: true } } },
    });
    expect(attempt.outcome).toBe('DELIVERED');
    // Результат остаётся действующим: незавершённых он не касается.
    expect(attempt.activeKey).not.toBeNull();
    expect(attempt.cancellation).toBeNull();
  });
});

describe('«Отменить все» — административная коррекция', () => {
  it('возвращает доставленные в работу, сохраняя прежний факт', async () => {
    const sheet = await seedShipped(2);
    const attemptId = await markDelivered(sheet, sheet.participations[0]!);

    const result = await cancelShipment(
      deps(),
      await logistician(),
      sheet.id,
      { expectedVersion: sheet.version, mode: 'ALL', reason: 'Курьер отметил чужой заказ' },
      CONTEXT,
    );

    expect(result.state).toBe('CONFIRMED');
    // Разделения нет: лист остаётся одним целым.
    expect(result.createdSheet).toBeNull();
    expect(result.restoredOrders).toBe(1);
    expect(await activeOrdersOf(sheet.id)).toHaveLength(2);

    // Прежний факт остался в истории — отменённым коррекцией с причиной.
    const attempt = await ctx.db.deliveryAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: {
        outcome: true,
        activeKey: true,
        cancellation: { select: { kind: true, reason: true, actorUserId: true } },
      },
    });
    expect(attempt.outcome).toBe('DELIVERED');
    expect(attempt.activeKey).toBeNull();
    expect(attempt.cancellation?.kind).toBe('MANAGER_CORRECTION');
    expect(attempt.cancellation?.reason).toBe('Курьер отметил чужой заказ');
    expect(attempt.cancellation?.actorUserId).toBeTruthy();
  });

  it('без причины возврат доставленных невозможен', async () => {
    const sheet = await seedShipped(1);
    const attemptId = await markDelivered(sheet, sheet.participations[0]!);

    await expect(
      cancelShipment(
        deps(),
        await logistician(),
        sheet.id,
        { expectedVersion: sheet.version, mode: 'ALL' },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // Ничего не изменилось: ни состояние листа, ни факт доставки.
    const route = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: sheet.id },
      select: { state: true },
    });
    expect(route.state).toBe('ACTIVE');
    const attempt = await ctx.db.deliveryAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: { activeKey: true },
    });
    expect(attempt.activeKey).not.toBeNull();
  });

  it('чужая версия отклоняет операцию целиком', async () => {
    const sheet = await seedShipped(2);
    await markDelivered(sheet, sheet.participations[0]!);

    await expect(
      cancelShipment(
        deps(),
        await logistician(),
        sheet.id,
        { expectedVersion: sheet.version + 3, mode: 'UNFINISHED' },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'STALE_VERSION' } });

    // Ни нового листа, ни закрытых участий: частичных изменений нет.
    // Считаются участия ИМЕННО этих заказов: соседние проверки файла работают
    // в тот же день, и общий счётчик листов доказывал бы не то.
    expect(await activeOrdersOf(sheet.id)).toHaveLength(2);
    const elsewhere = await ctx.db.routeOrder.count({
      where: {
        orderId: { in: sheet.participations.map((item) => item.orderId) },
        routeId: { not: sheet.id },
      },
    });
    expect(elsewhere).toBe(0);
  });
});

describe('посторонние переходы по-прежнему запрещены', () => {
  /**
   * Миграция расширила перечень ровно на две пары. Всё остальное обязано
   * остаться невозможным: перечень разрешённых переходов — это защита от
   * состояний, из которых нет пути назад, а не формальность.
   */
  async function transition(from: string, to: string): Promise<void> {
    const sheet = await seedShipped(1);
    const actor = await logistician();
    await ctx.db.routeStateTransition.create({
      data: {
        routeId: sheet.id,
        fromState: from as never,
        toState: to as never,
        actorUserId: actor.userId,
        occurredAt: new Date(),
        reason: to === 'CANCELLED' || to === 'DRAFT' ? 'проверка ограничения' : null,
      },
    });
  }

  it('отгруженный лист не может стать черновиком', async () => {
    await expect(transition('ACTIVE', 'DRAFT')).rejects.toThrow();
  });

  it('черновик не может стать доставленным', async () => {
    await expect(transition('DRAFT', 'COMPLETED')).rejects.toThrow();
  });

  it('отменённый маршрут не возвращается ни в какое состояние', async () => {
    await expect(transition('CANCELLED', 'CONFIRMED')).rejects.toThrow();
  });

  it('разрешённые миграцией пары принимаются', async () => {
    await expect(transition('ACTIVE', 'CONFIRMED')).resolves.toBeUndefined();
    await expect(transition('COMPLETED', 'CONFIRMED')).resolves.toBeUndefined();
  });
});
