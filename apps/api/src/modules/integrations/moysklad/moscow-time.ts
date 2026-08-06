/**
 * Граница времени между нами и МоимСкладом.
 *
 * МойСклад принимает и отдаёт время в часовом поясе аккаунта — московском,
 * без указания смещения. Поэтому преобразование выполняется явно и в одном месте:
 * полагаться на `TZ` процесса нельзя — в CI и в контейнере он может отличаться,
 * и один и тот же код давал бы разные окна синхронизации.
 *
 * Ошибка здесь не заметна глазом: фильтр, отправленный в UTC, сдвигает окно
 * на три часа, и синхронизация молча отстаёт.
 *
 * Москва — UTC+3 круглый год, перевода часов нет, поэтому достаточно константы.
 */

/** Смещение Москвы относительно UTC. */
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

export class MoscowTimeParseError extends Error {
  constructor() {
    // Значение в сообщение не попадает: оно приходит из внешнего ответа.
    super('Некорректное значение времени МоегоСклада');
    this.name = 'MoscowTimeParseError';
  }
}

/** `2026-08-02T21:00:00Z` → `2026-08-03 00:00:00`. */
export function formatMoscow(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new MoscowTimeParseError();
  }
  const shifted = new Date(date.getTime() + MOSCOW_OFFSET_MS);
  const iso = shifted.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

const MOMENT_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;

/**
 * `2026-08-06 12:00:00.000` (московское местное) → абсолютный момент времени.
 * Смещение вычитается явно, без участия часового пояса процесса.
 */
export function parseMoscow(value: string): Date {
  const match = MOMENT_RE.exec(value.trim());
  if (match === null) {
    throw new MoscowTimeParseError();
  }

  const [, year, month, day, hour, minute, second = '00', millis = '0'] = match;
  const asUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millis.padEnd(3, '0')),
  );

  const parsed = new Date(asUtc - MOSCOW_OFFSET_MS);
  if (Number.isNaN(parsed.getTime())) {
    throw new MoscowTimeParseError();
  }
  return parsed;
}

/** Календарная дата Москвы для момента времени. */
export function moscowDate(date: Date): string {
  return new Date(date.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}
