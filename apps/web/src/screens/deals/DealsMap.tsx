/**
 * Карта «Сделок».
 *
 * Показывает ровно то же множество, что и список: точки приходят тем же
 * серверным отбором, только с координатами. Догадок по строке адреса здесь нет
 * вовсе — на карту попадает лишь подтверждённая точка, потому что придуманная
 * координата выглядит как настоящая и отправит курьера не туда.
 *
 * Выбор общий со списком: клик по маркеру меняет тот же самый набор.
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ErrorState, LoadingState } from '../../ui/components';
import type { MapConfig } from '../routing/geo';
import {
  depotAbsenceReason,
  depotMarkerOf,
  visiblePoints,
  type DepotView,
  type MapPoint,
  type TimeWindow,
} from './deals-view';
import { parseTimeFilter, selectionNumber } from './selection';

/**
 * Карта грузится отдельным куском: MapLibre и разбор тайлов — сотни килобайт,
 * и остальным экранам они не нужны.
 */
const DealsMapCanvas = lazy(() =>
  import('./DealsMapCanvas').then((module) => ({ default: module.DealsMapCanvas })),
);

export type DealPoint = MapPoint;

interface MapResponse {
  points: DealPoint[];
  deliveryDate: string;
}

interface DealsMapProps {
  scopeKey: string;
  selected: readonly string[];
  /** Отдаёт саму точку: пригодность берётся из неё, а не из списка. */
  onToggle: (point: MapPoint) => void;
}

/**
 * Порог кластеризации в градусах.
 *
 * Близкие невыбранные точки на дальнем масштабе сливаются в одну отметку
 * с количеством: два десятка маркеров на одном доме нечитаемы. Выбранные
 * в кластер не попадают никогда — их номер обязан оставаться видимым.
 */
const CLUSTER_STEP = 0.01;

export interface Cluster {
  key: string;
  points: DealPoint[];
}

export function clusterize(points: readonly DealPoint[]): Cluster[] {
  const buckets = new Map<string, DealPoint[]>();
  for (const point of points) {
    const key = `${Math.round(Number(point.lat) / CLUSTER_STEP)}:${Math.round(
      Number(point.lon) / CLUSTER_STEP,
    )}`;
    buckets.set(key, [...(buckets.get(key) ?? []), point]);
  }
  return [...buckets.entries()].map(([key, items]) => ({ key, points: items }));
}

/**
 * Состояние маркера.
 *
 * Различается и цветом, и формой: одного цвета мало тому, кто его не различает,
 * а маркер без различий превращает карту в набор одинаковых точек.
 */
export type MarkerState = 'FREE' | 'PICKED' | 'DRAFT' | 'ASSEMBLED';

export interface MarkerLook {
  color: string;
  shape: 'circle' | 'number' | 'ring' | 'check';
}

/**
 * Склада среди состояний нет: на этой карте отметки склада не существует,
 * а легенда, называющая то, чего не показывают, хуже отсутствующей.
 */
export const MARKER_LOOKS: Record<MarkerState, MarkerLook> = {
  FREE: { color: '#6b7280', shape: 'circle' },
  PICKED: { color: 'hsl(210 70% 45%)', shape: 'number' },
  DRAFT: { color: '#9ca3af', shape: 'ring' },
  ASSEMBLED: { color: 'hsl(150 55% 32%)', shape: 'check' },
};

/**
 * Разделяет точки на выбранные и кластеризуемые.
 *
 * Выбранная точка в кластер не попадает никогда: её номер — часть маршрута,
 * который человек уже спланировал, и прятать его в безымянную группу нельзя.
 */
export function splitForMap(
  points: readonly DealPoint[],
  selected: readonly string[],
  zoomedOut: boolean,
): { chosen: DealPoint[]; clusters: Cluster[] } {
  const selectedSet = new Set(selected);
  const chosen = points.filter((point) => selectedSet.has(point.orderId));
  const rest = points.filter((point) => !selectedSet.has(point.orderId));
  return {
    chosen,
    clusters: zoomedOut
      ? clusterize(rest)
      : rest.map((point) => ({ key: point.orderId, points: [point] })),
  };
}

