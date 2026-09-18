/**
 * Отчёты: расчёты с курьерами и операционные показатели.
 *
 * Суммы берутся ТОЛЬКО из учёта и снимков, а не из живых таблиц заказов:
 * сумма заказа в МоёмСкладе меняется и после доставки, и отчёт, считающий по
 * ней, задним числом переписывал бы историю расчётов.
 *
 * Строки маршрутов, подтверждённых до включения учёта, помечаются признаком
 * «расчёта нет». Ноль вместо этого означал бы «ставка нулевая», а это неправда.
 */

import type { Database } from '../../platform/db.js';
import { fromDateColumn, toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { balanceOf, entriesOf, type LedgerEntryView } from './ledger.js';
import { groupSettlement, pageOfGroups, type CourierProfile, type DayGroup } from './grouping.js';

export interface Period {
  from: string;
  to: string;
}

export interface SettlementTotals {
  /** Баланс на начало периода: сумма всех записей строго до его первого дня. */
  openingBalanceMinor: string;
  cashReceivedMinor: string;
  /**
   * Корректировки наличных после оплаты в источнике: со знаком, обычно минус.
   *
   * Отдельно от наличных и БЕЗ модуля: иначе период, в котором есть только
   * корректировка, показал бы снятие как приход.
   */
  cashCorrectionsMinor: string;
  handedToLogistMinor: string;
  issuedToCourierMinor: string;
  deliveryFeesMinor: string;
  attemptFeesMinor: string;
  distanceFeesMinor: string;
  expensesMinor: string;
  bonusesMinor: string;
  adjustmentsMinor: string;
  /**
   * Начальный долг, заведённый В ЭТОМ периоде.
   *
   * Отдельная строка, а не часть заработка, наличных или расходов: это долг
   * курьера до перехода на ERP, и смешивать его с фактическими движениями
   * денег нельзя. В периодах ПОСЛЕ дня учёта сумма уже сидит в
   * `openingBalanceMinor`, и здесь будет ноль.
   */
  openingDebtMinor: string;
  closingBalanceMinor: string;
}

export interface SettlementRow {
  attemptId: string;
  orderId: string;
  orderNumber: string;
  routeId: string;
  routeNumber: string;
  deliveryDate: string;
  courierUserId: string;
  outcome: string;
  cancelled: boolean;
  cashCollectable: boolean;
  cashMinor: string;
  paymentTypeName: string | null;
  /** Тип транспорта, по которому выбрана ставка. `null` — снимка нет. */
  vehicleType: 'CAR' | 'FOOT' | null;
  /** Ставки маршрута. `null` — маршрут подтверждён до включения учёта. */
  perOrderMinor: string | null;
  perKmMinor: string | null;
  /** Расстояние за МКАД. `null` — не рассчитано. */
  beyondMkadKmTenths: number | null;
  distanceSource: 'COMPUTED' | 'MANUAL' | null;
  deliveryFeeMinor: string;
  distanceFeeMinor: string;
  attemptFeeMinor: string;
  expensesMinor: string;
  bonusesMinor: string;
  totalMinor: string;
  /** Расчёта нет: тарифного снимка у маршрута не существует. */
  settlementMissing: boolean;
  /**
   * Финансовый результат доставки снят (отмена в источнике или обратные
   * записи). Физический факт доставки при этом сохраняется.
   */
  financeCancelled: boolean;
}

export interface SettlementReport {
  period: Period;
  courierUserId: string | null;
  totals: SettlementTotals;
  rows: SettlementRow[];
  entries: LedgerEntryView[];
  /**
   * Иерархия «день → курьер → строки».
   *
   * Итоги групп считаются по ПОЛНОМУ отфильтрованному набору, а страница
   * нарезается по группам: группа одного курьера не делится между страницами.
   */
  days: DayGroup[];
  totalGroups: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** Дата включения учёта. `null` — учёт выключен. */
  ledgerActiveFrom: string | null;
}

function sumOf(entries: readonly LedgerEntryView[], kinds: readonly string[]): bigint {
  return entries
    .filter((entry) => kinds.includes(entry.kind))
    .reduce((total, entry) => total + BigInt(entry.amountMinor), 0n);
}

/**
 * Записи, погашенные внутри периода: сама операция и её обратная запись.
 *
 * Пара «начисление + его отмена» даёт в сумме ноль, поэтому в ДЕЙСТВУЮЩЕМ
 * результате её не показывают вовсе: иначе отменённый заказ продолжал бы
 * увеличивать зарплату и километры в колонках, хотя денег по нему нет.
 *
 * Гасится именно ПАРА и только когда обе записи попали в период. Если отмена
 * пришла позже выбранного периода, исходное начисление в нём действительно
 * было — и остаётся видимым; если раньше периода лежит начисление, а в периоде
 * только отмена, видимой остаётся отмена. Так сумма показанных движений всегда
 * объясняет изменение баланса, а даты не переписываются задним числом.
 */
function settledWithinPeriod(entries: readonly LedgerEntryView[]): ReadonlySet<string> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const settled = new Set<string>();
  for (const entry of entries) {
    if (entry.reversesEntryId === null) {
      continue;
    }
    const source = byId.get(entry.reversesEntryId);
    /*
     * Гасится пара ОДНОГО дня.
     *
     * Отмена, пришедшая в другой день, — это движение того, другого дня: в свой
     * день начисление действительно было. Спрятать обе записи значило бы
     * показать разные итоги одного и того же дня в зависимости от границ
     * отчёта — ровно то, чего быть не должно.
     */
    if (source !== undefined && source.operationDate === entry.operationDate) {
      settled.add(source.id);
      settled.add(entry.id);
    }
  }
  return settled;
}

