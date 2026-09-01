/**
 * Визуальный слой станций метро для карт «Сделки» и «Маршрутизация».
 *
 * Один общий модуль на обе карты. Точки — РЕАЛЬНЫЕ узлы станций из снимка
 * OpenStreetMap (`railway=station` + `station=subway`), собранные скриптом
 * `scripts/geodata/build-metro.mjs` в версионируемый набор `lib/metro-stations`.
 * Усреднения нет: пересадочный узел показан несколькими точками разных линий
 * (у каждой свой цвет `colour` и устойчивый id узла), а не выдуманной серединой
 * между платформами. Близость точек — забота отрисовки, а не повод пересчитать
 * координату.
 *
 * Источник идентификатора версионирован датой снимка: при обновлении набора
 * меняется и id источника, поэтому старый слой не может «пережить» деплой в
 * кэше карты. Сам набор лежит в бандле (хэш содержимого меняется при сборке),
 * так что второй, старый слой не появляется.
 *
 * Слой ТОЛЬКО визуальный: это клиентский оверлей MapLibre. Он не участвует ни
 * в геокодировании (Photon/DaData), ни в адресе и координатах доставки, ни в
 * матрице, ни в VROOM/Valhalla, ни в построении и расчёте маршрута — координаты
 * набора никуда, кроме отрисовки, не уходят. Любая неожиданность при добавлении
 * не имеет права уронить карту: без метро логист работает, без карты — нет.
 */

import type { Map as MapLibreMap, GeoJSONSourceSpecification } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import stationsData from './metro-stations/moscow-metro-2026-08-06.geo.json';
import manifest from './metro-stations/manifest.json';

/** Свойства точки станции: устойчивый id узла OSM, название и цвет линии. */
interface MetroStationProps {
  id: string;
  name: string;
  colour: string;
}

/** Набор станций как GeoJSON. Тип сужается явно: JSON приходит как unknown-форма. */
const STATIONS = stationsData as unknown as FeatureCollection<Point, MetroStationProps>;

/**
 * Идентификатор GeoJSON-источника версионируется датой набора.
 *
 * Иначе при обновлении данных карта могла бы держать старый источник под тем
 * же именем. Дата берётся из манифеста того же набора, поэтому id и данные
 * всегда согласованы.
 */
const METRO_SOURCE = `metro-stations-${manifest.geometryVersion}`;

export const METRO_STATION_LAYER = `metro-stations-${manifest.geometryVersion}`;
export const METRO_LABEL_LAYER = `metro-station-labels-${manifest.geometryVersion}`;

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
          // Цвет линии из данных станции; негодного значения в наборе нет.
          'circle-color': ['get', 'colour'],
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
          // Подпись не наезжает на соседей и на карточки заказов; у пересадки
          // это оставляет один читаемый ярлык на несколько точек рядом.
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
