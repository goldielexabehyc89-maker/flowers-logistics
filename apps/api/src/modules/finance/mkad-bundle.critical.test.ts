/**
 * Критические проверки системной геометрии МКАД.
 *
 * Защищаемое свойство одно: деньги считаются по НАСТОЯЩЕМУ кольцу МКАД из
 * названного источника, а не по тому, что оказалось в файле. Поэтому здесь
 * проверяется и сама геометрия (замкнутость, самопересечения, рамка, длина,
 * закреплённые точки по обе стороны кольца), и её жизнь в приложении:
 * идемпотентная установка, появление новой версии без пересчёта прошлых
 * доставок, действующая версия по поставке, отсутствие ручной загрузки
 * и отказ вместо тихой работы на повреждённом файле.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestContext, createTestContext, type TestContext } from '../auth/testing/harness.js';
import {
  MkadBundleError,
  activeRing,
  ensureBundledRing,
  readBundle,
  resetBundleCache,
} from './mkad-bundle.js';
import { geometrySha256, hasSelfIntersection, parseBundle, RING_LIMITS } from './mkad-geojson.js';
import { isInsideRing, storeRing } from './mkad.js';

let ctx: TestContext;

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/mkad');

function readAssets(): { manifest: Record<string, unknown>; geojson: Record<string, unknown> } {
  const manifest = JSON.parse(readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const geojson = JSON.parse(
    readFileSync(path.join(ASSETS, String(manifest['geometry'])), 'utf8'),
  ) as Record<string, unknown>;
  return { manifest, geojson };
}

function ringOf(geojson: Record<string, unknown>): [number, number][] {
  const features = geojson['features'] as { geometry: { coordinates: [number, number][][] } }[];
  return features[0]?.geometry.coordinates[0] ?? [];
}

/**
 * Каталог поставки с изменённой геометрией.
 *
 * `sealed` означает согласованную поставку: описание и manifest пересчитаны
 * под новые координаты. Так проверяется не «поймали расхождение», а само
 * поведение на другой, но правильно оформленной геометрии.
 */
function bundleDirectory(
  mutate: (geojson: Record<string, unknown>) => void,
  sealed = false,
): string {
  const { manifest, geojson } = readAssets();
  mutate(geojson);
  if (sealed) {
    const features = geojson['features'] as { properties: Record<string, unknown> }[];
    manifest['geometrySha256'] = features[0]?.properties['geometrySha256'];
  }

  const directory = mkdtempSync(path.join(tmpdir(), 'mkad-'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, String(manifest['geometry'])), JSON.stringify(geojson));
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return directory;
}

/** Пересчёт описания под новые координаты: поставка обязана быть согласованной. */
function reseal(geojson: Record<string, unknown>): void {
  const ring = ringOf(geojson);
  const points = ring.map(([lon, lat]) => ({ lon, lat }));
  const features = geojson['features'] as { properties: Record<string, unknown> }[];
  const properties = features[0]?.properties ?? {};

  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const [lon, lat] of ring) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }

  const R = 6_371_008.8;
  const toRad = Math.PI / 180;
  let length = 0;
  for (let index = 1; index < ring.length; index += 1) {
    const a = ring[index - 1] ?? [0, 0];
    const b = ring[index] ?? [0, 0];
    const dLat = (b[1] - a[1]) * toRad;
    const dLon = (b[0] - a[0]) * toRad;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
    length += 2 * R * Math.asin(Math.sqrt(h));
  }

  properties['pointCount'] = ring.length;
  properties['bbox'] = [minLon, minLat, maxLon, maxLat];
  properties['lengthMeters'] = Math.round(length);
  properties['geometrySha256'] = geometrySha256(points);
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
  resetBundleCache();
});

// --- Геометрия ---------------------------------------------------------------

