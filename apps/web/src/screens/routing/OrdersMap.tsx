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

import { useEffect, useRef } from 'react';
import {
  addProtocol,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  type MapMouseEvent,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { markerKind, toLngLat, type MapPoint } from './geo';

/** Москва: карта открывается там, где работает служба. */
const DEFAULT_CENTER: [number, number] = [37.6173, 55.7558];
const DEFAULT_ZOOM = 10;

/**
 * Протокол `pmtiles://` регистрируется один раз на приложение.
 * Повторная регистрация в MapLibre — ошибка, а карта монтируется многократно.
 */
let pmtilesRegistered = false;

function registerPmtiles(): void {
  if (pmtilesRegistered) {
    return;
  }
  const protocol = new Protocol();
  addProtocol('pmtiles', protocol.tile);
  pmtilesRegistered = true;
}

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
}

export function OrdersMap({
  styleUrl,
  attribution,
  points,
  selectedOrderId,
  onSelect,
  picking,
  onPick,
}: OrdersMapProps): React.JSX.Element {
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

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    registerPmtiles();

    const map = new MapLibreMap({
      container,
      style: styleUrl,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      // Сбор статистики отключён: он ушёл бы на чужой сервер.
      attributionControl: attribution === null ? false : { customAttribution: attribution },
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');

    map.on('click', (event: MapMouseEvent) => {
      if (pickingRef.current) {
        pickRef.current({ lat: event.lngLat.lat, lon: event.lngLat.lng });
      }
    });

    mapRef.current = map;

    return () => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current.clear();
      map.remove();
      mapRef.current = null;
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
  }, [points, selectedOrderId]);

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
