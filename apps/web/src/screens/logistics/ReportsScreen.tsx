/**
 * Вкладка «Отчёты»: расчёты с курьерами и операционные показатели.
 *
 * По умолчанию открываются расчёты — это то, ради чего логист сюда заходит.
 *
 * Деньги показываются одинаково во всех местах экрана и всегда сопровождаются
 * СЛОВАМИ о направлении долга: цвет и знак читаются по-разному, а ошибка здесь
 * стоит настоящих денег.
 *
 * Строки маршрутов, подтверждённых до включения учёта, помечаются «Расчёт
 * отсутствует». Ноль вместо этого означал бы нулевую ставку, а это неправда.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  TextInput,
} from '../../ui/components';
import { formatDate, moscowToday } from '../routing/routing';
import './reports.css';

interface SettlementTotals {
  openingBalanceMinor: string;
  cashReceivedMinor: string;
  handedToLogistMinor: string;
  issuedToCourierMinor: string;
  deliveryFeesMinor: string;
  attemptFeesMinor: string;
  distanceFeesMinor: string;
  expensesMinor: string;
  bonusesMinor: string;
  adjustmentsMinor: string;
  closingBalanceMinor: string;
}

interface SettlementRow {
  attemptId: string;
  orderNumber: string;
  routeNumber: string;
  deliveryDate: string;
  outcome: string;
  cancelled: boolean;
  cashMinor: string;
  paymentTypeName: string | null;
  perOrderMinor: string | null;
  perKmMinor: string | null;
  beyondMkadKmTenths: number | null;
  deliveryFeeMinor: string;
  distanceFeeMinor: string;
  attemptFeeMinor: string;
  expensesMinor: string;
  bonusesMinor: string;
  totalMinor: string;
  settlementMissing: boolean;
}

interface SettlementReport {
  totals: SettlementTotals;
  rows: SettlementRow[];
  entries: {
    id: string;
    kind: string;
    amountMinor: string;
    operationDate: string;
    reason: string | null;
    reversed: boolean;
  }[];
  ledgerActiveFrom: string | null;
}

interface OperationalReport {
  orders: {
    received: number;
    assigned: number;
    unassigned: number;
    shipped: number;
    delivered: number;
    failed: number;
    cancelled: number;
  };
  routes: {
    total: number;
    confirmed: number;
    active: number;
    completed: number;
    cancelled: number;
    averageOrders: number;
  };
  actualMinutes: { measured: number; averageMinutes: number | null };
  failureReasons: { name: string; count: number }[];
}

const OPERATION_LABELS: Record<string, string> = {
  CASH_RECEIVED: 'Наличные получены курьером',
  DELIVERY_FEE: 'Оплата за доставку',
  DISTANCE_FEE: 'Оплата километров за МКАД',
  ATTEMPT_FEE: 'Оплачиваемая попытка',
  CASH_HANDED_TO_LOGIST: 'Курьер сдал логисту',
  CASH_ISSUED_TO_COURIER: 'Логист выдал курьеру',
  EXPENSE_PARKING: 'Расход: парковка',
  EXPENSE_TOLL: 'Расход: платная дорога',
  EXPENSE_TRANSIT: 'Расход: общественный транспорт',
  EXPENSE_REPAIR: 'Расход: ремонт',
  EXPENSE_LOADING: 'Расход: погрузка',
  EXPENSE_OTHER: 'Расход: другое',
  BONUS: 'Доплата курьеру',
  ADJUSTMENT: 'Обратная корректировка',
};

/** Заводимые человеком операции. Начисления система делает сама. */
const MANUAL_OPERATIONS = [
  'CASH_HANDED_TO_LOGIST',
  'CASH_ISSUED_TO_COURIER',
  'BONUS',
  'ATTEMPT_FEE',
  'EXPENSE_PARKING',
  'EXPENSE_TOLL',
  'EXPENSE_TRANSIT',
  'EXPENSE_REPAIR',
  'EXPENSE_LOADING',
  'EXPENSE_OTHER',
] as const;

/** Деньги одинаково во всём приложении: рубли, запятая, два знака. */
export function formatMoney(minor: string): string {
  const value = Number(BigInt(minor)) / 100;
  return `${value.toFixed(2).replace('.', ',')} ₽`;
}

