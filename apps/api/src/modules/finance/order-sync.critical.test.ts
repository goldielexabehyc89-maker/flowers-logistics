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
import ExcelJS from 'exceljs';
import { accrueDeliveryResult, accrueDistanceFee } from './accrual.js';
import { appendEntry, balanceOf, reverseEntry } from './ledger.js';
import { LEDGER_SETTING_KEY, readLedgerActivation } from './tariffs.js';
import { buildSettlementReport } from './reports.js';
import { buildSettlementWorkbook } from './export-xlsx.js';
import {
  applyCashPaymentCorrection,
  createOrderFinanceHandler,
  stripCancelledOrderFinance,
} from './order-sync.js';

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
      /*
       * Черновик, а не активный маршрут.
       *
       * Начислению состояние маршрута безразлично — оно читает только дату
       * доставки, — а экран маршрутных листов показывает лишь подтверждённые,
       * отгруженные и завершённые. Активный маршрут далёкого месяца занимал бы
       * место в общем списке дней и вытеснял оттуда дни соседних проверок.
       */
      state: 'DRAFT',
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
/**
 * Действующий ненулевой снимок расстояния за МКАД.
 *
 * Без него начисление километров равно нулю просто потому, что считать нечего,
 * и проверка «отменённому не начисляем» проходила бы даже без защиты.
 */
async function seedDistance(delivery: Delivery, kmTenths: number): Promise<void> {
  const admin = await actorFor(['ADMIN']);
  const ring =
    (await ctx.db.mkadRingVersion.findFirst({ select: { id: true } })) ??
    (await ctx.db.mkadRingVersion.create({
      data: {
        points: [
          [37_000_000, 55_000_000],
          [37_100_000, 55_000_000],
          [37_100_000, 55_100_000],
          [37_000_000, 55_000_000],
        ],
        pointCount: 4,
        sha256: `ring-${process.hrtime.bigint().toString(16)}`,
        source: 'проверка',
      },
      select: { id: true },
    }));

  await ctx.db.routeOrderDistance.create({
    data: {
      routeOrderId: delivery.routeOrderId,
      ringVersionId: ring.id,
      meters: kmTenths * 100,
      roundedKmTenths: kmTenths,
      insideMkad: false,
      source: 'MANUAL',
      actorUserId: admin.userId,
      reason: 'проверка позднего начисления',
      activeKey: delivery.routeOrderId,
    },
  });
}

/**
 * Ещё одна попытка доставки того же заказа.
 *
 * `activeKey` не заполняется: действующий результат остаётся у первой попытки,
 * а здесь важна лишь возможность начислить по второй.
 */
async function seedAttemptFor(delivery: Delivery): Promise<string> {
  const attempt = await ctx.db.deliveryAttempt.create({
    data: {
      routeOrderId: delivery.routeOrderId,
      orderId: delivery.orderId,
      routeId: delivery.routeId,
      outcome: 'DELIVERED',
      courierUserId: delivery.courierId,
    },
    select: { id: true },
  });
  return attempt.id;
}

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

