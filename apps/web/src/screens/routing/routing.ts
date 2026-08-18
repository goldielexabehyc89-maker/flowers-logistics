/**
 * Правила экрана маршрутизации, вынесенные из компонентов.
 *
 * Здесь только чистые функции и типы: их можно проверить тестами без браузера,
 * и именно они решают спорные вопросы — что показать вместо кода конфликта,
 * можно ли сейчас редактировать маршрут и какой порядок получится после сдвига
 * остановки вверх или вниз.
 */

import { formatCalendarDate, moscowToday } from '@fl/shared';

export type RouteState = 'DRAFT' | 'CONFIRMED' | 'CANCELLED' | 'ACTIVE';
export type VehicleType = 'CAR' | 'FOOT';

export interface RouteOrderView {
  routeOrderId: string;
  position: number;
  addedAt: string;
  assignmentState: string;
  conflicts: { kind: string; detectedAt: string }[];
  order: {
    id: string;
    number: string;
    deliveryDate: string | null;
    deliveryDateMatchesRoute: boolean;
    interval: {
      raw: string | null;
      kind: string;
      startMinute: number | null;
      endMinute: number | null;
      manualStartMinute: number | null;
      manualEndMinute: number | null;
    };
    address: string | null;
    recipient: string | null;
    comment: string | null;
    needsAttention: boolean;
    /** Заказ отменён: из состава не исчезает, но выдавать его нельзя. */
    cancelled?: boolean;
    attentionReasons: string[];
    cashToCollect: string | null;
    scope: { inScope: boolean; sourceMissing: boolean; sourceArchived: boolean };
  };
}

export interface EditLockView {
  locked: boolean;
  heldByCurrentSession: boolean;
  holder: { id: string; fullName: string } | null;
  expiresAt: string | null;
  leaseVersion: number | null;
}

export interface RouteCardView {
  id: string;
  number: string;
  deliveryDate: string;
  state: RouteState;
  vehicleType: VehicleType;
  version: number;
  createdAt: string;
  updatedAt: string;
  courier: { id: string; fullName: string } | null;
  conflictCount: number;
  editLock: EditLockView;
  confirmBlockers: { kind: string; orderIds: string[] }[];
  orders: RouteOrderView[];
}

export interface RouteListItem {
  id: string;
  number: string;
  deliveryDate: string;
  state: RouteState;
  vehicleType: VehicleType;
  version: number;
  createdAt: string;
  courier: { id: string; fullName: string } | null;
  orderCount: number;
  conflictCount: number;
}

