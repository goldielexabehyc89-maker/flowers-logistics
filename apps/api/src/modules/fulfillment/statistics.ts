/**
 * Статистика смен флориста.
 *
 * Считается по НЕИЗМЕНЯЕМОЙ истории, а не по опросу клиента: смены
 * (`FloristShift`), взятия и сборки (`AuditLog`), доступность общей очереди
 * (`FloristQueueAvailabilityEvent`). Вкладка браузера для накопления не нужна.
 *
 * Что честно восстановимо из прежней истории — показывается за любые даты
 * (длительность смены, число собранных, ритм, среднее и медиана времени
 * сборки). Что накапливается только вперёд — разбиение простоя на «с очередью»
 * и «без очереди» и деньги в момент сборки — до даты начала точного накопления
 * помечается неполным, а не заполняется догадкой.
 *
 * Смена, перешедшая полночь, целиком относится к дате НАЧАЛА. Одновременные
 * заказы время не умножают: рабочее время — объединение интервалов сборки, а не
 * их сумма. Повторная сборка не удваивает уникальный счётчик, но её цикл
 * учитывается во времени сборки отдельно.
 */

import type { Database } from '../../platform/db.js';
import { moscowDate } from '../integrations/moysklad/moscow-time.js';

/** Полуинтервал времени в миллисекундах эпохи. */
interface Span {
  start: number;
  end: number;
}

export interface FloristStatComparison {
  shiftDurationMinutes: number;
  workingMinutes: number;
  idleWithQueueMinutes: number | null;
  idleWithoutQueueMinutes: number | null;
  uniqueAssembledCount: number;
  totalSumMinor: string | null;
  ordersPerHour: number;
  rublesPerHour: number | null;
  avgAssemblyMinutes: number | null;
  medianAssemblyMinutes: number | null;
}

export interface FloristStatRow extends FloristStatComparison {
  floristId: string;
  floristName: string;
  /** Простой известен неполно: часть периода — до начала точного накопления. */
  idleIncomplete: boolean;
  /** Деньги известны неполно: часть сборок сделана до начала накопления денег. */
  moneyIncomplete: boolean;
  idleWithQueuePercent: number | null;
  idleWithoutQueuePercent: number | null;
  /** Изменение к непосредственно предшествующему равному периоду. */
  comparison: FloristStatComparison;
}

export interface FloristStatistics {
  period: { from: string; to: string };
  previousPeriod: { from: string; to: string };
  /** Дата начала точного накопления (мин. occurredAt событий). `null` — записей нет. */
  accurateFrom: string | null;
  rows: FloristStatRow[];
}

/** Начало московских суток `date` в UTC. Москва — фиксированный UTC+3. */
function moscowDayStart(date: string): Date {
  return new Date(`${date}T00:00:00.000+03:00`);
}

/** Прибавляет дни к календарной дате `YYYY-MM-DD` (UTC-арифметика по полудню). */
function addDays(date: string, days: number): string {
  const at = new Date(`${date}T12:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T12:00:00.000Z`).getTime();
  const b = new Date(`${to}T12:00:00.000Z`).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Длина объединения интервалов (пересечения считаются один раз). */
function unionLength(spans: Span[]): number {
  if (spans.length === 0) {
    return 0;
  }
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = sorted[0]!.start;
  let curEnd = sorted[0]!.end;
  for (let i = 1; i < sorted.length; i += 1) {
    const s = sorted[i]!;
    if (s.start > curEnd) {
      total += curEnd - curStart;
      curStart = s.start;
      curEnd = s.end;
    } else if (s.end > curEnd) {
      curEnd = s.end;
    }
  }
  total += curEnd - curStart;
  return total;
}

/** Объединение интервалов в непересекающиеся спаны. */
function mergeSpans(spans: Span[]): Span[] {
  if (spans.length === 0) {
    return [];
  }
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i += 1) {
    const s = sorted[i]!;
    const last = out[out.length - 1]!;
    if (s.start > last.end) {
      out.push({ ...s });
    } else if (s.end > last.end) {
      last.end = s.end;
    }
  }
  return out;
}

