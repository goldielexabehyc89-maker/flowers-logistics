/**
 * Проверки разбора геометрии.
 *
 * Защищаемое свойство: точность 1e-6. Разбор той же строки как 1e-5 смещает
 * маршрут в десять раз, и по одной координате это незаметно.
 */

import { describe, expect, it } from 'vitest';
import { decodePolyline, VALHALLA_PRECISION } from './polyline.js';

/**
 * Кодировщик для фикстуры.
 *
 * Живёт в проверке намеренно: строку геометрии нельзя написать от руки,
 * а брать её из того же кода, который проверяется, значило бы доказывать
 * совпадение кода с самим собой. Здесь независимая реализация формата.
 */
function encode(points: readonly [number, number][], precision = 6): string {
  const factor = 10 ** precision;
  let lastLat = 0;
  let lastLon = 0;
  let out = '';

  const chunk = (value: number): void => {
    let shifted = value < 0 ? ~(value << 1) : value << 1;
    while (shifted >= 0x20) {
      out += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
      shifted >>= 5;
    }
    out += String.fromCharCode(shifted + 63);
  };

  for (const [lon, lat] of points) {
    const latValue = Math.round(lat * factor);
    const lonValue = Math.round(lon * factor);
    chunk(latValue - lastLat);
    chunk(lonValue - lastLon);
    lastLat = latValue;
    lastLon = lonValue;
  }
  return out;
}

describe('геометрия маршрута', () => {
  it('пустая строка — это отсутствие линии, а не ошибка', () => {
    expect(decodePolyline('')).toEqual([]);
  });

  it('точки возвращаются в порядке долгота-широта', () => {
    // MapLibre принимает пару долгота-широта. Перепутанный порядок увёз бы
    // московский маршрут в Индийский океан.
    const [point] = decodePolyline(encode([[37.6173, 55.7558]]));

    expect(point?.[0]).toBeCloseTo(37.6173, 6);
    expect(point?.[1]).toBeCloseTo(55.7558, 6);
  });

  it('точность задана явно и равна шести знакам', () => {
    const encoded = encode([[37.6173, 55.7558]]);
    const [strict] = decodePolyline(encoded, VALHALLA_PRECISION);
    const [loose] = decodePolyline(encoded, 5);

    expect(VALHALLA_PRECISION).toBe(6);
    // Ошибка в точности — это не мелочь: та же строка даёт координату
    // в десять раз дальше от нуля.
    expect(loose?.[0]).toBeCloseTo((strict?.[0] ?? 0) * 10, 3);
  });

  it('последовательность накапливает смещения, а не повторяет первую точку', () => {
    const line: [number, number][] = [
      [37.6173, 55.7558],
      [37.62, 55.76],
      [37.7, 55.8],
    ];
    const points = decodePolyline(encode(line));

    expect(points).toHaveLength(3);
    expect(points[2]?.[0]).toBeCloseTo(37.7, 6);
    expect(points[2]?.[1]).toBeCloseTo(55.8, 6);
  });

  it('оборванная строка отвергается, а не рисуется приблизительно', () => {
    // Нарисовать «примерно то, что вышло» значило бы показать логисту путь,
    // которого никто не считал.
    const encoded = encode([[37.6173, 55.7558]]);
    expect(() => decodePolyline(`${encoded}_`)).toThrow();
  });
});

describe('локальная подмена маршрутизатора', () => {
  it('отвечает в настоящем формате Valhalla и разбирается тем же кодом', async () => {
    // Подмена стоит на транспорте: если бы она отвечала «удобной» структурой,
    // настоящий разбор ответа остался бы непроверенным.
    const { createTestRouterFetch } = await import('./test-router.js');
    const fetchImpl = createTestRouterFetch();

    const response = await fetchImpl('http://valhalla.local.test/route', {
      method: 'POST',
      body: JSON.stringify({
        locations: [
          { lat: 55.7, lon: 37.5 },
          { lat: 55.75, lon: 37.62 },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { trip: { legs: { shape: string }[] } };
    const line = decodePolyline(body.trip.legs[0]?.shape ?? '');

    // Путь начинается ровно в первой переданной точке — то есть на складе.
    expect(line[0]?.[0]).toBeCloseTo(37.5, 6);
    expect(line[0]?.[1]).toBeCloseTo(55.7, 6);
    // И заканчивается в остановке.
    expect(line[line.length - 1]?.[0]).toBeCloseTo(37.62, 6);
    expect(line[line.length - 1]?.[1]).toBeCloseTo(55.75, 6);
    // Между ними есть угол: линия читается как путь, а не как отрезок.
    expect(line.length).toBeGreaterThan(2);
  });

  it('всё, кроме построения маршрута, подменой не притворяется', async () => {
    const { createTestRouterFetch } = await import('./test-router.js');
    const response = await createTestRouterFetch()('http://valhalla.local.test/status', {
      method: 'GET',
    });

    expect(response.status).toBe(404);
  });

  it('строка переживает круг «закодировать — разобрать»', async () => {
    const { encodePolyline } = await import('./polyline.js');
    const line: [number, number][] = [
      [37.5, 55.7],
      [37.62, 55.75],
      [37.7, 55.8],
    ];

    const restored = decodePolyline(encodePolyline(line));

    expect(restored).toHaveLength(3);
    expect(restored[1]?.[0]).toBeCloseTo(37.62, 6);
    expect(restored[1]?.[1]).toBeCloseTo(55.75, 6);
  });
});
