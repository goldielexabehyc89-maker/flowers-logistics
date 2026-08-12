/**
 * Правила отображения экрана «Сделки», вынесенные из компонентов.
 *
 * Здесь только чистые функции: их можно проверить тестами без браузера, и именно
 * они решают спорные вопросы — какой интервал считается фактическим, что показать
 * вместо пустого значения и как объяснить причину «Требует внимания» словами,
 * а не кодом перечисления.
 */

import { formatCalendarDate, formatMinutesOfDay, moscowToday } from '@fl/shared';

export interface OrderInterval {
  /** Исходный текст «Время доставки» из МоегоСклада, в том числе нераспознанный. */
  raw: string | null;
  kind: string;
  startMinute: number | null;
  endMinute: number | null;
  manualStartMinute: number | null;
  manualEndMinute: number | null;
}

export interface OrderMoney {
  sum: string;
  payed: string;
  cashToCollect: string;
  cashCollectable: boolean;
  anomaly: boolean;
}

export interface OrderView {
  id: string;
  number: string;
  deliveryDate: string | null;
  deliveryDateRaw: string | null;
  interval: OrderInterval;
  address: string | null;
  recipient: string | null;
  comment: string | null;
  externalState: { id: string | null; name: string | null; stateType: string | null };
  money: OrderMoney;
  scope: { inScope: boolean; exitReason: string | null; sourceMissing: boolean };
  needsAttention: boolean;
  attentionReasons: string[];
  updatedAt: string;
  version: number;
}

export interface OrderListResponse {
  items: OrderView[];
  total: number;
  limit: number;
  offset: number;
}

/** Прочерк вместо пустоты: пустая ячейка читается как «забыли показать». */
export const EMPTY_VALUE = '—';

/** Причины «Требует внимания» человеческим языком. */
export const ATTENTION_LABELS: Record<string, string> = {
  MISSING_DELIVERY_DATE: 'Не указана дата доставки',
  UNRECOGNIZED_DELIVERY_DATE: 'Дата доставки не распознана',
  MISSING_INTERVAL: 'Не указано время доставки',
  UNRECOGNIZED_INTERVAL: 'Время доставки не распознано',
  MISSING_ADDRESS: 'Не указан адрес',
  MISSING_RECIPIENT: 'Не указан получатель',
  CASH_OVERPAYMENT: 'Оплачено больше суммы заказа',
};

export function attentionLabel(reason: string): string {
  return ATTENTION_LABELS[reason] ?? reason;
}

/** Причины выхода заказа из нашей области. */
export const SCOPE_EXIT_LABELS: Record<string, string> = {
  STORE_CHANGED: 'Перенесён на другой склад',
  DELIVERY_METHOD_CHANGED: 'Способ доставки изменён',
  SOURCE_ARCHIVED: 'Архивирован в МоемСкладе',
  SOURCE_MISSING: 'Не найден в МоемСкладе',
};

/** `600` → `10:00`. */
export function formatMinutes(minute: number | null): string {
  return formatMinutesOfDay(minute);
}

/** `10:00` → `600`; всё остальное → `null`. */
export function parseMinutes(value: string): number | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export interface EffectiveInterval {
  /** Готовая строка для показа. */
  text: string;
  /** Значение задано логистом вручную. */
  manual: boolean;
}

/**
 * Фактически используемый интервал.
 *
 * Ручное исправление логиста имеет приоритет над текстом источника: именно по нему
 * будет строиться маршрут. Исходный текст МоегоСклада при этом не подменяется —
 * он показывается рядом отдельной строкой.
 */
export function effectiveInterval(interval: OrderInterval): EffectiveInterval {
  if (interval.manualStartMinute !== null && interval.manualEndMinute !== null) {
    return {
      text: `${formatMinutes(interval.manualStartMinute)} – ${formatMinutes(interval.manualEndMinute)}`,
      manual: true,
    };
  }

  if (interval.kind === 'RANGE' && interval.startMinute !== null && interval.endMinute !== null) {
    return {
      text: `${formatMinutes(interval.startMinute)} – ${formatMinutes(interval.endMinute)}`,
      manual: false,
    };
  }

  if (interval.kind === 'EXACT' && interval.startMinute !== null) {
    // Точное время не превращается в окно: придуманная граница выглядела бы фактом.
    return { text: `к ${formatMinutes(interval.startMinute)}`, manual: false };
  }

  return { text: EMPTY_VALUE, manual: false };
}

/** Заказы делятся ровно на две группы: требующие внимания и остальные. */
export interface DealGroups {
  attention: OrderView[];
  unassigned: OrderView[];
}

export function groupOrders(orders: readonly OrderView[]): DealGroups {
  return {
    attention: orders.filter((order) => order.needsAttention),
    unassigned: orders.filter((order) => !order.needsAttention),
  };
}

/**
 * Время экрана берётся из общего модуля: собственная копия «плюс три часа»
 * здесь больше не живёт.
 */
export { moscowToday };

/** `2026-08-07` → `07.08.2026`. Пустая дата остаётся честным прочерком. */
export function formatDate(value: string | null): string {
  return formatCalendarDate(value);
}

/** Деньги приходят десятичными строками и такими же показываются. */
export function formatMoney(value: string): string {
  return `${value} ₽`;
}

export type IntegrationState = 'NOT_CONFIGURED' | 'CONFIGURED' | 'OK' | 'DEGRADED' | 'ERROR';

export interface IntegrationView {
  tone: 'success' | 'warning' | 'error' | 'neutral' | 'info';
  label: string;
  hint: string;
}

/**
 * Состояние синхронизации для строки над списком.
 *
 * Технические подробности сюда не попадают: логисту важно, можно ли доверять
 * списку прямо сейчас. Коды и счётчики видит только администратор — на отдельном
 * экране состояния.
 */
export function describeIntegration(state: IntegrationState | undefined): IntegrationView {
  switch (state) {
    case 'OK':
      return {
        tone: 'success',
        label: 'Синхронизация работает',
        hint: 'Заказы обновляются автоматически.',
      };
    case 'DEGRADED':
      return {
        tone: 'warning',
        label: 'Временная ошибка синхронизации',
        hint: 'Список может отставать. Приложение повторяет попытки автоматически.',
      };
    case 'ERROR':
      return {
        tone: 'error',
        label: 'Синхронизация остановлена',
        hint: 'Новые заказы не поступают. Обратитесь к администратору.',
      };
    case 'CONFIGURED':
      return {
        tone: 'neutral',
        label: 'Синхронизация выключена',
        hint: 'Интеграция настроена, но автоматический обмен не запущен.',
      };
    default:
      return {
        tone: 'neutral',
        label: 'Интеграция не настроена',
        hint: 'Заказы из МоегоСклада пока не поступают.',
      };
  }
}