/** `base` минус занятые спаны `busy`: получаем свободные (простой) промежутки. */
function subtractSpans(base: Span, busy: Span[]): Span[] {
  const merged = mergeSpans(
    busy
      .map((s) => ({ start: Math.max(s.start, base.start), end: Math.min(s.end, base.end) }))
      .filter((s) => s.end > s.start),
  );
  const out: Span[] = [];
  let cursor = base.start;
  for (const b of merged) {
    if (b.start > cursor) {
      out.push({ start: cursor, end: b.start });
    }
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < base.end) {
    out.push({ start: cursor, end: base.end });
  }
  return out;
}

/** Ступенчатая доступность очереди из переходов, с зоной «неизвестно» до первого. */
export class AvailabilityTimeline {
  private readonly events: { t: number; available: boolean }[];
  readonly firstAt: number | null;

  constructor(events: { occurredAt: Date; available: boolean }[]) {
    this.events = events
      .map((e) => ({ t: e.occurredAt.getTime(), available: e.available }))
      .sort((a, b) => a.t - b.t);
    this.firstAt = this.events.length > 0 ? this.events[0]!.t : null;
  }

  /**
   * Делит простойный промежуток на «с очередью», «без очереди» и «неизвестно»
   * (время до первого зафиксированного перехода). Возвращает миллисекунды.
   */
  split(span: Span): { withQueue: number; withoutQueue: number; unknown: number } {
    let withQueue = 0;
    let withoutQueue = 0;
    let unknown = 0;

    if (this.firstAt === null) {
      return { withQueue: 0, withoutQueue: 0, unknown: span.end - span.start };
    }

    // Часть до первого перехода — неизвестна.
    if (span.start < this.firstAt) {
      const boundary = Math.min(span.end, this.firstAt);
      unknown += boundary - span.start;
    }

    let cursor = Math.max(span.start, this.firstAt);
    while (cursor < span.end) {
      // Состояние, действующее в `cursor`: последний переход с t <= cursor.
      let state = false;
      let nextChange = span.end;
      for (let i = 0; i < this.events.length; i += 1) {
        const e = this.events[i]!;
        if (e.t <= cursor) {
          state = e.available;
        } else {
          nextChange = Math.min(nextChange, e.t);
          break;
        }
      }
      const segmentEnd = Math.min(nextChange, span.end);
      const length = segmentEnd - cursor;
      if (state) {
        withQueue += length;
      } else {
        withoutQueue += length;
      }
      cursor = segmentEnd;
    }

    return { withQueue, withoutQueue, unknown };
  }
}

const MIN = 60_000;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

interface ShiftRow {
  userId: string;
  startedAt: Date;
  closedAt: Date | null;
}

interface AuditRow {
  actorUserId: string | null;
  occurredAt: Date;
  entityId: string | null;
  newValue: unknown;
}