/** Отчёт за период по одному курьеру: учёт включён с начала месяца. */
async function report(from: string, to: string, courierUserId: string) {
  return buildSettlementReport(ctx.db, {
    from,
    to,
    courierUserId,
    ledgerActiveFrom: '2030-08-01',
    limit: 50,
    offset: 0,
  });
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

    const run = (): Promise<boolean> =>
      ctx.db.$transaction((tx) =>
        applyCashPaymentCorrection(tx, {
          orderId: delivery.orderId,
          now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
        }),
      );

    /*
     * Оба запроса обязаны ЗАВЕРШИТЬСЯ УСПЕШНО.
     *
     * Строка заказа блокируется первой, поэтому второй запрос не соревнуется
     * за уникальность, а ждёт первого и перечитывает уже снятое: разница
     * выходит нулевой, и вставлять ему нечего. Разрешать здесь отказ по
     * уникальности значило бы заранее согласиться с симптомом, который эта
     * проверка и должна ловить: убери блокировку — и тест продолжил бы
     * проходить, доказывая только то, что запись в итоге одна.
     */
    const [first, second] = await Promise.all([run(), run()]);
    // Один снял разницу, другой увидел, что снимать уже нечего.
    expect([first, second].filter(Boolean)).toHaveLength(1);

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

  /*
   * Три отдельных отчёта: день доставки, день корректировки и общий период.
   *
   * Раньше отчёт ТОЛЬКО за день корректировки показывал снятие как приход
   * наличных (модуль суммы) и терял саму строку: доставка вне периода, а
   * журнал группы пропускал все операции с привязкой к доставке. Баланс при
   * этом менялся, и объяснить его было нечем.
   */

  /*
   * Итог дня не зависит от ширины отчёта.
   *
   * Это главный признак дефекта: один и тот же день показывал разные суммы,
   * когда его запрашивали отдельно и вместе с соседним.
   */

  /*
   * Обязательная регрессия из ревью: доставка с наличными, оплатой и МКАД,
   * отмена на следующий день. История дней сохраняется, но за весь период
   * отменённый заработок не остаётся в зарплатных показателях.
   */
  it('отмена следующего дня: движения дней сохранены, заработок за период нулевой', async () => {
    const delivery = await seedDelivered({
      sum: 500_000n,
      payed: 0n,
      perOrder: 20_000n,
      distanceFee: 10_000n,
    });

    await ctx.db.deliveryOrder.update({
      where: { id: delivery.orderId },
      data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
    });
    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
      }),
    );

    const onDelivery = await report(DAY, DAY, delivery.courierId);
    const onCancel = await report(NEXT_DAY, NEXT_DAY, delivery.courierId);
    const both = await report(DAY, NEXT_DAY, delivery.courierId);

    // День доставки: заработок начислен и виден как было.
    expect(onDelivery.totals.deliveryFeesMinor).toBe('20000');
    expect(onDelivery.totals.distanceFeesMinor).toBe('10000');
    expect(onDelivery.totals.cashReceivedMinor).toBe('500000');
    expect(onDelivery.totals.closingBalanceMinor).toBe('470000');

    // День отмены: те же категории с МИНУСОМ, а не общей «корректировкой».
    expect(onCancel.totals.deliveryFeesMinor).toBe('-20000');
    expect(onCancel.totals.distanceFeesMinor).toBe('-10000');
    expect(onCancel.totals.cashReceivedMinor).toBe('-500000');
    expect(onCancel.totals.closingBalanceMinor).toBe('0');

    // Весь период: заработка нет, баланс ноль.
    expect(both.totals.deliveryFeesMinor).toBe('0');
    expect(both.totals.distanceFeesMinor).toBe('0');
    expect(both.totals.cashReceivedMinor).toBe('0');
    expect(both.totals.closingBalanceMinor).toBe('0');

    // Дневные категории согласованы с итогами периода и между отчётами.
    const dayGroup = (built: typeof both, date: string) =>
      built.days.find((day) => day.date === date)?.couriers[0];

    expect(dayGroup(both, DAY)?.deliveryFeesMinor).toBe(
      dayGroup(onDelivery, DAY)?.deliveryFeesMinor,
    );
    expect(dayGroup(both, NEXT_DAY)?.deliveryFeesMinor).toBe(
      dayGroup(onCancel, NEXT_DAY)?.deliveryFeesMinor,
    );
    expect(dayGroup(both, DAY)?.accruedMinor).toBe('30000');
    expect(dayGroup(both, NEXT_DAY)?.accruedMinor).toBe('-30000');

    // Сумма дневных категорий равна итогу периода.
    const sumDays = (field: 'deliveryFeesMinor' | 'distanceFeesMinor' | 'accruedMinor'): bigint =>
      both.days
        .flatMap((day) => day.couriers)
        .reduce((total, courier) => total + BigInt(courier[field]), 0n);
    expect(sumDays('deliveryFeesMinor')).toBe(BigInt(both.totals.deliveryFeesMinor));
    expect(sumDays('distanceFeesMinor')).toBe(BigInt(both.totals.distanceFeesMinor));
    expect(sumDays('accruedMinor')).toBe(0n);

    /*
     * Строка доставки осталась на своём дне и НЕ помечена снятой: снятие
     * пришло на следующий день и живёт там. Пометка на дне доставки прятала бы
     * настоящие деньги этого дня за словом «отменён».
     */
    const row = both.rows.find((item) => item.attemptId === delivery.attemptId);
    expect(row?.deliveryDate).toBe(DAY);
    expect(row?.financeCancelled).toBe(false);
    expect(row?.outcome).toBe('DELIVERED');
  });

  it('частичная → полная оплата → отмена не снимает дважды', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n, perOrder: 20_000n });

    await payInSource(delivery, 300_000n);
    await payInSource(delivery, 500_000n);
    // Наличные сняты ровно на начисленные 4 000 ₽.
    expect(await sumKind(delivery.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(-400_000n);

    await ctx.db.deliveryOrder.update({
      where: { id: delivery.orderId },
      data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
    });
    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
      }),
    );

    const both = await report(DAY, NEXT_DAY, delivery.courierId);
    expect(both.totals.cashReceivedMinor).toBe('0');
    expect(both.totals.cashCorrectionsMinor).toBe('0');
    expect(both.totals.deliveryFeesMinor).toBe('0');
    expect(both.totals.closingBalanceMinor).toBe('0');
    expect(await orderContribution(delivery.orderId)).toBe(0n);
  });

  it('начальный долг и его отмена не попадают в заработок', async () => {
    const delivery = await seedDelivered({ sum: 0n, payed: 0n, perOrder: 20_000n });
    const admin = await actorFor(['ADMIN']);

    const debt = await ctx.db.$transaction((tx) =>
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
    await ctx.db.$transaction((tx) =>
      reverseEntry(tx, {
        entryId: debt.id,
        actorUserId: admin.userId,
        reason: 'внесено по ошибке',
        operationDate: NEXT_DAY,
      }),
    );

    const both = await report(DAY, NEXT_DAY, delivery.courierId);
    // Долг и его отмена гасят друг друга в СВОЕЙ категории.
    expect(both.totals.openingDebtMinor).toBe('0');
    // И ни копейки из них не попало в зарплатные показатели.
    expect(both.totals.deliveryFeesMinor).toBe('20000');
    expect(both.totals.distanceFeesMinor).toBe('0');
    expect(both.totals.attemptFeesMinor).toBe('0');
    expect(both.totals.bonusesMinor).toBe('0');
    expect(both.totals.expensesMinor).toBe('0');
  });

  it('дневные итоги совпадают в отдельных отчётах и в общем', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n });
    await payInSource(delivery, 300_000n);

    const onDelivery = await report(DAY, DAY, delivery.courierId);
    const onCorrection = await report(NEXT_DAY, NEXT_DAY, delivery.courierId);
    const both = await report(DAY, NEXT_DAY, delivery.courierId);

    const dayTotal = (
      built: { days: { date: string; couriers: { totalMinor: string }[] }[] },
      date: string,
    ): bigint =>
      (built.days.find((day) => day.date === date)?.couriers ?? []).reduce(
        (total, courier) => total + BigInt(courier.totalMinor),
        0n,
      );

    expect(dayTotal(both, DAY)).toBe(dayTotal(onDelivery, DAY));
    expect(dayTotal(both, NEXT_DAY)).toBe(dayTotal(onCorrection, NEXT_DAY));
    expect(dayTotal(both, DAY)).toBe(400_000n);
    expect(dayTotal(both, NEXT_DAY)).toBe(-200_000n);
  });

  it('отмена следующего дня тоже остаётся в своём дне', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 0n, perOrder: 20_000n });

    // Отмена приходит на СЛЕДУЮЩИЙ день после доставки.
    await ctx.db.deliveryOrder.update({
      where: { id: delivery.orderId },
      data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
    });
    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
      }),
    );

    const both = await report(DAY, NEXT_DAY, delivery.courierId);

    // День доставки показывает то, что в нём действительно начислили.
    const deliveryDay = both.days.find((day) => day.date === DAY);
    expect(deliveryDay).toBeDefined();
    const row = both.rows.find((item) => item.attemptId === delivery.attemptId);
    expect(row?.cashMinor).toBe('500000');
    expect(row?.deliveryFeeMinor).toBe('20000');
    /*
     * Строка дня доставки «снятой» НЕ помечается: снятие лежит в следующем
     * дне, а этот день честно несёт свои 4 800 ₽ и полностью входит в итог
     * периода. Пометка здесь спрятала бы настоящие деньги за словом «отменён».
     */
    expect(row?.financeCancelled).toBe(false);
    expect(row?.totalMinor).toBe('480000');

    // День отмены существует и несёт обратные записи.
    const cancelDay = both.days.find((day) => day.date === NEXT_DAY);
    expect(cancelDay).toBeDefined();
    const reversals = (cancelDay?.couriers ?? []).flatMap((courier) => courier.operations.entries);
    expect(reversals.filter((entry) => entry.kind === 'ADJUSTMENT').length).toBeGreaterThan(0);

    // Вклад заказа за оба дня — ноль, и сумма групп объясняет баланс.
    expect(await orderContribution(delivery.orderId)).toBe(0n);
    const groups = both.days
      .flatMap((day) => day.couriers)
      .reduce((total, courier) => total + BigInt(courier.totalMinor), 0n);
    expect(groups).toBe(
      BigInt(both.totals.closingBalanceMinor) - BigInt(both.totals.openingBalanceMinor),
    );
  });

  it('день доставки: наличные начислены, корректировок нет', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n });
    await payInSource(delivery, 300_000n);

    const onDelivery = await report(DAY, DAY, delivery.courierId);
    expect(onDelivery.totals.cashReceivedMinor).toBe('400000');
    expect(onDelivery.totals.cashCorrectionsMinor).toBe('0');
    expect(onDelivery.totals.closingBalanceMinor).toBe('400000');
    const row = onDelivery.rows.find((item) => item.attemptId === delivery.attemptId);
    expect(row?.cashMinor).toBe('400000');
  });

  it('день корректировки: снятие показано минусом и отдельной строкой журнала', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n });
    await payInSource(delivery, 300_000n);

    const onCorrection = await report(NEXT_DAY, NEXT_DAY, delivery.courierId);

    // Приход наличных в этот день не возникает из ниоткуда.
    expect(onCorrection.totals.cashReceivedMinor).toBe('0');
    // Снятие — со знаком минус, а не модулем.
    expect(onCorrection.totals.cashCorrectionsMinor).toBe('-200000');
    // Баланс: 4 000 ₽ входящих минус 2 000 ₽ снятых.
    expect(onCorrection.totals.openingBalanceMinor).toBe('400000');
    expect(onCorrection.totals.closingBalanceMinor).toBe('200000');

    // Строка корректировки видна в дне её учёта, с заказом и основанием.
    const day = onCorrection.days.find((item) => item.date === NEXT_DAY);
    const operations = day?.couriers[0]?.operations.entries ?? [];
    const correction = operations.find((entry) => entry.kind === 'CASH_PAYMENT_CORRECTION');
    expect(correction).toBeDefined();
    expect(correction?.amountMinor).toBe('-200000');
    expect(correction?.orderId).toBe(delivery.orderId);
    expect(correction?.reason ?? '').toContain('Корректировка наличных: оплата в МойСклад');

    // Видимые движения объясняют изменение баланса.
    const visible = operations.reduce((total, entry) => total + BigInt(entry.amountMinor), 0n);
    expect(visible).toBe(
      BigInt(onCorrection.totals.closingBalanceMinor) -
        BigInt(onCorrection.totals.openingBalanceMinor),
    );
  });

  it('общий период: и начисление, и корректировка, без двойного учёта', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n });
    await payInSource(delivery, 300_000n);

    const both = await report(DAY, NEXT_DAY, delivery.courierId);
    expect(both.totals.cashReceivedMinor).toBe('400000');
    expect(both.totals.cashCorrectionsMinor).toBe('-200000');
    expect(both.totals.closingBalanceMinor).toBe(
      (await balanceOf(ctx.db, delivery.courierId, NEXT_DAY)).toString(),
    );

    /*
     * Каждая проводка — в СВОЁМ дне. Строка доставки берёт только записи своего
     * дня, корректировка остаётся операцией своего. Раньше при выборе обоих
     * дней корректировка пряталась внутрь строки, и день корректировки исчезал.
     */
    const row = both.rows.find((item) => item.attemptId === delivery.attemptId);
    expect(row?.cashMinor).toBe('400000');

    const correctionDay = both.days.find((day) => day.date === NEXT_DAY);
    expect(correctionDay).toBeDefined();
    const journal = (correctionDay?.couriers ?? []).flatMap(
      (courier) => courier.operations.entries,
    );
    expect(journal.some((entry) => entry.kind === 'CASH_PAYMENT_CORRECTION')).toBe(true);

    // Сумма итогов групп равна изменению баланса за период.
    const groups = both.days
      .flatMap((day) => day.couriers)
      .reduce((total, courier) => total + BigInt(courier.totalMinor), 0n);
    expect(groups).toBe(
      BigInt(both.totals.closingBalanceMinor) - BigInt(both.totals.openingBalanceMinor),
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
    const strip = (): Promise<boolean> =>
      ctx.db.$transaction((tx) =>
        stripCancelledOrderFinance(tx, {
          orderId: delivery.orderId,
          now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
        }),
      );

    // Первая отмена снимает начисления, вторая не находит что снимать — и это
    // не ошибка: результат «ничего не изменилось», без исключения.
    expect(await strip()).toBe(true);
    expect(await strip()).toBe(false);

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

// --- Гонки доставки и финансовой синхронизации --------------------------------

describe('порядок доставки и синхронизации не оставляет непоправленных денег', () => {
  /**
   * Отмена обработана РАНЬШЕ, чем доставка успела начислить.
   *
   * Так и выглядел найденный дефект: задание снимало пустой журнал, помечалось
   * DONE, а начисление появлялось следом — и возвращало отменённому заказу
   * ненулевой результат, снимать который уже некому.
   */
  it('начисление доставки по отменённому заказу не создаётся вовсе', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 0n, perOrder: 20_000n });

    // Заказ отменён, деньги сняты — журнал по нему пуст по вкладу.
    await ctx.db.deliveryOrder.update({
      where: { id: delivery.orderId },
      data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
    });
    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
      }),
    );
    expect(await orderContribution(delivery.orderId)).toBe(0n);

    // Повторная фиксация результата доставки (второй круг, пересчёт, гонка).
    const second = await seedAttemptFor(delivery);
    await accrueDeliveryResult(ctx.db, await readLedgerActivation(ctx.db), {
      attemptId: second,
      routeOrderId: delivery.routeOrderId,
      routeId: delivery.routeId,
      orderId: delivery.orderId,
      courierUserId: delivery.courierId,
      actorUserId: delivery.courierId,
      outcome: 'DELIVERED',
    });

    // Ни наличных, ни оплаты доставки: вклад остаётся нулевым.
    expect(await orderContribution(delivery.orderId)).toBe(0n);
    expect(await ctx.db.courierLedgerEntry.count({ where: { attemptId: second } })).toBe(0);
    // Физический факт доставки при этом сохранён.
    expect(await ctx.db.deliveryMoneyFact.count({ where: { attemptId: second } })).toBe(1);
  });

  it('поздний расчёт МКАД: неотменённому начисляет, отменённому — нет', async () => {
    const lateDistance = (delivery: Delivery): Promise<void> =>
      ctx.db.$transaction((tx) =>
        accrueDistanceFee(tx, {
          attemptId: delivery.attemptId,
          routeOrderId: delivery.routeOrderId,
          routeId: delivery.routeId,
          orderId: delivery.orderId,
          courierUserId: delivery.courierId,
          actorUserId: delivery.courierId,
          operationDate: NEXT_DAY,
          perKmMinor: 5_000n,
        }),
      );

    /*
     * КОНТРОЛЬ: обычный заказ с тем же снимком расстояния. Он доказывает, что
     * начисление вообще происходит, — иначе нулевой результат у отменённого
     * ничего не значил бы.
     */
    const control = await seedDelivered({ sum: 0n, payed: 0n, perOrder: 20_000n });
    await seedDistance(control, 20);
    await lateDistance(control);
    expect(await sumKind(control.orderId, 'DISTANCE_FEE')).toBe(-10_000n);

    // Тот же снимок и та же ставка, но заказ отменён в источнике.
    const cancelled = await seedDelivered({ sum: 0n, payed: 0n, perOrder: 20_000n });
    await seedDistance(cancelled, 20);
    await ctx.db.deliveryOrder.update({
      where: { id: cancelled.orderId },
      data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
    });
    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: cancelled.orderId,
        now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
      }),
    );

    await lateDistance(cancelled);

    expect(await sumKind(cancelled.orderId, 'DISTANCE_FEE')).toBe(0n);
    expect(await orderContribution(cancelled.orderId)).toBe(0n);
  });

  /**
   * Управляемый порядок: доставка прочитала СТАРУЮ оплату и держит транзакцию,
   * импорт и задание идут следом. Пауза не доказывает ничего сама по себе —
   * доказывает общая блокировка строки заказа: пока доставка не зафиксирована,
   * ни импорт, ни задание не проходят.
   */
  it('доставка со старой оплатой → импорт → задание: наличные обнуляются', async () => {
    /*
     * Заказ оплачен полностью, поэтому первая попытка наличных не начисляет:
     * в проверке участвует ровно одна доставка — управляемая.
     */
    const delivery = await seedDelivered({ sum: 500_000n, payed: 500_000n });
    expect(await sumKind(delivery.orderId, 'CASH_RECEIVED')).toBe(0n);

    // Источник «откатывает» оплату: доставка будет считать по 0 оплачено.
    await ctx.db.deliveryOrder.update({
      where: { id: delivery.orderId },
      data: { payedSumMinor: 0n, cashToCollectMinor: 500_000n, cashAnomaly: false },
    });

    const second = await seedAttemptFor(delivery);

    let accrued!: () => void;
    let release!: () => void;
    const accruedSignal = new Promise<void>((resolve) => (accrued = resolve));
    const releaseSignal = new Promise<void>((resolve) => (release = resolve));

    const activation = await readLedgerActivation(ctx.db);
    const deliveryTx = ctx.db.$transaction(
      async (tx) => {
        await accrueDeliveryResult(tx, activation, {
          attemptId: second,
          routeOrderId: delivery.routeOrderId,
          routeId: delivery.routeId,
          orderId: delivery.orderId,
          courierUserId: delivery.courierId,
          actorUserId: delivery.courierId,
          outcome: 'DELIVERED',
        });
        accrued();
        await releaseSignal;
      },
      { timeout: 20_000, maxWait: 20_000 },
    );

    await accruedSignal;

    // Импорт и задание стартуют ДО фиксации доставки и обязаны её дождаться.
    let importDone = false;
    const afterDelivery = (async (): Promise<void> => {
      await ctx.db.deliveryOrder.update({
        where: { id: delivery.orderId },
        data: { payedSumMinor: 500_000n, cashToCollectMinor: 0n },
      });
      await ctx.db.$transaction((tx) =>
        applyCashPaymentCorrection(tx, {
          orderId: delivery.orderId,
          now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
        }),
      );
      importDone = true;
    })();

    /*
     * Проверяется не «прошло время», а ФАКТ ожидания: импорт стоит на
     * блокировке строки заказа, пока доставка держит транзакцию. Вопрос
     * «кем заблокирован» задаётся напрямую, а не угадывается по wait_event.
     */
    const deadline = Date.now() + 10_000;
    let blocked = 0;
    while (Date.now() < deadline && blocked < 1) {
      const rows = await ctx.db.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count
        FROM pg_stat_activity
        WHERE cardinality(pg_blocking_pids(pid)) > 0
      `;
      blocked = Number(rows[0]?.count ?? 0n);
      if (blocked < 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(blocked).toBeGreaterThanOrEqual(1);
    expect(importDone).toBe(false);

    release();
    await deliveryTx;
    await afterDelivery;
    expect(importDone).toBe(true);

    // Начислено по старой оплате 5 000 ₽ и снято ровно столько же.
    expect(await sumKind(delivery.orderId, 'CASH_RECEIVED')).toBe(500_000n);
    expect(await sumKind(delivery.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(-500_000n);
    expect(await balanceOf(ctx.db, delivery.courierId, null)).toBe(0n);
  });
});

// --- Отменённый заказ в отчёте -------------------------------------------------

describe('отменённый заказ не остаётся в действующих начислениях', () => {
  it('колонки обнуляются, строка помечена, история проводок сохранена', async () => {
    const delivery = await seedDelivered({
      sum: 500_000n,
      payed: 0n,
      perOrder: 20_000n,
      distanceFee: 10_000n,
    });

    await ctx.db.deliveryOrder.update({
      where: { id: delivery.orderId },
      data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
    });
    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${DAY}T12:00:00.000Z`),
      }),
    );

    const built = await report(DAY, DAY, delivery.courierId);
    const row = built.rows.find((item) => item.attemptId === delivery.attemptId);

    // Заработок по отменённому заказу больше не начисляется.
    expect(row?.deliveryFeeMinor).toBe('0');
    expect(row?.distanceFeeMinor).toBe('0');
    expect(row?.cashMinor).toBe('0');
    expect(row?.totalMinor).toBe('0');
    expect(row?.financeCancelled).toBe(true);
    // Физический факт доставки остаётся.
    expect(row?.outcome).toBe('DELIVERED');

    // Итоги тоже без исходных начислений, а баланс сошёлся.
    expect(built.totals.deliveryFeesMinor).toBe('0');
    expect(built.totals.distanceFeesMinor).toBe('0');
    expect(built.totals.cashReceivedMinor).toBe('0');
    expect(built.totals.closingBalanceMinor).toBe('0');
    const group = built.days.find((day) => day.date === DAY)?.couriers[0];
    expect(group?.accruedMinor).toBe('0');

    // История проводок цела: и начисления, и их отмены на месте.
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { orderId: delivery.orderId, kind: 'DELIVERY_FEE' },
      }),
    ).toBe(1);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { orderId: delivery.orderId, kind: 'ADJUSTMENT' },
      }),
    ).toBe(3);
  });
});

