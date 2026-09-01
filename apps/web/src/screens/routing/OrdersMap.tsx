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
import { addMetroLayer } from '../../lib/metro-layer';
import { markerContentOf, toLngLat, type MapPoint } from './geo';
// Тот же визуальный контракт, что и на карте «Сделок»: одна карта продукта.
import {
  createMarkerElement,
  fillMarkerElement,
  stampMarkerPoint,
  MARKER_CLASS,
} from '../map/marker';
import { formatMinutes } from '../deals/deals';
import { DEFAULT_CENTER, DEFAULT_ZOOM, registerPmtiles } from './map-runtime';
import { resolveStyleUrls, type StyleDocument } from './style-urls';

/**
 * Сколько ждать подъёма карты, прежде чем признать подложку недоступной.
 *
 * Не «мгновенно»: набор тайлов читается по частям, и первые секунды карта
 * законно молчит. И не «бесконечно»: нерабочая подложка обязана быть названа.
 *
 * Срок с запасом намеренно. На загруженной машине карта поднимается медленнее,
 * и короткий срок объявлял бы отказ там, где нужно просто подождать: вместе
 * с панелью отказа исчезали бы отметки, склад и линия маршрута.
 */
const BASEMAP_LOAD_TIMEOUT_MS = 30_000;

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
   * Что написать в кружке. По умолчанию — ничего.
   *
   * Рабочее место черновика подписывает точки активного маршрута позицией
   * остановки: нумерация на карте и в списке обязана совпадать. Номер заказа
   * сюда не попадает никогда — цифра в кружке читается как позиция в маршруте.
   */
  labelOf?: (point: MapPoint) => string;
  /**
   * Фактическая линия пути активного маршрута.
   *
   * Приходит с сервера от собственного маршрутизатора. Прямых отрезков между
   * точками здесь не бывает: прямая читалась бы как рассчитанный путь и как
   * обещание времени, которого никто не давал.
   */
  line?: readonly (readonly [number, number])[];
  /** Подтверждённая точка склада начала. Маршрут начинается отсюда. */
  depot?: { name: string; lng: number; lat: number } | null;
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
  labelOf,
  line,
  depot = null,
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
  const depotMarkerRef = useRef<Marker | null>(null);

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

      /*
       * Отказом считается ТОЛЬКО то, что карта так и не поднялась.
       *
       * Раньше панель отказа показывалась по ЛЮБОЙ ошибке MapLibre. Но
       * библиотека шлёт `error` и по мелочам: отсутствующий глиф, оборванный
       * запрос тайла, пустая клетка набора. На большом экране такая мелочь
       * находится почти всегда, и логист видел «подложка не загрузилась» там,
       * где карта работала — а вместе с панелью отказа исчезали и отметки,
       * и линия маршрута.
       *
       * Настоящий отказ никуда не делся: сломанная подложка события `load`
       * не даёт, и через отведённое время экран честно об этом скажет.
       * Внешнего запасного источника при этом нет и быть не может: публичные
       * серверы OSM в работе не используются.
       */
      const loadTimer = globalThis.setTimeout(() => {
        if (!cancelled) {
          markState('error');
          loadErrorRef.current();
        }
      }, BASEMAP_LOAD_TIMEOUT_MS);

      instance.on('load', () => {
        globalThis.clearTimeout(loadTimer);
        // Визуальный слой станций метро (общий набор generated/metro).
        addMetroLayer(instance);
        markState('ready');
      });

      // `idle` означает, что карта отрисовала всё, что могла: содержимое
      // на экране есть, даже если какой-то тайл так и не пришёл.
      instance.on('idle', () => {
        globalThis.clearTimeout(loadTimer);
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
      /*
       * Ссылка на карту для браузерной проверки.
       *
       * Линия маршрута — это данные источника MapLibre, а не разметка: из DOM
       * её не видно, и спросить о нарисованном можно только саму карту.
       */
      (globalThis as { __routingMap?: MapLibreMap }).__routingMap = instance;
      setMapReady(true);
    };

    void start();

    return () => {
      cancelled = true;
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current.clear();
      depotMarkerRef.current?.remove();
      depotMarkerRef.current = null;
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

      /*
       * Содержимое пересчитывается и у существующей точки: после перестановки
       * остановок номера обязаны совпасть со списком, иначе карта показывала
       * бы прежний порядок как действующий.
       */
      const content = markerContentOf(point, {
        label: labelOf === undefined ? '' : labelOf(point),
        selected: point.orderId === selectedOrderId,
        formatMinute: formatMinutes,
      });

      const existing = markers.get(point.orderId);
      if (existing !== undefined) {
        existing.setLngLat(lngLat);
        fillMarkerElement(existing.getElement(), content);
        stampMarkerPoint(existing.getElement(), lngLat);
        continue;
      }

      const element = createMarkerElement();
      fillMarkerElement(element, content);
      stampMarkerPoint(element, lngLat);
      element.dataset['orderId'] = point.orderId;
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        selectRef.current(point.orderId);
      });

      markers.set(point.orderId, new Marker({ element }).setLngLat(lngLat).addTo(map));
    }

    for (const [orderId, marker] of markers) {
      if (!seen.has(orderId)) {
        marker.remove();
        markers.delete(orderId);
      }
    }
  }, [points, selectedOrderId, mapReady, labelOf]);

  /*
   * Линия маршрута.
   *
   * Отдельный источник и отдельный слой: линия обновляется на месте, а не
   * пересоздаётся вместе с картой — иначе каждое сохранение порядка сбрасывало
   * бы масштаб и положение, и логист терял бы то место, куда только что смотрел.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !mapReady) {
      return;
    }

    const data = {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: (line ?? []).map((point) => [...point]),
      },
    };

    /*
     * Линия не имеет права уронить карту.
     *
     * Слой добавляется в живой стиль, и любая неожиданность здесь — от
     * повторного добавления до незагруженного стиля — раньше выбрасывала бы
     * исключение прямо в отрисовку и убирала бы карту с экрана целиком.
     * Ручная работа при этом не должна прекращаться (`ROUTE-003`): без линии
     * логист работает, без карты — нет.
     */
    const draw = (): void => {
      try {
        const existing = map.getSource('route-line') as unknown as
          { setData: (value: unknown) => void } | undefined;
        if (existing === undefined || existing === null) {
          map.addSource('route-line', { type: 'geojson', data });
          (map as unknown as { __routeLine?: unknown }).__routeLine = data.geometry.coordinates;
          map.addLayer({
            id: 'route-line',
            type: 'line',
            source: 'route-line',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#4f6ef7', 'line-width': 5, 'line-opacity': 0.85 },
          });
          return;
        }
        existing.setData(data);
        /*
         * Что именно нарисовано — записывается на самой карте.
         *
         * Отрисованные объекты видит только тот, кто попал в кадр, а описание
         * источника возвращает данные его создания. Проверке нужен факт: вот
         * линия, которую слой получил последней.
         */
        (map as unknown as { __routeLine?: unknown }).__routeLine = data.geometry.coordinates;
      } catch {
        // Молча: причина отсутствия линии приходит с сервера и называется
        // словами в панели, а не догадкой браузера.
      }
    };

    /*
     * Слой добавляется только в ЗАГРУЖЕННЫЙ стиль.
     *
     * Карта считается доступной сразу после создания — маркеры стилю не нужны.
     * Источник и слой нужны: в незагруженный стиль они не встают, и одна
     * неудачная попытка раньше означала, что линии не будет уже никогда —
     * зависимости эффекта больше не менялись. Поэтому неудача не проглатывается,
     * а откладывается до готовности стиля.
     */
    if (map.isStyleLoaded()) {
      draw();
      return;
    }

    map.on('styledata', draw);
    map.on('load', draw);
    return () => {
      map.off('styledata', draw);
      map.off('load', draw);
    };
  }, [line, mapReady]);

  /*
   * Отметка склада.
   *
   * Форма и цвет отличаются от заказов: склад — не остановка, кликом он ничего
   * не выбирает. Отсутствие подтверждённой точки означает отсутствие отметки,
   * а не нулевые координаты.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !mapReady) {
      return;
    }

    if (depot === null) {
      depotMarkerRef.current?.remove();
      depotMarkerRef.current = null;
      return;
    }

    if (depotMarkerRef.current === null) {
      const element = document.createElement('div');
      element.className = `${MARKER_CLASS} ${MARKER_CLASS}--depot`;
      const dot = document.createElement('span');
      dot.className = `${MARKER_CLASS}__dot`;
      element.append(dot);
      element.dataset['testid'] = 'map-depot';
      depotMarkerRef.current = new Marker({ element }).setLngLat([depot.lng, depot.lat]).addTo(map);
    } else {
      depotMarkerRef.current.setLngLat([depot.lng, depot.lat]);
    }
    depotMarkerRef.current.getElement().setAttribute('aria-label', `Склад: ${depot.name}`);
    depotMarkerRef.current.getElement().title = `Склад: ${depot.name}`;
  }, [depot, mapReady]);

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
