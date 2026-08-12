/**
 * Правила складского экрана, вынесенные из компонентов.
 *
 * Здесь только чистые функции и типы: их проверяют тестами без браузера.
 * Состав повторяет безопасный ответ сервера — ни адреса, ни получателя,
 * ни состава заказа тут нет и появиться не может.
 */

export type StorageCellKind = 'STORAGE' | 'ROUTE';
export type IssueSessionState = 'OPEN' | 'COMPLETED' | 'CANCELLED';
export type RouteState = 'DRAFT' | 'CONFIRMED' | 'CANCELLED' | 'ACTIVE';

export interface PlacedOrderView {
  orderId: string;
  orderNumber: string;
  deliveryDate: string | null;
  cellId: string | null;
  cellCode: string | null;
  cellKind: StorageCellKind | null;
  requiresRelocation: boolean;
  blockedBy: string[];
  routeNumber: string | null;
  routeId: string | null;
}

export interface RouteFlowOrderView extends PlacedOrderView {
  position: number;
  issued: boolean;
  inRouteCell: boolean;
}

export interface RouteSummary {
  routeId: string;
  routeNumber: string;
  state: RouteState;
  deliveryDate: string;
  courier: { id: string; fullName: string } | null;
  total: number;
  inRouteCell: number;
  issued: number;
  hasIssueSession: boolean;
}

export interface RouteFlowView {
  routeId: string;
  routeNumber: string;
  state: RouteState;
  version: number;
  deliveryDate: string;
  courier: { id: string; fullName: string } | null;
  routeCell: { id: string; code: string } | null;
  issueSession: { id: string; courierUserId: string; state: IssueSessionState } | null;
  orders: RouteFlowOrderView[];
}

export interface ScanContext {
  orderId: string;
  orderNumber: string;
  blockedBy: string[];
  needsAttention: boolean;
  currentCell: {
    id: string;
    code: string;
    kind: StorageCellKind;
    requiresRelocation: boolean;
  } | null;
  route: { id: string; number: string; routeCell: { id: string; code: string } | null } | null;
}

/** Человеческие названия признаков, блокирующих обычную работу. */
export const BLOCK_LABELS: Record<string, string> = {
  OUT_OF_SCOPE: 'Не наша доставка',
  SOURCE_ARCHIVED: 'Архивирован в МоемСкладе',
  SOURCE_MISSING: 'Не найден в МоемСкладе',
};

export function blockLabel(flag: string): string {
  return BLOCK_LABELS[flag] ?? flag;
}

export const CELL_KIND_LABELS: Record<StorageCellKind, string> = {
  STORAGE: 'Хранение',
  ROUTE: 'Маршрутная',
};

/**
 * Можно ли выдавать этот заказ прямо сейчас.
 *
 * Заказ без размещения выдавать нечего, помеченный проблемным — нельзя,
 * требующий перемещения — тоже: маршрут менялся уже после комплектования.
 */
export function issueBlocker(order: RouteFlowOrderView): string | null {
  if (order.issued) {
    return null;
  }
  if (order.blockedBy.length > 0) {
    return blockLabel(order.blockedBy[0] ?? '');
  }
  if (order.requiresRelocation) {
    return 'Требуется перемещение';
  }
  if (order.cellId === null) {
    return 'Не принят на склад';
  }
  return null;
}

/** Что показать в колонке «Ячейка»: код либо честное «не принят». */
export function cellLabel(order: PlacedOrderView): string {
  return order.cellCode ?? 'Не принят';
}

/** Готов ли маршрут к переводу в активный: все заказы выданы. */
export function issueProgress(view: RouteFlowView): { issued: number; total: number } {
  return {
    issued: view.orders.filter((order) => order.issued).length,
    total: view.orders.length,
  };
}

/** Сколько заказов маршрута уже лежит в его маршрутной ячейке. */
export function pickProgress(view: RouteFlowView): { picked: number; total: number } {
  return {
    picked: view.orders.filter((order) => order.inRouteCell).length,
    total: view.orders.length,
  };
}

/**
 * Следующий шаг двухсканной операции.
 *
 * До второго скана база не меняется, поэтому интерфейс обязан честно
 * показывать, чего он ждёт: иначе кладовщик решит, что заказ уже принят.
 */
export type ScanStep = 'ORDER' | 'CELL';

export function nextStep(orderScanned: boolean): ScanStep {
  return orderScanned ? 'CELL' : 'ORDER';
}

export const SCAN_HINTS: Record<ScanStep, string> = {
  ORDER: 'Отсканируйте QR заказа',
  CELL: 'Теперь отсканируйте QR ячейки',
};
