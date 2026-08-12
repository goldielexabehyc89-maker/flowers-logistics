/**
 * Нагрузочный пилот логистики.
 *
 * Отвечает на один практический вопрос: выдерживает ли уже собранный стек
 * «матрица Valhalla → решатель VROOM» рабочий день склада — и делает это
 * измеримо, воспроизводимо и без единой персональной строки в отчёте.
 *
 * ЧТО ПИЛОТ ДЕЛАЕТ И ЧЕГО НЕ ДЕЛАЕТ.
 *
 * Пилот не создаёт и не меняет заказы, маршруты, планы, настройки, аудит
 * и realtime. Он вызывает ровно те же функции, что и боевой расчёт, и измеряет
 * их поведение: если бы он считал сам, его числа не говорили бы о продукте
 * ничего.
 *
 * Но «ничего не пишет в базу» было бы неправдой, и повторять это нельзя.
 * Штатный путь расчёта намеренно проходит через продуктовый кэш матриц
 * и технический статус маршрутизатора, поэтому операторский прогон
 * ЗАКОНОМЕРНО записывает ровно две технические области:
 *
 *   * `RouteMatrixCache` — аренда и результат матрицы. Именно ради холодного
 *     и тёплого пути пилот и существует: обойти кэш значило бы измерить
 *     не тот продукт.
 *   * `IntegrationStatus` — технический статус Valhalla, который обновляет
 *     общая проверка графа перед первым расчётом.
 *
 * Других записей быть не должно, и это проверяется поведением, а не обещанием
 * (`pilot-isolation.critical.test.ts`).
 *
 * ЧТО ТАКОЕ ВОРОТА.
 *
 * Ворота — это утверждения, каждое из которых можно нарушить. Размер матрицы,
 * единственная ревизия графа, переданная решателю матрица, время обслуживания
 * по типу машины, детерминизм повторов, соблюдение жёстких окон, сохранность
 * состава заказов, предел точек, недостижимая пара. Нарушение любого —
 * явный отказ с кодом, а не примечание в тексте.
 *
 * ПОЧЕМУ БЕЗ PII.
 *
 * Отчёт пилота уезжает в документацию и в отчёты агентов. Поэтому наружу
 * выходят только размеры, времена, попадания в кэш, количества и агрегаты.
 * Ни адресов, ни координат, ни номеров заказов, ни тел ответов.
 */

import type { $Enums } from '../../generated/prisma/client.js';
import type { VroomRequest, VroomSolution } from '../integrations/vroom/client.js';
import type { MatrixResult } from '../geo/matrix/service.js';
import {
  buildSolverRequest,
  parseSolution,
  PlanContractError,
  profileOf,
  type PlanFailureCode,
  type PlanResult,
  type SourceMatrix,
} from './solve.js';
import type { PlanInputSnapshot, SnapshotOrder, SnapshotPoint } from './input.js';
import { INPUT_SNAPSHOT_VERSION } from './input.js';
import { readSnapshotFile } from '../orders/snapshot/file.js';
import { assertSnapshotIsSafe } from '../orders/snapshot-export.js';

/** Предел уникальных точек за один расчёт, включая склад. */
export const PILOT_MAX_POINTS = 60;

/** Коды отказов пилота. Наружу выходит код, а не текст внешней ошибки. */
export type PilotFailureCode =
  | 'TOO_MANY_POINTS'
  /** Матрицу получить не удалось: недоступна база, Valhalla или сам расчёт. */
  | 'MATRIX_UNAVAILABLE'
  /** Решатель не ответил: недоступен VROOM либо запрос отвергнут. */
  | 'SOLVER_UNAVAILABLE'
  /** Ошибка самого пилота. Наружу выходит код, а не текст исключения. */
  | 'PILOT_INTERNAL'
  | 'MATRIX_SHAPE'
  | 'MATRIX_GRAPH_MISMATCH'
  | 'MATRIX_UNREACHABLE_PAIR'
  | 'SOLVER_MATRIX_NOT_USED'
  | 'SOLVER_SERVICE_PER_TYPE_MISSING'
  | 'NONDETERMINISTIC_REPEAT'
  | 'ORDERS_LOST_OR_DUPLICATED'
  | 'WINDOW_VIOLATED'
  | PlanFailureCode;

