/**
 * Начисления курьеру: где деньги входят в учёт.
 *
 * Две точки на весь продукт:
 *
 * 1. Подтверждение маршрута — снимок тарифа по дате доставки. С этого момента
 *    ставки маршрута зафиксированы, и правка тарифа их не трогает.
 * 2. Результат доставки — денежный факт и сами начисления: наличные к получению,
 *    оплата за доставленный заказ и оплата километров за МКАД.
 *
 * Отмена результата не переписывает записи: на каждую создаётся связанная
 * обратная. Отменённая доставка не оставляет ни долга, ни оплаты.
 *
 * Пока учёт не включён владельцем, ни одна из точек ничего не делает: прошлые
 * доставки остаются без начислений, и отчёт помечает их «Расчёт отсутствует».
 */

import type { TransactionClient } from '../auth/sessions.js';
import { fromDateColumn } from '../integrations/moysklad/delivery-date.js';
import { appendEntry, accrualKey, reversalKey } from './ledger.js';
import {
  ledgerCoversDate,
  perOrderForVehicle,
  type LedgerActivation,
  type TariffRates,
} from './tariffs.js';

export interface CaptureTariffInput {
  routeId: string;
  deliveryDate: string;
  /** Тип транспорта маршрута: им выбирается пешая или автомобильная ставка. */
  vehicleType: 'CAR' | 'FOOT';
  rates: TariffRates;
}

/**
 * Снимок тарифа маршрута.
 *
 * Повтор безопасен: у снимка один маршрут, и при повторном подтверждении
 * (например, после возврата в черновик) сохраняется первый снимок — ставки
 * не имеют права поменяться под уже посчитанными деньгами.
 */
export async function captureRouteTariff(
  tx: TransactionClient,
  input: CaptureTariffInput,
): Promise<void> {
  const existing = await tx.routeTariffSnapshot.findUnique({
    where: { routeId: input.routeId },
    select: { id: true },
  });
  if (existing !== null) {
    return;
  }

  await tx.routeTariffSnapshot.create({
    data: {
      routeId: input.routeId,
      tariffVersionId: input.rates.tariffVersionId,
      vehicleType: input.vehicleType,
      // Ставка выбирается по типу транспорта здесь и замораживается: смена
      // настроек тарифа задним числом подтверждённый маршрут не пересчитывает.
      perOrderMinor: perOrderForVehicle(input.rates, input.vehicleType),
      perKmMinor: input.rates.perKmMinor,
      deliveryDate: new Date(`${input.deliveryDate}T00:00:00.000Z`),
    },
  });
}

export interface DeliveryAccrualInput {
  attemptId: string;
  routeOrderId: string;
  routeId: string;
  orderId: string;
  courierUserId: string;
  actorUserId: string;
  outcome: 'DELIVERED' | 'NOT_DELIVERED';
}

/**
 * Начисления по результату доставки.
 *
 * Денежный факт снимается всегда, даже когда наличных нет: отчёт обязан
 * различать «наличных не было» и «мы не знаем». Начисления создаются только
 * при доставке и только если у маршрута есть тарифный снимок.
 */
export async function accrueDeliveryResult(
  tx: TransactionClient,
  activation: LedgerActivation,
  input: DeliveryAccrualInput,
): Promise<void> {
  const route = await tx.deliveryRoute.findUnique({
    where: { id: input.routeId },
    select: { deliveryDate: true },
  });
  if (route === null) {
    return;
  }

  const deliveryDate = fromDateColumn(route.deliveryDate);
  if (!ledgerCoversDate(activation, deliveryDate)) {
    return;
  }

  const order = await tx.deliveryOrder.findUnique({
    where: { id: input.orderId },
    select: {
      cashCollectable: true,
      sumMinor: true,
      payedSumMinor: true,
      paymentTypeId: true,
      paymentTypeName: true,
    },
  });
  if (order === null) {
    return;
  }

  /*
   * Сумма к получению считается тем же правилом, что и везде: разница суммы
   * и оплаченного, но не меньше нуля. Переплата не превращается в долг
   * компании перед курьером.
   */
  const outstanding = order.sumMinor - order.payedSumMinor;
  const cash = order.cashCollectable && outstanding > 0n ? outstanding : 0n;

  await tx.deliveryMoneyFact.upsert({
    where: { attemptId: input.attemptId },
    update: {},
    create: {
      attemptId: input.attemptId,
      orderId: input.orderId,
      routeId: input.routeId,
      courierUserId: input.courierUserId,
      cashCollectable: order.cashCollectable,
      cashToCollectMinor: cash,
      paymentTypeId: order.paymentTypeId,
      paymentTypeName: order.paymentTypeName,
    },
  });

  if (input.outcome !== 'DELIVERED') {
    return;
  }

  if (cash > 0n) {
    await appendEntry(tx, {
      courierUserId: input.courierUserId,
      kind: 'CASH_RECEIVED',
      amountMinor: cash,
      operationDate: deliveryDate,
      actorUserId: input.actorUserId,
      routeId: input.routeId,
      orderId: input.orderId,
      attemptId: input.attemptId,
      idempotencyKey: accrualKey(input.attemptId, 'CASH_RECEIVED'),
    });
  }

  const snapshot = await tx.routeTariffSnapshot.findUnique({
    where: { routeId: input.routeId },
    select: { perOrderMinor: true, perKmMinor: true },
  });
  if (snapshot === null) {
    // Маршрут подтверждён до включения учёта: начислять нечем, и выдумывать
    // ставку задним числом запрещено решением владельца.
    return;
  }

  if (snapshot.perOrderMinor > 0n) {
    await appendEntry(tx, {
      courierUserId: input.courierUserId,
      kind: 'DELIVERY_FEE',
      amountMinor: snapshot.perOrderMinor,
      operationDate: deliveryDate,
      actorUserId: input.actorUserId,
      routeId: input.routeId,
      orderId: input.orderId,
      attemptId: input.attemptId,
      idempotencyKey: accrualKey(input.attemptId, 'DELIVERY_FEE'),
    });
  }

  await accrueDistanceFee(tx, {
    attemptId: input.attemptId,
    routeOrderId: input.routeOrderId,
    routeId: input.routeId,
    orderId: input.orderId,
    courierUserId: input.courierUserId,
    actorUserId: input.actorUserId,
    operationDate: deliveryDate,
    perKmMinor: snapshot.perKmMinor,
  });
}

