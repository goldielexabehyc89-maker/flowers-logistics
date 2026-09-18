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
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  StatusBadge,
  TextInput,
} from '../../ui/components';
import {
  formatMoscowDateTime,
  ledgerEntryTitle,
  ledgerKindLabel,
  shiftCalendarDate,
  VEHICLE_TYPE_LABELS,
} from '@fl/shared';
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
  /** Начальный долг, заведённый в этом периоде: отдельная строка, не заработок. */
  openingDebtMinor: string;
  /** Корректировки наличных после оплаты в источнике: со знаком, обычно минус. */
  cashCorrectionsMinor: string;
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
  vehicleType: 'CAR' | 'FOOT' | null;
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
  /** Финансовый результат доставки снят: деньги по заказу не действуют. */
  financeCancelled: boolean;
  sourceCancelled: boolean;
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
  /** Что именно отменяет обратная запись. */
  reversesKind: string | null;
  reversesEntryId: string | null;
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
  openingDebtMinor: string;
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

/** Сколько групп «день + курьер» показывать за раз. */
const GROUPS_PER_PAGE = 25;

/**
 * Предел, согласованный с сервером (`SETTLEMENT_GROUPS_LIMIT`).
 *
 * Страница наращивает `limit`, не двигая `offset`, поэтому дальше этого числа
 * групп показать нечем. Упереться молча нельзя: человек должен понимать, что
 * видит не весь период, и сузить срок.
 */
const GROUPS_LIMIT = 1000;

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
 *
 * Отсчёт идёт от МОСКОВСКОЙ операционной даты и по календарю строки. Прежний
 * `new Date().toISOString()` брал UTC-день браузера: с полуночи до трёх часов
 * ночи по Москве отчёт молча показывал вчерашний день, а у пользователя за
 * Уралом — завтрашний.
 */