export class PilotGateError extends Error {
  readonly code: PilotFailureCode;

  constructor(code: PilotFailureCode) {
    super(`нарушены ворота пилота: ${code}`);
    this.name = 'PilotGateError';
    this.code = code;
  }
}

/**
 * Отказ внешнего участника расчёта.
 *
 * Отдельный класс нужен, чтобы недоступность базы, маршрутизатора или решателя
 * не выглядела испорченной матрицей. Текст исходного исключения не переносится:
 * он способен содержать адрес запроса, координаты и тело чужого ответа.
 */
export class PilotInfrastructureError extends Error {
  readonly code: 'MATRIX_UNAVAILABLE' | 'SOLVER_UNAVAILABLE';

  constructor(code: 'MATRIX_UNAVAILABLE' | 'SOLVER_UNAVAILABLE') {
    super(`участник расчёта недоступен: ${code}`);
    this.name = 'PilotInfrastructureError';
    this.code = code;
  }
}

// --- Синтетический день ------------------------------------------------------

/**
 * Детерминированный генератор псевдослучайных чисел.
 *
 * Обычный `Math.random` сделал бы пилот невоспроизводимым: два прогона дали бы
 * разные наборы, и сравнивать их было бы нечем. Здесь то же зерно всегда даёт
 * тот же день.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Границы синтетической Москвы. Настоящих адресов здесь нет по построению. */
const MOSCOW_BBOX = { minLat: 55.6, maxLat: 55.87, minLon: 37.4, maxLon: 37.75 };

export interface SyntheticDayOptions {
  orderCount: number;
  /** Зерно: один и тот же день при одном и том же значении. */
  seed?: number;
  vehicleType?: $Enums.VehicleType;
  /** Сколько машин в смене. По умолчанию — по одной на каждые десять заказов. */
  slotCount?: number;
  serviceMinutes?: { car: number; foot: number };
  shift?: { startMinute: number; endMinute: number };
  graphSha256?: string;
  deliveryDate?: string;
}

/**
 * Собирает синтетический день ровно в том формате, который читает планирование.
 *
 * Координаты синтетические, идентификаторы — порядковые. Это не «похожие
 * на настоящие» данные, а заведомо выдуманные: пилот измеряет стек, а не город.
 */
export function buildSyntheticDay(options: SyntheticDayOptions): PlanInputSnapshot {
  const {
    orderCount,
    seed = 20260820,
    vehicleType = 'CAR',
    serviceMinutes = { car: 8, foot: 12 },
    shift = { startMinute: 9 * 60, endMinute: 21 * 60 },
    graphSha256 = 'a'.repeat(64),
    deliveryDate = '2026-08-20',
  } = options;

  const random = seeded(seed);
  const slotCount = options.slotCount ?? Math.max(1, Math.ceil(orderCount / 10));

  // Нулевая точка — склад: маршрут начинается и заканчивается на нём.
  const points: SnapshotPoint[] = [
    { latMicro: Math.round(55.751244 * 1e6), lonMicro: Math.round(37.618423 * 1e6) },
  ];

  const orders: SnapshotOrder[] = [];
  for (let index = 0; index < orderCount; index += 1) {
    const lat = MOSCOW_BBOX.minLat + random() * (MOSCOW_BBOX.maxLat - MOSCOW_BBOX.minLat);
    const lon = MOSCOW_BBOX.minLon + random() * (MOSCOW_BBOX.maxLon - MOSCOW_BBOX.minLon);
    const latMicro = Math.round(lat * 1e6);
    const lonMicro = Math.round(lon * 1e6);
    points.push({ latMicro, lonMicro });

    // Треть заказов получает жёсткое окно, один — точное время: именно они
    // проверяют, что решатель обещания не нарушает.
    const kind = index % 3;
    const windowStart = kind === 0 ? 10 * 60 : kind === 1 ? 14 * 60 : null;
    const windowEnd = kind === 0 ? 14 * 60 : kind === 1 ? 18 * 60 : null;
    const exact = index === 0;

    orders.push({
      orderId: `pilot-order-${String(index + 1).padStart(4, '0')}`,
      version: 1,
      geoGeneration: 1,
      latMicro,
      lonMicro,
      pointIndex: index + 1,
      windowStartMinute: exact ? 12 * 60 : windowStart,
      windowEndMinute: exact ? 12 * 60 : windowEnd,
      windowSource: windowStart === null && !exact ? null : 'MOYSKLAD',
      windowExact: exact,
    });
  }

  return {
    version: INPUT_SNAPSHOT_VERSION,
    deliveryDate,
    graphSha256,
    trafficMode: 'STATIC',
    maxPoints: PILOT_MAX_POINTS,
    shift: { startMinute: shift.startMinute, endMinute: shift.endMinute, settingVersion: 1 },
    serviceTime: {
      carMinutes: serviceMinutes.car,
      footMinutes: serviceMinutes.foot,
      settingVersion: 1,
    },
    depots: [
      {
        depotId: 'pilot-depot',
        version: 1,
        latMicro: points[0]!.latMicro,
        lonMicro: points[0]!.lonMicro,
        pointIndex: 0,
      },
    ],
    points,
    slots: Array.from({ length: slotCount }, (_, index) => ({
      slotId: `pilot-slot-${index + 1}`,
      slotIndex: index + 1,
      courierUserId: null,
      vehicleType,
      capacityOrders: Math.max(1, Math.ceil(orderCount / slotCount)),
      shiftStartMinute: shift.startMinute,
      shiftEndMinute: shift.endMinute,
      startDepotId: 'pilot-depot',
      endDepotId: 'pilot-depot',
      startPointIndex: 0,
      endPointIndex: 0,
    })),
    orders,
  };
}

