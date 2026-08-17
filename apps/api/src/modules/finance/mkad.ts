/**
 * Расстояние заказа за МКАД.
 *
 * Считается дорожное расстояние от БЛИЖАЙШЕЙ точки кольца до адреса заказа,
 * округляется до 0,1 км и сохраняется снимком. Снимок обязателен: геометрия
 * кольца и дорожный граф со временем меняются, а начисление за вчерашний
 * маршрут меняться не имеет права.
 *
 * Геометрия кольца НЕ зашита в код и не загружается через интерфейс: она
 * приходит системным файлом поставки (`mkad-bundle.ts`), и каждая версия
 * неизменяема. Придумывать «примерно кольцо» нельзя — от него зависят деньги.
 */

import { createHash } from 'node:crypto';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { LatLon } from '../integrations/valhalla/client.js';

/** Микроградусы: координаты кольца хранятся целыми, как и у заказов. */
const MICRO = 1_000_000;

/** Метров в одном градусе широты. Для выбора ближайшей точки этого достаточно. */
const METERS_PER_DEGREE_LAT = 111_320;

export interface RingPoint {
  lon: number;
  lat: number;
}

export interface RingVersionView {
  id: string;
  pointCount: number;
  sha256: string;
  source: string;
  createdAt: string;
}

/**
 * Разбор загруженного кольца.
 *
 * Принимается список пар «долгота, широта» в градусах. Кольцо обязано быть
 * замкнутым и содержать хотя бы три различные точки: иначе «ближайшая точка
 * МКАД» не определена, а деньги считать по неопределённости нельзя.
 */
export function parseRing(input: unknown): RingPoint[] {
  if (!Array.isArray(input) || input.length < 4) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: 'Кольцо МКАД должно содержать не меньше четырёх точек.',
    });
  }

  const points = input.map((item) => {
    const pair = item as [unknown, unknown];
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new AppError('VALIDATION_FAILED', {
        publicMessage: 'Точка кольца задаётся парой «долгота, широта».',
      });
    }
    const lon = Number(pair[0]);
    const lat = Number(pair[1]);
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      throw new AppError('VALIDATION_FAILED', {
        publicMessage: 'Координата точки кольца недопустима.',
      });
    }
    return { lon, lat };
  });

  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) {
    throw new AppError('VALIDATION_FAILED', { publicMessage: 'Кольцо МКАД пустое.' });
  }
  if (Math.abs(first.lon - last.lon) > 1e-9 || Math.abs(first.lat - last.lat) > 1e-9) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: 'Кольцо МКАД должно быть замкнутым: последняя точка совпадает с первой.',
    });
  }

  return points;
}

/** Отпечаток геометрии: одна и та же линия не заводит вторую версию. */
export function ringSha256(points: readonly RingPoint[]): string {
  const canonical = points
    .map((point) => `${Math.round(point.lon * MICRO)},${Math.round(point.lat * MICRO)}`)
    .join(';');
  return createHash('sha256').update(canonical).digest('hex');
}

function toMicro(points: readonly RingPoint[]): number[][] {
  return points.map((point) => [Math.round(point.lon * MICRO), Math.round(point.lat * MICRO)]);
}

export function fromMicro(stored: unknown): RingPoint[] {
  const rows = Array.isArray(stored) ? (stored as number[][]) : [];
  return rows.map((pair) => ({ lon: (pair[0] ?? 0) / MICRO, lat: (pair[1] ?? 0) / MICRO }));
}

/**
 * Ближайшая точка кольца по прямой.
 *
 * Прямая — только для ВЫБОРА точки съезда. Само расстояние потом считает
 * маршрутизатор по дорогам: платить по воздушной линии нельзя.
 */
export function nearestRingPoint(ring: readonly RingPoint[], target: LatLon): LatLon {
  let best: LatLon = { lat: target.lat, lon: target.lon };
  let bestDistance = Number.POSITIVE_INFINITY;

  const cos = Math.cos((target.lat * Math.PI) / 180);
  for (const point of ring) {
    const dy = (point.lat - target.lat) * METERS_PER_DEGREE_LAT;
    const dx = (point.lon - target.lon) * METERS_PER_DEGREE_LAT * cos;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { lat: point.lat, lon: point.lon };
    }
  }

  return best;
}

/**
 * Внутри ли точка кольца.
 *
 * Обычный алгоритм пересечений луча. Для точки внутри МКАД расстояние за МКАД
 * равно нулю по определению, и маршрутизатор для этого не нужен.
 */