export interface RouteListResponse {
  items: RouteListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface HistoryResponse {
  items: {
    occurredAt: string;
    action: string;
    actorUserId: string | null;
    actorRoles: string[];
    source: string;
    value: unknown;
  }[];
  transitions: {
    occurredAt: string;
    fromState: RouteState;
    toState: RouteState;
    actorUserId: string | null;
    reason: string | null;
  }[];
  total: number;
  transitionTotal: number;
  limit: number;
  offset: number;
}

export const VEHICLE_LABELS: Record<VehicleType, string> = {
  CAR: 'Автомобиль',
  FOOT: 'Пеший',
};

export const ROUTE_STATE_LABELS: Record<RouteState, string> = {
  DRAFT: 'Черновик',
  CONFIRMED: 'Подтверждён',
  CANCELLED: 'Отменён',
  /// Заказы физически переданы курьеру: маршрут начался (этап 6.5).
  ACTIVE: 'Передан курьеру',
};

/** Причины, по которым маршрут нельзя подтвердить, человеческим языком. */
export const BLOCKER_LABELS: Record<string, string> = {
  ROUTE_EMPTY: 'В маршруте нет заказов',
  ROUTE_HAS_CONFLICTS: 'У заказов есть расхождения с МоимСкладом',
  ORDER_NOT_ELIGIBLE:
    'Часть заказов больше не подходит: дата, склад или способ доставки изменились',
  ROUTE_COURIER_UNAVAILABLE: 'Назначенный курьер недоступен',
};

export function blockerLabel(kind: string): string {
  return BLOCKER_LABELS[kind] ?? kind;
}

/** Расхождения распределённого заказа. */
export const CONFLICT_LABELS: Record<string, string> = {
  DELIVERY_DATE_CHANGED: 'Дата доставки изменилась',
  SCOPE_LOST: 'Заказ вышел из нашей доставки',
  SOURCE_MISSING: 'Заказ не найден в МоемСкладе',
  SOURCE_ARCHIVED: 'Заказ архивирован в МоемСкладе',
};

export function conflictLabel(kind: string): string {
  return CONFLICT_LABELS[kind] ?? kind;
}

/** Действия аудита маршрута человеческим языком. */
export const ROUTE_ACTION_LABELS: Record<string, string> = {
  ROUTE_CREATED: 'Черновик создан',
  ROUTE_ORDERS_ADDED: 'Заказы добавлены',
  ROUTE_ORDERS_RETURNED: 'Заказы возвращены',
  ROUTE_ORDERS_MOVED: 'Заказы перемещены',
  ROUTE_ORDERS_REORDERED: 'Порядок изменён',
  ROUTE_COURIER_ASSIGNED: 'Курьер назначен',
  ROUTE_COURIER_UNASSIGNED: 'Курьер снят',
  ROUTE_CONFIRMED: 'Маршрут подтверждён',
  ROUTE_RETURNED_TO_DRAFT: 'Возвращён в черновик',
  ROUTE_CANCELLED: 'Маршрут отменён',
  ROUTE_EDIT_LOCK_ACQUIRED: 'Взят в работу',
  ROUTE_EDIT_LOCK_RELEASED: 'Освобождён',
  ROUTE_EDIT_LOCK_TAKEN_OVER: 'Редактирование перехвачено',
  ROUTE_ORDER_CONFLICT_DETECTED: 'Обнаружено расхождение заказа',
};

export function routeActionLabel(action: string): string {
  return ROUTE_ACTION_LABELS[action] ?? action;
}

/**
 * Можно ли сейчас менять маршрут.
 *
 * Решение сервера повторяется на клиенте не ради защиты — сервер и так откажет, —
 * а чтобы интерфейс не предлагал действий, которые заведомо не пройдут:
 * нажатая кнопка с последующим отказом раздражает сильнее, чем выключенная.
 */
export function canEdit(route: Pick<RouteCardView, 'state' | 'editLock'>): boolean {
  return route.state === 'DRAFT' && route.editLock.locked && route.editLock.heldByCurrentSession;
}

/** Почему редактирование недоступно. `null` означает «доступно». */
export function editingHint(route: Pick<RouteCardView, 'state' | 'editLock'>): string | null {
  if (route.state === 'ACTIVE') {
    return 'Заказы переданы курьеру: маршрут доступен только для просмотра.';
  }
  if (route.state === 'CANCELLED') {
    return 'Маршрут отменён и доступен только для просмотра.';
  }
  if (route.state === 'CONFIRMED') {
    return 'Маршрут подтверждён. Чтобы изменить состав, верните его в черновик.';
  }
  if (!route.editLock.locked) {
    return 'Возьмите маршрут в работу, чтобы редактировать состав.';
  }
  if (!route.editLock.heldByCurrentSession) {
    const holder = route.editLock.holder?.fullName ?? 'другой пользователь';
    return `Маршрут редактирует ${holder}. Можно перехватить с указанием причины.`;
  }
  return null;
}

/**
 * Новый порядок остановок после сдвига одной из них.
 *
 * Перетаскивание намеренно не используется: кнопками маршрут переставляется
 * и мышью, и с клавиатуры, и пальцем на телефоне, а библиотека drag-and-drop
 * добавила бы зависимость ради одного экрана.
 *
 * Возвращает `null`, если двигать некуда: тогда кнопка просто выключена.
 */
export function moveWithin(ids: readonly string[], id: string, direction: -1 | 1): string[] | null {
  const index = ids.indexOf(id);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= ids.length) {
    return null;
  }