/**
 * Берёт из снимка `orders-snapshot@2` только его форму дня: количество заказов
 * и их временные окна.
 *
 * Координат в снимке нет и быть не должно — он обезличен. Поэтому точки
 * остаются синтетическими и детерминированными, а из снимка приходит то,
 * ради чего он и нужен: реальное распределение интервалов рабочего дня.
 */
export function buildDayFromSnapshotShape(
  snapshot: { orders: readonly SnapshotShapeOrder[] },
  options: Omit<SyntheticDayOptions, 'orderCount'> & { orderCount?: number },
): PlanInputSnapshot {
  const usable = snapshot.orders.filter((order) => order.inScope !== false);
  const count = Math.min(options.orderCount ?? usable.length, usable.length);
  const day = buildSyntheticDay({ ...options, orderCount: count });

  for (let index = 0; index < count; index += 1) {
    const source = usable[index]!;
    const target = day.orders[index]!;
    const start = source.manualIntervalStartMinute ?? source.intervalStartMinute;
    const end = source.manualIntervalEndMinute ?? source.intervalEndMinute;

    target.windowStartMinute = start ?? null;
    target.windowEndMinute = end ?? null;
    target.windowSource = start === null || start === undefined ? null : 'MOYSKLAD';
    target.windowExact = start !== null && start !== undefined && start === end;
  }

  return day;
}

/**
 * Читает снимок ТЕМ ЖЕ безопасным слоем, что и штатные команды staging.
 *
 * Собственного разбора здесь нет намеренно: он обошёл бы проверку формата
 * и safety-ворота, ради которых слой и существует. Отвергается всё, что
 * не является `orders-snapshot@2`, а также снимок с настоящим адресом,
 * получателем или следом соли — и отвергается ДО матрицы, решателя и базы.
 *
 * Наружу возвращается только форма дня: интервалы. Псевдонимы, суммы
 * и номера заказов пилоту не нужны и не читаются.
 */
export async function readPilotSnapshot(path: string): Promise<readonly SnapshotShapeOrder[]> {
  const snapshot = await readSnapshotFile(path);
  assertSnapshotIsSafe(snapshot);
  return snapshot.orders;
}

/** Ровно те поля снимка, которые нужны пилоту. Псевдонимы и суммы не читаются. */
export interface SnapshotShapeOrder {
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
  manualIntervalStartMinute: number | null;
  manualIntervalEndMinute: number | null;
  inScope?: boolean;
}

// --- Прогон ------------------------------------------------------------------