export function DealsMap({ scopeKey, selected, onToggle }: DealsMapProps): React.JSX.Element {
  const { client } = useAuth();
  const [zoomedOut, setZoomedOut] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [basemapFailed, setBasemapFailed] = useState(false);

  const query = useQuery({
    queryKey: ['deals-map', scopeKey],
    queryFn: () => client.get<MapResponse>(`/api/deals/map?${scopeKey}`),
    // Смена фильтра меняет ключ запроса, то есть создаёт НОВЫЙ запрос без
    // данных. Без этого карта на время загрузки размонтировалась бы целиком
    // и создавалась заново — логист видел бы моргание вместо обновления.
    placeholderData: keepPreviousData,
  });

  /*
   * Основной склад.
   *
   * Маршрут начинается со склада, поэтому логист обязан видеть его на той же
   * карте, что и заказы. Запрос отдельный и редкий: склады меняются гораздо
   * реже, чем заказы дня.
   */
  const depots = useQuery({
    queryKey: ['depots'],
    queryFn: () => client.get<{ items: DepotView[] }>('/api/depots'),
    staleTime: 60 * 1000,
  });

  // Подложка своя: адрес стиля приходит из нашей конфигурации, публичные тайлы
  // не используются.
  const config = useQuery({
    queryKey: ['map-config'],
    queryFn: () => client.get<MapConfig>('/api/map/config'),
    staleTime: 5 * 60 * 1000,
  });

  /*
   * Последние успешно полученные данные.
   *
   * `keepPreviousData` держит прежний ответ, пока новый ЗАГРУЖАЕТСЯ, но если
   * повторный запрос УПАЛ, данных у запроса не остаётся. Карта из-за временной
   * ошибки исчезать не должна, поэтому последний удачный ответ помнится
   * отдельно и переживает любой отказ обновления.
   */
  const lastGood = useRef<MapResponse | null>(null);
  if (query.data !== undefined) {
    lastGood.current = query.data;
  }
  const shown = query.data ?? lastGood.current;

  // Адрес стиля запоминается так же: пропасть он может только вместе с картой.
  const lastStyleUrl = useRef('');
  const configuredStyleUrl = config.data?.styleUrl ?? '';
  if (configuredStyleUrl !== '') {
    lastStyleUrl.current = configuredStyleUrl;
  }

  const all = useMemo(() => shown?.points ?? [], [shown]);

  /*
   * Фильтр времени карты.
   *
   * Ограничивает ТОЛЬКО показанные отметки. Список заказов слева при этом
   * не меняется и не перезагружается: это отдельный, более узкий вопрос
   * «что я сейчас вижу на карте», а не смена рабочего отбора дня.
   */
  const fromMinute = parseTimeFilter(from);
  const toMinute = parseTimeFilter(to);
  const points = useMemo(
    () => visiblePoints(all, { fromMinute, toMinute } satisfies TimeWindow),
    [all, fromMinute, toMinute],
  );
  const hidden = all.length - points.length;

  const { chosen, clusters } = splitForMap(points, selected, zoomedOut);

  // Номер выбранного заказа подписью на отметке. Пусто — заказ не выбран.
  const numberOf = useCallback(
    (orderId: string): number | null => selectionNumber(selected, orderId),
    [selected],
  );

  // Состояние загрузки допустимо ТОЛЬКО до первых данных. Дальше карта
  // остаётся на месте при любом обновлении.
  if (shown === null && query.isPending) {
    return <LoadingState title="Загружаем карту…" />;
  }
  if (shown === null) {
    return <ErrorState title="Не удалось загрузить карту" onRetry={() => void query.refetch()} />;
  }

  const styleUrl = lastStyleUrl.current;
  const empty = points.length === 0;
  // Обновление идёт, но прежние точки показаны: это не загрузка, а уточнение.
  const refreshing = query.isFetching;
  // Обновление не удалось. Карта и прежние точки остаются: они всё ещё верны,
  // просто новее ничего не пришло.
  const refreshFailed = query.isError;

  return (
    <section className="deals-map" data-testid="deals-map">
      {depots.data !== undefined && depotAbsenceReason(depots.data.items) !== null && (
        <p className="deals-map__notice-line" role="status" data-testid="deals-map-no-depot">
          {depotAbsenceReason(depots.data.items)}: маршрут не с чего начинать. Координаты не
          угадываются.
        </p>
      )}

      {refreshFailed && (
        <p className="deals-map__refresh-error" role="status" data-testid="deals-map-refresh-error">
          Не удалось обновить точки. Показаны прежние.{' '}
          <button type="button" className="deals__link" onClick={() => void query.refetch()}>
            Повторить
          </button>
        </p>
      )}

      {/*
        Карта показывается ВСЕГДА, даже когда точек ноль. Пустой день — обычное
        дело, и подложка Москвы в этот момент нужна не меньше: логист видит,
        где он работает, а не серый прямоугольник. Сообщение об отсутствии
        координат лежит поверх карты и её не заменяет.
      */}
      <div className="deals-map__surface">
        {/*
          Управление картой лежит ПОВЕРХ холста.

          Отдельная полоса над картой отнимала у неё высоту и разрывала рабочую
          поверхность на разрозненные ряды. Карта — фон всей правой панели,
          а её контролы плавают над ней.
        */}
        {/*
          Управление картой двумя плавающими строками.

          Сверху — что показано: счётчик и легенда. Ниже — чем это менять:
          время и группировка. Обе строки лежат ПОВЕРХ холста и высоту у карты
          не отнимают.
        */}
        <div className="deals-map__overlay deals-map__overlay--top">
          <div className="deals-map__panel deals-map__panel--info">
            <span className="deals-map__head-count" data-testid="deals-map-head-count">
              На карте: {points.length}
              {hidden > 0 && <span className="deals-map__muted"> · скрыто фильтром: {hidden}</span>}
              {refreshing && (
                <span className="deals-map__refreshing" data-testid="deals-map-refreshing">
                  {' '}
                  Обновляем…
                </span>
              )}
            </span>
          </div>

          <ul className="deals-map__legend" data-testid="deals-map-legend">
            <li>
              <span className="deals-map__dot deals-map__dot--free" /> доступен
            </li>
            <li>
              <span className="deals-map__dot deals-map__dot--picked" /> выбран
            </li>
            <li>
              <span className="deals-map__dot deals-map__dot--draft" /> в черновике
            </li>
            <li>
              <span className="deals-map__dot deals-map__dot--assembled" /> собран
            </li>
            <li>
              <span className="deals-map__dot deals-map__dot--depot" /> склад
            </li>
          </ul>
        </div>

        <div className="deals-map__overlay deals-map__overlay--controls">
          <div className="deals-map__panel deals-map__panel--controls">
            {/*
          Счётчик и его пояснения занимают постоянное место: иначе поля времени
          и кнопка группировки прыгали бы при каждом фоновом обновлении.
        */}
            {/*
          Два простых поля времени. Ничего не пересчитывают и никуда
          не отправляются: только сужают то, что показано на карте.
        */}
            <label className="deals-map__time">
              От
              <input
                type="time"
                value={from}
                data-testid="deals-map-from"
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label className="deals-map__time">
              До
              <input
                type="time"
                value={to}
                data-testid="deals-map-to"
                onChange={(event) => setTo(event.target.value)}
              />
            </label>

            <button
              type="button"
              className="deals__link deals-map__zoom"
              data-testid="deals-map-zoom"
              // Разделять нечего, пока точек нет: кнопка не должна обещать
              // действие, которое ничего не изменит.
              disabled={empty}
              onClick={() => setZoomedOut((value) => !value)}
            >
              {zoomedOut ? 'Показать отдельно' : 'Сгруппировать'}
            </button>
          </div>

          {/*
        Постоянная легенда: без неё цвет и форма ничего не значат. Состояния
        различаются и цветом, и формой — одного цвета мало тому, кто его
        не различает.
      */}
        </div>

        {styleUrl === '' ? (
          <p className="deals-map__notice" role="status" data-testid="deals-map-notice">
            Карта не настроена
          </p>
        ) : basemapFailed ? (
          <p className="deals-map__notice" role="status" data-testid="deals-map-notice">
            Подложка карты не загрузилась. Список и выбор работают как обычно.
          </p>
        ) : (
          <Suspense fallback={<LoadingState title="Готовим карту…" />}>
            <DealsMapCanvas
              styleUrl={styleUrl}
              attribution={config.data?.attribution ?? null}
              chosen={chosen}
              clusters={clusters}
              depot={depotMarkerOf(depots.data?.items ?? [])}
              numberOf={numberOf}
              onToggle={(orderId) => {
                const point = points.find((item) => item.orderId === orderId);
                if (point !== undefined) {
                  onToggle(point);
                }
              }}
              onLoadError={() => setBasemapFailed(true)}
            />
          </Suspense>
        )}

        {empty && !basemapFailed && styleUrl !== '' && (
          <p className="deals-map__notice" role="status" data-testid="deals-map-empty">
            В выбранном дне нет заказов с координатами
          </p>
        )}
      </div>
    </section>
  );
}
