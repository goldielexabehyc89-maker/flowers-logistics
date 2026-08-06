/**
 * Плановая дата доставки.
 *
 * МойСклад отдаёт `deliveryPlannedMoment` строкой вида `2026-08-07 12:00:00.000`
 * уже в часовом поясе аккаунта — московском, том же, в котором работает вся система.
 * Поэтому календарная дата берётся из самой строки, **без** преобразования через
 * `Date` и UTC: разбор в UTC с последующим форматированием сдвинул бы доставку
 * на соседний день у всего, что назначено до 03:00 или после 21:00.
 *
 * Непустое, но неразбираемое значение нормальным не считается: заказ импортируется,
 * но получает признак «Требует внимания».
 */

export type DeliveryDateKind = 'MISSING' | 'DATE' | 'UNRECOGNIZED';

export interface ParsedDeliveryDate {
  kind: DeliveryDateKind;
  /** Календарная дата Москвы в формате `YYYY-MM-DD`. */
  date: string | null;
  /** Исходное значение сохраняется как есть, в том числе неразобранное. */
  raw: string | null;
}

/** `2026-08-07 12:00:00.000`, `2026-08-07T12:00`, `2026-08-07` — все допустимы. */
const MOMENT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;

/** Календарь без арифметики дат: проверяем, что день реально существует. */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const daysInMonth = [
    31,
    (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= (daysInMonth[month - 1] ?? 0);
}

export function parseDeliveryDate(input: string | null | undefined): ParsedDeliveryDate {
  if (input === null || input === undefined) {
    return { kind: 'MISSING', date: null, raw: null };
  }

  const raw = input;
  const text = input.trim();
  if (text === '') {
    return { kind: 'MISSING', date: null, raw };
  }

  const match = MOMENT_RE.exec(text);
  if (match === null) {
    return { kind: 'UNRECOGNIZED', date: null, raw };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!isRealDate(year, month, day)) {
    return { kind: 'UNRECOGNIZED', date: null, raw };
  }

  // Строка уже содержит нужную дату: берём её посимвольно, ничего не пересчитывая.
  return { kind: 'DATE', date: `${match[1]}-${match[2]}-${match[3]}`, raw };
}

/**
 * Значение для колонки типа DATE.
 *
 * Полночь UTC выбрана намеренно: PostgreSQL сохранит именно эту календарную дату,
 * а обратное чтение вернёт тот же день независимо от часового пояса процесса.
 */
export function toDateColumn(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** Обратное преобразование колонки DATE в `YYYY-MM-DD`. */
export function fromDateColumn(value: Date): string {
  return value.toISOString().slice(0, 10);
}
