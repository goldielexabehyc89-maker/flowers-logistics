/**
 * PDF печатного бланка.
 *
 * Стандарт реализует библиотека, а не собственный код. Тот же вывод уже был
 * сделан для QR (`warehouse/qr.ts`): самописный кодировщик умеет доказать
 * только согласованность с самим собой, а бумагу читает чужой сканер и чужой
 * просмотрщик.
 *
 * КИРИЛЛИЦА. Четырнадцать стандартных шрифтов PDF кириллицы не содержат вовсе,
 * поэтому шрифт встраивается в документ. Файл приходит зависимостью npm
 * (`dejavu-fonts-ttf`, лицензия внутри пакета), а не лежит в репозитории и тем
 * более не тянется с CDN: бланк обязан печататься на машине без интернета.
 *
 * ДЕТЕРМИНИРОВАННОСТЬ. Один и тот же снимок обязан давать один и тот же файл:
 * повторная печать — это тот же документ, а не «похожий». Поэтому даты
 * создания и изменения документа фиксированные, идентификатор документа
 * выводится из хеша снимка, а ничего зависящего от текущего времени
 * в генерацию не попадает.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import fontkit from '@pdf-lib/fontkit';
import {
  degrees,
  PDFDocument,
  PDFHexString,
  rgb,
  type PDFArray,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import { encodeQrMatrix } from '../warehouse/qr.js';
import { snapshotHash, type PrintFormSnapshot } from './print-form.js';

/**
 * Путь к шрифту разрешается через `require.resolve`, а не собирается из
 * `node_modules` руками: расположение пакета зависит от того, как менеджер
 * пакетов разложил дерево, и склеенный путь однажды перестал бы находиться.
 */
const resolveFromHere = createRequire(import.meta.url);

/**
 * Шрифт читается один раз за процесс.
 *
 * Файл около 750 КБ; перечитывать его на каждую печать значит тратить время
 * на данные, которые не меняются.
 */
let fontBytesCache: Uint8Array | null = null;

