/**
 * Локальная подмена маршрутизатора.
 *
 * Существует ради одного: на локальном стенде дорожного графа нет, и линия
 * маршрута не строится вовсе — проверить глазами «идёт ли путь от склада через
 * остановки» невозможно. Подмена стоит на уровне HTTP: клиент Valhalla, разбор
 * закодированной геометрии и весь серверный контракт остаются настоящими.
 *
 * Геометрия детерминированная и намеренно НЕ прямая: между соседними точками
 * добавляется угол, поэтому линия читается как путь, а не как отрезок, и
 * перестановка остановок видна сразу. Настоящим расчётом она не является
 * и за пределы `APP_ENV=local` не выходит — это запрещено конфигурацией.
 */

import { encodePolyline, type LngLat } from './polyline.js';

interface RouteRequestBody {
  locations: { lat: number; lon: number }[];
}

/** Промежуточная точка: путь идёт «уступом», а не по прямой. */
function legShape(from: LngLat, to: LngLat): LngLat[] {
  const corner: LngLat = [to[0], from[1]];
  return [from, corner, to];
}

/** Грубая длина в метрах: нужна только для подписи, не для решений. */
function legMeters(from: LngLat, to: LngLat): number {
  const dx = (to[0] - from[0]) * 63_000;
  const dy = (to[1] - from[1]) * 111_000;
  return Math.round(Math.abs(dx) + Math.abs(dy));
}

/**
 * `fetch`, отвечающий как Valhalla.
 *
 * Отвечает только на `/route`; всё остальное — 404, чтобы подмена не выдавала
 * себя за сервис целиком.
 */
export function createTestRouterFetch(): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith('/route')) {
      return new Response('not found', { status: 404 });
    }

    const body = JSON.parse(String(init?.body ?? '{}')) as RouteRequestBody;
    const points: LngLat[] = (body.locations ?? []).map((location) => [location.lon, location.lat]);

    const legs: { shape: string }[] = [];
    let meters = 0;
    for (let index = 0; index + 1 < points.length; index += 1) {
      const from = points[index];
      const to = points[index + 1];
      if (from === undefined || to === undefined) {
        continue;
      }
      legs.push({ shape: encodePolyline(legShape(from, to)) });
      meters += legMeters(from, to);
    }

    if (legs.length === 0) {
      return new Response(JSON.stringify({ error: 'no locations' }), { status: 400 });
    }

    return new Response(
      JSON.stringify({
        trip: {
          legs,
          // Скорость условная и одна на все участки: числа здесь — подпись,
          // а не расчёт, и решений по ним не принимают.
          summary: { time: Math.round(meters / 8), length: meters / 1000 },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
}
