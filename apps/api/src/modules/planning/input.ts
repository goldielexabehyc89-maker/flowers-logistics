/**
 * Неизменяемый снимок входа планирования.
 *
 * Снимок определяет, что именно считалось. Он создаётся ДО обращения
 * к матрице и решателю — иначе перехват брошенной аренды не смог бы
 * продолжить расчёт с первоначальными данными: заказы, настройки и склад
 * к тому моменту могли измениться, и повторная попытка дала бы другой ответ
 * на тот же запрос.
 *
 * ЧТО В СНИМКЕ ЕСТЬ: идентификаторы и версии заказов, поколение геоданных,
 * координаты точек, временные окна, параметры слотов, смена, время
 * обслуживания, координаты и версии складов, предел размера задачи.
 *
 * ЧЕГО В НЁМ НЕТ: адресов, получателей, номеров заказов, комментариев, денег.
 * Координаты есть намеренно: без них воспроизвести расчёт нечем, а точки той же
 * природы уже хранит неизменяемая `OrderGeoHistory`.
 *
 * FAIL CLOSED. Планирование не начинается вовсе, если у любого заказа дня нет
 * подтверждённой точки или его интервал непригоден. Частичный план опаснее
 * отказа: он выглядит готовым. Отказ называет конкретные заказы, чтобы логист
 * знал, что чинить.
 */

import { createHash } from 'node:crypto';
import type { $Enums } from '../../generated/prisma/client.js';
import { AppError } from '../../platform/errors.js';
import { MINUTES_IN_DAY, type ServiceTime, type Shift } from '../settings/service.js';
import type { DepotRow } from '../depots/service.js';

/** Версия формата снимка. Растёт, если состав полей меняется. */
export const INPUT_SNAPSHOT_VERSION = 1;

export interface SnapshotPoint {
  latMicro: number;
  lonMicro: number;
}

export interface SnapshotOrder {
  orderId: string;
  /** Версия строки заказа на момент постановки: при применении сверяется заново. */
  version: number;
  /** Поколение адреса: ответ геокодера после смены адреса не должен пройти незаметно. */
  geoGeneration: number;
  latMicro: number;
  lonMicro: number;
  /** Индекс точки в общем наборе. Совпадающие адреса делят одну строку матрицы. */
  pointIndex: number;
  /** Жёсткое окно, минуты от полуночи. `null` — заказ можно везти в любое время смены. */
  windowStartMinute: number | null;
  windowEndMinute: number | null;
  /** Откуда взято окно: из МоегоСклада или задано логистом вручную. */
  windowSource: 'MOYSKLAD' | 'MANUAL' | null;
}

export interface SnapshotSlot {
  slotId: string;
  slotIndex: number;
  courierUserId: string | null;
  vehicleType: $Enums.VehicleType;
  capacityOrders: number;
  shiftStartMinute: number;
  shiftEndMinute: number;
  startDepotId: string;
  endDepotId: string;
  startPointIndex: number;
  endPointIndex: number;
}

export interface SnapshotDepot {
  depotId: string;
  version: number;
  latMicro: number;
  lonMicro: number;
  pointIndex: number;
}

export interface PlanInputSnapshot {
  version: number;
  deliveryDate: string;
  graphSha256: string;
  trafficMode: $Enums.TrafficMode;
  maxPoints: number;
  shift: { startMinute: number; endMinute: number; settingVersion: number };
  serviceTime: { carMinutes: number; footMinutes: number; settingVersion: number };
  depots: SnapshotDepot[];
  points: SnapshotPoint[];
  slots: SnapshotSlot[];
  orders: SnapshotOrder[];
}

/** Заказ дня в том виде, в каком его читает планирование. */
export interface PlanningOrderRow {
  id: string;
  version: number;
  geoGeneration: number;
  geoState: $Enums.OrderGeoState;
  geoLatMicro: number | null;
  geoLonMicro: number | null;
  intervalKind: $Enums.DeliveryIntervalKind;
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
  manualIntervalStartMinute: number | null;
  manualIntervalEndMinute: number | null;
}

export type OrderProblem =
  'NO_CONFIRMED_POINT' | 'INTERVAL_UNRECOGNIZED' | 'INTERVAL_NOT_A_RANGE' | 'INTERVAL_OUT_OF_SHIFT';