function fontBytes(): Uint8Array {
  if (fontBytesCache === null) {
    fontBytesCache = new Uint8Array(
      readFileSync(resolveFromHere.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf')),
    );
  }
  return fontBytesCache;
}

/** A5 портрет в пунктах: достаточно для состава, но не расточительно по бумаге. */
const PAGE_WIDTH = 419.53;
const PAGE_HEIGHT = 595.28;
const MARGIN = 28;

const TITLE_SIZE = 22;
const BODY_SIZE = 10;
const SMALL_SIZE = 8;
const LINE = 13;

/**
 * Фиксированный момент метаданных документа.
 *
 * Реальное время создания сделало бы файл невоспроизводимым, а само по себе
 * оно на бланке не показывается и никому не нужно: когда заказ собран, знает
 * база, а не PDF.
 */
const FIXED_DATE = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

/**
 * Количество человеку: русская десятичная запятая и единица, если она известна.
 *
 * Каноническое значение хранится с точкой — это машинный формат сравнения
 * и хеша. Запятая появляется только при показе, и только здесь: два разных
 * форматирования одного числа однажды разошлись бы между экраном и бумагой.
 *
 * Единицы может не быть: тогда печатается одно число, без «ед. не указана»
 * и без подставленного «шт.».
 */
export function formatQuantity(quantity: string, uomName: string | null | undefined): string {
  const value = quantity.replace('.', ',');
  const unit = typeof uomName === 'string' && uomName.trim() !== '' ? ` ${uomName.trim()}` : '';
  return `${value}${unit}`;
}

function formatMinutes(minute: number | null): string {
  if (minute === null) {
    return '';
  }
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** `2026-08-21` → `21.08.2026`. Строкой: браузерный парсер сдвигает день. */
function formatDate(value: string | null): string {
  if (value === null) {
    return '—';
  }
  const parts = value.split('-');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : value;
}

function formatInterval(snapshot: PrintFormSnapshot): string {
  const start = formatMinutes(snapshot.intervalStartMinute);
  const end = formatMinutes(snapshot.intervalEndMinute);
  if (start === '') {
    return 'время не указано';
  }
  if (end === '' || end === start) {
    return start;
  }
  return `${start}–${end}`;
}

/** Разбивает текст по ширине, не разрывая слова там, где это возможно. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((word) => word !== '');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current !== '') {
      lines.push(current);
    }
    // Слово длиннее строки режется принудительно: иначе оно уехало бы за поле.
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
      let cut = rest.length;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) {
        cut -= 1;
      }
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }

  if (current !== '') {
    lines.push(current);
  }
  return lines.length === 0 ? [''] : lines;
}

/** Рисует QR как чёрные квадраты: растр не нужен, модули и так прямоугольники. */
function drawQr(page: PDFPage, text: string, x: number, y: number, size: number): void {
  const matrix = encodeQrMatrix(text);
  const modules = matrix.length;
  const module = size / modules;

  for (let row = 0; row < modules; row += 1) {
    const line = matrix[row] ?? [];
    for (let column = 0; column < modules; column += 1) {
      if (line[column] !== true) {
        continue;
      }
      page.drawRectangle({
        x: x + column * module,
        // PDF считает координаты снизу вверх, матрица QR — сверху вниз.
        y: y + size - (row + 1) * module,
        width: module,
        height: module,
        color: rgb(0, 0, 0),
      });
    }
  }
}

/**
 * Собирает PDF бланка из снимка.
 *
 * QR кодирует РОВНО номер заказа — ни ссылку, ни JSON. Физический бланк и поиск
 * обязаны использовать одно значение, иначе сканер кладовщика найдёт не то
 * (`FUL-002` §2.9). Тот же номер печатается текстом: сканер может не сработать,
 * человек — прочитать.
 */
export async function renderPrintFormPdf(snapshot: PrintFormSnapshot): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);

  const font = await document.embedFont(fontBytes(), { subset: true });
  const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const contentWidth = PAGE_WIDTH - MARGIN * 2;

  let cursor = PAGE_HEIGHT - MARGIN;

  const qrSize = 96;
  drawQr(page, snapshot.orderNumber, PAGE_WIDTH - MARGIN - qrSize, cursor - qrSize, qrSize);

  // Номер — самое крупное на бланке: его читают и глазом, и сканером.
  page.drawText(snapshot.orderNumber, {
    x: MARGIN,
    y: cursor - TITLE_SIZE,
    size: TITLE_SIZE,
    font,
    color: rgb(0, 0, 0),
  });
  cursor -= TITLE_SIZE + 10;

  page.drawText(`${formatDate(snapshot.deliveryDate)}   ${formatInterval(snapshot)}`, {
    x: MARGIN,
    y: cursor - BODY_SIZE,
    size: BODY_SIZE,
    font,
  });
  cursor -= BODY_SIZE + 8;

  // Ниже QR-кода начинается общий поток текста.
  cursor = Math.min(cursor, PAGE_HEIGHT - MARGIN - qrSize - 12);

  const section = (title: string): void => {
    cursor -= 6;
    page.drawText(title, { x: MARGIN, y: cursor - SMALL_SIZE, size: SMALL_SIZE, font });
    cursor -= SMALL_SIZE + 4;
    page.drawLine({
      start: { x: MARGIN, y: cursor + 2 },
      end: { x: MARGIN + contentWidth, y: cursor + 2 },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    cursor -= 4;
  };

  const paragraph = (text: string, indent = 0, size = BODY_SIZE): void => {
    for (const line of wrap(text, font, size, contentWidth - indent)) {
      if (cursor - size < MARGIN) {
        // Бланк на одну страницу: длинный состав обрезается видимым признаком,
        // а не молча — иначе флорист решил бы, что букет собран полностью.
        page.drawText('…', { x: MARGIN + indent, y: cursor - size, size, font });
        cursor = MARGIN - 1;
        return;
      }
      page.drawText(line, { x: MARGIN + indent, y: cursor - size, size, font });
      cursor -= LINE;
    }
  };

  section('СОСТАВ');
  if (snapshot.positions.length === 0) {
    paragraph('состав пуст');
  }
  for (const position of snapshot.positions) {
    if (cursor < MARGIN) break;
    const characteristic =
      position.characteristicLabel === null ? '' : ` (${position.characteristicLabel})`;
    paragraph(
      `${formatQuantity(position.quantity, position.uomName)} × ${position.name ?? 'без названия'}${characteristic}`,
    );
    for (const component of position.components) {
      if (cursor < MARGIN) break;
      paragraph(
        `— ${formatQuantity(component.quantity, component.uomName)} × ${component.name ?? 'без названия'}`,
        14,
        SMALL_SIZE,
      );
    }
  }

  if (snapshot.cardText !== null && cursor > MARGIN) {
    section('ТЕКСТ ОТКРЫТКИ');
    paragraph(snapshot.cardText);
  }

  if (snapshot.description !== null && cursor > MARGIN) {
    section('КОММЕНТАРИЙ');
    paragraph(snapshot.description);
  }

  // Метаданные фиксированы: файл обязан быть побайтово тем же при повторе.
  document.setTitle(`Бланк ${snapshot.orderNumber}`);
  document.setProducer('flowers-logistics');
  document.setCreator('flowers-logistics');
  document.setCreationDate(FIXED_DATE);
  document.setModificationDate(FIXED_DATE);

  // Идентификатор документа pdf-lib по умолчанию берёт из времени и случайности.
  // Выводим его из хеша снимка: одинаковый снимок — одинаковый файл.
  const id = snapshotHash(snapshot).slice(0, 32).toUpperCase();
  const idArray = document.context.obj([PDFHexString.of(id), PDFHexString.of(id)]) as PDFArray;
  document.context.trailerInfo.ID = idArray;

  return document.save({ useObjectStreams: false, updateFieldAppearances: false });
}

/** Имя файла бланка: только номер заказа, без PII. */
export function printFormFileName(snapshot: PrintFormSnapshot): string {
  const safe = snapshot.orderNumber.replace(/[^A-Za-z0-9._-]/g, '_');
  return `order-${safe}.pdf`;
}

/** Ровно то, что кодирует QR. Вынесено, чтобы проверка читала то же значение. */
export function qrPayload(snapshot: PrintFormSnapshot): string {
  return snapshot.orderNumber;
}

// --- Термоэтикетка 58×40 мм --------------------------------------------------

/**
 * Этикетка для термопринтера шириной 58 мм.
 *
 * Это ВТОРОЕ представление того же печатного бланка, а не второй механизм
 * печати: снимок, задание, история и аудит остаются прежними, меняется только
 * то, как документ выглядит на бумаге. Поэтому функция живёт здесь, рядом
 * с бланком, и берёт тот же `PrintFormSnapshot`.
 *
 * На этикетке НЕТ ничего, кроме QR и номера заказа. Ни адреса, ни получателя,
 * ни состава: наклейка живёт на коробке, её видит каждый, кто проходит мимо,
 * и любая лишняя строка на ней — это разглашение, которое невозможно отозвать.
 */

/** Пункт PDF — 1/72 дюйма; миллиметр — 1/25.4 дюйма. */
const MM = 72 / 25.4;

/** Физический размер носителя. Одна этикетка — одна страница. */
export const LABEL_WIDTH_MM = 58;
export const LABEL_HEIGHT_MM = 40;

/**
 * Безопасная ширина печати у 58-мм принтеров — около 48 мм.
 *
 * Печатающая головка уже носителя, и края физически не пропечатываются.
 * Поэтому содержимое прижимается к безопасной области, а не к краю бумаги:
 * иначе на части принтеров обрезался бы либо QR, либо номер.
 */
const SAFE_WIDTH_MM = 48;

/** Поля внутри безопасной области. */
const LABEL_PADDING_MM = 2;

/**
 * Сторона QR.
 *
 * Тридцать миллиметров при 203 DPI — это примерно 240 точек на сторону,
 * больше трёх точек на модуль даже для длинного номера. Меньше делать нельзя:
 * термопечать «размывает» модули, и сканер начинает ошибаться.
 */
const QR_SIZE_MM = 30;

/** Тихая зона вокруг QR. Без неё сканер не находит границы кода. */
const QR_QUIET_MM = 2;

const LABEL_NUMBER_MAX_SIZE = 13;

/** Ниже этого кегля термопечать превращает цифры в кашу. */
const LABEL_NUMBER_READABLE_SIZE = 5;

/** Абсолютный пол: ниже него строка перестаёт быть строкой. */
const LABEL_NUMBER_MIN_SIZE = 2;

/**
 * Размер шрифта номера, при котором строка помещается ЦЕЛИКОМ.
 *
 * Номер не переносится и не обрезается. Обрезание здесь — не только наш
 * `slice`: строка, вышедшая за край наклейки, обрезается печатающей головкой
 * и выглядит настоящим номером, просто другим. Кладовщик уходит искать чужой
 * заказ, и понять, что номер неполный, уже нечем.
 *
 * Поэтому подбор идёт в два шага. Сначала — читаемый диапазон от 13 до 5
 * пунктов с шагом в половину пункта: в него укладывается любой настоящий
 * номер. Если строка не помещается и в пять пунктов, кегль считается точно
 * по ширине: мелкий, но целый номер можно сфотографировать и увеличить,
 * а машинное значение всё равно несёт QR. Обрезанный — нельзя ничем.
 */
export function labelNumberFontSize(font: PDFFont, text: string, availableHeight: number): number {
  for (let size = LABEL_NUMBER_MAX_SIZE; size >= LABEL_NUMBER_READABLE_SIZE; size -= 0.5) {
    if (font.widthOfTextAtSize(text, size) <= availableHeight) {
      return size;
    }
  }

  const unitWidth = font.widthOfTextAtSize(text, 1);
  if (unitWidth <= 0) {
    return LABEL_NUMBER_READABLE_SIZE;
  }

  // Округление ВНИЗ до четверти пункта: округлённый вверх кегль дал бы
  // строку на волос шире доступной высоты, то есть то самое обрезание.
  const exact = Math.floor((availableHeight / unitWidth) * 4) / 4;
  return Math.max(LABEL_NUMBER_MIN_SIZE, Math.min(LABEL_NUMBER_READABLE_SIZE, exact));
}

/**
 * Собирает термоэтикетку из того же снимка, что и бланк.
 *
 * QR кодирует РОВНО номер заказа — то же значение, что и на бланке, и то же,
 * которое ожидает складской сканер. Менять его ради макета нельзя: наклейка
 * и поиск обязаны говорить об одном заказе.
 */
export async function renderThermalLabelPdf(snapshot: PrintFormSnapshot): Promise<Uint8Array> {
  const document = await PDFDocument.create();

  const font = await embedLabelFont(document);
  const width = LABEL_WIDTH_MM * MM;
  const height = LABEL_HEIGHT_MM * MM;
  const page = document.addPage([width, height]);

  const safeWidth = SAFE_WIDTH_MM * MM;
  const padding = LABEL_PADDING_MM * MM;
  const qrSize = QR_SIZE_MM * MM;
  const quiet = QR_QUIET_MM * MM;

  // QR слева, по вертикали посередине.
  const qrX = padding;
  const qrY = (height - qrSize) / 2;
  drawQr(page, snapshot.orderNumber, qrX, qrY, qrSize);

  /*
   * Номер справа, повёрнут на 90°, читается снизу вверх.
   *
   * Поворот — не украшение: вдоль короткой стороны 58-мм этикетки длинный
   * номер поместился бы только столбиком по одному символу, а такой номер
   * человек не прочитает и глазами не сверит.
   */
  const numberX = qrX + qrSize + quiet;
  const availableWidth = safeWidth - numberX - padding;
  const availableHeight = height - padding * 2;

  const size = labelNumberFontSize(font, snapshot.orderNumber, availableHeight);
  const textWidth = font.widthOfTextAtSize(snapshot.orderNumber, size);

  page.drawText(snapshot.orderNumber, {
    x: numberX + Math.max(0, (availableWidth - size) / 2) + size,
    // Строка центрируется по высоте: повёрнутый текст растёт вверх от базовой
    // линии, поэтому начало смещается на половину неиспользованной высоты.
    y: padding + Math.max(0, (availableHeight - textWidth) / 2),
    size,
    font,
    color: rgb(0, 0, 0),
    rotate: degrees(90),
  });

  return document.save();
}

/**
 * Высота, в которую обязан уложиться повёрнутый номер.
 *
 * Экспортируется, чтобы проверка мерила ровно ту величину, по которой
 * подбирается кегль, а не собственную копию арифметики — разойдись они,
 * проверка перестала бы ловить обрезанный номер.
 */
export const LABEL_NUMBER_HEIGHT_PT = (LABEL_HEIGHT_MM - LABEL_PADDING_MM * 2) * MM;

/** Гарнитура этикетки. Общая для отрисовки и для замеров в проверках. */
export async function embedLabelFont(document: PDFDocument): Promise<PDFFont> {
  document.registerFontkit(fontkit);
  return document.embedFont(fontBytes(), { subset: true });
}

/** Имя файла этикетки: только номер заказа, без PII. */
export function thermalLabelFileName(snapshot: PrintFormSnapshot): string {
  const safe = snapshot.orderNumber.replace(/[^A-Za-z0-9._-]/g, '_');
  return `label-${safe}.pdf`;
}