/** Направление долга словами: знак сам по себе читается неоднозначно. */
export function debtWords(minor: string): string {
  const value = BigInt(minor);
  if (value === 0n) {
    return 'взаиморасчёты закрыты';
  }
  return value > 0n ? 'курьер должен компании' : 'компания должна курьеру';
}

function weekAgo(today: string): string {
  const instant = new Date(`${today}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() - 7);
  return instant.toISOString().slice(0, 10);
}

export function ReportsScreen(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const today = moscowToday();

  const [mode, setMode] = useState<'SETTLEMENTS' | 'OPERATIONS'>('SETTLEMENTS');
  const [from, setFrom] = useState(weekAgo(today));
  const [to, setTo] = useState(today);
  const [courierUserId, setCourierUserId] = useState('');
  const [operationOpen, setOperationOpen] = useState(false);
  const [kind, setKind] = useState<string>('CASH_HANDED_TO_LOGIST');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const couriers = useQuery({
    queryKey: ['couriers-for-routes'],
    queryFn: () =>
      client.get<{ items: { id: string; fullName: string }[] }>(
        '/api/users?role=COURIER&status=ACTIVE&limit=100',
      ),
  });

  const params = (): string => {
    const search = new URLSearchParams({ from, to });
    if (courierUserId !== '') {
      search.set('courierUserId', courierUserId);
    }
    return search.toString();
  };

  const settlements = useQuery({
    queryKey: ['settlements', from, to, courierUserId],
    enabled: mode === 'SETTLEMENTS',
    queryFn: () => client.get<SettlementReport>(`/api/logistics/reports/settlements?${params()}`),
  });

  const operations = useQuery({
    queryKey: ['operations-report', from, to],
    enabled: mode === 'OPERATIONS',
    queryFn: () =>
      client.get<OperationalReport>(`/api/logistics/reports/operations?from=${from}&to=${to}`),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['settlements'] });
  };

  const addOperation = useMutation({
    mutationFn: (input: { idempotencyKey: string }) =>
      client.post('/api/logistics/ledger/operations', {
        courierUserId,
        kind,
        amountMinor: String(Math.round(Number(amount.replace(',', '.')) * 100)),
        operationDate: to,
        reason: reason.trim() === '' ? undefined : reason.trim(),
        idempotencyKey: input.idempotencyKey,
      }),
    onSuccess: () => {
      setOperationOpen(false);
      setAmount('');
      setReason('');
      showToast('Операция записана', 'success');
      refresh();
    },
    onError: (error: unknown) =>
      setFormError((error as { message?: string }).message ?? 'Не удалось записать операцию'),
  });

  const reverse = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      client.post(`/api/logistics/ledger/operations/${input.id}/reverse`, { reason: input.reason }),
    onSuccess: () => {
      showToast('Обратная корректировка записана', 'success');
      refresh();
    },
    onError: (error: unknown) =>
      showToast((error as { message?: string }).message ?? 'Не удалось отменить операцию', 'error'),
  });

  const exportUrl = (format: 'xlsx' | 'pdf'): string =>
    `/api/logistics/reports/settlements.${format}?${params()}`;

  return (
    <section className="reports" data-testid="reports-screen">
      <div className="reports__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'SETTLEMENTS'}
          className={mode === 'SETTLEMENTS' ? 'reports__tab reports__tab--active' : 'reports__tab'}
          data-testid="reports-mode-settlements"
          onClick={() => setMode('SETTLEMENTS')}
        >
          Расчёты с курьерами
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'OPERATIONS'}
          className={mode === 'OPERATIONS' ? 'reports__tab reports__tab--active' : 'reports__tab'}
          data-testid="reports-mode-operations"
          onClick={() => setMode('OPERATIONS')}
        >
          Операционные показатели
        </button>
      </div>

      <div className="reports__filters">
        <Field label="С">
          {(props) => (
            <TextInput
              {...props}
              type="date"
              value={from}
              data-testid="reports-from"
              onChange={(event) => setFrom(event.target.value)}
            />
          )}
        </Field>
        <Field label="По">
          {(props) => (
            <TextInput
              {...props}
              type="date"
              value={to}
              data-testid="reports-to"
              onChange={(event) => setTo(event.target.value)}
            />
          )}
        </Field>
        {mode === 'SETTLEMENTS' && (
          <Field label="Курьер" hint="Баланс считается по одному курьеру">
            {(props) => (
              <select
                {...props}
                className="reports__select"
                value={courierUserId}
                data-testid="reports-courier"
                onChange={(event) => setCourierUserId(event.target.value)}
              >
                <option value="">Все курьеры</option>
                {(couriers.data?.items ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.fullName}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
      </div>

      {mode === 'SETTLEMENTS' ? (
        settlements.isPending ? (
          <LoadingState title="Считаем расчёты…" />
        ) : settlements.isError ? (
          <ErrorState
            title="Не удалось построить отчёт"
            onRetry={() => void settlements.refetch()}
          />
        ) : (
          <>
            {settlements.data.ledgerActiveFrom === null && (
              <p className="reports__notice" role="status" data-testid="reports-ledger-off">
                Финансовый учёт ещё не включён: начислений за период нет. Прошлые доставки
                показываются с пометкой «Расчёт отсутствует».
              </p>
            )}

            <div className="reports__summary" data-testid="reports-summary">
              {[
                ['Начальный баланс', settlements.data.totals.openingBalanceMinor],
                ['Наличные у курьера', settlements.data.totals.cashReceivedMinor],
                ['Сдано логисту', settlements.data.totals.handedToLogistMinor],
                ['Выдано курьеру', settlements.data.totals.issuedToCourierMinor],
                ['Оплата доставок', settlements.data.totals.deliveryFeesMinor],
                ['Оплачиваемые попытки', settlements.data.totals.attemptFeesMinor],
                ['Километры за МКАД', settlements.data.totals.distanceFeesMinor],
                ['Расходы', settlements.data.totals.expensesMinor],
                ['Доплаты', settlements.data.totals.bonusesMinor],
              ].map(([label, value]) => (
                <div key={label} className="reports__cell">
                  <span className="reports__cell-label">{label}</span>
                  <span className="reports__cell-value">{formatMoney(value ?? '0')}</span>
                </div>
              ))}
              <div className="reports__cell reports__cell--total">
                <span className="reports__cell-label">Конечный баланс</span>
                <span className="reports__cell-value" data-testid="reports-closing">
                  {formatMoney(settlements.data.totals.closingBalanceMinor)}
                </span>
                <span className="reports__cell-words">
                  {debtWords(settlements.data.totals.closingBalanceMinor)}
                </span>
              </div>
            </div>

            <div className="reports__actions">
              <Button
                variant="primary"
                disabled={courierUserId === ''}
                title={courierUserId === '' ? 'Выберите курьера' : undefined}
                data-testid="reports-add-operation"
                onClick={() => {
                  setFormError(null);
                  setOperationOpen(true);
                }}
              >
                Добавить операцию
              </Button>
              <a className="reports__link" href={exportUrl('xlsx')} data-testid="reports-xlsx">
                Выгрузить XLSX
              </a>
              <a className="reports__link" href={exportUrl('pdf')} data-testid="reports-pdf">
                Итог в PDF
              </a>
            </div>

            {settlements.data.rows.length === 0 ? (
              <EmptyState title="За период доставок не было" />
            ) : (
              <div className="reports__table-wrap">
                <table className="reports__table" data-testid="reports-rows">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Лист</th>
                      <th>Заказ</th>
                      <th>Итог</th>
                      <th>Наличные</th>
                      <th>За заказ</th>
                      <th>За МКАД</th>
                      <th>Начислено</th>
                      <th>Строка</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settlements.data.rows.map((row) => (
                      <tr key={row.attemptId} data-order-number={row.orderNumber}>
                        <td>{formatDate(row.deliveryDate)}</td>
                        <td>{row.routeNumber}</td>
                        <td>{row.orderNumber}</td>
                        <td>
                          {row.outcome === 'DELIVERED' ? 'Доставлен' : 'Не доставлен'}
                          {row.cancelled ? ' (отменён)' : ''}
                        </td>
                        <td>{formatMoney(row.cashMinor)}</td>
                        <td>{row.perOrderMinor === null ? '—' : formatMoney(row.perOrderMinor)}</td>
                        <td>
                          {row.beyondMkadKmTenths === null
                            ? 'не рассчитано'
                            : `${(row.beyondMkadKmTenths / 10).toFixed(1)} км`}
                        </td>
                        <td>
                          {formatMoney(
                            (
                              BigInt(row.deliveryFeeMinor) +
                              BigInt(row.distanceFeeMinor) +
                              BigInt(row.attemptFeeMinor)
                            ).toString(),
                          )}
                        </td>
                        <td>
                          {row.settlementMissing ? (
                            <span className="reports__missing">Расчёт отсутствует</span>
                          ) : (
                            formatMoney(row.totalMinor)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {settlements.data.entries.length > 0 && (
              <div className="reports__table-wrap">
                <table className="reports__table" data-testid="reports-entries">
                  <thead>
                    <tr>
                      <th>День</th>
                      <th>Операция</th>
                      <th>Сумма</th>
                      <th>Основание</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {settlements.data.entries.map((entry) => (
                      <tr key={entry.id} data-entry-kind={entry.kind}>
                        <td>{formatDate(entry.operationDate)}</td>
                        <td>{OPERATION_LABELS[entry.kind] ?? entry.kind}</td>
                        <td>{formatMoney(entry.amountMinor)}</td>
                        <td>{entry.reason ?? '—'}</td>
                        <td>
                          {entry.kind !== 'ADJUSTMENT' && !entry.reversed && (
                            <button
                              type="button"
                              className="reports__reverse"
                              data-testid="reports-reverse"
                              onClick={() => {
                                const value = globalThis.prompt('Причина обратной корректировки');
                                if (value !== null && value.trim().length >= 3) {
                                  reverse.mutate({ id: entry.id, reason: value.trim() });
                                }
                              }}
                            >
                              Отменить
                            </button>
                          )}
                          {entry.reversed && <span className="muted text-sm">отменена</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )
      ) : operations.isPending ? (
        <LoadingState title="Считаем показатели…" />
      ) : operations.isError ? (
        <ErrorState title="Не удалось построить отчёт" onRetry={() => void operations.refetch()} />
      ) : (
        <div className="reports__summary" data-testid="operations-summary">
          {[
            ['Получено заказов', operations.data.orders.received],
            ['Распределено', operations.data.orders.assigned],
            ['Не распределено', operations.data.orders.unassigned],
            ['Отгружено', operations.data.orders.shipped],
            ['Доставлено', operations.data.orders.delivered],
            ['Не доставлено', operations.data.orders.failed],
            ['Маршрутов', operations.data.routes.total],
            ['Средняя загрузка', operations.data.routes.averageOrders],
            [
              'Среднее время маршрута',
              operations.data.actualMinutes.averageMinutes === null
                ? 'нет данных'
                : `${operations.data.actualMinutes.averageMinutes} мин`,
            ],
          ].map(([label, value]) => (
            <div key={String(label)} className="reports__cell">
              <span className="reports__cell-label">{label}</span>
              <span className="reports__cell-value">{value}</span>
            </div>
          ))}
        </div>
      )}

      {operationOpen && (
        <Modal open title="Денежная операция" onClose={() => setOperationOpen(false)}>
          <div className="stack">
            <Field label="Операция">
              {(props) => (
                <select
                  {...props}
                  className="reports__select"
                  value={kind}
                  data-testid="operation-kind"
                  onChange={(event) => setKind(event.target.value)}
                >
                  {MANUAL_OPERATIONS.map((item) => (
                    <option key={item} value={item}>
                      {OPERATION_LABELS[item] ?? item}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Сумма, ₽" hint="Частичные суммы разрешены">
              {(props) => (
                <TextInput
                  {...props}
                  value={amount}
                  inputMode="decimal"
                  data-testid="operation-amount"
                  onChange={(event) => setAmount(event.target.value)}
                />
              )}
            </Field>
            <Field label="Основание" hint="Обязательно для расходов">
              {(props) => (
                <TextInput
                  {...props}
                  value={reason}
                  data-testid="operation-reason"
                  onChange={(event) => setReason(event.target.value)}
                />
              )}
            </Field>
            {formError !== null && (
              <p className="reports__error" role="alert">
                {formError}
              </p>
            )}
            <div className="reports__actions">
              <Button
                variant="primary"
                disabled={addOperation.isPending || amount.trim() === ''}
                data-testid="operation-submit"
                onClick={() => {
                  setFormError(null);
                  /*
                   * Ключ идемпотентности собирается из содержания операции.
                   * Повторное нажатие той же кнопки не создаёт вторую запись —
                   * сервер вернёт уже существующую.
                   */
                  addOperation.mutate({
                    idempotencyKey: `ui:${courierUserId}:${kind}:${to}:${amount}:${reason}`,
                  });
                }}
              >
                Записать
              </Button>
              <Button onClick={() => setOperationOpen(false)}>Отмена</Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
