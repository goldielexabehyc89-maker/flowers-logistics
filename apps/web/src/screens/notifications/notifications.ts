/**
 * Типы и подписи вкладки «Уведомления».
 *
 * Чистые данные и функции: их проверяют без браузера. Состав уведомления и
 * текущее состояние заказа приходят с сервера; здесь только человеческие
 * подписи и раскладка.
 */

export interface CompositionDiff {
  added: { name: string; quantity: string }[];
  removed: { name: string; quantity: string }[];
  quantityChanged: { name: string; old: string; new: string }[];
  parameterChanged: { name: string }[];
}

export interface NotificationPayload {
  fields: { category: string; label: string; old: string | null; new: string | null }[];
  composition: CompositionDiff | null;
}

export interface OrderStateView {
  kind:
    | 'UNASSIGNED'
    | 'WITH_FLORIST'
    | 'AWAITING_INTAKE'
    | 'IN_STORAGE_CELL'
    | 'IN_ROUTE_CELL'
    | 'IN_ROUTE'
    | 'WITH_COURIER'
    | 'DELIVERED'
    | 'CANCELLED'
    | 'WRITTEN_OFF';
  cellCode?: string;
  routeNumber?: string;
  routeState?: string;
  courierName?: string;
}

export interface NotificationView {
  id: string;
  orderId: string;
  orderNumber: string;
  occurredAt: string;
  source: string;
  categories: string[];
  kind: string;
  payload: NotificationPayload;
  read: boolean;
  currentState: OrderStateView;
  decision: {
    assignedFloristId: string;
    assignedFloristName: string;
    decidedByName: string;
    assemblyRound: number;
    decidedAt: string;
  } | null;
}

export interface NotificationsResponse {
  items: NotificationView[];
  total: number;
  unread: number;
}

/** Источник изменения словами. */
export function sourceLabel(source: string): string {
  return source === 'MOYSKLAD_SYNC' ? 'МойСклад (синхронизация)' : source;
}

const ROUTE_STATE_LABEL: Record<string, string> = {
  DRAFT: 'черновик',
  CONFIRMED: 'подтверждён',
  ACTIVE: 'активен',
  COMPLETED: 'завершён',
  CANCELLED: 'отменён',
};

/**
 * Текущее состояние заказа словами. Всегда ясно, в маршрутном ли листе заказ и
 * в каком именно: номер листа входит в подпись везде, где он есть.
 */
export function orderStateLabel(state: OrderStateView): string {
  switch (state.kind) {
    case 'UNASSIGNED':
      return 'Не назначен в маршрутный лист';
    case 'WITH_FLORIST':
      return 'У флориста';
    case 'AWAITING_INTAKE':
      return 'Собран, ожидает приёмки';
    case 'IN_STORAGE_CELL':
      return `В ячейке хранения ${state.cellCode ?? ''}`.trim();
    case 'IN_ROUTE_CELL':
      return `В маршрутной ячейке ${state.cellCode ?? ''}${
        state.routeNumber === undefined ? '' : ` · МЛ ${state.routeNumber}`
      }`.trim();
    case 'IN_ROUTE':
      return `В маршрутном листе ${state.routeNumber ?? ''}${
        state.routeState === undefined
          ? ''
          : ` (${ROUTE_STATE_LABEL[state.routeState] ?? state.routeState})`
      }`.trim();
    case 'WITH_COURIER':
      return `У курьера${state.courierName === undefined ? '' : ` ${state.courierName}`} · МЛ ${
        state.routeNumber ?? ''
      }`.trim();
    case 'DELIVERED':
      return `Доставлен${state.routeNumber === undefined ? '' : ` · МЛ ${state.routeNumber}`}`;
    case 'CANCELLED':
      return 'Отменён';
    case 'WRITTEN_OFF':
      return 'Списан';
    default:
      return '—';
  }
}

/** Есть ли в diff состава хоть одно изменение. */
export function hasCompositionChange(diff: CompositionDiff | null): boolean {
  if (diff === null) {
    return false;
  }
  return (
    diff.added.length > 0 ||
    diff.removed.length > 0 ||
    diff.quantityChanged.length > 0 ||
    diff.parameterChanged.length > 0
  );
}
