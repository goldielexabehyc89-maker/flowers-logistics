/**
 * Автоматическая разбивка выбранных сделок на несколько черновиков.
 *
 * Здесь только правила, без React и без сети: сколько машин заказать у
 * решателя и что означает очередное состояние запуска. Их видно целиком,
 * и они проверяются без браузера.
 *
 * Расчёт остаётся двухфазным на сервере — превью, затем применение, — но
 * логист этих стадий не видит. Он выбирает заказы и получает готовые
 * черновики; технический запуск в интерфейс не всплывает.
 */

export type VehicleType = 'CAR' | 'FOOT';

export interface SlotRequest {
  courierUserId: string | null;
  vehicleType: VehicleType;
  /** Вместимость в заказах: один заказ — одна единица. */
  capacityOrders: number;
}

/** Верхняя граница слотов на запуск. Совпадает с серверной. */
export const MAX_SLOTS = 50;

/** Сколько заказов приходится на машину, если логист не указал иное. */
export const DEFAULT_CAPACITY = 20;

/**
 * Сколько машин заказать.
 *
 * Одна машина на весь выбор — это не разбивка, а один длинный маршрут:
 * ровно так вело себя прежнее обращение, посылавшее `capacity` размером
 * со всё выделение. Число машин считается от вместимости и ограничивается
 * серверным пределом, иначе запрос отвергается уже после ожидания.
 */
export function vehicleCount(orderCount: number, capacityOrders: number): number {
  if (orderCount <= 0 || capacityOrders <= 0) {
    return 1;
  }
  return Math.min(MAX_SLOTS, Math.ceil(orderCount / capacityOrders));
}

export function buildSlots(input: {
  orderCount: number;
  capacityOrders: number;
  vehicleType: VehicleType;
}): SlotRequest[] {
  const count = vehicleCount(input.orderCount, input.capacityOrders);
  return Array.from({ length: count }, () => ({
    courierUserId: null,
    vehicleType: input.vehicleType,
    // Поле называется `capacityOrders`, а не `capacity`: прежний клиент слал
    // второе, и сервер отвергал запрос ещё до расчёта.
    capacityOrders: input.capacityOrders,
  }));
}

export type PlanRunState = 'QUEUED' | 'COMPUTING' | 'PREVIEW' | 'APPLIED' | 'FAILED' | 'EXPIRED';

export interface PlanRunView {
  id: string;
  state: PlanRunState;
  version: number;
  routeIds: string[];
  preview: { unassignedOrderIds: string[] } | null;
}

export type SplitPhase =
  /** Решатель ещё считает: ждём, оставаясь в «Сделках». */
  | { kind: 'RUNNING' }
  /** Всё разместилось: можно применять без вопросов. */
  | { kind: 'READY' }
  /** Часть заказов никто не повезёт: нужно отдельное согласие человека. */
  | { kind: 'NEEDS_CONSENT'; unassignedCount: number }
  /** Расчёт отказал либо превью снято. */
  | { kind: 'FAILED' };

/**
 * Что означает текущее состояние запуска.
 *
 * Неразмещённые заказы не проходят молча: заказ, который никто не повезёт,
 * логист обязан увидеть до создания черновиков, а не вечером.
 */
export function splitPhase(run: PlanRunView): SplitPhase {
  switch (run.state) {
    case 'QUEUED':
    case 'COMPUTING':
      return { kind: 'RUNNING' };
    case 'PREVIEW': {
      const unassigned = run.preview?.unassignedOrderIds ?? [];
      return unassigned.length > 0
        ? { kind: 'NEEDS_CONSENT', unassignedCount: unassigned.length }
        : { kind: 'READY' };
    }
    case 'APPLIED':
      return { kind: 'READY' };
    default:
      return { kind: 'FAILED' };
  }
}

/**
 * Куда вести после применения.
 *
 * В «Маршрутизации» раскрывается первый созданный черновик: логист попадает
 * в работу, а не в общий список, где свой результат пришлось бы искать.
 * Пустой набор означает, что применение ничего не создало, — вести некуда.
 */
export function firstDraftId(run: PlanRunView): string | null {
  return run.routeIds[0] ?? null;
}