function periodRange(days: number): { from: string; to: string } {
  const to = moscowToday();
  return { from: shiftCalendarDate(to, -days), to };
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
 * Столбцы таблицы расчётов — ОДИН список на шапку и на журнал.
 *
 * Шапка рисуется отсюда, и номер столбца для суммы журнала считается отсюда же.
 * Пока номера были вписаны в код числами, они могли разойтись с шапкой при
 * первой же вставке столбца: суммы уехали бы под соседние заголовки молча.
 */
export const SETTLEMENT_COLUMNS: readonly string[] = [
  'Дата',
  'Курьер',
  'Листы',
  'Заказы',
  'Статус',
  'Наличные',
  'За заказ',
  'За МКАД',
  'Доп.',
  'Начислено',
  'Курьер сдал',
  'Выдано курьеру',
  'Итог',
];

/**
 * Под каким ЗАГОЛОВКОМ стоит сумма операции журнала.
 *
 * Именно заголовком, а не числом: столбцы задаются одним списком, шапка
 * рисуется из него же, и номер считается по имени. Номера в коде расходились
 * бы с шапкой при первой же вставке столбца — молча и незаметно.
 *
 * Правило одно: операция встаёт под тем столбцом, в чей итог дня она вошла
 * на сервере (`grouping.ts`). Наличные, оплата заказа и километры имеют свои
 * столбцы; расходы и доплаты — «Доп.»; у оплачиваемой попытки своего столбца
 * нет, и она показывается под «Начислено», куда и входит.
 */
const JOURNAL_HEADERS: Record<string, string> = {
  CASH_RECEIVED: 'Наличные',
  DELIVERY_FEE: 'За заказ',
  DISTANCE_FEE: 'За МКАД',
  ATTEMPT_FEE: 'Начислено',
  CASH_HANDED_TO_LOGIST: 'Курьер сдал',
  CASH_ISSUED_TO_COURIER: 'Выдано курьеру',
};

/**
 * Первый столбец, в котором вообще может стоять сумма журнала.
 *
 * Слева от него — дата, название операции и автор на две ячейки. Заголовок из
 * этой части дал бы отрицательный colSpan у ячейки основания и сломал бы
 * строку целиком, а заметить это можно было бы только глазами.
 */
const FIRST_MONEY_COLUMN = 6;

export function journalColumn(kind: string): number {
  const column = SETTLEMENT_COLUMNS.indexOf(JOURNAL_HEADERS[kind] ?? 'Доп.') + 1;
  return column < FIRST_MONEY_COLUMN ? SETTLEMENT_COLUMNS.indexOf('Доп.') + 1 : column;
}

/**
 * Подпись и слова под итогом периода.
 *
 * Отдельной чистой функцией: это решение о том, что человек прочитает как
 * «баланс», и оно обязано быть проверяемым без рендера. Признак — сам ОТБОР,
 * а не найденное имя: справочник отдаёт первую сотню активных курьеров и
 * может ещё не загрузиться, и по имени отчёт по выбранному курьеру
 * подписывался бы «все курьеры».
 */
export function balanceCaption(
  courierUserId: string,
  courierName: string | null,
  closingBalanceMinor: string,
): { title: string; words: string; showOpening: boolean } {
  if (courierUserId === '') {
    return {
      title: 'Изменение за период · все курьеры',
      words: 'выберите курьера, чтобы увидеть его баланс',
      showOpening: false,
    };
  }
  return {
    title: `Конечный баланс${courierName === null ? '' : ` · ${courierName}`}`,
    words: debtWords(closingBalanceMinor),
    showOpening: true,
  };
}

/** Показывать ли кнопку «Показать ещё»: дальше предела отчёт не листается. */
export function canShowMore(hasMore: boolean, pages: number): boolean {
  return hasMore && GROUPS_PER_PAGE * pages < GROUPS_LIMIT;
}

/**
 * Операции, которым нужна СВОЯ строка журнала.
 *
 * Их нельзя ставить под денежные и зарплатные столбцы: начальный долг, его
 * отмена и корректировка наличных меняют только баланс. В общем виде сумма
 * встала бы под «Доп.» или «Начислено», и снятие долга читалось бы как
 * положительная зарплата. Поэтому такие строки называют операцию словами,
 * показывают знак и направление и ссылаются на исходную запись.
 */
export function correctiveOperation(
  entry: Pick<LedgerEntry, 'kind' | 'amountMinor' | 'reversesKind'>,
): { title: string; direction: string } | null {
  if (entry.kind === 'OPENING_DEBT') {
    return { title: ledgerKindLabel(entry.kind), direction: 'увеличивает долг' };
  }
  if (entry.kind === 'CASH_PAYMENT_CORRECTION') {
    return {
      title: ledgerKindLabel(entry.kind),
      direction: 'уменьшает наличные за курьером',
    };
  }
  if (entry.kind === 'ADJUSTMENT') {
    const negative = BigInt(entry.amountMinor) < 0n;
    return {
      /*
       * Название берётся из ОБЩЕГО словаря — того же, что у выгрузки.
       * Пока названия жили в двух местах, одна и та же строка называлась на
       * экране и в файле по-разному, и найти её в выгрузке было нельзя.
       */
      title: ledgerEntryTitle(entry),
      direction: negative ? 'уменьшает долг' : 'увеличивает долг',
    };
  }
  return null;
}

/** Знак суммы словом-символом: направление должно читаться без догадок. */
export function signOf(minor: string): string {
  return BigInt(minor) < 0n ? '−' : '+';
}

/**
 * «Доп.» одной доставки: расходы и доплаты, привязанные к её попытке.
 *
 * Считается там же, где и у дня (`grouping.ts`), чтобы сумма строк сходилась
 * с итогом дня. Без общего правила строка показывала бы прочерк, а день —
 * деньги, и объяснить разницу было бы нечем.
 */
export function rowExtra(row: { expensesMinor: string; bonusesMinor: string }): string {
  return (BigInt(row.expensesMinor) + BigInt(row.bonusesMinor)).toString();
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

export function ReportsScreen(): React.JSX.Element {
  const { client, user } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const today = moscowToday();
  /**
   * Начальный долг заводит и отменяет только администратор.
   *
   * Кнопка скрыта не вместо проверки прав, а вместе с ней: сервер отвечает
   * отказом и на прямой запрос, поэтому скрытие здесь — только про удобство.
   */
  const isAdmin = (user?.roles ?? []).includes('ADMIN');

  /*
   * Кому предлагать отмену операции.
   *
   * Отмена ПЕРЕДАЧИ наличных двигает кассу конкретного логиста, поэтому сервер
   * требует права на неё: администратор или сам владелец кассы. Управляющий
   * кассы не имеет вовсе. Без этой проверки кнопка предлагалась всем, кто видит
   * отчёт, и заканчивалась отказом — а обещать действие, которое всегда
   * отклоняют, хуже, чем не показывать его.
   *
   * Это удобство, а не защита: сервер отвечает отказом и на прямой запрос.
   */
  const canReverse = (entry: LedgerEntry): boolean => {
    const isTransfer =
      entry.kind === 'CASH_HANDED_TO_LOGIST' || entry.kind === 'CASH_ISSUED_TO_COURIER';
    if (!isTransfer) {
      return true;
    }
    return isAdmin || (user?.roles ?? []).includes('LOGISTICIAN');
  };

  const [mode, setMode] = useState<'SETTLEMENTS' | 'CASH' | 'OPERATIONS'>('SETTLEMENTS');
  /*
   * По умолчанию — «День», то есть сегодняшняя московская операционная дата.
   *
   * Раньше экран открывался на неделе: логист приходит за сегодняшней кассой
   * и расчётом, а видел сумму за семь дней и принимал её за дневную. Другие
   * сроки остаются на месте и по-прежнему переключаются кнопками.
   */
  const [from, setFrom] = useState(today);
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
  /**
   * Форма начального долга.
   *
   * `nonce` — ключ идемпотентности окна: двойное нажатие и сетевой повтор
   * ссылаются на один и тот же ключ и не создают вторую запись. Новое окно
   * получает новый ключ, поэтому осознанно внести второй долг по-прежнему можно.
   */
  const [openingDebt, setOpeningDebt] = useState<{
    courierUserId: string;
    amount: string;
    operationDate: string;
    reason: string;
    nonce: string;
  } | null>(null);
  const [openingDebtError, setOpeningDebtError] = useState<string | null>(null);
  /** Шаг подтверждения: показываем, на сколько и кому вырастет долг. */
  const [openingDebtConfirm, setOpeningDebtConfirm] = useState(false);

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
      search.set('limit', String(Math.min(GROUPS_PER_PAGE * pages, GROUPS_LIMIT)));
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

  /*
   * Уже заведённые начальные долги выбранного курьера.
   *
   * Долг до перехода на ERP по смыслу вносится один раз, поэтому перед вторым
   * внесением администратор обязан увидеть первое — иначе долг удвоится молча.
   */
  const existingOpeningDebts = useQuery({
    queryKey: ['opening-debts', openingDebt?.courierUserId ?? ''],
    enabled: isAdmin && openingDebt !== null && openingDebt.courierUserId !== '',
    queryFn: () =>
      client.get<{ entries: LedgerEntry[] }>(
        `/api/logistics/ledger/opening-debt?courierUserId=${openingDebt?.courierUserId ?? ''}`,
      ),
  });

  const addOpeningDebt = useMutation({
    mutationFn: (input: { minor: bigint }) =>
      client.post('/api/logistics/ledger/opening-debt', {
        courierUserId: openingDebt?.courierUserId ?? '',
        amountMinor: input.minor.toString(),
        operationDate: openingDebt?.operationDate ?? today,
        reason: openingDebt?.reason.trim() ?? '',
        idempotencyKey: `opening-debt:${openingDebt?.nonce ?? ''}`,
      }),
    onSuccess: () => {
      setOpeningDebt(null);
      setOpeningDebtConfirm(false);
      showToast('Начальный долг внесён', 'success');
      void queryClient.invalidateQueries({ queryKey: ['opening-debts'] });
      refresh();
    },
    onError: (error: unknown) => {
      setOpeningDebtConfirm(false);
      setOpeningDebtError(
        (error as { message?: string }).message ?? 'Не удалось внести начальный долг',
      );
    },
  });

  const reverseOpeningDebt = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      client.post(`/api/logistics/ledger/opening-debt/${input.id}/reverse`, {
        reason: input.reason,
      }),
    onSuccess: () => {
      showToast('Начальный долг отменён обратной записью', 'success');
      void queryClient.invalidateQueries({ queryKey: ['opening-debts'] });
      refresh();
    },
    onError: (error: unknown) =>
      showToast(
        (error as { message?: string }).message ?? 'Не удалось отменить начальный долг',
        'error',
      ),
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
            {/*
              Долг до перехода на ERP заводит только администратор: это ручной
              ввод исторической суммы, которую система ничем не подтверждает.
              Форма работает и для курьера без единой доставки.
            */}
            {isAdmin && (
              <Button
                data-testid="reports-opening-debt-open"
                onClick={() => {
                  setOpeningDebtError(null);
                  setOpeningDebtConfirm(false);
                  setOpeningDebt({
                    courierUserId,
                    amount: '',
                    // День учёта выбирает человек. По умолчанию — сегодняшний
                    // московский день, а не дата перехода на ERP и не дата
                    // выкладки: подставить их молча означало бы решить за него.
                    operationDate: today,
                    reason: '',
                    nonce: globalThis.crypto.randomUUID(),
                  });
                }}
              >
                Внести начальный долг
              </Button>
            )}
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
              {/*
                Баланс существует только у КОНКРЕТНОГО курьера.

                Без отбора начальный баланс сервер отдаёт нулём, и «конечный
                баланс» превращался в изменение за период, подписанное словами
                «курьер должен компании». При ненулевых входящих сальдо это
                прямая дезинформация о направлении долга — поэтому без курьера
                показывается изменение и называется изменением.

                Признак — сам ОТБОР, а не найденное имя: справочник отдаёт
                первую сотню активных курьеров и может ещё не загрузиться.
                По имени отчёт по выбранному курьеру подписывался бы «все
                курьеры», а его настоящий начальный баланс прятался.
              */}
              <div className="reports__balance" data-testid="reports-balance">
                <span className="reports__balance-title">
                  {
                    balanceCaption(
                      courierUserId,
                      courierName,
                      settlements.data.totals.closingBalanceMinor,
                    ).title
                  }
                </span>
                <span className="reports__balance-value" data-testid="reports-closing">
                  {formatMoney(settlements.data.totals.closingBalanceMinor)}
                </span>
                <span className="reports__balance-words">
                  {
                    balanceCaption(
                      courierUserId,
                      courierName,
                      settlements.data.totals.closingBalanceMinor,
                    ).words
                  }
                </span>
                {balanceCaption(
                  courierUserId,
                  courierName,
                  settlements.data.totals.closingBalanceMinor,
                ).showOpening ? (
                  <span className="reports__balance-opening">
                    Начальный {formatMoney(settlements.data.totals.openingBalanceMinor)}
                  </span>
                ) : null}
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

            {/*
              Начальный долг стоит отдельной строкой, а не плиткой среди
              показателей периода: это долг курьера до перехода на ERP, а не
              его заработок и не движение наличных, и смешивать их нельзя.
              В периодах после дня учёта сумма уже сидит в начальном балансе.
            */}
            {settlements.data.totals.cashCorrectionsMinor !== '0' && (
              <p
                className="reports__notice"
                role="status"
                data-testid="reports-cash-corrections-total"
              >
                Корректировки наличных за период:{' '}
                {signOf(settlements.data.totals.cashCorrectionsMinor)}
                {formatMoney(absMoney(settlements.data.totals.cashCorrectionsMinor))} — заказы
                оплатили в МоемСкладе уже после доставки, столько наличных курьер не сдаёт.
              </p>
            )}

            {settlements.data.totals.openingDebtMinor !== '0' && (
              <p className="reports__notice" role="status" data-testid="reports-opening-debt-total">
                Начальный долг за период: {formatMoney(settlements.data.totals.openingDebtMinor)} —
                долг курьера перед компанией, возникший до перехода на ERP. Не заработок и не
                движение наличных.
              </p>
            )}

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
                        {/*
                          Шапка рисуется из того же списка, по которому журнал
                          вычисляет свой столбец: два места разошлись бы.
                        */}
                        {SETTLEMENT_COLUMNS.map((name) => (
                          <th key={name}>{name}</th>
                        ))}
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
                                {/*
                                  Итог дня — число, а пометка стоит РЯДОМ.
                                  Достаточно одной строки без тарифного снимка,
                                  чтобы слова заменили итог всего дня, — при том
                                  что деньги входят в баланс курьера и в итоги
                                  периода, а в выгрузке число сохраняется.
                                */}
                                {formatMoney(group.totalMinor)}
                                {/*
                                  Начальный долг не попадает ни в один столбец:
                                  он не заработок и не движение наличных. Но в
                                  итог дня входит, и без пояснения строка
                                  показывала бы нули во всех столбцах при
                                  ненулевом итоге.
                                */}
                                {BigInt(group.openingDebtMinor) !== 0n ? (
                                  <span className="muted text-sm">
                                    {' '}
                                    в т. ч. начальный долг {formatMoney(group.openingDebtMinor)}
                                  </span>
                                ) : null}
                                {group.settlementMissing ? (
                                  <span className="reports__missing"> Расчёт отсутствует</span>
                                ) : null}
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
                                  {row.vehicleType !== null && (
                                    <span className="muted text-sm">
                                      {' · '}
                                      {VEHICLE_TYPE_LABELS[row.vehicleType]}
                                      {row.perOrderMinor === null
                                        ? ''
                                        : ` · ставка ${formatMoney(row.perOrderMinor)}`}
                                    </span>
                                  )}
                                </td>
                                <td colSpan={2} />
                                <td>
                                  {/* Исход — плашка: по ней разбирают строку, а не читают её как текст. */}
                                  <StatusBadge
                                    tone={row.outcome === 'DELIVERED' ? 'success' : 'error'}
                                  >
                                    {row.outcome === 'DELIVERED' ? 'Доставлен' : 'Не доставлен'}
                                    {row.cancelled ? ' (результат отменён)' : ''}
                                    {/*
                                      Отмена заказа в источнике — не отмена
                                      результата. Показывается всегда, в каком
                                      бы дне ни сняли деньги: иначе отменённый
                                      заказ читался бы как обычная доставка.
                                    */}
                                    {row.sourceCancelled ? ' (отменён в МоемСкладе)' : ''}
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
                                {/*
                                  «Доп.» строки: расход или доплату можно
                                  привязать к попытке. Такая сумма входит в
                                  «Доп.» и «Начислено» дня, и не показать её
                                  здесь значило бы оставить итог дня без
                                  объяснения. Сдача и выдача — операции дня,
                                  к заказу они не относятся.
                                */}
                                <td>{formatMoney(rowExtra(row))}</td>
                                <td>
                                  {formatMoney(
                                    (
                                      BigInt(row.deliveryFeeMinor) +
                                      BigInt(row.distanceFeeMinor) +
                                      BigInt(row.attemptFeeMinor) +
                                      BigInt(rowExtra(row))
                                    ).toString(),
                                  )}
                                </td>
                                <td />
                                <td />
                                <td>
                                  {/*
                                    Пометки СКЛАДЫВАЮТСЯ, а не вытесняют друг
                                    друга — как и в выгрузке. Отсутствие расчёта
                                    раньше затирало «Финрезультат отменён», и
                                    одна и та же строка в файле была помечена,
                                    а на экране нет.
                                  */}
                                  {formatMoney(row.totalMinor)}
                                  {row.settlementMissing ? (
                                    <span className="reports__missing"> Расчёт отсутствует</span>
                                  ) : null}
                                  {row.financeCancelled ? (
                                    /*
                                          Доставка состоялась, но за этот день
                                          её деньги сняты целиком. Число
                                          остаётся на месте: оно входит в итог
                                          дня и периода, и прятать его нельзя —
                                          пометка объясняет ноль, а не заменяет
                                          его.
                                        */
                                    <span
                                      className="reports__missing"
                                      data-testid="reports-finance-cancelled"
                                      title="Начисления этой доставки сняты обратными записями того же дня; факт доставки сохранён"
                                    >
                                      {' '}
                                      Финрезультат отменён
                                    </span>
                                  ) : null}
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
                            /*
                             * Начальный долг показывается своей строкой.
                             *
                             * В общем виде сумма встала бы под столбец «Доп.»,
                             * то есть выглядела бы дополнительным начислением
                             * зарплаты. Это не так: долг до перехода на ERP
                             * меняет только баланс. Поэтому сумма стоит под
                             * «Итогом», названа со знаком и словами о
                             * направлении, рядом видно основание, а отменить
                             * её может только администратор.
                             */
                            const corrective = correctiveOperation(entry);
                            if (corrective !== null) {
                              rows.push(
                                <tr
                                  key={entry.id}
                                  className="reports__detail reports__payment"
                                  data-entry-kind={entry.kind}
                                  data-testid="reports-payment"
                                >
                                  <td>{formatMoscowDateTime(entry.occurredAt)}</td>
                                  <td className="reports__detail-order">{corrective.title}</td>
                                  <td colSpan={2}>{entry.actorName ?? 'автор неизвестен'}</td>
                                  <td
                                    className="reports__detail-reason"
                                    colSpan={SETTLEMENT_COLUMNS.length - 6}
                                    title={entry.reason ?? undefined}
                                  >
                                    {entry.reason ?? ''}
                                  </td>
                                  <td>
                                    {entry.reversed ? (
                                      <span className="muted text-sm">отменён</span>
                                    ) : (
                                      entry.kind === 'OPENING_DEBT' &&
                                      isAdmin && (
                                        <button
                                          type="button"
                                          className="reports__reverse"
                                          data-testid="reports-opening-debt-reverse"
                                          onClick={() => {
                                            const value = globalThis.prompt(
                                              `Причина отмены начального долга. Отмена будет записана отдельной обратной записью за ${formatDate(today)} и уменьшит долг на ${formatMoney(absMoney(entry.amountMinor))}.`,
                                            );
                                            if (value !== null && value.trim().length >= 3) {
                                              reverseOpeningDebt.mutate({
                                                id: entry.id,
                                                reason: value.trim(),
                                              });
                                            }
                                          }}
                                        >
                                          Отменить
                                        </button>
                                      )
                                    )}
                                  </td>
                                  <td data-testid="reports-corrective-amount">
                                    {signOf(entry.amountMinor)}
                                    {formatMoney(absMoney(entry.amountMinor))}
                                    <span className="muted text-sm"> {corrective.direction}</span>
                                  </td>
                                </tr>,
                              );
                              continue;
                            }

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
                                  {ledgerKindLabel(entry.kind)}
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
                                <td colSpan={SETTLEMENT_COLUMNS.length - journalColumn(entry.kind)}>
                                  {entry.reversed ? (
                                    <span className="muted text-sm">отменена</span>
                                  ) : (
                                    entry.kind !== 'ADJUSTMENT' &&
                                    canReverse(entry) && (
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

                {settlements.data.hasMore &&
                  (canShowMore(settlements.data.hasMore, pages) ? (
                    <Button
                      data-testid="reports-more"
                      onClick={() => setPages((current) => current + 1)}
                    >
                      Показать ещё
                    </Button>
                  ) : (
                    <p className="reports__notice" role="status" data-testid="reports-limit">
                      Показаны первые {GROUPS_LIMIT} групп «день + курьер». Дальше отчёт не
                      листается — выберите более короткий срок или отдельного курьера.
                    </p>
                  ))}
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

      {/*
        Внесение начального долга.

        Форма работает и для курьера, у которого ещё нет ни одной доставки и ни
        одной строки в отчёте: список курьеров не зависит от наличия расчётов.
      */}
      {openingDebt !== null && !openingDebtConfirm && (
        <Modal
          open
          title="Внести начальный долг"
          onClose={() => {
            setOpeningDebt(null);
            setOpeningDebtConfirm(false);
          }}
        >
          <div className="stack" data-testid="opening-debt-form">
            <p className="muted text-sm">
              Долг курьера перед компанией, возникший до перехода на ERP. Не влияет на кассы, на
              оплату доставок и на расходы.
            </p>

            <Field label="Курьер" hint="Можно выбрать курьера без доставок">
              {() => (
                <CourierCombobox
                  options={couriers.data?.items ?? []}
                  value={
                    (couriers.data?.items ?? []).find(
                      (item) => item.id === openingDebt.courierUserId,
                    ) ?? null
                  }
                  label="Курьер"
                  emptyLabel="Выберите курьера"
                  testId="opening-debt-courier"
                  onChange={(courier) => {
                    setOpeningDebtError(null);
                    setOpeningDebt({
                      ...openingDebt,
                      courierUserId: courier === null ? '' : courier.id,
                    });
                  }}
                />
              )}
            </Field>

            {/*
              Долг по смыслу вносится один раз. Если он уже заводился, человек
              обязан увидеть это до второго внесения — иначе долг удвоится.
            */}
            {(existingOpeningDebts.data?.entries ?? []).length > 0 && (
              <div className="reports__notice" role="status" data-testid="opening-debt-existing">
                <strong>Начальный долг этому курьеру уже вносили.</strong> Повторное внесение
                увеличит долг ещё раз.
                <ul>
                  {(existingOpeningDebts.data?.entries ?? []).map((entry) => (
                    <li key={entry.id}>
                      {formatDate(entry.operationDate)} · {formatMoney(absMoney(entry.amountMinor))}
                      {entry.reversed ? ' · отменён' : ''}
                      {entry.reason === null ? '' : ` · ${entry.reason}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Field label="Сумма долга, ₽" hint="Строго больше нуля. Можно считать: 1000+500">
              {(props) => (
                <TextInput
                  {...props}
                  value={openingDebt.amount}
                  inputMode="text"
                  autoFocus
                  data-testid="opening-debt-amount"
                  onChange={(event) => {
                    setOpeningDebtError(null);
                    setOpeningDebt({ ...openingDebt, amount: event.target.value });
                  }}
                />
              )}
            </Field>

            {previewOf(openingDebt.amount) !== null && (
              <p className="muted text-sm" data-testid="opening-debt-preview">
                Получится {previewOf(openingDebt.amount)}
              </p>
            )}

            <Field label="Дата учёта" hint="День, к которому относится долг">
              {(props) => (
                <TextInput
                  {...props}
                  type="date"
                  value={openingDebt.operationDate}
                  data-testid="opening-debt-date"
                  onChange={(event) => {
                    setOpeningDebtError(null);
                    setOpeningDebt({ ...openingDebt, operationDate: event.target.value });
                  }}
                />
              )}
            </Field>

            {/*
              Дата решает, в каком отчёте долг виден операцией, а в каком уже
              лежит в начальном балансе. Без объяснения это выглядит произволом.
            */}
            <p className="muted text-sm" data-testid="opening-debt-date-hint">
              В отчётах, которые заканчиваются раньше {formatDate(openingDebt.operationDate)}, долг
              не виден. В отчёте за {formatDate(openingDebt.operationDate)} он показан отдельной
              операцией. В отчётах со следующего дня входит в начальный баланс.
            </p>

            <Field label="Основание" hint="Обязательно: на каком основании внесён долг">
              {(props) => (
                <TextInput
                  {...props}
                  value={openingDebt.reason}
                  data-testid="opening-debt-reason"
                  onChange={(event) => {
                    setOpeningDebtError(null);
                    setOpeningDebt({ ...openingDebt, reason: event.target.value });
                  }}
                />
              )}
            </Field>

            {openingDebtError !== null && (
              <p className="reports__error" role="alert" data-testid="opening-debt-error">
                {openingDebtError}
              </p>
            )}

            <div className="reports__actions">
              <Button
                data-testid="opening-debt-cancel"
                onClick={() => {
                  setOpeningDebt(null);
                  setOpeningDebtConfirm(false);
                }}
              >
                Отмена
              </Button>
              <Button
                variant="primary"
                disabled={addOpeningDebt.isPending}
                data-testid="opening-debt-submit"
                onClick={() => {
                  if (openingDebt.courierUserId === '') {
                    setOpeningDebtError('Выберите курьера.');
                    return;
                  }
                  const value = evaluateMoney(openingDebt.amount);
                  if (value.minor === null) {
                    setOpeningDebtError(value.error ?? 'Введите сумму.');
                    return;
                  }
                  if (openingDebt.operationDate === '') {
                    setOpeningDebtError('Укажите дату учёта.');
                    return;
                  }
                  if (openingDebt.reason.trim().length < 3) {
                    setOpeningDebtError('Укажите основание: не меньше трёх символов.');
                    return;
                  }
                  setOpeningDebtConfirm(true);
                }}
              >
                Внести долг
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/*
        Подтверждение называет направление, сумму, курьера и дату: вводится
        историческая сумма, которую система ничем не проверит.
      */}
      {openingDebt !== null && (
        <ConfirmDialog
          open={openingDebtConfirm}
          title="Внести начальный долг?"
          description={`Долг курьера перед компанией увеличится на ${previewOf(openingDebt.amount) ?? ''}. Курьер: ${
            (couriers.data?.items ?? []).find((item) => item.id === openingDebt.courierUserId)
              ?.fullName ?? '—'
          }. Дата учёта: ${formatDate(openingDebt.operationDate)}.`}
          confirmLabel="Подтвердить внесение"
          busy={addOpeningDebt.isPending}
          onCancel={() => setOpeningDebtConfirm(false)}
          onConfirm={() => {
            const value = evaluateMoney(openingDebt.amount);
            if (value.minor === null) {
              setOpeningDebtConfirm(false);
              setOpeningDebtError(value.error ?? 'Введите сумму.');
              return;
            }
            addOpeningDebt.mutate({ minor: value.minor });
          }}
        />
      )}
    </section>
  );
}
