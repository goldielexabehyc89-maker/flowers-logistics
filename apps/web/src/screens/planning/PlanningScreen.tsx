/**
 * Экран «Планирование».
 *
 * Две фазы разделены и в интерфейсе. Кнопка «Рассчитать» не создаёт ни одного
 * маршрута — она ставит расчёт в очередь. Логист видит готовое ПРЕВЬЮ целиком:
 * маршруты, их состав и, отдельным блоком, заказы, которые никто не повезёт.
 * Черновики появляются только после нажатия «Применить».
 *
 * Условия расчёта показаны ДО кнопки: склад, смена и время обслуживания. Логист
 * должен видеть, из чего сложится план, а не узнавать об этом из отказа.
 *
 * Расчёт идёт в фоне, поэтому состояние опрашивается, пока запуск не завершится.
 * Готовое превью не перезапрашивается: оно неизменяемо.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Select,
  StatusBadge,
  TextInput,
  type StatusTone,
} from '../../ui/components';
import { formatMoscowDateTime } from '@fl/shared';
import { formatDate, moscowToday } from '../routing/routing';
import {
  assignedCount,
  availableCouriers,
  canApply,
  failureLabel,
  formatDistance,
  formatDuration,
  formatMinute,
  isRunning,
  needsUnassignedConfirmation,
  PLAN_STATE_LABELS,
  VEHICLE_LABELS,
  type CourierOption,
  type PlanRunState,
  type PlanRunView,
  type VehicleType,
} from './planning';
import '../routing/routing.css';

interface PlanListItem {
  id: string;
  deliveryDate: string;
  state: PlanRunState;
  version: number;
  failureCode: string | null;
  createdAt: string;
  slotCount: number;
}

interface PlanListResponse {
  items: PlanListItem[];
}

interface PlanningSettings {
  shift: { value: { startMinute: number; endMinute: number } | null; version: number };
  serviceTime: {
    value: { carMinutes: number; footMinutes: number };
    version: number;
    isDefault: boolean;
  };
}

interface DepotListResponse {
  items: { id: string; name: string; address: string; isActive: boolean; isDefault: boolean }[];
}

interface SlotDraft {
  vehicleType: VehicleType;
  capacityOrders: number;
  /** Пусто — машина без человека: её маршрут станет черновиком без курьера. */
  courierUserId: string | null;
}

/** Пока расчёт идёт, состояние перезапрашивается. Готовое превью — нет. */
const POLL_INTERVAL_MS = 3000;

