/**
 * Критические проверки визуального слоя станций метро.
 *
 * Защищаемые свойства:
 *
 *  * метки берутся из СТАНЦИЙ, а не входов: набор собран из
 *    `railway=station` + `station=subway`, по одной точке на название —
 *    пересадочные узлы не размножаются;
 *  * координаты правдоподобны (в московской рамке) и версионируемы
 *    (лицензия, происхождение, дата — в манифесте);
 *  * слой ТОЛЬКО визуальный: клиентский GeoJSON-оверлей, две отрисовочные
 *    прослойки, никакого обращения к матрице, VROOM или Valhalla;
 *  * обе карты используют ОДИН модуль слоя.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addMetroLayer, METRO_LABEL_LAYER, METRO_STATION_LAYER } from './metro-layer';
import stations from './generated/metro/moscow-metro-2026-08-06.geo.json';
import manifest from './generated/metro/manifest.json';

const here = path.dirname(fileURLToPath(import.meta.url));
const BBOX = { minLon: 36.7, minLat: 55.1, maxLon: 38.2, maxLat: 56.1 };

/** Минимальный двойник карты MapLibre: помнит источники и слои. */
interface FakeLayer {
  type: string;
  source: string;
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
      layout?: Record<string, unknown>;
    }) => layers.set(spec.id, { type: spec.type, source: spec.source, layout: spec.layout }),
  } as unknown as Parameters<typeof addMetroLayer>[0];
  return { map, sources, layers };
}

describe('набор станций метро', () => {
  it('это FeatureCollection точек с названиями', () => {
    expect(stations.type).toBe('FeatureCollection');
    for (const feature of stations.features) {
      expect(feature.geometry.type).toBe('Point');
      expect(typeof feature.properties.name).toBe('string');
      expect(feature.properties.name.length).toBeGreaterThan(0);
    }
  });

  it('одно название — одна точка: пересадочные узлы не размножаются', () => {
    const names = stations.features.map((feature) => feature.properties.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('станций правдоподобно много и все в московской рамке', () => {
    expect(stations.features.length).toBeGreaterThanOrEqual(180);
    expect(stations.features.length).toBe(manifest.stationCount);
    for (const feature of stations.features) {
      const [lon, lat] = feature.geometry.coordinates;
      expect(lon).toBeGreaterThanOrEqual(BBOX.minLon);
      expect(lon).toBeLessThanOrEqual(BBOX.maxLon);
      expect(lat).toBeGreaterThanOrEqual(BBOX.minLat);
      expect(lat).toBeLessThanOrEqual(BBOX.maxLat);
    }
  });

  it('манифест документирует происхождение, дату и лицензию', () => {
    expect(manifest.license).toBe('ODbL-1.0');
    expect(manifest.attribution).toBe('© OpenStreetMap contributors');
    expect(manifest.source).toMatch(/^https?:\/\//);
    expect(manifest.dataDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.filter).toBe('railway=station AND station=subway');
  });
});

describe('addMetroLayer', () => {
  it('добавляет один GeoJSON-источник и две отрисовочные прослойки', () => {
    const { map, sources, layers } = fakeMap();
    addMetroLayer(map);

    expect(sources.size).toBe(1);
    const [sourceId, sourceSpec] = [...sources.entries()][0]!;
    expect((sourceSpec as { type: string }).type).toBe('geojson');
    // Данные — сам набор станций, а не запрос к серверу: слой живёт в бандле.
    expect((sourceSpec as { data: unknown }).data).toBe(stations);

    const circle = layers.get(METRO_STATION_LAYER);
    const label = layers.get(METRO_LABEL_LAYER);
    expect(circle?.type).toBe('circle');
    expect(label?.type).toBe('symbol');
    // Обе прослойки читают тот же локальный источник.
    expect(circle?.source).toBe(sourceId);
    expect(label?.source).toBe(sourceId);
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
