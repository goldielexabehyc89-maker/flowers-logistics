/**
 * Карта рабочего места черновиков.
 *
 * Показывает активный черновик: остановки подписаны позициями, и нумерация
 * совпадает со списком слева. Отдельным переключателем поднимаются
 * нераспределённые сделки дня — те, у которых есть пригодная точка.
 *
 * Нажатие на точку открывает данные заказа и позволяет переложить его
 * в другой черновик. Это тот же серверный контракт, что и в списке: перенос
 * выполняется одной атомарной операцией, а не парой «убрать и добавить».
 *
 * Линии маршрута здесь нет намеренно. Настоящей дорожной геометрии система
 * не считает, а прямая между точками читалась бы как рассчитанный путь
 * и как обещание времени, которого никто не давал.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  TextInput,
} from '../../ui/components';
import { describeMap, trafficNote, type MapConfig, type MapPointsResponse } from './geo';
import { pointAction, pointLabel, transferTargets, visiblePoints } from './draft-map';
import { withRouteLease } from './lease-scope';
import { conflictMessage, type RouteCardView, type RouteListItem } from './routing';

const OrdersMap = lazy(() =>
  import('./OrdersMap').then((module) => ({ default: module.OrdersMap })),
);

export interface DraftMapPanelProps {
  deliveryDate: string;
  activeRouteId: string | null;
  drafts: readonly RouteListItem[];
}

/** Ответ контракта геометрии: линия пути, склад и остановки по порядку. */
interface RouteGeometryResponse {
  depot: { name: string; lng: number; lat: number } | null;
  stops: { orderId: string; number: string; position: number }[];
  line: [number, number][];
  timeSeconds: number | null;
  distanceMeters: number | null;
  unavailableReason: string | null;
}

