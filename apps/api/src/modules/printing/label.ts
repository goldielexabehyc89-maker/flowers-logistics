/**
 * Геометрия физической этикетки 58×40 мм.
 *
 * Одна раскладка на два вида этикеток — заказа и складской ячейки. Различаются
 * они только тем, что кодирует QR и что написано текстом; всё остальное —
 * размер носителя, положение кода, поворот подписи, подбор кегля — обязано
 * совпадать. Разведи мы их по двум файлам, они разошлись бы на первой же
 * правке, и на ленте оказались бы наклейки разного вида.
 *
 * Здесь только ЧИСТАЯ раскладка: ни PDF, ни растра, ни печати. Поэтому один
 * и тот же расчёт проверяется отдельно и используется всеми представлениями —
 * бумажным, растровым и принтерным. Разойдись они, на экране был бы один
 * макет, а из принтера вышел бы другой.
 */

import { AppError } from '../../platform/errors.js';

/** Пункт PDF на миллиметр. */
export const MM = 72 / 25.4;

export const LABEL_WIDTH_MM = 58;
export const LABEL_HEIGHT_MM = 40;

/**
 * Безопасная ширина печати у 58-мм принтеров — около 48 мм.
 *
 * Печатающая головка уже носителя, и края физически не пропечатываются.
 * Содержимое прижимается к безопасной области, а не к краю бумаги: иначе
 * на части принтеров обрезался бы либо QR, либо подпись.
 */
export const SAFE_WIDTH_MM = 48;

/** Поля внутри безопасной области. */
export const PADDING_MM = 2;

/**
 * Сторона QR.
 *
 * Тридцать миллиметров при 203 DPI — это 240 точек на сторону: больше трёх
 * точек на модуль даже для самого длинного допустимого номера. Меньше делать
 * нельзя: термопечать «размывает» модули, и сканер начинает ошибаться.
 */
export const QR_SIZE_MM = 30;

/** Тихая зона вокруг QR. Без неё сканер не находит границы кода. */
export const QR_QUIET_MM = 2;

/** Кегль подписи: от крупного к мелкому, шаг в половину пункта. */
const MAX_SIZE = 13;

/** Ниже этого кегля термопечать превращает знаки в кашу. */
export const READABLE_SIZE = 5;

/** Абсолютный пол: ниже него строка перестаёт быть строкой. */
const MIN_SIZE = 2;

/** Просвет между двумя строками подписи, в пунктах. */
const LINE_GAP = 2;

/**
 * Длина, до которой подпись остаётся ОДНОЙ строкой.
 *
 * Тридцать два знака — не круглое число, а граница читаемости: при большей
 * длине одна строка вдоль наклейки вынуждает опускать кегль ниже пяти пунктов,
 * то есть печатать номер, который человек не прочтёт. Дальше подпись
 * переносится на вторую строку — но НЕ обрезается и не заканчивается
 * многоточием: обрезанный номер выглядит настоящим и уводит кладовщика
 * к чужому заказу.
 */
export const SINGLE_LINE_MAX = 32;

/** Больше двух строк не бывает: третья строка не влезает по ширине колонки. */
export const MAX_LINES = 2;

/** Знаки, по которым подпись делится охотнее всего: они уже разделяют смысл. */
const SEPARATORS = new Set([' ', '-', '_', '.', '/', ':']);

/** Что измеряет раскладка. Реализуют и шрифт PDF, и шрифт растра. */
export interface TextWidth {
  widthOfTextAtSize(text: string, size: number): number;
}

export interface LabelContent {
  /** Значение внутри QR: номер заказа либо нормализованный код ячейки. */
  qrText: string;
  /** Подпись рядом с кодом. Печатается целиком. */
  caption: string;
}

export interface LabelLayout {
  /** Квадрат QR: левый нижний угол и сторона, в миллиметрах. */
  qr: { x: number; y: number; size: number };
  /** Строки подписи снизу вверх, вместе с выбранным кеглем в пунктах. */
  lines: string[];
  size: number;
  /** Левая граница колонки подписи и её ширина, в миллиметрах. */
  textX: number;
  textWidth: number;
}