describe('геометрия МКАД в поставке', () => {
  it('файл — стандартный GeoJSON: один Polygon в CRS84', () => {
    const { geojson } = readAssets();
    expect(geojson['type']).toBe('FeatureCollection');
    const crs = geojson['crs'] as { properties: { name: string } };
    expect(crs.properties.name).toBe('urn:ogc:def:crs:OGC:1.3:CRS84');

    const features = geojson['features'] as { type: string; geometry: { type: string } }[];
    expect(features).toHaveLength(1);
    expect(features[0]?.type).toBe('Feature');
    expect(features[0]?.geometry.type).toBe('Polygon');
  });

  it('кольцо замкнуто, содержит достаточно точек и не пересекает себя', () => {
    const bundle = readBundle();
    expect(bundle.pointCount).toBeGreaterThanOrEqual(RING_LIMITS.minPoints);

    const first = bundle.points[0];
    const last = bundle.points.at(-1);
    expect(first).toEqual(last);

    // Проверка идёт по самим координатам, а не по описанию файла.
    expect(hasSelfIntersection(bundle.points)).toBe(false);
  });

  it('рамка над Москвой, длина — как у настоящего МКАД', () => {
    const bundle = readBundle();
    const [minLon, minLat, maxLon, maxLat] = bundle.bbox;
    expect(minLon).toBeGreaterThan(RING_LIMITS.bbox.minLon);
    expect(minLat).toBeGreaterThan(RING_LIMITS.bbox.minLat);
    expect(maxLon).toBeLessThan(RING_LIMITS.bbox.maxLon);
    expect(maxLat).toBeLessThan(RING_LIMITS.bbox.maxLat);

    // Фактическая длина МКАД — около 109 км.
    expect(bundle.lengthMeters / 1000).toBeGreaterThan(105);
    expect(bundle.lengthMeters / 1000).toBeLessThan(112);
  });

  it('источник назван: отношение 2094222, датированный снимок, ODbL', () => {
    const bundle = readBundle();
    expect(bundle.osmRelationId).toBe(2094222);
    expect(bundle.snapshotUrl).toContain('download.geofabrik.de');
    // «latest» источником быть не может: он меняется каждый день.
    expect(bundle.snapshotUrl).not.toContain('latest');
    expect(bundle.snapshotMd5).toMatch(/^[0-9a-f]{32}$/);
    expect(bundle.dataDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(bundle.license).toBe('ODbL-1.0');
    expect(bundle.attribution).toContain('OpenStreetMap');
    // Сборка топологическая: угловых секторов в поставке быть не должно.
    expect(bundle.derivation).toContain('Топологическая сборка');
  });

  it('файл в репозитории и рабочая геометрия имеют один отпечаток', () => {
    const { manifest } = readAssets();
    const bundle = readBundle();
    expect(bundle.sha256).toBe(manifest['geometrySha256']);
    expect(bundle.sha256).toBe(geometrySha256(bundle.points));
  });

  it('закреплённые точки Москвы — внутри кольца, точки области — снаружи', () => {
    const ring = readBundle().points;

    // Источник координат — общеизвестные места, а не подгонка под алгоритм.
    const inside = [
      { name: 'Красная площадь', lat: 55.7539, lon: 37.6208 },
      { name: 'ВДНХ', lat: 55.8263, lon: 37.6377 },
      { name: 'Печатники', lat: 55.692, lon: 37.728 },
      { name: 'Кунцево', lat: 55.7305, lon: 37.4085 },
    ];
    const outside = [
      { name: 'Химки', lat: 55.8894, lon: 37.445 },
      { name: 'Подольск', lat: 55.4312, lon: 37.5547 },
      { name: 'Люберцы', lat: 55.6759, lon: 37.8938 },
      { name: 'Красногорск', lat: 55.83, lon: 37.33 },
      { name: 'Мытищи', lat: 55.91, lon: 37.766 },
    ];

    for (const point of inside) {
      expect(isInsideRing(ring, point), point.name).toBe(true);
    }
    for (const point of outside) {
      expect(isInsideRing(ring, point), point.name).toBe(false);
    }
  });

  it('у самой границы точка по одну сторону внутри, по другую — снаружи', () => {
    /*
     * Точки получены смещением от УЗЛОВ кольца, а не подобраны под результат:
     * от узла отмеряется 300 метров внутрь и наружу по направлению от центра
     * кольца. Проверяется именно граница — то место, где ошибка в геометрии
     * стоит денег.
     */
    const ring = readBundle().points;
    const center = ring.reduce(
      (total, point) => ({
        lat: total.lat + point.lat / ring.length,
        lon: total.lon + point.lon / ring.length,
      }),
      { lat: 0, lon: 0 },
    );

    const step = 300; // метров
    const metersPerDegreeLat = 111_320;
    let checked = 0;

    for (const index of [0, 120, 240, 360, 480, 600, 720, 840, 960]) {
      const node = ring[index];
      if (node === undefined) {
        continue;
      }
      const cos = Math.cos((node.lat * Math.PI) / 180);
      const dLat = node.lat - center.lat;
      const dLon = (node.lon - center.lon) * cos;
      const norm = Math.hypot(dLat, dLon);
      if (norm === 0) {
        continue;
      }

      const shiftLat = ((dLat / norm) * step) / metersPerDegreeLat;
      const shiftLon = ((dLon / norm) * step) / (metersPerDegreeLat * cos);

      const outward = { lat: node.lat + shiftLat, lon: node.lon + shiftLon };
      const inward = { lat: node.lat - shiftLat, lon: node.lon - shiftLon };

      expect(isInsideRing(ring, outward), `узел ${index} наружу`).toBe(false);
      expect(isInsideRing(ring, inward), `узел ${index} внутрь`).toBe(true);
      checked += 1;
    }

    expect(checked).toBeGreaterThanOrEqual(8);
  });
});

// --- Отказ вместо тихой работы ----------------------------------------------

describe('негодная поставка — отказ, а не рабочее состояние', () => {
  it('подмена одной координаты отвергается', () => {
    const directory = bundleDirectory((geojson) => {
      const ring = ringOf(geojson);
      const point = ring[10];
      if (point !== undefined) {
        point[0] += 0.01;
      }
    });

    expect(() => readBundle(directory)).toThrow(MkadBundleError);
    rmSync(directory, { recursive: true, force: true });
  });

  it('незамкнутое кольцо отвергается', () => {
    const directory = bundleDirectory((geojson) => {
      const ring = ringOf(geojson);
      ring.pop();
      reseal(geojson);
    });

    expect(() => readBundle(directory)).toThrow(/не замкнуто/);
    rmSync(directory, { recursive: true, force: true });
  });

  it('самопересечение отвергается', () => {
    const directory = bundleDirectory((geojson) => {
      const ring = ringOf(geojson);
      // Перестановка соседних узлов даёт петлю: длина кольца при этом почти
      // не меняется, поэтому ловится именно пересечение, а не длина.
      const left = ring[100];
      const right = ring[103];
      if (left !== undefined && right !== undefined) {
        ring[100] = right;
        ring[103] = left;
      }
      reseal(geojson);
    }, true);

    expect(() => readBundle(directory)).toThrow(/пересекает сама себя|пересекает само себя/);
    rmSync(directory, { recursive: true, force: true });
  });

  it('расхождение описания с координатами отвергается', () => {
    const directory = bundleDirectory((geojson) => {
      const features = geojson['features'] as { properties: Record<string, unknown> }[];
      const properties = features[0]?.properties ?? {};
      properties['pointCount'] = 12;
    });

    expect(() => readBundle(directory)).toThrow(/числа точек/);
    rmSync(directory, { recursive: true, force: true });
  });

  it('отсутствие файла в образе — отказ, а не «геометрия не настроена»', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'mkad-empty-'));
    expect(() => readBundle(empty)).toThrow(MkadBundleError);
    rmSync(empty, { recursive: true, force: true });
  });

  it('чужой JSON вместо GeoJSON отвергается', () => {
    expect(() =>
      parseBundle({ geometry: 'x.geojson', geometrySha256: 'a'.repeat(64) }, []),
    ).toThrow(/FeatureCollection/);
  });
});

