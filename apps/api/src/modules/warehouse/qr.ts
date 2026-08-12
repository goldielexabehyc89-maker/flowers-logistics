/**
 * Печатная этикетка складской ячейки.
 *
 * Кодирование QR выполняет поддерживаемая библиотека `qrcode-generator`,
 * а не собственная реализация стандарта. Прежний самописный кодировщик умел
 * доказать только внутреннюю согласованность с собственным же обратным чтением;
 * для физического склада этого мало — этикетку читает чужой сканер, и цена
 * ошибки здесь не косметическая, а потерянный заказ.
 *
 * Здесь остаются ровно две вещи: тонкий адаптер к библиотеке и отрисовка
 * самодостаточного документа. Ни таблиц версий, ни кодов Рида — Соломона,
 * ни масок, ни размещения служебных модулей этот файл больше не содержит.
 */

import qrcode from 'qrcode-generator';
import { AppError } from '../../platform/errors.js';

/**
 * Уровень коррекции M: разумный баланс плотности и устойчивости к замятой
 * или запачканной наклейке на складской полке.
 */
const ERROR_CORRECTION = 'M';

/**
 * Кодировка байтового режима.
 *
 * Библиотека по умолчанию раскладывает строку в однобайтовую кодировку, и код
 * ячейки с кириллицей превратился бы в мусор ещё до кодирования. Готовый
 * UTF-8-вариант лежит в отдельном файле пакета, но его подключение закрыто
 * полем `exports`, поэтому подставляется штатный `TextEncoder` платформы.
 * Это преобразование строки в байты UTF-8, а не часть стандарта QR:
 * кодирование символа целиком остаётся за библиотекой.
 *
 * Назначение выполняется один раз при загрузке модуля и обязательно ДО
 * `addData`: библиотека раскладывает строку в байты в момент добавления данных.
 * Другого пользователя у неё в приложении нет.
 */
qrcode.stringToBytes = (value: string): number[] => Array.from(new TextEncoder().encode(value));

/**
 * Матрица модулей QR: `true` — тёмный.
 *
 * Тип символа выбирается библиотекой автоматически (`0`) по длине данных.
 */
export function encodeQrMatrix(text: string): boolean[][] {
  const symbol = qrcode(0, ERROR_CORRECTION);
  symbol.addData(text, 'Byte');

  try {
    symbol.make();
  } catch (error) {
    // Единственная ожидаемая причина — данные не помещаются ни в один символ.
    // Наружу уходит понятная причина, а не внутреннее сообщение библиотеки.
    throw new AppError('VALIDATION_FAILED', {
      message: `qr encoding failed: ${error instanceof Error ? error.message : String(error)}`,
      publicMessage: 'Код ячейки слишком длинный для этикетки.',
    });
  }

  const size = symbol.getModuleCount();
  return Array.from({ length: size }, (_row, row) =>
    Array.from({ length: size }, (_col, col) => symbol.isDark(row, col)),
  );
}

/** Экранирование текста внутри SVG: подпись приходит из кода ячейки. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface LabelOptions {
  /** Размер одного модуля в единицах SVG. */
  moduleSize?: number;
  /** Светлое поле вокруг кода, в модулях. Стандарт требует не меньше четырёх. */
  quietZone?: number;
}

/**
 * Размер модуля по умолчанию.
 *
 * Восемь, а не четыре: этикетку печатают и наклеивают на полку, а читает её
 * обычная камера телефона под углом и при складском освещении. Экономия
 * на размере модуля здесь оборачивается нераспознанной наклейкой.
 */
const DEFAULT_MODULE_SIZE = 8;
const DEFAULT_QUIET_ZONE = 4;

/**
 * Печатная этикетка ячейки: QR и подпись под ним.
 *
 * В документе нет ни ссылок, ни внешних ресурсов, ни шрифтов с чужого сервера:
 * SVG, открытый в браузере или в редакторе, не должен никуда ходить.
 * Подпись дублирует код словами — этикетку должно быть можно прочитать глазами,
 * когда сканер не работает.
 *
 * Отрисовка детерминированная: один и тот же код всегда даёт один и тот же
 * документ, поэтому этикетку можно перепечатать и сверить.
 */
export function renderCellLabelSvg(normalizedCode: string, options: LabelOptions = {}): string {
  const moduleSize = options.moduleSize ?? DEFAULT_MODULE_SIZE;
  const quietZone = options.quietZone ?? DEFAULT_QUIET_ZONE;

  const matrix = encodeQrMatrix(normalizedCode);
  const size = matrix.length;
  const side = (size + quietZone * 2) * moduleSize;
  const captionHeight = Math.max(16, moduleSize * 4);
  const height = side + captionHeight;

  const rects: string[] = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if ((matrix[row] ?? [])[col] !== true) {
        continue;
      }
      const x = (col + quietZone) * moduleSize;
      const y = (row + quietZone) * moduleSize;
      rects.push(`<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}"/>`);
    }
  }

  const caption = escapeXml(normalizedCode);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${height}"`,
    ` viewBox="0 0 ${side} ${height}" role="img" aria-label="${caption}">`,
    `<rect width="${side}" height="${height}" fill="#ffffff"/>`,
    `<g fill="#000000">${rects.join('')}</g>`,
    `<text x="${side / 2}" y="${side + captionHeight / 2}" fill="#000000"`,
    ` font-family="monospace" font-size="${Math.max(10, moduleSize * 2)}"`,
    ` text-anchor="middle" dominant-baseline="middle">${caption}</text>`,
    '</svg>',
  ].join('');
}
