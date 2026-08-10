/**
 * Контракт решателя: сборка числового запроса и проверка ответа.
 *
 * Модуль чистый — ни базы, ни сети. Он отвечает на два вопроса: что именно
 * уходит решателю и можно ли верить тому, что он вернул.
 *
 * ЧТО УХОДИТ. Только индексы и числа: `location_index`, `start_index`,
 * `end_index`, длительности, расстояния, вместимости и окна. Ни адресов,
 * ни координат, ни номеров заказов, ни описаний. Заказ представлен номером
 * своей строки в снимке, машина — номером слота.
 *
 * МАТРИЦЫ передаются ОБЕ и для КАЖДОГО используемого профиля. Расстояния
 * не роскошь: без них решателю при некоторых параметрах пришлось бы добывать
 * их самому — то есть сходить в маршрутизатор, чего он делать не должен.
 * Значения — целые неотрицательные секунды и метры; дробные округляются вверх,
 * чтобы план не оказался оптимистичнее действительности.
 *
 * ЛЮБАЯ пара `null` останавливает расчёт целиком. Недостижимая точка означает,
 * что план будет неверен, а не «чуть хуже»: подставить туда большое число
 * значило бы выдумать дорогу, которой нет.
 *
 * ОТВЕТ проверяется как ТОЧНОЕ РАЗБИЕНИЕ: каждый заказ ровно один раз либо
 * в маршруте, либо в неразмещённых. Неизвестный, пропущенный или
 * повторяющийся идентификатор — полный отказ, а не «почти правильный план».
 */

import type { $Enums } from '../../generated/prisma/client.js';
import {
  VROOM_PROFILE,
  type VroomMatrix,
  type VroomProfile,
  type VroomRequest,
  type VroomSolution,
} from '../integrations/vroom/client.js';
import type { PlanInputSnapshot } from './input.js';

const SECONDS_IN_MINUTE = 60;

/** Матрица, посчитанная нашим сервисом. `null` — пара недостижима. */
export interface SourceMatrix {
  durationsSec: (number | null)[][];
  distancesM: (number | null)[][];
}

export type PlanFailureCode =
  | 'MATRIX_UNREACHABLE_PAIR'
  | 'MATRIX_SHAPE'
  | 'SOLVER_PARTITION'
  | 'SOLVER_UNKNOWN_ID'
  | 'SOLVER_DUPLICATE_ID'
  | 'SOLVER_UNKNOWN_VEHICLE'
  | 'SOLVER_DUPLICATE_VEHICLE'
  | 'SOLVER_ROUTE_SHAPE'
  | 'SOLVER_CAPACITY'
  | 'SOLVER_SHIFT'
  | 'SOLVER_TIME_WINDOW';

export class PlanContractError extends Error {
  readonly code: PlanFailureCode;

  constructor(code: PlanFailureCode) {
    super(`нарушен контракт планирования: ${code}`);
    this.name = 'PlanContractError';
    this.code = code;
  }
}

export function profileOf(vehicleType: $Enums.VehicleType): VroomProfile {
  return VROOM_PROFILE[vehicleType];
}

/**
 * Приводит нашу матрицу к матрице решателя.
 *
 * Округление ВВЕРХ: план, построенный на заниженном времени, обещает
 * невыполнимое. Отрицательные и нецелые значения означают, что источник
 * ответил не тем, и принимать их нельзя.
 */
export function toSolverMatrix(source: SourceMatrix, size: number): VroomMatrix {
  if (source.durationsSec.length !== size || source.distancesM.length !== size) {
    throw new PlanContractError('MATRIX_SHAPE');
  }

  const durations: number[][] = [];
  const distances: number[][] = [];

  for (let from = 0; from < size; from += 1) {
    const durationRow = source.durationsSec[from];
    const distanceRow = source.distancesM[from];

    if (
      durationRow === undefined ||
      distanceRow === undefined ||
      durationRow.length !== size ||
      distanceRow.length !== size
    ) {
      throw new PlanContractError('MATRIX_SHAPE');
    }

    durations.push(durationRow.map(toNonNegativeInteger));
    distances.push(distanceRow.map(toNonNegativeInteger));
  }

  return { durations, distances };
}

function toNonNegativeInteger(value: number | null): number {
  if (value === null) {
    // Недостижимая пара останавливает расчёт целиком.
    throw new PlanContractError('MATRIX_UNREACHABLE_PAIR');
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new PlanContractError('MATRIX_SHAPE');
  }
  return Math.ceil(value);
}

