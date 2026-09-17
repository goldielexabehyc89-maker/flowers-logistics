/**
 * Критические проверки денежных последствий изменений заказа в МоемСкладе.
 *
 * Защищаемые свойства:
 *   • выросла оплата после доставки — наличных за курьером становится меньше
 *     ровно на разницу, частично при частичной оплате и до нуля при полной;
 *   • уже учтённая предоплата второй раз не вычитается, переплата не уводит
 *     остаток в минус, повтор синхронизации не снимает одно и то же дважды;
 *   • оплата работы курьера и километры за МКАД при изменении оплаты не
 *     снимаются: он всё отвёз;
 *   • отмена в источнике снимает финансовый результат доставки целиком, и заказ
 *     перестаёт давать и плюс, и минус; исходные записи остаются в истории;
 *   • после отмены ни поздний расчёт МКАД, ни пришедшая оплата не возвращают
 *     заказу ненулевой вклад;
 *   • начальный долг, фактические передачи денег и чужие операции не трогаются.
 *
 * ВЛАДЕНИЕ ДАТАМИ: август 2030 (см. RESERVED_MONTHS).
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
import { accrueDeliveryResult } from './accrual.js';
import { appendEntry, balanceOf } from './ledger.js';
import { LEDGER_SETTING_KEY, readLedgerActivation } from './tariffs.js';
import { buildSettlementReport } from './reports.js';
import { applyCashPaymentCorrection, stripCancelledOrderFinance } from './order-sync.js';

let ctx: TestContext;

const DAY = '2030-08-12';
const NEXT_DAY = '2030-08-13';

beforeAll(async () => {
  ctx = await createTestContext();
  await activateLedger('2030-08-01');

  const admin = await actorFor(['ADMIN']);
  const version = await ctx.db.courierTariffVersion.create({
    data: {
      kind: 'REGULAR',
      effectiveFrom: toDateColumn('2030-08-01'),
      effectiveTo: null,
      perOrderWalkMinor: 0n,
      perOrderCarMinor: 0n,
      perKmMinor: 0n,
      createdById: admin.userId,
    },
    select: { id: true },
  });
  tariffVersionId = version.id;
});

afterAll(async () => {
  await closeTestContext(ctx);
});

/** Одна версия тарифа на весь файл: снимок маршрута ссылается на неё. */
let tariffVersionId = '';

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${seq}`;
}

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return { userId: user.id, roles, familyId: randomUUID() } as AuthenticatedActor;
}

async function activateLedger(from: string): Promise<void> {
  const admin = await actorFor(['ADMIN']);
  await ctx.db.systemSetting.updateMany({
    where: { key: LEDGER_SETTING_KEY, currentKey: LEDGER_SETTING_KEY },
    data: { currentKey: null },
  });
  const previous = await ctx.db.systemSetting.findFirst({
    where: { key: LEDGER_SETTING_KEY },
    orderBy: [{ version: 'desc' }],
    select: { version: true },
  });
  await ctx.db.systemSetting.create({
    data: {
      key: LEDGER_SETTING_KEY,
      currentKey: LEDGER_SETTING_KEY,
      version: (previous?.version ?? 0) + 1,
      value: { activeFrom: from },
      updatedById: admin.userId,
    },
  });
}

interface Delivery {
  orderId: string;
  routeId: string;
  routeOrderId: string;
  attemptId: string;
  courierId: string;
}

/**
 * Доставленный заказ с наличными, ставкой за заказ и расстоянием за МКАД.
 *
 * `sum` — сумма заказа, `payed` — сколько было оплачено НА МОМЕНТ доставки:
 * именно разница и становится наличными за курьером.
 */
async function seedDelivered(input: {
  sum: bigint;
  payed: bigint;
  perOrder?: bigint;
  /** Уже начисленные километры за МКАД: снимок расстояния здесь не нужен. */
  distanceFee?: bigint;
}): Promise<Delivery> {
  const admin = await actorFor(['ADMIN']);
  const courier = await actorFor(['COURIER']);

  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: unique('OS'),
      externalUpdated: new Date(),
      deliveryDate: toDateColumn(DAY),
      inScope: true,
      cashCollectable: true,
      sumMinor: input.sum,
      payedSumMinor: input.payed,
      cashToCollectMinor: input.sum - input.payed > 0n ? input.sum - input.payed : 0n,
      paymentTypeName: 'Наличные/карта на ТТ',
    },
    select: { id: true },
  });

  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('ROS'),
      deliveryDate: toDateColumn(DAY),
      state: 'ACTIVE',
      vehicleType: 'CAR',
      createdById: admin.userId,
      courierUserId: courier.userId,
    },
    select: { id: true },
  });

  const participation = await ctx.db.routeOrder.create({
    data: { routeId: route.id, orderId: order.id, position: 1, addedById: admin.userId },
    select: { id: true },
  });

  /*
   * Снимок ставок маршрута создаётся напрямую: проверяются последствия
   * изменений заказа, а не выбор тарифа. Нулевые ставки означают, что
   * начисляются только наличные.
   */
  await ctx.db.routeTariffSnapshot.create({
    data: {
      routeId: route.id,
      tariffVersionId,
      vehicleType: 'CAR',
      perOrderMinor: input.perOrder ?? 0n,
      perKmMinor: 0n,
      deliveryDate: toDateColumn(DAY),
    },
  });

  const attempt = await ctx.db.deliveryAttempt.create({
    data: {
      routeOrderId: participation.id,
      orderId: order.id,
      routeId: route.id,
      outcome: 'DELIVERED',
      courierUserId: courier.userId,
      activeKey: participation.id,
    },
    select: { id: true },
  });

  await accrueDeliveryResult(ctx.db, await readLedgerActivation(ctx.db), {
    attemptId: attempt.id,
    routeOrderId: participation.id,
    routeId: route.id,
    orderId: order.id,
    courierUserId: courier.userId,
    actorUserId: courier.userId,
    outcome: 'DELIVERED',
  });

  /*
   * Километры за МКАД начисляются напрямую: сам расчёт расстояния проверяется
   * в своих тестах, а здесь важно лишь то, что этот заработок ведёт себя как
   * заработок — не снимается при оплате и снимается при отмене.
   */
  if ((input.distanceFee ?? 0n) > 0n) {
    await ctx.db.$transaction((tx) =>
      appendEntry(tx, {
        courierUserId: courier.userId,
        kind: 'DISTANCE_FEE',
        amountMinor: input.distanceFee ?? 0n,
        operationDate: DAY,
        actorUserId: courier.userId,
        routeId: route.id,
        orderId: order.id,
        attemptId: attempt.id,
        idempotencyKey: unique('distance'),
      }),
    );
  }

  return {
    orderId: order.id,
    routeId: route.id,
    routeOrderId: participation.id,
    attemptId: attempt.id,
    courierId: courier.userId,
  };
}

/**
 * Сообщает источнику новую оплаченную сумму и запускает корректировку.
 *
 * Поля заказа держат инвариант базы: остаток к получению равен неоплаченной
 * части, а переплата помечается аномалией — ровно так их пишет импорт.
 */
async function payInSource(delivery: Delivery, payed: bigint): Promise<void> {
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { id: delivery.orderId },
    select: { sumMinor: true },
  });
  const rest = order.sumMinor - payed;
  await ctx.db.deliveryOrder.update({
    where: { id: delivery.orderId },
    data: {
      payedSumMinor: payed,
      cashToCollectMinor: rest > 0n ? rest : 0n,
      cashAnomaly: payed > order.sumMinor,
    },
  });
  await ctx.db.$transaction((tx) =>
    applyCashPaymentCorrection(tx, {
      orderId: delivery.orderId,
      now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
    }),
  );
}

/** Сумма записей одного вида по заказу, без учёта отменённых. */
async function sumKind(orderId: string, kind: string): Promise<bigint> {
  const result = await ctx.db.courierLedgerEntry.aggregate({
    where: { orderId, kind: kind as never, reversedBy: { is: null } },
    _sum: { amountMinor: true },
  });
  return result._sum.amountMinor ?? 0n;
}

/** Вклад заказа в расчёты: сумма ВСЕХ его записей, включая обратные. */
async function orderContribution(orderId: string): Promise<bigint> {
  const result = await ctx.db.courierLedgerEntry.aggregate({
    where: { orderId },
    _sum: { amountMinor: true },
  });
  return result._sum.amountMinor ?? 0n;
}

// --- Оплата после доставки ----------------------------------------------------

describe('оплата в источнике уменьшает наличные за курьером', () => {
  it('частичная оплата уменьшает частично, полная — обнуляет', async () => {
    // Заказ 5 000 ₽, до доставки оплачено 1 000 ₽ → за курьером 4 000 ₽.
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n });
    expect(await sumKind(delivery.orderId, 'CASH_RECEIVED')).toBe(400_000n);

    // Оплачено стало 3 000 ₽ → остаётся 2 000 ₽.
    await payInSource(delivery, 300_000n);
    expect(await sumKind(delivery.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(-200_000n);

    // Оплачено стало 5 000 ₽ → остаётся 0 ₽, и снято ровно начисленное.
    await payInSource(delivery, 500_000n);
    expect(await sumKind(delivery.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(-400_000n);

    // Исходное начисление не переписано и не удалено.
    expect(await sumKind(delivery.orderId, 'CASH_RECEIVED')).toBe(400_000n);
  });

  it('переплата не уводит остаток в минус', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n });
    await payInSource(delivery, 700_000n);

    // Снято ровно 4 000 ₽ — столько и начисляли, не больше.
    expect(await sumKind(delivery.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(-400_000n);
    expect(
      (await sumKind(delivery.orderId, 'CASH_RECEIVED')) +
        (await sumKind(delivery.orderId, 'CASH_PAYMENT_CORRECTION')),
    ).toBe(0n);
  });

  it('повторная синхронизация не снимает одно и то же дважды', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n });

    await payInSource(delivery, 300_000n);
    await payInSource(delivery, 300_000n);
    await payInSource(delivery, 300_000n);

    expect(await sumKind(delivery.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(-200_000n);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { orderId: delivery.orderId, kind: 'CASH_PAYMENT_CORRECTION' },
      }),
    ).toBe(1);
  });

  it('конкурентные корректировки одной оплаты дают одну запись', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n });
    await ctx.db.deliveryOrder.update({
      where: { id: delivery.orderId },
      data: { payedSumMinor: 300_000n, cashToCollectMinor: 200_000n },
    });

    const run = (): Promise<void> =>
      ctx.db
        .$transaction((tx) =>
          applyCashPaymentCorrection(tx, {
            orderId: delivery.orderId,
            now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
          }),
        )
        .catch(() => undefined);

    await Promise.all([run(), run()]);

    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { orderId: delivery.orderId, kind: 'CASH_PAYMENT_CORRECTION' },
      }),
    ).toBe(1);
    expect(await sumKind(delivery.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(-200_000n);
  });

  it('предоплата, которую не начисляли, второй раз не вычитается', async () => {
    // Оплачено 1 000 ₽ ещё до доставки: начислено 4 000 ₽, а не 5 000 ₽.
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n });
    // Оплата выросла ровно на предоплату — то есть не менялась по сути.
    await payInSource(delivery, 100_000n);

    expect(await sumKind(delivery.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(0n);
  });

  it('оплата работы курьера и километры за МКАД не снимаются', async () => {
    const delivery = await seedDelivered({
      sum: 500_000n,
      payed: 0n,
      perOrder: 20_000n,
      distanceFee: 10_000n,
    });
    const feeBefore = await sumKind(delivery.orderId, 'DELIVERY_FEE');
    const distanceBefore = await sumKind(delivery.orderId, 'DISTANCE_FEE');
    expect(feeBefore).toBe(-20_000n);
    expect(distanceBefore).toBe(-10_000n);

    await payInSource(delivery, 500_000n);

    // Наличные сняты полностью, заработок — нет.
    expect(await sumKind(delivery.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(-500_000n);
    expect(await sumKind(delivery.orderId, 'DELIVERY_FEE')).toBe(feeBefore);
    expect(await sumKind(delivery.orderId, 'DISTANCE_FEE')).toBe(distanceBefore);
  });

  it('итог отчёта сходится с журналом, когда доставка и корректировка в разных днях', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n });
    await payInSource(delivery, 300_000n);

    // Период, охватывающий оба дня: наличные показаны за вычетом корректировки.
    const report = await buildSettlementReport(ctx.db, {
      from: DAY,
      to: NEXT_DAY,
      courierUserId: delivery.courierId,
      limit: 50,
      offset: 0,
    });
    expect(report.totals.cashReceivedMinor).toBe('200000');
    const row = report.rows.find((item) => item.attemptId === delivery.attemptId);
    expect(row?.cashMinor).toBe('200000');
    expect(report.totals.closingBalanceMinor).toBe(
      (await balanceOf(ctx.db, delivery.courierId, NEXT_DAY)).toString(),
    );
  });
});

// --- Отмена в источнике --------------------------------------------------------

describe('отмена в источнике исключает заказ из расчётов', () => {
  it('снимает наличные, оплату доставки и километры; вклад заказа нулевой', async () => {
    const delivery = await seedDelivered({
      sum: 500_000n,
      payed: 0n,
      perOrder: 20_000n,
      distanceFee: 10_000n,
    });
    const balanceBefore = await balanceOf(ctx.db, delivery.courierId, null);
    expect(balanceBefore).toBe(500_000n - 20_000n - 10_000n);

    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
      }),
    );

    // Ни плюса, ни минуса: заказ больше не влияет на расчёты.
    expect(await orderContribution(delivery.orderId)).toBe(0n);
    expect(await balanceOf(ctx.db, delivery.courierId, null)).toBe(0n);

    // История сохранена: исходные суммы на месте, снятие — отдельными записями.
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { orderId: delivery.orderId, kind: 'CASH_RECEIVED' },
      }),
    ).toBe(1);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { orderId: delivery.orderId, kind: 'ADJUSTMENT' },
      }),
    ).toBeGreaterThan(0);
  });

  it('после частичного снятия наличных отмена не вычитает их повторно', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n });
    await payInSource(delivery, 300_000n);
    // Осталось 2 000 ₽ наличных.
    expect(await balanceOf(ctx.db, delivery.courierId, null)).toBe(200_000n);

    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
      }),
    );

    // Ровно ноль: ни 4 000 ₽ повторно, ни минус.
    expect(await orderContribution(delivery.orderId)).toBe(0n);
    expect(await balanceOf(ctx.db, delivery.courierId, null)).toBe(0n);
  });

  it('повторная отмена ничего не меняет', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 0n, perOrder: 20_000n });
    const strip = (): Promise<void> =>
      ctx.db
        .$transaction((tx) =>
          stripCancelledOrderFinance(tx, {
            orderId: delivery.orderId,
            now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
          }),
        )
        .catch(() => undefined);

    await strip();
    await strip();

    expect(await orderContribution(delivery.orderId)).toBe(0n);
    expect(await balanceOf(ctx.db, delivery.courierId, null)).toBe(0n);
  });

  it('оплата, пришедшая после отмены, оставляет результат нулевым', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 0n });
    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
      }),
    );
    await ctx.db.deliveryOrder.update({
      where: { id: delivery.orderId },
      data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
    });

    await payInSource(delivery, 500_000n);

    expect(await orderContribution(delivery.orderId)).toBe(0n);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { orderId: delivery.orderId, kind: 'CASH_PAYMENT_CORRECTION' },
      }),
    ).toBe(0);
  });

  it('начальный долг, передачи денег и чужие операции не трогаются', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 0n, perOrder: 20_000n });
    const admin = await actorFor(['ADMIN']);

    // Начальный долг того же курьера — к этой доставке отношения не имеет.
    await ctx.db.$transaction((tx) =>
      appendEntry(tx, {
        courierUserId: delivery.courierId,
        kind: 'OPENING_DEBT',
        amountMinor: 700_00n,
        operationDate: DAY,
        actorUserId: admin.userId,
        reason: 'долг до перехода на ERP',
        idempotencyKey: unique('debt'),
      }),
    );
    // Фактическая сдача наличных логисту — реальное движение денег.
    await ctx.db.$transaction((tx) =>
      appendEntry(tx, {
        courierUserId: delivery.courierId,
        kind: 'CASH_HANDED_TO_LOGIST',
        amountMinor: 100_00n,
        operationDate: DAY,
        actorUserId: admin.userId,
        idempotencyKey: unique('handed'),
      }),
    );

    const untouched = 700_00n - 100_00n;

    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
      }),
    );

    // Доставка обнулена, а всё остальное осталось как было.
    expect(await orderContribution(delivery.orderId)).toBe(0n);
    expect(await balanceOf(ctx.db, delivery.courierId, null)).toBe(untouched);
    expect(await sumKind(delivery.orderId, 'OPENING_DEBT')).toBe(0n);
  });
});
