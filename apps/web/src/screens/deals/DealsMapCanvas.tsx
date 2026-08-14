/**
 * Настоящая карта экрана «Сделки».
 *
 * Отдельный холст, а не переиспользование карты маршрутов: там один выбранный
 * заказ, здесь — множественный выбор с номерами и кластеры. Свести обе задачи
 * в один компонент значило бы усложнить работающий экран маршрутов ради чужих
 * требований.
 *
 * Общим осталось ровно то, где ошибка стоит дорого: адрес воркера MapLibre,
 * регистрация протокола `pmtiles://` и центр Москвы — они живут в `map-runtime`
 * и настраиваются один раз на приложение.
 *
 * Публичные тайлы OSM и демонстрационные тайлы MapLibre не используются: их
 * условия не допускают продуктовую нагрузку. Подложка приходит из нашей
 * конфигурации; если она не задана, экран честно об этом говорит.
 *
 * КАРТА СОЗДАЁТСЯ ВСЕГДА, даже когда точек ноль. Пустой день — обычное дело,
 * и подложка Москвы в этот момент нужна не меньше: логист видит, где он
 * работает, а не серый прямоугольник.
 */

import { useEffect, useRef, useState } from 'react';
import { Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { DEFAULT_CENTER, DEFAULT_ZOOM, registerPmtiles } from '../routing/map-runtime';
import { resolveStyleUrls, type StyleDocument } from '../routing/style-urls';

/** Точка дня. Совпадает с ответом `/api/deals/map`. */
export interface DealMapPoint {
  orderId: string;
  number: string;
  lat: string;
  lon: string;
  needsAttention: boolean;
}

/** Группа точек, показываемая одной отметкой. */
export interface DealMapCluster {
  key: string;
  points: readonly DealMapPoint[];
}

export interface DealsMapCanvasProps {
  styleUrl: string;
  attribution: string | null;
  /** Выбранные заказы: показываются отдельно и с номером. */
  chosen: readonly DealMapPoint[];
  /** Остальные: одиночные отметки либо кластеры. */
  clusters: readonly DealMapCluster[];
  /** Номер заказа в выборке. Пусто — заказ не выбран. */
  numberOf: (orderId: string) => string | null;
  onToggle: (orderId: string) => void;
  /** Подложка не загрузилась: экран обязан сказать это, а не молчать. */
  onLoadError: () => void;
}

/** Координаты точки в порядке MapLibre. `null` — координата непригодна. */
function toLngLat(point: DealMapPoint): [number, number] | null {
  const lat = Number(point.lat);
  const lon = Number(point.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return [lon, lat];
}

/** Что рисуется в конкретной отметке. */
interface MarkerPlan {
  key: string;
  lngLat: [number, number];
  label: string;
  className: string;
  ariaLabel: string;
  orderId: string | null;
}

/**
 * Готовит отметки карты.
 *
 * Чистая функция: раскладку можно доказать без браузера и без MapLibre.
 * Выбранные никогда не попадают в кластер — их номер обязан оставаться видимым.
 */
export function planMarkers(
  chosen: readonly DealMapPoint[],
  clusters: readonly DealMapCluster[],
  numberOf: (orderId: string) => string | null,
): MarkerPlan[] {
  const plans: MarkerPlan[] = [];

  for (const point of chosen) {
    const lngLat = toLngLat(point);
    if (lngLat === null) {
      continue;
    }
    plans.push({
      key: point.orderId,
      lngLat,
      label: numberOf(point.orderId) ?? '•',
      className: 'deals-marker deals-marker--picked',
      ariaLabel: `Заказ ${point.number} выбран, номер ${numberOf(point.orderId) ?? ''}`,
      orderId: point.orderId,
    });
  }

  for (const cluster of clusters) {
    const first = cluster.points[0];
    if (first === undefined) {
      continue;
    }
    const lngLat = toLngLat(first);
    if (lngLat === null) {
      continue;
    }

    if (cluster.points.length === 1) {
      plans.push({
        key: first.orderId,
        lngLat,
        label: first.number,
        className: `deals-marker deals-marker--${first.needsAttention ? 'draft' : 'free'}`,
        ariaLabel: `Заказ ${first.number} на карте`,
        orderId: first.orderId,
      });
      continue;
    }

    // Кластер кликом ничего не выбирает: непонятно, какой именно заказ имел
    // в виду человек. Он существует, чтобы два десятка отметок на одном доме
    // оставались читаемыми.
    plans.push({
      key: `cluster:${cluster.key}`,
      lngLat,
      label: String(cluster.points.length),
      className: 'deals-marker deals-marker--cluster',
      ariaLabel: `Здесь ${cluster.points.length} заказов`,
      orderId: null,
    });
  }

  return plans;
}

export function DealsMapCanvas({
  styleUrl,
  attribution,
  chosen,
  clusters,
  numberOf,
  onToggle,
  onLoadError,
}: DealsMapCanvasProps): React.JSX.Element {
  const [mapReady, setMapReady] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());

  // Колбэк живёт в ссылке: пересоздавать карту при каждом рендере списка
  // недопустимо — это сбрасывало бы масштаб и положение.
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;
  const loadErrorRef = useRef(onLoadError);
  loadErrorRef.current = onLoadError;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || styleUrl === '') {
      return;
    }

    registerPmtiles();

    let cancelled = false;
    let map: MapLibreMap | null = null;

    void (async () => {
      let style: StyleDocument;
      try {
        const response = await fetch(styleUrl, { credentials: 'same-origin' });
        if (!response.ok) {
          throw new Error(`стиль недоступен: ${response.status}`);
        }
        style = resolveStyleUrls(
          (await response.json()) as StyleDocument,
          response.url,
          window.location.origin,
        );
      } catch {
        // Молча показать серый прямоугольник нельзя: логист должен понимать,
        // что видит не карту.
        if (!cancelled) {
          loadErrorRef.current();
        }
        return;
      }
      if (cancelled) {
        return;
      }

      map = new MapLibreMap({
        container,
        style: style as unknown as StyleSpecification,
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        attributionControl: attribution === null ? false : { customAttribution: attribution },
      });
      map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
      map.on('error', () => loadErrorRef.current());
      map.once('load', () => {
        if (!cancelled) {
          setMapReady(true);
        }
      });
      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      for (const marker of markersRef.current.values()) {
        marker.remove();
      }
      markersRef.current.clear();
      map?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [styleUrl, attribution]);

  // Отметки пересобираются при изменении выборки или набора точек.
  //
  // Именно здесь появляется маркер заказа, у которого только что появились
  // координаты: перезагрузка страницы для этого не нужна — список и карта
  // берут одни и те же данные, и обновление запроса перерисовывает обе части.
  useEffect(() => {
    const map = mapRef.current;
    if (map === null) {
      return;
    }

    const markers = markersRef.current;
    const plans = planMarkers(chosen, clusters, numberOf);
    const seen = new Set<string>();

    for (const plan of plans) {
      seen.add(plan.key);

      const existing = markers.get(plan.key);
      if (existing !== undefined) {
        existing.setLngLat(plan.lngLat);
        const element = existing.getElement();
        element.textContent = plan.label;
        element.className = plan.className;
        element.setAttribute('aria-label', plan.ariaLabel);
        continue;
      }

      const element = document.createElement('button');
      element.type = 'button';
      element.className = plan.className;
      element.textContent = plan.label;
      element.setAttribute('aria-label', plan.ariaLabel);
      element.dataset['testid'] = 'map-marker';
      if (plan.orderId !== null) {
        element.dataset['orderNumber'] = plan.label;
        const orderId = plan.orderId;
        element.addEventListener('click', (event) => {
          event.stopPropagation();
          toggleRef.current(orderId);
        });
      }

      markers.set(plan.key, new Marker({ element }).setLngLat(plan.lngLat).addTo(map));
    }

    for (const [key, marker] of markers) {
      if (!seen.has(key)) {
        marker.remove();
        markers.delete(key);
      }
    }
  }, [chosen, clusters, numberOf, mapReady]);

  /*
   * Класс контейнера карты постоянен намеренно: MapLibre дописывает в него
   * собственный `maplibregl-map`, и очередной рендер React затёр бы чужой класс.
   */
  return <div className="deals-map__canvas" ref={containerRef} data-testid="deals-map-canvas" />;
}
