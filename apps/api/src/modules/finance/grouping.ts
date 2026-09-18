/**
 * Группировка расчётов: день → курьер → подробные строки.
 *
 * Итоги считает СЕРВЕР и по всему отфильтрованному набору, а не по загруженной
 * странице: сумма, посчитанная по видимым строкам, меняется от прокрутки и
 * потому не является итогом.
 *
 * Постраничность идёт по ГРУППАМ курьера, а не по строкам: разорванная между
 * страницами группа означала бы два разных итога у одного человека за один
 * день, и оба были бы неверными.
 *
 * Чистые функции: их можно доказать на выдуманных данных, не поднимая базу.
 */

import type { LedgerEntryView } from './ledger.js';
import type { SettlementRow } from './reports.js';

/**
 * Виды, увеличивающие долг курьера компании.
 *
 * У них показатель отчёта равен самой сумме журнала; у остальных — сумме с
 * обратным знаком, потому что в журнале заработок и расходы отрицательны, а
 * в отчёте их показывают как положительный заработок.
 */
const DEBT_INCREASING: readonly string[] = [
  'CASH_RECEIVED',
  'CASH_ISSUED_TO_COURIER',
  'OPENING_DEBT',
];

/**
 * Категория записи: у обратной — категория ОТМЕНЯЕМОЙ операции.
 *
 * Иначе снятая зарплата оставалась бы в зарплате, а её отмена пряталась в общей
 * строке «обратные корректировки», где смешаны наличные, заработок и долги.
 * Отмена оплаты доставки — это изменение оплаты доставки, и считаться должна там.
 */
export function categoryKind(entry: Pick<LedgerEntryView, 'kind' | 'reversesKind'>): string {
  return entry.kind === 'ADJUSTMENT' && entry.reversesKind !== null
    ? entry.reversesKind
    : entry.kind;
}

/**
 * ИЗМЕНЕНИЕ показателя по категории, со знаком.
 *
 * День начисления даёт плюс, день отмены — минус, а за оба дня получается ноль.
 * Модуль здесь применять нельзя: он превратил бы снятие в начисление.
 */
export function changeOf(entries: readonly LedgerEntryView[], kinds: readonly string[]): bigint {
  let total = 0n;
  for (const entry of entries) {
    const kind = categoryKind(entry);
    if (!kinds.includes(kind)) {
      continue;
    }
    const amount = BigInt(entry.amountMinor);
    total += DEBT_INCREASING.includes(kind) ? amount : -amount;
  }
  return total;
}

/** Сумма журнала как есть: нужна там, где знак записи и есть смысл показателя. */
export function rawOf(entries: readonly LedgerEntryView[], kinds: readonly string[]): bigint {
  return entries
    .filter((entry) => kinds.includes(categoryKind(entry)))
    .reduce((total, entry) => total + BigInt(entry.amountMinor), 0n);
}

/** Наличные строки и дня: приход минус корректировки после оплаты в источнике. */
export const CASH_KINDS: readonly string[] = ['CASH_RECEIVED', 'CASH_PAYMENT_CORRECTION'];

/**
 * Виды, попадающие в столбец «Доп.».
 *
 * Оплачиваемой попытки здесь НЕТ: у неё собственный столбец, и подсчёт в обоих
 * сразу удваивал её в «Начислено» — одна попытка на 200 ₽ давала 400 ₽.
 * Каждый вид принадлежит ровно одной категории заработка.
 */
export const EXTRA_KINDS: readonly string[] = [
  'EXPENSE_PARKING',
  'EXPENSE_TOLL',
  'EXPENSE_TRANSIT',
  'EXPENSE_REPAIR',
  'EXPENSE_LOADING',
  'EXPENSE_OTHER',
  'BONUS',
];

/** Расходные и прочие операции, не привязанные к конкретной доставке. */
export interface CourierOperationsGroup {
  count: number;
  totalMinor: string;
  entries: LedgerEntryView[];
}

