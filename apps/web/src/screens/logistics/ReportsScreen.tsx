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
  StatusBadge,
  TextInput,
} from '../../ui/components';
import { formatMoscowDateTime } from '@fl/shared';
import { formatDate, moscowToday } from '../routing/routing';
import { evaluateMoney, previewOf } from './money-calculator';
import { CashDeskPanel } from './CashDeskPanel';
import { CourierCombobox } from './CourierCombobox';
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

interface LedgerEntry {
  id: string;
  kind: string;
  amountMinor: string;
  operationDate: string;
  occurredAt: string;
  actorName: string | null;
  reason: string | null;
  reversed: boolean;
}

interface CourierGroup {
  courierUserId: string;
  fullName: string;
  phone: string | null;
  sheets: number;
  orders: number;
  cashMinor: string;
  deliveryFeesMinor: string;
  distanceKmTenths: number;
  distanceFeesMinor: string;
  attemptFeesMinor: string;
  extraExpensesMinor: string;
  handedMinor: string;
  issuedMinor: string;
  accruedMinor: string;
  totalMinor: string;
  settlementMissing: boolean;
  rows: SettlementRow[];
  operations: {
    count: number;
    totalMinor: string;
    entries: LedgerEntry[];
  };
}

interface DayGroup {
  date: string;
  couriers: CourierGroup[];
}

interface SettlementReport {
  totals: SettlementTotals;
  rows: SettlementRow[];
  days: DayGroup[];
  totalGroups: number;
  hasMore: boolean;
  entries: LedgerEntry[];
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
  EXPENSE_OTHER: 'Дополнительный расход',
  BONUS: 'Доплата курьеру',
  ADJUSTMENT: 'Обратная корректировка',
};

/** Сколько групп «день + курьер» показывать за раз. */
const GROUPS_PER_PAGE = 25;

/**
 * Что заводится прямо из ячейки таблицы.
 *
 * Универсальной кнопки «Добавить операцию» больше нет: человек нажимает на ту
 * ячейку дня и курьера, к которой относится операция, — так невозможно завести
 * расход не тому курьеру или не в тот день.
 *
 * Доплата и оплачиваемая попытка по решению владельца из интерфейса убраны:
 * это обычные расходы и вносятся через «Доп.». В учёте их виды сохранены —
 * прошлые записи никуда не делись и продолжают считаться.
 */
/** Вкладки отчёта: что именно смотрим. */
const REPORT_TABS = [
  { key: 'SETTLEMENTS', title: 'Расчёты с курьерами', testId: 'reports-mode-settlements' },
  { key: 'CASH', title: 'Касса логистов', testId: 'reports-mode-cash' },
  { key: 'OPERATIONS', title: 'Операционные показатели', testId: 'reports-mode-operations' },
] as const;

/** Готовые сроки: день, неделя, месяц назад от сегодняшнего дня. */
const REPORT_PERIODS = [
  { key: 'day', title: 'День', days: 0 },
  { key: 'week', title: 'Неделя', days: 7 },
  { key: 'month', title: 'Месяц', days: 30 },
] as const;

/**
 * Границы срока в календарных днях.
 *
 * Считается назад от сегодняшнего дня: «неделя» — последние семь дней вместе
 * с текущим, а не календарная неделя с понедельника. Отчёт спрашивают так.
 */
function periodRange(days: number): { from: string; to: string } {
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const start = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: start.toISOString().slice(0, 10), to };
}

const CELL_OPERATIONS = {
  EXPENSE_OTHER: { title: 'Дополнительный расход', needsReason: true },
  CASH_HANDED_TO_LOGIST: { title: 'Курьер сдал', needsReason: false },
  CASH_ISSUED_TO_COURIER: { title: 'Выдано курьеру', needsReason: false },
} as const;

type CellOperation = keyof typeof CELL_OPERATIONS;

/** Деньги одинаково во всём приложении: рубли, запятая, два знака. */
export function formatMoney(minor: string): string {
  const value = Number(BigInt(minor)) / 100;
  return `${value.toFixed(2).replace('.', ',')} ₽`;
}

/**
 * В каком столбце показывать сумму операции журнала.
 *
 * Число встаёт ровно под тот столбец, в который оно вошло итогом дня: расход
 * под «Доп.», сдача под «Курьер сдал», выдача под «Выдано курьеру». Так строку
 * журнала можно сверить со свёрнутой строкой глазами, не считая в уме.
 */
