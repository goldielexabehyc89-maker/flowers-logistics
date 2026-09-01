/**
 * Визуальный слой станций метро для карт «Сделки» и «Маршрутизация».
 *
 * Один общий слой на обе карты и БЕЗ новых данных: станции берутся из уже
 * существующего слоя `poi` собственной подложки (PMTiles собран planetiler с
 * профилем OpenMapTiles, где станции метро лежат в `poi`). Координаты заказов
 * не трогаются, во внешнюю сеть слой не ходит.
 *
 * Слой ТОЛЬКО визуальный: он не участвует ни в геокодировании, ни в матрице,
 * ни в VROOM/Valhalla, ни в расчёте маршрута. Любая неожиданность при добавлении
 * не имеет права уронить карту — без метро логист работает, без карты нет.
 *
 * Иконка — кружок (спрайта метро в стиле подложки нет), название — подписью из
 * глифов стиля. Подпись показывается на более близком масштабе и не наезжает на
 * соседей (`text-allow-overlap: false`), чтобы не перекрывать карточки заказов.
 */

import type { Map as MapLibreMap, FilterSpecification } from 'maplibre-gl';

/** Идентификатор векторного источника подложки (см. `tools/geo/style.mjs`). */
const BASEMAP_SOURCE = 'basemap';
/** Слой POI подложки OpenMapTiles, где лежат станции. */
const POI_SOURCE_LAYER = 'poi';

export const METRO_STATION_LAYER = 'metro-stations';
export const METRO_LABEL_LAYER = 'metro-station-labels';

/**
 * Отбор станций метро в слое `poi`.
 *
 * OpenMapTiles кладёт станции с `class = 'railway'` и `subclass` вроде
 * `subway`/`station`. Берём метро и станции; трамвайные остановки и прочее
 * не показываем, чтобы не зашумлять карту.
 */
const METRO_FILTER = [
  'all',
  ['==', ['get', 'class'], 'railway'],
  ['in', ['get', 'subclass'], ['literal', ['subway', 'station']]],
] as unknown as FilterSpecification;

/**
 * Добавляет слой станций метро в живой стиль карты, если его ещё нет и если у
 * карты есть собственная подложка. Безопасен к повторному вызову.
 */
export function addMetroLayer(map: MapLibreMap): void {
  try {
    if (map.getSource(BASEMAP_SOURCE) === undefined) {
      // Подложки нет (например, локальная разработка без PMTiles) — метро нечем
      // рисовать; молча выходим.
      return;
    }
    if (map.getLayer(METRO_STATION_LAYER) !== undefined) {
      return;
    }

    map.addLayer({
      id: METRO_STATION_LAYER,
      type: 'circle',
      source: BASEMAP_SOURCE,
      'source-layer': POI_SOURCE_LAYER,
      minzoom: 11,
      filter: METRO_FILTER,
      paint: {
        'circle-radius': 4,
        'circle-color': '#d32f2f',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
      },
    });

    map.addLayer({
      id: METRO_LABEL_LAYER,
      type: 'symbol',
      source: BASEMAP_SOURCE,
      'source-layer': POI_SOURCE_LAYER,
      minzoom: 12,
      filter: METRO_FILTER,
      layout: {
        'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': '#b71c1c',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
      },
    });
  } catch {
    // Метро — визуальный слой: любая неожиданность не должна убрать карту.
  }
}
