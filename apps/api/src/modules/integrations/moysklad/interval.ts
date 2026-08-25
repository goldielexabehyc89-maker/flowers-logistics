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
 * не выдумывается. Диапазон с ОДИНАКОВЫМИ границами — тот же случай: «с 09:00
 * до 09:00» человек пишет ровно тогда, когда обещал прийти к девяти, и это
 * точное время, записанное привычной ему формой.
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

/**
 * Время: час обязателен, минуты — нет.
 *
 * «10» человек пишет ровно в том же смысле, что «10:00», и в поле свободного
 * текста делает это постоянно. Минуты вынесены в необязательную группу того же
 * выражения, а не в отдельный разбор: два разбора одного поля однажды разошлись
 * бы, и «9-10» означало бы разное в импорте и в проверке.
 *
 * Часы и минуты по-прежнему ограничены сутками: `24`, `25` и `9:75` остаются
 * непонятыми, а не превращаются в догадку.
 */
const TIME = '([01]?\\d|2[0-3])(?:[:.]([0-5]\\d))?';

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
 * Минуты необязательной группы.
 *
 * Отсутствие группы — это НУЛЬ минут, а не отказ: «10» означает начало часа.
 * Отдельная функция нужна потому, что `group` намеренно бросает на пустой
 * группе — там она сторожит обязательные части выражения.
 */
function optionalMinutes(match: RegExpExecArray, index: number): string {
  return match[index] ?? '00';
}

/**
 * Обязательная группа совпадения.
 *
 * Выражение уже совпало, поэтому группа существует. Проверка нужна не для рантайма,
 * а чтобы правка регулярного выражения не превратилась в тихий разбор мусора.
 */
function group(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error('регулярное выражение интервала изменилось: группа отсутствует');
  }
  return value;
}

/**
 * Разбирает текст интервала.
 *
 * Возвращает MISSING для пустого значения, RANGE для корректного диапазона,
 * EXACT для одиночного времени и для диапазона с одинаковыми границами,
 * UNRECOGNIZED во всех остальных случаях.
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
    const start = toMinutes(group(range, 1), optionalMinutes(range, 2));
    const end = toMinutes(group(range, 3), optionalMinutes(range, 4));

    /*
     * Одинаковые границы — точное время, а не пустой интервал.
     *
     * Прежде такой заказ уходил в «Требует внимания» как нераспознанный, и
     * логист руками вписывал то же самое время. Догадки здесь нет: обе
     * границы названы человеком и совпадают, а «в 09:00» и «с 09:00 до 09:00»
     * обещают клиенту одно и то же.
     *
     * Конец остаётся пустым — ровно как у одиночного времени. Записать сюда
     * `end` значило бы завести второй способ хранить точное время, и первый
     * же потребитель, читающий только `endMinute`, увидел бы диапазон.
     */
    if (end === start) {
      return { kind: 'EXACT', startMinute: start, endMinute: null, raw };
    }

    // Обратный диапазон интервалом не является. «с 19:00 по 16:00» может быть
    // как опечаткой, так и переходом через полночь; угадывать между ними нельзя.
    if (end < start) {
      return { kind: 'UNRECOGNIZED', startMinute: null, endMinute: null, raw };
    }
    return { kind: 'RANGE', startMinute: start, endMinute: end, raw };
  }

  const exact = EXACT_RE.exec(text);
  if (exact !== null) {
    return {
      kind: 'EXACT',
      startMinute: toMinutes(group(exact, 1), optionalMinutes(exact, 2)),
      endMinute: null,
      raw,
    };
  }

  // Произвольный комментарий может содержать числа, похожие на время. Вытаскивать
  // их как достоверный интервал нельзя: «позвонить за 15 минут» интервалом не является.
  return { kind: 'UNRECOGNIZED', startMinute: null, endMinute: null, raw };
}