// --- Содержимое выгрузки -------------------------------------------------------

describe('выгрузка показывает корректировки, а не только непустой файл', () => {
  it('XLSX отменённого периода: заработок обнулён, движения дней сохранены', async () => {
    const delivery = await seedDelivered({
      sum: 500_000n,
      payed: 0n,
      perOrder: 20_000n,
      distanceFee: 10_000n,
    });
    await ctx.db.deliveryOrder.update({
      where: { id: delivery.orderId },
      data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
    });
    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
      }),
    );

    const built = await report(DAY, NEXT_DAY, delivery.courierId);
    const workbook = new ExcelJS.Workbook();
    // ExcelJS объявляет собственный `Buffer extends ArrayBuffer`, несовместимый
    // с Buffer из Node. Приведение стоит на границе чужой декларации.
    await workbook.xlsx.load(
      (await buildSettlementWorkbook(built)) as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );

    const summary = workbook.getWorksheet('Итоги');
    const named = new Map<string, unknown>();
    summary?.eachRow((row) => named.set(String(row.getCell(1).value ?? ''), row.getCell(2).value));

    // За период заработка по отменённому заказу нет.
    expect(named.get('Базовая оплата доставок')).toBe(0);
    expect(named.get('Километры за МКАД')).toBe(0);
    expect(named.get('Наличные, полученные курьером')).toBe(0);
    expect(named.get('Конечный баланс')).toBe(0);

    /*
     * Дневные движения в листе «Заказы» сохранены.
     *
     * Строка дня доставки НЕ помечается снятой: снятие пришло на следующий
     * день. Её итог остаётся настоящим числом, а обратные записи видны
     * отдельной строкой своего дня — именно так это выглядит и на экране.
     */
    /*
     * Утверждения привязаны к КОНКРЕТНОЙ строке по столбцу «Уровень».
     *
     * Сбор значений по всему листу выполнялся бы и тогда, когда строка заказа
     * исчезла: её итог совпадает с итогом группы, и «есть такое число где-то
     * на листе» не доказывает ничего.
     */
    const rows = workbook.getWorksheet('Заказы');
    const orderRows: { total: unknown; note: string; date: unknown }[] = [];
    const dayRows: { total: unknown; date: unknown }[] = [];
    rows?.eachRow((row) => {
      const level = String(row.getCell(1).value ?? '');
      if (level === 'Заказ') {
        orderRows.push({
          total: row.getCell(21).value,
          note: String(row.getCell(22).value ?? ''),
          date: row.getCell(2).value,
        });
      }
      if (level === 'Итог дня') {
        dayRows.push({ total: row.getCell(21).value, date: row.getCell(2).value });
      }
    });

    // Строка заказа одна, стоит в дне доставки и несёт настоящий итог.
    expect(orderRows).toHaveLength(1);
    // 4 700 ₽: 5 000 наличных минус 200 оплаты работы и 100 МКАД.
    expect(orderRows[0]?.total).toBe(4700);
    expect(orderRows[0]?.date).toBe(DAY);
    // «Начисления дня сняты» к этому дню не относится — снятие в следующем.
    expect(orderRows[0]?.note).not.toContain('Начисления дня сняты');
    // Но отмена заказа в источнике названа прямо.
    expect(orderRows[0]?.note).toContain('Отменён в МоемСкладе');

    // День отмены показан отдельной группой и ровно тем же числом со знаком минус.
    expect(dayRows.find((row) => row.date === DAY)?.total).toBe(4700);
    expect(dayRows.find((row) => row.date === NEXT_DAY)?.total).toBe(-4700);
  });

  it('XLSX: подписи, знаки и суммы итогов и журнала', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n });
    await payInSource(delivery, 300_000n);

    // День корректировки: именно здесь снятие обязано читаться минусом.
    const built = await report(NEXT_DAY, NEXT_DAY, delivery.courierId);
    const workbook = new ExcelJS.Workbook();
    // ExcelJS объявляет собственный `Buffer extends ArrayBuffer`, несовместимый
    // с Buffer из Node. Приведение стоит на границе чужой декларации.
    await workbook.xlsx.load(
      (await buildSettlementWorkbook(built)) as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );

    const summary = workbook.getWorksheet('Итоги');
    const named = new Map<string, unknown>();
    summary?.eachRow((row) => {
      named.set(String(row.getCell(1).value ?? ''), row.getCell(2).value);
    });

    expect(named.get('Начальный баланс')).toBe(4000);
    expect(named.get('Наличные, полученные курьером')).toBe(0);
    // Знак сохранён: снятие показано отрицательным числом, а не модулем.
    expect(named.get('Корректировки наличных (оплата в МойСклад)')).toBe(-2000);
    expect(named.get('Конечный баланс')).toBe(2000);

    // Журнал выгрузки называет операцию и показывает её сумму со знаком.
    const operations = workbook.getWorksheet('Операции');
    const journal: { kind: string; amount: unknown }[] = [];
    operations?.eachRow((row) =>
      journal.push({ kind: String(row.getCell(7).value ?? ''), amount: row.getCell(8).value }),
    );
    const line = journal.find((item) => item.kind === 'Корректировка наличных: оплата в МойСклад');
    expect(line).toBeDefined();
    expect(line?.amount).toBe(-2000);
  });
});

