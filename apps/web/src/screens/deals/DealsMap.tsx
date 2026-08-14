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

import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ErrorState, LoadingState } from '../../ui/components';
import type { MapConfig } from '../routing/geo';
import { formatMinutes } from './deals';
import { selectionNumber } from './selection';

/**
 * Карта грузится отдельным куском: MapLibre и разбор тайлов — сотни килобайт,
 * и остальным экранам они не нужны.
 */
const DealsMapCanvas = lazy(() =>
  import('./DealsMapCanvas').then((module) => ({ default: module.DealsMapCanvas })),
);

export interface DealPoint {
  orderId: string;
  number: string;
  lat: string;
  lon: string;
  startMinute: number | null;
  endMinute: number | null;
  needsAttention: boolean;
}

interface MapResponse {
  points: DealPoint[];
  deliveryDate: string;
}

interface DealsMapProps {
  scopeKey: string;
  selected: readonly string[];
  onToggle: (orderId: string) => void;
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
export type MarkerState = 'DEPOT' | 'FREE' | 'PICKED' | 'DRAFT';

export interface MarkerLook {
  color: string;
  shape: 'diamond' | 'circle' | 'square' | 'triangle';
}

export const MARKER_LOOKS: Record<MarkerState, MarkerLook> = {
  DEPOT: { color: '#333', shape: 'diamond' },
  FREE: { color: '#6b7280', shape: 'circle' },
  PICKED: { color: 'hsl(210 70% 45%)', shape: 'square' },
  DRAFT: { color: '#9ca3af', shape: 'triangle' },
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
  const [basemapFailed, setBasemapFailed] = useState(false);

  const query = useQuery({
    queryKey: ['deals-map', scopeKey],
    queryFn: () => client.get<MapResponse>(`/api/deals/map?${scopeKey}`),
  });

  // Подложка своя: адрес стиля приходит из нашей конфигурации, публичные тайлы
  // не используются.
  const config = useQuery({
    queryKey: ['map-config'],
    queryFn: () => client.get<MapConfig>('/api/map/config'),
    staleTime: 5 * 60 * 1000,
  });

  const points = useMemo(() => query.data?.points ?? [], [query.data]);

  const { chosen, clusters } = splitForMap(points, selected, zoomedOut);

  // Номер выбранного заказа подписью на отметке. Пусто — заказ не выбран.
  const numberOf = useCallback(
    (orderId: string): string | null => {
      const number = selectionNumber(selected, orderId);
      return number === null ? null : String(number);
    },
    [selected],
  );

  if (query.isPending) {
    return <LoadingState title="Загружаем карту…" />;
  }
  if (query.isError) {
    return <ErrorState title="Не удалось загрузить карту" onRetry={() => void query.refetch()} />;
  }

  const styleUrl = config.data?.styleUrl ?? '';
  const empty = points.length === 0;

  return (
    <section className="deals-map" data-testid="deals-map">
      <div className="deals-map__head">
        <span>На карте: {points.length}</span>
        <button
          type="button"
          className="deals__link"
          data-testid="deals-map-zoom"
          // Приближать нечего, пока точек нет: кнопка не должна обещать
          // действие, которое ничего не изменит.
          disabled={empty}
          onClick={() => setZoomedOut((value) => !value)}
        >
          {zoomedOut ? 'Приблизить' : 'Отдалить'}
        </button>
      </div>

      {/*
        Постоянная легенда: без неё цвет и форма ничего не значат. Состояния
        различаются и цветом, и формой — одного цвета мало тому, кто его
        не различает.
      */}
      <ul className="deals-map__legend" data-testid="deals-map-legend">
        <li>
          <span className="deals-map__dot deals-map__dot--depot" /> склад
        </li>
        <li>
          <span className="deals-map__dot deals-map__dot--free" /> доступен
        </li>
        <li>
          <span className="deals-map__dot deals-map__dot--picked" /> выбран, с номером
        </li>
        <li>
          <span className="deals-map__dot deals-map__dot--draft" /> в черновике, только чтение
        </li>
      </ul>

      {/*
        Карта показывается ВСЕГДА, даже когда точек ноль. Пустой день — обычное
        дело, и подложка Москвы в этот момент нужна не меньше: логист видит,
        где он работает, а не серый прямоугольник. Сообщение об отсутствии
        координат лежит поверх карты и её не заменяет.
      */}
      <div className="deals-map__surface">
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
              numberOf={numberOf}
              onToggle={onToggle}
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

      {points.length === 0 ? null : (
        <ul className="deals-map__points">
          {chosen.map((point) => (
            <li key={point.orderId} data-testid="map-point" data-order-number={point.number}>
              <button
                type="button"
                className="deals-map__marker deals-map__marker--picked"
                onClick={() => onToggle(point.orderId)}
              >
                {selectionNumber(selected, point.orderId)}
              </button>
              <span>
                {point.number} · {formatMinutes(point.startMinute)}–{formatMinutes(point.endMinute)}
              </span>
            </li>
          ))}

          {clusters.map((cluster) =>
            cluster.points.length === 1 ? (
              <li
                key={cluster.key}
                data-testid="map-point"
                data-order-number={cluster.points[0]?.number}
              >
                <button
                  type="button"
                  className="deals-map__marker deals-map__marker--free"
                  onClick={() => onToggle(cluster.points[0]?.orderId ?? '')}
                >
                  •
                </button>
                <span>
                  {cluster.points[0]?.number} ·{' '}
                  {formatMinutes(cluster.points[0]?.startMinute ?? null)}–
                  {formatMinutes(cluster.points[0]?.endMinute ?? null)}
                </span>
              </li>
            ) : (
              <li key={cluster.key} data-testid="map-cluster">
                <span className="deals-map__marker deals-map__marker--cluster">
                  {cluster.points.length}
                </span>
                <span>рядом заказов: {cluster.points.length}</span>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