export interface DistanceFeeInput {
  attemptId: string;
  routeOrderId: string;
  routeId: string;
  orderId: string;
  courierUserId: string;
  actorUserId: string;
  /** Дата операции в форме ГГГГ-ММ-ДД. */
  operationDate: string;
  perKmMinor: bigint;
}

/**
 * Начисление оплаты километров за МКАД по действующему снимку расстояния.
 *
 * Вынесено отдельно, потому что вызывается из двух мест: сразу при результате
 * «Доставлен», если расстояние уже посчитано, и позднее — когда Valhalla
 * ответила уже после доставки и расстояние сохранилось. Уникальный ключ
 * `attempt:<id>:DISTANCE_FEE` не даёт начислить километры дважды: повторный
 * вызов после позднего снимка добавляет запись ровно один раз, а основная
 * оплата `DELIVERY_FEE` остаётся нетронутой.
 */
export async function accrueDistanceFee(
  tx: TransactionClient,
  input: DistanceFeeInput,
): Promise<void> {
  if (input.perKmMinor <= 0n) {
    return;
  }

  const distance = await tx.routeOrderDistance.findFirst({
    where: { routeOrderId: input.routeOrderId, activeKey: { not: null } },
    select: { roundedKmTenths: true },
  });

  if (distance === null || distance.roundedKmTenths <= 0) {
    return;
  }

  // Десятые доли километра: ставка задана за целый километр, поэтому
  // умножение и деление выполняются в целых минорных единицах.
  const amount = (input.perKmMinor * BigInt(distance.roundedKmTenths)) / 10n;
  if (amount <= 0n) {
    return;
  }

  await appendEntry(tx, {
    courierUserId: input.courierUserId,
    kind: 'DISTANCE_FEE',
    amountMinor: amount,
    operationDate: input.operationDate,
    actorUserId: input.actorUserId,
    routeId: input.routeId,
    orderId: input.orderId,
    attemptId: input.attemptId,
    idempotencyKey: accrualKey(input.attemptId, 'DISTANCE_FEE'),
  });
}

/**
 * Отмена результата доставки.
 *
 * Каждое начисление этой попытки получает связанную обратную запись с причиной.
 * Исходные записи остаются: по ним видно, что деньги начислялись и почему были
 * сняты. Денежный факт не удаляется — он остаётся историей.
 */
export async function reverseDeliveryAccruals(
  tx: TransactionClient,
  input: { attemptId: string; actorUserId: string; reason: string; operationDate: string },
): Promise<void> {
  const entries = await tx.courierLedgerEntry.findMany({
    where: { attemptId: input.attemptId, kind: { not: 'ADJUSTMENT' }, reversedBy: { is: null } },
    select: {
      id: true,
      courierUserId: true,
      amountMinor: true,
      routeId: true,
      orderId: true,
      attemptId: true,
    },
  });

  for (const entry of entries) {
    await tx.courierLedgerEntry.create({
      data: {
        courierUserId: entry.courierUserId,
        kind: 'ADJUSTMENT',
        amountMinor: -entry.amountMinor,
        operationDate: new Date(`${input.operationDate}T00:00:00.000Z`),
        actorUserId: input.actorUserId,
        reason: input.reason,
        routeId: entry.routeId,
        orderId: entry.orderId,
        attemptId: entry.attemptId,
        reversesEntryId: entry.id,
        idempotencyKey: reversalKey(entry.id),
      },
    });
  }
}