export function journalColumn(kind: string): number {
  if (kind === 'CASH_HANDED_TO_LOGIST') {
    return 11;
  }
  if (kind === 'CASH_ISSUED_TO_COURIER') {
    return 12;
  }
  if (kind === 'ADJUSTMENT') {
    return 10;
  }
  return 9;
}

/** Величина суммы без знака: направление задаёт вид операции или столбец. */
export function absMoney(minor: string): string {
  const value = BigInt(minor);
  return (value < 0n ? -value : value).toString();
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

  const [mode, setMode] = useState<'SETTLEMENTS' | 'CASH' | 'OPERATIONS'>('SETTLEMENTS');
  const [from, setFrom] = useState(weekAgo(today));
  const [to, setTo] = useState(today);
  const [courierUserId, setCourierUserId] = useState('');
  /**
   * Открытый редактор ячейки.
   *
   * Ячейка задаёт всё сразу: день, курьера и вид операции. Ошибиться адресатом
   * невозможно — человек нажимает ровно на ту клетку, к которой относится
   * операция.
   */
  const [editor, setEditor] = useState<{
    kind: CellOperation;
    date: string;
    courierUserId: string;
    courierName: string;
    /**
     * Ключ идемпотентности открытого редактора.
     *
     * Один на всё окно: повторное нажатие «Добавить» не создаёт вторую
     * запись, а следующая операция открывает новое окно и получает новый
     * ключ — два одинаковых расхода за день остаются двумя расходами.
     */
    nonce: string;
  } | null>(null);
  /** Касса логиста для передач наличных. */
  const [deskId, setDeskId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  /**
   * Раскрытые группы.
   *
   * По умолчанию свёрнуты все: экран отвечает на вопрос «сколько за день»,
   * а подробности человек открывает сам по конкретному курьеру.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [pages, setPages] = useState(1);

  const toggle = (key: string): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  /*
   * Кассы, доступные пользователю.
   *
   * Логисту доступна одна — своя, и выбирать нечего. Администратор обязан
   * назвать кассу явно: его действие не должно попадать в несуществующую
   * кассу владельца системы.
   */
  const desks = useQuery({
    queryKey: ['cash-desks'],
    queryFn: () =>
      client.get<{ items: { id: string; fullName: string; balanceMinor: string }[] }>(
        '/api/logistics/cash/desks',
      ),
  });

  const couriers = useQuery({
    queryKey: ['couriers-for-routes'],
    queryFn: () =>
      client.get<{ items: { id: string; fullName: string; phone: string | null }[] }>(
        '/api/users?role=COURIER&status=ACTIVE&limit=100',
      ),
  });

  /** Имя выбранного курьера: баланс считается по одному человеку, и он назван. */
  const courierName =
    courierUserId === ''
      ? null
      : ((couriers.data?.items ?? []).find((item) => item.id === courierUserId)?.fullName ?? null);

  const params = (withPaging = true): string => {
    const search = new URLSearchParams({ from, to });
    if (courierUserId !== '') {
      search.set('courierUserId', courierUserId);
    }
    if (withPaging) {
      // Страница считается ГРУППАМИ: группа курьера не делится между страницами.
      search.set('limit', String(GROUPS_PER_PAGE * pages));
      search.set('offset', '0');
    }
    return search.toString();
  };

  const settlements = useQuery({
    queryKey: ['settlements', from, to, courierUserId, pages],
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
    mutationFn: (input: { minor: bigint; idempotencyKey: string }) =>
      client.post('/api/logistics/ledger/operations', {
        courierUserId: editor?.courierUserId ?? '',
        kind: editor?.kind ?? 'EXPENSE_OTHER',
        // Сумма уже посчитана калькулятором и приходит целыми копейками.
        amountMinor: input.minor.toString(),
        // День берётся из строки таблицы, а не из фильтра: операция относится
        // к тому дню, на который человек нажал.
        operationDate: editor?.date ?? to,
        reason: reason.trim() === '' ? undefined : reason.trim(),
        // Передача наличных всегда идёт через чью-то кассу.
        logistUserId: editor?.kind === 'EXPENSE_OTHER' ? undefined : deskId,
        idempotencyKey: input.idempotencyKey,
      }),
    onSuccess: () => {
      setEditor(null);
      setAmount('');
      setReason('');
      showToast('Операция записана', 'success');
      refresh();
    },
    onError: (error: unknown) =>
      setFormError((error as { message?: string }).message ?? 'Не удалось записать операцию'),
  });

  /** Открытие редактора ячейки: поля всегда начинаются пустыми. */
  const openEditor = (
    kind: CellOperation,
    date: string,
    group: { courierUserId: string; fullName: string },
  ): void => {
    setFormError(null);
    setAmount('');
    setReason('');
    setDeskId(desks.data?.items[0]?.id ?? '');
    setEditor({
      kind,
      date,
      courierUserId: group.courierUserId,
      courierName: group.fullName,
      nonce: globalThis.crypto.randomUUID(),
    });
  };

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

  // Выгрузка отдаёт ВЕСЬ отбор, а не показанную страницу.
  const exportUrl = (format: 'xlsx' | 'pdf'): string =>
    `/api/logistics/reports/settlements.${format}?${params(false)}`;

  return (
    <section className="reports" data-testid="reports-screen">
      {/*
        Шапка отчёта: чем смотрим и за какой срок.

        Вкладки и период стояли отдельными полосами, каждая со своими
        подписями, и вместе занимали четверть экрана до первой цифры.
        Теперь это одна панель: слева выбор отчёта, справа — срок.
      */}
      <div className="reports__head">
        <div className="reports__tabs" role="tablist">
          {REPORT_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={mode === tab.key}
              className={mode === tab.key ? 'reports__tab reports__tab--active' : 'reports__tab'}
              data-testid={tab.testId}
              onClick={() => setMode(tab.key)}
            >
              {tab.title}
            </button>
          ))}
        </div>

        <div className="reports__period">
          {/*
            Готовые сроки вместо счёта дней в уме: «неделя» — самый частый
            вопрос к отчёту. Кнопки только подставляют границы, поля остаются.
          */}
          <div className="reports__segments" role="group" aria-label="Период">
            {REPORT_PERIODS.map((period) => {
              const range = periodRange(period.days);
              const active = from === range.from && to === range.to;
              return (
                <button
                  key={period.key}
                  type="button"
                  className={active ? 'reports__segment reports__segment--on' : 'reports__segment'}
                  aria-pressed={active}
                  data-testid={`reports-period-${period.key}`}
                  onClick={() => {
                    setFrom(range.from);
                    setTo(range.to);
                  }}
                >
                  {period.title}
                </button>
              );
            })}
          </div>

          <TextInput
            type="date"
            value={from}
            aria-label="С"
            data-testid="reports-from"
            onChange={(event) => setFrom(event.target.value)}
          />
          <span className="reports__dash" aria-hidden="true">
            –
          </span>
          <TextInput
            type="date"
            value={to}
            aria-label="По"
            data-testid="reports-to"
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
      </div>

      <div className="reports__filters">
        {mode === 'SETTLEMENTS' && (
          <>
            <span className="reports__filter-label">Курьер</span>
            {/*
              Ввод с подсказками вместо длинного списка: курьеров десятки,
              и искать нужного прокруткой дольше, чем набрать три буквы имени
              или цифры телефона.
            */}
            <div
              className="reports__courier"
              title="Баланс считается по одному курьеру"
              data-testid="reports-courier"
            >
              <CourierCombobox
                options={couriers.data?.items ?? []}
                value={
                  (couriers.data?.items ?? []).find((item) => item.id === courierUserId) ?? null
                }
                label="Курьер"
                emptyLabel="Все курьеры"
                testId="reports-courier-combobox"
                onChange={(courier) => setCourierUserId(courier === null ? '' : courier.id)}
              />
            </div>
            {/* Выгрузка относится ко всему отчёту, поэтому стоит в его шапке. */}
            <a className="reports__export" href={exportUrl('xlsx')} data-testid="reports-xlsx">
              Выгрузить XLSX
            </a>
            <a className="reports__export" href={exportUrl('pdf')} data-testid="reports-pdf">
              Итог в PDF
            </a>
          </>
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

            {/*
              Итог отдельно от слагаемых.

              Девять плиток одного вида не отвечали на главный вопрос — кто
              кому должен: конечный баланс терялся среди слагаемых, из которых
              он и сложился. Теперь он стоит крупно слева, а показатели
              периода лежат рядом в своём лотке.
            */}
            <div className="reports__totals">
              <div className="reports__balance" data-testid="reports-balance">
                <span className="reports__balance-title">
                  Конечный баланс
                  {courierName === null ? '' : ` · ${courierName}`}
                </span>
                <span className="reports__balance-value" data-testid="reports-closing">
                  {formatMoney(settlements.data.totals.closingBalanceMinor)}
                </span>
                <span className="reports__balance-words">
                  {debtWords(settlements.data.totals.closingBalanceMinor)}
                </span>
                <span className="reports__balance-opening">
                  Начальный {formatMoney(settlements.data.totals.openingBalanceMinor)}
                </span>
              </div>

              <div className="reports__metrics">
                <span className="reports__metrics-title">Показатели за период</span>
                <div className="reports__summary" data-testid="reports-summary">
                  {[
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
                </div>
              </div>
            </div>

            {settlements.data.days.length === 0 ? (
              <EmptyState title="За период доставок и операций не было" />
            ) : (
              <>
                {/*
                  Иерархия «день → курьер → строки».
                  Итоги группы считает сервер по всему отбору, а не по видимым
                  строкам: сумма, зависящая от прокрутки, итогом не является.
                */}
                {/*
                  Заголовок объясняет, что строка кликабельна.

                  Раскрытие ничем себя не выдавало: логист видел таблицу
                  и не знал, что за строкой есть заказы и разбор начисления.
                */}
                <div className="reports__section-head">
                  <h3 className="reports__section-title">Смены курьеров</h3>
                  <span className="reports__section-hint">
                    нажмите строку, чтобы увидеть заказы и из чего сложилось начисление
                  </span>
                </div>

                <div className="reports__table-wrap">
                  <table className="reports__table" data-testid="reports-rows">
                    <thead>
                      <tr>
                        <th>Дата</th>
                        <th>Курьер</th>
                        <th>Листы</th>
                        <th>Заказы</th>
                        <th>Статус</th>
                        <th>Наличные</th>
                        <th>За заказ</th>
                        <th>За МКАД</th>
                        <th>Доп.</th>
                        <th>Начислено</th>
                        <th>Курьер сдал</th>
                        <th>Выдано курьеру</th>
                        <th>Итог</th>
                      </tr>
                    </thead>
                    <tbody>
                      {settlements.data.days.flatMap((day) =>
                        day.couriers.flatMap((group) => {
                          const key = `${day.date}:${group.courierUserId}`;
                          const open = expanded.has(key);

                          const rows = [
                            <tr
                              key={key}
                              className="reports__group"
                              data-testid="reports-group"
                              data-group-date={day.date}
                              data-group-courier={group.courierUserId}
                              data-expanded={open ? 'true' : 'false'}
                            >
                              <td>{formatDate(day.date)}</td>
                              <td>
                                <button
                                  type="button"
                                  className="reports__group-toggle"
                                  aria-expanded={open}
                                  data-testid="reports-group-toggle"
                                  onClick={() => toggle(key)}
                                >
                                  <span className="reports__group-chevron" aria-hidden="true">
                                    {open ? '▲' : '▼'}
                                  </span>
                                  <span className="reports__group-name">
                                    <span>{group.fullName}</span>
                                    <span className="reports__group-phone">
                                      {group.phone ?? 'телефон не указан'}
                                    </span>
                                  </span>
                                </button>
                              </td>
                              <td>{group.sheets}</td>
                              <td>{group.orders}</td>
                              {/* Внутри дня статусы разные, поэтому в свёрнутой строке пусто. */}
                              <td />
                              <td>{formatMoney(group.cashMinor)}</td>
                              <td>{formatMoney(group.deliveryFeesMinor)}</td>
                              <td>
                                {(group.distanceKmTenths / 10).toFixed(1)} км ·{' '}
                                {formatMoney(group.distanceFeesMinor)}
                              </td>
                              {/*
                                Три ячейки-кнопки: день и курьер берутся из самой
                                строки, поэтому операция не может уйти не тому
                                человеку и не в тот день.
                              */}
                              <td>
                                <button
                                  type="button"
                                  className="reports__cell-button"
                                  data-testid="reports-cell-expense"
                                  title="Добавить дополнительный расход"
                                  onClick={() => openEditor('EXPENSE_OTHER', day.date, group)}
                                >
                                  {formatMoney(group.extraExpensesMinor)}
                                </button>
                              </td>
                              <td>{formatMoney(group.accruedMinor)}</td>
                              <td>
                                <button
                                  type="button"
                                  className="reports__cell-button"
                                  data-testid="reports-cell-handed"
                                  title="Курьер сдал наличные логисту"
                                  onClick={() =>
                                    openEditor('CASH_HANDED_TO_LOGIST', day.date, group)
                                  }
                                >
                                  {formatMoney(group.handedMinor)}
                                </button>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="reports__cell-button"
                                  data-testid="reports-cell-issued"
                                  title="Логист выдал деньги курьеру"
                                  onClick={() =>
                                    openEditor('CASH_ISSUED_TO_COURIER', day.date, group)
                                  }
                                >
                                  {formatMoney(group.issuedMinor)}
                                </button>
                              </td>
                              <td>
                                {group.settlementMissing ? (
                                  <span className="reports__missing">Расчёт отсутствует</span>
                                ) : (
                                  formatMoney(group.totalMinor)
                                )}
                              </td>
                            </tr>,
                          ];

                          if (!open) {
                            return rows;
                          }

                          for (const row of group.rows) {
                            rows.push(
                              <tr
                                key={row.attemptId}
                                className="reports__detail"
                                data-order-number={row.orderNumber}
                              >
                                <td>{formatDate(row.deliveryDate)}</td>
                                <td className="reports__detail-order">
                                  {row.routeNumber} · {row.orderNumber}
                                </td>
                                <td colSpan={2} />
                                <td>
                                  {/* Исход — плашка: по ней разбирают строку, а не читают её как текст. */}
                                  <StatusBadge
                                    tone={row.outcome === 'DELIVERED' ? 'success' : 'error'}
                                  >
                                    {row.outcome === 'DELIVERED' ? 'Доставлен' : 'Не доставлен'}
                                    {row.cancelled ? ' (отменён)' : ''}
                                  </StatusBadge>
                                </td>
                                <td>{formatMoney(row.cashMinor)}</td>
                                <td>
                                  {row.perOrderMinor === null
                                    ? '—'
                                    : formatMoney(row.deliveryFeeMinor)}
                                </td>
                                <td>
                                  {row.beyondMkadKmTenths === null
                                    ? 'не рассчитано'
                                    : `${(row.beyondMkadKmTenths / 10).toFixed(1)} км · ${formatMoney(row.distanceFeeMinor)}`}
                                </td>
                                {/* Доп., сдача и выдача — операции дня, а не заказа. */}
                                <td />
                                <td>
                                  {formatMoney(
                                    (
                                      BigInt(row.deliveryFeeMinor) +
                                      BigInt(row.distanceFeeMinor) +
                                      BigInt(row.attemptFeeMinor)
                                    ).toString(),
                                  )}
                                </td>
                                <td />
                                <td />
                                <td>
                                  {row.settlementMissing ? (
                                    <span className="reports__missing">Расчёт отсутствует</span>
                                  ) : (
                                    formatMoney(row.totalMinor)
                                  )}
                                </td>
                              </tr>,
                            );
                          }

                          /*
                           * Журнал платежей курьера за день: время, вид, сумма,
                           * автор и состояние отмены. Операции неизменяемы —
                           * исправление только обратной корректировкой.
                           */
                          for (const entry of group.operations.entries) {
                            rows.push(
                              <tr
                                key={entry.id}
                                className="reports__detail reports__payment"
                                data-entry-kind={entry.kind}
                                data-testid="reports-payment"
                              >
                                {/*
                                  Ячеек ровно столько же, сколько столбцов
                                  в шапке. Раньше их было на одну меньше, и
                                  строка журнала съезжала вбок, растягивая
                                  таблицу за край страницы.
                                */}
                                <td>{formatMoscowDateTime(entry.occurredAt)}</td>
                                <td className="reports__detail-order">
                                  {OPERATION_LABELS[entry.kind] ?? entry.kind}
                                </td>
                                <td colSpan={2}>{entry.actorName ?? 'автор неизвестен'}</td>
                                <td
                                  className="reports__detail-reason"
                                  colSpan={journalColumn(entry.kind) - 5}
                                  title={entry.reason ?? undefined}
                                >
                                  {entry.reason ?? ''}
                                </td>
                                {/*
                                  В журнале сумма показывается величиной:
                                  направление уже названо видом операции, а
                                  прыгающий знак рядом с названием читается как
                                  ошибка ввода.
                                */}
                                <td>{formatMoney(absMoney(entry.amountMinor))}</td>
                                <td colSpan={13 - journalColumn(entry.kind)}>
                                  {entry.reversed ? (
                                    <span className="muted text-sm">отменена</span>
                                  ) : (
                                    entry.kind !== 'ADJUSTMENT' && (
                                      <button
                                        type="button"
                                        className="reports__reverse"
                                        data-testid="reports-reverse"
                                        onClick={() => {
                                          const value = globalThis.prompt(
                                            'Причина обратной корректировки',
                                          );
                                          if (value !== null && value.trim().length >= 3) {
                                            reverse.mutate({ id: entry.id, reason: value.trim() });
                                          }
                                        }}
                                      >
                                        Отменить
                                      </button>
                                    )
                                  )}
                                </td>
                              </tr>,
                            );
                          }

                          return rows;
                        }),
                      )}
                    </tbody>
                  </table>
                </div>

                {settlements.data.hasMore && (
                  <Button
                    data-testid="reports-more"
                    onClick={() => setPages((current) => current + 1)}
                  >
                    Показать ещё
                  </Button>
                )}
              </>
            )}
          </>
        )
      ) : mode === 'CASH' ? (
        <CashDeskPanel from={from} to={to} />
      ) : operations.isPending ? (
        <LoadingState title="Считаем показатели…" />
      ) : operations.isError ? (
        <ErrorState title="Не удалось построить отчёт" onRetry={() => void operations.refetch()} />
      ) : (
        <div className="stack" data-testid="operations-summary">
          {/*
            Путь заказа виден целиком.

            Девять одинаковых плиток не показывали главного: сколько заказов
            дошло от получения до доставки и где именно они осели. Четыре шага
            стоят в ряд с долей от полученных — провал виден раньше, чем
            прочитаны числа.
          */}
          <div className="reports__funnel">
            <span className="reports__funnel-title">Путь заказов за период</span>
            <div className="reports__funnel-steps">
              {[
                ['Получено заказов', operations.data.orders.received],
                ['Распределено', operations.data.orders.assigned],
                ['Отгружено', operations.data.orders.shipped],
                ['Доставлено', operations.data.orders.delivered],
              ].map(([label, value]) => {
                const received = operations.data.orders.received;
                const share = received === 0 ? 0 : Math.round((Number(value) / received) * 100);
                return (
                  <div key={String(label)} className="reports__step">
                    <span className="reports__step-label">{label}</span>
                    <span className="reports__step-value">{value}</span>
                    <span className="reports__step-bar" aria-hidden="true">
                      <span className="reports__step-fill" style={{ width: `${share}%` }} />
                    </span>
                    <span className="reports__step-share">{share}% от полученных</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/*
            Осевшее выделено тоном: это не просто числа, а работа, которую
            кто-то должен доделать.
          */}
          <div className="reports__summary">
            <div className="reports__cell reports__cell--bad">
              <span className="reports__cell-label">Не распределено</span>
              <span className="reports__cell-value">{operations.data.orders.unassigned}</span>
              <span className="reports__cell-note">ждут маршрута</span>
            </div>
            <div className="reports__cell reports__cell--bad">
              <span className="reports__cell-label">Не доставлено</span>
              <span className="reports__cell-value">{operations.data.orders.failed}</span>
              <span className="reports__cell-note">ушли в «Требуют решения»</span>
            </div>
            <div className="reports__cell">
              <span className="reports__cell-label">Маршрутов</span>
              <span className="reports__cell-value">{operations.data.routes.total}</span>
              <span className="reports__cell-note">создано за период</span>
            </div>
            <div className="reports__cell">
              <span className="reports__cell-label">Средняя загрузка</span>
              <span className="reports__cell-value">{operations.data.routes.averageOrders}</span>
              <span className="reports__cell-note">заказов на маршрут</span>
            </div>
            <div className="reports__cell">
              <span className="reports__cell-label">Среднее время маршрута</span>
              <span className="reports__cell-value">
                {operations.data.actualMinutes.averageMinutes === null
                  ? 'нет данных'
                  : `${operations.data.actualMinutes.averageMinutes} мин`}
              </span>
              <span className="reports__cell-note">
                {operations.data.actualMinutes.averageMinutes === null
                  ? 'появится, когда курьеры закроют маршруты'
                  : 'от первой остановки до последней'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/*
        Компактный редактор ячейки.
        Ни курьера, ни вида операции выбирать не нужно: их задала сама ячейка.
      */}
      {editor !== null && (
        <Modal open title={CELL_OPERATIONS[editor.kind].title} onClose={() => setEditor(null)}>
          <div className="stack" data-testid="cell-editor">
            <p className="muted text-sm">
              {editor.courierName} · {formatDate(editor.date)}
            </p>

            {/*
              Передача наличных всегда идёт через чью-то кассу: деньги лежат
              у конкретного человека. Логисту доступна одна касса — своя,
              администратор обязан назвать её явно.
            */}
            {editor.kind !== 'EXPENSE_OTHER' && (desks.data?.items ?? []).length === 0 && (
              <p className="reports__error" role="alert" data-testid="cell-no-desk">
                Нет ни одной кассы логиста: назначьте роль логиста сотруднику, который принимает и
                выдаёт наличные.
              </p>
            )}

            {editor.kind !== 'EXPENSE_OTHER' && (desks.data?.items ?? []).length > 0 && (
              <Field label="Касса логиста" hint="Наличные лежат у конкретного человека">
                {(props) => (
                  <select
                    {...props}
                    className="reports__select"
                    value={deskId}
                    data-testid="cell-desk"
                    onChange={(event) => setDeskId(event.target.value)}
                  >
                    {(desks.data?.items ?? []).map((desk) => (
                      <option key={desk.id} value={desk.id}>
                        {desk.fullName} · {formatMoney(desk.balanceMinor)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}

            <Field label="Сумма, ₽" hint="Можно считать прямо здесь: 1000+500 даст 1500">
              {(props) => (
                <TextInput
                  {...props}
                  value={amount}
                  inputMode="text"
                  autoFocus
                  data-testid="cell-amount"
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setFormError(null);
                  }}
                />
              )}
            </Field>

            {previewOf(amount) !== null && (
              <p className="muted text-sm" data-testid="cell-preview">
                Получится {previewOf(amount)}
              </p>
            )}

            {CELL_OPERATIONS[editor.kind].needsReason && (
              <Field label="Пояснение" hint="Обязательно: за что именно потрачено">
                {(props) => (
                  <TextInput
                    {...props}
                    value={reason}
                    data-testid="cell-reason"
                    onChange={(event) => setReason(event.target.value)}
                  />
                )}
              </Field>
            )}

            {formError !== null && (
              <p className="reports__error" role="alert" data-testid="cell-error">
                {formError}
              </p>
            )}

            <div className="reports__actions">
              <Button data-testid="cell-cancel" onClick={() => setEditor(null)}>
                Отмена
              </Button>
              <Button
                variant="primary"
                disabled={
                  addOperation.isPending ||
                  (editor.kind !== 'EXPENSE_OTHER' && (desks.data?.items ?? []).length === 0)
                }
                data-testid="cell-submit"
                onClick={() => {
                  const value = evaluateMoney(amount);
                  if (value.minor === null) {
                    setFormError(value.error ?? 'Введите сумму.');
                    return;
                  }
                  if (CELL_OPERATIONS[editor.kind].needsReason && reason.trim().length < 3) {
                    setFormError('Опишите расход: не меньше трёх символов.');
                    return;
                  }

                  /*
                   * Ключ идемпотентности собирается из содержания операции.
                   * Двойное нажатие не создаёт вторую запись, а разные операции
                   * одного вида за день различаются суммой и пояснением.
                   */
                  addOperation.mutate({
                    minor: value.minor,
                    idempotencyKey: `cell:${editor.nonce}`,
                  });
                }}
              >
                Добавить
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
