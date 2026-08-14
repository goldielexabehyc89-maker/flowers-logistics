/**
 * Правила показа предложенного расчёта.
 *
 * Превью — видимая стадия работы: до явного «Применить» черновиков не
 * существует, и логист решает, глядя на предложенные маршруты, а не на факт
 * их создания. Поэтому здесь всё, что делает предложение проверяемым:
 * человеческие подписи заказов, итоги маршрута и причина, по которой заказ
 * никто не повезёт.
 *
 * Только чистые функции: их видно целиком и можно проверить без браузера.
 */

export type UnassignedReason = 'CAPACITY' | 'TIME_WINDOW' | 'SHIFT' | 'UNREACHABLE' | 'UNKNOWN';

export interface PreviewOrder {
  id: string;
  number: string;
  address: string | null;
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
}

export interface PreviewStop {
  orderId: string;
  position: number;
  arrivalMinute: number | null;
}

export interface PreviewRoute {
  slotId: string;
  slotIndex: number;
  vehicleType: 'CAR' | 'FOOT';
  stops: PreviewStop[];
  travelSeconds: number | null;
  serviceSeconds: number | null;
  distanceMeters: number | null;
}

export interface PreviewPlan {
  routes: PreviewRoute[];
  unassignedOrderIds: string[];
  unassigned?: { orderId: string; reason: UnassignedReason }[];
}

export type PlanRunState = 'QUEUED' | 'COMPUTING' | 'PREVIEW' | 'APPLIED' | 'FAILED' | 'EXPIRED';

export interface PlanRunView {
  id: string;
  deliveryDate: string;
  state: PlanRunState;
  version: number;
  failureCode: string | null;
  createdAt: string;
  preview: PreviewPlan | null;
  orders: PreviewOrder[];
  routeIds: string[];
}

/**
 * Почему заказ остался без маршрута.
 *
 * Причина — не украшение: от неё зависит, добавить машину, расширить смену
 * или разбираться с адресом. «Неизвестно» показывается честно, а не
 * подменяется правдоподобной догадкой.
 */
export const UNASSIGNED_LABELS: Record<UnassignedReason, string> = {
  CAPACITY: 'Не хватило мест: все машины заполнены',
  TIME_WINDOW: 'Не попадает в своё время доставки',
  SHIFT: 'Не помещается в смену',
  UNREACHABLE: 'До точки нет проезда',
  UNKNOWN: 'Решатель не назвал причину',
};

export function unassignedLabel(reason: UnassignedReason): string {
  return UNASSIGNED_LABELS[reason] ?? UNASSIGNED_LABELS.UNKNOWN;
}

/**
 * Неразмещённые заказы с причинами.
 *
 * Старые расчёты причин не хранят: тогда решатель их сообщал, а мы
 * отбрасывали. Такой заказ показывается с честным «причина не сохранялась»,
 * а не исчезает из списка.
 */
export function unassignedWithReasons(
  plan: PreviewPlan,
): { orderId: string; reason: UnassignedReason }[] {
  const known = new Map((plan.unassigned ?? []).map((item) => [item.orderId, item.reason]));
  return plan.unassignedOrderIds.map((orderId) => ({
    orderId,
    reason: known.get(orderId) ?? 'UNKNOWN',
  }));
}

/** Заказ по идентификатору. Отсутствие — не повод падать: покажем как есть. */
export function orderOf(run: PlanRunView, orderId: string): PreviewOrder {
  return (
    run.orders.find((order) => order.id === orderId) ?? {
      id: orderId,
      number: '—',
      address: null,
      intervalStartMinute: null,
      intervalEndMinute: null,
    }
  );
}

/** Маршруты предложения. Пустые слоты не показываются: машина никуда не едет. */
export function plannedRoutes(plan: PreviewPlan): PreviewRoute[] {
  return plan.routes.filter((route) => route.stops.length > 0);
}

export function assignedCount(plan: PreviewPlan): number {
  return plan.routes.reduce((total, route) => total + route.stops.length, 0);
}

/**
 * Можно ли применить предложение.
 *
 * Применение доступно только у готового превью и только если хоть один
 * маршрут получился: применять пустой план значит создать ноль черновиков
 * и решить, что работа сделана.
 */
export function canApply(run: PlanRunView): boolean {
  return run.state === 'PREVIEW' && run.preview !== null && plannedRoutes(run.preview).length > 0;
}

/** Требуется ли отдельное согласие: часть заказов никто не повезёт. */
export function needsPartialConsent(run: PlanRunView): boolean {
  return (run.preview?.unassignedOrderIds.length ?? 0) > 0;
}

/** Часы и минуты от полуночи. `null` — расчёт времени не дал. */
export function formatMinute(minute: number | null): string {
  if (minute === null) {
    return '—';
  }
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** Длительность из секунд. Округление вверх: план не должен выглядеть быстрее. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return '—';
  }
  const total = Math.ceil(seconds / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return hours === 0 ? `${minutes} мин` : `${hours} ч ${minutes} мин`;
}

/** Расстояние из метров. */
export function formatDistance(meters: number | null): string {
  if (meters === null) {
    return '—';
  }
  return meters < 1000 ? `${meters} м` : `${(meters / 1000).toFixed(1)} км`;
}

/** Окно доставки заказа для строки остановки. */
export function formatWindow(order: PreviewOrder): string {
  if (order.intervalStartMinute === null || order.intervalEndMinute === null) {
    return 'время не задано';
  }
  return `${formatMinute(order.intervalStartMinute)}–${formatMinute(order.intervalEndMinute)}`;
}
