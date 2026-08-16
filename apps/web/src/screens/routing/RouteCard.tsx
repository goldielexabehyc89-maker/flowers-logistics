/**
 * Карточка маршрута: состав, порядок, курьер, жизненный цикл и блокировка редактора.
 *
 * Мутации отправляют актуальную версию маршрута. При 409 карточка не повторяет
 * операцию сама и не оставляет на экране переставленный порядок: она перечитывает
 * данные и честно говорит, что маршрут изменил кто-то другой. Молчаливый повтор
 * поверх чужой правки хуже отказа — логист не узнал бы, что его действие
 * применилось не к тому составу.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { X } from 'lucide-react';
import { formatMoscowDateTime } from '@fl/shared';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  Pagination,
  Select,
  StatusBadge,
  TextInput,
} from '../../ui/components';
import { useRouteLease } from './useRouteLease';
import { withRouteLease } from './lease-scope';
import {
  blockerLabel,
  canEdit,
  conflictLabel,
  conflictMessage,
  editingHint,
  formatDate,
  moveTo,
  moveWithin,
  ROUTE_STATE_LABELS,
  routeActionLabel,
  stopInterval,
  VEHICLE_LABELS as VEHICLES,
  type HistoryResponse,
  type RouteCardView,
  type RouteListResponse,
} from './routing';

const HISTORY_PAGE_SIZE = 20;

import type { CourierOption } from '../deals/courier-picker';
import { CourierCombobox } from '../logistics/CourierCombobox';

export interface RouteCardProps {
  routeId: string;
  onClose: () => void;
  /**
   * Карточка раскрыта внутри списка черновиков, а не показана отдельно.
   * Сворачивает её сам список, поэтому собственная кнопка «Закрыть» лишняя.
   */
  embedded?: boolean;
  /**
   * Черновик подтверждён и перестал быть черновиком.
   *
   * Список обязан узнать об этом сам: подтверждённый маршрут уходит
   * в «Маршрутные листы» и не должен остаться раскрытым на этой вкладке.
   */
  onConfirmed?: () => void;
}

