/**
 * Рабочий экран склада: «Склад», «Сборка», «Выдача».
 *
 * Интерфейс рассчитан на сканер, который работает как клавиатура: поле ввода
 * само получает фокус и очищается после успешного шага, а `Enter` подтверждает
 * значение. Ручной ввод остаётся доступным везде — сканер ломается чаще, чем
 * заканчивается рабочий день.
 *
 * Ошибка не теряет уже подтверждённый прогресс: неудачный второй скан
 * возвращает к сканированию ячейки, а не сбрасывает заказ.
 *
 * Ни адреса, ни получателя, ни состава заказа здесь нет — сервер их не отдаёт.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { moscowToday } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  StatusBadge,
  TextInput,
} from '../../ui/components';
import {
  CELL_KIND_LABELS,
  SCAN_HINTS,
  blockLabel,
  cellLabel,
  issueBlocker,
  issueProgress,
  pickProgress,
  type PlacedOrderView,
  type RouteFlowView,
  type RouteSummary,
  type ScanContext,
} from './warehouse-flow';

type Tab = 'storage' | 'picking' | 'issue';

const TABS: readonly { key: Tab; title: string }[] = [
  { key: 'storage', title: 'Склад' },
  { key: 'picking', title: 'Сборка' },
  { key: 'issue', title: 'Выдача' },
];

export function WarehouseScreen(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('storage');

  return (
    <section className="stack">
      <div className="card stack">
        <div>
          <h2>Склад</h2>
          <p className="muted text-sm">
            Приёмка собранных заказов в ячейки, комплектование подтверждённых маршрутных листов и
            выдача курьеру. Поля работают со сканером и с ручным вводом.
          </p>
        </div>
        <div className="row" role="tablist">
          {TABS.map((item) => (
            <Button
              key={item.key}
              variant={tab === item.key ? 'primary' : 'ghost'}
              role="tab"
              aria-selected={tab === item.key}
              data-testid={`wh-tab-${item.key}`}
              onClick={() => setTab(item.key)}
            >
              {item.title}
            </Button>
          ))}
        </div>
      </div>

      {tab === 'storage' && <StorageTab />}
      {tab === 'picking' && <RouteTab mode="picking" />}
      {tab === 'issue' && <RouteTab mode="issue" />}
    </section>
  );
}

/** Поле, которое ведёт себя как приёмник сканера. */
function ScanField({
  label,
  hint,
  value,
  onChange,
  onSubmit,
  autoFocus,
  testId,
  disabled,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  autoFocus: boolean;
  testId: string;
  disabled: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (autoFocus && !disabled) {
      ref.current?.focus();
    }
  }, [autoFocus, disabled]);

  return (
    <Field label={label} hint={hint}>
      {(fieldProps) => (
        <TextInput
          {...fieldProps}
          ref={ref}
          data-testid={testId}
          value={value}
          disabled={disabled}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Сканер завершает ввод переводом строки: это и есть подтверждение.
            if (event.key === 'Enter') {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
      )}
    </Field>
  );
}

function useApiError(): (error: unknown, fallback: string) => void {
  const { showToast } = useToast();
  return (error: unknown, fallback: string) => {
    showToast(error instanceof ApiError ? error.message : fallback, 'error');
  };
}

// --- Вкладка «Склад» ---------------------------------------------------------

