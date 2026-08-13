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
  Select,
  StatusBadge,
  TextInput,
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
  type ActiveOrderView,
  type ActiveRouteView,
  type AttemptView,
  type DeliveryOutcome,
  type FailureReasonView,
} from './delivery-flow';
import './delivery.css';

const ACTIVE_KEY = ['delivery-active'];

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
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<DeliveryOutcome | null>(null);
  const [reasonId, setReasonId] = useState<string | null>(null);
  const [comment, setComment] = useState('');
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

  const reasons = useQuery({
    queryKey: ['delivery-reasons'],
    queryFn: () => client.get<{ items: FailureReasonView[] }>('/api/delivery/failure-reasons'),
  });

  function resetDraft(): void {
    setOpenOrderId(null);
    setOutcome(null);
    setReasonId(null);
    setComment('');
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
  const reasonList = reasons.data?.items ?? [];
  const routes = groupRoutes(allRoutes, routeFilter === '' ? null : routeFilter);
  const minutes = moscowMinutesOfDay(now);

  if (allRoutes.length === 0) {
    return (
      <EmptyState
        title="Активных доставок нет"
        description="Маршрут появится здесь после того, как склад выдаст его курьеру."
      />
    );
  }

  return (
    <div className="delivery">
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
                reasons={reasonList}
                open={openOrderId === order.routeOrderId}
                busy={record.isPending || cancel.isPending}
                outcome={outcome}
                reasonId={reasonId}
                comment={comment}
                onOpen={(nextOutcome) => {
                  setOpenOrderId(order.routeOrderId);
                  setOutcome(nextOutcome);
                  setReasonId(null);
                  setComment('');
                }}
                onOutcome={setOutcome}
                onReason={setReasonId}
                onComment={setComment}
                onCancelDraft={resetDraft}
                onSubmit={() => {
                  if (outcome === null) return;
                  record.mutate({
                    routeOrderId: order.routeOrderId,
                    outcome,
                    ...(reasonId === null ? {} : { reasonId }),
                    ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
                  });
                }}
                onCancelResult={(attemptId) => cancel.mutate(attemptId)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

interface OrderCardProps {
  order: ActiveOrderView;
  minutes: number;
  now: Date;
  reasons: FailureReasonView[];
  open: boolean;
  busy: boolean;
  outcome: DeliveryOutcome | null;
  reasonId: string | null;
  comment: string;
  onOpen: (outcome: DeliveryOutcome) => void;
  onOutcome: (outcome: DeliveryOutcome) => void;
  onReason: (reasonId: string) => void;
  onComment: (comment: string) => void;
  onCancelDraft: () => void;
  onSubmit: () => void;
  onCancelResult: (attemptId: string) => void;
}

function OrderCard(props: OrderCardProps): React.JSX.Element {
  const { order, minutes, now, reasons } = props;
  const position = intervalPosition(order, minutes);
  const done = order.result !== null;

  const problem =
    props.outcome === null
      ? null
      : resultDraftProblem(
          { outcome: props.outcome, reasonId: props.reasonId, comment: props.comment },
          reasons,
        );

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

      {order.address === null ? null : <div className="delivery__order-line">{order.address}</div>}
      {order.recipient === null ? null : (
        <div className="delivery__order-muted">{order.recipient}</div>
      )}
      {order.comment === null ? null : <div className="delivery__order-muted">{order.comment}</div>}
      {order.cashCollectable ? (
        <div className="delivery__order-line">
          К получению: <strong>{formatCash(order.cashToCollectMinor)}</strong>
        </div>
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

      {done ? null : props.open ? (
        <div className="delivery__form">
          <Field label="Результат">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={props.outcome ?? ''}
                onChange={(event) => props.onOutcome(event.target.value as DeliveryOutcome)}
              >
                <option value="DELIVERED">Доставлен</option>
                <option value="NOT_DELIVERED">Не доставлен</option>
              </Select>
            )}
          </Field>

          {props.outcome === 'NOT_DELIVERED' ? (
            <>
              <Field label="Причина">
                {(fieldProps) => (
                  <Select
                    {...fieldProps}
                    value={props.reasonId ?? ''}
                    onChange={(event) => props.onReason(event.target.value)}
                  >
                    <option value="">Выберите причину</option>
                    {reasons
                      .filter((reason) => reason.isActive)
                      .map((reason) => (
                        <option key={reason.id} value={reason.id}>
                          {reason.name}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
              <Field label="Комментарий" hint="Обязателен для причины «Другое»">
                {(fieldProps) => (
                  <TextInput
                    {...fieldProps}
                    value={props.comment}
                    onChange={(event) => props.onComment(event.target.value)}
                  />
                )}
              </Field>
            </>
          ) : null}

          {problem === null ? null : <p className="delivery__warning">{problem}</p>}

          <div className="delivery__actions">
            <Button
              data-testid="delivery-submit"
              onClick={props.onSubmit}
              disabled={props.busy || problem !== null}
            >
              Подтвердить
            </Button>
            <Button variant="secondary" onClick={props.onCancelDraft} disabled={props.busy}>
              Отмена
            </Button>
          </div>
        </div>
      ) : (
        <div className="delivery__actions">
          <Button
            data-testid="delivery-open-delivered"
            onClick={() => props.onOpen('DELIVERED')}
            disabled={props.busy}
          >
            Доставлен
          </Button>
          <Button
            data-testid="delivery-open-failed"
            variant="secondary"
            onClick={() => props.onOpen('NOT_DELIVERED')}
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