export const ORDER_PROBLEM_MESSAGES: Record<OrderProblem, string> = {
  NO_CONFIRMED_POINT: 'у заказа нет подтверждённой точки на карте',
  INTERVAL_UNRECOGNIZED: 'время доставки не распознано — задайте интервал вручную',
  INTERVAL_NOT_A_RANGE: 'указано одно время без интервала — задайте интервал вручную',
  INTERVAL_OUT_OF_SHIFT: 'интервал доставки не помещается в смену',
};

export interface OrderWindow {
  startMinute: number;
  endMinute: number;
  source: 'MOYSKLAD' | 'MANUAL';
}

/**
 * Временное окно заказа.
 *
 * Ручной интервал старше импортированного: логист задал его именно потому,
 * что значение из МоегоСклада не годилось.
 *
 * `EXACT` окном НЕ становится. Указано одно время — это обещание клиенту,
 * а не диапазон; достроить из него интервал значило бы выдумать за логиста
 * ширину окна, а считать «в любое время смены» — молча нарушить обещание.
 * Такой заказ ждёт ручного интервала, для которого в системе есть отдельная
 * операция.
 */
export function orderWindow(order: PlanningOrderRow): OrderWindow | null | OrderProblem {
  if (order.manualIntervalStartMinute !== null && order.manualIntervalEndMinute !== null) {
    return {
      startMinute: order.manualIntervalStartMinute,
      endMinute: order.manualIntervalEndMinute,
      source: 'MANUAL',
    };
  }

  switch (order.intervalKind) {
    case 'MISSING':
      // Отсутствие интервала не означает срочности: заказ планируется
      // в любое время внутри смены.
      return null;
    case 'RANGE':
      if (order.intervalStartMinute === null || order.intervalEndMinute === null) {
        return 'INTERVAL_UNRECOGNIZED';
      }
      return {
        startMinute: order.intervalStartMinute,
        endMinute: order.intervalEndMinute,
        source: 'MOYSKLAD',
      };
    case 'EXACT':
      return 'INTERVAL_NOT_A_RANGE';
    case 'UNRECOGNIZED':
      return 'INTERVAL_UNRECOGNIZED';
    default:
      return 'INTERVAL_UNRECOGNIZED';
  }
}

/** Почему заказ непригоден для планирования. `null` — пригоден. */
export function orderProblem(order: PlanningOrderRow, shift: Shift): OrderProblem | null {
  if (order.geoState !== 'RESOLVED' || order.geoLatMicro === null || order.geoLonMicro === null) {
    return 'NO_CONFIRMED_POINT';
  }

  const window = orderWindow(order);
  if (typeof window === 'string') {
    return window;
  }

  if (window !== null) {
    // Окно, целиком лежащее вне смены, невыполнимо. Решатель отправил бы заказ
    // в неразмещённые, но объяснить это логисту было бы нечем.
    if (window.startMinute >= shift.endMinute || window.endMinute <= shift.startMinute) {
      return 'INTERVAL_OUT_OF_SHIFT';
    }
  }

  return null;
}

export interface BuildSnapshotInput {
  deliveryDate: string;
  graphSha256: string;
  trafficMode: $Enums.TrafficMode;
  maxPoints: number;
  shift: Shift;
  shiftVersion: number;
  serviceTime: ServiceTime;
  serviceTimeVersion: number;
  depots: readonly DepotRow[];
  orders: readonly PlanningOrderRow[];
  slots: readonly {
    slotIndex: number;
    courierUserId: string | null;
    vehicleType: $Enums.VehicleType;
    capacityOrders: number;
    shiftStartMinute: number;
    shiftEndMinute: number;
    startDepotId: string;
    endDepotId: string;
  }[];
  /** Идентификаторы слотов из базы. Индекс совпадает с `slots`. */
  slotIds: readonly string[];
}

/**
 * Собирает снимок входа.
 *
 * Точки складов идут первыми и по построению попадают в общий набор
 * уникальных точек: одинаковые склад начала и склад конца — ОДНА строка
 * матрицы, а не две. Предел размера задачи считается по этому набору,
 * а не по числу заказов: два заказа на один адрес — одна точка.
 */