export interface CourierGroup {
  courierUserId: string;
  fullName: string;
  /** Телефон показывается логисту и администратору; в realtime он не уходит. */
  phone: string | null;
  /** Число маршрутных листов курьера за этот день. */
  sheets: number;
  orders: number;
  cashMinor: string;
  deliveryFeesMinor: string;
  distanceKmTenths: number;
  distanceFeesMinor: string;
  attemptFeesMinor: string;
  /** Дополнительные расходы курьера за день: столбец «Доп.». */
  extraExpensesMinor: string;
  /** Наличные, переданные курьером логисту за день. */
  handedMinor: string;
  /** Деньги, выданные курьеру логистом за день. */
  issuedMinor: string;
  /**
   * Всё, что начислено курьеру за день: доставки, километры, попытки и
   * дополнительные расходы. Именно эта величина стоит в столбце «Начислено».
   */
  accruedMinor: string;
  totalMinor: string;
  /** Хотя бы одна строка без тарифного снимка: расчёта у неё нет. */
  settlementMissing: boolean;
  rows: SettlementRow[];
  operations: CourierOperationsGroup;
}

export interface DayGroup {
  date: string;
  couriers: CourierGroup[];
}

export interface CourierProfile {
  id: string;
  fullName: string;
  phone: string | null;
}

function sum(values: readonly string[]): bigint {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}

/**
 * Сборка групп из плоских строк и операций.
 *
 * Операции без привязки к доставке распределяются по своему дню и курьеру:
 * сдача наличных относится к тому же дню, что и работа, иначе итог дня
 * не сходится с тем, что человек делал.
 */
