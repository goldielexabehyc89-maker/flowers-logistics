/**
 * Правила отображения геоданных, вынесенные из компонентов.
 *
 * Здесь только чистые функции: они решают, какой заказ вообще можно показать
 * на карте, что написать вместо кода состояния и как выглядит маркер
 * нераспределённого заказа против уже включённого в маршрут.
 */

export type GeoState = 'UNRESOLVED' | 'PENDING' | 'RESOLVED' | 'NEEDS_REVIEW' | 'FAILED';

export interface OrderGeo {
  state: GeoState;
  source: string | null;
  precision: string | null;
  reviewReason: string | null;
  /** Десятичные строки: целые микроградусы наружу не показываются. */
  lat: string | null;
  lon: string | null;
}

export interface MapPoint {
  orderId: string;
  number: string;
  lat: string | null;
  lon: string | null;
  precision: string | null;
  needsAttention: boolean;
  assigned: boolean;
  routeId: string | null;
  routeNumber: string | null;
  position: number | null;
}

export interface MapPointsResponse {
  deliveryDate: string;
  points: MapPoint[];
}

export interface MapConfig {
  configured: boolean;
  styleUrl: string | null;
  attribution: string | null;
}

export const GEO_STATE_LABELS: Record<GeoState, string> = {
  UNRESOLVED: 'Точка не определена',
  PENDING: 'Определяется',
  RESOLVED: 'Точка подтверждена',
  NEEDS_REVIEW: 'Требуется проверка точки',
  FAILED: 'Точку определить не удалось',
};

export const GEO_REVIEW_LABELS: Record<string, string> = {
  ADDRESS_CHANGED: 'адрес изменён, требуется повторная проверка',
  LOW_PRECISION: 'найдена только улица или населённый пункт',
  PROVIDER_FAILED: 'сервис определения адреса не ответил',
  MANUAL_CHECK: 'проверку запросил человек',
};

/** Короткое объяснение для строки списка. Пусто, если точка в порядке. */
export function geoHint(geo: OrderGeo): string | null {
  if (geo.state === 'RESOLVED') {
    return null;
  }
  const reason = geo.reviewReason === null ? null : GEO_REVIEW_LABELS[geo.reviewReason];
  return reason === undefined || reason === null
    ? GEO_STATE_LABELS[geo.state]
    : `${GEO_STATE_LABELS[geo.state]}: ${reason}`;
}

/**
 * Можно ли показать заказ на карте.
 *
 * Только подтверждённая точка: маркер там, где координата не подтверждена,
 * выглядит как факт и отправит курьера не туда. Заказ без точки не исчезает —
 * он остаётся в списке с объяснением.
 */
export function isMappable(geo: Pick<OrderGeo, 'state' | 'lat' | 'lon'>): boolean {
  return geo.state === 'RESOLVED' && geo.lat !== null && geo.lon !== null;
}

/** Числовые координаты для карты. `null`, если точка непригодна. */
export function toLngLat(point: {
  lat: string | null;
  lon: string | null;
}): [number, number] | null {
  if (point.lat === null || point.lon === null) {
    return null;
  }
  const lat = Number(point.lat);
  const lon = Number(point.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return [lon, lat];
}

/** Округление до микроградуса: сервер хранит именно эту точность. */
export function roundCoordinate(value: number): string {
  return (Math.round(value * 1_000_000) / 1_000_000).toFixed(6);
}

export type MarkerKind = 'assigned' | 'unassigned' | 'attention';

/**
 * Как выглядит маркер.
 *
 * Три состояния, а не цветовая шкала: логисту нужно с одного взгляда отличить
 * «этот заказ уже в маршруте» от «этот ещё никуда не попал», а требующий
 * внимания заметить раньше остальных.
 */
export function markerKind(point: Pick<MapPoint, 'assigned' | 'needsAttention'>): MarkerKind {
  if (point.needsAttention) {
    return 'attention';
  }
  return point.assigned ? 'assigned' : 'unassigned';
}

/** Состояние карты для интерфейса. */
export interface MapStatus {
  ready: boolean;
  message: string | null;
}

/**
 * Настроена ли карта.
 *
 * Отсутствующий адрес стиля — это честное «карта не настроена», а не повод
 * молча пойти на публичный сервер OSM или демонстрационные тайлы: их условия
 * не допускают продуктовую нагрузку, а доступность никто не гарантирует.
 */
export function describeMap(config: MapConfig | undefined): MapStatus {
  if (config === undefined) {
    return { ready: false, message: 'Проверяем настройки карты…' };
  }
  if (!config.configured || config.styleUrl === null || config.styleUrl === '') {
    return {
      ready: false,
      message: 'Карта не настроена. Список заказов и маршруты работают как обычно.',
    };
  }
  return { ready: true, message: null };
}