export function DraftMapPanel({
  deliveryDate,
  activeRouteId,
  drafts,
}: DraftMapPanelProps): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [showUnassigned, setShowUnassigned] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [targetRouteId, setTargetRouteId] = useState('');
  const [targetQuery, setTargetQuery] = useState('');
  const [basemapFailed, setBasemapFailed] = useState(false);

  const config = useQuery({
    queryKey: ['map-config'],
    queryFn: () => client.get<MapConfig>('/api/map/config'),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const status = describeMap(config.data);

  const points = useQuery({
    queryKey: ['map-points', deliveryDate],
    queryFn: () => client.get<MapPointsResponse>(`/api/orders/map?deliveryDate=${deliveryDate}`),
    enabled: status.ready,
  });

  const allPoints = useMemo(() => points.data?.points ?? [], [points.data]);

  /*
   * Фактическая геометрия активного маршрута.
   *
   * Считает собственная Valhalla на сервере. Запрос идёт только для раскрытого
   * черновика: линия нужна там, где логист сейчас работает, а не для всех
   * черновиков дня сразу. После сохранения нового порядка ключ запроса
   * не меняется — линию пересчитывает явное обновление в списке.
   */
  const geometry = useQuery({
    queryKey: ['route-geometry', activeRouteId],
    queryFn: () => client.get<RouteGeometryResponse>(`/api/routes/${activeRouteId}/geometry`),
    enabled: activeRouteId !== null && status.ready,
  });

  const visible = useMemo(
    () => visiblePoints(allPoints, { activeRouteId, showUnassigned }),
    [allPoints, activeRouteId, showUnassigned],
  );

  const selected = visible.find((point) => point.orderId === selectedOrderId) ?? null;

  // Подпись стабильна между рендерами: иначе маркеры пересобирались бы
  // на каждом обновлении списка и карта дёргалась бы.
  const labelOf = useCallback(pointLabel, []);

  const refreshAll = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['routes'] });
    void queryClient.invalidateQueries({ queryKey: ['route'] });
    void queryClient.invalidateQueries({ queryKey: ['map-points'] });
  };

  const failure = (error: unknown): void => {
    const kind = error instanceof ApiError ? (error.conflict?.kind ?? undefined) : undefined;
    showToast(
      error instanceof ApiError
        ? conflictMessage(kind, error.message)
        : 'Не удалось выполнить операцию. Повторите попытку.',
      'error',
    );
    refreshAll();
  };

  const lease = useMemo(
    () => ({
      acquire: (routeId: string) =>
        client.post<{ granted: boolean }>(`/api/routes/${routeId}/edit-lock/acquire`, {}),
      release: async (routeId: string) => {
        await client.post(`/api/routes/${routeId}/edit-lock/release`, {});
      },
    }),
    [client],
  );

  /**
   * Перенос остановки в другой черновик.
   *
   * Аренда берётся на оба маршрута: сервер требует её и у источника, и
   * у цели. Освобождается только то, что взял этот вызов — аренду источника
   * обычно уже держит раскрытая карточка, и снять её значило бы отдать
   * черновик другому редактору посреди правки.
   */
  const moveOrder = useMutation({
    mutationFn: (input: { orderId: string; fromRouteId: string; toRouteId: string }) =>
      withRouteLease(lease, input.fromRouteId, () =>
        withRouteLease(lease, input.toRouteId, async () => {
          const [source, target] = await Promise.all([
            client.get<RouteCardView>(`/api/routes/${input.fromRouteId}`),
            client.get<RouteCardView>(`/api/routes/${input.toRouteId}`),
          ]);
          await client.post('/api/routes/move', {
            fromRouteId: input.fromRouteId,
            toRouteId: input.toRouteId,
            orderIds: [input.orderId],
            expectedSourceVersion: source.version,
            expectedTargetVersion: target.version,
          });
        }),
      ),
    onSuccess: () => {
      setSelectedOrderId(null);
      setTargetRouteId('');
      showToast('Заказ перенесён в другой черновик', 'success');
      refreshAll();
    },
    onError: failure,
  });

  /** Назначение нераспределённой сделки в черновик. */
  const assignOrder = useMutation({
    mutationFn: (input: { orderId: string; toRouteId: string }) =>
      withRouteLease(lease, input.toRouteId, async () => {
        const target = await client.get<RouteCardView>(`/api/routes/${input.toRouteId}`);
        await client.post(`/api/routes/${input.toRouteId}/orders`, {
          orderIds: [input.orderId],
          expectedVersion: target.version,
        });
      }),
    onSuccess: () => {
      setSelectedOrderId(null);
      setTargetRouteId('');
      showToast('Заказ добавлен в черновик', 'success');
      refreshAll();
    },
    onError: failure,
  });

  if (!status.ready) {
    return (
      <section className="routes__panel routes__map-panel">
        <header className="routes__panel-header">
          <h3>Карта</h3>
        </header>
        <EmptyState title="Карта не настроена" description={status.message ?? ''} />
      </section>
    );
  }

  const traffic = trafficNote(config.data);
  const busy = moveOrder.isPending || assignOrder.isPending;
  const action = selected === null ? null : pointAction(selected);
  const targets = transferTargets(drafts, selected?.routeId ?? null);

  /*
   * Обычное вычисление, а не хук.
   *
   * Эта часть кода живёт ПОСЛЕ раннего возврата «карта не настроена», и хук
   * здесь означал бы разное число хуков на разных рендерах — React снимает
   * такое приложение целиком. Список целей короткий, считать его каждый раз
   * дешевле любой памятки.
   */
  const query = targetQuery.trim().toLocaleLowerCase('ru');
  const matchingTargets = targets.filter((draft) =>
    draft.number.toLocaleLowerCase('ru').includes(query),
  );

  return (
    <section className="routes__panel routes__map-panel">
      <header className="routes__panel-header">
        <h3>Карта</h3>
        <span
          className="muted text-sm"
          data-testid="route-line-points"
          data-points={String(geometry.data?.line.length ?? -1)}
        >
          {activeRouteId === null ? 'черновик не раскрыт' : `точек: ${visible.length}`}
          {geometry.data?.unavailableReason !== undefined &&
            geometry.data.unavailableReason !== null && (
              <span className="routes__map-note" data-testid="route-line-missing">
                {' · '}
                {geometry.data.unavailableReason}
              </span>
            )}
        </span>
      </header>

      <div className="routes__map-controls">
        <label className="routes__toggle">
          <input
            type="checkbox"
            checked={showUnassigned}
            data-testid="map-unassigned-toggle"
            onChange={(event) => {
              setShowUnassigned(event.target.checked);
              setSelectedOrderId(null);
            }}
          />
          Показать нераспределённые сделки дня
        </label>
      </div>

      {basemapFailed ? (
        <ErrorState
          title="Подложка карты не загрузилась"
          description="Черновики и их состав работают как обычно. Внешние карты не используются намеренно."
          onRetry={() => {
            setBasemapFailed(false);
            void config.refetch();
          }}
        />
      ) : points.isPending ? (
        <LoadingState title="Загружаем точки…" />
      ) : points.isError ? (
        <ErrorState title="Не удалось загрузить точки" onRetry={() => void points.refetch()} />
      ) : (
        <Suspense fallback={<LoadingState title="Готовим карту…" />}>
          <OrdersMap
            styleUrl={config.data?.styleUrl ?? ''}
            attribution={config.data?.attribution ?? null}
            points={visible}
            selectedOrderId={selectedOrderId}
            onSelect={(orderId) => {
              setSelectedOrderId(orderId);
              setTargetRouteId('');
            }}
            picking={false}
            onPick={() => undefined}
            labelOf={labelOf}
            line={geometry.data?.line ?? []}
            depot={
              geometry.data?.depot === undefined || geometry.data.depot === null
                ? null
                : geometry.data.depot
            }
            onLoadError={() => setBasemapFailed(true)}
          />
        </Suspense>
      )}

      {activeRouteId === null && !showUnassigned && (
        <p className="muted text-sm">
          Раскройте черновик слева, чтобы увидеть его остановки, либо включите нераспределённые
          сделки.
        </p>
      )}

      {/*
        Данные точки и перенос.

        Показываются номер и адрес, а не идентификатор: по обрезанному UUID
        проверить, тот ли это заказ, невозможно.
      */}
      {selected !== null && action !== null && (
        <div className="routes__map-selection" data-testid="map-selection">
          <div className="stack">
            <strong>{selected.number}</strong>
            <span className="muted text-sm">
              {selected.routeNumber === null
                ? 'Нераспределённая сделка'
                : `${selected.routeNumber} · остановка ${selected.position ?? '—'}`}
            </span>
          </div>

          {/*
            Цель выбирается поиском по номеру, а не набором отдельных кнопок:
            в дне бывает два десятка черновиков и листов, и ряд кнопок
            превращается в лотерею.
          */}
          <Field
            label={action.kind === 'ASSIGN' ? 'Назначить в черновик' : 'Перенести в черновик'}
            hint="Поиск по номеру"
          >
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                value={targetQuery}
                placeholder="Например, 3661"
                disabled={busy}
                data-testid="map-transfer-search"
                onChange={(event) => {
                  setTargetQuery(event.target.value);
                  setTargetRouteId('');
                }}
              />
            )}
          </Field>

          <ul className="routes__targets" data-testid="map-transfer-list">
            {matchingTargets.length === 0 ? (
              <li className="muted">Подходящих черновиков нет</li>
            ) : (
              matchingTargets.map((draft) => (
                <li key={draft.id}>
                  <button
                    type="button"
                    className={
                      draft.id === targetRouteId
                        ? 'deals__link routes__target--picked'
                        : 'deals__link'
                    }
                    data-testid="map-transfer-option"
                    onClick={() => {
                      setTargetRouteId(draft.id);
                      setTargetQuery(draft.number);
                    }}
                  >
                    {draft.number} · заказов: {draft.orderCount}
                  </button>
                </li>
              ))
            )}
          </ul>

          <div className="routes__actions">
            <Button
              variant="primary"
              data-testid="map-transfer"
              disabled={busy || targetRouteId === ''}
              onClick={() => {
                if (action.kind === 'ASSIGN') {
                  assignOrder.mutate({ orderId: action.orderId, toRouteId: targetRouteId });
                  return;
                }
                moveOrder.mutate({
                  orderId: action.orderId,
                  fromRouteId: action.fromRouteId,
                  toRouteId: targetRouteId,
                });
              }}
            >
              {action.kind === 'ASSIGN' ? 'Назначить' : 'Перенести'}
            </Button>
            <Button onClick={() => setSelectedOrderId(null)}>Снять выбор</Button>
          </div>
        </div>
      )}

      {traffic !== null && (
        <p className="muted text-sm" data-testid="traffic-note">
          {traffic}
        </p>
      )}
    </section>
  );
}