export function buildInputSnapshot(input: BuildSnapshotInput): PlanInputSnapshot {
  const points: SnapshotPoint[] = [];
  const indexByPoint = new Map<string, number>();

  const pointIndexOf = (latMicro: number, lonMicro: number): number => {
    const key = `${latMicro}:${lonMicro}`;
    const existing = indexByPoint.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const index = points.length;
    points.push({ latMicro, lonMicro });
    indexByPoint.set(key, index);
    return index;
  };

  const depots: SnapshotDepot[] = input.depots.map((depot) => ({
    depotId: depot.id,
    version: depot.version,
    latMicro: depot.latMicro,
    lonMicro: depot.lonMicro,
    pointIndex: pointIndexOf(depot.latMicro, depot.lonMicro),
  }));

  const depotById = new Map(depots.map((depot) => [depot.depotId, depot]));

  const orders: SnapshotOrder[] = input.orders.map((order) => {
    // Непригодные заказы сюда не доходят: их отсекает `orderProblem` до вызова.
    const latMicro = order.geoLatMicro ?? 0;
    const lonMicro = order.geoLonMicro ?? 0;
    const window = orderWindow(order);
    const usable = typeof window === 'string' ? null : window;

    return {
      orderId: order.id,
      version: order.version,
      geoGeneration: order.geoGeneration,
      latMicro,
      lonMicro,
      pointIndex: pointIndexOf(latMicro, lonMicro),
      windowStartMinute: usable?.startMinute ?? null,
      windowEndMinute: usable?.endMinute ?? null,
      windowSource: usable?.source ?? null,
    };
  });

  const slots: SnapshotSlot[] = input.slots.map((slot, index) => {
    const start = depotById.get(slot.startDepotId);
    const end = depotById.get(slot.endDepotId);
    const slotId = input.slotIds[index];

    if (start === undefined || end === undefined || slotId === undefined) {
      throw new AppError('INTERNAL_ERROR', { message: 'slot references unknown depot' });
    }

    return {
      slotId,
      slotIndex: slot.slotIndex,
      courierUserId: slot.courierUserId,
      vehicleType: slot.vehicleType,
      capacityOrders: slot.capacityOrders,
      shiftStartMinute: slot.shiftStartMinute,
      shiftEndMinute: slot.shiftEndMinute,
      startDepotId: slot.startDepotId,
      endDepotId: slot.endDepotId,
      startPointIndex: start.pointIndex,
      endPointIndex: end.pointIndex,
    };
  });

  return {
    version: INPUT_SNAPSHOT_VERSION,
    deliveryDate: input.deliveryDate,
    graphSha256: input.graphSha256,
    trafficMode: input.trafficMode,
    maxPoints: input.maxPoints,
    shift: {
      startMinute: input.shift.startMinute,
      endMinute: input.shift.endMinute,
      settingVersion: input.shiftVersion,
    },
    serviceTime: {
      carMinutes: input.serviceTime.carMinutes,
      footMinutes: input.serviceTime.footMinutes,
      settingVersion: input.serviceTimeVersion,
    },
    depots,
    points,
    slots,
    orders,
  };
}

/**
 * Канонический хеш снимка.
 *
 * Сериализация с сортировкой ключей: `JSON.stringify` сохраняет порядок
 * вставки, и одинаковые по смыслу снимки давали бы разные суммы.
 */
export function snapshotHash(snapshot: PlanInputSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(',')}}`;
}

/** Предел размера задачи. Считается по уникальным точкам с учётом складов. */
export function assertPointLimit(snapshot: PlanInputSnapshot): void {
  if (snapshot.points.length <= snapshot.maxPoints) {
    return;
  }

  // День автоматически НЕ делится. Разрезав его произвольно, мы получили бы
  // не «почти оптимально», а «неизвестно насколько плохо», и сравнить это
  // было бы не с чем.
  throw new AppError('VALIDATION_FAILED', {
    message: 'too many unique points for planning',
    publicMessage:
      `Слишком большой день: ${snapshot.points.length} уникальных адресов с учётом склада ` +
      `при пределе ${snapshot.maxPoints}. Разделите день на части вручную.`,
  });
}

/** Смена обязана помещаться в сутки: окна считаются от полуночи дня доставки. */
export function assertShiftShape(shift: Shift): void {
  if (
    shift.startMinute < 0 ||
    shift.endMinute > MINUTES_IN_DAY ||
    shift.endMinute <= shift.startMinute
  ) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'shift is out of range',
      publicMessage: 'Смена задана неверно: окончание должно быть позже начала и внутри суток.',
    });
  }
}
