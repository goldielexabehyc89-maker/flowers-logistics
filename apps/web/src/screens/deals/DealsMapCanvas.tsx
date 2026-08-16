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
import { formatMinutes } from './deals';
import { markerHint, markerInterval, markerLabel, type MapPoint } from './deals-view';

/** Точка дня. Совпадает с ответом `/api/deals/map`. */
export type DealMapPoint = MapPoint;

/** Подтверждённая точка основного склада. Маршрут начинается отсюда. */
export interface DepotPoint {
  name: string;
  lat: string;
  lon: string;
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
  /** Основной склад. `null` — склада или его точки нет, и выдумывать её нельзя. */
  depot: DepotPoint | null;
  /** Номер заказа в выборке. Пусто — заказ не выбран. */
  numberOf: (orderId: string) => number | null;
  onToggle: (orderId: string) => void;
  /** Подложка не загрузилась: экран обязан сказать это, а не молчать. */
  onLoadError: () => void;
}

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
  /** Что написано в кружке. Пусто — невыбранный заказ без признаков. */
  label: string;
  /** Подпись над кружком. Показана всегда: по времени логист и группирует день. */
  interval: string;
  /** Подсказка при наведении: номер и адрес — то, чего на самой отметке нет. */
  hint: string;
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
  numberOf: (orderId: string) => number | null,
  depot: DepotPoint | null = null,
): MarkerPlan[] {
  const plans: MarkerPlan[] = [];

  // Склад показывается всегда и отдельной формой: это не заказ, кликом
  // он ничего не выбирает. Отсутствие склада или его точки — честное
  // отсутствие отметки, а не догаданная координата.
  if (depot !== null) {
    const lngLat = toLngLat({ lat: depot.lat, lon: depot.lon } as DealMapPoint);
    if (lngLat !== null) {
      plans.push({
        key: 'depot',
        lngLat,
        label: '',
        interval: '',
        hint: `Склад · ${depot.name}`,
        className: 'deals-marker deals-marker--depot',
        ariaLabel: `Основной склад: ${depot.name}`,
        orderId: null,
      });
    }
  }

  for (const point of chosen) {
    const lngLat = toLngLat(point);
    if (lngLat === null) {
      continue;
    }
    const selection = numberOf(point.orderId);
    plans.push({
      key: point.orderId,
      lngLat,
      label: markerLabel(selection),
      interval: markerInterval(point, formatMinutes),
      hint: markerHint(point),
      className: `deals-marker deals-marker--picked${point.assembled ? ' deals-marker--assembled' : ''}`,
      ariaLabel: `Заказ ${point.number} выбран, номер ${selection ?? ''}`,
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
      // Невыбранный заказ — простой круг без номера: сотня номеров на карте
      // не читается и превращает её в текст. Номер и адрес показывает
      // подсказка при наведении, время — подпись над кружком.
      plans.push({
        key: first.orderId,
        lngLat,
        label: first.assembled ? '✓' : '',
        interval: markerInterval(first, formatMinutes),
        hint: markerHint(first),
        className: [
          'deals-marker',
          first.selectable ? 'deals-marker--free' : 'deals-marker--draft',
          ...(first.assembled ? ['deals-marker--assembled'] : []),
        ].join(' '),
        ariaLabel: `${markerHint(first)}${first.assembled ? ', собран' : ''}`,
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
      interval: '',
      hint: `Здесь ${cluster.points.length} заказов`,
      className: 'deals-marker deals-marker--cluster',
      ariaLabel: `Здесь ${cluster.points.length} заказов`,
      orderId: null,
    });
  }

  return plans;
}

/**
 * Содержимое отметки.
 *
 * Кружок и подпись времени — разные узлы: подпись обязана оставаться читаемой
 * и не растягивать сам кружок.
 */
function fillMarker(element: HTMLElement, plan: MarkerPlan): void {
  /*
   * Свои классы заменяются, чужие остаются.
   *
   * Раньше здесь стояло `element.className = plan.className`, и обновление
   * отметки стирало класс `maplibregl-marker`, который ставит сама библиотека.
   * Вместе с ним элемент терял `position: absolute` и вставал в обычный поток:
   * отметка съезжала относительно подложки на десятки пикселей, хотя её
   * координата не менялась ни разу. Происходило это при КАЖДОМ обновлении
   * данных, поэтому заказ «переезжал» сам собой.
   */
  for (const existing of Array.from(element.classList)) {
    if (existing.startsWith('deals-marker')) {
      element.classList.remove(existing);
    }
  }
  for (const own of plan.className.split(' ')) {
    if (own !== '') {
      element.classList.add(own);
    }
  }
  element.setAttribute('aria-label', plan.ariaLabel);
  /*
   * Координата доменного объекта — прямо в разметке.
   *
   * Она и есть место заказа. Проверка сверяет с ней экранное положение
   * кружка после каждого масштабирования и сдвига: если когда-нибудь отметку
   * начнут двигать пикселями, расхождение станет видно сразу.
   */
  element.dataset['lng'] = String(plan.lngLat[0]);
  element.dataset['lat'] = String(plan.lngLat[1]);

  const time = element.querySelector('.deals-marker__time');
  const dot = element.querySelector('.deals-marker__dot');
  const hint = element.querySelector('.deals-marker__hint');
  if (time !== null) {
    time.textContent = plan.interval;
  }
  if (dot !== null) {
    dot.textContent = plan.label;
  }
  // Подсказка своя, а не нативный `title`: тот появляется через секунду
  // с лишним, и логист успевает решить, что подсказки нет вовсе.
  if (hint !== null) {
    hint.textContent = plan.hint;
  }
}

export function DealsMapCanvas({
  styleUrl,
  attribution,
  chosen,
  clusters,
  depot,
  numberOf,
  onToggle,
  onLoadError,
}: DealsMapCanvasProps): React.JSX.Element {
  const [mapReady, setMapReady] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

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

      /*
       * Отказом считается ТОЛЬКО то, что карта так и не поднялась.
       *
       * Раньше панель отказа показывалась по первой же ошибке MapLibre до
       * события `load`. Но библиотека шлёт `error` и по мелочам: отсутствующий
       * глиф, оборванный запрос тайла, пустая клетка набора. На большом экране
       * такая мелочь находится почти всегда, и логист видел «подложка
       * не загрузилась» там, где карта работала.
       *
       * Настоящий отказ при этом никуда не делся: сломанная подложка события
       * `load` не даёт, и через отведённое время экран честно об этом скажет.
       */
      const loadTimer = globalThis.setTimeout(() => {
        if (!cancelled) {
          loadErrorRef.current();
        }
      }, BASEMAP_LOAD_TIMEOUT_MS);
      const markLoaded = (): void => {
        globalThis.clearTimeout(loadTimer);
        if (!cancelled) {
          setMapReady(true);
        }
      };
      map.once('load', markLoaded);
      // `idle` означает, что карта отрисовала всё, что могла: содержимое
      // на экране есть, даже если какой-то тайл так и не пришёл.
      map.once('idle', markLoaded);
      mapRef.current = map;
      /*
       * Ссылка на карту для браузерной проверки географической привязки.
       *
       * Проверке нужно спросить у самой MapLibre, куда проецируется координата
       * заказа, — иначе «совпадает с проекцией» пришлось бы считать вручную
       * той же формулой, что и в коде, и ошибка совпала бы с ошибкой.
       */
      (globalThis as { __dealsMap?: MapLibreMap }).__dealsMap = map;

      /*
       * Карта обязана знать свой настоящий размер.
       *
       * MapLibre следит за окном, но не за контейнером: любая перестройка
       * раскладки — появившаяся строка сообщения, изменившаяся шапка, свёрнутое
       * меню — меняет высоту холста, а карта продолжает считать проекцию по
       * прежней. Отметки при этом смещаются относительно подложки: заказ
       * «переезжает» без единого изменения своей координаты. Наблюдатель за
       * контейнером закрывает это в корне, а не подгонкой пикселей.
       */
      const observer = new ResizeObserver(() => {
        map?.resize();
      });
      observer.observe(container);
      resizeObserverRef.current = observer;
    })();

    return () => {
      cancelled = true;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
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
    const plans = planMarkers(chosen, clusters, numberOf, depot);
    const seen = new Set<string>();

    for (const plan of plans) {
      seen.add(plan.key);

      const existing = markers.get(plan.key);
      if (existing !== undefined) {
        existing.setLngLat(plan.lngLat);
        fillMarker(existing.getElement(), plan);
        continue;
      }

      const element = document.createElement('button');
      element.type = 'button';
      const time = document.createElement('span');
      time.className = 'deals-marker__time';
      const dot = document.createElement('span');
      dot.className = 'deals-marker__dot';
      const hint = document.createElement('span');
      hint.className = 'deals-marker__hint';
      hint.setAttribute('role', 'tooltip');
      element.append(time, dot, hint);
      fillMarker(element, plan);
      element.dataset['testid'] = 'map-marker';
      if (plan.orderId !== null) {
        element.dataset['orderId'] = plan.orderId;
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
  }, [chosen, clusters, depot, numberOf, mapReady]);

  /*
   * Класс контейнера карты постоянен намеренно: MapLibre дописывает в него
   * собственный `maplibregl-map`, и очередной рендер React затёр бы чужой класс.
   */
  return <div className="deals-map__canvas" ref={containerRef} data-testid="deals-map-canvas" />;
}