export function PlanningScreen(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [date, setDate] = useState(moscowToday());
  const [slots, setSlots] = useState<SlotDraft[]>([
    { vehicleType: 'CAR', capacityOrders: 20, courierUserId: null },
  ]);
  /**
   * Открытый запуск восстанавливается из адреса.
   *
   * Обновление страницы и прямая ссылка обязаны возвращать тот же расчёт:
   * иначе логист, вернувшийся по ссылке, увидел бы список вместо того
   * превью, которое обсуждал.
   */
  const [params, setParams] = useSearchParams();
  const openRunId = params.get('run');
  const setOpenRunId = (value: string | null): void => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null) {
          next.delete('run');
        } else {
          next.set('run', value);
        }
        return next;
      },
      { replace: true },
    );
  };
  const [confirmingApply, setConfirmingApply] = useState(false);

  const settings = useQuery({
    queryKey: ['planning-settings'],
    queryFn: () => client.get<PlanningSettings>('/api/settings/planning'),
  });

  const depots = useQuery({
    queryKey: ['depots'],
    queryFn: () => client.get<DepotListResponse>('/api/depots'),
  });

  // Замороженные и лишённые роли курьера сюда не попадают: фильтрует сервер.
  // Скрытая строка списка не защита — сервер проверяет кандидата ещё раз, —
  // но предлагать человека, которого нельзя назначить, незачем.
  const couriers = useQuery({
    queryKey: ['couriers-for-planning'],
    queryFn: () =>
      client.get<{ items: CourierOption[] }>('/api/users?role=COURIER&status=ACTIVE&limit=100'),
  });

  const runs = useQuery({
    queryKey: ['route-plans', date],
    queryFn: () => client.get<PlanListResponse>(`/api/route-plans?deliveryDate=${date}`),
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((item) => isRunning(item.state))
        ? POLL_INTERVAL_MS
        : false,
  });

  const openRun = useQuery({
    queryKey: ['route-plan', openRunId],
    queryFn: () => client.get<PlanRunView>(`/api/route-plans/${openRunId ?? ''}`),
    enabled: openRunId !== null,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state !== undefined && isRunning(state) ? POLL_INTERVAL_MS : false;
    },
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['route-plans'] });
    await queryClient.invalidateQueries({ queryKey: ['route-plan'] });
  };

  const requestPlan = useMutation({
    mutationFn: (input: { replacePreviewId?: string }) =>
      client.post<PlanRunView>('/api/route-plans', {
        deliveryDate: date,
        slots: slots.map((slot) => ({
          courierUserId: slot.courierUserId,
          vehicleType: slot.vehicleType,
          capacityOrders: slot.capacityOrders,
        })),
        ...(input.replacePreviewId === undefined
          ? {}
          : { replacePreviewId: input.replacePreviewId }),
      }),
    onSuccess: async (run) => {
      setOpenRunId(run.id);
      await invalidate();
      showToast('Расчёт поставлен в очередь', 'success');
    },
    onError: (error: unknown) => showToast(errorText(error), 'error'),
  });

  const applyPlan = useMutation({
    mutationFn: (input: { runId: string; version: number; allowUnassigned: boolean }) =>
      client.post<PlanRunView & { alreadyApplied: boolean }>(
        `/api/route-plans/${input.runId}/apply`,
        { expectedVersion: input.version, allowUnassigned: input.allowUnassigned },
      ),
    onSuccess: async (run) => {
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: ['routes'] });
      showToast(
        run.alreadyApplied
          ? 'План уже был применён: черновики не создавались повторно'
          : `Создано черновиков: ${run.routeIds.length}`,
        'success',
      );
    },
    onError: (error: unknown) => showToast(errorText(error), 'error'),
  });

  const expirePlan = useMutation({
    mutationFn: (input: { runId: string; version: number }) =>
      client.post<PlanRunView>(`/api/route-plans/${input.runId}/expire`, {
        expectedVersion: input.version,
      }),
    onSuccess: async () => {
      await invalidate();
      showToast('Превью снято с рассмотрения', 'success');
    },
    onError: (error: unknown) => showToast(errorText(error), 'error'),
  });

  const shift = settings.data?.shift.value ?? null;
  const serviceTime = settings.data?.serviceTime ?? null;
  const defaultDepot = depots.data?.items.find((depot) => depot.isDefault) ?? null;
  const items = runs.data?.items ?? [];
  const activePreview = items.find((item) => item.state === 'PREVIEW') ?? null;
  const computing = items.find((item) => isRunning(item.state)) ?? null;
  const ready = shift !== null && defaultDepot !== null;

  return (
    <section className="routes">
      <header className="routes__header">
        <h2>Планирование маршрутов</h2>
        <Field label="Дата доставки">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                setOpenRunId(null);
              }}
            />
          )}
        </Field>
      </header>

      <section className="routes__panel">
        <div className="routes__panel-header">
          <h3>Условия расчёта</h3>
        </div>
        {settings.isPending || depots.isPending ? (
          <LoadingState />
        ) : (
          <ul className="routes__list">
            <li className="routes__list-item">
              Склад:{' '}
              {defaultDepot === null ? (
                <strong>не настроен — планирование недоступно</strong>
              ) : (
                `${defaultDepot.name}, ${defaultDepot.address}`
              )}
            </li>
            <li className="routes__list-item">
              Смена:{' '}
              {shift === null ? (
                <strong>не настроена — планирование недоступно</strong>
              ) : (
                `${formatMinute(shift.startMinute)} — ${formatMinute(shift.endMinute)}`
              )}
            </li>
            <li className="routes__list-item">
              Время на заказ: автомобиль {serviceTime?.value.carMinutes ?? '—'} мин, пешком{' '}
              {serviceTime?.value.footMinutes ?? '—'} мин
              {serviceTime?.isDefault === true ? ' (значения по умолчанию)' : ''}
            </li>
          </ul>
        )}
      </section>

      <section className="routes__panel">
        <div className="routes__panel-header">
          <h3>Машины</h3>
        </div>
        <p className="muted text-sm">Вместимость считается в заказах: один заказ — одна единица.</p>

        {slots.map((slot, index) => (
          <div className="routes__filters" key={index}>
            <Field label="Транспорт">
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  value={slot.vehicleType}
                  onChange={(event) =>
                    setSlots((current) =>
                      current.map((item, position) =>
                        position === index
                          ? { ...item, vehicleType: event.target.value as VehicleType }
                          : item,
                      ),
                    )
                  }
                >
                  <option value="CAR">{VEHICLE_LABELS.CAR}</option>
                  <option value="FOOT">{VEHICLE_LABELS.FOOT}</option>
                </Select>
              )}
            </Field>
            <Field label="Вместимость, заказов">
              {(fieldProps) => (
                <TextInput
                  {...fieldProps}
                  type="number"
                  min={1}
                  max={500}
                  value={String(slot.capacityOrders)}
                  onChange={(event) =>
                    setSlots((current) =>
                      current.map((item, position) =>
                        position === index
                          ? { ...item, capacityOrders: Number(event.target.value) || 1 }
                          : item,
                      ),
                    )
                  }
                />
              )}
            </Field>
            <Field label="Курьер">
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  data-testid={`slot-courier-${index}`}
                  value={slot.courierUserId ?? ''}
                  onChange={(event) =>
                    setSlots((current) =>
                      current.map((item, position) =>
                        position === index
                          ? {
                              ...item,
                              courierUserId: event.target.value === '' ? null : event.target.value,
                            }
                          : item,
                      ),
                    )
                  }
                >
                  <option value="">Без курьера</option>
                  {availableCouriers(
                    couriers.data?.items ?? [],
                    slots.map((item) => item.courierUserId),
                    index,
                  ).map((courier) => (
                    <option key={courier.id} value={courier.id}>
                      {courier.fullName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="routes__filter-actions">
              <Button
                disabled={slots.length === 1}
                onClick={() => setSlots((current) => current.filter((_, i) => i !== index))}
              >
                Убрать
              </Button>
            </div>
          </div>
        ))}

        <div className="routes__panel-actions">
          <Button
            onClick={() =>
              setSlots((current) => [
                ...current,
                { vehicleType: 'CAR', capacityOrders: 20, courierUserId: null },
              ])
            }
          >
            Добавить машину
          </Button>
          <Button
            variant="primary"
            loading={requestPlan.isPending}
            disabled={!ready || computing !== null}
            onClick={() =>
              requestPlan.mutate(
                activePreview === null ? {} : { replacePreviewId: activePreview.id },
              )
            }
          >
            {activePreview === null ? 'Рассчитать' : 'Рассчитать заново, заменив превью'}
          </Button>
        </div>

        {computing === null ? null : (
          <p className="muted text-sm">
            На {formatDate(date)} уже идёт расчёт. Дождитесь его завершения.
          </p>
        )}
      </section>

      <section className="routes__panel">
        <div className="routes__panel-header">
          <h3>Расчёты за {formatDate(date)}</h3>
        </div>

        {runs.isPending ? <LoadingState /> : null}
        {runs.isError ? <ErrorState onRetry={() => void runs.refetch()} /> : null}
        {!runs.isPending && items.length === 0 ? (
          <EmptyState title="Расчётов за этот день нет" />
        ) : null}

        <ul className="routes__list">
          {items.map((item) => (
            <li className="routes__list-item" key={item.id}>
              <button
                type="button"
                className="routes__number-button"
                aria-pressed={openRunId === item.id}
                onClick={() => setOpenRunId(item.id)}
              >
                {formatMoscowDateTime(item.createdAt)}
              </button>{' '}
              <StatusBadge tone={toneOf(item.state)}>{PLAN_STATE_LABELS[item.state]}</StatusBadge>{' '}
              <span className="muted text-sm">машин: {item.slotCount}</span>
            </li>
          ))}
        </ul>
      </section>

      {openRun.data === undefined ? null : (
        <PreviewPanel
          run={openRun.data}
          busy={applyPlan.isPending || expirePlan.isPending}
          onApply={() => {
            const run = openRun.data;
            if (run === undefined) {
              return;
            }
            if (needsUnassignedConfirmation(run)) {
              setConfirmingApply(true);
              return;
            }
            applyPlan.mutate({ runId: run.id, version: run.version, allowUnassigned: false });
          }}
          onExpire={() => {
            const run = openRun.data;
            if (run !== undefined) {
              expirePlan.mutate({ runId: run.id, version: run.version });
            }
          }}
        />
      )}

      <ConfirmDialog
        open={confirmingApply && openRun.data !== undefined}
        title="Применить план с неразмещёнными заказами?"
        description={
          `${openRun.data?.preview?.unassignedOrderIds.length ?? 0} заказ(ов) останутся ` +
          'нераспределёнными: их никто не повезёт. Распределить их можно будет вручную.'
        }
        confirmLabel="Применить частично"
        busy={applyPlan.isPending}
        onConfirm={() => {
          const run = openRun.data;
          setConfirmingApply(false);
          if (run !== undefined) {
            applyPlan.mutate({ runId: run.id, version: run.version, allowUnassigned: true });
          }
        }}
        onCancel={() => setConfirmingApply(false)}
      />
    </section>
  );
}

