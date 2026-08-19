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
import { X } from 'lucide-react';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import { EmptyState, ErrorState, LoadingState, TextInput } from '../../ui/components';
import { describeMap, trafficNote, type MapConfig, type MapPointsResponse } from './geo';
import { pointAction, pointLabel, transferTargets, visiblePoints } from './draft-map';
import { withRouteLease } from './lease-scope';
import { conflictMessage, type RouteCardView, type RouteListItem } from './routing';

/** Со скольких целей ряд кнопок перестаёт читаться и появляется поиск. */
const SEARCH_FROM = 6;

const OrdersMap = lazy(() =>
  import('./OrdersMap').then((module) => ({ default: module.OrdersMap })),
);

export interface DraftMapPanelProps {
  deliveryDate: string;
  activeRouteId: string | null;
  drafts: readonly RouteListItem[];
  /** Список черновиков скрыт — карта занимает всю рабочую ширину. */
  draftsHidden: boolean;
  onToggleDrafts: () => void;
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
  draftsHidden,
  onToggleDrafts,
}: DraftMapPanelProps): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [showUnassigned, setShowUnassigned] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
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

  /*
   * Адрес выбранного заказа.
   *
   * В точках карты его нет, а окно без адреса не отвечает на вопрос «тот ли
   * это заказ». Берётся существующим read-only запросом заказа, своего
   * контракта не заводим.
   */
  const selectedOrder = useQuery({
    queryKey: ['order-address', selectedOrderId],
    enabled: selectedOrderId !== null,
    queryFn: () => client.get<{ address: string | null }>(`/api/orders/${selectedOrderId ?? ''}`),
  });
  const address = selectedOrder.data?.address ?? null;

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
      showToast('Заказ перенесён в другой черновик', 'success');
      refreshAll();
    },
    onError: failure,
  });

  /**
   * Снятие заказа с маршрута прямо на карте.
   *
   * Та же серверная операция возврата, что и крестик в строке состава:
   * заказ уходит в нераспределённые «Сделки», а не удаляется.
   */
  const removeOrder = useMutation({
    mutationFn: (input: { orderId: string; fromRouteId: string }) =>
      withRouteLease(lease, input.fromRouteId, async () => {
        const source = await client.get<RouteCardView>(`/api/routes/${input.fromRouteId}`);
        await client.post(`/api/routes/${input.fromRouteId}/orders/return`, {
          orderIds: [input.orderId],
          expectedVersion: source.version,
        });
      }),
    onSuccess: () => {
      setSelectedOrderId(null);
      showToast('Заказ убран из маршрута', 'success');
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
      showToast('Заказ добавлен в черновик', 'success');
      refreshAll();
    },
    onError: failure,
  });

  /*
   * Переключатель списка стоит в панели карты и виден в обоих её состояниях —
   * и когда подложка есть, и когда её нет. Скрытая панель обязана оставаться
   * возвращаемой, а вернуть её больше неоткуда.
   */
  const listToggle = (
    <div className="routes__map-actions">
      <button
        type="button"
        className="routes__map-toggle"
        aria-expanded={!draftsHidden}
        aria-controls="routing-drafts"
        data-testid="routing-toggle-drafts"
        onClick={onToggleDrafts}
      >
        {draftsHidden ? 'Показать черновики' : 'Скрыть черновики'}
      </button>
    </div>
  );

  if (!status.ready) {
    return (
      <section className="routes__map-panel" data-testid="routing-map-panel">
        {listToggle}
        {/*
          Панель сохраняет полную высоту: сообщение стоит там, где была бы
          карта. Сжатый блок сверху выглядел бы поломкой раскладки, тогда как
          это честное состояние — подложки нет, а список и действия работают.
        */}
        <div className="routes__map-empty">
          <EmptyState title="Карта не настроена" description={status.message ?? ''} />
        </div>
      </section>
    );
  }

  const traffic = trafficNote(config.data);
  const busy = moveOrder.isPending || assignOrder.isPending || removeOrder.isPending;
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
    <section className="routes__map-panel" data-testid="routing-map-panel">
      {listToggle}
      {/*
        Служебная строка лежит НАД полотном карты, а не отдельной полосой сверху.

        Отдельный ряд отнимал у карты высоту, ради которой её и открывают:
        счётчик точек и переключатель занимают несколько десятков пикселей,
        а карта теряла их на всей ширине.
      */}
      <div className="routes__map-surface" data-testid="routing-map-surface">
        <div className="routes__map-overlay">
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
            Нераспределённые сделки дня
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
      </div>

      {activeRouteId === null && !showUnassigned && (
        <p className="muted text-sm routes__map-hint">
          Раскройте черновик слева, чтобы увидеть его остановки, либо включите нераспределённые
          сделки.
        </p>
      )}

      {/*
        Данные точки и перенос.

        Показываются номер и адрес, а не идентификатор: по обрезанному UUID
        проверить, тот ли это заказ, невозможно.
      */}
      {/*
        Окно заказа лежит ПОВЕРХ карты по центру.

        Раньше эта панель вставала под картой и отнимала у неё высоту при
        каждом нажатии на точку. Теперь карта не меняет размера, а окно
        закрывается крестиком или выбором другой точки.
      */}
      {selected !== null && action !== null && (
        <div className="routes__map-window" data-testid="map-selection">
          <header className="routes__map-window-head">
            <span className="routes__map-window-number">{selected.number}</span>
            {selected.routeNumber !== null && (
              <span className="routes__map-window-route">{selected.routeNumber}</span>
            )}
            <button
              type="button"
              className="routes__map-window-close"
              aria-label="Закрыть окно заказа"
              data-testid="map-selection-close"
              onClick={() => setSelectedOrderId(null)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </header>

          {/* Адрес читается из существующего заказа: на карте его нет. */}
          <p className="routes__map-window-address" title={address ?? undefined}>
            {address ?? '—'}
          </p>

          <p className="routes__map-window-label">
            {action.kind === 'ASSIGN' ? 'Назначить в маршрут:' : 'Переназначить в маршрут:'}
          </p>

          {/*
            Когда черновиков много, ряд кнопок превращается в лотерею: сверху
            появляется то же поле поиска, что и у выбора курьера.
          */}
          {targets.length > SEARCH_FROM && (
            <TextInput
              value={targetQuery}
              placeholder="Поиск по номеру"
              aria-label="Поиск маршрута"
              disabled={busy}
              className="routes__map-window-search"
              data-testid="map-transfer-search"
              onChange={(event) => setTargetQuery(event.target.value)}
            />
          )}

          <div className="routes__map-window-targets" data-testid="map-transfer-list">
            {matchingTargets.length === 0 ? (
              <span className="muted text-sm">Подходящих черновиков нет</span>
            ) : (
              matchingTargets.map((draft) => (
                <button
                  key={draft.id}
                  type="button"
                  className="routes__map-window-target"
                  data-testid="map-transfer-option"
                  disabled={busy}
                  onClick={() => {
                    if (action.kind === 'ASSIGN') {
                      assignOrder.mutate({ orderId: action.orderId, toRouteId: draft.id });
                      return;
                    }
                    moveOrder.mutate({
                      orderId: action.orderId,
                      fromRouteId: action.fromRouteId,
                      toRouteId: draft.id,
                    });
                  }}
                >
                  {draft.number}
                </button>
              ))
            )}
          </div>

          {action.kind === 'MOVE' && (
            <button
              type="button"
              className="routes__map-window-remove"
              data-testid="map-order-remove"
              disabled={busy}
              onClick={() =>
                removeOrder.mutate({ orderId: action.orderId, fromRouteId: action.fromRouteId })
              }
            >
              Убрать из маршрута
            </button>
          )}
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