export interface BuildRequestInput {
  snapshot: PlanInputSnapshot;
  /** Матрицы по типу транспорта. Обязаны присутствовать для всех типов слотов. */
  matrices: Partial<Record<$Enums.VehicleType, SourceMatrix>>;
}

/**
 * Собирает запрос к решателю.
 *
 * `service` дублирует максимальное из значений `service_per_type` намеренно.
 * Возможность задавать время обслуживания по типу машины появилась в VROOM
 * 1.15.0; решатель, который её не знает, молча взял бы `service`. Максимум
 * делает такой (уже невозможный после проверки возможностей) сценарий
 * консервативным, а не оптимистичным: план окажется чуть плотнее по времени,
 * но не пообещает того, чего нет.
 */
export function buildSolverRequest(input: BuildRequestInput): VroomRequest {
  const { snapshot } = input;
  const size = snapshot.points.length;

  const usedTypes = [...new Set(snapshot.slots.map((slot) => slot.vehicleType))];
  const matrices: Record<string, VroomMatrix> = {};

  for (const vehicleType of usedTypes) {
    const source = input.matrices[vehicleType];
    if (source === undefined) {
      throw new PlanContractError('MATRIX_SHAPE');
    }
    matrices[profileOf(vehicleType)] = toSolverMatrix(source, size);
  }

  const serviceSeconds: Record<$Enums.VehicleType, number> = {
    CAR: snapshot.serviceTime.carMinutes * SECONDS_IN_MINUTE,
    FOOT: snapshot.serviceTime.footMinutes * SECONDS_IN_MINUTE,
  };
  const fallbackService = Math.max(serviceSeconds.CAR, serviceSeconds.FOOT);

  const jobs = snapshot.orders.map((order, index) => ({
    // Идентификатор заказа в решателе — номер его строки в снимке, начиная
    // с единицы. Ни UUID, ни номер из МоегоСклада туда не уходят.
    id: index + 1,
    location_index: order.pointIndex,
    service: fallbackService,
    service_per_type: { CAR: serviceSeconds.CAR, FOOT: serviceSeconds.FOOT },
    // Один заказ — одна единица вместимости.
    delivery: [1],
    ...(order.windowStartMinute === null || order.windowEndMinute === null
      ? {}
      : {
          time_windows: [
            [
              order.windowStartMinute * SECONDS_IN_MINUTE,
              order.windowEndMinute * SECONDS_IN_MINUTE,
            ] as [number, number],
          ],
        }),
  }));

  const vehicles = snapshot.slots.map((slot) => ({
    id: slot.slotIndex,
    profile: profileOf(slot.vehicleType),
    type: slot.vehicleType,
    start_index: slot.startPointIndex,
    end_index: slot.endPointIndex,
    capacity: [slot.capacityOrders],
    time_window: [
      slot.shiftStartMinute * SECONDS_IN_MINUTE,
      slot.shiftEndMinute * SECONDS_IN_MINUTE,
    ] as [number, number],
  }));

  // Геометрия не запрашивается: она не нужна плану и заставила бы решатель
  // обратиться к маршрутизатору самостоятельно.
  return { jobs, vehicles, matrices };
}

export interface PlannedStop {
  orderId: string;
  position: number;
  /** Расчётное время прибытия, минуты от полуночи. */
  arrivalMinute: number | null;
}

export interface PlannedRoute {
  slotId: string;
  slotIndex: number;
  vehicleType: $Enums.VehicleType;
  courierUserId: string | null;
  startDepotId: string;
  endDepotId: string;
  stops: PlannedStop[];
  /** Итоги маршрута для показа логисту. Секунды и метры. */
  travelSeconds: number | null;
  serviceSeconds: number | null;
  distanceMeters: number | null;
}

export interface PlanResult {
  routes: PlannedRoute[];
  unassignedOrderIds: string[];
}

/**
 * Разбирает и проверяет ответ решателя.
 *
 * Проверяется всё, что мы просили: точное разбиение заказов, известность
 * машины, форма маршрута, вместимость, смена и временные окна. Решатель
 * обещает соблюдать жёсткие ограничения, но обещание — не доказательство:
 * ошибка в нашем запросе выглядела бы как корректный ответ на другой вопрос.
 */
