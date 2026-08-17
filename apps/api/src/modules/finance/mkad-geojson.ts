/**
 * Разбор и проверка системной геометрии МКАД.
 *
 * Геометрия приходит не «откуда-нибудь», а одним файлом поставки, и по ней
 * считаются деньги. Поэтому здесь нет ни одного «ну, наверное, сойдёт»:
 * незамкнутое кольцо, самопересечение, не тот отпечаток, рамка не над Москвой,
 * длина не как у МКАД, расхождение описания с самими координатами — всё это
 * отказ. Повреждённая геометрия не является рабочим состоянием: приложение
 * с ней не поднимается вовсе, потому что молча считать деньги по кривому
 * кольцу хуже, чем не подняться.
 *
 * Функции чистые: разбор доказывается без файловой системы и без базы.
 */

import { createHash } from 'node:crypto';

/** Микроградусы: в этой точности геометрия живёт в базе и считается отпечаток. */
const MICRO = 1_000_000;

/**
 * Пределы, за которыми геометрия перестаёт быть МКАД.
 *
 * Не подгонка под алгоритм, а грубая страховка: прямоугольник вокруг области
 * или кольцо длиной в двенадцать километров обязаны быть отвергнуты до того,
 * как по ним начнут начислять деньги.
 */
export const RING_LIMITS = {
  bbox: { minLon: 36.9, minLat: 55.4, maxLon: 38.1, maxLat: 56.1 },
  lengthMeters: { min: 100_000, max: 120_000 },
  minPoints: 1000,
} as const;

export interface RingPoint {
  lon: number;
  lat: number;
}

export interface BundleManifest {
  geometry: string;
  geometryVersion: string;
  geometrySha256: string;
  osmRelationId: number;
  dataDate: string;
  license: string;
  attribution: string;
  source: string;
}

export interface MkadBundle {
  version: string;
  osmRelationId: number;
  snapshotUrl: string;
  snapshotMd5: string;
  snapshotSha256: string;
  dataDate: string;
  derivation: string;
  builder: string;
  license: string;
  attribution: string;
  /** Отпечаток нормализованной рабочей геометрии. */
  sha256: string;
  pointCount: number;
  lengthMeters: number;
  bbox: [number, number, number, number];
  points: RingPoint[];
}

/**
 * Отказ поставки.
 *
 * Отдельный тип, чтобы запуск приложения мог отличить «файл поставки негоден»
 * от любой другой ошибки и остановиться, назвав причину словами.
 */
export class MkadBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MkadBundleError';
  }
}

function reject(message: string): never {
  throw new MkadBundleError(`Системная геометрия МКАД негодна: ${message}`);
}

const EARTH_RADIUS_M = 6_371_008.8;

function haversine(a: RingPoint, b: RingPoint): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function ringLengthMeters(points: readonly RingPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous !== undefined && current !== undefined) {
      total += haversine(previous, current);
    }
  }
  return total;
}