export function isInsideRing(ring: readonly RingPoint[], target: LatLon): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) {
      continue;
    }
    const crosses = a.lat > target.lat !== b.lat > target.lat;
    if (!crosses) {
      continue;
    }
    const x = ((b.lon - a.lon) * (target.lat - a.lat)) / (b.lat - a.lat) + a.lon;
    if (target.lon < x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Округление до 0,1 км — один раз и на записи, а не при каждом чтении. */
export function toKmTenths(meters: number): number {
  return Math.round(meters / 100);
}

export interface StoreRingInput {
  points: RingPoint[];
  source: string;
  license: string;
  /** Дата, на которую геометрия актуальна, в московском календаре. */
  sourceDate: string;
}

/**
 * Регистрация версии кольца.
 *
 * Повторная загрузка той же геометрии не создаёт новую версию: отпечаток
 * совпадает, и снимки прошлых расчётов продолжают ссылаться на ту же строку.
 */
export async function storeRing(db: Database, input: StoreRingInput): Promise<RingVersionView> {
  const sha256 = ringSha256(input.points);
  const existing = await db.mkadRingVersion.findUnique({ where: { sha256 } });
  if (existing !== null) {
    return {
      id: existing.id,
      pointCount: existing.pointCount,
      sha256: existing.sha256,
      source: existing.source,
      createdAt: existing.createdAt.toISOString(),
    };
  }

  const created = await db.mkadRingVersion.create({
    data: {
      points: toMicro(input.points),
      pointCount: input.points.length,
      sha256,
      source: input.source,
      license: input.license,
      sourceDate: new Date(`${input.sourceDate}T00:00:00.000Z`),
    },
  });

  return {
    id: created.id,
    pointCount: created.pointCount,
    sha256: created.sha256,
    source: created.source,
    createdAt: created.createdAt.toISOString(),
  };
}

export interface DistanceRouter {
  readonly configured: boolean;
  route(
    points: readonly LatLon[],
    costing: 'auto' | 'pedestrian',
  ): Promise<{ distanceMeters: number | null }>;
}

export interface ComputeDistanceInput {
  routeOrderId: string;
  target: LatLon;
  graphSha256: string | null;
}

/** Действующее кольцо: его выбирает поставка, а не порядок строк в таблице. */
export interface ActiveRing {
  id: string;
  points: RingPoint[];
}

export interface DistanceResult {
  meters: number;
  roundedKmTenths: number;
  insideMkad: boolean;
}

/**
 * Расчёт расстояния за МКАД для одного заказа.
 *
 * Возвращает `null`, если считать нечем: нет кольца, нет маршрутизатора или он
 * не смог построить путь. Отсутствие расчёта — честное состояние, ноль вместо
 * него означал бы «за МКАД не выезжали», а это неправда.
 */
export async function computeBeyondMkad(
  ring: ActiveRing,
  router: DistanceRouter,
  input: ComputeDistanceInput,
): Promise<DistanceResult | null> {
  if (isInsideRing(ring.points, input.target)) {
    return { meters: 0, roundedKmTenths: 0, insideMkad: true };
  }

  if (!router.configured) {
    return null;
  }

  const from = nearestRingPoint(ring.points, input.target);
  const geometry = await router.route([from, input.target], 'auto');
  if (geometry.distanceMeters === null) {
    return null;
  }

  const meters = Math.max(0, Math.round(geometry.distanceMeters));
  return { meters, roundedKmTenths: toKmTenths(meters), insideMkad: false };
}

/**
 * Сохранение снимка расстояния.
 *
 * Прежняя действующая строка не удаляется: у неё снимается признак действующей,
 * и она остаётся в истории. Так ручная правка логиста не стирает расчёт.
 */
export async function saveDistanceSnapshot(
  db: Database,
  input: {
    routeOrderId: string;
    ringVersionId: string;
    graphSha256: string | null;
    meters: number;
    insideMkad: boolean;
    source: 'COMPUTED' | 'MANUAL';
    actorUserId?: string | null;
    reason?: string | null;
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.routeOrderDistance.updateMany({
      where: { routeOrderId: input.routeOrderId, activeKey: { not: null } },
      data: { activeKey: null },
    });

    await tx.routeOrderDistance.create({
      data: {
        routeOrderId: input.routeOrderId,
        ringVersionId: input.ringVersionId,
        graphSha256: input.graphSha256,
        meters: input.meters,
        roundedKmTenths: toKmTenths(input.meters),
        insideMkad: input.insideMkad,
        source: input.source,
        actorUserId: input.actorUserId ?? null,
        reason: input.reason ?? null,
        activeKey: input.routeOrderId,
      },
    });
  });
}