export interface PilotDeps {
  /** Матрица: тот же вызов, что у боевого расчёта. */
  matrix: (
    points: readonly { lat: number; lon: number }[],
    profile: $Enums.VehicleType,
  ) => Promise<MatrixResult>;
  /** Решатель: тот же клиент, что у боевого расчёта. */
  solve: (request: VroomRequest) => Promise<VroomSolution>;
  /** Монотонные миллисекунды. Инъекция нужна тестам, а не продукту. */
  clock?: () => number;
}

export interface PilotScenario {
  label: string;
  orderCount: number;
  vehicleType: $Enums.VehicleType;
  /** Сколько раз повторить решение на той же матрице. Минимум два. */
  repeats?: number;
  seed?: number;
}

export interface PilotSolveMeasurement {
  attempt: number;
  solveMs: number;
  routes: number;
  unassigned: number;
  /** Подпись размещения: маршруты и порядок остановок без идентификаторов заказов. */
  placementSignature: string;
}

export interface PilotScenarioReport {
  label: string;
  orderCount: number;
  /** Уникальных точек с учётом склада. */
  pointCount: number;
  profile: string;
  vehicleType: $Enums.VehicleType;
  matrix: {
    coldMs: number;
    warmMs: number;
    coldCached: boolean;
    warmCached: boolean;
    size: number;
    unreachablePairs: number;
    graphSha256Short: string;
    trafficMode: string;
  };
  solves: PilotSolveMeasurement[];
  deterministic: boolean;
  routes: number;
  unassigned: number;
  totals: {
    travelSeconds: number;
    serviceSeconds: number;
    distanceMeters: number;
  };
  baseline: {
    /** Простая воспроизводимая эвристика: ближайшая доступная точка от склада. */
    travelSeconds: number;
    distanceMeters: number;
  };
  gatesPassed: boolean;
  failure: PilotFailureCode | null;
}

export interface PilotReport {
  format: 'flowers-logistics/logistics-pilot@1';
  maxPoints: number;
  scenarios: PilotScenarioReport[];
  allGatesPassed: boolean;
}

/** Подпись размещения: только позиции и число остановок, без идентификаторов. */
function placementSignature(plan: PlanResult): string {
  const routes = plan.routes
    .map((route) => `${route.slotIndex}:${route.stops.map((stop) => stop.orderId).join('>')}`)
    .sort();
  return `${routes.join('|')}#${[...plan.unassignedOrderIds].sort().join(',')}`;
}

/** Сумма матрицы по маршруту: базовая эвристика «ближайшая доступная точка». */
function nearestNeighbourBaseline(
  snapshot: PlanInputSnapshot,
  matrix: SourceMatrix,
): { travelSeconds: number; distanceMeters: number } {
  const remaining = new Set(snapshot.orders.map((order) => order.pointIndex));
  let current = 0;
  let travel = 0;
  let distance = 0;

  while (remaining.size > 0) {
    let best: number | null = null;
    let bestDuration = Number.POSITIVE_INFINITY;

    for (const candidate of remaining) {
      const duration = matrix.durationsSec[current]?.[candidate];
      if (duration !== null && duration !== undefined && duration < bestDuration) {
        bestDuration = duration;
        best = candidate;
      }
    }

    if (best === null) {
      break;
    }

    travel += bestDuration;
    distance += matrix.distancesM[current]?.[best] ?? 0;
    remaining.delete(best);
    current = best;
  }

  // Возврат на склад: маршрут замкнут так же, как у решателя.
  travel += matrix.durationsSec[current]?.[0] ?? 0;
  distance += matrix.distancesM[current]?.[0] ?? 0;

  return { travelSeconds: Math.round(travel), distanceMeters: Math.round(distance) };
}

function assertMatrixShape(result: MatrixResult, size: number, graphSha256: string): number {
  if (result.durationsSec.length !== size || result.distancesM.length !== size) {
    throw new PilotGateError('MATRIX_SHAPE');
  }
  for (const row of result.durationsSec) {
    if (row.length !== size) {
      throw new PilotGateError('MATRIX_SHAPE');
    }
  }
  if (result.graphSha256 !== graphSha256) {
    throw new PilotGateError('MATRIX_GRAPH_MISMATCH');
  }

  let unreachable = 0;
  for (let from = 0; from < size; from += 1) {
    for (let to = 0; to < size; to += 1) {
      if (from !== to && result.durationsSec[from]?.[to] === null) {
        unreachable += 1;
      }
    }
  }
  return unreachable;
}

