/**
 * Предложенный расчёт: видимая стадия перед созданием черновиков.
 *
 * До явного «Применить» черновиков не существует. Логист видит, что именно
 * предложено — маршруты, порядок остановок, время и расстояние, — и решает
 * сам. Прежде расчёт молча превращался в черновики, и проверять было уже
 * нечего: отменить их можно было только вручную, по одному.
 *
 * «Отклонить» ничего не создаёт: расчёт снимается с рассмотрения и остаётся
 * в истории. Неразмещённые заказы требуют отдельного согласия — заказ,
 * который никто не повезёт, не должен уехать в работу молча.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import { Button, ConfirmDialog, ErrorState, LoadingState, StatusBadge } from '../../ui/components';
import { conflictMessage, VEHICLE_LABELS } from './routing';
import {
  assignedCount,
  canApply,
  formatDistance,
  formatDuration,
  formatMinute,
  formatWindow,
  needsPartialConsent,
  orderOf,
  plannedRoutes,
  unassignedLabel,
  unassignedWithReasons,
  type PlanRunView,
} from './preview';

export interface PreviewPanelProps {
  runId: string;
  /** Расчёт применён: показать созданные черновики. */
  onApplied: (firstDraftId: string | null) => void;
  /** Расчёт отклонён либо закрыт: вернуться к черновикам дня. */
  onDismissed: () => void;
}

/** Пока решатель считает, состояние опрашивается. */
const POLL_INTERVAL_MS = 2000;

