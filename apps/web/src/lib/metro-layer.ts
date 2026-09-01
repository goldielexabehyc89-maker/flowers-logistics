/**
 * Визуальный слой станций метро для карт «Сделки» и «Маршрутизация».
 *
 * Один общий модуль на обе карты. Метки берутся из СТАНЦИЙ, а не входов:
 * прежде слой строился поверх `poi` подложки, где под тот же фильтр попадали
 * входы в метро (1273 узла против 273 станций), и вокруг настоящей станции
 * появлялось по несколько меток, смещённых от неё. Теперь источник —
 * версионируемый набор `lib/metro-stations`, собранный из датированного снимка
 * OpenStreetMap (`railway=station` + `station=subway`) скриптом
 * `scripts/geodata/build-metro.mjs`: по одной точке на станцию, пересадочные
 * узлы сведены в одну метку.
 *
 * Слой ТОЛЬКО визуальный: это клиентский оверлей MapLibre. Он не участвует ни
 * в геокодировании, ни в матрице, ни в VROOM/Valhalla, ни в расчёте маршрута —
 * координаты набора никуда, кроме отрисовки, не уходят. Любая неожиданность
 * при добавлении не имеет права уронить карту: без метро логист работает,
 * без карты — нет.
 */

import type { Map as MapLibreMap, GeoJSONSourceSpecification } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import stationsData from './metro-stations/moscow-metro-2026-08-06.geo.json';

/** Набор станций как GeoJSON. Тип сужается явно: JSON приходит как unknown-форма. */
const STATIONS = stationsData as unknown as FeatureCollection<Point, { name: string }>;

/** Идентификатор GeoJSON-источника станций метро. */
const METRO_SOURCE = 'metro-stations-src';

export const METRO_STATION_LAYER = 'metro-stations';
export const METRO_LABEL_LAYER = 'metro-station-labels';

/**
 * Добавляет слой станций метро в живой стиль карты, если его ещё нет.
 * Безопасен к повторному вызову и к любой ошибке отрисовки.
 */
export function addMetroLayer(map: MapLibreMap): void {
  try {
    if (map.getSource(METRO_SOURCE) === undefined) {
      const source: GeoJSONSourceSpecification = { type: 'geojson', data: STATIONS };
      map.addSource(METRO_SOURCE, source);
    }

    if (map.getLayer(METRO_STATION_LAYER) === undefined) {
      map.addLayer({
        id: METRO_STATION_LAYER,
        type: 'circle',
        source: METRO_SOURCE,
        minzoom: 10,
        paint: {
          'circle-radius': 4,
          'circle-color': '#d32f2f',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
        },
      });
    }

    if (map.getLayer(METRO_LABEL_LAYER) === undefined) {
      map.addLayer({
        id: METRO_LABEL_LAYER,
        type: 'symbol',
        source: METRO_SOURCE,
        minzoom: 12,
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 11,
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          // Подпись не наезжает на соседей и на карточки заказов.
          'text-allow-overlap': false,
          'text-optional': true,
        },
        paint: {
          'text-color': '#b71c1c',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      });
    }
  } catch {
    // Метро — визуальный слой: любая неожиданность не должна убрать карту.
  }
}