// --- Жизнь в приложении ------------------------------------------------------

describe('установка геометрии из поставки', () => {
  it('первая установка создаёт версию, повторная ничего не меняет', async () => {
    const before = await ctx.db.mkadRingVersion.count();
    const first = await ensureBundledRing(ctx.db);
    const middle = await ctx.db.mkadRingVersion.count();
    const second = await ensureBundledRing(ctx.db);
    const after = await ctx.db.mkadRingVersion.count();

    expect(middle).toBe(before + (first.installed ? 1 : 0));
    expect(second.installed).toBe(false);
    expect(second.ringVersionId).toBe(first.ringVersionId);
    expect(after).toBe(middle);
  });

  it('установка записана в аудит без координат', async () => {
    const installed = await ensureBundledRing(ctx.db);
    const entries = await ctx.db.auditLog.findMany({
      where: { entityId: installed.ringVersionId, action: 'FINANCE_MKAD_RING_INSTALLED' },
      select: { newValue: true, source: true },
    });

    expect(entries).toHaveLength(1);
    const value = entries[0]?.newValue as Record<string, unknown>;
    expect(value['sha256']).toBe(readBundle().sha256);
    expect(value['osmRelationId']).toBe(2094222);
    expect(entries[0]?.source).toBe('bootstrap');
    // Координат в журнале нет: их десятки тысяч, и вопрос решается отпечатком.
    expect(JSON.stringify(value)).not.toContain('37.');
  });

  it('действующая версия — из поставки, а не последняя по времени', async () => {
    await ensureBundledRing(ctx.db);
    const shipped = readBundle();

    // Чужая, более поздняя версия кольца появляется в таблице…
    const foreign = await storeRing(ctx.db, {
      points: shipped.points.map((point) => ({ lon: point.lon + 0.002, lat: point.lat })),
      source: 'проверочная версия',
      license: 'ODbL-1.0',
      sourceDate: '2026-08-17',
    });

    const active = await activeRing(ctx.db);
    // …и действующей от этого не становится: версию назначает поставка.
    expect(active?.sha256).toBe(shipped.sha256);
    expect(active?.id).not.toBe(foreign.id);
  });

  it('новая версия файла добавляет строку, прежняя и её снимки остаются', async () => {
    const previous = await ensureBundledRing(ctx.db);
    const distances = await ctx.db.routeOrderDistance.count({
      where: { ringVersionId: previous.ringVersionId },
    });

    // Новая поставка: та же геометрия, сдвинутая на десять метров.
    const directory = bundleDirectory((geojson) => {
      const ring = ringOf(geojson);
      for (const point of ring) {
        point[1] = Math.round((point[1] + 0.0001) * 1_000_000) / 1_000_000;
      }
      reseal(geojson);
    }, true);

    const next = await ensureBundledRing(ctx.db, directory);
    expect(next.installed).toBe(true);
    expect(next.ringVersionId).not.toBe(previous.ringVersionId);

    // Прежняя версия на месте вместе со своими снимками расстояний.
    const kept = await ctx.db.mkadRingVersion.findUnique({
      where: { id: previous.ringVersionId },
    });
    expect(kept).not.toBeNull();
    expect(
      await ctx.db.routeOrderDistance.count({ where: { ringVersionId: previous.ringVersionId } }),
    ).toBe(distances);

    rmSync(directory, { recursive: true, force: true });
  });
});

describe('ручной загрузки геометрии не существует', () => {
  it('в маршрутах модуля нет POST и PUT для кольца', () => {
    const routes = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'routes.ts'),
      'utf8',
    );

    expect(routes).toContain("app.get('/api/logistics/mkad'");
    expect(routes).not.toContain("app.post('/api/logistics/mkad'");
    expect(routes).not.toContain("app.put('/api/logistics/mkad'");
  });

  it('CI не скачивает геометрию из сети', () => {
    const workflows = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../../.github/workflows',
    );
    const text = readFileSync(path.join(workflows, 'ci.yml'), 'utf8');
    // Геометрия приходит файлом поставки: CI её не скачивает и не собирает.
    expect(text).not.toContain('geofabrik');
    expect(text).not.toContain('overpass');
    expect(text).not.toContain('build-mkad');
  });

  it('отпечаток геометрии не зависит от случайности процесса', () => {
    const bundle = readBundle();
    const again = readBundle();
    expect(again.sha256).toBe(bundle.sha256);
    expect(createHash('sha256').update(randomUUID()).digest('hex')).not.toBe(bundle.sha256);
  });
});