/** Считает показатели одного флориста за набор его смен в периоде. */
function computeForFlorist(
  shifts: ShiftRow[],
  claims: AuditRow[],
  assembles: AuditRow[],
  timeline: AvailabilityTimeline,
  now: number,
): FloristStatComparison & { idleUnknownMs: number; moneyIncomplete: boolean } {
  // Взятия по заказу: время каждого взятия для сопоставления с последующей сборкой.
  const claimsByOrder = new Map<string, number[]>();
  for (const c of claims) {
    if (c.entityId === null) continue;
    const list = claimsByOrder.get(c.entityId) ?? [];
    list.push(c.occurredAt.getTime());
    claimsByOrder.set(c.entityId, list);
  }
  for (const list of claimsByOrder.values()) {
    list.sort((a, b) => a - b);
  }

  let shiftDurationMs = 0;
  const assemblySpans: Span[] = [];
  const cycleMinutes: number[] = [];
  const uniqueOrders = new Set<string>();
  let sumMinor = 0n;
  let moneyIncomplete = false;
  let idleWithQueueMs = 0;
  let idleWithoutQueueMs = 0;
  let idleUnknownMs = 0;

  // Границы всех смен флориста (для отнесения сборок к рабочему времени).
  const shiftSpans: Span[] = shifts.map((s) => ({
    start: s.startedAt.getTime(),
    end: (s.closedAt ?? new Date(now)).getTime(),
  }));

  for (const span of shiftSpans) {
    shiftDurationMs += span.end - span.start;
  }

  // Сборки: уникальный счётчик, деньги, циклы времени сборки, интервалы работы.
  for (const a of assembles) {
    if (a.entityId === null) continue;
    const ta = a.occurredAt.getTime();
    uniqueOrders.add(a.entityId);

    const value = (a.newValue ?? {}) as { assembledSumMinor?: unknown };
    if (typeof value.assembledSumMinor === 'string' && /^\d+$/.test(value.assembledSumMinor)) {
      sumMinor += BigInt(value.assembledSumMinor);
    } else {
      moneyIncomplete = true;
    }

    // Ближайшее предшествующее взятие этого заказа — начало цикла.
    const claimTimes = claimsByOrder.get(a.entityId) ?? [];
    let claimAt: number | null = null;
    for (const t of claimTimes) {
      if (t <= ta) {
        claimAt = t;
      } else {
        break;
      }
    }
    if (claimAt !== null) {
      cycleMinutes.push((ta - claimAt) / MIN);
      assemblySpans.push({ start: claimAt, end: ta });
    }
  }

  const workingMs = unionLength(
    assemblySpans.flatMap((cycle) =>
      shiftSpans
        .map((sh) => ({ start: Math.max(cycle.start, sh.start), end: Math.min(cycle.end, sh.end) }))
        .filter((s) => s.end > s.start),
    ),
  );

  // Простой = смена минус рабочие интервалы; разбивается по доступности очереди.
  for (const sh of shiftSpans) {
    const idle = subtractSpans(sh, assemblySpans);
    for (const gap of idle) {
      const { withQueue, withoutQueue, unknown } = timeline.split(gap);
      idleWithQueueMs += withQueue;
      idleWithoutQueueMs += withoutQueue;
      idleUnknownMs += unknown;
    }
  }

  const hours = shiftDurationMs / (60 * MIN);
  const uniqueCount = uniqueOrders.size;
  const idleKnown = idleUnknownMs === 0;

  return {
    shiftDurationMinutes: round1(shiftDurationMs / MIN),
    workingMinutes: round1(workingMs / MIN),
    idleWithQueueMinutes: idleKnown ? round1(idleWithQueueMs / MIN) : null,
    idleWithoutQueueMinutes: idleKnown ? round1(idleWithoutQueueMs / MIN) : null,
    uniqueAssembledCount: uniqueCount,
    totalSumMinor: moneyIncomplete ? null : sumMinor.toString(),
    ordersPerHour: hours > 0 ? round1(uniqueCount / hours) : 0,
    rublesPerHour: moneyIncomplete || hours <= 0 ? null : round1(Number(sumMinor) / 100 / hours),
    avgAssemblyMinutes:
      cycleMinutes.length === 0
        ? null
        : round1(cycleMinutes.reduce((s, v) => s + v, 0) / cycleMinutes.length),
    medianAssemblyMinutes: (() => {
      const m = median(cycleMinutes);
      return m === null ? null : round1(m);
    })(),
    idleUnknownMs,
    moneyIncomplete,
  };
}

/**
 * Строит статистику смен за период и за непосредственно предшествующий равный
 * период (для сравнения). Даты — московские календарные `YYYY-MM-DD`.
 */
