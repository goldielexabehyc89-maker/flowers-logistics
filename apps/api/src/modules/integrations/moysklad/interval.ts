/**
 * Разбор интервала доставки из свободного текста «Время доставки».
 *
 * Отдельных полей начала и конца в МоемСкладе нет — есть только строка, которую
 * заполняет человек. Поэтому парсер обязан быть консервативным: лучше честно
 * вернуть «не распознано» и поднять заказ в «Требует внимания», чем достроить
 * интервал догадкой. Придуманная граница выглядит как факт и приводит к неверному
 * планированию маршрута.
 *
 * По той же причине одиночное время остаётся точным временем: окно вокруг него
 * не выдумывается.
 */

export type DeliveryIntervalKind = 'MISSING' | 'RANGE' | 'EXACT' | 'UNRECOGNIZED';

export interface ParsedInterval {
  kind: DeliveryIntervalKind;
  /** Минуты от полуночи. Для EXACT заполнено только начало. */
  startMinute: number | null;
  endMinute: number | null;
  /** Исходный текст сохраняется всегда, в том числе при UNRECOGNIZED. */
  raw: string | null;
}

/** Тире в разных начертаниях: дефис, короткое и длинное тире. */
const DASHES = '\\-\\u2013\\u2014';

/**
 * Разделитель между началом и концом.
 * Слово «до»/«по» или тире; вокруг допускаются пробелы.
 */
const SEPARATOR = `(?:\\s*[${DASHES}]\\s*|\\s+(?:до|по)\\s+)`;

const TIME = '([01]?\\d|2[0-3])[:.]([0-5]\\d)';

const RANGE_RE = new RegExp(`^(?:с\\s+)?${TIME}${SEPARATOR}${TIME}$`, 'i');
const EXACT_RE = new RegExp(`^(?:в\\s+|к\\s+)?${TIME}$`, 'i');

/**
 * Приводит разумные варианты пробелов к обычному и убирает края.
 * Неразрывный, узкий и другие типографские пробелы регулярно попадают в текст
 * при копировании из документов и сами по себе интервал не портят.
 */
function normalize(value: string): string {
  return value
    .replace(/[\u00A0\u2007\u2009\u200A\u202F\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toMinutes(hours: string, minutes: string): number {
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Разбирает текст интервала.
 *
 * Возвращает MISSING для пустого значения, RANGE для корректного диапазона,
 * EXACT для одиночного времени и UNRECOGNIZED во всех остальных случаях.
 */
export function parseDeliveryInterval(input: string | null | undefined): ParsedInterval {
  if (input === null || input === undefined) {
    return { kind: 'MISSING', startMinute: null, endMinute: null, raw: null };
  }

  const raw = input;
  const text = normalize(input);

  if (text === '') {
    return { kind: 'MISSING', startMinute: null, endMinute: null, raw };
  }

  const range = RANGE_RE.exec(text);
  if (range !== null) {
    const [, startHour, startMinute, endHour, endMinute] = range;
    const start = toMinutes(startHour, startMinute);
    const end = toMinutes(endHour, endMinute);

    // Обратный и нулевой диапазон — не интервал. «с 19:00 по 16:00» может быть
    // как опечаткой, так и переходом через полночь; угадывать между ними нельзя.
    if (end <= start) {
      return { kind: 'UNRECOGNIZED', startMinute: null, endMinute: null, raw };
    }
    return { kind: 'RANGE', startMinute: start, endMinute: end, raw };
  }

  const exact = EXACT_RE.exec(text);
  if (exact !== null) {
    const [, hour, minute] = exact;
    return { kind: 'EXACT', startMinute: toMinutes(hour, minute), endMinute: null, raw };
  }

  // Произвольный комментарий может содержать числа, похожие на время. Вытаскивать
  // их как достоверный интервал нельзя: «позвонить за 15 минут» интервалом не является.
  return { kind: 'UNRECOGNIZED', startMinute: null, endMinute: null, raw };
}
