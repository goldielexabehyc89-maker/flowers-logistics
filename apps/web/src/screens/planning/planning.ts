/**
 * Правила экрана планирования, вынесенные из компонентов.
 *
 * Здесь только чистые функции и типы: их можно проверить без браузера, и именно
 * они решают спорные вопросы — что показать вместо технического кода отказа,
 * можно ли сейчас применить превью и нужно ли отдельное подтверждение.
 */

export type PlanRunState = 'QUEUED' | 'COMPUTING' | 'PREVIEW' | 'APPLIED' | 'FAILED' | 'EXPIRED';
export type VehicleType = 'CAR' | 'FOOT';

export interface PlannedStopView {
  orderId: string;
  position: number;
  arrivalMinute: number | null;
}

export interface PlannedRouteView {
  slotId: string;
  slotIndex: number;
  vehicleType: VehicleType;
  courierUserId: string | null;
  stops: PlannedStopView[];
  travelSeconds: number | null;
  serviceSeconds: number | null;
  distanceMeters: number | null;
}

export interface PlanPreviewView {
  routes: PlannedRouteView[];
  unassignedOrderIds: string[];
}

export interface PlanSlotView {
  id: string;
  slotIndex: number;
  courierUserId: string | null;
  vehicleType: VehicleType;
  capacityOrders: number;
  shiftStartMinute: number;
  shiftEndMinute: number;
}

export interface PlanRunView {
  id: string;
  deliveryDate: string;
  state: PlanRunState;
  version: number;
  failureCode: string | null;
  createdAt: string;
  appliedAt: string | null;
  slots: PlanSlotView[];
  preview: PlanPreviewView | null;
  routeIds: string[];
}

export const PLAN_STATE_LABELS: Record<PlanRunState, string> = {
  QUEUED: 'В очереди на расчёт',
  COMPUTING: 'Считается',
  PREVIEW: 'Готово к применению',
  APPLIED: 'Применено',
  FAILED: 'Расчёт не удался',
  EXPIRED: 'Снято с рассмотрения',
};

/**
 * Понятная причина отказа.
 *
 * Технический код показывать человеку нельзя: `SOLVER_TIME_WINDOW` не объясняет
 * ничего, а «решатель нарушил интервал доставки» объясняет. Неизвестный код
 * не прячется — он остаётся видимым, чтобы дежурный мог его назвать.
 */
export const PLAN_FAILURE_LABELS: Record<string, string> = {
  MATRIX_UNREACHABLE_PAIR: 'До одной из точек нет дороги. Проверьте адреса на карте.',
  MATRIX_SHAPE: 'Расчёт времени вернул неожиданный результат.',
  SOLVER_PARTITION: 'Решатель вернул неполный план: часть заказов пропала.',
  SOLVER_UNKNOWN_ID: 'Решатель вернул неизвестный заказ.',
  SOLVER_DUPLICATE_ID: 'Решатель вернул один заказ дважды.',
  SOLVER_UNKNOWN_VEHICLE: 'Решатель вернул неизвестную машину.',
  SOLVER_DUPLICATE_VEHICLE: 'Решатель вернул одну машину дважды.',
  SOLVER_ROUTE_SHAPE: 'Маршрут решателя начинается или заканчивается не на складе.',
  SOLVER_CAPACITY: 'Решатель превысил вместимость машины.',
  SOLVER_SHIFT: 'Решатель вышел за пределы смены.',
  SOLVER_TIME_WINDOW: 'Решатель нарушил интервал доставки.',
  RECOVERY_EXHAUSTED: 'Расчёт трижды прерывался и был остановлен.',
  INPUT_STALE: 'Данные изменились с момента расчёта.',
  EXPIRED_BY_USER: 'Превью снято с рассмотрения.',
  REPLACED: 'Заменено новым расчётом.',
  INPUT_SNAPSHOT_MISSING: 'Не найден снимок входных данных расчёта.',
};

export function failureLabel(code: string | null): string | null {
  if (code === null) {
    return null;
  }
  return PLAN_FAILURE_LABELS[code] ?? `Технический код: ${code}`;
}

/** Расчёт ещё идёт: экран продолжает опрашивать состояние. */
export function isRunning(state: PlanRunState): boolean {
  return state === 'QUEUED' || state === 'COMPUTING';
}

/** Применить можно только готовое превью, в котором есть хотя бы один маршрут. */
export function canApply(run: PlanRunView): boolean {
  if (run.state !== 'PREVIEW' || run.preview === null) {
    return false;
  }
  return run.preview.routes.some((route) => route.stops.length > 0);
}

/**
 * Нужно ли отдельное подтверждение частичного применения.
 *
 * Неразмещённый заказ — это заказ, который никто не повезёт. Узнать об этом
 * логист должен до применения, а не вечером.
 */
export function needsUnassignedConfirmation(run: PlanRunView): boolean {
  return (run.preview?.unassignedOrderIds.length ?? 0) > 0;
}

export function assignedCount(preview: PlanPreviewView | null): number {
  return preview?.routes.reduce((total, route) => total + route.stops.length, 0) ?? 0;
}

/** Минуты от полуночи в «ЧЧ:ММ». Единственное место, где это делается. */
export function formatMinute(minute: number | null): string {
  if (minute === null) {
    return '—';
  }
  const normalized = ((minute % 1440) + 1440) % 1440;
  const hours = String(Math.floor(normalized / 60)).padStart(2, '0');
  const minutes = String(normalized % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** Секунды в «Ч ч ММ мин». Для итогов маршрута. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return '—';
  }
  const total = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return hours === 0 ? `${minutes} мин` : `${hours} ч ${String(minutes).padStart(2, '0')} мин`;
}

/** Метры в километры с одним знаком. Метровая точность в списке маршрутов не нужна. */
export function formatDistance(meters: number | null): string {
  if (meters === null) {
    return '—';
  }
  return `${(meters / 1000).toFixed(1)} км`;
}

export const VEHICLE_LABELS: Record<VehicleType, string> = {
  CAR: 'Автомобиль',
  FOOT: 'Пешком',
};

export interface CourierOption {
  id: string;
  fullName: string;
}

/**
 * Кого можно предложить в строке машины.
 *
 * Курьер, уже выбранный в другой машине, из списка убирается: один человек
 * не может вести две машины одновременно, и предлагать это значило бы вести
 * к заведомому отказу сервера. Собственный выбор строки остаётся видимым —
 * иначе поле показывало бы пустоту при заполненном значении.
 *
 * Замороженных и лишённых роли курьера здесь нет по другой причине: их
 * не присылает сервер. Скрытая строка списка защитой не является — кандидата
 * проверяет сервер и при постановке расчёта, и повторно при применении плана.
 */
export function availableCouriers(
  couriers: readonly CourierOption[],
  chosen: readonly (string | null)[],
  index: number,
): CourierOption[] {
  return couriers.filter(
    (courier) =>
      courier.id === chosen[index] ||
      !chosen.some((other, position) => position !== index && other === courier.id),
  );
}