  const next = [...ids];
  const moved = next[index];
  const replaced = next[target];
  if (moved === undefined || replaced === undefined) {
    return null;
  }
  next[index] = replaced;
  next[target] = moved;
  return next;
}

/**
 * Время экрана берётся из общего модуля.
 *
 * Прежде здесь лежала собственная копия «плюс три часа»; вторая такая же жила
 * на экране сделок. Копии расходятся молча, поэтому остались только имена,
 * привычные этому экрану.
 */
export { moscowToday };

/** `2026-08-07` → `07.08.2026`. */
export function formatDate(value: string | null): string {
  return formatCalendarDate(value);
}

/** `600` → `10:00`. */
export function formatMinutes(minute: number | null): string {
  if (minute === null) {
    return '—';
  }
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/**
 * Фактически используемый интервал остановки.
 * Ручное исправление логиста важнее текста источника: именно по нему поедет курьер.
 */
export function stopInterval(interval: RouteOrderView['order']['interval']): string {
  if (interval.manualStartMinute !== null && interval.manualEndMinute !== null) {
    return `${formatMinutes(interval.manualStartMinute)} – ${formatMinutes(interval.manualEndMinute)}`;
  }
  if (interval.kind === 'RANGE' && interval.startMinute !== null && interval.endMinute !== null) {
    return `${formatMinutes(interval.startMinute)} – ${formatMinutes(interval.endMinute)}`;
  }
  if (interval.kind === 'EXACT' && interval.startMinute !== null) {
    return `к ${formatMinutes(interval.startMinute)}`;
  }
  return '—';
}

/** Сообщение о конкурентном изменении. Повторять операцию автоматически нельзя. */
export const CONFLICT_MESSAGES: Record<string, string> = {
  STALE_VERSION:
    'Маршрут изменил другой пользователь. Мы обновили карточку — проверьте и повторите.',
  ORDER_ALREADY_IN_ROUTE: 'Заказ уже добавлен в другой маршрут.',
  ORDER_NOT_ELIGIBLE: 'Заказ больше не подходит этому маршруту: дата или склад изменились.',
  ROUTE_NOT_DRAFT: 'Маршрут больше не черновик. Карточка обновлена.',
  ROUTE_ORDER_SET_MISMATCH: 'Состав маршрута изменился. Карточка обновлена.',
  ROUTE_EMPTY: 'В маршруте нет заказов.',
  ROUTE_HAS_CONFLICTS: 'Сначала разберите расхождения заказов.',
  ROUTE_COURIER_UNAVAILABLE: 'Назначенный курьер недоступен.',
  EDIT_LOCK_REQUIRED: 'Возьмите маршрут в работу и повторите.',
  EDIT_LOCK_HELD_BY_OTHER: 'Маршрут сейчас редактирует другой пользователь.',
  EDIT_LOCK_STALE: 'Блокировка изменилась. Карточка обновлена.',

  /*
   * Причины, по которым расчёт не может начаться.
   *
   * Каждая требует своего действия, и общее «расчёт не удался» не подсказывает
   * ни одного из них: человек не знает, создавать склад, выбирать его адрес
   * заново или настраивать смену.
   */
  DEPOT_NOT_CONFIGURED: 'Не выбран основной склад',
  DEPOT_POINT_MISSING: 'У склада не определены координаты',
  SHIFT_NOT_CONFIGURED: 'Не настроена рабочая смена',
};

export function conflictMessage(kind: string | undefined, fallback: string): string {
  if (kind === undefined) {
    return fallback;
  }
  return CONFLICT_MESSAGES[kind] ?? fallback;
}

/**
 * Перестановка заказа на новое место списка.
 *
 * Используется перетаскиванием: заказ вынимается со своего места и вставляется
 * перед тем, на который его отпустили. Возвращает `null`, когда порядок
 * не изменился, — сохранять нечего, и лишний запрос только сбросил бы линию
 * маршрута ради прежнего результата.
 */
export function moveTo(ids: readonly string[], from: number, to: number): string[] | null {
  if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) {
    return null;
  }
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) {
    return null;
  }
  next.splice(to, 0, moved);
  return next;
}
