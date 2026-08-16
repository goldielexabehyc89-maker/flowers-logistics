/**
 * Разбор закодированной геометрии Valhalla.
 *
 * Valhalla отдаёт линию маршрута строкой в формате Google Encoded Polyline,
 * но с точностью 1e-6, а не 1e-5. Перепутанная точность смещает маршрут
 * в десять раз — линия уезжает за сотни километров, и заметить это по одной
 * координате невозможно, поэтому точность здесь задаётся явно и проверяется.
 *
 * Разбор отдельным чистым модулем: он не зависит ни от сети, ни от базы,
 * и доказывается на известных строках.
 */

/** Точность Valhalla: шесть знаков после запятой. */
export const VALHALLA_PRECISION = 6;

/** Точка линии в порядке MapLibre: долгота, затем широта. */
export type LngLat = [number, number];

/**
 * Раскодирует строку в последовательность точек.
 *
 * Возвращает пустой массив на пустой строке: маршрут без геометрии — это
 * отсутствие линии, а не ошибка разбора. Испорченная строка отличается
 * от пустой и приводит к исключению: нарисовать «примерно то, что вышло»
 * значило бы показать логисту путь, которого никто не считал.
 */
export function decodePolyline(encoded: string, precision = VALHALLA_PRECISION): LngLat[] {
  if (encoded === '') {
    return [];
  }

  const factor = 10 ** precision;
  const points: LngLat[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    lat += readValue();
    lon += readValue();
    points.push([lon / factor, lat / factor]);
  }

  return points;

  function readValue(): number {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      if (index >= encoded.length) {
        throw new Error('оборванная строка геометрии');
      }
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      if (byte < 0 || byte > 63) {
        throw new Error('недопустимый символ геометрии');
      }
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    // Младший бит — знак: нечётное значение означает отрицательное смещение.
    return (result & 1) === 1 ? ~(result >> 1) : result >> 1;
  }
}

/**
 * Обратное преобразование: точки в строку.
 *
 * Нужно ровно одному месту — локальной подмене маршрутизатора, которая обязана
 * отвечать в НАСТОЯЩЕМ формате Valhalla, чтобы разбор ответа, клиент и весь
 * контракт геометрии оставались непроверенными только в одной точке: в самом
 * источнике линии.
 */
export function encodePolyline(points: readonly LngLat[], precision = VALHALLA_PRECISION): string {
  const factor = 10 ** precision;
  let lastLat = 0;
  let lastLon = 0;
  let encoded = '';

  const write = (value: number): void => {
    let shifted = value < 0 ? ~(value << 1) : value << 1;
    while (shifted >= 0x20) {
      encoded += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
      shifted >>= 5;
    }
    encoded += String.fromCharCode(shifted + 63);
  };

  for (const [lon, lat] of points) {
    const latValue = Math.round(lat * factor);
    const lonValue = Math.round(lon * factor);
    write(latValue - lastLat);
    write(lonValue - lastLon);
    lastLat = latValue;
    lastLon = lonValue;
  }

  return encoded;
}