export function RouteCard({
  routeId,
  onClose,
  embedded = false,
  onConfirmed,
}: RouteCardProps): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [selected, setSelected] = useState<string[]>([]);
  /** Что сейчас перетаскивают. `null` — перетаскивания нет. */
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const [historyOffset, setHistoryOffset] = useState(0);
  const [pendingAction, setPendingAction] = useState<'return-to-draft' | 'cancel' | null>(null);
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** Курьер, выбранный в окне подтверждения. Пустая строка — «не назначен». */
  const [confirmCourierId, setConfirmCourierId] = useState('');
  const [moveTargetId, setMoveTargetId] = useState('');

  const routeQuery = useQuery({
    queryKey: ['route', routeId],
    queryFn: () => client.get<RouteCardView>(`/api/routes/${routeId}`),
  });

  const route = routeQuery.data;
  const editable = route !== undefined && canEdit(route);
  const hint = route === undefined ? null : editingHint(route);

  // Аренда нужна только черновику: подтверждённый и отменённый маршрут не правятся.
  useRouteLease({
    client,
    routeId,
    enabled: route?.state === 'DRAFT',
    heldByCurrentSession: route?.editLock.heldByCurrentSession === true,
    onChanged: () => {
      void queryClient.invalidateQueries({ queryKey: ['route', routeId] });
    },
  });

  const couriers = useQuery({
    queryKey: ['couriers-for-routes'],
    queryFn: () =>
      client.get<{ items: CourierOption[] }>('/api/users?role=COURIER&status=ACTIVE&limit=100'),
    enabled: editable,
  });

  const history = useQuery({
    queryKey: ['route-history', routeId, historyOffset],
    queryFn: () =>
      client.get<HistoryResponse>(
        `/api/routes/${routeId}/history?limit=${HISTORY_PAGE_SIZE}&offset=${historyOffset}`,
      ),
  });

  /** Общая обработка отказов: карточка всегда перечитывается, повтора нет. */
  const handleFailure = (error: unknown): void => {
    const kind = error instanceof ApiError ? (error.conflict?.kind ?? undefined) : undefined;
    const message =
      error instanceof ApiError
        ? conflictMessage(kind, error.message)
        : 'Не удалось выполнить операцию. Повторите попытку.';

    showToast(message, 'error');
    setSelected([]);
    void queryClient.invalidateQueries({ queryKey: ['route', routeId] });
    void queryClient.invalidateQueries({ queryKey: ['routes'] });
    void queryClient.invalidateQueries({ queryKey: ['unassigned-orders'] });
  };

  /**
   * Успешная мутация.
   *
   * Сервер возвращает свежую карточку целиком, и она кладётся в кэш сразу:
   * иначе между ответом и повторным запросом остаётся окно, в котором следующая
   * кнопка отправила бы устаревшую версию и честно получила бы 409 на пустом месте.
   */
  const afterSuccess = (message: string, card?: RouteCardView): void => {
    showToast(message, 'success');
    setSelected([]);
    if (card !== undefined) {
      queryClient.setQueryData(['route', routeId], card);
    }
    void queryClient.invalidateQueries({ queryKey: ['route', routeId] });
    void queryClient.invalidateQueries({ queryKey: ['route-history', routeId] });
    void queryClient.invalidateQueries({ queryKey: ['routes'] });
    void queryClient.invalidateQueries({ queryKey: ['unassigned-orders'] });
  };

  // Список черновиков того же дня нужен для переноса: маршрут другого дня
  // сервер всё равно отвергнет, и предлагать его бессмысленно.
  const siblings = useQuery({
    queryKey: ['routes', route?.deliveryDate ?? ''],
    queryFn: () =>
      client.get<RouteListResponse>(
        `/api/routes?deliveryDate=${route?.deliveryDate ?? ''}&state=DRAFT&limit=100`,
      ),
    enabled: route !== undefined && route.state === 'DRAFT',
  });

  /**
   * Перенос между черновиками.
   *
   * Сервер требует аренду ОБОИХ маршрутов: перенос меняет состав и там, и там.
   * Поэтому целевой маршрут берётся в работу на время операции и освобождается
   * сразу после неё — но только если аренду выдали именно под эту операцию.
   * Если та же вкладка уже держала целевой маршрут открытым, освобождать его
   * нельзя: пользователь потерял бы собственную блокировку.
   *
   * Версия целевого маршрута читается здесь же, после захвата: значение из списка
   * могло устареть, пока логист выбирал заказы.
   */
  const moveOrders = useMutation({
    mutationFn: (input: { targetId: string; orderIds: string[] }) =>
      withRouteLease(
        {
          acquire: (id) =>
            client.post<{ granted: boolean }>(`/api/routes/${id}/edit-lock/acquire`, {}),
          release: async (id) => {
            await client.post(`/api/routes/${id}/edit-lock/release`, {});
          },
        },
        input.targetId,
        async () => {
          const target = await client.get<RouteCardView>(`/api/routes/${input.targetId}`);
          return client.post<{ source: RouteCardView; target: RouteCardView }>('/api/routes/move', {
            fromRouteId: routeId,
            toRouteId: input.targetId,
            orderIds: input.orderIds,
            expectedSourceVersion: route?.version ?? 0,
            expectedTargetVersion: target.version,
          });
        },
      ),
    onSuccess: (result) => {
      setMoveTargetId('');
      afterSuccess('Заказы перенесены в другой маршрут', result.source);
    },
    onError: handleFailure,
  });

  const returnOrders = useMutation({
    mutationFn: (orderIds: string[]) =>
      client.post<RouteCardView>(`/api/routes/${routeId}/orders/return`, {
        orderIds,
        expectedVersion: route?.version ?? 0,
      }),
    onSuccess: (card) => afterSuccess('Заказы возвращены в нераспределённые', card),
    onError: handleFailure,
  });

  const reorder = useMutation({
    mutationFn: (orderIds: string[]) =>
      client.put<RouteCardView>(`/api/routes/${routeId}/orders/reorder`, {
        orderIds,
        expectedVersion: route?.version ?? 0,
      }),
    onSuccess: (card) => {
      afterSuccess('Порядок сохранён', card);
      /*
       * Линия маршрута обязана догнать новый порядок.
       *
       * При отказе расчёта прежняя линия остаётся на карте, а причина названа
       * словами: показать «примерно тот» путь было бы хуже, чем не показать
       * никакого.
       */
      void queryClient.invalidateQueries({ queryKey: ['route-geometry', routeId] });
    },
    onError: handleFailure,
  });

  const setCourier = useMutation({
    mutationFn: (courierUserId: string | null) =>
      client.put<RouteCardView>(`/api/routes/${routeId}/courier`, {
        courierUserId,
        expectedVersion: route?.version ?? 0,
      }),
    onSuccess: (card) => afterSuccess('Курьер обновлён', card),
    onError: handleFailure,
  });

  /**
   * Подтверждение, при необходимости вместе с назначением курьера.
   *
   * Две операции идут последовательно и по свежей версии: назначение курьера
   * увеличивает версию маршрута, и подтверждение с прежней честно получило бы
   * 409. Если курьер не менялся, лишнего запроса нет.
   *
   * Сервер перед переходом заново проверяет состав и конфликты — клиентская
   * последовательность не заменяет эту проверку, а только не мешает ей.
   */
  const confirmWithCourier = useMutation({
    mutationFn: async () => {
      const desired = confirmCourierId === '' ? null : confirmCourierId;
      const current = route?.courier?.id ?? null;
      let version = route?.version ?? 0;

      if (desired !== current) {
        const updated = await client.put<RouteCardView>(`/api/routes/${routeId}/courier`, {
          courierUserId: desired,
          expectedVersion: version,
        });
        version = updated.version;
      }

      return client.post<RouteCardView>(`/api/routes/${routeId}/confirm`, {
        expectedVersion: version,
      });
    },
    onSuccess: (card) => {
      setConfirmOpen(false);
      afterSuccess('Маршрутный лист создан', card);
      // Подтверждённый маршрут больше не черновик: список обязан свернуть его
      // и убрать со вкладки, а не оставить раскрытым.
      onConfirmed?.();
      /*
       * Маршрутный лист живёт в «Маршрутных листах».
       *
       * Оставить логиста на прежней вкладке значило бы заставить его искать
       * собственную работу: черновика здесь больше нет, а лист — там.
       */
      void navigate('/logistics/route-sheets');
    },
    onError: (error: unknown) => {
      setConfirmOpen(false);
      handleFailure(error);
    },
  });

  const withReason = useMutation({
    mutationFn: (input: { action: 'return-to-draft' | 'cancel'; reason: string }) =>
      client.post<RouteCardView>(`/api/routes/${routeId}/${input.action}`, {
        expectedVersion: route?.version ?? 0,
        reason: input.reason,
      }),
    onSuccess: (card, variables) => {
      setPendingAction(null);
      setReason('');
      afterSuccess(
        variables.action === 'cancel' ? 'Маршрут отменён' : 'Маршрут возвращён в черновик',
        card,
      );
    },
    onError: (error: unknown) => {
      setPendingAction(null);
      setReason('');
      handleFailure(error);
    },
  });

  const takeover = useMutation({
    mutationFn: (input: { reason: string }) =>
      client.post(`/api/routes/${routeId}/edit-lock/takeover`, {
        confirm: true,
        reason: input.reason,
        expectedLeaseVersion: route?.editLock.leaseVersion ?? 0,
      }),
    onSuccess: () => {
      setTakeoverOpen(false);
      setReason('');
      afterSuccess('Маршрут перешёл к вам');
    },
    onError: (error: unknown) => {
      setTakeoverOpen(false);
      setReason('');
      handleFailure(error);
    },
  });

  if (routeQuery.isPending) {
    return <LoadingState title="Загружаем маршрут…" />;
  }

  if (routeQuery.isError || route === undefined) {
    return (
      <ErrorState title="Не удалось загрузить маршрут" onRetry={() => void routeQuery.refetch()} />
    );
  }

  const orderIds = route.orders.map((item) => item.order.id);

  const submitReason = (): void => {
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      setReasonError('Опишите причину: не меньше трёх символов.');
      return;
    }
    setReasonError(null);

    if (takeoverOpen) {
      takeover.mutate({ reason: trimmed });
      return;
    }
    if (pendingAction !== null) {
      withReason.mutate({ action: pendingAction, reason: trimmed });
    }
  };

  return (
    <section className="stack routes__card">
      <header className="routes__card-header">
        <div>
          <h3>
            Маршрут {route.number}{' '}
            <StatusBadge tone={route.state === 'CANCELLED' ? 'neutral' : 'info'}>
              {ROUTE_STATE_LABELS[route.state]}
            </StatusBadge>
          </h3>
          <p className="muted text-sm">
            {formatDate(route.deliveryDate)} · {VEHICLES[route.vehicleType]} · {route.orders.length}{' '}
            заказ(ов)
            {route.conflictCount > 0 ? ` · расхождений: ${route.conflictCount}` : ''}
          </p>
        </div>
        {/*
          Крестик в правом верхнем углу — ВТОРОЙ вход в ту же операцию отмены,
          а не удаление. Данные не удаляются никогда: маршрут отменяется
          с обязательной причиной, запись остаётся в истории, а заказы одной
          транзакцией возвращаются в нераспределённые «Сделки».
        */}
        {route.state === 'DRAFT' && (
          <button
            type="button"
            className="routes__card-close"
            data-testid="route-delete"
            /*
              Название отличается от кнопки «Отменить маршрут» намеренно:
              два элемента с одинаковым названием неразличимы и для чтения
              с экрана, и для проверки — выбрать нужный было бы нельзя.
            */
            aria-label={`Отменить черновик ${route.number}`}
            title="Отменить маршрут: заказы вернутся в «Сделки»"
            disabled={!editable}
            onClick={() => {
              setPendingAction('cancel');
              setReason('');
            }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
        {/* Встроенную карточку сворачивает сам список: вторая кнопка была бы лишней. */}
        {!embedded && <Button onClick={onClose}>Закрыть</Button>}
      </header>

      {hint !== null && (
        <p className="routes__hint" role="status">
          {hint}
          {route.editLock.locked && !route.editLock.heldByCurrentSession && (
            <Button variant="secondary" onClick={() => setTakeoverOpen(true)}>
              Перехватить
            </Button>
          )}
        </p>
      )}

      {route.state === 'DRAFT' && route.confirmBlockers.length > 0 && (
        <ul className="routes__blockers">
          {route.confirmBlockers.map((blocker) => (
            <li key={blocker.kind}>
              {blockerLabel(blocker.kind)}
              {blocker.orderIds.length > 0 ? ` (${blocker.orderIds.length})` : ''}
            </li>
          ))}
        </ul>
      )}

      <div className="routes__actions">
        {route.state === 'DRAFT' && (
          <>
            <Button
              variant="primary"
              disabled={!editable || route.confirmBlockers.length > 0}
              onClick={() => {
                // Окно открывается с уже назначенным курьером, а не пустым:
                // иначе подтверждение молча снимало бы прежнего.
                setConfirmCourierId(route.courier?.id ?? '');
                setConfirmOpen(true);
              }}
            >
              Создать МЛ
            </Button>
            <Button
              variant="danger"
              disabled={!editable}
              onClick={() => {
                setPendingAction('cancel');
                setReason('');
              }}
            >
              Отменить маршрут
            </Button>
          </>
        )}
        {route.state === 'CONFIRMED' && (
          <>
            <Button
              onClick={() => {
                setPendingAction('return-to-draft');
                setReason('');
              }}
            >
              Вернуть в черновик
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setPendingAction('cancel');
                setReason('');
              }}
            >
              Отменить маршрут
            </Button>
          </>
        )}
      </div>

      {/*
        Курьер выбирается одним и тем же контролом на всех трёх вкладках:
        нажатие в поле открывает список, ввод его сужает.
      */}
      <Field label="Курьер" hint="Поиск по имени или телефону">
        {() => (
          <CourierCombobox
            options={couriers.data?.items ?? []}
            /*
              Назначенный курьер мог не попасть в загруженный список (сотню
              активных курьеров список ограничивает): тогда он берётся из самого
              маршрута — телефона в карточке нет, и это нормально.
            */
            value={
              route.courier === null
                ? null
                : ((couriers.data?.items ?? []).find((item) => item.id === route.courier?.id) ?? {
                    id: route.courier.id,
                    fullName: route.courier.fullName,
                    phone: null,
                  })
            }
            disabled={!editable || setCourier.isPending}
            testId="route-courier"
            onChange={(courier) => setCourier.mutate(courier === null ? null : courier.id)}
          />
        )}
      </Field>

      {route.orders.length === 0 ? (
        <EmptyState
          title="В маршруте нет заказов"
          description="Отметьте нераспределённые заказы слева и добавьте их в маршрут."
        />
      ) : (
        <ol className="routes__stops">
          {route.orders.map((item, index) => (
            <li
              key={item.routeOrderId}
              className={
                dragIndex === index ? 'routes__stop routes__stop--dragging' : 'routes__stop'
              }
              data-testid="route-stop"
              /*
               * Перетаскивание — основной способ менять порядок. Стрелки рядом
               * остаются для клавиатуры: обе дороги ведут в одну и ту же
               * атомарную операцию с проверкой версии.
               */
              draggable={editable && !reorder.isPending}
              onDragStart={() => setDragIndex(index)}
              onDragEnd={() => setDragIndex(null)}
              onDragOver={(event) => {
                if (dragIndex !== null) {
                  event.preventDefault();
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragIndex === null) {
                  return;
                }
                const next = moveTo(orderIds, dragIndex, index);
                setDragIndex(null);
                if (next !== null) {
                  reorder.mutate(next);
                }
              }}
            >
              <label className="routes__stop-select">
                <input
                  type="checkbox"
                  checked={selected.includes(item.order.id)}
                  disabled={!editable}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, item.order.id]
                        : current.filter((id) => id !== item.order.id),
                    )
                  }
                  aria-label={`Выбрать заказ ${item.order.number}`}
                />
              </label>

              <div className="routes__stop-body">
                <div className="routes__stop-head">
                  <span className="routes__position">{item.position}</span>
                  <span className="routes__number">{item.order.number}</span>
                  <span>{stopInterval(item.order.interval)}</span>
                  {item.order.needsAttention && (
                    <StatusBadge tone="warning">Требует внимания</StatusBadge>
                  )}
                  {!item.order.deliveryDateMatchesRoute && (
                    <StatusBadge tone="error">Дата не совпадает</StatusBadge>
                  )}
                </div>
                <div className="routes__stop-body-text">
                  <span>{item.order.address ?? '—'}</span>
                  <span className="muted">{item.order.recipient ?? '—'}</span>
                </div>
                {item.conflicts.length > 0 && (
                  <ul className="routes__conflicts">
                    {item.conflicts.map((conflict) => (
                      <li key={conflict.kind}>{conflictLabel(conflict.kind)}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="routes__stop-actions">
                {/*
                  Перетаскивание — основной способ менять порядок; стрелки
                  остаются рядом для клавиатуры и для тех, кому мышью тащить
                  неудобно. Обе дороги ведут в одну и ту же атомарную операцию.
                */}
                <Button
                  aria-label={`Поднять заказ ${item.order.number}`}
                  disabled={!editable || index === 0 || reorder.isPending}
                  onClick={() => {
                    const next = moveWithin(orderIds, item.order.id, -1);
                    if (next !== null) {
                      reorder.mutate(next);
                    }
                  }}
                >
                  ↑
                </Button>
                <Button
                  aria-label={`Опустить заказ ${item.order.number}`}
                  disabled={!editable || index === route.orders.length - 1 || reorder.isPending}
                  onClick={() => {
                    const next = moveWithin(orderIds, item.order.id, 1);
                    if (next !== null) {
                      reorder.mutate(next);
                    }
                  }}
                >
                  ↓
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {route.orders.length > 0 && (
        <div className="routes__actions routes__actions--wrap">
          <Button
            disabled={!editable || selected.length === 0 || returnOrders.isPending}
            onClick={() => returnOrders.mutate(selected)}
          >
            Вернуть выбранные ({selected.length})
          </Button>

          <Field label="Перенести в маршрут">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={moveTargetId}
                disabled={!editable}
                onChange={(event) => setMoveTargetId(event.target.value)}
              >
                <option value="">Выберите черновик</option>
                {(siblings.data?.items ?? [])
                  .filter((item) => item.id !== route.id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.number} · заказов: {item.orderCount}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Button
            disabled={
              !editable || selected.length === 0 || moveTargetId === '' || moveOrders.isPending
            }
            onClick={() => {
              const target = (siblings.data?.items ?? []).find((item) => item.id === moveTargetId);
              if (target !== undefined) {
                // Если целевой маршрут занят другим редактором, захват вернёт 409,
                // перенос не выполнится и локальный состав не изменится.
                moveOrders.mutate({ targetId: target.id, orderIds: selected });
              }
            }}
          >
            Перенести ({selected.length})
          </Button>
        </div>
      )}

      <details className="routes__history">
        <summary>История маршрута</summary>
        {history.isPending ? (
          <LoadingState title="Загружаем историю…" />
        ) : history.isError ? (
          <ErrorState onRetry={() => void history.refetch()} />
        ) : (
          <>
            {(history.data?.transitions ?? []).length > 0 && (
              <ul className="routes__transitions">
                {(history.data?.transitions ?? []).map((transition) => (
                  <li key={`${transition.occurredAt}-${transition.toState}`}>
                    {ROUTE_STATE_LABELS[transition.fromState]} →{' '}
                    {ROUTE_STATE_LABELS[transition.toState]}
                    {transition.reason === null ? '' : `: ${transition.reason}`}
                  </li>
                ))}
              </ul>
            )}
            <ul className="routes__audit">
              {(history.data?.items ?? []).map((entry, index) => (
                <li key={`${entry.occurredAt}-${index}`}>
                  {formatMoscowDateTime(entry.occurredAt)} · {routeActionLabel(entry.action)}
                </li>
              ))}
            </ul>
            <Pagination
              offset={historyOffset}
              limit={HISTORY_PAGE_SIZE}
              total={history.data?.total ?? 0}
              onChange={setHistoryOffset}
            />
          </>
        )}
      </details>

      {/*
        Подтверждение с назначением курьера.

        Курьер остаётся необязательным: маршрут подтверждался без него и раньше,
        и делать его обязательным без отдельного решения владельца нельзя.
        Здесь он просто под рукой — назначать курьера отдельным полем, а потом
        искать кнопку подтверждения было лишним шагом в самом частом действии.
      */}
      <Modal
        open={confirmOpen}
        title="Подтвердить маршрут"
        onClose={() => setConfirmOpen(false)}
        dismissible={!confirmWithCourier.isPending}
      >
        <div className="stack">
          <p className="text-sm muted">
            После подтверждения состав нельзя менять без возврата в черновик. Маршрут появится в
            «Маршрутных листах» и исчезнет из этой вкладки.
          </p>
          <Field label="Курьер" hint="Необязательно: маршрут можно подтвердить и без курьера">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={confirmCourierId}
                disabled={confirmWithCourier.isPending}
                onChange={(event) => setConfirmCourierId(event.target.value)}
              >
                <option value="">Не назначен</option>
                {route.courier !== null &&
                  !(couriers.data?.items ?? []).some((item) => item.id === route.courier?.id) && (
                    <option value={route.courier.id}>{route.courier.fullName}</option>
                  )}
                {(couriers.data?.items ?? []).map((courier) => (
                  <option key={courier.id} value={courier.id}>
                    {courier.fullName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="modal__footer">
            <Button onClick={() => setConfirmOpen(false)} disabled={confirmWithCourier.isPending}>
              Отмена
            </Button>
            <Button
              variant="primary"
              data-testid="route-confirm-submit"
              disabled={confirmWithCourier.isPending}
              onClick={() => confirmWithCourier.mutate()}
            >
              Подтвердить
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={pendingAction !== null || takeoverOpen}
        title={
          takeoverOpen
            ? 'Перехватить редактирование'
            : pendingAction === 'cancel'
              ? 'Отмена маршрута'
              : 'Возврат в черновик'
        }
        onClose={() => {
          setPendingAction(null);
          setTakeoverOpen(false);
          setReason('');
          setReasonError(null);
        }}
      >
        <div className="stack">
          <p className="text-sm muted">
            {takeoverOpen
              ? 'Прежний редактор сразу потеряет право на изменения и получит уведомление.'
              : 'Причина сохраняется в истории маршрута и изменению не подлежит.'}
          </p>
          <Field label="Причина" error={reasonError ?? undefined}>
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                autoFocus
              />
            )}
          </Field>
          <div className="modal__footer">
            <Button
              onClick={() => {
                setPendingAction(null);
                setTakeoverOpen(false);
                setReason('');
              }}
            >
              Отмена
            </Button>
            <Button
              variant="primary"
              disabled={withReason.isPending || takeover.isPending}
              onClick={submitReason}
            >
              Продолжить
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
