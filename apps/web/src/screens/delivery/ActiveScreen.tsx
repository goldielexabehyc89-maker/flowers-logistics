/**
 * Активные доставки курьера.
 *
 * Список объединённый, но сгруппирован по маршрутам и окрашен по ним же:
 * курьер везёт несколько листов сразу и обязан видеть, где заканчивается один
 * и начинается другой. Порядок остановок рекомендательный.
 *
 * ДЕЙСТВИЕ ТОЛЬКО ONLINE. Клиентской очереди статусов нет: результат уходит
 * на сервер сразу либо не уходит вовсе. При потерянном ответе экран сначала
 * ПЕРЕЧИТЫВАЕТ состояние с сервера и показывает то, что там на самом деле, —
 * ложный успех дороже второго нажатия.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
  Select,
  StatusBadge,
} from '../../ui/components';
import {
  cancelWindowLeftMs,
  formatCash,
  groupRoutes,
  intervalPosition,
  moscowMinutesOfDay,
  remainingOf,
  resultDraftProblem,
  routeAccent,
  routeLink,
  selectableReasons,
  type ActiveOrderView,
  type ActiveRouteView,
  type AttemptView,
  type DeliveryOutcome,
  type FailureReasonView,
} from './delivery-flow';
import './delivery.css';

const ACTIVE_KEY = ['delivery-active'];
const RETURNS_KEY = ['delivery-returns'];

/** Обязательство вернуть букет на склад. */
interface CourierReturnView {
  returnId: string;
  orderId: string;
  orderNumber: string;
  routeNumber: string;
  reasonName: string;
  state: 'WITH_COURIER' | 'RETURNING' | 'ACCEPTED' | 'CANCELLED';
  failedAt: string;
}

const RETURN_STATE_LABELS: Readonly<Record<string, string>> = {
  WITH_COURIER: 'У курьера',
  RETURNING: 'Возвращается на склад',
  ACCEPTED: 'Принят складом',
};

/**
 * Красный блок «Вернуть на склад».
 *
 * Отдельно от маршрутов намеренно: маршрут завершается последним результатом,
 * а букет из машины при этом никуда не девается. Блок исчезает ровно тогда,
 * когда кладовщик назначил заказу ячейку, — не раньше и без обновления
 * страницы.
 */