export function parseSolution(snapshot: PlanInputSnapshot, solution: VroomSolution): PlanResult {
  const orderByJobId = new Map(snapshot.orders.map((order, index) => [index + 1, order]));
  const slotByIndex = new Map(snapshot.slots.map((slot) => [slot.slotIndex, slot]));

  const seenJobs = new Set<number>();
  const seenVehicles = new Set<number>();
  const routes: PlannedRoute[] = [];

  for (const route of solution.routes ?? []) {
    const slot = slotByIndex.get(route.vehicle);
    if (slot === undefined) {
      throw new PlanContractError('SOLVER_UNKNOWN_VEHICLE');
    }
    if (seenVehicles.has(route.vehicle)) {
      throw new PlanContractError('SOLVER_DUPLICATE_VEHICLE');
    }
    seenVehicles.add(route.vehicle);

    const steps = route.steps;
    const first = steps[0];
    const last = steps[steps.length - 1];

    // Маршрут обязан начинаться на складе начала и заканчиваться на складе
    // конца: иначе курьер поехал бы не оттуда и вернулся бы не туда.
    if (first?.type !== 'start' || last?.type !== 'end') {
      throw new PlanContractError('SOLVER_ROUTE_SHAPE');
    }

    const shiftStartSec = slot.shiftStartMinute * SECONDS_IN_MINUTE;
    const shiftEndSec = slot.shiftEndMinute * SECONDS_IN_MINUTE;

    if (
      (first.arrival !== undefined && first.arrival < shiftStartSec) ||
      (last.arrival !== undefined && last.arrival > shiftEndSec)
    ) {
      throw new PlanContractError('SOLVER_SHIFT');
    }

    const stops: PlannedStop[] = [];

    for (const step of steps) {
      if (step.type === 'start' || step.type === 'end') {
        continue;
      }
      if (step.type !== 'job') {
        // Перерывов и отгрузок мы не запрашивали. Шаг другого рода означает,
        // что решён не тот запрос.
        throw new PlanContractError('SOLVER_ROUTE_SHAPE');
      }

      const jobId = step.id;
      if (jobId === undefined) {
        throw new PlanContractError('SOLVER_ROUTE_SHAPE');
      }

      const order = orderByJobId.get(jobId);
      if (order === undefined) {
        throw new PlanContractError('SOLVER_UNKNOWN_ID');
      }
      if (seenJobs.has(jobId)) {
        throw new PlanContractError('SOLVER_DUPLICATE_ID');
      }
      seenJobs.add(jobId);

      const arrival = step.arrival;

      if (arrival !== undefined) {
        if (arrival > shiftEndSec) {
          throw new PlanContractError('SOLVER_SHIFT');
        }
        if (order.windowEndMinute !== null && arrival > order.windowEndMinute * SECONDS_IN_MINUTE) {
          // Обслуживание начинается не раньше прибытия, поэтому прибытие
          // после конца окна — прямое нарушение обещания клиенту.
          throw new PlanContractError('SOLVER_TIME_WINDOW');
        }
      }

      stops.push({
        orderId: order.orderId,
        position: stops.length + 1,
        arrivalMinute: arrival === undefined ? null : Math.round(arrival / SECONDS_IN_MINUTE),
      });
    }

    if (stops.length > slot.capacityOrders) {
      throw new PlanContractError('SOLVER_CAPACITY');
    }

    routes.push({
      slotId: slot.slotId,
      slotIndex: slot.slotIndex,
      vehicleType: slot.vehicleType,
      courierUserId: slot.courierUserId,
      startDepotId: slot.startDepotId,
      endDepotId: slot.endDepotId,
      stops,
      travelSeconds: route.duration === undefined ? null : Math.round(route.duration),
      serviceSeconds: route.service === undefined ? null : Math.round(route.service),
      distanceMeters: route.distance === undefined ? null : Math.round(route.distance),
    });
  }

  const unassignedOrderIds: string[] = [];

  for (const item of solution.unassigned ?? []) {
    const order = orderByJobId.get(item.id);
    if (order === undefined) {
      throw new PlanContractError('SOLVER_UNKNOWN_ID');
    }
    if (seenJobs.has(item.id)) {
      throw new PlanContractError('SOLVER_DUPLICATE_ID');
    }
    seenJobs.add(item.id);
    unassignedOrderIds.push(order.orderId);
  }

  // Точное разбиение: пропущенный заказ означал бы, что часть дня просто
  // исчезла из плана, оставшись при этом нераспределённой в системе.
  if (seenJobs.size !== snapshot.orders.length) {
    throw new PlanContractError('SOLVER_PARTITION');
  }

  return { routes, unassignedOrderIds };
}
