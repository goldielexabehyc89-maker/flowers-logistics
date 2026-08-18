/**
 * Правила отображения геоданных, вынесенные из компонентов.
 *
 * Здесь только чистые функции: они решают, какой заказ вообще можно показать
 * на карте, что написать вместо кода состояния и как выглядит маркер
 * нераспределённого заказа против уже включённого в маршрут.
 */

// Вид отметки — общий контракт карт продукта, а не собственный у раздела.
import { MARKER_CLASS, type MarkerContent } from '../map/marker';
import { markerHint, markerInterval } from '../deals/deals-view';

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
  /**
   * Интервал и адрес: те же поля, что у карты «Сделок».
   *
   * Необязательные: старые ответы без них не ломают экран, отметка просто
   * скажет «время не задано» вместо выдуманного интервала.
   */
  startMinute?: number | null;
  endMinute?: number | null;
  address?: string | null;
  assigned: boolean;
  /** Собран: отметка флориста ЛИБО букет в ячейке текущего круга сборки. */
  assembled?: boolean;
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
  /** Откуда взята подложка: собственный набор или заранее заданный адрес. */
  source?: 'SELF_HOSTED' | 'EXTERNAL_STYLE' | 'NONE';
  styleUrl: string | null;
  attribution: string | null;
  revision?: string | null;
  /** Почему подложка недоступна. Технических подробностей не раскрывает. */
  problem?: string | null;
  /**
   * Есть ли данные о текущей дорожной обстановке.
   *
   * `STATIC` означает постоянные скорости дорожного графа. Это НЕ пробки,
   * и интерфейс обязан сказать это прямо: цифра, выданная за знание о текущей
   * ситуации, заставила бы логиста верить в точность, которой нет.
   */
  trafficMode?: 'NONE' | 'STATIC';
  /** Настроен ли расчёт времени в пути. */
  routingAvailable?: boolean;
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

/**
 * Как выглядит точка на карте маршрутизации.
 *
 * Тот же контракт, что и на карте «Сделок», и те же правила: цифра в кружке
 * означает позицию остановки в маршруте. У нераспределённой сделки позиции
 * нет — её кружок пуст, а номер и адрес показывает подсказка. Своей второй
 * реализации отметки у маршрутизации нет: один заказ обязан выглядеть
 * одинаково, из какого бы раздела на него ни смотрели.
 */
export function markerContentOf(
  point: MapPoint,
  options: { label: string; selected: boolean; formatMinute: (minute: number) => string },
): MarkerContent {
  const numbered = options.label !== '';
  const classes = [
    MARKER_CLASS,
    // Нумерованный крупный кружок — только у остановки маршрута. Точке,
    // которая ещё никуда не входит, номер приписывать нечему.
    `${MARKER_CLASS}--${numbered ? 'picked' : 'free'}`,
    ...(point.needsAttention ? [`${MARKER_CLASS}--attention`] : []),
    // Собранность — состояние заказа, а не выбора: она видна и у свободной
    // точки, и у остановки с номером.
    ...(point.assembled === true ? [`${MARKER_CLASS}--assembled`] : []),
    ...(options.selected ? [`${MARKER_CLASS}--selected`] : []),
  ];

  return {
    label: options.label,
    interval: markerInterval(
      { startMinute: point.startMinute ?? null, endMinute: point.endMinute ?? null },
      options.formatMinute,
    ),
    hint: markerHint({ number: point.number, address: point.address ?? null }),
    className: classes.join(' '),
    // Опознание всегда по номеру заказа: подпись может быть позицией
    // остановки, и «Заказ 3» означало бы совсем другое.
    ariaLabel: `Заказ ${point.number} на карте`,
  };
}

/** Состояние карты для интерфейса. */
export interface MapStatus {
  ready: boolean;
  message: string | null;
}

/** Понятные объяснения отказов подложки. Внутренних подробностей нет. */
export const BASEMAP_PROBLEMS: Record<string, string> = {
  NOT_CONFIGURED: 'Карта не настроена: подложка не установлена.',
  MANIFEST_MISSING: 'Карта не настроена: набор подложки не найден на сервере.',
  MANIFEST_INVALID: 'Карта не настроена: набор подложки не распознан.',
  ARTIFACT_MISSING: 'Карта не настроена: часть файлов подложки отсутствует.',
  SIZE_MISMATCH: 'Карта не настроена: файлы подложки не совпадают с описанием набора.',
  CHECKSUM_MISMATCH: 'Карта не настроена: файлы подложки не совпадают с описанием набора.',
  STYLE_NOT_LISTED: 'Карта не настроена: стиль отсутствует в наборе.',
};

/**
 * Пометка о дорожной обстановке.
 *
 * Показывается всегда, когда расчёт времени вообще возможен. Молчание здесь
 * читалось бы как «пробки учтены»: собственный стек считает по постоянным
 * скоростям графа и о текущей ситуации не знает ничего.
 */
export function trafficNote(config: MapConfig | undefined): string | null {
  if (config?.routingAvailable !== true) {
    return null;
  }
  return 'Время в пути — без данных о текущих пробках.';
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
    const explained =
      config.problem === null || config.problem === undefined
        ? null
        : (BASEMAP_PROBLEMS[config.problem] ?? null);

    return {
      ready: false,
      message: `${explained ?? 'Карта не настроена.'} Список заказов и маршруты работают как обычно.`,
    };
  }
  return { ready: true, message: null };
}