export function groupSettlement(
  rows: readonly SettlementRow[],
  entries: readonly LedgerEntryView[],
  profiles: ReadonlyMap<string, CourierProfile>,
): DayGroup[] {
  const byDay = new Map<string, Map<string, CourierGroup>>();

  const ensure = (date: string, courierUserId: string): CourierGroup => {
    const couriers = byDay.get(date) ?? new Map<string, CourierGroup>();
    byDay.set(date, couriers);

    const existing = couriers.get(courierUserId);
    if (existing !== undefined) {
      return existing;
    }

    const profile = profiles.get(courierUserId);
    const created: CourierGroup = {
      courierUserId,
      fullName: profile?.fullName ?? 'Курьер удалён из справочника',
      phone: profile?.phone ?? null,
      sheets: 0,
      orders: 0,
      cashMinor: '0',
      deliveryFeesMinor: '0',
      distanceKmTenths: 0,
      distanceFeesMinor: '0',
      attemptFeesMinor: '0',
      extraExpensesMinor: '0',
      handedMinor: '0',
      issuedMinor: '0',
      accruedMinor: '0',
      totalMinor: '0',
      settlementMissing: false,
      rows: [],
      operations: { count: 0, totalMinor: '0', entries: [] },
    };
    couriers.set(courierUserId, created);
    return created;
  };

  for (const row of rows) {
    const group = ensure(row.deliveryDate, row.courierUserId);
    group.rows.push(row);
  }

  /*
   * Журнал дня показывает ровно то, что ему передали.
   *
   * Какие записи уже учтены строкой доставки, решает отчёт: он знает день
   * каждой доставки и день каждой проводки. Здесь повторять этот отбор нельзя —
   * иначе одно и то же правило жило бы в двух местах и однажды разошлось бы.
   */
  for (const entry of entries) {
    const group = ensure(entry.operationDate, entry.courierUserId);
    group.operations.entries.push(entry);
  }

  for (const couriers of byDay.values()) {
    for (const group of couriers.values()) {
      const sheets = new Set(group.rows.map((row) => row.routeNumber));
      group.sheets = sheets.size;
      group.orders = group.rows.length;
      group.cashMinor = (
        sum(group.rows.map((row) => row.cashMinor)) + rawOf(group.operations.entries, CASH_KINDS)
      ).toString();
      group.deliveryFeesMinor = (
        sum(group.rows.map((row) => row.deliveryFeeMinor)) +
        changeOf(group.operations.entries, ['DELIVERY_FEE'])
      ).toString();
      group.distanceFeesMinor = (
        sum(group.rows.map((row) => row.distanceFeeMinor)) +
        changeOf(group.operations.entries, ['DISTANCE_FEE'])
      ).toString();
      group.attemptFeesMinor = (
        sum(group.rows.map((row) => row.attemptFeeMinor)) +
        changeOf(group.operations.entries, ['ATTEMPT_FEE'])
      ).toString();
      group.distanceKmTenths = group.rows.reduce(
        (total, row) => total + (row.beyondMkadKmTenths ?? 0),
        0,
      );
      /*
       * Суммы столбцов «Доп.», «Курьер сдал» и «Выдано курьеру».
       *
       * Показываются положительными числами: направление задаёт столбец,
       * а знак живёт в самой записи учёта и в итоге.
       */
      /*
       * Журнал дня участвует в тех же категориях, что и строки доставок.
       *
       * Отмена, пришедшая на следующий день, строки не имеет — она лежит в
       * журнале. Если её не учесть здесь, снятая зарплата так и останется
       * в «Оплате доставок» и «Начислено» за период.
       */
      const journal = group.operations.entries;

      /*
       * «Доп.» собирается и со строк доставок, и из журнала.
       *
       * Расход или доплату можно привязать к попытке — тогда они попадают
       * в строку. Без слагаемого по строкам такие суммы исчезали бы из
       * «Начислено», хотя баланс их учитывает.
       */
      group.extraExpensesMinor = (
        sum(group.rows.map((row) => row.expensesMinor)) +
        sum(group.rows.map((row) => row.bonusesMinor)) +
        changeOf(journal, EXTRA_KINDS)
      ).toString();
      group.handedMinor = changeOf(journal, ['CASH_HANDED_TO_LOGIST']).toString();
      group.issuedMinor = changeOf(journal, ['CASH_ISSUED_TO_COURIER']).toString();

      group.accruedMinor = (
        BigInt(group.deliveryFeesMinor) +
        BigInt(group.distanceFeesMinor) +
        BigInt(group.attemptFeesMinor) +
        BigInt(group.extraExpensesMinor)
      ).toString();
      group.settlementMissing = group.rows.some((row) => row.settlementMissing);

      group.operations.count = group.operations.entries.length;
      group.operations.totalMinor = sum(
        group.operations.entries.map((entry) => entry.amountMinor),
      ).toString();

      /*
       * Итог дня курьера — вклад дня в его баланс: строки доставок плюс
       * операции этого дня. Знак прежний: плюс — курьер должен компании.
       */
      group.totalMinor = (
        sum(group.rows.map((row) => row.totalMinor)) + BigInt(group.operations.totalMinor)
      ).toString();
    }
  }

  return [...byDay.entries()]
    .sort((left, right) => right[0].localeCompare(left[0]))
    .map(([date, couriers]) => ({
      date,
      couriers: [...couriers.values()].sort((left, right) =>
        left.fullName.localeCompare(right.fullName, 'ru'),
      ),
    }));
}

/**
 * Страница групп.
 *
 * Считается по группам «день + курьер», поэтому одна группа целиком попадает
 * на одну страницу. Возвращается и общее число групп: без него «показать ещё»
 * не знает, есть ли что показывать.
 */
export function pageOfGroups(
  days: readonly DayGroup[],
  limit: number,
  offset: number,
): { days: DayGroup[]; totalGroups: number; hasMore: boolean } {
  const flat: { date: string; group: CourierGroup }[] = [];
  for (const day of days) {
    for (const group of day.couriers) {
      flat.push({ date: day.date, group });
    }
  }

  const slice = flat.slice(offset, offset + limit);
  const byDay = new Map<string, CourierGroup[]>();
  for (const item of slice) {
    byDay.set(item.date, [...(byDay.get(item.date) ?? []), item.group]);
  }

  return {
    days: [...byDay.entries()].map(([date, couriers]) => ({ date, couriers })),
    totalGroups: flat.length,
    hasMore: offset + slice.length < flat.length,
  };
}