function PreviewPanel({
  run,
  busy,
  onApply,
  onExpire,
}: {
  run: PlanRunView;
  busy: boolean;
  onApply: () => void;
  onExpire: () => void;
}): React.JSX.Element {
  const failure = failureLabel(run.failureCode);
  const routes = run.preview?.routes.filter((route) => route.stops.length > 0) ?? [];

  return (
    <section className="routes__panel" data-plan-state={run.state}>
      <div className="routes__panel-header">
        <h3>
          Расчёт от {formatMoscowDateTime(run.createdAt)} — {PLAN_STATE_LABELS[run.state]}
        </h3>
      </div>

      {isRunning(run.state) ? <LoadingState title="Считаем маршруты…" /> : null}
      {failure === null ? null : <p className="muted text-sm">{failure}</p>}

      {run.preview === null ? null : (
        <>
          <p className="text-sm">
            Маршрутов: {routes.length}, размещено заказов: {assignedCount(run.preview)}, не
            размещено: {run.preview.unassignedOrderIds.length}
          </p>

          {routes.map((route) => (
            <article className="routes__card" key={route.slotId}>
              <h4>
                Машина {route.slotIndex} — {VEHICLE_LABELS[route.vehicleType]}
              </h4>
              <p className="muted text-sm">
                В пути {formatDuration(route.travelSeconds)}, обслуживание{' '}
                {formatDuration(route.serviceSeconds)}, {formatDistance(route.distanceMeters)}
              </p>
              <ol className="routes__stops">
                {route.stops.map((stop) => (
                  <li className="routes__stop" key={stop.orderId}>
                    <span className="routes__position">{stop.position}</span>
                    <span className="routes__stop-body-text">
                      заказ {stop.orderId.slice(0, 8)} — прибытие {formatMinute(stop.arrivalMinute)}
                    </span>
                  </li>
                ))}
              </ol>
            </article>
          ))}

          {run.preview.unassignedOrderIds.length === 0 ? null : (
            <article className="routes__card" data-testid="plan-unassigned">
              <h4>Не размещены</h4>
              <p className="muted text-sm">
                Эти заказы никто не повезёт. Применить план вместе с ними можно только отдельным
                подтверждением.
              </p>
              <ul className="routes__list">
                {run.preview.unassignedOrderIds.map((orderId) => (
                  <li className="routes__list-item" key={orderId}>
                    заказ {orderId.slice(0, 8)}
                  </li>
                ))}
              </ul>
            </article>
          )}
        </>
      )}

      {run.state === 'APPLIED' ? (
        <p className="text-sm">Создано черновиков: {run.routeIds.length}</p>
      ) : null}

      {run.state === 'PREVIEW' ? (
        <div className="routes__panel-actions">
          <Button variant="primary" disabled={busy || !canApply(run)} onClick={onApply}>
            Применить
          </Button>
          <Button disabled={busy} onClick={onExpire}>
            Снять с рассмотрения
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function toneOf(state: PlanRunState): StatusTone {
  switch (state) {
    case 'PREVIEW':
      return 'warning';
    case 'APPLIED':
      return 'success';
    case 'FAILED':
      return 'error';
    default:
      return 'neutral';
  }
}

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Не удалось выполнить операцию';
}