/**
 * Ответ решателя обязан быть посчитан ПО НАШЕЙ матрице, а не по своей.
 *
 * Наличие полей `matrices` и `service_per_type` в отправленном JSON доказывает
 * только то, что мы их отправили. Решатель мог их проигнорировать и вернуть
 * правдоподобный ответ — от этого и защищает поведенческая проба при выкатке.
 * Здесь то же самое делается на каждом решении пилота.
 *
 * Сверяются два агрегата, семантика которых в ответе VROOM однозначна:
 *
 *  * `distance` маршрута — сумма расстояний по фактическому порядку остановок,
 *    от стартовой точки машины через все работы к конечной;
 *  * `service` маршрута — число фактически размещённых работ, умноженное
 *    на время обслуживания ДЛЯ ЭТОГО типа машины.
 *
 * `duration` намеренно не сверяется: её состав (входит ли ожидание) я фактом
 * на живом решателе не устанавливал, а проверять по догадке — значит однажды
 * объявить отказом исправный ответ.
 *
 * Отсутствие нужного агрегата — отказ, а не «проверка пропущена»: ответ без
 * него ничего не подтверждает.
 */
function assertSolutionUsedOurInputs(
  snapshot: PlanInputSnapshot,
  matrix: SourceMatrix,
  solution: VroomSolution,
): void {
  const slotByIndex = new Map(snapshot.slots.map((slot) => [slot.slotIndex, slot]));
  const pointByJobId = new Map(
    snapshot.orders.map((order, index) => [index + 1, order.pointIndex]),
  );
  const serviceSeconds: Record<$Enums.VehicleType, number> = {
    CAR: snapshot.serviceTime.carMinutes * 60,
    FOOT: snapshot.serviceTime.footMinutes * 60,
  };

  for (const route of solution.routes ?? []) {
    const slot = slotByIndex.get(route.vehicle);
    if (slot === undefined) {
      throw new PilotGateError('SOLVER_UNKNOWN_VEHICLE');
    }

    const jobs = route.steps
      .filter((step) => step.type === 'job' && step.id !== undefined)
      .map((step) => step.id!);

    // Порядок точек: старт машины → работы по факту ответа → её конец.
    const path = [slot.startPointIndex];
    for (const job of jobs) {
      const point = pointByJobId.get(job);
      if (point === undefined) {
        throw new PilotGateError('SOLVER_UNKNOWN_ID');
      }
      path.push(point);
    }
    path.push(slot.endPointIndex);

    let expectedDistance = 0;
    for (let index = 1; index < path.length; index += 1) {
      const leg = matrix.distancesM[path[index - 1]!]?.[path[index]!];
      if (leg === null || leg === undefined) {
        throw new PilotGateError('SOLVER_MATRIX_NOT_USED');
      }
      expectedDistance += leg;
    }

    if (route.distance === undefined) {
      throw new PilotGateError('SOLVER_MATRIX_NOT_USED');
    }
    // Допуск в один метр на плечо: решатель округляет, но не пересчитывает.
    if (Math.abs(route.distance - expectedDistance) > path.length) {
      throw new PilotGateError('SOLVER_MATRIX_NOT_USED');
    }

    if (route.service === undefined) {
      throw new PilotGateError('SOLVER_SERVICE_PER_TYPE_MISSING');
    }
    if (route.service !== jobs.length * serviceSeconds[slot.vehicleType]) {
      // Решатель, не знающий `service_per_type`, взял бы общий `service`
      // либо ноль. И то и другое здесь отличается от ожидаемого.
      throw new PilotGateError('SOLVER_SERVICE_PER_TYPE_MISSING');
    }
  }
}

/** Решатель обязан получить нашу матрицу и время обслуживания по типу машины. */
function assertSolverRequest(
  request: VroomRequest,
  size: number,
  vehicleType: $Enums.VehicleType,
): void {
  const profile = profileOf(vehicleType);
  const matrix = request.matrices[profile];

  if (matrix === undefined || matrix.durations.length !== size) {
    throw new PilotGateError('SOLVER_MATRIX_NOT_USED');
  }
  if (request.jobs.some((job) => job.service_per_type === undefined)) {
    throw new PilotGateError('SOLVER_SERVICE_PER_TYPE_MISSING');
  }
}