// --- Обновление отчётов без F5 -------------------------------------------------

describe('автоматические корректировки публикуют финансовое событие', () => {
  /*
   * Курсор по идентификатору, а не по времени.
   *
   * `occurredAt` ставит СУБД, а отметку «до» брал процесс тестов: при малейшем
   * расхождении часов событие предыдущего шага попадало в окно следующего, и
   * проверка «лишнего события нет» становилась плавающей. Идентификатор
   * возрастает монотонно и от часов не зависит.
   */
  async function lastEventId(): Promise<bigint> {
    const row = await ctx.db.realtimeEvent.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    return row?.id ?? 0n;
  }

  /** События финансового журнала, появившиеся после курсора. */
  async function ledgerEventsAfter(cursor: bigint): Promise<{ audienceRoles: string[] }[]> {
    return ctx.db.realtimeEvent.findMany({
      where: { topic: 'finance.ledger_changed', id: { gt: cursor } },
      select: { audienceRoles: true },
    });
  }

  it('корректировка оплаты шлёт событие всем ролям отчёта', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n });
    await ctx.db.deliveryOrder.update({
      where: { id: delivery.orderId },
      data: { payedSumMinor: 300_000n, cashToCollectMinor: 200_000n },
    });

    const cursor = await lastEventId();
    const handler = createOrderFinanceHandler({
      now: () => new Date(`${NEXT_DAY}T09:00:00.000Z`),
    });
    await ctx.db.$transaction((tx) =>
      handler(
        {
          id: randomUUID(),
          topic: 'finance.order_sync',
          idempotencyKey: unique('job'),
          payload: { reason: 'PAYMENT', orderId: delivery.orderId },
          attempts: 0,
          maxAttempts: 5,
        },
        tx,
      ),
    );

    /*
     * Событие импорта заказа отчёт не инвалидирует и приходит раньше задания,
     * поэтому его недостаточно: нужно ИМЕННО финансовое событие и в той же
     * транзакции, что и запись в журнал.
     */
    const events = await ledgerEventsAfter(cursor);
    expect(events).toHaveLength(1);
    expect([...(events[0]?.audienceRoles ?? [])].sort()).toEqual([
      'ADMIN',
      'LOGISTICIAN',
      'SUPERVISOR',
    ]);
  });

  it('отмена шлёт событие, а задание без изменений — не шлёт', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 0n, perOrder: 20_000n });
    await ctx.db.deliveryOrder.update({
      where: { id: delivery.orderId },
      data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
    });

    const handler = createOrderFinanceHandler({
      now: () => new Date(`${NEXT_DAY}T09:00:00.000Z`),
    });
    const run = (): Promise<void> =>
      ctx.db.$transaction((tx) =>
        handler(
          {
            id: randomUUID(),
            topic: 'finance.order_sync',
            idempotencyKey: unique('job'),
            payload: { reason: 'CANCEL', orderId: delivery.orderId },
            attempts: 0,
            maxAttempts: 5,
          },
          tx,
        ),
      );

    const firstCursor = await lastEventId();
    await run();
    expect(await ledgerEventsAfter(firstCursor)).toHaveLength(1);

    // Повтор снимать уже нечего — лишнего события не появляется.
    const secondCursor = await lastEventId();
    await run();
    expect(await ledgerEventsAfter(secondCursor)).toHaveLength(0);
  });
});
