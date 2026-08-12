/**
 * Единый часовой пояс приложения.
 *
 * Бизнес-время у сервиса ровно одно — московское. «Сегодня» и «завтра», дата
 * доставки, срочность, смены, интервалы, маршрутный день, очередь флориста,
 * складские операции и печатные формы считаются относительно Москвы независимо
 * от часового пояса сервера, браузера и рабочего компьютера (решение владельца
 * `TZ-001`).
 *
 * ТРИ РАЗНЫЕ ВЕЩИ, КОТОРЫЕ НЕЛЬЗЯ ПУТАТЬ.
 *
 *  1. Абсолютный момент — аудит, TTL, аренда, отметки времени в базе. Хранится
 *     и передаётся как UTC/ISO-инстант. Переводить хранение в «московское
 *     локальное» запрещено: два одинаковых мгновения обязаны совпадать байтом.
 *     Москва появляется только при показе человеку.
 *  2. Календарная дата `YYYY-MM-DD` — день без времени и без пояса. Она никогда
 *     не проходит через `new Date(value)`: локальный парсер браузера способен
 *     сдвинуть день на единицу.
 *  3. Длительность и минуты внутри дня — часовой пояс в них не участвует вовсе.
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ В КАЖДОМ ЭКРАНЕ.
 *
 * Копии одной и той же функции расходятся молча: одну поправят, другую забудут,
 * и два экрана начнут показывать разные дни на границе полуночи. Общий модуль
 * лежит в пакете, который одинаково доступен серверу и браузеру, и не тянет
 * за собой ни одной серверной зависимости.
 */

/** Единственный бизнес-часовой пояс. Строку не дублировать по месту вызова. */
export const MOSCOW_TIME_ZONE = 'Europe/Moscow';

/** Единственная локаль показа. */
export const MOSCOW_LOCALE = 'ru-RU';

/** Чем заменяется отсутствующее значение при показе. */
export const EMPTY_TIME_VALUE = '—';

/**
 * Календарная дата Москвы для абсолютного момента.
 *
 * Считается через `Intl` с явным поясом, а не арифметикой «плюс три часа»:
 * смещение задаёт база часовых поясов, а не константа в коде. Формат `en-CA`
 * выбран потому, что даёт ровно `YYYY-MM-DD` без разбора частей вручную.
 */
export function moscowCalendarDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MOSCOW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Сегодняшний московский день. Часовой пояс среды на результат не влияет. */
export function moscowToday(now: Date = new Date()): string {
  return moscowCalendarDate(now);
}

/**
 * Соседний московский день: `+1` — завтра, `-1` — вчера.
 *
 * Сдвиг выполняется по календарю строки, а не прибавлением суток к моменту:
 * так результат не зависит ни от перевода часов, ни от длины суток.
 */
export function shiftCalendarDate(date: string, days: number): string {
  const parts = date.split('-');
  if (parts.length !== 3) {
    return date;
  }
  const shifted = new Date(
    Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + days),
  );
  return shifted.toISOString().slice(0, 10);
}

/**
 * `2026-08-07` → `07.08.2026`.
 *
 * Работает со строкой и только со строкой: `new Date('2026-08-07')` в браузере
 * западнее Гринвича даёт шестое августа.
 */
export function formatCalendarDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return EMPTY_TIME_VALUE;
  }
  const parts = value.split('-');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : value;
}

/**
 * Абсолютный момент человеку: всегда московское время, всегда одинаково.
 *
 * `timeZone` задан явно. Без него `toLocaleString` показывает время компьютера
 * пользователя, и один и тот же аудит выглядит по-разному у логиста в Москве
 * и у владельца в поездке.
 */
export function formatMoscowDateTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return EMPTY_TIME_VALUE;
  }
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    return EMPTY_TIME_VALUE;
  }
  return new Intl.DateTimeFormat(MOSCOW_LOCALE, {
    timeZone: MOSCOW_TIME_ZONE,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(instant);
}

/** Абсолютный момент без даты: только московское время. */
export function formatMoscowTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return EMPTY_TIME_VALUE;
  }
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    return EMPTY_TIME_VALUE;
  }
  return new Intl.DateTimeFormat(MOSCOW_LOCALE, {
    timeZone: MOSCOW_TIME_ZONE,
    timeStyle: 'short',
  }).format(instant);
}

/**
 * `600` → `10:00`.
 *
 * Минуты от начала дня — не момент времени: часовой пояс к ним отношения
 * не имеет, и переводить их через `Date` не нужно.
 */
export function formatMinutesOfDay(minute: number | null | undefined): string {
  if (minute === null || minute === undefined) {
    return EMPTY_TIME_VALUE;
  }
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