/** Ни один заказ не потерян и не удвоен. */
function assertOrdersPreserved(snapshot: PlanInputSnapshot, plan: PlanResult): void {
  const placed = plan.routes.flatMap((route) => route.stops.map((stop) => stop.orderId));
  const all = [...placed, ...plan.unassignedOrderIds];

  if (all.length !== snapshot.orders.length || new Set(all).size !== snapshot.orders.length) {
    throw new PilotGateError('ORDERS_LOST_OR_DUPLICATED');
  }
}

/** Жёсткое окно и точное время не нарушены ни на одной остановке. */
function assertWindowsRespected(snapshot: PlanInputSnapshot, plan: PlanResult): void {
  const byId = new Map(snapshot.orders.map((order) => [order.orderId, order]));

  for (const route of plan.routes) {
    for (const stop of route.stops) {
      const order = byId.get(stop.orderId);
      if (order === undefined || order.windowStartMinute === null || stop.arrivalMinute === null) {
        continue;
      }
      if (
        stop.arrivalMinute < order.windowStartMinute ||
        (order.windowEndMinute !== null && stop.arrivalMinute > order.windowEndMinute)
      ) {
        throw new PilotGateError('WINDOW_VIOLATED');
      }
    }
  }
}

/**
 * Обращения к внешним участникам расчёта.
 *
 * Их отказ обязан называться своим именем: недоступная база, маршрутизатор
 * или решатель — это не испорченная матрица. Текст исходного исключения
 * не переносится: он способен содержать адрес запроса и тело чужого ответа.
 */
async function callMatrix(
  deps: PilotDeps,
  points: readonly { lat: number; lon: number }[],
  vehicleType: $Enums.VehicleType,
): Promise<MatrixResult> {
  try {
    return await deps.matrix(points, vehicleType);
  } catch {
    throw new PilotInfrastructureError('MATRIX_UNAVAILABLE');
  }
}

async function callSolver(deps: PilotDeps, request: VroomRequest): Promise<VroomSolution> {
  try {
    return await deps.solve(request);
  } catch {
    throw new PilotInfrastructureError('SOLVER_UNAVAILABLE');
  }
}

/**
 * Один сценарий: холодная матрица, тёплая матрица, несколько решений.
 *
 * Порядок важен. Матрица считается ДО решателя, потому что предел точек
 * и недостижимая пара обязаны отказать раньше, чем задача уедет решателю:
 * иначе отказ пришёл бы от чужого сервиса и объяснял бы не то.
 */