function StorageTab(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const reportError = useApiError();

  const [orderInput, setOrderInput] = useState('');
  const [cellInput, setCellInput] = useState('');
  const [scanned, setScanned] = useState<ScanContext | null>(null);

  const placements = useQuery({
    queryKey: ['warehouse-placements'],
    queryFn: () =>
      client.get<{ items: PlacedOrderView[]; total: number }>(
        '/api/warehouse/placements?limit=100',
      ),
  });

  const lookup = useMutation({
    mutationFn: (number: string) =>
      client.get<ScanContext>(`/api/warehouse/scan/order?number=${encodeURIComponent(number)}`),
    onSuccess: (context) => {
      setScanned(context);
      setOrderInput('');
    },
    onError: (error: unknown) => reportError(error, 'Не удалось распознать заказ.'),
  });

  const receive = useMutation({
    mutationFn: (input: { orderNumber: string; cellCode: string; allowRouteCell?: boolean }) =>
      client.post<{ orderNumber: string; cellCode: string; unchanged: boolean }>(
        '/api/warehouse/placements',
        input,
      ),
    onSuccess: async (result) => {
      // Прогресс подтверждён: сбрасываем оба поля и возвращаемся к первому шагу.
      setScanned(null);
      setCellInput('');
      await queryClient.invalidateQueries({ queryKey: ['warehouse-placements'] });
      showToast(
        result.unchanged
          ? `Заказ ${result.orderNumber} уже лежит в ячейке ${result.cellCode}`
          : `Заказ ${result.orderNumber} принят в ячейку ${result.cellCode}`,
        'success',
      );
    },
    onError: (error: unknown) => {
      // Заказ остаётся подтверждённым: человек повторяет только скан ячейки.
      setCellInput('');
      reportError(error, 'Не удалось разместить заказ.');
    },
  });

  function submitCell(allowRouteCell?: boolean): void {
    if (scanned === null || cellInput.trim() === '') {
      return;
    }
    receive.mutate({
      orderNumber: scanned.orderNumber,
      cellCode: cellInput,
      ...(allowRouteCell === undefined ? {} : { allowRouteCell }),
    });
  }

  return (
    <>
      <div className="card stack">
        <h3>Приёмка</h3>

        {scanned === null ? (
          <ScanField
            label="Заказ"
            hint={SCAN_HINTS.ORDER}
            value={orderInput}
            onChange={setOrderInput}
            onSubmit={() => orderInput.trim() !== '' && lookup.mutate(orderInput)}
            autoFocus
            testId="wh-scan-order"
            disabled={lookup.isPending}
          />
        ) : (
          <div className="stack">
            <div className="row">
              <div>
                <div className="field__label">Заказ</div>
                <strong data-testid="wh-scanned-order">{scanned.orderNumber}</strong>
              </div>
              {scanned.currentCell !== null && (
                <div>
                  <div className="field__label">Сейчас лежит</div>
                  <span>{scanned.currentCell.code}</span>
                </div>
              )}
              <Button
                variant="ghost"
                data-testid="wh-scan-reset"
                onClick={() => {
                  setScanned(null);
                  setCellInput('');
                }}
              >
                Отменить
              </Button>
            </div>

            {scanned.blockedBy.length > 0 && (
              <p className="field__error" role="alert" data-testid="wh-order-blocked">
                {scanned.blockedBy.map(blockLabel).join('; ')}. Разместить заказ можно, но
                комплектование и выдача заблокированы.
              </p>
            )}

            {scanned.route !== null && (
              <p className="muted text-sm" data-testid="wh-order-route">
                Заказ входит в подтверждённый лист {scanned.route.number}
                {scanned.route.routeCell === null
                  ? '. Маршрутная ячейка ещё не привязана.'
                  : `. Маршрутная ячейка: ${scanned.route.routeCell.code}.`}
              </p>
            )}

            <ScanField
              label="Ячейка"
              hint={SCAN_HINTS.CELL}
              value={cellInput}
              onChange={setCellInput}
              onSubmit={() => submitCell()}
              autoFocus
              testId="wh-scan-cell"
              disabled={receive.isPending}
            />

            <div className="row">
              <Button
                variant="primary"
                data-testid="wh-place"
                disabled={receive.isPending || cellInput.trim() === ''}
                onClick={() => submitCell()}
              >
                {receive.isPending ? 'Сохраняем…' : 'Положить в ячейку'}
              </Button>
              {scanned.route !== null && (
                <Button
                  variant="secondary"
                  data-testid="wh-place-route"
                  disabled={receive.isPending || cellInput.trim() === ''}
                  onClick={() => submitCell(true)}
                >
                  Это маршрутная ячейка
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="card stack">
        <h3>Сейчас на складе</h3>
        {placements.isPending && <LoadingState title="Загружаем размещения…" />}
        {placements.isError && (
          <ErrorState
            description="Список размещений не загрузился."
            onRetry={() => void placements.refetch()}
          />
        )}
        {placements.isSuccess && placements.data.items.length === 0 && (
          <EmptyState
            title="На складе пусто"
            description="Отсканируйте заказ и ячейку, чтобы принять его."
          />
        )}
        {placements.isSuccess && placements.data.items.length > 0 && (
          <PlacementTable items={placements.data.items} />
        )}
      </div>
    </>
  );
}

function PlacementTable({ items }: { items: PlacedOrderView[] }): React.JSX.Element {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Заказ</th>
            <th>Ячейка</th>
            <th>Тип</th>
            <th>Маршрут</th>
            <th>Пометки</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.orderId} data-testid="wh-placement-row">
              <td>
                <strong>{item.orderNumber}</strong>
              </td>
              <td>{cellLabel(item)}</td>
              <td className="muted">
                {item.cellKind === null ? '—' : CELL_KIND_LABELS[item.cellKind]}
              </td>
              <td className="muted">{item.routeNumber ?? '—'}</td>
              <td>
                {item.requiresRelocation && <StatusBadge tone="warning">Переместить</StatusBadge>}
                {item.blockedBy.map((flag) => (
                  <StatusBadge key={flag} tone="error">
                    {blockLabel(flag)}
                  </StatusBadge>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Вкладки «Сборка» и «Выдача» ---------------------------------------------

function RouteTab({ mode }: { mode: 'picking' | 'issue' }): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const reportError = useApiError();

  const [date, setDate] = useState(moscowToday());
  const [routeId, setRouteId] = useState<string | null>(null);
  const [cellInput, setCellInput] = useState('');
  const [orderInput, setOrderInput] = useState('');

  const routes = useQuery({
    queryKey: ['warehouse-routes', date],
    queryFn: () =>
      client.get<{ items: RouteSummary[] }>(`/api/warehouse/routes?deliveryDate=${date}`),
  });

  const route = useQuery({
    queryKey: ['warehouse-route', routeId],
    queryFn: () => client.get<RouteFlowView>(`/api/warehouse/routes/${routeId ?? ''}`),
    enabled: routeId !== null,
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['warehouse-route'] });
    await queryClient.invalidateQueries({ queryKey: ['warehouse-routes'] });
    await queryClient.invalidateQueries({ queryKey: ['warehouse-placements'] });
  };

  const bindCell = useMutation({
    mutationFn: () =>
      client.put<{ cellCode: string }>(`/api/warehouse/routes/${routeId ?? ''}/cell`, {
        cellCode: cellInput,
      }),
    onSuccess: async (result) => {
      setCellInput('');
      await refresh();
      showToast(`Маршрутная ячейка ${result.cellCode} привязана`, 'success');
    },
    onError: (error: unknown) => reportError(error, 'Не удалось привязать ячейку.'),
  });

  const pick = useMutation({
    mutationFn: (cellCode: string) =>
      client.post<{ orderNumber: string; picked: number; total: number }>(
        `/api/warehouse/routes/${routeId ?? ''}/pick`,
        { orderNumber: orderInput, cellCode },
      ),
    onSuccess: async (result) => {
      setOrderInput('');
      await refresh();
      showToast(`Заказ ${result.orderNumber}: ${result.picked} из ${result.total}`, 'success');
    },
    onError: (error: unknown) => {
      setOrderInput('');
      reportError(error, 'Не удалось перенести заказ.');
    },
  });

  const confirmCourier = useMutation({
    mutationFn: (courierUserId: string) =>
      client.post(`/api/warehouse/routes/${routeId ?? ''}/courier`, { courierUserId }),
    onSuccess: async () => {
      await refresh();
      showToast('Курьер подтверждён', 'success');
    },
    onError: (error: unknown) => reportError(error, 'Не удалось подтвердить курьера.'),
  });

  const issue = useMutation({
    mutationFn: () =>
      client.post<{ orderNumber: string; issued: number; total: number; routeActivated: boolean }>(
        `/api/warehouse/routes/${routeId ?? ''}/issue`,
        { orderNumber: orderInput },
      ),
    onSuccess: async (result) => {
      setOrderInput('');
      await refresh();
      showToast(
        result.routeActivated
          ? `Выдан последний заказ: маршрут передан курьеру`
          : `Заказ ${result.orderNumber} выдан: ${result.issued} из ${result.total}`,
        'success',
      );
    },
    onError: (error: unknown) => {
      setOrderInput('');
      reportError(error, 'Не удалось выдать заказ.');
    },
  });

  const view = route.data ?? null;

  return (
    <>
      <div className="card stack">
        <div className="row">
          <Field label="Дата доставки">
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                type="date"
                value={date}
                data-testid="wh-route-date"
                onChange={(event) => {
                  setDate(event.target.value);
                  setRouteId(null);
                }}
              />
            )}
          </Field>
        </div>

        {routes.isPending && <LoadingState title="Загружаем маршрутные листы…" />}
        {routes.isError && (
          <ErrorState
            description="Маршрутные листы не загрузились."
            onRetry={() => void routes.refetch()}
          />
        )}
        {routes.isSuccess && routes.data.items.length === 0 && (
          <EmptyState
            title="Подтверждённых листов на эту дату нет"
            description="Комплектование начинается после подтверждения маршрута логистом."
          />
        )}
        {routes.isSuccess && routes.data.items.length > 0 && (
          <div className="row">
            {routes.data.items.map((summary) => (
              <Button
                key={summary.routeId}
                variant={routeId === summary.routeId ? 'primary' : 'ghost'}
                data-testid="wh-route-button"
                data-route-number={summary.routeNumber}
                onClick={() => setRouteId(summary.routeId)}
              >
                {summary.routeNumber} ·{' '}
                {mode === 'picking'
                  ? `${summary.inRouteCell}/${summary.total}`
                  : `${summary.issued}/${summary.total}`}
                {summary.state === 'ACTIVE' ? ' · передан' : ''}
              </Button>
            ))}
          </div>
        )}
      </div>

      {view !== null && (
        <div className="card stack" data-testid="wh-route-card" data-route-state={view.state}>
          <div className="row">
            <div>
              <div className="field__label">Маршрутный лист</div>
              <strong>{view.routeNumber}</strong>
            </div>
            <div>
              <div className="field__label">Курьер</div>
              <span data-testid="wh-route-courier">{view.courier?.fullName ?? 'не назначен'}</span>
            </div>
            <div>
              <div className="field__label">Маршрутная ячейка</div>
              <span data-testid="wh-route-cell">{view.routeCell?.code ?? 'не привязана'}</span>
            </div>
            <div>
              <div className="field__label">{mode === 'picking' ? 'Скомплектовано' : 'Выдано'}</div>
              <span data-testid="wh-route-progress">
                {mode === 'picking'
                  ? `${pickProgress(view).picked} из ${pickProgress(view).total}`
                  : `${issueProgress(view).issued} из ${issueProgress(view).total}`}
              </span>
            </div>
          </div>

          {mode === 'picking' && view.state === 'CONFIRMED' && (
            <>
              {view.routeCell === null ? (
                <div className="stack">
                  <ScanField
                    label="Маршрутная ячейка"
                    hint="Отсканируйте QR маршрутной ячейки для этого листа"
                    value={cellInput}
                    onChange={setCellInput}
                    onSubmit={() => cellInput.trim() !== '' && bindCell.mutate()}
                    autoFocus
                    testId="wh-bind-cell"
                    disabled={bindCell.isPending}
                  />
                  <Button
                    variant="primary"
                    data-testid="wh-bind-submit"
                    disabled={bindCell.isPending || cellInput.trim() === ''}
                    onClick={() => bindCell.mutate()}
                  >
                    Привязать ячейку
                  </Button>
                </div>
              ) : (
                <div className="stack">
                  <ScanField
                    label="Заказ"
                    hint="Отсканируйте заказ, затем подтвердите перенос"
                    value={orderInput}
                    onChange={setOrderInput}
                    onSubmit={() =>
                      orderInput.trim() !== '' && pick.mutate(view.routeCell?.code ?? '')
                    }
                    autoFocus
                    testId="wh-pick-order"
                    disabled={pick.isPending}
                  />
                  <Button
                    variant="primary"
                    data-testid="wh-pick-submit"
                    disabled={pick.isPending || orderInput.trim() === ''}
                    onClick={() => pick.mutate(view.routeCell?.code ?? '')}
                  >
                    Перенести в маршрутную ячейку
                  </Button>
                </div>
              )}
            </>
          )}

          {mode === 'issue' && view.state === 'CONFIRMED' && (
            <>
              {view.issueSession === null ? (
                <div className="stack">
                  <p className="muted text-sm">
                    Подтвердите назначенного курьера: без подтверждения выдать заказы нельзя.
                  </p>
                  <Button
                    variant="primary"
                    data-testid="wh-confirm-courier"
                    disabled={view.courier === null || confirmCourier.isPending}
                    onClick={() => view.courier !== null && confirmCourier.mutate(view.courier.id)}
                  >
                    Курьер {view.courier?.fullName ?? '—'} подтверждён
                  </Button>
                </div>
              ) : (
                <div className="stack">
                  <ScanField
                    label="Заказ"
                    hint="Сканируйте заказы по одному"
                    value={orderInput}
                    onChange={setOrderInput}
                    onSubmit={() => orderInput.trim() !== '' && issue.mutate()}
                    autoFocus
                    testId="wh-issue-order"
                    disabled={issue.isPending}
                  />
                  <Button
                    variant="primary"
                    data-testid="wh-issue-submit"
                    disabled={issue.isPending || orderInput.trim() === ''}
                    onClick={() => issue.mutate()}
                  >
                    Выдать заказ
                  </Button>
                </div>
              )}
            </>
          )}

          {view.state === 'ACTIVE' && (
            <p className="muted text-sm" data-testid="wh-route-active">
              Маршрут передан курьеру и стал активным. Маршрутная ячейка освобождена.
            </p>
          )}

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>№</th>
                  <th>Заказ</th>
                  <th>Ячейка</th>
                  <th>Состояние</th>
                </tr>
              </thead>
              <tbody>
                {view.orders.map((order) => (
                  <tr
                    key={order.orderId}
                    data-testid="wh-route-order"
                    data-order={order.orderNumber}
                  >
                    <td className="muted">{order.position}</td>
                    <td>
                      <strong>{order.orderNumber}</strong>
                    </td>
                    <td>{cellLabel(order)}</td>
                    <td>
                      {order.issued ? (
                        <StatusBadge tone="success">Выдан</StatusBadge>
                      ) : order.inRouteCell ? (
                        <StatusBadge tone="info">В маршрутной ячейке</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">
                          {issueBlocker(order) ?? 'В хранении'}
                        </StatusBadge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
