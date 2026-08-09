/**
 * Разбор заголовка `Range` для отдачи PMTiles.
 *
 * PMTiles — единый файл на сотни мегабайт, из которого карта читает несколько
 * килобайт на каждый тайл. Без диапазонных запросов браузер тянул бы весь архив
 * ради одного экрана, поэтому поддержка `Range` здесь не оптимизация,
 * а условие работоспособности формата.
 *
 * Разбор строгий и намеренно узкий: поддерживается ровно один диапазон.
 * Составные диапазоны требуют ответа `multipart/byteranges`, которого клиенты
 * PMTiles не запрашивают; молча отдать вместо него первый кусок значило бы
 * вернуть не те байты под видом правильного ответа.
 */

export type RangeResult =
  | { kind: 'FULL' }
  | { kind: 'PARTIAL'; start: number; end: number; length: number }
  /** Диапазон синтаксически верен, но не пересекается с файлом: 416. */
  | { kind: 'UNSATISFIABLE' };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Разбирает `Range` для файла известного размера.
 *
 * Возвращает `FULL`, когда заголовка нет или он не распознан: по спецификации
 * нераспознанный `Range` игнорируется, а не приводит к ошибке.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined || header.trim() === '') {
    return { kind: 'FULL' };
  }

  const match = SINGLE_RANGE.exec(header.trim());
  if (match === null) {
    // Несколько диапазонов, другие единицы измерения, мусор — игнорируем
    // и отдаём файл целиком. Это разрешено и безопаснее частичного ответа.
    return { kind: 'FULL' };
  }

  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';

  if (rawStart === '' && rawEnd === '') {
    return { kind: 'FULL' };
  }

  // Пустой файл диапазонами не отдаётся: любой диапазон в нём неудовлетворим.
  if (size === 0) {
    return { kind: 'UNSATISFIABLE' };
  }

  if (rawStart === '') {
    // `bytes=-N` — последние N байт.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return { kind: 'UNSATISFIABLE' };
    }
    const start = Math.max(0, size - suffix);
    return { kind: 'PARTIAL', start, end: size - 1, length: size - start };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
    return { kind: 'UNSATISFIABLE' };
  }

  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) {
    return { kind: 'UNSATISFIABLE' };
  }

  // Конец за пределами файла обрезается по размеру: так требует спецификация.
  const last = Math.min(end, size - 1);
  return { kind: 'PARTIAL', start, end: last, length: last - start + 1 };
}

/** Значение заголовка `Content-Range` для частичного ответа. */
export function contentRange(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

/** Значение `Content-Range` для отказа 416: клиенту нужен размер файла. */
export function unsatisfiableContentRange(size: number): string {
  return `bytes */${size}`;
}
