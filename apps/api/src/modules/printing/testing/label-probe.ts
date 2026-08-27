/**
 * Чтение готовой этикетки — для проверок.
 *
 * Функции разбирают КОНЕЧНЫЙ документ: поток содержимого PDF, а не наши
 * внутренние структуры. Проверка, читающая собственную матрицу QR, доказывает
 * лишь согласованность генератора с самим собой; наклейку же читает чужой
 * сканер и чужой просмотрщик.
 *
 * Модуль общий для проверок печати заказа и печати ячеек: две копии этого
 * разбора однажды разошлись бы, и одна из них перестала бы ловить ошибку.
 */

import { inflateSync } from 'node:zlib';

/** Все текстовые потоки документа, распакованные и склеенные. */
export function pdfContent(pdf: Uint8Array): string {
  const buffer = Buffer.from(pdf);
  const marker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');
  let content = '';
  let index = 0;

  for (;;) {
    const at = buffer.indexOf(marker, index);
    if (at === -1) {
      break;
    }
    let start = at + marker.length;
    if (buffer[start] === 0x0d) {
      start += 1;
    }
    if (buffer[start] === 0x0a) {
      start += 1;
    }
    const end = buffer.indexOf(endMarker, start);
    if (end === -1) {
      break;
    }
    try {
      content += inflateSync(buffer.subarray(start, end)).toString('latin1');
    } catch {
      // Несжатый поток: шрифт или метаданные, текста в них нет.
    }
    index = end + endMarker.length;
  }

  return content;
}

/** Сколько операций показа текста в документе: столько же и строк. */
export function textOperations(pdf: Uint8Array): number {
  return (pdfContent(pdf).match(/Tj/g) ?? []).length;
}

/** Кегль первой текстовой строки документа. */
export function firstFontSize(pdf: Uint8Array): number {
  const match = /\/[A-Za-z0-9+.-]+ ([\d.]+) Tf/.exec(pdfContent(pdf));
  return match === null ? 0 : Number(match[1]);
}

export interface RasterizedQr {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** Сторона одного модуля в пунктах: по ней считается размер точки принтера. */
  moduleSizePt: number;
  /** Сколько модулей в стороне символа. */
  modules: number;
  minX: number;
  maxX: number;
}

/**
 * Модули QR, прочитанные ИЗ ГОТОВОГО PDF и растеризованные.
 *
 * Читается фактический поток содержимого — то же, что увидит просмотрщик
 * и сканер, — а не наша матрица. Подпись рядом с кодом рисуется контурами
 * шрифта и под этот разбор не попадает: она вне области QR и декодированию
 * не мешает.
 *
 * `page` выбирает страницу многостраничного документа: в пакете этикеток
 * каждая наклейка занимает свою.
 */
export function rasterizeQr(pdf: Uint8Array, page = 0): RasterizedQr {
  const content = pdfContent(pdf);
  const square =
    /1 0 0 1 ([\d.]+) ([\d.]+) cm[\s\S]{0,80}?0 0 m\s+0 ([\d.]+) l\s+([\d.]+) \3 l\s+\4 0 l\s+h\s+f/g;

  const pages: { x: number; y: number; size: number }[][] = [];
  let current: { x: number; y: number; size: number }[] = [];
  let previous: { x: number; y: number } | null = null;

  let match = square.exec(content);
  while (match !== null) {
    const found = { x: Number(match[1]), y: Number(match[2]), size: Number(match[3]) };

    /*
     * Граница страниц определяется по возврату координат назад.
     *
     * Модули одной наклейки идут слева направо и сверху вниз, поэтому первый
     * модуль следующей страницы всегда оказывается левее и выше предыдущего.
     * Разбирать структуру страниц PDF ради этого не нужно.
     */
    if (previous !== null && found.x < previous.x && found.y > previous.y && current.length > 0) {
      pages.push(current);
      current = [];
    }

    current.push(found);
    previous = found;
    match = square.exec(content);
  }
  if (current.length > 0) {
    pages.push(current);
  }

  const modulesOnPage = pages[page];
  if (modulesOnPage === undefined || modulesOnPage.length === 0) {
    throw new Error(`на странице ${page} нет ни одного модуля QR`);
  }

  const size = modulesOnPage[0]?.size ?? 1;
  const minX = Math.min(...modulesOnPage.map((module) => module.x));
  const minY = Math.min(...modulesOnPage.map((module) => module.y));
  const maxX = Math.max(...modulesOnPage.map((module) => module.x));
  const maxY = Math.max(...modulesOnPage.map((module) => module.y));

  const quiet = 4;
  const columns = Math.round((maxX - minX) / size) + 1;
  const rows = Math.round((maxY - minY) / size) + 1;
  const scale = 4;
  const width = (columns + quiet * 2) * scale;
  const height = (rows + quiet * 2) * scale;

  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const module of modulesOnPage) {
    const column = Math.round((module.x - minX) / size) + quiet;
    const row = rows - 1 - Math.round((module.y - minY) / size) + quiet;
    for (let dy = 0; dy < scale; dy += 1) {
      for (let dx = 0; dx < scale; dx += 1) {
        const offset = ((row * scale + dy) * width + (column * scale + dx)) * 4;
        pixels[offset] = 0;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = 0;
      }
    }
  }

  return { data: pixels, width, height, moduleSizePt: size, modules: columns, minX, maxX };
}

/** Сколько страниц в документе. Считается по объектам страниц. */
export function pageCount(pdf: Uint8Array): number {
  return (
    Buffer.from(pdf)
      .toString('latin1')
      .match(/\/Type\s*\/Page[^s]/g) ?? []
  ).length;
}