function ReturnsBlock({
  items,
  onDeparting,
  busy,
}: {
  items: readonly CourierReturnView[];
  onDeparting: (orderId: string) => void;
  busy: boolean;
}): React.JSX.Element | null {
  if (items.length === 0) {
    return null;
  }

  return (
    <section className="delivery__returns" data-testid="delivery-returns">
      <h3 className="delivery__returns-title">Вернуть на склад</h3>
      <ul className="delivery__returns-list">
        {items.map((item) => (
          <li key={item.returnId} className="delivery__return" data-order-number={item.orderNumber}>
            <div className="delivery__return-head">
              <strong>{item.orderNumber}</strong>
              <span className="delivery__return-state">
                {RETURN_STATE_LABELS[item.state] ?? item.state}
              </span>
            </div>
            <p className="delivery__return-note">
              Передайте заказ кладовщику: пока склад его не принял, он числится за вами.
            </p>
            {item.state === 'WITH_COURIER' && (
              <Button
                variant="ghost"
                disabled={busy}
                data-testid="delivery-return-departing"
                onClick={() => onDeparting(item.orderId)}
              >
                Везу на склад
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function minutesLabel(minute: number | null): string {
  if (minute === null) return '—';
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function outcomeLabel(outcome: DeliveryOutcome): string {
  return outcome === 'DELIVERED' ? 'Доставлен' : 'Не доставлен';
}

export function ActiveScreen(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [routeFilter, setRouteFilter] = useState<string>('');
  /*
   * Заказ и исход, ради которых открыто окно.
   *
   * Раскрытия карточки больше нет: результат — отдельное действие с явным
   * подтверждением, а не форма, выросшая посреди списка и сдвинувшая
   * соседние заказы под пальцем курьера.
   */
  const [asking, setAsking] = useState<{ order: ActiveOrderView; outcome: DeliveryOutcome } | null>(
    null,
  );
  const [reasonId, setReasonId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Часы тикают только ради подсказок времени: досрочности и остатка окна
  // исправления. Ни одно решение сервера от них не зависит.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const active = useQuery({
    queryKey: ACTIVE_KEY,
    queryFn: () => client.get<{ routes: ActiveRouteView[] }>('/api/delivery/active'),
  });

  const returns = useQuery({
    queryKey: RETURNS_KEY,
    queryFn: () => client.get<{ items: CourierReturnView[] }>('/api/delivery/returns'),
  });

  const reasons = useQuery({
    queryKey: ['delivery-reasons'],
    queryFn: () => client.get<{ items: FailureReasonView[] }>('/api/delivery/failure-reasons'),
  });

  function resetDraft(): void {
    setAsking(null);
    setReasonId(null);
  }

  /**
   * Общий обработчик отказа.
   *
   * Любая неудача — в том числе потерянная сеть — заканчивается перечитыванием
   * состояния с сервера. Курьер увидит то, что записано, а не то, что он успел
   * нажать.
   */
  async function afterFailure(error: unknown, fallback: string): Promise<void> {
    showToast(error instanceof ApiError ? error.message : fallback, 'error');
    await queryClient.invalidateQueries({ queryKey: ACTIVE_KEY });
  }

  const record = useMutation({
    mutationFn: (input: {
      routeOrderId: string;
      outcome: DeliveryOutcome;
      reasonId?: string;
      comment?: string;
    }) =>
      client.post<{ unchanged: boolean; routeCompleted: boolean; remaining: number }>(
        `/api/delivery/orders/${input.routeOrderId}/result`,
        {
          outcome: input.outcome,
          ...(input.reasonId === undefined ? {} : { reasonId: input.reasonId }),
          ...(input.comment === undefined ? {} : { comment: input.comment }),
        },
      ),
    onSuccess: async (result) => {
      resetDraft();
      await queryClient.invalidateQueries({ queryKey: ACTIVE_KEY });
      showToast(
        result.unchanged
          ? 'Результат уже был записан ранее'
          : result.routeCompleted
            ? 'Результат записан. Маршрут завершён'
            : `Результат записан. Осталось заказов: ${result.remaining}`,
        'success',
      );
    },
    onError: (error: unknown) => void afterFailure(error, 'Нет интернета. Статус не сохранён'),
  });

  const departing = useMutation({
    mutationFn: (orderId: string) =>
      client.post<{ state: string }>(`/api/delivery/returns/${orderId}/returning`, {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: RETURNS_KEY });
    },
    onError: (error: unknown) => void afterFailure(error, 'Не удалось отметить выезд на склад.'),
  });

  const cancel = useMutation({
    mutationFn: (attemptId: string) =>
      client.post<{ routeReopened: boolean }>(`/api/delivery/attempts/${attemptId}/cancel`, {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ACTIVE_KEY });
      showToast('Результат отменён', 'success');
    },
    onError: (error: unknown) => void afterFailure(error, 'Не удалось отменить результат.'),
  });

  if (active.isPending || reasons.isPending) return <LoadingState />;
  if (active.isError) {
    return (
      <ErrorState title="Не удалось загрузить доставки" onRetry={() => void active.refetch()} />
    );
  }

  const allRoutes = active.data?.routes ?? [];
  const returnItems = returns.data?.items ?? [];
  const reasonList = reasons.data?.items ?? [];
  const routes = groupRoutes(allRoutes, routeFilter === '' ? null : routeFilter);
  const minutes = moscowMinutesOfDay(now);

  if (allRoutes.length === 0) {
    // Возвраты показываются и без маршрутов: обязательство переживает маршрут.
    return (
      <div className="delivery">
        <ReturnsBlock
          items={returnItems}
          busy={departing.isPending}
          onDeparting={(orderId) => departing.mutate(orderId)}
        />
        <EmptyState
          title="Активных доставок нет"
          description="Маршрут появится здесь после того, как склад выдаст его курьеру."
        />
      </div>
    );
  }

  return (
    <div className="delivery">
      <ReturnsBlock
        items={returnItems}
        busy={departing.isPending}
        onDeparting={(orderId) => departing.mutate(orderId)}
      />
      <div className="delivery__filters">
        <Field label="Маршрут">
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={routeFilter}
              onChange={(event) => setRouteFilter(event.target.value)}
            >
              <option value="">Все маршруты</option>
              {allRoutes.map((route) => (
                <option key={route.routeId} value={route.routeId}>
                  {route.number}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      {routes.map((route) => (
        <section
          key={route.routeId}
          className="delivery__route"
          data-testid="delivery-route"
          data-route-number={route.number}
          data-remaining={remainingOf(route)}
          style={{ ['--route-accent' as string]: String(routeAccent(route.number)) }}
        >
          <header className="delivery__route-head">
            <span className="delivery__route-title">{route.number}</span>
            <span className="delivery__route-meta">
              {route.deliveryDate} · осталось {remainingOf(route)} из {route.orders.length}
              {route.courier === null ? '' : ` · ${route.courier.fullName}`}
            </span>
          </header>

          <div className="delivery__orders">
            {route.orders.map((order) => (
              <OrderCard
                key={order.routeOrderId}
                order={order}
                minutes={minutes}
                now={now}
                busy={record.isPending || cancel.isPending}
                onAsk={(nextOutcome) => {
                  setAsking({ order, outcome: nextOutcome });
                  setReasonId(null);
                }}
                onCancelResult={(attemptId) => cancel.mutate(attemptId)}
              />
            ))}
          </div>
        </section>
      ))}

      {/*
        Окно подтверждения результата.

        Одно на весь экран, а не по одному в каждой карточке: открыт всегда
        ровно один вопрос, и список под ним не перестраивается.
      */}
      <ResultDialog
        asking={asking}
        reasons={reasonList}
        reasonId={reasonId}
        busy={record.isPending}
        onReason={setReasonId}
        onCancel={resetDraft}
        onSubmit={() => {
          if (asking === null) return;
          /*
           * Комментарий не отправляется вовсе — даже пустой строкой.
           *
           * Пустая строка не «отсутствие пояснения», а пояснение из нуля
           * символов: база отвергает её отдельным ограничением, и посылать
           * такое значит выдумывать данные там, где их нет.
           */
          record.mutate({
            routeOrderId: asking.order.routeOrderId,
            outcome: asking.outcome,
            ...(asking.outcome === 'NOT_DELIVERED' && reasonId !== null ? { reasonId } : {}),
          });
        }}
      />
    </div>
  );
}

interface ResultDialogProps {
  asking: { order: ActiveOrderView; outcome: DeliveryOutcome } | null;
  reasons: FailureReasonView[];
  reasonId: string | null;
  busy: boolean;
  onReason: (reasonId: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

/**
 * Подтверждение результата доставки.
 *
 * Компактное окно на один вопрос. У «Доставлен» полей нет вовсе. У «Не
 * доставлен» — причины кнопками: курьер стоит у двери с коробкой в руках,
 * и попасть пальцем в крупную кнопку он может, а раскрывать список и
 * набирать текст — нет.
 *
 * Нажатие на причину только ВЫБИРАЕТ её. Запись происходит по «Подтвердить»:
 * результат отменяется всего пять минут, и случайное касание не должно
 * закрывать заказ. «Отмена» и крестик не отправляют ничего.
 */
function ResultDialog(props: ResultDialogProps): React.JSX.Element {
  const { asking } = props;
  const failed = asking?.outcome === 'NOT_DELIVERED';
  const choices = selectableReasons(props.reasons);
  /** Была ли попытка подтвердить: до неё упрекать человека не за что. */
  const [attempted, setAttempted] = useState(false);

  // Закрытое окно возвращается к чистому листу: следующий заказ начинается
  // без чужого упрёка на экране.
  const open = asking !== null;
  useEffect(() => {
    if (!open) {
      setAttempted(false);
    }
  }, [open]);

  const problem =
    asking === null
      ? null
      : resultDraftProblem(
          { outcome: asking.outcome, reasonId: props.reasonId, comment: '' },
          props.reasons,
        );

  return (
    <Modal
      open={asking !== null}
      title={asking === null ? '' : `${outcomeLabel(asking.outcome)}: заказ ${asking.order.number}`}
      onClose={props.onCancel}
      dismissible={!props.busy}
      testId="delivery-result-dialog"
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          if (problem === null) {
            props.onSubmit();
          }
        }}
      >
        {failed ? (
          <>
            <p className="text-sm muted">Что произошло?</p>
            <div className="delivery__reasons" data-testid="delivery-reasons">
              {choices.map((reason) => (
                <button
                  key={reason.id}
                  type="button"
                  className={`delivery__reason${
                    props.reasonId === reason.id ? ' delivery__reason--picked' : ''
                  }`}
                  data-testid="delivery-reason"
                  data-reason-code={reason.code}
                  aria-pressed={props.reasonId === reason.id}
                  disabled={props.busy}
                  onClick={() => props.onReason(reason.id)}
                >
                  {reason.name}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm muted">
            Заказ {asking?.order.number} будет отмечен доставленным. Отменить результат можно в
            течение пяти минут.
          </p>
        )}

        {/*
          Ошибка появляется ПОСЛЕ попытки, а не при открытии окна.

          Красная строка «Выберите причину» в момент, когда человек ещё ничего
          не сделал, — это упрёк за несовершённую ошибку. Кнопка подтверждения
          и без неё погашена, а объяснение нужно тому, кто уже попробовал
          подтвердить.
        */}
        {problem === null || !attempted ? null : (
          <p className="field__error" role="alert" data-testid="delivery-problem">
            {problem}
          </p>
        )}

        <div className="modal__footer">
          <Button
            variant="ghost"
            data-testid="delivery-dismiss"
            onClick={props.onCancel}
            disabled={props.busy}
          >
            Отмена
          </Button>
          <Button
            type="submit"
            variant="primary"
            data-testid="delivery-submit"
            disabled={props.busy || problem !== null}
          >
            Подтвердить
          </Button>
        </div>
      </form>
    </Modal>
  );
}

interface OrderCardProps {
  order: ActiveOrderView;
  minutes: number;
  now: Date;
  busy: boolean;
  onAsk: (outcome: DeliveryOutcome) => void;
  onCancelResult: (attemptId: string) => void;
}

function OrderCard(props: OrderCardProps): React.JSX.Element {
  const { order, minutes, now } = props;
  const position = intervalPosition(order, minutes);
  const done = order.result !== null;
  const link = routeLink(order.point);

  return (
    <article
      data-testid="delivery-order"
      data-order-number={order.number}
      data-result={order.result === null ? 'none' : order.result.outcome}
      data-interval={position}
      className={[
        'delivery__order',
        position === 'late' && !done ? 'delivery__order--late' : '',
        done ? 'delivery__order--done' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="delivery__order-head">
        <span className="delivery__order-number">
          {order.position}. {order.number}
        </span>
        <span className="delivery__order-muted">
          {minutesLabel(order.intervalStartMinute)}–{minutesLabel(order.intervalEndMinute)}
        </span>
      </div>

      {order.address === null ? null : (
        <div className="delivery__order-line">
          {/*
            Адрес ведёт в Яндекс Карты — к подтверждённой точке заказа, а не
            к строке адреса: по строке карты найдут «примерно тот» дом, а
            курьеру нужен именно тот, который подтвердил логист.

            Без подтверждённой точки ссылки нет: догаданная координата увела
            бы человека не туда с уверенным видом.
          */}
          {link === null ? (
            <span data-testid="delivery-address">{order.address}</span>
          ) : (
            <a
              className="delivery__address-link"
              data-testid="delivery-address"
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              title="Построить маршрут в Яндекс Картах"
            >
              {order.address}
            </a>
          )}
        </div>
      )}
      {order.recipient === null ? null : (
        <div className="delivery__order-muted">{order.recipient}</div>
      )}
      {order.comment === null ? null : <div className="delivery__order-muted">{order.comment}</div>}
      {order.cashCollectable ? (
        <div className="delivery__order-line">
          К получению: <strong>{formatCash(order.cashToCollectMinor)}</strong>
        </div>
      ) : null}

      {/*
        Отмена заказа, случившаяся уже в пути.
        Заказ не исчезает из маршрута: он физически в машине, и курьер обязан
        знать, что везти его больше не нужно, а надо вернуть.
      */}
      {order.cancelled ? (
        <p className="delivery__cancelled" data-testid="delivery-cancelled">
          Не доставлять — вернуть на склад.
        </p>
      ) : null}

      {position === 'early' && !done ? (
        <p className="delivery__warning" data-testid="delivery-early-warning">
          Интервал ещё не начался. Подтвердить можно — предупреждение не запрет.
        </p>
      ) : null}
      {position === 'late' && !done ? (
        <p className="delivery__warning">Интервал закончился: заказ опаздывает.</p>
      ) : null}

      {done ? <ResultRow result={order.result!} now={now} onCancel={props.onCancelResult} /> : null}

      {done ? null : (
        <div className="delivery__actions">
          <Button
            data-testid="delivery-open-delivered"
            onClick={() => props.onAsk('DELIVERED')}
            disabled={props.busy || order.cancelled}
          >
            Доставлен
          </Button>
          <Button
            data-testid="delivery-open-failed"
            variant="secondary"
            onClick={() => props.onAsk('NOT_DELIVERED')}
            disabled={props.busy}
          >
            Не доставлен
          </Button>
        </div>
      )}
    </article>
  );
}

function ResultRow({
  result,
  now,
  onCancel,
}: {
  result: AttemptView;
  now: Date;
  onCancel: (attemptId: string) => void;
}): React.JSX.Element {
  const leftMs = cancelWindowLeftMs(result, now);
  const leftMinutes = Math.ceil(leftMs / 60_000);

  return (
    <div className="delivery__order-line">
      <StatusBadge tone={result.outcome === 'DELIVERED' ? 'success' : 'error'}>
        {outcomeLabel(result.outcome)}
      </StatusBadge>
      {result.reasonName === null ? null : (
        <span className="delivery__order-muted"> · {result.reasonName}</span>
      )}
      {result.cancellable ? (
        <div className="delivery__actions">
          <Button
            data-testid="delivery-cancel-result"
            variant="secondary"
            onClick={() => onCancel(result.id)}
          >
            {leftMs > 0 ? `Отменить (${leftMinutes} мин)` : 'Отменить'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