/** Модуль суммы: в отчёте расходы показываются положительными числами. */
function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** День, предшествующий первому дню периода: по нему считается входящий баланс. */
export function dayBefore(date: string): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() - 1);
  return instant.toISOString().slice(0, 10);
}

export interface SettlementInput extends Period {
  courierUserId?: string | undefined;
  ledgerActiveFrom: string | null;
  /** Постраничность по группам. По умолчанию — вся выборка. */
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function buildSettlementReport(
  db: Database,
  input: SettlementInput,
): Promise<SettlementReport> {
  const entries = await entriesOf(db, {
    courierUserId: input.courierUserId,
    from: input.from,
    to: input.to,
  });

  const opening =
    input.courierUserId === undefined
      ? 0n
      : await balanceOf(db, input.courierUserId, dayBefore(input.from));

  const periodSum = entries.reduce((total, entry) => total + BigInt(entry.amountMinor), 0n);

  /*
   * Действующий результат периода считается по непогашенным записям, а баланс —
   * по всем. Расхождения между ними нет: погашенная пара в сумме даёт ноль.
   */
  const settled = settledWithinPeriod(entries);
  const active = entries.filter((entry) => !settled.has(entry.id));

  const totals: SettlementTotals = {
    openingBalanceMinor: opening.toString(),
    cashReceivedMinor: abs(sumOf(active, ['CASH_RECEIVED'])).toString(),
    /*
     * Корректировки наличных — ОТДЕЛЬНАЯ строка и со своим знаком.
     *
     * Складывать их с наличными и брать модуль нельзя: в периоде, где есть
     * только корректировка, −5 000 ₽ превратились бы в приход +5 000 ₽.
     */
    cashCorrectionsMinor: sumOf(active, ['CASH_PAYMENT_CORRECTION']).toString(),
    handedToLogistMinor: abs(sumOf(active, ['CASH_HANDED_TO_LOGIST'])).toString(),
    issuedToCourierMinor: abs(sumOf(active, ['CASH_ISSUED_TO_COURIER'])).toString(),
    deliveryFeesMinor: abs(sumOf(active, ['DELIVERY_FEE'])).toString(),
    attemptFeesMinor: abs(sumOf(active, ['ATTEMPT_FEE'])).toString(),
    distanceFeesMinor: abs(sumOf(active, ['DISTANCE_FEE'])).toString(),
    expensesMinor: abs(
      sumOf(active, [
        'EXPENSE_PARKING',
        'EXPENSE_TOLL',
        'EXPENSE_TRANSIT',
        'EXPENSE_REPAIR',
        'EXPENSE_LOADING',
        'EXPENSE_OTHER',
      ]),
    ).toString(),
    bonusesMinor: abs(sumOf(active, ['BONUS'])).toString(),
    adjustmentsMinor: sumOf(active, ['ADJUSTMENT']).toString(),
    openingDebtMinor: sumOf(active, ['OPENING_DEBT']).toString(),
    closingBalanceMinor: (opening + periodSum).toString(),
  };

  const facts = await db.deliveryMoneyFact.findMany({
    where: {
      ...(input.courierUserId === undefined ? {} : { courierUserId: input.courierUserId }),
      attempt: {
        route: {
          deliveryDate: { gte: toDateColumn(input.from), lte: toDateColumn(input.to) },
        },
      },
    },
    select: {
      attemptId: true,
      orderId: true,
      routeId: true,
      courierUserId: true,
      cashCollectable: true,
      cashToCollectMinor: true,
      paymentTypeName: true,
      attempt: {
        select: {
          outcome: true,
          routeOrderId: true,
          cancellation: { select: { id: true } },
          order: { select: { externalName: true, cancelledInSource: true } },
          route: { select: { number: true, deliveryDate: true } },
        },
      },
    },
    orderBy: [{ capturedAt: 'asc' }],
  });

  const routeIds = [...new Set(facts.map((fact) => fact.routeId))];
  const snapshots = await db.routeTariffSnapshot.findMany({
    where: { routeId: { in: routeIds } },
    select: { routeId: true, vehicleType: true, perOrderMinor: true, perKmMinor: true },
  });
  const snapshotByRoute = new Map(snapshots.map((row) => [row.routeId, row]));

  const routeOrderIds = facts.map((fact) => fact.attempt.routeOrderId);
  const distances = await db.routeOrderDistance.findMany({
    where: { routeOrderId: { in: routeOrderIds }, activeKey: { not: null } },
    select: { routeOrderId: true, roundedKmTenths: true, source: true },
  });
  const distanceByRouteOrder = new Map(distances.map((row) => [row.routeOrderId, row]));

  /*
   * Проводка принадлежит СВОЕМУ дню, а не дню доставки.
   *
   * Строка доставки собирает только записи своего дня; корректировка или
   * отмена другого дня уходит в журнал этого другого дня. Иначе итог дня
   * менялся бы от того, насколько широкий период выбран: при обоих днях
   * корректировка пряталась внутрь строки доставки, и её день исчезал.
   * Двойного счёта нет: запись попадает ровно в одно место.
   */
  const deliveryDayOfAttempt = new Map(
    facts.map((fact) => [fact.attemptId, fromDateColumn(fact.attempt.route.deliveryDate)]),
  );

  const byAttempt = new Map<string, LedgerEntryView[]>();
  const takenByRows = new Set<string>();
  for (const entry of entries) {
    if (entry.attemptId === null) {
      continue;
    }
    if (deliveryDayOfAttempt.get(entry.attemptId) !== entry.operationDate) {
      continue;
    }
    byAttempt.set(entry.attemptId, [...(byAttempt.get(entry.attemptId) ?? []), entry]);
    takenByRows.add(entry.id);
  }

  /** Всё, что не попало в строку доставки, показывается журналом своего дня. */
  const journalEntries = entries.filter((entry) => !takenByRows.has(entry.id));

  const rows: SettlementRow[] = facts.map((fact) => {
    const own = byAttempt.get(fact.attemptId) ?? [];
    /*
     * Колонки показывают ДЕЙСТВУЮЩИЙ результат доставки, а `totalMinor` — её
     * вклад в баланс. Погашенные внутри периода пары исключаются из колонок и
     * в сумме дают ноль, поэтому итог строки от этого не меняется.
     */
    const activeOwn = own.filter((entry) => !settled.has(entry.id));
    const snapshot = snapshotByRoute.get(fact.routeId) ?? null;
    const distance = distanceByRouteOrder.get(fact.attempt.routeOrderId) ?? null;

    return {
      attemptId: fact.attemptId,
      orderId: fact.orderId,
      orderNumber: fact.attempt.order.externalName,
      routeId: fact.routeId,
      routeNumber: fact.attempt.route.number,
      deliveryDate: fromDateColumn(fact.attempt.route.deliveryDate),
      courierUserId: fact.courierUserId,
      outcome: fact.attempt.outcome,
      cancelled: fact.attempt.cancellation !== null,
      cashCollectable: fact.cashCollectable,
      /*
       * Наличные строки — это ФАКТИЧЕСКИ полученные курьером деньги, то есть
       * записи учёта, а не сумма к получению по заказу.
       *
       * Раньше сюда шёл снимок «сколько причиталось», и недоставленный заказ
       * показывал те же 4990 ₽, хотя курьер их не брал: строка противоречила
       * балансу, а итог группы завышался. Отменённая доставка тем же правилом
       * обнуляет наличные: её запись отменена обратной операцией.
       */
      /*
       * Корректировка после оплаты в источнике уменьшает эту же цифру.
       *
       * Иначе строка показывала бы наличные, которых у курьера уже нет:
       * покупатель доплатил в МойСклад, и сдавать столько он не должен.
       * Суммы корректировок отрицательные, поэтому просто складываются.
       */
      cashMinor: sumOf(activeOwn, ['CASH_RECEIVED', 'CASH_PAYMENT_CORRECTION']).toString(),
      paymentTypeName: fact.paymentTypeName,
      vehicleType: snapshot === null ? null : (snapshot.vehicleType as 'CAR' | 'FOOT'),
      perOrderMinor: snapshot === null ? null : snapshot.perOrderMinor.toString(),
      perKmMinor: snapshot === null ? null : snapshot.perKmMinor.toString(),
      beyondMkadKmTenths: distance?.roundedKmTenths ?? null,
      distanceSource: (distance?.source ?? null) as 'COMPUTED' | 'MANUAL' | null,
      deliveryFeeMinor: abs(sumOf(activeOwn, ['DELIVERY_FEE'])).toString(),
      distanceFeeMinor: abs(sumOf(activeOwn, ['DISTANCE_FEE'])).toString(),
      attemptFeeMinor: abs(sumOf(activeOwn, ['ATTEMPT_FEE'])).toString(),
      expensesMinor: abs(
        sumOf(activeOwn, [
          'EXPENSE_PARKING',
          'EXPENSE_TOLL',
          'EXPENSE_TRANSIT',
          'EXPENSE_REPAIR',
          'EXPENSE_LOADING',
          'EXPENSE_OTHER',
        ]),
      ).toString(),
      bonusesMinor: abs(sumOf(activeOwn, ['BONUS'])).toString(),
      /*
       * Финансовый результат доставки снят.
       *
       * Отмена из МоегоСклада НЕ создаёт отмену результата доставки: физический
       * факт остаётся, снимаются только деньги. Поэтому признак отдельный от
       * `cancelled` — иначе отменённый заказ выглядел бы обычной доставкой
       * с нулевыми колонками и без объяснения.
       */
      financeCancelled:
        fact.attempt.order.cancelledInSource || own.some((entry) => entry.reversesEntryId !== null),
      totalMinor: own.reduce((total, entry) => total + BigInt(entry.amountMinor), 0n).toString(),
      settlementMissing: snapshot === null,
    };
  });

  /*
   * Справочник курьеров для подписей группы.
   *
   * Имя и телефон берутся один раз пачкой: запрашивать их построчно значило бы
   * десятки запросов ради подписи, которая у группы одна.
   */
  const courierIds = [
    ...new Set([...rows.map((row) => row.courierUserId), ...entries.map((e) => e.courierUserId)]),
  ];
  const profiles = new Map<string, CourierProfile>(
    (
      await db.user.findMany({
        where: { id: { in: courierIds } },
        select: { id: true, fullName: true, phone: true },
      })
    ).map((user) => [user.id, { id: user.id, fullName: user.fullName, phone: user.phone }]),
  );

  const grouped = groupSettlement(rows, journalEntries, profiles);
  const page = pageOfGroups(grouped, input.limit ?? Number.MAX_SAFE_INTEGER, input.offset ?? 0);

  return {
    period: { from: input.from, to: input.to },
    courierUserId: input.courierUserId ?? null,
    totals,
    rows,
    entries,
    days: page.days,
    totalGroups: page.totalGroups,
    limit: input.limit ?? page.totalGroups,
    offset: input.offset ?? 0,
    hasMore: page.hasMore,
    ledgerActiveFrom: input.ledgerActiveFrom,
  };
}

export interface OperationalReport {
  period: Period;
  orders: {
    received: number;
    assigned: number;
    unassigned: number;
    shipped: number;
    delivered: number;
    failed: number;
    cancelled: number;
  };
  routes: {
    total: number;
    confirmed: number;
    active: number;
    completed: number;
    cancelled: number;
    averageOrders: number;
  };
  /** Фактическое время маршрута: от отгрузки до последнего результата. */
  actualMinutes: { measured: number; averageMinutes: number | null };
  failureReasons: { name: string; count: number }[];
}

/**
 * Операционные показатели периода.
 *
 * Рассчитанные расстояния сюда не попадают: без GPS называть их фактическим
 * пробегом нельзя, а «рассчитанная длина» относится к маршруту, а не к отчёту
 * о выполненной работе.
 */
export async function buildOperationalReport(
  db: Database,
  period: Period,
): Promise<OperationalReport> {
  const from = toDateColumn(period.from);
  const to = toDateColumn(period.to);
  const dayRange = { gte: from, lte: to };

  const [received, assignedRows, routes, attempts, transitions] = await Promise.all([
    db.deliveryOrder.count({ where: { deliveryDate: dayRange, inScope: true } }),
    db.routeOrder.findMany({
      where: { removedAt: null, route: { deliveryDate: dayRange } },
      select: { orderId: true, route: { select: { state: true } } },
    }),
    db.deliveryRoute.findMany({
      where: { deliveryDate: dayRange },
      select: { id: true, state: true, _count: { select: { orders: true } } },
    }),
    db.deliveryAttempt.findMany({
      where: { route: { deliveryDate: dayRange }, activeKey: { not: null } },
      select: { outcome: true, occurredAt: true, routeId: true, reasonNameSnapshot: true },
    }),
    db.routeStateTransition.findMany({
      where: { route: { deliveryDate: dayRange }, toState: 'ACTIVE' },
      select: { routeId: true, occurredAt: true },
      orderBy: [{ occurredAt: 'asc' }],
    }),
  ]);

  const assignedOrders = new Set(assignedRows.map((row) => row.orderId));
  const shippedOrders = assignedRows.filter((row) =>
    ['ACTIVE', 'COMPLETED'].includes(row.route.state),
  ).length;

  const delivered = attempts.filter((item) => item.outcome === 'DELIVERED').length;
  const failed = attempts.filter((item) => item.outcome === 'NOT_DELIVERED').length;

  const shippedAt = new Map<string, Date>();
  for (const transition of transitions) {
    if (!shippedAt.has(transition.routeId)) {
      shippedAt.set(transition.routeId, transition.occurredAt);
    }
  }

  const lastResultAt = new Map<string, Date>();
  for (const attempt of attempts) {
    const current = lastResultAt.get(attempt.routeId);
    if (current === undefined || attempt.occurredAt > current) {
      lastResultAt.set(attempt.routeId, attempt.occurredAt);
    }
  }

  const durations: number[] = [];
  for (const [routeId, start] of shippedAt) {
    const end = lastResultAt.get(routeId);
    if (end !== undefined && end.getTime() >= start.getTime()) {
      durations.push(Math.round((end.getTime() - start.getTime()) / 60_000));
    }
  }

  const reasons = new Map<string, number>();
  for (const attempt of attempts) {
    if (attempt.outcome !== 'NOT_DELIVERED') {
      continue;
    }
    const name = attempt.reasonNameSnapshot ?? 'Причина не указана';
    reasons.set(name, (reasons.get(name) ?? 0) + 1);
  }

  const routeOrders = routes.reduce((total, route) => total + route._count.orders, 0);

  return {
    period,
    orders: {
      received,
      assigned: assignedOrders.size,
      unassigned: Math.max(0, received - assignedOrders.size),
      shipped: shippedOrders,
      delivered,
      failed,
      cancelled: routes
        .filter((route) => route.state === 'CANCELLED')
        .reduce((total, route) => total + route._count.orders, 0),
    },
    routes: {
      total: routes.length,
      confirmed: routes.filter((route) => route.state === 'CONFIRMED').length,
      active: routes.filter((route) => route.state === 'ACTIVE').length,
      completed: routes.filter((route) => route.state === 'COMPLETED').length,
      cancelled: routes.filter((route) => route.state === 'CANCELLED').length,
      averageOrders: routes.length === 0 ? 0 : Math.round((routeOrders / routes.length) * 10) / 10,
    },
    actualMinutes: {
      measured: durations.length,
      averageMinutes:
        durations.length === 0
          ? null
          : Math.round(durations.reduce((total, value) => total + value, 0) / durations.length),
    },
    failureReasons: [...reasons.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count),
  };
}
