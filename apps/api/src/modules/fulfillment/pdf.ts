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
import { PDFDocument, PDFHexString, rgb, type PDFArray, type PDFFont, type PDFPage } from 'pdf-lib';
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
    paragraph(`${position.quantity} × ${position.name ?? 'без названия'}${characteristic}`);
    for (const component of position.components) {
      if (cursor < MARGIN) break;
      paragraph(`— ${component.quantity} × ${component.name ?? 'без названия'}`, 14, SMALL_SIZE);
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
