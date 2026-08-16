/**
 * Фактическая геометрия маршрута для карты.
 *
 * Маршрут начинается с подтверждённой точки основного склада и идёт по
 * остановкам в их текущем порядке. Линия — настоящий путь по дорогам от
 * собственной Valhalla, а не прямые отрезки: прямая между точками читается
 * как рассчитанный путь и как обещание времени, которого никто не давал.
 *
 * Возврат на склад добавляется ТОЛЬКО если он есть в самом маршруте
 * (`endDepotId`). Дорисовывать его ручному черновику нельзя: это изменило бы
 * длину пути, которую логист принимает за факт.
 *
 * Отказ маршрутизатора не ломает работу (`ROUTE-003`): контракт возвращает
 * причину, а экран продолжает показывать список и отметки. Молчаливой
 * подмены прямыми линиями здесь нет.
 */

import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import {
  COSTING,
  ValhallaError,
  type LatLon,
  type RouteGeometry,
} from '../integrations/valhalla/client.js';
import type { LngLat } from '../integrations/valhalla/polyline.js';

const MICRO = 1_000_000;

/** Что умеет маршрутизатор с точки зрения этого модуля. */
export interface RouteGeometryRouter {
  readonly configured: boolean;
  route(points: readonly LatLon[], costing: 'auto' | 'pedestrian'): Promise<RouteGeometry>;
}

export interface GeometryStop {
  orderId: string;
  number: string;
  position: number;
  lng: number;
  lat: number;
}

export interface RouteGeometryView {
  routeId: string;
  /** Точка склада начала. `null` — склада или его точки нет. */
  depot: { name: string; lng: number; lat: number } | null;
  stops: GeometryStop[];
  /** Линия по дорогам. Пусто — линии нет, и её отсутствие названо причиной. */
  line: LngLat[];
  timeSeconds: number | null;
  distanceMeters: number | null;
  /** Почему линии нет. `null` — линия построена. */
  unavailableReason: string | null;
}

/** Координаты остановок и склада для одного маршрута. */
async function loadRoute(
  db: Database,
  routeId: string,
): Promise<{
  vehicleType: 'CAR' | 'FOOT';
  stops: GeometryStop[];
  startDepotId: string | null;
  endDepotId: string | null;
}> {
  const route = await db.deliveryRoute.findUnique({
    where: { id: routeId },
    select: {
      vehicleType: true,
      startDepotId: true,
      endDepotId: true,
      orders: {
        where: { removedAt: null },
        orderBy: { position: 'asc' },
        select: {
          position: true,
          order: {
            select: {
              id: true,
              externalName: true,
              geoLatMicro: true,
              geoLonMicro: true,
              geoState: true,
            },
          },
        },
      },
    },
  });

  if (route === null) {
    throw new AppError('NOT_FOUND', {
      message: 'route not found',
      publicMessage: 'Маршрут не найден.',
    });
  }

  const stops: GeometryStop[] = [];
  for (const row of route.orders) {
    const order = row.order;
    // Заказ без подтверждённой точки в линию не входит: выдуманная координата
    // выглядит как настоящая и уводит линию через полгорода.
    if (order.geoState !== 'RESOLVED' || order.geoLatMicro === null || order.geoLonMicro === null) {
      continue;
    }
    stops.push({
      orderId: order.id,
      number: order.externalName,
      position: row.position,
      lng: order.geoLonMicro / MICRO,
      lat: order.geoLatMicro / MICRO,
    });
  }

  return {
    vehicleType: route.vehicleType,
    stops,
    startDepotId: route.startDepotId,
    endDepotId: route.endDepotId,
  };
}

/** Склад начала: собственный склад маршрута либо основной склад по умолчанию. */
async function loadDepot(
  db: Database,
  startDepotId: string | null,
): Promise<{ name: string; lng: number; lat: number } | null> {
  const depot =
    startDepotId === null
      ? await db.depot.findFirst({
          where: { defaultKey: { not: null }, isActive: true },
          select: { name: true, latMicro: true, lonMicro: true },
        })
      : await db.depot.findUnique({
          where: { id: startDepotId },
          select: { name: true, latMicro: true, lonMicro: true },
        });

  if (depot === null || depot.latMicro === null || depot.lonMicro === null) {
    return null;
  }
  return { name: depot.name, lng: depot.lonMicro / MICRO, lat: depot.latMicro / MICRO };
}

export async function routeGeometry(
  db: Database,
  router: RouteGeometryRouter,
  routeId: string,
): Promise<RouteGeometryView> {
  const route = await loadRoute(db, routeId);
  const depot = await loadDepot(db, route.startDepotId);

  const base: Omit<
    RouteGeometryView,
    'line' | 'timeSeconds' | 'distanceMeters' | 'unavailableReason'
  > = {
    routeId,
    depot,
    stops: route.stops,
  };

  if (depot === null) {
    return {
      ...base,
      line: [],
      timeSeconds: null,
      distanceMeters: null,
      unavailableReason: 'Нет подтверждённой точки основного склада: маршрут не с чего начинать.',
    };
  }
  if (route.stops.length === 0) {
    return {
      ...base,
      line: [],
      timeSeconds: null,
      distanceMeters: null,
      unavailableReason: 'В маршруте нет заказов с подтверждённой точкой.',
    };
  }
  if (!router.configured) {
    return {
      ...base,
      line: [],
      timeSeconds: null,
      distanceMeters: null,
      unavailableReason: 'Маршрутизатор не настроен: линия пути не строится.',
    };
  }

  const points: LatLon[] = [
    { lat: depot.lat, lon: depot.lng },
    ...route.stops.map((stop) => ({ lat: stop.lat, lon: stop.lng })),
  ];
  // Возврат добавляется только там, где он есть в самом маршруте.
  if (route.endDepotId !== null) {
    const end = await loadDepot(db, route.endDepotId);
    if (end !== null) {
      points.push({ lat: end.lat, lon: end.lng });
    }
  }

  try {
    const geometry = await router.route(points, COSTING[route.vehicleType]);
    return {
      ...base,
      line: geometry.line,
      timeSeconds: geometry.timeSeconds,
      distanceMeters: geometry.distanceMeters,
      unavailableReason: null,
    };
  } catch (error) {
    // Отказ маршрутизатора не блокирует ручную работу: логист видит состав,
    // отметки и порядок, а причину отсутствия линии — словами.
    const reason = error instanceof ValhallaError ? error.message : 'Маршрутизатор не ответил';
    return {
      ...base,
      line: [],
      timeSeconds: null,
      distanceMeters: null,
      unavailableReason: `${reason}: линия пути не построена.`,
    };
  }
}