export function PreviewPanel({
  runId,
  onApplied,
  onDismissed,
}: PreviewPanelProps): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [confirmingPartial, setConfirmingPartial] = useState(false);

  const runQuery = useQuery({
    queryKey: ['route-plan', runId],
    queryFn: () => client.get<PlanRunView>(`/api/route-plans/${runId}`),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'QUEUED' || state === 'COMPUTING' ? POLL_INTERVAL_MS : false;
    },
  });

  const failure = (error: unknown): void => {
    const kind = error instanceof ApiError ? (error.conflict?.kind ?? undefined) : undefined;
    showToast(
      error instanceof ApiError
        ? conflictMessage(kind, error.message)
        : 'Не удалось выполнить операцию. Повторите попытку.',
      'error',
    );
    void queryClient.invalidateQueries({ queryKey: ['route-plan', runId] });
  };

  const applyPlan = useMutation({
    mutationFn: (input: { allowUnassigned: boolean }) =>
      client.post<PlanRunView & { routeIds: string[] }>(`/api/route-plans/${runId}/apply`, {
        expectedVersion: runQuery.data?.version ?? 0,
        allowUnassigned: input.allowUnassigned,
      }),
    onSuccess: (applied) => {
      setConfirmingPartial(false);
      showToast(`Создано черновиков: ${applied.routeIds.length}`, 'success');
      void queryClient.invalidateQueries({ queryKey: ['routes'] });
      void queryClient.invalidateQueries({ queryKey: ['map-points'] });
      onApplied(applied.routeIds[0] ?? null);
    },
    onError: (error: unknown) => {
      setConfirmingPartial(false);
      failure(error);
    },
  });

  const dismissPlan = useMutation({
    mutationFn: () =>
      client.post<PlanRunView>(`/api/route-plans/${runId}/expire`, {
        expectedVersion: runQuery.data?.version ?? 0,
      }),
    onSuccess: () => {
      // Черновиков не создано: отклонение ничего не оставляет после себя,
      // кроме записи в истории расчётов.
      showToast('Расчёт отклонён, черновики не создавались', 'success');
      void queryClient.invalidateQueries({ queryKey: ['route-plan', runId] });
      onDismissed();
    },
    onError: failure,
  });

  if (runQuery.isPending) {
    return (
      <section className="routes__panel">
        <LoadingState title="Загружаем расчёт…" />
      </section>
    );
  }

  if (runQuery.isError || runQuery.data === undefined) {
    return (
      <section className="routes__panel">
        <ErrorState title="Не удалось загрузить расчёт" onRetry={() => void runQuery.refetch()} />
      </section>
    );
  }

  const run = runQuery.data;
  const plan = run.preview;
  const busy = applyPlan.isPending || dismissPlan.isPending;

  return (
    <section className="routes__panel routes__preview" data-plan-state={run.state}>
      <header className="routes__panel-header">
        <h3>Предложенный расчёт</h3>
        <StatusBadge tone={run.state === 'PREVIEW' ? 'warning' : 'neutral'}>
          {run.state === 'PREVIEW' ? 'черновики ещё не созданы' : run.state}
        </StatusBadge>
      </header>

      {(run.state === 'QUEUED' || run.state === 'COMPUTING') && (
        <LoadingState title="Считаем маршруты…" />
      )}

      {run.state === 'FAILED' && (
        <p className="routes__hint" role="status">
          Расчёт не удался. Черновики не создавались — проверьте условия и повторите.
        </p>
      )}

      {run.state === 'EXPIRED' && (
        <p className="routes__hint" role="status">
          Расчёт снят с рассмотрения. Черновики не создавались.
        </p>
      )}

      {plan !== null && (
        <>
          <p className="text-sm">
            Маршрутов: {plannedRoutes(plan).length}, размещено заказов: {assignedCount(plan)}, не
            размещено: {plan.unassignedOrderIds.length}
          </p>

          {plannedRoutes(plan).map((route) => (
            <article
              className="routes__card"
              key={route.slotId}
              data-preview-route={route.slotIndex}
            >
              <h4>
                Машина {route.slotIndex} — {VEHICLE_LABELS[route.vehicleType]}
              </h4>
              <p className="muted text-sm">
                В пути {formatDuration(route.travelSeconds)}, обслуживание{' '}
                {formatDuration(route.serviceSeconds)}, {formatDistance(route.distanceMeters)}
              </p>
              <ol className="routes__stops">
                {route.stops.map((stop) => {
                  const order = orderOf(run, stop.orderId);
                  return (
                    <li className="routes__stop" key={stop.orderId}>
                      <span className="routes__position">{stop.position}</span>
                      <div className="routes__stop-body">
                        <div className="routes__stop-head">
                          <span className="routes__number">{order.number}</span>
                          <span>прибытие {formatMinute(stop.arrivalMinute)}</span>
                          <span className="muted text-sm">окно {formatWindow(order)}</span>
                        </div>
                        <span className="routes__stop-body-text">{order.address ?? '—'}</span>
                        {order.addressDetails !== null && (
                          <span className="routes__stop-body-text muted text-sm">
                            {order.addressDetails}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </article>
          ))}

          {plan.unassignedOrderIds.length > 0 && (
            <article className="routes__card" data-testid="plan-unassigned">
              <h4>Не размещены</h4>
              <p className="muted text-sm">
                Эти заказы никто не повезёт. Применить расчёт вместе с ними можно только отдельным
                подтверждением.
              </p>
              <ul className="routes__list">
                {unassignedWithReasons(plan).map((item) => {
                  const order = orderOf(run, item.orderId);
                  return (
                    <li className="routes__list-item" key={item.orderId}>
                      <div>
                        <span className="routes__number">{order.number}</span>{' '}
                        <span className="muted text-sm">
                          {order.address ?? '—'}
                          {order.addressDetails === null ? '' : ` · ${order.addressDetails}`}
                        </span>
                        <div className="muted text-sm">{unassignedLabel(item.reason)}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </article>
          )}
        </>
      )}

      <div className="routes__panel-actions">
        {run.state === 'PREVIEW' ? (
          <>
            <Button
              variant="primary"
              data-testid="preview-apply"
              disabled={busy || !canApply(run)}
              onClick={() => {
                if (needsPartialConsent(run)) {
                  setConfirmingPartial(true);
                  return;
                }
                applyPlan.mutate({ allowUnassigned: false });
              }}
            >
              Применить
            </Button>
            <Button
              variant="danger"
              data-testid="preview-dismiss"
              disabled={busy}
              onClick={() => dismissPlan.mutate()}
            >
              Отклонить
            </Button>
          </>
        ) : (
          <Button data-testid="preview-close" onClick={onDismissed}>
            Вернуться к черновикам
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmingPartial}
        title="Применить расчёт с неразмещёнными заказами?"
        description={
          `${run.preview?.unassignedOrderIds.length ?? 0} заказ(ов) останутся нераспределёнными: ` +
          'их никто не повезёт. Распределить их можно будет вручную.'
        }
        confirmLabel="Применить частично"
        busy={applyPlan.isPending}
        onConfirm={() => applyPlan.mutate({ allowUnassigned: true })}
        onCancel={() => setConfirmingPartial(false)}
      />
    </section>
  );
}
