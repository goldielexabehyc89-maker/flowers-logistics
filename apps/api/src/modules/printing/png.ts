/**
 * Кадр этикетки в PNG — для глаз, а не для принтера.
 *
 * Существует ровно затем, чтобы человек мог посмотреть на то, что уйдёт
 * в термоголовку, не имея под рукой ни принтера, ни Windows. Печать этим
 * файлом не пользуется: принтеру уходит TSPL.
 *
 * Кодировщик написан здесь, а не взят зависимостью: PNG нужен один
 * и самый простой — серый, без палитры, без прозрачности, — а новая
 * зависимость ради тридцати строк живёт в проекте годами.
 */

import { deflateSync } from 'node:zlib';
import { crc32 } from 'node:zlib';
import type { LabelBitmap } from './raster.js';

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);

  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed) >>> 0, 0);

  return Buffer.concat([length, typed, checksum]);
}

/**
 * PNG из монохромного кадра: чёрная точка — чёрный пиксель.
 *
 * Восемь бит на пиксель, а не один: файл на пару килобайт больше, зато его
 * открывает любой просмотрщик без вопросов о палитре, а смотреть на него
 * будут именно люди.
 */
export function encodeLabelPng(bitmap: LabelBitmap): Uint8Array {
  const stride = bitmap.width + 1;
  const raw = Buffer.alloc(stride * bitmap.height);

  for (let row = 0; row < bitmap.height; row += 1) {
    // Нулевой байт в начале строки — тип фильтра «без фильтрации».
    raw[row * stride] = 0;
    for (let column = 0; column < bitmap.width; column += 1) {
      raw[row * stride + 1 + column] = bitmap.data[row * bitmap.width + column] === 1 ? 0 : 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(bitmap.width, 0);
  header.writeUInt32BE(bitmap.height, 4);
  header[8] = 8; // бит на канал
  header[9] = 0; // серый без альфы
  header[10] = 0; // сжатие deflate
  header[11] = 0; // фильтрация штатная
  header[12] = 0; // без чересстрочности

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
