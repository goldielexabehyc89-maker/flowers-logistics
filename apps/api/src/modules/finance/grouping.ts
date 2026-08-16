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
  /** Всё, что начислено курьеру за день: доставки, километры, попытки. */
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

  for (const entry of entries) {
    // В группу дня и курьера попадают только операции БЕЗ доставки: деньги
    // самой доставки уже показаны её строкой, и второй раз их не считают.
    if (entry.attemptId !== null) {
      continue;
    }
    const group = ensure(entry.operationDate, entry.courierUserId);
    group.operations.entries.push(entry);
  }

  for (const couriers of byDay.values()) {
    for (const group of couriers.values()) {
      const sheets = new Set(group.rows.map((row) => row.routeNumber));
      group.sheets = sheets.size;
      group.orders = group.rows.length;
      group.cashMinor = sum(group.rows.map((row) => row.cashMinor)).toString();
      group.deliveryFeesMinor = sum(group.rows.map((row) => row.deliveryFeeMinor)).toString();
      group.distanceFeesMinor = sum(group.rows.map((row) => row.distanceFeeMinor)).toString();
      group.attemptFeesMinor = sum(group.rows.map((row) => row.attemptFeeMinor)).toString();
      group.distanceKmTenths = group.rows.reduce(
        (total, row) => total + (row.beyondMkadKmTenths ?? 0),
        0,
      );
      group.accruedMinor = (
        BigInt(group.deliveryFeesMinor) +
        BigInt(group.distanceFeesMinor) +
        BigInt(group.attemptFeesMinor)
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
