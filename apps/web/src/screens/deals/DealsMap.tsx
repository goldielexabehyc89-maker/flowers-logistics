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
import { useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { EmptyState, ErrorState, LoadingState } from '../../ui/components';
import { formatMinutes } from './deals';
import { selectionNumber } from './selection';

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

interface Cluster {
  key: string;
  points: DealPoint[];
}

function clusterize(points: readonly DealPoint[]): Cluster[] {
  const buckets = new Map<string, DealPoint[]>();
  for (const point of points) {
    const key = `${Math.round(Number(point.lat) / CLUSTER_STEP)}:${Math.round(
      Number(point.lon) / CLUSTER_STEP,
    )}`;
    buckets.set(key, [...(buckets.get(key) ?? []), point]);
  }
  return [...buckets.entries()].map(([key, items]) => ({ key, points: items }));
}

export function DealsMap({ scopeKey, selected, onToggle }: DealsMapProps): React.JSX.Element {
  const { client } = useAuth();
  const [zoomedOut, setZoomedOut] = useState(true);

  const query = useQuery({
    queryKey: ['deals-map', scopeKey],
    queryFn: () => client.get<MapResponse>(`/api/deals/map?${scopeKey}`),
  });

  const points = useMemo(() => query.data?.points ?? [], [query.data]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const unselected = points.filter((point) => !selectedSet.has(point.orderId));
  const chosen = points.filter((point) => selectedSet.has(point.orderId));
  const clusters = zoomedOut
    ? clusterize(unselected)
    : unselected.map((point) => ({
        key: point.orderId,
        points: [point],
      }));

  if (query.isPending) {
    return <LoadingState title="Загружаем карту…" />;
  }
  if (query.isError) {
    return <ErrorState title="Не удалось загрузить карту" onRetry={() => void query.refetch()} />;
  }

  return (
    <section className="deals-map" data-testid="deals-map">
      <div className="deals-map__head">
        <span>На карте: {points.length}</span>
        <button
          type="button"
          className="deals__link"
          data-testid="deals-map-zoom"
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

      {points.length === 0 ? (
        <EmptyState title="Точек на карте нет" />
      ) : (
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
