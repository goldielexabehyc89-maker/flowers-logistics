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
 *   • снятие ложится В ИСХОДНЫЕ ДНИ учёта каждой записи: отчёт за день доставки
 *     показывает по заказу нули, а день обработки отмены отдельного минуса не
 *     получает; реальное время записи и отметка снятия попытки исторической
 *     датой не подменяются;
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
import { fromDateColumn, toDateColumn } from '../integrations/moysklad/delivery-date.js';
import ExcelJS from 'exceljs';
import { accrueDeliveryResult, accrueDistanceFee, restateDistanceFee } from './accrual.js';
import { appendEntry, balanceOf, reverseEntry } from './ledger.js';
import { saveDistanceSnapshot } from './mkad.js';
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
/** День обработки отмены, когда она приходит не назавтра, а позже. */
const LATER_DAY = '2030-08-14';
/** Отмена через неделю: цепочка правок к этому моменту разнесена по трём дням. */
const WEEK_LATER = '2030-08-19';

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
  /** Ставка за километр в снимке маршрута: нужна проверкам правки километров. */
  perKm?: bigint;
  /** Уже начисленные километры за МКАД: снимок расстояния здесь не нужен. */
  distanceFee?: bigint;
  /** Курьер, у которого уже есть другие доставки; иначе заводится новый. */
  courierId?: string;
}): Promise<Delivery> {
  const admin = await actorFor(['ADMIN']);
  const courier =
    input.courierId === undefined
      ? await actorFor(['COURIER'])
      : ({ userId: input.courierId } as AuthenticatedActor);

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
      perKmMinor: input.perKm ?? 0n,
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

  /*
   * Снимок ставится ТОЙ ЖЕ функцией, что и боевой путь: она гасит прежний
   * действующий снимок, поэтому правку километров можно повторять. Прямая
   * вставка второй раз упиралась бы в уникальность `activeKey`.
   */
  await saveDistanceSnapshot(ctx.db, {
    routeOrderId: delivery.routeOrderId,
    ringVersionId: ring.id,
    graphSha256: null,
    meters: kmTenths * 100,
    insideMkad: false,
    source: 'MANUAL',
    actorUserId: admin.userId,
    reason: 'проверка позднего начисления',
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

/**
 * Источник отменил заказ.
 *
 * Отметку ставит тот же импорт, что и в проде: снятие денег выполняется
 * заданием и перепроверяет признак — состояния «задание есть, а заказ не
 * отменён» в продукте не бывает, и проверять функцию в нём бессмысленно.
 */
async function cancelInSource(delivery: Delivery): Promise<void> {
  await ctx.db.deliveryOrder.update({
    where: { id: delivery.orderId },
    data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
  });
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

/**
 * Обратные записи отмены заказа в источнике: день каждой, реальное время её
 * появления и снятая ею запись. По ним проверяется правило даты: сторно
 * ложится в день ИСХОДНОЙ записи, а не в день обработки отмены.
 */
async function cancellationReversals(orderId: string) {
  return ctx.db.courierLedgerEntry.findMany({
    where: { orderId, kind: 'ADJUSTMENT', reversalCause: 'ORDER_CANCELLED' },
    select: {
      operationDate: true,
      occurredAt: true,
      amountMinor: true,
      reversesEntry: { select: { kind: true, operationDate: true, amountMinor: true } },
    },
  });
}

/**
 * Переносы дня учёта по заказу: сторона, день, сумма и переносимая запись.
 *
 * Перенос — связанная пара обратных записей одной категории: OUT в дне
 * начисления, IN в дне его сторно. Сумма пары равна нулю.
 */
async function relocationsOf(orderId: string) {
  return ctx.db.courierLedgerEntry.findMany({
    where: { orderId, relocatesEntryId: { not: null } },
    select: {
      operationDate: true,
      amountMinor: true,
      relocationSide: true,
      reason: true,
      relocatesEntry: {
        select: { kind: true, amountMinor: true, operationDate: true, distanceKmTenths: true },
      },
    },
  });
}

/** Сжатая форма переноса для сравнения: сторона, сумма, день, вид и километры. */
function relocationShape(
  relocation: Awaited<ReturnType<typeof relocationsOf>>[number],
): [string | null, bigint, string, string | undefined, number | null | undefined] {
  return [
    relocation.relocationSide,
    relocation.amountMinor,
    fromDateColumn(relocation.operationDate),
    relocation.relocatesEntry?.kind,
    relocation.relocatesEntry?.distanceKmTenths,
  ];
}

/** Дни, в которых у заказа есть хотя бы одна запись журнала, по возрастанию. */
async function daysOf(orderId: string): Promise<string[]> {
  const rows = await ctx.db.courierLedgerEntry.findMany({
    where: { orderId },
    select: { operationDate: true },
    distinct: ['operationDate'],
  });
  return rows.map((row) => fromDateColumn(row.operationDate)).sort();
}

/** Сколько соединений СЕЙЧАС ждут чужую блокировку в этой базе. */
async function blockedBackends(): Promise<number> {
  const rows = await ctx.db.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count
    FROM pg_stat_activity
    WHERE cardinality(pg_blocking_pids(pid)) > 0
      AND datname = current_database()
  `;
  return Number(rows[0]?.count ?? 0n);
}

async function waitForBlocked(expected: number, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    seen = await blockedBackends();
    if (seen >= expected) {
      return seen;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return seen;
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
   * отмена на следующий день. Снятие ложится В ДЕНЬ ДОСТАВКИ — туда, где
   * начисления были учтены (решение владельца, 24.09.2026). День обработки
   * отмены отдельного минуса не получает, а за период отменённый заработок не
   * остаётся ни в одном показателе.
   */
  it('отмена следующего дня снимает начисления днём доставки, день отмены пуст', async () => {
    const delivery = await seedDelivered({
      sum: 500_000n,
      payed: 0n,
      perOrder: 20_000n,
      distanceFee: 10_000n,
    });

    await cancelInSource(delivery);
    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
      }),
    );

    const onDelivery = await report(DAY, DAY, delivery.courierId);
    const onCancel = await report(NEXT_DAY, NEXT_DAY, delivery.courierId);
    const both = await report(DAY, NEXT_DAY, delivery.courierId);

    // День доставки: по заказу нули во всех трёх категориях — снятие лежит здесь же.
    expect(onDelivery.totals.deliveryFeesMinor).toBe('0');
    expect(onDelivery.totals.distanceFeesMinor).toBe('0');
    expect(onDelivery.totals.cashReceivedMinor).toBe('0');
    expect(onDelivery.totals.closingBalanceMinor).toBe('0');

    // День обработки отмены: ни минуса, ни группы — денег в этот день не двигали.
    expect(onCancel.totals.deliveryFeesMinor).toBe('0');
    expect(onCancel.totals.distanceFeesMinor).toBe('0');
    expect(onCancel.totals.cashReceivedMinor).toBe('0');
    expect(onCancel.totals.openingBalanceMinor).toBe('0');
    expect(onCancel.totals.closingBalanceMinor).toBe('0');
    expect(onCancel.days).toHaveLength(0);

    // Весь период: заработка нет, баланс ноль, единственный день — день доставки.
    expect(both.totals.deliveryFeesMinor).toBe('0');
    expect(both.totals.distanceFeesMinor).toBe('0');
    expect(both.totals.cashReceivedMinor).toBe('0');
    expect(both.totals.closingBalanceMinor).toBe('0');
    expect(both.days.map((day) => day.date)).toEqual([DAY]);

    // Дневная группа согласована между отдельным и общим отчётом.
    const dayGroup = (built: typeof both, date: string) =>
      built.days.find((day) => day.date === date)?.couriers[0];
    expect(dayGroup(both, DAY)?.deliveryFeesMinor).toBe(
      dayGroup(onDelivery, DAY)?.deliveryFeesMinor,
    );
    expect(dayGroup(both, DAY)?.accruedMinor).toBe('0');
    expect(dayGroup(both, DAY)?.cashMinor).toBe('0');
    expect(dayGroup(both, DAY)?.totalMinor).toBe('0');

    /*
     * Строка доставки стоит в своём дне: факт доставки сохранён, а деньги этого
     * дня сняты целиком и помечены — ровно как при отмене в тот же день.
     */
    const row = both.rows.find((item) => item.attemptId === delivery.attemptId);
    expect(row?.deliveryDate).toBe(DAY);
    expect(row?.outcome).toBe('DELIVERED');
    expect(row?.financeCancelled).toBe(true);
    expect(row?.sourceCancelled).toBe(true);
    expect(row?.cashMinor).toBe('0');
    expect(row?.deliveryFeeMinor).toBe('0');
    expect(row?.distanceFeeMinor).toBe('0');
    expect(row?.totalMinor).toBe('0');
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

  it('отмена следующего дня не создаёт своего дня: снятие лежит в дне доставки', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 0n, perOrder: 20_000n });

    // Отмена приходит на СЛЕДУЮЩИЙ день после доставки.
    await cancelInSource(delivery);
    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
      }),
    );

    const both = await report(DAY, NEXT_DAY, delivery.courierId);

    // Единственный день периода — день доставки; дня отмены в отчёте нет.
    expect(both.days.map((day) => day.date)).toEqual([DAY]);

    /*
     * Строка дня доставки: факт сохранён, деньги дня сняты целиком и помечены.
     * Начисления и их снятие лежат в одной строке одного дня, поэтому в журнале
     * операций ни того, ни другого нет — двойного показа не возникает.
     */
    const row = both.rows.find((item) => item.attemptId === delivery.attemptId);
    expect(row?.outcome).toBe('DELIVERED');
    expect(row?.cashMinor).toBe('0');
    expect(row?.deliveryFeeMinor).toBe('0');
    expect(row?.totalMinor).toBe('0');
    expect(row?.financeCancelled).toBe(true);
    expect(row?.sourceCancelled).toBe(true);
    const journal = both.days
      .flatMap((day) => day.couriers)
      .flatMap((courier) => courier.operations.entries);
    expect(journal).toHaveLength(0);

    // История периода цела: и начисления, и их снятие — все днём доставки.
    expect(both.entries.filter((entry) => entry.kind === 'ADJUSTMENT')).toHaveLength(2);
    expect(both.entries.every((entry) => entry.operationDate === DAY)).toBe(true);

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

    await cancelInSource(delivery);
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

    await cancelInSource(delivery);
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
    await cancelInSource(delivery);
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

  it('отмену успели снять до выполнения задания — деньги остаются на месте', async () => {
    /*
     * Задание выполняется отдельно и при неудачах откладывается с отсрочкой до
     * пятнадцати минут. За это время отмену в источнике успевают снять: заказ
     * возвращается в работу, и снимать его деньги уже не за что. Соседние
     * обработчики признак перепроверяют, а снятие — не перепроверяло.
     */
    const delivery = await seedDelivered({ sum: 500_000n, payed: 0n, perOrder: 20_000n });
    const before = await balanceOf(ctx.db, delivery.courierId, null);

    await cancelInSource(delivery);
    // Отмену сняли ДО того, как задание дошло до очереди.
    await ctx.db.deliveryOrder.update({
      where: { id: delivery.orderId },
      data: { cancelledInSource: false, cancelledInSourceAt: null },
    });

    const changed = await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
      }),
    );

    expect(changed).toBe(false);
    expect(await balanceOf(ctx.db, delivery.courierId, null)).toBe(before);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { orderId: delivery.orderId, kind: 'ADJUSTMENT' },
      }),
    ).toBe(0);
  });

  it('оплата, пришедшая после отмены, оставляет результат нулевым', async () => {
    const delivery = await seedDelivered({ sum: 500_000n, payed: 0n });
    await cancelInSource(delivery);
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

    // Другой заказ того же курьера в тот же день: соседняя отмена его не касается.
    const control = await seedDelivered({
      sum: 300_000n,
      payed: 0n,
      perOrder: 20_000n,
      courierId: delivery.courierId,
    });
    const controlContribution = await orderContribution(control.orderId);
    expect(controlContribution).toBe(300_000n - 20_000n);

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

    await cancelInSource(delivery);
    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${NEXT_DAY}T09:00:00.000Z`),
      }),
    );

    // Доставка обнулена, а всё остальное осталось как было.
    expect(await orderContribution(delivery.orderId)).toBe(0n);
    expect(await balanceOf(ctx.db, delivery.courierId, null)).toBe(untouched + controlContribution);
    expect(await sumKind(delivery.orderId, 'OPENING_DEBT')).toBe(0n);

    // У соседнего заказа не снято ничего: ни одной обратной записи, вклад прежний.
    expect(await orderContribution(control.orderId)).toBe(controlContribution);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { orderId: control.orderId, reversedBy: { isNot: null } },
      }),
    ).toBe(0);
    // Ручные операции курьера не снимались и не помечены снятыми.
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: {
          courierUserId: delivery.courierId,
          kind: { in: ['OPENING_DEBT', 'CASH_HANDED_TO_LOGIST'] },
          reversedBy: { isNot: null },
        },
      }),
    ).toBe(0);
  });
});