export async function runPilotScenario(
  deps: PilotDeps,
  scenario: PilotScenario,
  snapshot?: PlanInputSnapshot,
): Promise<PilotScenarioReport> {
  const clock = deps.clock ?? (() => Date.now());
  const day =
    snapshot ??
    buildSyntheticDay({
      orderCount: scenario.orderCount,
      vehicleType: scenario.vehicleType,
      ...(scenario.seed === undefined ? {} : { seed: scenario.seed }),
    });
  const size = day.points.length;

  const base: Omit<PilotScenarioReport, 'gatesPassed' | 'failure'> = {
    label: scenario.label,
    orderCount: day.orders.length,
    pointCount: size,
    profile: profileOf(scenario.vehicleType),
    vehicleType: scenario.vehicleType,
    matrix: {
      coldMs: 0,
      warmMs: 0,
      coldCached: false,
      warmCached: false,
      size,
      unreachablePairs: 0,
      graphSha256Short: `${day.graphSha256.slice(0, 12)}…`,
      trafficMode: day.trafficMode,
    },
    solves: [],
    deterministic: true,
    routes: 0,
    unassigned: 0,
    totals: { travelSeconds: 0, serviceSeconds: 0, distanceMeters: 0 },
    baseline: { travelSeconds: 0, distanceMeters: 0 },
  };

  try {
    if (size > PILOT_MAX_POINTS) {
      // Отказ до решателя: задачу такого размера мы не отправляем никуда.
      throw new PilotGateError('TOO_MANY_POINTS');
    }

    const points = day.points.map((point) => ({
      lat: point.latMicro / 1e6,
      lon: point.lonMicro / 1e6,
    }));

    const coldStart = clock();
    const cold = await callMatrix(deps, points, scenario.vehicleType);
    base.matrix.coldMs = clock() - coldStart;
    base.matrix.coldCached = cold.cached;

    const warmStart = clock();
    const warm = await callMatrix(deps, points, scenario.vehicleType);
    base.matrix.warmMs = clock() - warmStart;
    base.matrix.warmCached = warm.cached;

    base.matrix.unreachablePairs = assertMatrixShape(cold, size, day.graphSha256);
    if (base.matrix.unreachablePairs > 0) {
      // Недостижимая пара — fail closed: план по такой матрице обещал бы
      // доставку, которой не существует.
      throw new PilotGateError('MATRIX_UNREACHABLE_PAIR');
    }

    const source: SourceMatrix = { durationsSec: cold.durationsSec, distancesM: cold.distancesM };
    const request = buildSolverRequest({
      snapshot: day,
      matrices: { [scenario.vehicleType]: source },
    });
    assertSolverRequest(request, size, scenario.vehicleType);

    const repeats = Math.max(2, scenario.repeats ?? 2);
    let lastPlan: PlanResult | null = null;

    for (let attempt = 1; attempt <= repeats; attempt += 1) {
      const solveStart = clock();
      const solution = await callSolver(deps, request);
      const solveMs = clock() - solveStart;
      const plan = parseSolution(day, solution);

      // Первая линия — что мы отправили, вторая — что решатель посчитал.
      assertSolutionUsedOurInputs(day, source, solution);
      assertOrdersPreserved(day, plan);
      assertWindowsRespected(day, plan);

      const signature = placementSignature(plan);
      base.solves.push({
        attempt,
        solveMs,
        routes: plan.routes.length,
        unassigned: plan.unassignedOrderIds.length,
        placementSignature: signature,
      });
      lastPlan = plan;
    }

    const signatures = new Set(base.solves.map((solve) => solve.placementSignature));
    base.deterministic = signatures.size === 1;
    if (!base.deterministic) {
      // Недетерминированный повтор — явный отказ, а не примечание: логист
      // не должен получать разный план на один и тот же вход.
      throw new PilotGateError('NONDETERMINISTIC_REPEAT');
    }

    const plan = lastPlan!;
    base.routes = plan.routes.length;
    base.unassigned = plan.unassignedOrderIds.length;
    base.totals = {
      travelSeconds: plan.routes.reduce((sum, route) => sum + (route.travelSeconds ?? 0), 0),
      serviceSeconds: plan.routes.reduce((sum, route) => sum + (route.serviceSeconds ?? 0), 0),
      distanceMeters: plan.routes.reduce((sum, route) => sum + (route.distanceMeters ?? 0), 0),
    };
    base.baseline = nearestNeighbourBaseline(day, source);

    return { ...base, gatesPassed: true, failure: null };
  } catch (error) {
    const code: PilotFailureCode =
      error instanceof PilotGateError || error instanceof PilotInfrastructureError
        ? error.code
        : error instanceof PlanContractError
          ? error.code
          : // Неизвестная ошибка на этом уровне уже не относится ни к матрице,
            // ни к решателю: их отказы обёрнуты выше. Считать её испорченной
            // матрицей значило бы соврать в отчёте.
            'PILOT_INTERNAL';
    return { ...base, gatesPassed: false, failure: code };
  }
}

/** Полный пилот: несколько размеров и профилей подряд. */
export async function runPilot(
  deps: PilotDeps,
  scenarios: readonly PilotScenario[],
): Promise<PilotReport> {
  const reports: PilotScenarioReport[] = [];
  for (const scenario of scenarios) {
    reports.push(await runPilotScenario(deps, scenario));
  }

  return {
    format: 'flowers-logistics/logistics-pilot@1',
    maxPoints: PILOT_MAX_POINTS,
    scenarios: reports,
    allGatesPassed: reports.every((report) => report.gatesPassed),
  };
}