/**
 * Делит подпись не более чем на две строки.
 *
 * Деление ищет разделитель ближе к середине: «CRM-2026-08-29-000042» человек
 * читает по частям, и разрыв внутри группы цифр сбивает сверку сильнее, чем
 * перенос по дефису. Если разделителя нет, строка делится ровно пополам —
 * это хуже для чтения, но лучше, чем потерянный хвост.
 */
export function splitCaption(caption: string): string[] {
  const text = caption.trim();
  if (text.length <= SINGLE_LINE_MAX) {
    return [text];
  }

  const middle = Math.floor(text.length / 2);
  const window = Math.max(2, Math.floor(text.length / 4));

  let best = -1;
  for (let index = 1; index < text.length; index += 1) {
    if (!SEPARATORS.has(text[index] ?? '')) {
      continue;
    }
    if (Math.abs(index - middle) > window) {
      continue;
    }
    if (best === -1 || Math.abs(index - middle) < Math.abs(best - middle)) {
      best = index;
    }
  }

  // Разделитель остаётся в КОНЦЕ первой строки: перенесённый в начало второй,
  // он читался бы как часть следующей группы.
  const cut = best === -1 ? middle : best + 1;
  return [text.slice(0, cut), text.slice(cut)];
}

/**
 * Наибольший кегль, при котором ВСЕ строки помещаются целиком.
 *
 * Помещаются в двух измерениях сразу: по длине наклейки (туда растёт
 * повёрнутая строка) и поперёк (столько строк должно уместиться в колонку
 * рядом с QR). Проверять только длину было бы половиной работы: вторая строка
 * просто ушла бы за край.
 */
export function captionFontSize(
  font: TextWidth,
  lines: readonly string[],
  availableLength: number,
  availableWidth: number,
): number {
  const longest = (size: number): number =>
    Math.max(...lines.map((line) => font.widthOfTextAtSize(line, size)));

  const fitsAcross = (size: number): boolean =>
    size * lines.length + LINE_GAP * (lines.length - 1) <= availableWidth;

  for (let size = MAX_SIZE; size >= READABLE_SIZE; size -= 0.5) {
    if (longest(size) <= availableLength && fitsAcross(size)) {
      return size;
    }
  }

  /*
   * Читаемым кеглем не обошлось. Обрезать подпись всё равно нельзя: обрезанный
   * номер выглядит настоящим. Поэтому кегль считается точно по самой длинной
   * строке — мелкий, но целый номер можно сфотографировать и увеличить,
   * а машинное значение всё равно несёт QR.
   */
  const unit = longest(1);
  if (unit <= 0) {
    return READABLE_SIZE;
  }

  const byLength = Math.floor((availableLength / unit) * 4) / 4;
  const byWidth =
    Math.floor(((availableWidth - LINE_GAP * (lines.length - 1)) / lines.length) * 4) / 4;

  return Math.max(MIN_SIZE, Math.min(READABLE_SIZE, byLength, byWidth));
}

/**
 * Раскладка одной этикетки.
 *
 * QR слева и по центру высоты, подпись справа вдоль длинной стороны, снизу
 * вверх. Поворот — не украшение: поперёк 58-мм наклейки длинная подпись
 * поместилась бы только столбиком по одному знаку, а такой номер человек
 * не прочитает и глазами не сверит.
 */
export function layoutLabel(font: TextWidth, content: LabelContent): LabelLayout {
  if (content.caption.trim() === '') {
    throw new AppError('VALIDATION_FAILED', {
      message: 'label caption is empty',
      publicMessage: 'Этикетка без подписи не печатается.',
    });
  }

  const qr = { x: PADDING_MM, y: (LABEL_HEIGHT_MM - QR_SIZE_MM) / 2, size: QR_SIZE_MM };

  const textX = qr.x + qr.size + QR_QUIET_MM;
  const textWidth = SAFE_WIDTH_MM - textX - PADDING_MM;

  const lines = splitCaption(content.caption);
  const size = captionFontSize(
    font,
    lines,
    (LABEL_HEIGHT_MM - PADDING_MM * 2) * MM,
    textWidth * MM,
  );

  return { qr, lines, size, textX, textWidth };
}