// --- Дата снятия: исходные дни учёта -------------------------------------------

describe('отмена в источнике снимает начисления исходными днями их учёта', () => {
  /*
   * Курьер отвёз, а заказ позже отменили в МоемСкладе. Владелец решил
   * (24.09.2026): системные начисления снимаются в тех днях, где были учтены,
   * а не днём обработки отмены. Отчёт за день доставки показывает по заказу
   * нули, в дне обработки отдельного минуса нет. Факт доставки, история
   * начислений и реальное время отмены сохраняются.
   */
  it('сторно каждой записи ложится в день её учёта, а день обработки остаётся пустым', async () => {
    const delivery = await seedDelivered({
      sum: 500_000n,
      payed: 0n,
      perOrder: 20_000n,
      distanceFee: 10_000n,
    });
    const processedAt = new Date(`${LATER_DAY}T09:00:00.000Z`);
    const startedAt = Date.now();

    await cancelInSource(delivery);
    expect(
      await ctx.db.$transaction((tx) =>
        stripCancelledOrderFinance(tx, { orderId: delivery.orderId, now: processedAt }),
      ),
    ).toBe(true);

    const reversals = await cancellationReversals(delivery.orderId);
    expect(reversals.map((reversal) => reversal.reversesEntry?.kind).sort()).toEqual([
      'CASH_RECEIVED',
      'DELIVERY_FEE',
      'DISTANCE_FEE',
    ]);
    for (const reversal of reversals) {
      // Дата учёта — из ИСХОДНОЙ записи, а не из момента обработки отмены.
      expect(fromDateColumn(reversal.operationDate)).toBe(
        fromDateColumn(reversal.reversesEntry?.operationDate ?? new Date(0)),
      );
      expect(fromDateColumn(reversal.operationDate)).toBe(DAY);
      expect(reversal.amountMinor).toBe(-(reversal.reversesEntry?.amountMinor ?? 0n));
      // Реальное время появления записи исторической датой не подменяется.
      expect(reversal.occurredAt.getTime()).toBeGreaterThanOrEqual(startedAt - 60_000);
    }
    // В дне обработки отмены у заказа нет ни одной записи.
    expect(await daysOf(delivery.orderId)).toEqual([DAY]);

    // Отметка снятия — фактическим временем обработки, не днём доставки.
    const attempt = await ctx.db.deliveryAttempt.findUniqueOrThrow({
      where: { id: delivery.attemptId },
      select: { financeStrippedAt: true },
    });
    expect(attempt.financeStrippedAt?.toISOString()).toBe(processedAt.toISOString());

    expect(await orderContribution(delivery.orderId)).toBe(0n);
    expect(await balanceOf(ctx.db, delivery.courierId, DAY)).toBe(0n);
    expect((await report(LATER_DAY, LATER_DAY, delivery.courierId)).days).toHaveLength(0);
  });

  it('оплата другим днём, отмена третьим: наличные и корректировка снимаются каждая своим днём', async () => {
    // Заказ 5 000 ₽, до доставки оплачено 1 000 ₽ → за курьером 4 000 ₽.
    const delivery = await seedDelivered({ sum: 500_000n, payed: 100_000n, perOrder: 20_000n });
    // Оплата выросла на следующий день: корректировка −2 000 ₽ учтена этим днём.
    await payInSource(delivery, 300_000n);
    expect(await sumKind(delivery.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(-200_000n);

    await cancelInSource(delivery);
    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${LATER_DAY}T09:00:00.000Z`),
      }),
    );

    // Наличные и оплата работы — днём доставки, корректировка — днём оплаты.
    const reversals = await cancellationReversals(delivery.orderId);
    expect(reversals).toHaveLength(3);
    const dated = new Map(
      reversals.map((reversal) => [
        reversal.reversesEntry?.kind,
        fromDateColumn(reversal.operationDate),
      ]),
    );
    expect(dated.get('CASH_RECEIVED')).toBe(DAY);
    expect(dated.get('DELIVERY_FEE')).toBe(DAY);
    expect(dated.get('CASH_PAYMENT_CORRECTION')).toBe(NEXT_DAY);
    expect(await daysOf(delivery.orderId)).toEqual([DAY, NEXT_DAY]);

    // День доставки: наличных и оплаты нет, корректировок в нём не появилось.
    const onDelivery = await report(DAY, DAY, delivery.courierId);
    expect(onDelivery.totals.cashReceivedMinor).toBe('0');
    expect(onDelivery.totals.cashCorrectionsMinor).toBe('0');
    expect(onDelivery.totals.deliveryFeesMinor).toBe('0');
    expect(onDelivery.totals.closingBalanceMinor).toBe('0');

    // День оплаты: корректировка погашена в своём дне, журнал объясняет ноль.
    const onPayment = await report(NEXT_DAY, NEXT_DAY, delivery.courierId);
    expect(onPayment.totals.cashCorrectionsMinor).toBe('0');
    expect(onPayment.totals.openingBalanceMinor).toBe('0');
    expect(onPayment.totals.closingBalanceMinor).toBe('0');
    const journal = (onPayment.days.find((day) => day.date === NEXT_DAY)?.couriers ?? []).flatMap(
      (courier) => courier.operations.entries,
    );
    expect(journal.map((entry) => entry.kind).sort()).toEqual([
      'ADJUSTMENT',
      'CASH_PAYMENT_CORRECTION',
    ]);

    // День обработки отмены пуст; снято ровно по разу — 4 000 ₽, а не 4 000 и ещё 2 000.
    expect((await report(LATER_DAY, LATER_DAY, delivery.courierId)).days).toHaveLength(0);
    expect(await orderContribution(delivery.orderId)).toBe(0n);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { orderId: delivery.orderId, kind: 'ADJUSTMENT' },
      }),
    ).toBe(3);
  });

  /** Километры за МКАД, посчитанные уже после доставки, по ставке снимка маршрута. */
  async function lateDistance(delivery: Delivery, perKmMinor: bigint): Promise<void> {
    await ctx.db.$transaction((tx) =>
      accrueDistanceFee(tx, {
        attemptId: delivery.attemptId,
        routeOrderId: delivery.routeOrderId,
        routeId: delivery.routeId,
        orderId: delivery.orderId,
        courierUserId: delivery.courierId,
        actorUserId: delivery.courierId,
        operationDate: DAY,
        perKmMinor,
      }),
    );
  }

  async function restate(delivery: Delivery, operationDate: string): Promise<boolean> {
    const admin = await actorFor(['ADMIN']);
    return ctx.db.$transaction((tx) =>
      restateDistanceFee(tx, {
        routeOrderId: delivery.routeOrderId,
        actorUserId: admin.userId,
        reason: 'Правка километров: маршрут построен по неверной точке',
        operationDate,
      }),
    );
  }

  /** Задание отмены, обработанное в указанный день. */
  function strip(delivery: Delivery, day: string): Promise<boolean> {
    return ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${day}T09:00:00.000Z`),
      }),
    );
  }

  /** День по заказу в нуле: категории, «прочие корректировки» и вклад в баланс. */
  function expectDayZero(built: Awaited<ReturnType<typeof report>>): void {
    expect(built.totals.cashReceivedMinor).toBe('0');
    expect(built.totals.cashCorrectionsMinor).toBe('0');
    expect(built.totals.deliveryFeesMinor).toBe('0');
    expect(built.totals.distanceFeesMinor).toBe('0');
    expect(built.totals.adjustmentsMinor).toBe('0');
    expect(
      BigInt(built.totals.closingBalanceMinor) - BigInt(built.totals.openingBalanceMinor),
    ).toBe(0n);
    for (const group of built.days.flatMap((day) => day.couriers)) {
      expect(group.distanceFeesMinor).toBe('0');
      expect(group.distanceKmTenths).toBe(0);
      expect(group.totalMinor).toBe('0');
    }
  }

  /** Снятие отмены не возвращает деньги: ни правкой километров, ни поздним расчётом. */
  async function expectNoRevival(delivery: Delivery, kmTenths: number): Promise<void> {
    const before = await ctx.db.courierLedgerEntry.count({ where: { orderId: delivery.orderId } });
    await ctx.db.deliveryOrder.update({
      where: { id: delivery.orderId },
      data: { cancelledInSource: false, cancelledInSourceAt: null },
    });
    await seedDistance(delivery, kmTenths);
    expect(await restate(delivery, WEEK_LATER)).toBe(false);
    await lateDistance(delivery, 4_000n);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { orderId: delivery.orderId, kind: 'DISTANCE_FEE', reversedBy: { is: null } },
      }),
    ).toBe(0);
    expect(await ctx.db.courierLedgerEntry.count({ where: { orderId: delivery.orderId } })).toBe(
      before,
    );
    expect(await orderContribution(delivery.orderId)).toBe(0n);
  }

  /*
   * Цепочка правок километров в разных днях. Владелец подтвердил: после отмены
   * заказа КАЖДЫЙ исходный день по заказу в нуле, включая пересчитанный МКАД.
   * Прежнее начисление уже погашено сторно другого дня, второй раз его снять
   * нельзя — поэтому его учёт ПЕРЕНОСИТСЯ в день сторно связанной парой
   * записей той же категории и с теми же километрами; сумма пары — ноль.
   */
  it('километры пересчитаны другим днём: после отмены оба дня по заказу в нуле, перенос связан и хранит километры', async () => {
    // Ставка 40 ₽/км; на момент доставки расстояния нет — километры приходят позже.
    const delivery = await seedDelivered({
      sum: 500_000n,
      payed: 0n,
      perOrder: 20_000n,
      perKm: 4_000n,
    });
    await seedDistance(delivery, 125);
    await lateDistance(delivery, 4_000n);
    expect(await sumKind(delivery.orderId, 'DISTANCE_FEE')).toBe(-50_000n);

    // Правка километров на следующий день: 12,5 → 20,0 км, деньги — днём правки.
    await seedDistance(delivery, 200);
    expect(await restate(delivery, NEXT_DAY)).toBe(true);
    expect(await sumKind(delivery.orderId, 'DISTANCE_FEE')).toBe(-80_000n);
    // До отмены дни живут по правилу правки: 500 ₽ в дне доставки, +300 ₽ в дне правки.
    expect((await report(DAY, DAY, delivery.courierId)).totals.distanceFeesMinor).toBe('50000');
    expect((await report(NEXT_DAY, NEXT_DAY, delivery.courierId)).totals.distanceFeesMinor).toBe(
      '30000',
    );

    await cancelInSource(delivery);
    expect(await strip(delivery, LATER_DAY)).toBe(true);

    // 1. Каждый исходный день — в нуле по всем категориям; день отмены пуст.
    const onDelivery = await report(DAY, DAY, delivery.courierId);
    expectDayZero(onDelivery);
    const onRestatement = await report(NEXT_DAY, NEXT_DAY, delivery.courierId);
    expectDayZero(onRestatement);
    expect(onRestatement.totals.openingBalanceMinor).toBe('0');
    expect((await report(LATER_DAY, LATER_DAY, delivery.courierId)).days).toHaveLength(0);
    expect(await daysOf(delivery.orderId)).toEqual([DAY, NEXT_DAY]);
    expect(await orderContribution(delivery.orderId)).toBe(0n);

    // Строка дня доставки: деньги и километры дня сняты целиком, факт сохранён.
    const row = onDelivery.rows.find((item) => item.attemptId === delivery.attemptId);
    expect(row?.outcome).toBe('DELIVERED');
    expect(row?.distanceFeeMinor).toBe('0');
    expect(row?.beyondMkadKmTenths).toBe(0);
    expect(row?.totalMinor).toBe('0');
    expect(row?.financeCancelled).toBe(true);

    // 2. Действующие записи сняты сторно в своих днях.
    const reversals = await cancellationReversals(delivery.orderId);
    expect(
      reversals
        .map((reversal) => [
          reversal.reversesEntry?.kind,
          reversal.reversesEntry?.amountMinor,
          fromDateColumn(reversal.operationDate),
        ])
        .sort(),
    ).toEqual([
      ['CASH_RECEIVED', 500_000n, DAY],
      ['DELIVERY_FEE', -20_000n, DAY],
      ['DISTANCE_FEE', -80_000n, NEXT_DAY],
    ]);

    // 3. Прежние километры перенесены связанной парой: из дня доставки в день правки.
    const relocations = await relocationsOf(delivery.orderId);
    expect(relocations.map(relocationShape).sort()).toEqual([
      ['IN', -50_000n, NEXT_DAY, 'DISTANCE_FEE', 125],
      ['OUT', 50_000n, DAY, 'DISTANCE_FEE', 125],
    ]);
    // Сумма переноса — ноль: общий баланс он не меняет.
    expect(relocations.reduce((total, item) => total + item.amountMinor, 0n)).toBe(0n);
    // Сторно правки не переписано и не задвоено; исходные записи целы.
    const restated = await ctx.db.courierLedgerEntry.findMany({
      where: { orderId: delivery.orderId, reversalCause: 'DISTANCE_RESTATED' },
      select: { operationDate: true, reversesEntry: { select: { amountMinor: true } } },
    });
    expect(restated).toHaveLength(1);
    expect(fromDateColumn(restated[0]?.operationDate ?? new Date(0))).toBe(NEXT_DAY);
    expect(restated[0]?.reversesEntry?.amountMinor).toBe(-50_000n);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { orderId: delivery.orderId, kind: 'DISTANCE_FEE' },
      }),
    ).toBe(2);

    // 4. Выгрузка называет перенос своей категорией, а день правки сходится в ноль.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await buildSettlementWorkbook(
        await report(DAY, LATER_DAY, delivery.courierId),
      )) as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const operations = workbook.getWorksheet('Операции');
    const lines: { level: string; date: unknown; kind: string; amount: unknown }[] = [];
    operations?.eachRow((line) =>
      lines.push({
        level: String(line.getCell(1).value ?? ''),
        date: line.getCell(2).value,
        kind: String(line.getCell(7).value ?? ''),
        amount: line.getCell(8).value,
      }),
    );
    expect(
      lines.find((line) => line.kind === 'Перенос учёта в день: Оплата километров за МКАД'),
    ).toMatchObject({ date: NEXT_DAY, amount: -500 });
    expect(lines.find((line) => line.level === 'Итог дня' && line.date === NEXT_DAY)?.amount).toBe(
      0,
    );
    const orders = workbook.getWorksheet('Заказы');
    const orderLines: { total: unknown; note: string }[] = [];
    const header = (orders?.getRow(1).values as unknown[]).map((name) => String(name ?? ''));
    orders?.eachRow((line) => {
      if (String(line.getCell(1).value ?? '') === 'Заказ') {
        orderLines.push({
          total: line.getCell(header.indexOf('Итог, ₽')).value,
          note: String(line.getCell(header.indexOf('Примечание')).value ?? ''),
        });
      }
    });
    expect(orderLines).toHaveLength(1);
    expect(orderLines[0]?.total).toBe(0);
    expect(orderLines[0]?.note).toContain('Начисления дня сняты');

    // 5. Повтор ничего не добавляет: цепочка уже выверена в ноль.
    const total = await ctx.db.courierLedgerEntry.count({ where: { orderId: delivery.orderId } });
    expect(await strip(delivery, LATER_DAY)).toBe(false);
    expect(await ctx.db.courierLedgerEntry.count({ where: { orderId: delivery.orderId } })).toBe(
      total,
    );

    // 6. Нового активного начисления нет, а снятие отмены денег не возвращает.
    await expectNoRevival(delivery, 300);
  });

  it('километры обнулены другим днём и других начислений нет: отмена переносит учёт и обнуляет оба дня', async () => {
    // Заказ оплачен полностью, ставка за заказ нулевая: единственное начисление — километры.
    const delivery = await seedDelivered({ sum: 300_000n, payed: 300_000n, perKm: 4_000n });
    await seedDistance(delivery, 125);
    await lateDistance(delivery, 4_000n);
    expect(await orderContribution(delivery.orderId)).toBe(-50_000n);

    // На следующий день километры обнулили: адрес внутри МКАД.
    await seedDistance(delivery, 0);
    expect(await restate(delivery, NEXT_DAY)).toBe(true);
    expect(await orderContribution(delivery.orderId)).toBe(0n);
    // До отмены дни живут по правилу правки: +500 ₽ в дне доставки, −500 ₽ в дне правки.
    expect((await report(DAY, DAY, delivery.courierId)).totals.distanceFeesMinor).toBe('50000');
    expect((await report(NEXT_DAY, NEXT_DAY, delivery.courierId)).totals.distanceFeesMinor).toBe(
      '-50000',
    );

    const processedAt = new Date(`${LATER_DAY}T09:00:00.000Z`);
    await cancelInSource(delivery);
    /*
     * Действующих начислений нет — но снимать есть что: учёт разнесён по двум
     * дням. Отбор «есть непогашенная запись» такой заказ пропускал бы вовсе.
     */
    expect(
      await ctx.db.$transaction((tx) =>
        stripCancelledOrderFinance(tx, { orderId: delivery.orderId, now: processedAt }),
      ),
    ).toBe(true);

    expectDayZero(await report(DAY, DAY, delivery.courierId));
    expectDayZero(await report(NEXT_DAY, NEXT_DAY, delivery.courierId));
    expect((await report(LATER_DAY, LATER_DAY, delivery.courierId)).days).toHaveLength(0);
    expect(await daysOf(delivery.orderId)).toEqual([DAY, NEXT_DAY]);

    const row = (await report(DAY, DAY, delivery.courierId)).rows.find(
      (item) => item.attemptId === delivery.attemptId,
    );
    expect(row?.distanceFeeMinor).toBe('0');
    expect(row?.beyondMkadKmTenths).toBe(0);
    expect(row?.totalMinor).toBe('0');
    expect(row?.financeCancelled).toBe(true);

    // Сторно отмены нет — нечего снимать; есть ровно один перенос с километрами.
    expect(await cancellationReversals(delivery.orderId)).toHaveLength(0);
    const relocations = await relocationsOf(delivery.orderId);
    expect(relocations.map(relocationShape).sort()).toEqual([
      ['IN', -50_000n, NEXT_DAY, 'DISTANCE_FEE', 125],
      ['OUT', 50_000n, DAY, 'DISTANCE_FEE', 125],
    ]);
    // Отметка снятия стоит фактическим временем обработки.
    const attempt = await ctx.db.deliveryAttempt.findUniqueOrThrow({
      where: { id: delivery.attemptId },
      select: { financeStrippedAt: true },
    });
    expect(attempt.financeStrippedAt?.toISOString()).toBe(processedAt.toISOString());

    // Повтор задания — без изменений; снятие отмены денег не возвращает.
    expect(await strip(delivery, LATER_DAY)).toBe(false);
    await expectNoRevival(delivery, 200);
  });

  it('несколько правок в разных днях: после отмены каждый день цепочки в нуле', async () => {
    // День доставки: 12,5 км (500 ₽); назавтра 20 км (800 ₽); ещё через день 30 км (1 200 ₽).
    const delivery = await seedDelivered({ sum: 300_000n, payed: 300_000n, perKm: 4_000n });
    await seedDistance(delivery, 125);
    await lateDistance(delivery, 4_000n);
    await seedDistance(delivery, 200);
    expect(await restate(delivery, NEXT_DAY)).toBe(true);
    await seedDistance(delivery, 300);
    expect(await restate(delivery, LATER_DAY)).toBe(true);
    expect(await sumKind(delivery.orderId, 'DISTANCE_FEE')).toBe(-120_000n);
    expect(await orderContribution(delivery.orderId)).toBe(-120_000n);

    // Отмена через неделю.
    await cancelInSource(delivery);
    expect(await strip(delivery, WEEK_LATER)).toBe(true);

    for (const day of [DAY, NEXT_DAY, LATER_DAY]) {
      expectDayZero(await report(day, day, delivery.courierId));
    }
    expect((await report(WEEK_LATER, WEEK_LATER, delivery.courierId)).days).toHaveLength(0);
    expect(await daysOf(delivery.orderId)).toEqual([DAY, NEXT_DAY, LATER_DAY]);
    expect(await orderContribution(delivery.orderId)).toBe(0n);
    expect(await balanceOf(ctx.db, delivery.courierId, WEEK_LATER)).toBe(0n);

    // Действующая запись снята в своём дне; две прежних перенесены — каждая в день своего сторно.
    const reversals = await cancellationReversals(delivery.orderId);
    expect(
      reversals.map((reversal) => [
        reversal.reversesEntry?.amountMinor,
        fromDateColumn(reversal.operationDate),
      ]),
    ).toEqual([[-120_000n, LATER_DAY]]);
    expect((await relocationsOf(delivery.orderId)).map(relocationShape).sort()).toEqual([
      ['IN', -50_000n, NEXT_DAY, 'DISTANCE_FEE', 125],
      ['IN', -80_000n, LATER_DAY, 'DISTANCE_FEE', 200],
      ['OUT', 50_000n, DAY, 'DISTANCE_FEE', 125],
      ['OUT', 80_000n, NEXT_DAY, 'DISTANCE_FEE', 200],
    ]);
    // Период целиком: ни одной категории с остатком, дни — только исходные.
    const period = await report(DAY, WEEK_LATER, delivery.courierId);
    expectDayZero(period);
    expect(period.days.map((day) => day.date)).toEqual([LATER_DAY, NEXT_DAY, DAY]);

    expect(await strip(delivery, WEEK_LATER)).toBe(false);
    await expectNoRevival(delivery, 400);
  });

  it('после переноса снятая отмена и новая законная доставка начисляют и правят километры как обычно', async () => {
    const delivery = await seedDelivered({ sum: 300_000n, payed: 300_000n, perKm: 4_000n });
    await seedDistance(delivery, 125);
    await lateDistance(delivery, 4_000n);
    await seedDistance(delivery, 200);
    expect(await restate(delivery, NEXT_DAY)).toBe(true);
    await cancelInSource(delivery);
    expect(await strip(delivery, LATER_DAY)).toBe(true);
    expect(await orderContribution(delivery.orderId)).toBe(0n);

    // Отмену сняли, прежний результат закрыт, заказ везут заново — новой попыткой.
    await ctx.db.deliveryOrder.update({
      where: { id: delivery.orderId },
      data: { cancelledInSource: false, cancelledInSourceAt: null },
    });
    await ctx.db.deliveryAttempt.update({
      where: { id: delivery.attemptId },
      data: { activeKey: null },
    });
    const fresh = await ctx.db.deliveryAttempt.create({
      data: {
        routeOrderId: delivery.routeOrderId,
        orderId: delivery.orderId,
        routeId: delivery.routeId,
        outcome: 'DELIVERED',
        courierUserId: delivery.courierId,
        activeKey: delivery.routeOrderId,
      },
      select: { id: true },
    });
    await accrueDeliveryResult(ctx.db, await readLedgerActivation(ctx.db), {
      attemptId: fresh.id,
      routeOrderId: delivery.routeOrderId,
      routeId: delivery.routeId,
      orderId: delivery.orderId,
      courierUserId: delivery.courierId,
      actorUserId: delivery.courierId,
      outcome: 'DELIVERED',
    });
    // Новая попытка законно получает 800 ₽ за 20 км по действующему снимку.
    expect(await sumKind(delivery.orderId, 'DISTANCE_FEE')).toBe(-80_000n);
    expect(await orderContribution(delivery.orderId)).toBe(-80_000n);

    // И правка километров новой доставки работает: старый перенос ей не мешает.
    await seedDistance(delivery, 300);
    expect(await restate(delivery, WEEK_LATER)).toBe(true);
    expect(await sumKind(delivery.orderId, 'DISTANCE_FEE')).toBe(-120_000n);
    expect(await orderContribution(delivery.orderId)).toBe(-120_000n);
    // Записи прежней попытки не тронуты: переносов ровно один, новых по ней нет.
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { attemptId: delivery.attemptId, relocatesEntryId: { not: null } },
      }),
    ).toBe(2);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { attemptId: fresh.id, relocatesEntryId: { not: null } },
      }),
    ).toBe(0);
  });

  it('километры пересчитаны в день доставки: после отмены день доставки по заказу пуст целиком', async () => {
    const delivery = await seedDelivered({
      sum: 500_000n,
      payed: 0n,
      perOrder: 20_000n,
      perKm: 4_000n,
    });
    await seedDistance(delivery, 125);
    await lateDistance(delivery, 4_000n);
    await seedDistance(delivery, 200);
    expect(await restate(delivery, DAY)).toBe(true);
    expect(await sumKind(delivery.orderId, 'DISTANCE_FEE')).toBe(-80_000n);

    await cancelInSource(delivery);
    await ctx.db.$transaction((tx) =>
      stripCancelledOrderFinance(tx, {
        orderId: delivery.orderId,
        now: new Date(`${LATER_DAY}T09:00:00.000Z`),
      }),
    );

    const reversals = await cancellationReversals(delivery.orderId);
    expect(reversals).toHaveLength(3);
    expect(reversals.every((reversal) => fromDateColumn(reversal.operationDate) === DAY)).toBe(
      true,
    );
    expect(await daysOf(delivery.orderId)).toEqual([DAY]);

    // Единственный день заказа обнулён целиком, и строка это называет.
    const onDelivery = await report(DAY, DAY, delivery.courierId);
    expect(onDelivery.totals.cashReceivedMinor).toBe('0');
    expect(onDelivery.totals.deliveryFeesMinor).toBe('0');
    expect(onDelivery.totals.distanceFeesMinor).toBe('0');
    expect(onDelivery.totals.closingBalanceMinor).toBe('0');
    const row = onDelivery.rows.find((item) => item.attemptId === delivery.attemptId);
    expect(row?.financeCancelled).toBe(true);
    expect(row?.distanceFeeMinor).toBe('0');
    expect(row?.beyondMkadKmTenths).toBe(0);
    expect(row?.totalMinor).toBe('0');
    expect(await orderContribution(delivery.orderId)).toBe(0n);
  });

  it('одновременные снятия одного заказа дают один набор сторно исходными днями', async () => {
    const delivery = await seedDelivered({
      sum: 500_000n,
      payed: 0n,
      perOrder: 20_000n,
      distanceFee: 10_000n,
    });
    await cancelInSource(delivery);

    const strip = (): Promise<boolean> =>
      ctx.db.$transaction((tx) =>
        stripCancelledOrderFinance(tx, {
          orderId: delivery.orderId,
          now: new Date(`${LATER_DAY}T09:00:00.000Z`),
        }),
      );

    /*
     * Оба запроса обязаны завершиться успешно: строка заказа блокируется
     * первой, второй ждёт и находит уже снятый журнал. Отказ по уникальности
     * здесь означал бы гонку, которую блокировка и должна исключать.
     */
    const results = await Promise.all([strip(), strip()]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const reversals = await cancellationReversals(delivery.orderId);
    expect(reversals).toHaveLength(3);
    expect(reversals.every((reversal) => fromDateColumn(reversal.operationDate) === DAY)).toBe(
      true,
    );
    expect(await daysOf(delivery.orderId)).toEqual([DAY]);
    expect(await orderContribution(delivery.orderId)).toBe(0n);
  });

  it('отмена, догнавшая доставку под блокировкой, снимает её начисления днём доставки', async () => {
    // Первая попытка без начислений: заказ оплачен полностью, ставки нулевые.
    const delivery = await seedDelivered({ sum: 500_000n, payed: 500_000n });
    expect(await ctx.db.courierLedgerEntry.count({ where: { orderId: delivery.orderId } })).toBe(0);
    // Источник «откатывает» оплату: управляемая доставка начислит 5 000 ₽ наличных.
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

    // Отмена в источнике и её задание стартуют, пока доставка держит строку заказа.
    let stripped: boolean | null = null;
    const cancellation = (async (): Promise<void> => {
      await cancelInSource(delivery);
      stripped = await ctx.db.$transaction((tx) =>
        stripCancelledOrderFinance(tx, {
          orderId: delivery.orderId,
          now: new Date(`${LATER_DAY}T09:00:00.000Z`),
        }),
      );
    })();

    // Отмена действительно ждёт доставку на блокировке строки заказа.
    expect(await waitForBlocked(1)).toBeGreaterThanOrEqual(1);
    expect(stripped).toBeNull();

    release();
    await deliveryTx;
    await cancellation;
    expect(stripped).toBe(true);

    // Начисление доставки увидено и снято — днём доставки, а не днём обработки.
    const reversals = await cancellationReversals(delivery.orderId);
    expect(reversals).toHaveLength(1);
    expect(reversals[0]?.reversesEntry?.kind).toBe('CASH_RECEIVED');
    expect(fromDateColumn(reversals[0]?.operationDate ?? new Date(0))).toBe(DAY);
    expect(await daysOf(delivery.orderId)).toEqual([DAY]);
    expect(await orderContribution(delivery.orderId)).toBe(0n);
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
  it('XLSX отменённого периода: заработок обнулён, снятие показано в дне доставки', async () => {
    const delivery = await seedDelivered({
      sum: 500_000n,
      payed: 0n,
      perOrder: 20_000n,
      distanceFee: 10_000n,
    });
    await cancelInSource(delivery);
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
     * Лист «Заказы»: строка доставки стоит в своём дне с нулевым итогом, а
     * пометка называет обе стороны — отмену в источнике и снятие начислений
     * дня. Дня обработки отмены в файле нет: денег в нём не двигали.
     */
    /*
     * Утверждения привязаны к КОНКРЕТНОЙ строке по столбцу «Уровень».
     *
     * Сбор значений по всему листу выполнялся бы и тогда, когда строка заказа
     * исчезла: её итог совпадает с итогом группы, и «есть такое число где-то
     * на листе» не доказывает ничего.
     */
    const rows = workbook.getWorksheet('Заказы');
    // Столбцы по ЗАГОЛОВКУ: номер в проверке повторял бы число из кода.
    const columns = (rows?.getRow(1).values as unknown[]).map((name) => String(name ?? ''));
    const totalColumn = columns.indexOf('Итог, ₽');
    const noteColumn = columns.indexOf('Примечание');
    const orderRows: { total: unknown; note: string; date: unknown }[] = [];
    const dayRows: { total: unknown; date: unknown }[] = [];
    rows?.eachRow((row) => {
      const level = String(row.getCell(1).value ?? '');
      if (level === 'Заказ') {
        orderRows.push({
          total: row.getCell(totalColumn).value,
          note: String(row.getCell(noteColumn).value ?? ''),
          date: row.getCell(2).value,
        });
      }
      if (level === 'Итог дня') {
        dayRows.push({ total: row.getCell(totalColumn).value, date: row.getCell(2).value });
      }
    });

    // Строка заказа одна, стоит в дне доставки, и её итог — ноль.
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]?.total).toBe(0);
    expect(orderRows[0]?.date).toBe(DAY);
    // Пометки складываются: и отмена в источнике, и снятие начислений этого дня.
    expect(orderRows[0]?.note).toContain('Отменён в МоемСкладе');
    expect(orderRows[0]?.note).toContain('Начисления дня сняты');

    // Итог дня доставки — ноль; дня обработки отмены в файле нет.
    expect(dayRows.find((row) => row.date === DAY)?.total).toBe(0);
    expect(dayRows.find((row) => row.date === NEXT_DAY)).toBeUndefined();
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