export async function buildFloristStatistics(
  db: Database,
  input: { from: string; to: string; now?: Date },
): Promise<FloristStatistics> {
  const now = (input.now ?? new Date()).getTime();
  const length = daysBetween(input.from, input.to);
  const prevTo = addDays(input.from, -1);
  const prevFrom = addDays(prevTo, -(length - 1));

  const rangeStart = moscowDayStart(prevFrom);
  const rangeEnd = moscowDayStart(addDays(input.to, 1));

  // Смены, НАЧАВШИЕСЯ в объединённом диапазоне (переход полночи — к дате старта).
  const shifts = await db.floristShift.findMany({
    where: { startedAt: { gte: rangeStart, lt: rangeEnd } },
    select: { userId: true, startedAt: true, closedAt: true },
  });

  const claims = await db.auditLog.findMany({
    where: {
      action: 'ORDER_FULFILLMENT_CLAIMED',
      occurredAt: { gte: rangeStart, lt: rangeEnd },
    },
    select: { actorUserId: true, occurredAt: true, entityId: true, newValue: true },
  });
  const assembles = await db.auditLog.findMany({
    where: {
      action: 'ORDER_FULFILLMENT_ASSEMBLED',
      occurredAt: { gte: rangeStart, lt: rangeEnd },
    },
    select: { actorUserId: true, occurredAt: true, entityId: true, newValue: true },
  });

  const availabilityEvents = await db.floristQueueAvailabilityEvent.findMany({
    where: { occurredAt: { lt: rangeEnd } },
    select: { occurredAt: true, available: true },
    orderBy: { occurredAt: 'asc' },
  });
  const timeline = new AvailabilityTimeline(availabilityEvents);
  const accurateFrom = timeline.firstAt === null ? null : moscowDate(new Date(timeline.firstAt));

  // Имена флористов.
  const floristIds = [...new Set(shifts.map((s) => s.userId))];
  const users = await db.user.findMany({
    where: { id: { in: floristIds } },
    select: { id: true, fullName: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.fullName]));

  const inPeriod = (d: Date, from: string, to: string): boolean => {
    const day = moscowDate(d);
    return day >= from && day <= to;
  };

  const rowsForPeriod = (
    from: string,
    to: string,
  ): Map<string, FloristStatComparison & { idleUnknownMs: number; moneyIncomplete: boolean }> => {
    const result = new Map<
      string,
      FloristStatComparison & { idleUnknownMs: number; moneyIncomplete: boolean }
    >();
    for (const floristId of floristIds) {
      const fShifts = shifts.filter(
        (s) => s.userId === floristId && inPeriod(s.startedAt, from, to),
      );
      if (fShifts.length === 0) {
        continue;
      }
      const fClaims = claims.filter(
        (c) => c.actorUserId === floristId && inPeriod(c.occurredAt, from, to),
      );
      const fAssembles = assembles.filter(
        (a) => a.actorUserId === floristId && inPeriod(a.occurredAt, from, to),
      );
      result.set(floristId, computeForFlorist(fShifts, fClaims, fAssembles, timeline, now));
    }
    return result;
  };

  const current = rowsForPeriod(input.from, input.to);
  const previous = rowsForPeriod(prevFrom, prevTo);

  const rows: FloristStatRow[] = [];
  for (const [floristId, stat] of current) {
    const dur = stat.shiftDurationMinutes;
    const prev = previous.get(floristId);
    const zeroComparison: FloristStatComparison = {
      shiftDurationMinutes: 0,
      workingMinutes: 0,
      idleWithQueueMinutes: null,
      idleWithoutQueueMinutes: null,
      uniqueAssembledCount: 0,
      totalSumMinor: null,
      ordersPerHour: 0,
      rublesPerHour: null,
      avgAssemblyMinutes: null,
      medianAssemblyMinutes: null,
    };

    rows.push({
      floristId,
      floristName: nameById.get(floristId) ?? 'Флорист удалён из справочника',
      shiftDurationMinutes: stat.shiftDurationMinutes,
      workingMinutes: stat.workingMinutes,
      idleWithQueueMinutes: stat.idleWithQueueMinutes,
      idleWithoutQueueMinutes: stat.idleWithoutQueueMinutes,
      idleWithQueuePercent:
        stat.idleWithQueueMinutes === null || dur <= 0
          ? null
          : round1((stat.idleWithQueueMinutes / dur) * 100),
      idleWithoutQueuePercent:
        stat.idleWithoutQueueMinutes === null || dur <= 0
          ? null
          : round1((stat.idleWithoutQueueMinutes / dur) * 100),
      idleIncomplete: stat.idleUnknownMs > 0,
      moneyIncomplete: stat.moneyIncomplete,
      uniqueAssembledCount: stat.uniqueAssembledCount,
      totalSumMinor: stat.totalSumMinor,
      ordersPerHour: stat.ordersPerHour,
      rublesPerHour: stat.rublesPerHour,
      avgAssemblyMinutes: stat.avgAssemblyMinutes,
      medianAssemblyMinutes: stat.medianAssemblyMinutes,
      comparison: prev ?? zeroComparison,
    });
  }
  rows.sort((a, b) => a.floristName.localeCompare(b.floristName, 'ru'));

  return {
    period: { from: input.from, to: input.to },
    previousPeriod: { from: prevFrom, to: prevTo },
    accurateFrom,
    rows,
  };
}
