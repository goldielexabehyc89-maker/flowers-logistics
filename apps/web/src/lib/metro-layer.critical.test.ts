/**
 * Критические проверки визуального слоя станций метро.
 *
 * Защищаемые свойства:
 *
 *  * точки — РЕАЛЬНЫЕ узлы станций по линиям, без усреднения: пересадочный узел
 *    показан несколькими точками, а не выдуманной серединой;
 *  * координата равна исходной (не округлена и не пересчитана), широта и
 *    долгота не переставлены, все точки в московской рамке;
 *  * устойчивые идентификаторы узлов не дублируются;
 *  * набор версионируем (лицензия, происхождение, дата, отпечаток — в манифесте)
 *    и собран без усреднения;
 *  * слой ТОЛЬКО визуальный: клиентский GeoJSON-оверлей, две отрисовочные
 *    прослойки, id источника версионирован;
 *  * обе карты используют ОДИН модуль слоя.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addMetroLayer, METRO_LABEL_LAYER, METRO_STATION_LAYER } from './metro-layer';
import stations from './metro-stations/moscow-metro-2026-08-06.geo.json';
import manifest from './metro-stations/manifest.json';

const here = path.dirname(fileURLToPath(import.meta.url));
const BBOX = { minLon: 36.7, minLat: 55.1, maxLon: 38.2, maxLat: 56.1 };

/**
 * Не менее 20 станций разных типов должны присутствовать: обычные,
 * пересадочные, БКЛ, наземные, новые, с несколькими вестибюлями.
 */
const SAMPLE_STATIONS = [
  'Медведково',
  'Тропарёво',
  'Театральная',
  'Сокольники',
  'Авиамоторная',
  'Киевская',
  'Комсомольская',
  'Электрозаводская',
  'Нижегородская',
  'Парк Культуры',
  'Охотный ряд',
  'ЦСКА',
  'Деловой центр',
  'Савёловская',
  'Мичуринский проспект',
  'Филёвский парк',
  'Выхино',
  'Саларьево',
  'Коммунарка',
  'Пятницкое шоссе',
  'Партизанская',
  'Семёновская',
];

/**
 * Точные исходные координаты (из снимка OSM) — контроль, что координата
 * перенесена как есть, без округления и без усреднения.
 */
const SOURCE_COORDS: Record<string, [number, number]> = {
  Медведково: [37.66155, 55.8871767],
  ЦСКА: [37.5332007, 55.786561],
};

/** Пересадочные узлы — доказательство отсутствия усреднения (точек больше одной). */
const INTERCHANGE_POINTS: Record<string, number> = {
  Киевская: 3,
  Комсомольская: 2,
  Электрозаводская: 2,
  Нижегородская: 2,
};

function coordsOf(name: string): [number, number][] {
  return stations.features
    .filter((f) => f.properties.name === name)
    .map((f) => f.geometry.coordinates as [number, number]);
}

/** Минимальный двойник карты MapLibre: помнит источники и слои. */
interface FakeLayer {
  type: string;
  source: string;
  paint: Record<string, unknown> | undefined;
  layout: Record<string, unknown> | undefined;
}

function fakeMap(): {
  map: Parameters<typeof addMetroLayer>[0];
  sources: Map<string, unknown>;
  layers: Map<string, FakeLayer>;
} {
  const sources = new Map<string, unknown>();
  const layers = new Map<string, FakeLayer>();
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, spec: unknown) => sources.set(id, spec),
    getLayer: (id: string) => layers.get(id),
    addLayer: (spec: {
      id: string;
      type: string;
      source: string;
      paint?: Record<string, unknown>;
      layout?: Record<string, unknown>;
    }) =>
      layers.set(spec.id, {
        type: spec.type,
        source: spec.source,
        paint: spec.paint,
        layout: spec.layout,
      }),
  } as unknown as Parameters<typeof addMetroLayer>[0];
  return { map, sources, layers };
}

