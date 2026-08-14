/**
 * Карта заказов выбранного дня.
 *
 * MapLibre GL JS со стилем из конфигурации сервера. Публичные тайлы OSM
 * и демонстрационные тайлы MapLibre не используются: их условия не допускают
 * продуктовую нагрузку. Если стиль не задан, карта честно об этом говорит,
 * а маршрутизация продолжает работать списком — молчаливого обращения
 * к чужому серверу не происходит.
 *
 * Маршрутных линий, матриц и автоматического распределения здесь нет: этих
 * данных ещё не существует, а нарисованная линия выглядела бы как расчёт.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { markerKind, toLngLat, type MapPoint } from './geo';
import { DEFAULT_CENTER, DEFAULT_ZOOM, registerPmtiles } from './map-runtime';
import { resolveStyleUrls, type StyleDocument } from './style-urls';



export interface OrdersMapProps {
  styleUrl: string;
  attribution: string | null;
  points: readonly MapPoint[];
  /** Выбранная строка списка: её маркер подсвечивается. */
  selectedOrderId: string | null;
  onSelect: (orderId: string) => void;
  /** Режим установки точки: клик по карте возвращает координаты. */
  picking: boolean;
  onPick: (coordinates: { lat: number; lon: number }) => void;
  /**
   * Подложка не загрузилась.
   *
   * Стиль или архив тайлов могли оказаться недоступны уже после того, как
   * конфигурация сказала «настроено». Молчаливо показать серый прямоугольник
   * нельзя: логист должен понимать, что видит не карту.
   */
  onLoadError: () => void;
}

export function OrdersMap({
  styleUrl,
  attribution,
  points,
  selectedOrderId,
  onSelect,
  picking,
  onPick,
  onLoadError,
}: OrdersMapProps): React.JSX.Element {
  /**
   * Карта создаётся асинхронно: сначала читается стиль, чтобы разрешить его
   * относительные адреса. Маркеры расставляются только после этого, иначе
   * первый набор точек не попал бы на карту.
   */
  const [mapReady, setMapReady] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());

  // Колбэки живут в ссылках: пересоздавать карту при каждом рендере списка
  // недопустимо — это сбрасывало бы масштаб и положение.
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const loadErrorRef = useRef(onLoadError);
  loadErrorRef.current = onLoadError;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    registerPmtiles();

    let cancelled = false;
    let map: MapLibreMap | null = null;

    /**
     * Состояние подложки в разметке: `loading`, `ready` или `error`.
     *
     * «Карта загрузилась» — это не «компонент смонтирован», а «стиль применён
     * и первый кадр отрисован». Признак нужен и человеку, и проверке после
     * выкатки. Глобального отладочного объекта у приложения нет и не
     * появляется: состояние живёт там же, где сама карта.
     */
    const markState = (state: 'loading' | 'ready' | 'error'): void => {
      container.dataset['mapState'] = state;
    };
    markState('loading');

    /**
     * Стиль читается сам, а не передаётся адресом.
     *
     * Так база для относительных адресов внутри стиля — его ФАКТИЧЕСКИЙ адрес,
     * а не догадка. Это принципиально: MapLibre разрешает такие пути не везде.
     * Спрайт обязан быть абсолютным — относительный отвергается при разборе
     * стиля. Адрес с собственным протоколом `pmtiles://` уходит в обработчик
     * как есть и разрешается относительно СТРАНИЦЫ: на `/routing` это давало
     * запрос `/tiles-….pmtiles` вместо `/maps/tiles-….pmtiles`, в ответ
     * приходила оболочка приложения, и карта не открывалась.
     */
    const start = async (): Promise<void> => {
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
        // Внешнего запасного источника нет и быть не может: публичные серверы
        // OSM в работе не используются.
        markState('error');
        loadErrorRef.current();
        return;
      }

      if (cancelled) {
        return;
      }

      const instance = new MapLibreMap({
        container,
        style: style as unknown as StyleSpecification,
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        // Сбор статистики отключён: он ушёл бы на чужой сервер.
        attributionControl: attribution === null ? false : { customAttribution: attribution },
      });
      instance.addControl(new NavigationControl({ showCompass: false }), 'top-right');

      // Ошибка загрузки стиля или тайлов. Внешнего запасного источника нет
      // и быть не может: публичные серверы OSM в работе не используются.
      instance.on('error', () => {
        markState('error');
        loadErrorRef.current();
      });

      instance.on('load', () => {
        markState('ready');
      });

      instance.on('idle', () => {
        if (container.dataset['mapState'] !== 'error') {
          markState('ready');
        }
      });

      instance.on('click', (event: MapMouseEvent) => {
        if (pickingRef.current) {
          pickRef.current({ lat: event.lngLat.lat, lon: event.lngLat.lng });
        }
      });

      map = instance;
      mapRef.current = instance;
      setMapReady(true);
    };

    void start();

    return () => {
      cancelled = true;
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current.clear();
      map?.remove();
      map = null;
      mapRef.current = null;
      setMapReady(false);
    };
  }, [styleUrl, attribution]);

  // Маркеры пересобираются при изменении набора точек.
  useEffect(() => {
    const map = mapRef.current;
    if (map === null) {
      return;
    }

    const markers = markersRef.current;
    const seen = new Set<string>();

    for (const point of points) {
      const lngLat = toLngLat(point);
      if (lngLat === null) {
        continue;
      }
      seen.add(point.orderId);

      const existing = markers.get(point.orderId);
      if (existing !== undefined) {
        existing.setLngLat(lngLat);
        applyKind(existing, point, selectedOrderId);
        continue;
      }

      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'map-marker';
      element.textContent = point.number;
      element.setAttribute('aria-label', `Заказ ${point.number} на карте`);
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        selectRef.current(point.orderId);
      });

      const marker = new Marker({ element }).setLngLat(lngLat).addTo(map);
      applyKind(marker, point, selectedOrderId);
      markers.set(point.orderId, marker);
    }

    for (const [orderId, marker] of markers) {
      if (!seen.has(orderId)) {
        marker.remove();
        markers.delete(orderId);
      }
    }
  }, [points, selectedOrderId, mapReady]);

  // Выбор строки в списке подсвечивает маркер и подводит к нему карту.
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || selectedOrderId === null) {
      return;
    }
    const marker = markersRef.current.get(selectedOrderId);
    if (marker !== undefined) {
      map.easeTo({ center: marker.getLngLat(), duration: 300 });
    }
  }, [selectedOrderId]);

  /*
   * Класс контейнера карты постоянен намеренно.
   *
   * MapLibre дописывает в него собственный класс `maplibregl-map`, который задаёт
   * `position: relative`. Если менять className этого же элемента из React,
   * очередной рендер затрёт чужой класс, холст потеряет точку отсчёта и уедет
   * в угол страницы. Поэтому режим установки точки отмечается на обёртке.
   */
  return (
    <div className={`map${picking ? ' map--picking' : ''}`}>
      <div
        ref={containerRef}
        className="map__canvas"
        data-testid="orders-map"
        role="application"
        aria-label="Карта заказов выбранного дня"
      />
    </div>
  );
}

function applyKind(marker: Marker, point: MapPoint, selectedOrderId: string | null): void {
  const element = marker.getElement();
  element.classList.remove(
    'map-marker--assigned',
    'map-marker--unassigned',
    'map-marker--attention',
  );
  element.classList.add(`map-marker--${markerKind(point)}`);
  element.classList.toggle('map-marker--selected', point.orderId === selectedOrderId);
}
