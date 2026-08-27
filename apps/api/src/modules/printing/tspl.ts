/**
 * Задание для термопринтера на языке TSPL.
 *
 * Готовое задание собирает СЕРВЕР, а не Windows-агент. Причина простая:
 * агент придётся ставить на чужие компьютеры и обновлять руками, а сервер
 * обновляется сам. Вся раскладка, шрифт и растеризация остаются здесь,
 * агенту достаётся один шаг — отдать готовые байты в спулер как raw-поток.
 *
 * ПОЛЯРНОСТЬ. В команде BITMAP единица бита означает БЕЛУЮ точку, ноль —
 * чёрную: данные для принтера инвертированы относительно привычного «1 —
 * закрасить». Ошибка здесь не ломает печать, а печатает негатив — сплошной
 * чёрный прямоугольник с белым QR, который не читает ни один сканер.
 *
 * ФИЗИЧЕСКАЯ ПРОВЕРКА. Ни один тест здесь не доказывает, что бумага вышла
 * из XP-318B: этого нельзя проверить без принтера. Проверяется структура
 * задания и содержимое кадра, а физический выход — отдельная приёмка.
 */

import { LABEL_HEIGHT_MM, LABEL_WIDTH_MM } from './label.js';
import { RASTER_HEIGHT, RASTER_WIDTH, type LabelBitmap } from './raster.js';

/**
 * Зазор между наклейками на ленте.
 *
 * Два миллиметра — обычный зазор рулона 58×40. Значение вынесено в константу
 * не ради настройки, а ради места, куда смотреть при калибровке: если принтер
 * протягивает лишнюю наклейку, поправляется именно оно.
 */
const GAP_MM = 2;

/** Плотность нагрева: середина шкалы 0…15. Ниже — бледно, выше — растекается. */
const DENSITY = 8;

/** Скорость печати в дюймах в секунду: медленнее — чётче мелкий шрифт. */
const SPEED = 3;

/**
 * Байты кадра для команды BITMAP: по биту на точку, старший бит — левая точка.
 *
 * Ширина кадра кратна восьми (464 = 58 × 8), поэтому неполных байтов в строке
 * не бывает и дополнять нечем.
 */
export function bitmapBytes(bitmap: LabelBitmap): Uint8Array {
  const bytesPerRow = Math.ceil(bitmap.width / 8);
  const out = new Uint8Array(bytesPerRow * bitmap.height).fill(0xff);

  for (let row = 0; row < bitmap.height; row += 1) {
    for (let column = 0; column < bitmap.width; column += 1) {
      if (bitmap.data[row * bitmap.width + column] !== 1) {
        continue;
      }
      const index = row * bytesPerRow + (column >> 3);
      // Чёрная точка — СБРОШЕННЫЙ бит: у TSPL инвертированная полярность.
      out[index] = (out[index] ?? 0xff) & ~(0x80 >> (column & 7));
    }
  }

  return out;
}

/**
 * Одно задание печати: несколько этикеток подряд одним потоком.
 *
 * Команды заголовка повторяются перед каждой наклейкой намеренно: принтер
 * могли выключить и включить между заданиями, а SIZE и GAP он теряет вместе
 * с питанием — и следующая партия печаталась бы с чужим размером носителя.
 */
export function encodeTsplJob(bitmaps: readonly LabelBitmap[]): Uint8Array {
  const parts: Buffer[] = [];

  for (const bitmap of bitmaps) {
    if (bitmap.width !== RASTER_WIDTH || bitmap.height !== RASTER_HEIGHT) {
      throw new Error(
        `кадр ${bitmap.width}×${bitmap.height} не соответствует наклейке ${RASTER_WIDTH}×${RASTER_HEIGHT}`,
      );
    }

    const bytesPerRow = bitmap.width / 8;
    const header = [
      `SIZE ${LABEL_WIDTH_MM} mm,${LABEL_HEIGHT_MM} mm`,
      `GAP ${GAP_MM} mm,0 mm`,
      `DENSITY ${DENSITY}`,
      `SPEED ${SPEED}`,
      'DIRECTION 1',
      'CLS',
      `BITMAP 0,0,${bytesPerRow},${bitmap.height},0,`,
    ].join('\r\n');

    parts.push(Buffer.from(header, 'latin1'));
    parts.push(Buffer.from(bitmapBytes(bitmap)));
    parts.push(Buffer.from('\r\nPRINT 1,1\r\n', 'latin1'));
  }

  return new Uint8Array(Buffer.concat(parts));
}