describe('набор станций метро', () => {
  it('это FeatureCollection точек с id, названием и цветом линии', () => {
    expect(stations.type).toBe('FeatureCollection');
    for (const feature of stations.features) {
      expect(feature.geometry.type).toBe('Point');
      expect(typeof feature.properties.id).toBe('string');
      expect(feature.properties.name.length).toBeGreaterThan(0);
      expect(feature.properties.colour).toMatch(
        /^(#[0-9a-f]{3,8}|red|orange|green|blue|violet|yellow|lightblue|brown|grey|gray)$/,
      );
    }
  });

  it('устойчивые идентификаторы узлов не дублируются', () => {
    const ids = stations.features.map((f) => f.properties.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(manifest.pointCount);
  });

  it('все точки в московской рамке, широта и долгота не переставлены', () => {
    expect(stations.features.length).toBeGreaterThanOrEqual(200);
    for (const feature of stations.features) {
      const [lon, lat] = feature.geometry.coordinates;
      // Долгота Москвы ~37, широта ~55. Перестановка увела бы долготу в 55 —
      // за пределы рамки, поэтому проверка рамки ловит и перестановку.
      expect(lon).toBeGreaterThanOrEqual(BBOX.minLon);
      expect(lon).toBeLessThanOrEqual(BBOX.maxLon);
      expect(lat).toBeGreaterThanOrEqual(BBOX.minLat);
      expect(lat).toBeLessThanOrEqual(BBOX.maxLat);
    }
  });

  it('не менее 20 станций разных типов присутствуют', () => {
    expect(SAMPLE_STATIONS.length).toBeGreaterThanOrEqual(20);
    for (const name of SAMPLE_STATIONS) {
      expect(coordsOf(name).length, name).toBeGreaterThanOrEqual(1);
    }
  });

  it('усреднения нет: пересадочный узел — несколько РАЗНЫХ точек', () => {
    for (const [name, count] of Object.entries(INTERCHANGE_POINTS)) {
      const points = coordsOf(name);
      expect(points.length, name).toBe(count);
      // Точки различны — это узлы разных линий, а не одна усреднённая.
      const distinct = new Set(points.map((p) => `${p[0]},${p[1]}`));
      expect(distinct.size, name).toBe(count);
      // Ни одна точка не равна среднему остальных (не центроид-усреднение).
      const meanLon = points.reduce((s, p) => s + p[0], 0) / points.length;
      const meanLat = points.reduce((s, p) => s + p[1], 0) / points.length;
      for (const [lon, lat] of points) {
        expect(Math.abs(lon - meanLon) + Math.abs(lat - meanLat)).toBeGreaterThan(0);
      }
    }
  });

  it('координата равна исходной координате снимка (без округления)', () => {
    for (const [name, [lon, lat]] of Object.entries(SOURCE_COORDS)) {
      const points = coordsOf(name);
      expect(
        points.some((p) => p[0] === lon && p[1] === lat),
        name,
      ).toBe(true);
    }
  });

  it('манифест: происхождение, дата, лицензия и отсутствие усреднения', () => {
    expect(manifest.license).toBe('ODbL-1.0');
    expect(manifest.attribution).toBe('© OpenStreetMap contributors');
    expect(manifest.source).toMatch(/^https?:\/\//);
    expect(manifest.dataDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.filter).toBe('railway=station AND station=subway');
    expect(manifest.averaging).toMatch(/none/);
  });
});

describe('addMetroLayer', () => {
  it('добавляет один версионированный GeoJSON-источник и две прослойки', () => {
    const { map, sources, layers } = fakeMap();
    addMetroLayer(map);

    expect(sources.size).toBe(1);
    const [sourceId, sourceSpec] = [...sources.entries()][0]!;
    // Id источника версионирован датой набора — старый кэш не «переживёт» смену.
    expect(sourceId).toContain(manifest.geometryVersion);
    expect((sourceSpec as { type: string }).type).toBe('geojson');
    expect((sourceSpec as { data: unknown }).data).toBe(stations);

    const circle = layers.get(METRO_STATION_LAYER);
    const label = layers.get(METRO_LABEL_LAYER);
    expect(circle?.type).toBe('circle');
    expect(label?.type).toBe('symbol');
    expect(circle?.source).toBe(sourceId);
    expect(label?.source).toBe(sourceId);
    // Цвет кружка берётся из цвета линии станции.
    expect(circle?.paint?.['circle-color']).toEqual(['get', 'colour']);
    // Подпись берёт название из свойства точки.
    expect(label?.layout?.['text-field']).toEqual(['get', 'name']);
  });

  it('повторный вызов не плодит источники и слои', () => {
    const { map, sources, layers } = fakeMap();
    addMetroLayer(map);
    addMetroLayer(map);
    expect(sources.size).toBe(1);
    expect(layers.size).toBe(2);
  });
});

describe('одна реализация на обе карты', () => {
  it('«Сделки» и «Маршрутизация» берут слой из общего модуля', () => {
    const deals = readFileSync(path.join(here, '../screens/deals/DealsMapCanvas.tsx'), 'utf8');
    const routing = readFileSync(path.join(here, '../screens/routing/OrdersMap.tsx'), 'utf8');
    for (const source of [deals, routing]) {
      expect(source).toContain("from '../../lib/metro-layer'");
      expect(source).toContain('addMetroLayer(');
    }
  });
});