export function ringBbox(points: readonly RingPoint[]): [number, number, number, number] {
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minLon = Math.min(minLon, point.lon);
    minLat = Math.min(minLat, point.lat);
    maxLon = Math.max(maxLon, point.lon);
    maxLat = Math.max(maxLat, point.lat);
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Есть ли у кольца самопересечения.
 *
 * Отрезки разложены по сетке: полный перебор пар на десяти тысячах точек —
 * сотня миллионов сравнений, и такая проверка однажды была бы выключена
 * «ради скорости запуска».
 */
export function hasSelfIntersection(points: readonly RingPoint[]): boolean {
  const [minLon, minLat, maxLon, maxLat] = ringBbox(points);
  const cells = 200;
  const stepLon = (maxLon - minLon) / cells || 1;
  const stepLat = (maxLat - minLat) / cells || 1;

  const segments: [RingPoint, RingPoint][] = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (from !== undefined && to !== undefined) {
      segments.push([from, to]);
    }
  }

  const buckets = new Map<string, number[]>();
  segments.forEach(([a, b], index) => {
    const x0 = Math.floor((Math.min(a.lon, b.lon) - minLon) / stepLon);
    const x1 = Math.floor((Math.max(a.lon, b.lon) - minLon) / stepLon);
    const y0 = Math.floor((Math.min(a.lat, b.lat) - minLat) / stepLat);
    const y1 = Math.floor((Math.max(a.lat, b.lat) - minLat) / stepLat);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const key = `${x}:${y}`;
        const list = buckets.get(key) ?? [];
        list.push(index);
        buckets.set(key, list);
      }
    }
  });

  const side = (p: RingPoint, q: RingPoint, r: RingPoint): number => {
    const value = (q.lat - p.lat) * (r.lon - q.lon) - (q.lon - p.lon) * (r.lat - q.lat);
    return value === 0 ? 0 : value > 0 ? 1 : 2;
  };

  const last = segments.length - 1;
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const left = list[i] ?? 0;
        const right = list[j] ?? 0;
        // Соседние отрезки делят точку по построению; первый с последним — тоже.
        if (Math.abs(left - right) <= 1) {
          continue;
        }
        if ((left === 0 && right === last) || (right === 0 && left === last)) {
          continue;
        }
        const first = segments[left];
        const second = segments[right];
        if (first === undefined || second === undefined) {
          continue;
        }
        const [p1, q1] = first;
        const [p2, q2] = second;
        if (side(p1, q1, p2) !== side(p1, q1, q2) && side(p2, q2, p1) !== side(p2, q2, q1)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Отпечаток рабочей геометрии: та же формула, что и у версии кольца в базе. */
export function geometrySha256(points: readonly RingPoint[]): string {
  const canonical = points
    .map((point) => `${Math.round(point.lon * MICRO)},${Math.round(point.lat * MICRO)}`)
    .join(';');
  return createHash('sha256').update(canonical).digest('hex');
}

interface RawFeatureCollection {
  type?: unknown;
  features?: unknown;
}

interface RawFeature {
  type?: unknown;
  properties?: Record<string, unknown>;
  geometry?: { type?: unknown; coordinates?: unknown };
}

/**
 * Разбор поставки.
 *
 * Принимает уже прочитанные manifest и GeoJSON, поэтому проверяется без диска.
 * Любое расхождение — отказ: описание в properties обязано совпадать с самими
 * координатами, иначе «что именно установлено» перестаёт быть известным.
 */
export function parseBundle(manifestRaw: unknown, geojsonRaw: unknown): MkadBundle {
  const manifest = manifestRaw as Partial<BundleManifest>;
  if (typeof manifest?.geometry !== 'string' || manifest.geometry === '') {
    reject('manifest не называет файл геометрии');
  }
  if (typeof manifest.geometrySha256 !== 'string' || manifest.geometrySha256.length !== 64) {
    reject('manifest не содержит отпечатка геометрии');
  }

  const collection = geojsonRaw as RawFeatureCollection;
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    reject('файл не является GeoJSON FeatureCollection');
  }
  if (collection.features.length !== 1) {
    reject(`ожидалась ровно одна геометрия, найдено ${collection.features.length}`);
  }

  const feature = collection.features[0] as RawFeature;
  if (feature?.type !== 'Feature' || feature.geometry?.type !== 'Polygon') {
    reject('единственная геометрия обязана быть Polygon');
  }

  const rings = feature.geometry.coordinates;
  if (!Array.isArray(rings) || rings.length !== 1) {
    reject('у полигона обязано быть ровно одно кольцо без дыр');
  }

  const raw = rings[0] as unknown;
  if (!Array.isArray(raw)) {
    reject('кольцо не является списком координат');
  }

  const points: RingPoint[] = raw.map((item) => {
    const pair = item as [unknown, unknown];
    if (!Array.isArray(pair) || pair.length !== 2) {
      reject('точка кольца задаётся парой «долгота, широта»');
    }
    const lon = Number(pair[0]);
    const lat = Number(pair[1]);
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      reject('координата точки кольца недопустима');
    }
    return { lon, lat };
  });

  if (points.length < RING_LIMITS.minPoints) {
    reject(`точек ${points.length}, ожидалось не меньше ${RING_LIMITS.minPoints}`);
  }

  const first = points[0];
  const last = points[points.length - 1];
  if (
    first === undefined ||
    last === undefined ||
    first.lon !== last.lon ||
    first.lat !== last.lat
  ) {
    reject('кольцо не замкнуто: последняя точка обязана совпадать с первой');
  }

  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const sha256 = geometrySha256(points);
  if (sha256 !== manifest.geometrySha256) {
    reject('отпечаток геометрии не совпадает с manifest: файл повреждён или подменён');
  }
  if (properties['geometrySha256'] !== sha256) {
    reject('отпечаток внутри GeoJSON не совпадает с самими координатами');
  }
  if (properties['pointCount'] !== points.length) {
    reject('описание числа точек не совпадает с самими координатами');
  }

  const bbox = ringBbox(points);
  if (
    bbox[0] < RING_LIMITS.bbox.minLon ||
    bbox[1] < RING_LIMITS.bbox.minLat ||
    bbox[2] > RING_LIMITS.bbox.maxLon ||
    bbox[3] > RING_LIMITS.bbox.maxLat
  ) {
    reject(`рамка ${bbox.join(', ')} выходит за пределы Москвы`);
  }

  const declaredBbox = properties['bbox'];
  if (
    !Array.isArray(declaredBbox) ||
    declaredBbox.length !== 4 ||
    declaredBbox.some((value, index) => Math.abs(Number(value) - (bbox[index] ?? 0)) > 1e-6)
  ) {
    reject('рамка в описании не совпадает с самими координатами');
  }

  if (hasSelfIntersection(points)) {
    reject('кольцо пересекает само себя');
  }

  const lengthMeters = Math.round(ringLengthMeters(points));
  if (lengthMeters < RING_LIMITS.lengthMeters.min || lengthMeters > RING_LIMITS.lengthMeters.max) {
    reject(
      `длина кольца ${(lengthMeters / 1000).toFixed(3)} км вне диапазона ` +
        `${RING_LIMITS.lengthMeters.min / 1000}–${RING_LIMITS.lengthMeters.max / 1000} км`,
    );
  }
  if (Math.abs(Number(properties['lengthMeters']) - lengthMeters) > 1) {
    reject('длина в описании не совпадает с самими координатами');
  }

  if (Number(properties['osmRelationId']) !== manifest.osmRelationId) {
    reject('отношение OSM в описании не совпадает с manifest');
  }
  if (String(properties['license']) !== 'ODbL-1.0') {
    reject('лицензия геометрии обязана быть ODbL-1.0');
  }

  return {
    version: String(properties['geometryVersion'] ?? manifest.geometryVersion ?? ''),
    osmRelationId: Number(properties['osmRelationId']),
    snapshotUrl: String(properties['snapshotUrl'] ?? ''),
    snapshotMd5: String(properties['snapshotMd5'] ?? ''),
    snapshotSha256: String(properties['snapshotSha256'] ?? ''),
    dataDate: String(properties['dataDate'] ?? ''),
    derivation: String(properties['derivation'] ?? ''),
    builder: String(properties['builder'] ?? ''),
    license: String(properties['license']),
    attribution: String(properties['attribution'] ?? ''),
    sha256,
    pointCount: points.length,
    lengthMeters,
    bbox,
    points,
  };
}
