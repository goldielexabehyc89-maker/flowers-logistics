/**
 * Правила экрана «История заказа», вынесенные из компонента.
 *
 * Здесь только чистые функции и типы: их проверяют без браузера. Ни одна из
 * них не решает, что произошло, — это решил сервер. Клиент лишь раскладывает
 * готовые строки по дням и называет автора по-человечески.
 */

import { formatCalendarDate, MOSCOW_LOCALE, MOSCOW_TIME_ZONE } from '@fl/shared';

export type TimelineGroup =
  'IMPORT' | 'FLORIST' | 'WAREHOUSE' | 'LOGISTICS' | 'DELIVERY' | 'RETURN';

export interface TimelineActorView {
  kind: 'USER' | 'SYSTEM' | 'SOURCE';
  userId: string | null;
  fullName: string | null;
  roles: string[];
}

export interface TimelineDetailView {
  label: string;
  value: string;
}

export interface TimelineEventView {
  key: string;
  occurredAt: string;
  /** Московская календарная дата события. Считает СЕРВЕР. */
  moscowDate: string;
  group: TimelineGroup;
  kind: string;
  title: string;
  actor: TimelineActorView;
  details: TimelineDetailView[];
  reverted: boolean;
  route: { id: string; number: string } | null;
}

export interface TimelineHeaderView {
  orderId: string;
  number: string;
  processState: string;
  externalState: string | null;
  pickup: boolean;
  deliveryDate: string | null;
  interval: { startMinute: number | null; endMinute: number | null; manual: boolean };
  address: string | null;
  florist: { id: string; fullName: string } | null;
  route: { id: string; number: string; state: string } | null;
  courier: { id: string; fullName: string } | null;
  cell: { code: string; kind: string } | null;
  delivery: { outcome: string; occurredAt: string; reason: string | null } | null;
  returnObligation: { displayNumber: string; state: string } | null;
  cancellation: { source: boolean; logist: boolean; occurredAt: string | null } | null;
}

export interface TimelinePage {
  header: TimelineHeaderView;
  events: TimelineEventView[];
  nextCursor: string | null;
  total: number;
}

export const GROUP_LABELS: Record<TimelineGroup, string> = {
  IMPORT: 'Заказ',
  FLORIST: 'Флорист',
  WAREHOUSE: 'Склад',
  LOGISTICS: 'Логистика',
  DELIVERY: 'Доставка',
  RETURN: 'Возврат',
};

export const PROCESS_LABELS: Record<string, string> = {
  NEW: 'Свободен',
  IN_ASSEMBLY: 'В сборке',
  ASSEMBLED: 'Собран',
  NEEDS_REVIEW: 'Требует проверки',
};

export const ROUTE_STATE_LABELS: Record<string, string> = {
  DRAFT: 'черновик',
  CONFIRMED: 'подтверждён',
  ACTIVE: 'отгружен',
  COMPLETED: 'завершён',
  CANCELLED: 'отменён',
};

export const RETURN_STATE_LABELS: Record<string, string> = {
  WITH_COURIER: 'у курьера',
  RETURNING: 'везут на склад',
  ACCEPTED: 'принят складом',
  CANCELLED: 'закрыт',
};

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'администратор',
  LOGISTICIAN: 'логист',
  FLORIST: 'флорист',
  WAREHOUSE: 'кладовщик',
  COURIER: 'курьер',
  MANAGER: 'менеджер',
};

/**
 * Кто сделал действие — одной строкой.
 *
 * Роль показывается только там, где источник сохранил её СНИМОК на момент
 * действия. Подставлять текущие роли нельзя: за месяцы они меняются, и строка
 * обещала бы, что кладовщик тогда был логистом.
 */
export function actorLine(actor: TimelineActorView): string {
  if (actor.kind === 'SOURCE') {
    return 'МойСклад';
  }
  if (actor.kind === 'SYSTEM' || actor.userId === null) {
    return 'Система';
  }
  const name = actor.fullName ?? 'Сотрудник';
  const roles = actor.roles.map((role) => ROLE_LABELS[role] ?? role.toLowerCase());
  return roles.length === 0 ? name : `${name} · ${roles.join(', ')}`;
}

/** Действующий интервал заказа человеческой строкой. */
export function intervalLine(interval: {
  startMinute: number | null;
  endMinute: number | null;
  manual: boolean;
}): string | null {
  if (interval.startMinute === null && interval.endMinute === null) {
    return null;
  }
  const text = `${minutes(interval.startMinute)}–${minutes(interval.endMinute)}`;
  return interval.manual ? `${text} · задан вручную` : text;
}

function minutes(value: number | null): string {
  if (value === null) {
    return '—';
  }
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * Строки, разложенные по московским дням.
 *
 * День берётся из строки события, а не считается заново: сервер уже назвал
 * московскую дату, и второй ответ на тот же вопрос разошёлся бы с первым
 * ровно на границе суток.
 */
export function groupByDay(
  events: readonly TimelineEventView[],
): { date: string; events: TimelineEventView[] }[] {
  const days: { date: string; events: TimelineEventView[] }[] = [];
  for (const entry of events) {
    const last = days[days.length - 1];
    if (last !== undefined && last.date === entry.moscowDate) {
      last.events.push(entry);
      continue;
    }
    days.push({ date: entry.moscowDate, events: [entry] });
  }
  return days;
}

/** `2026-08-24` → `24.08.2026`. Строка, а не `Date`: пояс к делу не относится. */
export function formatMoscowDay(value: string | null): string {
  return value === null ? '—' : formatCalendarDate(value);
}

/**
 * Время строки с секундами.
 *
 * Остальные экраны показывают часы и минуты — там этого достаточно. В истории
 * же соседние события одной операции происходят в одну и ту же минуту, и без
 * секунд порядок строк приходится принимать на веру.
 */
export function formatMoscowTime(value: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    return '—';
  }
  return new Intl.DateTimeFormat(MOSCOW_LOCALE, {
    timeZone: MOSCOW_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(instant);
}
