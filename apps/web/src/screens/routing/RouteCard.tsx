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
import { ArrowDown, ArrowUp, CornerUpLeft, X } from 'lucide-react';
import { formatMoscowDateTime } from '@fl/shared';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
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
import {
  blockerLabel,
  canEdit,
  conflictLabel,
  conflictMessage,
  editingHint,
  formatDate,
  moveTo,
  ROUTE_STATE_LABELS,
  routeActionLabel,
  stopInterval,
  VEHICLE_LABELS as VEHICLES,
  type HistoryResponse,
  type RouteCardView,
} from './routing';

const HISTORY_PAGE_SIZE = 20;

import type { CourierOption } from '../deals/courier-picker';
import { CourierCombobox } from '../logistics/CourierCombobox';
import { OrderWindow } from '../logistics/OrderWindow';

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

  /** Заказ, открытый в окне. `null` — окно закрыто. */
  const [orderWindowId, setOrderWindowId] = useState<string | null>(null);
  /** Что сейчас перетаскивают. `null` — перетаскивания нет. */
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const [historyOffset, setHistoryOffset] = useState(0);
  /** Раскрыта ли история. Закрыта — в нижнем ряду стоит только её кнопка. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<'return-to-draft' | 'cancel' | null>(null);
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** Открыт ли выбор курьера. Закрыт — на его месте стоит строка со сводкой. */
  const [courierOpen, setCourierOpen] = useState(false);
  /** Курьер, выбранный в окне подтверждения. Пустая строка — «не назначен». */
  const [confirmCourierId, setConfirmCourierId] = useState('');

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
    if (card !== undefined) {
      queryClient.setQueryData(['route', routeId], card);
    }
    void queryClient.invalidateQueries({ queryKey: ['route', routeId] });
    void queryClient.invalidateQueries({ queryKey: ['route-history', routeId] });
    void queryClient.invalidateQueries({ queryKey: ['routes'] });
    void queryClient.invalidateQueries({ queryKey: ['unassigned-orders'] });
  };

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

  /*
   * Явные кнопки аренды.
   *
   * Захват при открытии карточки остался прежним: эти кнопки не меняют его,
   * а дают руками то, что до сих пор происходило только само. Освободить
   * маршрут было нечем вовсе — приходилось закрывать карточку и ждать,
   * пока аренда истечёт сама.
   */
  const acquireLease = useMutation({
    mutationFn: () => client.post(`/api/routes/${routeId}/edit-lock/acquire`, {}),
    onSuccess: () => afterSuccess('Маршрут взят в работу'),
    onError: handleFailure,
  });

  const releaseLease = useMutation({
    mutationFn: () => client.post(`/api/routes/${routeId}/edit-lock/release`, {}),
    onSuccess: () => afterSuccess('Маршрут освобождён'),
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

  const courierPhone =
    route.courier === null
      ? null
      : ((couriers.data?.items ?? []).find((item) => item.id === route.courier?.id)?.phone ?? null);

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
      {/*
        Заголовок карточки не повторяется.

        Номер и состояние уже стоят в строке списка, которая эту карточку
        и раскрыла: второй такой же заголовок отнимал строку у состава
        и заставлял читать одно и то же дважды.
      */}
      <header className="routes__card-header">
        {/*
          Внутри списка дата, транспорт и число остановок уже стоят в строке,
          которая карточку раскрыла. Повтор отнимал бы строку у состава
          и заставлял читать одно и то же дважды.
        */}
        {!embedded && (
          <p className="muted routes__card-meta">
            {formatDate(route.deliveryDate)} · {VEHICLES[route.vehicleType]} · заказов:{' '}
            {route.orders.length}
            {route.conflictCount > 0 ? ` · расхождений: ${route.conflictCount}` : ''}
          </p>
        )}
        {/*
          Крестик — ВТОРОЙ вход в ту же операцию отмены, а не удаление. Данные
          не удаляются никогда: маршрут отменяется с обязательной причиной,
          запись остаётся в истории, а заказы одной транзакцией возвращаются
          в нераспределённые «Сделки».

          Внутри списка его нет: там кнопка «Отменить маршрут» стоит в той же
          карточке двумя строками ниже и названа словами, а крестик оставался
          один на пустой полосе — строка экрана ради дубля.
        */}
        {route.state === 'DRAFT' && !embedded && (
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
            <X size={14} aria-hidden="true" />
          </button>
        )}
        {/* Встроенную карточку сворачивает сам список: вторая кнопка была бы лишней. */}
        {!embedded && <Button onClick={onClose}>Закрыть</Button>}
      </header>

      {/*
        Аренда названа во всех трёх состояниях, а не только в отказных.
        Молчание при удерживаемой аренде читалось как «редактировать нельзя»:
        логист видел активные кнопки и не понимал, кому маршрут принадлежит.
      */}
      {route.state === 'DRAFT' && (
        <div className="routes__lease" role="status">
          {editable ? (
            <>
              <span className="routes__lease-badge">Вы редактируете</span>
              <Button
                variant="ghost"
                disabled={releaseLease.isPending}
                data-testid="route-lease-release"
                onClick={() => releaseLease.mutate()}
              >
                Освободить
              </Button>
            </>
          ) : route.editLock.locked ? (
            <>
              <span className="routes__lease-text">{hint}</span>
              <Button variant="secondary" onClick={() => setTakeoverOpen(true)}>
                Перехватить
              </Button>
            </>
          ) : (
            <>
              <span className="routes__lease-text">Возьмите в работу, чтобы менять состав</span>
              <Button
                variant="primary"
                disabled={acquireLease.isPending}
                data-testid="route-lease-acquire"
                onClick={() => acquireLease.mutate()}
              >
                Взять в работу
              </Button>
            </>
          )}
        </div>
      )}

      {/* Прочие состояния маршрута аренды не касаются: он просто не правится. */}
      {route.state !== 'DRAFT' && hint !== null && (
        <div className="routes__hint" role="status">
          <span className="routes__hint-text">{hint}</span>
        </div>
      )}

      {/*
        Препятствия названы заголовком, а не одним лишь перечнем.

        Список причин сам по себе не говорил, к чему они относятся: логист
        видел строки и искал глазами, какая кнопка из-за них выключена.
      */}
      {route.state === 'DRAFT' && route.confirmBlockers.length > 0 && (
        <div className="routes__blockers" role="status">
          <p className="routes__blockers-title">Нельзя создать маршрутный лист</p>
          <ul className="routes__blockers-list">
            {route.confirmBlockers.map((blocker) => (
              <li key={blocker.kind}>
                {blockerLabel(blocker.kind)}
                {blocker.orderIds.length > 0 ? ` (${blocker.orderIds.length})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        Курьер: сначала ответ, потом инструмент.

        Раскрытый список занимал строку даже тогда, когда курьера не меняют,
        а главный вопрос — назначен он или нет — приходилось вычитывать из
        поля ввода. Строка отвечает сразу, выбор открывается по требованию.
      */}
      <div className="routes__courier">
        <div className="routes__courier-row">
          <span className="routes__courier-label">Курьер</span>
          <span
            className={
              route.courier === null
                ? 'routes__courier-value routes__courier-value--empty'
                : 'routes__courier-value'
            }
            data-testid="route-courier-value"
          >
            {route.courier?.fullName ?? 'не назначен'}
            {/*
              Телефон берётся из уже загруженного справочника курьеров:
              карточка маршрута его не отдаёт, а звонить по нему нужно
              с этого же экрана. Не нашли — обходимся именем.
            */}
            {courierPhone !== null && (
              <span className="routes__courier-phone"> · {courierPhone}</span>
            )}
          </span>
          {editable && (
            <Button
              variant="ghost"
              disabled={setCourier.isPending}
              aria-expanded={courierOpen}
              onClick={() => setCourierOpen((open) => !open)}
            >
              {courierOpen ? 'Свернуть' : route.courier === null ? 'Назначить' : 'Изменить'}
            </Button>
          )}
        </div>

        {/*
          Тот же контрол, что на всех трёх вкладках: нажатие в поле открывает
          список, ввод его сужает.
        */}
        {editable && courierOpen && (
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
                    : ((couriers.data?.items ?? []).find(
                        (item) => item.id === route.courier?.id,
                      ) ?? {
                        id: route.courier.id,
                        fullName: route.courier.fullName,
                        phone: null,
                      })
                }
                disabled={setCourier.isPending}
                testId="route-courier"
                onChange={(courier) => setCourier.mutate(courier === null ? null : courier.id)}
              />
            )}
          </Field>
        )}
      </div>

      {/*
        Пустой состав назван один раз.

        Блок препятствий выше уже сказал «В маршруте нет заказов»: крупная
        заглушка повторяла ту же фразу и занимала полкарточки, оставляя
        от подсказки одну строку пользы.
      */}
      {route.orders.length === 0 ? (
        <p className="muted text-sm routes__stops-empty">
          Отметьте нераспределённые заказы слева и добавьте их в маршрут.
        </p>
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
              {/*
                Ручка перетаскивания.

                Ручка не кнопка: она показывает, за что тянуть, а сам захват
                живёт на всей строке. Стрелки справа делают то же самое
                без мыши.
              */}
              <span className="routes__stop-grip" aria-hidden="true">
                ⠿
              </span>

              <span className="routes__position">{item.position}</span>

              <div className="routes__stop-body">
                <div className="routes__stop-head">
                  {/* Номер — вход в окно заказа со всей информацией. */}
                  <button
                    type="button"
                    className="routes__number order-number-button"
                    data-testid="order-number"
                    onClick={() => setOrderWindowId(item.order.id)}
                  >
                    {item.order.number}
                  </button>
                  <span className="routes__stop-time">{stopInterval(item.order.interval)}</span>
                  {/* Сумма к получению — часть задания курьеру, а не служебное поле. */}
                  {item.order.cashToCollect !== null && (
                    <span className="routes__stop-cash">{item.order.cashToCollect} ₽</span>
                  )}
                  {item.order.needsAttention && (
                    <StatusBadge tone="warning">Требует внимания</StatusBadge>
                  )}
                  {!item.order.deliveryDateMatchesRoute && (
                    <StatusBadge tone="error">Дата не совпадает</StatusBadge>
                  )}
                  {/*
                    Отмена остаётся в составе видимой: убрать заказ молча
                    значило бы потерять след букета, который, возможно,
                    уже собран и лежит в маршрутной ячейке.
                  */}
                  {item.order.cancelled === true && (
                    <StatusBadge tone="error">Отменён — не выдавать</StatusBadge>
                  )}
                </div>
                {/* Адрес — одна строка с обрезкой; полный виден подсказкой. */}
                <div className="routes__stop-address" title={item.order.address ?? undefined}>
                  {item.order.address ?? '—'}
                </div>
                {item.conflicts.length > 0 && (
                  <ul className="routes__conflicts">
                    {item.conflicts.map((conflict) => (
                      <li key={conflict.kind}>{conflictLabel(conflict.kind)}</li>
                    ))}
                  </ul>
                )}
              </div>

              {/*
                Три действия строки стоят рядом.

                Перетаскивание остаётся основным способом менять порядок, но
                оно недоступно с клавиатуры и неудобно в длинном списке:
                стрелки ведут в ту же атомарную операцию с проверкой версии.
                Возврат отдаёт ОДИН заказ в нераспределённые той же операцией,
                что прежняя кнопка «Вернуть выбранные».
              */}
              <div className="routes__stop-controls">
                <button
                  type="button"
                  className="routes__stop-move"
                  data-testid="route-stop-up"
                  aria-label={`Поднять заказ ${item.order.number} выше`}
                  disabled={!editable || reorder.isPending || index === 0}
                  onClick={() => {
                    const next = moveTo(orderIds, index, index - 1);
                    if (next !== null) {
                      reorder.mutate(next);
                    }
                  }}
                >
                  <ArrowUp size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="routes__stop-move"
                  data-testid="route-stop-down"
                  aria-label={`Опустить заказ ${item.order.number} ниже`}
                  disabled={!editable || reorder.isPending || index === route.orders.length - 1}
                  onClick={() => {
                    const next = moveTo(orderIds, index, index + 1);
                    if (next !== null) {
                      reorder.mutate(next);
                    }
                  }}
                >
                  <ArrowDown size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="routes__stop-remove"
                  data-testid="route-stop-remove"
                  aria-label={`Убрать заказ ${item.order.number} из маршрута`}
                  title="Убрать из маршрута: заказ вернётся в «Сделки»"
                  disabled={!editable || returnOrders.isPending}
                  onClick={() => returnOrders.mutate([item.order.id])}
                >
                  <CornerUpLeft size={13} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ol>
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

        {/*
          Групповых действий в карточке больше нет.

          Возврат делает стрелка в строке, а перенос в другой маршрут — окно
          заказа на карте: там видно, куда именно едет заказ.
        */}
        <Button
          variant="ghost"
          className="routes__history-toggle"
          aria-expanded={historyOpen}
          aria-controls={`route-history-${routeId}`}
          data-testid="route-history-toggle"
          onClick={() => setHistoryOpen((open) => !open)}
        >
          История маршрута
        </Button>
      </div>

      {/*
        История раскрывается кнопкой из нижнего ряда, а не сама по себе.

        Прежде она стояла отдельной строкой под действиями и занимала её
        всегда, хотя открывают историю редко: в списке черновиков эта строка
        стоила целой карточки соседнего маршрута.
      */}
      {historyOpen && (
        <div className="routes__history" id={`route-history-${routeId}`}>
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
        </div>
      )}

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

      {/* Окно заказа: одно и то же на всех вкладках. */}
      {orderWindowId !== null && (
        <OrderWindow orderId={orderWindowId} onClose={() => setOrderWindowId(null)} />
      )}
    </section>
  );
}
