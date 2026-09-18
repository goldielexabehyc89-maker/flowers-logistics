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
import {
  CASH_KINDS,
  changeOf,
  groupSettlement,
  pageOfGroups,
  rawOf,
  type CourierProfile,
  type DayGroup,
} from './grouping.js';

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
   * Все начисления ЭТОГО дня по этой доставке сняты обратными записями.
   *
   * Про день, а не про заказ: отмена, пришедшая на следующий день, живёт
   * в своём дне, а день доставки честно несёт свои деньги. Физический факт
   * доставки сохраняется в любом случае.
   */
  financeCancelled: boolean;
  /**
   * Заказ отменён в источнике — независимо от того, в каком дне сняты деньги.
   *
   * Отдельный признак: «деньги дня сняты» и «заказ отменён» — разные факты,
   * и в отчёте за день доставки первый ложен, а второй истинен. Без него
   * отменённый заказ выглядел бы обычной успешной доставкой.
   */
  sourceCancelled: boolean;
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

  const totals: SettlementTotals = {
    openingBalanceMinor: opening.toString(),
    /*
     * Каждый показатель — ИЗМЕНЕНИЕ за период, а обратная запись считается
     * в категории той операции, которую отменяет. Поэтому день начисления даёт
     * плюс, день отмены — минус, а за оба дня выходит ноль: отменённая зарплата
     * не остаётся в зарплате, и при этом движения обоих дней сохраняются.
     */
    cashReceivedMinor: changeOf(entries, ['CASH_RECEIVED']).toString(),
    /*
     * Корректировки наличных показываются со знаком журнала: это уменьшение,
     * и минус здесь — часть смысла показателя.
     */
    cashCorrectionsMinor: rawOf(entries, ['CASH_PAYMENT_CORRECTION']).toString(),
    handedToLogistMinor: changeOf(entries, ['CASH_HANDED_TO_LOGIST']).toString(),
    issuedToCourierMinor: changeOf(entries, ['CASH_ISSUED_TO_COURIER']).toString(),
    deliveryFeesMinor: changeOf(entries, ['DELIVERY_FEE']).toString(),
    attemptFeesMinor: changeOf(entries, ['ATTEMPT_FEE']).toString(),
    distanceFeesMinor: changeOf(entries, ['DISTANCE_FEE']).toString(),
    expensesMinor: changeOf(entries, [
      'EXPENSE_PARKING',
      'EXPENSE_TOLL',
      'EXPENSE_TRANSIT',
      'EXPENSE_REPAIR',
      'EXPENSE_LOADING',
      'EXPENSE_OTHER',
    ]).toString(),
    bonusesMinor: changeOf(entries, ['BONUS']).toString(),
    /*
     * Здесь остаются только обратные записи, чью исходную операцию определить
     * не удалось. В норме их нет: каждая отмена учтена в своей категории.
     */
    adjustmentsMinor: entries
      .filter((entry) => entry.kind === 'ADJUSTMENT' && entry.reversesKind === null)
      .reduce((total, entry) => total + BigInt(entry.amountMinor), 0n)
      .toString(),
    openingDebtMinor: changeOf(entries, ['OPENING_DEBT']).toString(),
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
  /*
   * Чей это заказ. Попытка одна, а курьер у записи — свой.
   *
   * У `attemptId` записи журнала нет внешнего ключа, и маршрут операций
   * принимает любой uuid. Запись курьера B с попыткой курьера A уходила в
   * строку A: у A в «Доп.» появлялись чужие деньги, а у B они пропадали из
   * отчёта, оставаясь в его балансе. Итог дня переставал быть вкладом дня в
   * баланс, и один и тот же день показывался по-разному в общем отчёте и в
   * отчёте по курьеру. Строку доставки наполняют только записи ЕЁ курьера.
   */
  const courierOfAttempt = new Map(facts.map((fact) => [fact.attemptId, fact.courierUserId]));

  const byAttempt = new Map<string, LedgerEntryView[]>();
  const takenByRows = new Set<string>();
  for (const entry of entries) {
    if (entry.attemptId === null) {
      continue;
    }
    if (deliveryDayOfAttempt.get(entry.attemptId) !== entry.operationDate) {
      continue;
    }
    if (courierOfAttempt.get(entry.attemptId) !== entry.courierUserId) {
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
     * Колонки строки — изменения её дня, `totalMinor` — вклад в баланс.
     * Отмена того же дня попадает в те же категории с обратным знаком и
     * обнуляет их; отмена другого дня живёт в журнале своего дня.
     */

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
      cashMinor: rawOf(own, CASH_KINDS).toString(),
      paymentTypeName: fact.paymentTypeName,
      vehicleType: snapshot === null ? null : (snapshot.vehicleType as 'CAR' | 'FOOT'),
      perOrderMinor: snapshot === null ? null : snapshot.perOrderMinor.toString(),
      perKmMinor: snapshot === null ? null : snapshot.perKmMinor.toString(),
      beyondMkadKmTenths: distance?.roundedKmTenths ?? null,
      distanceSource: (distance?.source ?? null) as 'COMPUTED' | 'MANUAL' | null,
      deliveryFeeMinor: changeOf(own, ['DELIVERY_FEE']).toString(),
      distanceFeeMinor: changeOf(own, ['DISTANCE_FEE']).toString(),
      attemptFeeMinor: changeOf(own, ['ATTEMPT_FEE']).toString(),
      expensesMinor: changeOf(own, [
        'EXPENSE_PARKING',
        'EXPENSE_TOLL',
        'EXPENSE_TRANSIT',
        'EXPENSE_REPAIR',
        'EXPENSE_LOADING',
        'EXPENSE_OTHER',
      ]).toString(),
      bonusesMinor: changeOf(own, ['BONUS']).toString(),
      /*
       * Начисления ЭТОГО дня по этой доставке сняты — все до одного.
       *
       * Отмена из МоегоСклада НЕ создаёт отмену результата доставки: физический
       * факт остаётся, снимаются только деньги. Поэтому признак отдельный от
       * `cancelled`.
       *
       * Признаком служит СОСТОЯНИЕ СТРОКИ, а не отметка заказа: отмена,
       * пришедшая на следующий день, лежит в своём дне, а день доставки честно
       * сохраняет ненулевой итог — помечать его «снято» значило бы прятать
       * деньги, которые входят в итог дня и периода полностью. И проверяется
       * КАЖДОЕ начисление, а не нулевая сумма: день, где отменили одну запись,
       * а остаток случайно сошёлся в ноль, снятым целиком не является.
       */
      financeCancelled: (() => {
        const accruals = own.filter((entry) => entry.kind !== 'ADJUSTMENT');
        const reversedHere = new Set(
          own
            .filter((entry) => entry.reversesEntryId !== null)
            .map((entry) => entry.reversesEntryId as string),
        );
        return accruals.length > 0 && accruals.every((entry) => reversedHere.has(entry.id));
      })(),
      sourceCancelled: fact.attempt.order.cancelledInSource,
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

  /*
   * Плоские списки описывают СТРАНИЦУ, а не весь период.
   *
   * Постраничность идёт по группам «день + курьер», но рядом с двадцатью
   * группами в ответе лежали все строки заказов и весь журнал периода — без
   * какой-либо границы. Месяц по всем курьерам отдавал тысячи строк на каждое
   * обновление журнала, и предел `limit` не значил ничего.
   *
   * Итоги при этом остаются периодными: они считаются по всему отбору, и
   * сумма по видимым строкам итогом не является.
   *
   * Без `limit` (обе выгрузки) видно всё, и списки совпадают с прежними —
   * включая записи, вошедшие в строки доставок.
   */
  const visibleRows = page.days.flatMap((day) => day.couriers.flatMap((group) => group.rows));
  const visibleAttempts = new Set(visibleRows.map((row) => row.attemptId));
  const visibleJournal = new Set(
    page.days.flatMap((day) =>
      day.couriers.flatMap((group) => group.operations.entries.map((entry) => entry.id)),
    ),
  );
  const visibleEntries = entries.filter(
    (entry) =>
      visibleJournal.has(entry.id) ||
      (entry.attemptId !== null && takenByRows.has(entry.id) && visibleAttempts.has(entry.attemptId)),
  );

  return {
    period: { from: input.from, to: input.to },
    courierUserId: input.courierUserId ?? null,
    totals,
    rows: visibleRows,
    entries: visibleEntries,
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
