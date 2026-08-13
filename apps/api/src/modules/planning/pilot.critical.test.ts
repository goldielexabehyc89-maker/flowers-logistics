/**
 * Критические проверки нагрузочного пилота логистики.
 *
 * Пилот существует ради ворот, а ворота имеют смысл, только если каждое из них
 * можно нарушить и получить отказ. Поэтому здесь проверяется не «пилот
 * запустился», а каждое утверждение по отдельности: размер матрицы, ревизия
 * графа, переданная решателю матрица, время обслуживания по типу машины,
 * детерминизм повторов, жёсткие окна, сохранность состава, предел точек
 * и недостижимая пара.
 *
 * Настоящих Valhalla и VROOM здесь нет: адаптеры закреплённые. Это не упрощение
 * — пилот и в бою вызывает те же функции через инъекцию, а сеть в тестах
 * означала бы, что проверка зависит от чужого сервиса.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VroomRequest, VroomSolution } from '../integrations/vroom/client.js';
import type { MatrixResult } from '../geo/matrix/service.js';
import {
  buildDayFromSnapshotShape,
  buildSyntheticDay,
  PILOT_MAX_POINTS,
  readPilotSnapshot,
  runPilot,
  runPilotScenario,
  type PilotDeps,
  type SnapshotShapeOrder,
} from './pilot.js';
import { buildSolverRequest } from './solve.js';

const GRAPH = 'a'.repeat(64);

/** Матрица «манхэттенского» вида: детерминированная и всегда достижимая. */
function fakeMatrix(size: number, options: { unreachable?: boolean; wrongGraph?: boolean } = {}) {
  const durations: (number | null)[][] = [];
  const distances: (number | null)[][] = [];

  for (let from = 0; from < size; from += 1) {
    durations.push([]);
    distances.push([]);
    for (let to = 0; to < size; to += 1) {
      const gap = Math.abs(from - to);
      durations[from]!.push(from === to ? 0 : gap * 60);
      distances[from]!.push(from === to ? 0 : gap * 800);
    }
  }

  if (options.unreachable === true && size > 2) {
    durations[1]![2] = null;
    distances[1]![2] = null;
  }

  return {
    durationsSec: durations,
    distancesM: distances,
    graphSha256: options.wrongGraph === true ? 'b'.repeat(64) : GRAPH,
    profile: 'CAR',
    trafficMode: 'STATIC',
    cached: false,
  } as unknown as MatrixResult;
}

/**
 * Решатель, раскладывающий заказы по машинам подряд.
 *
 * Он намеренно прост и детерминирован: пилот проверяет собственные ворота,
 * а не качество чужого решателя.
 */
function fakeSolve(
  options: {
    shuffleOnSecondCall?: boolean;
    dropOrder?: boolean;
    violateWindow?: boolean;
    /** Правдоподобный ответ, посчитанный НЕ по нашей матрице. */
    ignoreOurMatrix?: boolean;
    /** Правдоподобный ответ с нулевым временем обслуживания. */
    ignoreServicePerType?: boolean;
    /** Приезжает раньше окна и честно сообщает ожидание — обычная работа. */
    arriveEarly?: boolean;
    /** Приезжает раньше окна и об ожидании молчит — доказательства нет. */
    arriveEarlySilently?: boolean;
  } = {},
) {
  let call = 0;

  return async (request: VroomRequest): Promise<VroomSolution> => {
    call += 1;
    const jobs = request.jobs.map((job) => job.id);
    const ordered = options.shuffleOnSecondCall === true && call === 2 ? [...jobs].reverse() : jobs;
    const placed = options.dropOrder === true ? ordered.slice(1) : ordered;
    const windowOf = new Map(request.jobs.map((job) => [job.id, job.time_windows?.[0] ?? null]));

    const perVehicle = Math.ceil(placed.length / Math.max(1, request.vehicles.length));

    const pointOf = new Map(request.jobs.map((job) => [job.id, job.location_index]));
    const matrix = request.matrices['car'] ?? request.matrices['foot'];
    const serviceOf = request.jobs[0]?.service_per_type ?? { CAR: 0, FOOT: 0 };

    const routes = request.vehicles.map((current, index) => {
      const slice = placed.slice(index * perVehicle, (index + 1) * perVehicle);
      let second = current.time_window[0];

      // Исправный решатель считает по ПЕРЕДАННОЙ матрице: иначе поведенческая
      // сверка обязана это заметить.
      let distance = 0;
      let previous = current.start_index;
      for (const job of slice) {
        const next = pointOf.get(job)!;
        distance += matrix?.distances[previous]?.[next] ?? 0;
        previous = next;
      }
      distance += matrix?.distances[previous]?.[current.end_index] ?? 0;

      const steps = [
        { type: 'start' as const, arrival: second },
        ...slice.map((job) => {
          // Исправный решатель приезжает внутрь окна: начало окна, если оно
          // задано, иначе просто следующий свободный момент смены.
          const window = windowOf.get(job) ?? null;
          second = window === null ? second + 20 * 60 : window[0];
          if (options.violateWindow === true && window !== null) {
            second = window[1] + 60 * 60;
          }
          // Раннее прибытие — не нарушение: курьер ждёт, и решатель обязан
          // сообщить, сколько именно.
          if (
            window !== null &&
            (options.arriveEarly === true || options.arriveEarlySilently === true)
          ) {
            const early = window[0] - 30 * 60;
            second = window[0];
            return {
              type: 'job' as const,
              id: job,
              arrival: early,
              ...(options.arriveEarlySilently === true ? {} : { waiting_time: 30 * 60 }),
            };
          }
          return { type: 'job' as const, id: job, arrival: second };
        }),
        { type: 'end' as const, arrival: second + 20 * 60 },
      ];

      return {
        vehicle: current.id,
        cost: slice.length * 100,
        duration: slice.length * 600,
        service:
          options.ignoreServicePerType === true
            ? 0
            : slice.length * serviceOf[current.type as 'CAR' | 'FOOT'],
        distance: options.ignoreOurMatrix === true ? distance + 5000 : distance,
        steps,
      };
    });

    return {
      code: 0,
      routes,
      unassigned: [],
      summary: {
        cost: routes.reduce((sum, route) => sum + route.cost, 0),
        duration: routes.reduce((sum, route) => sum + route.duration, 0),
        service: routes.reduce((sum, route) => sum + route.service, 0),
        distance: routes.reduce((sum, route) => sum + route.distance, 0),
        unassigned: 0,
      },
    } as unknown as VroomSolution;
  };
}

function depsWith(matrixFactory: (size: number) => MatrixResult, solve = fakeSolve()): PilotDeps {
  let tick = 0;
  return {
    matrix: async (points) => matrixFactory(points.length),
    solve,
    // Часы монотонны и предсказуемы: измеряется поведение, а не машина.
    clock: () => {
      tick += 5;
      return tick;
    },
  };
}

describe('синтетический день пилота', () => {
  it('одно зерно даёт один и тот же день', () => {
    const first = buildSyntheticDay({ orderCount: 10, seed: 42 });
    const second = buildSyntheticDay({ orderCount: 10, seed: 42 });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // Точек на одну больше, чем заказов: нулевая — склад.
    expect(first.points).toHaveLength(11);
    expect(first.depots[0]?.pointIndex).toBe(0);
  });

  it('зерно больше не управляет координатами', () => {
    const first = buildSyntheticDay({ orderCount: 10, seed: 1 });
    const second = buildSyntheticDay({ orderCount: 10, seed: 2 });

    // Раньше зерно задавало и точки: они брались случайно из прямоугольника
    // вокруг Москвы и попадали в парки, в воду и в отрезанные куски сети.
    // Теперь точки приходят из дорожного набора, и это осознанная потеря
    // разнообразия: набор, меняющийся от прогона к прогону, не с чем сравнить.
    expect(JSON.stringify(first.points)).toBe(JSON.stringify(second.points));
  });

  it('из снимка берётся форма дня, а не его содержимое', () => {
    const day = buildDayFromSnapshotShape(
      {
        orders: [
          {
            intervalKind: 'RANGE',
            intervalStartMinute: 600,
            intervalEndMinute: 840,
            manualIntervalStartMinute: null,
            manualIntervalEndMinute: null,
          },
          {
            intervalKind: 'MISSING',
            intervalStartMinute: null,
            intervalEndMinute: null,
            manualIntervalStartMinute: 720,
            manualIntervalEndMinute: 720,
          },
        ],
      },
      { seed: 7 },
    );

    expect(day.orders).toHaveLength(2);
    expect(day.orders[0]?.windowStartMinute).toBe(600);
    expect(day.orders[0]?.windowEndMinute).toBe(840);
    // Ручной интервал сильнее исходного. Признак «точное время» при этом
    // остаётся ложным ровно так же, как на боевом пути: он означает
    // «клиенту названа минута», а не «границы совпали».
    expect(day.orders[1]?.windowStartMinute).toBe(720);
    expect(day.orders[1]?.windowEndMinute).toBe(720);
    expect(day.orders[1]?.windowSource).toBe('MANUAL');
  });
});

/**
 * Точное время не теряется по дороге из снимка.
 *
 * Именно этим отказал завершающий snapshot-прогон: адаптер снимка не читал
 * `intervalKind` и копировал `EXACT` как `start=t, end=null`. Такое окно
 * `buildSolverRequest` решателю НЕ отправляет — ему нужны обе границы, —
 * а строгая проверка начала обслуживания видела неполное представление
 * и закрывалась. Обещание «ровно в t» тихо становилось «когда угодно».
 *
 * Поэтому окно снимка теперь считает тот же `orderWindow`, что и боевой путь,
 * а здесь закреплены все четыре вида интервала и приоритет ручного.
 */
describe('форма дня из снимка совпадает с боевой семантикой', () => {
  function shapeOrder(overrides: Partial<SnapshotShapeOrder> & { intervalKind: string }) {
    return {
      intervalStartMinute: null,
      intervalEndMinute: null,
      manualIntervalStartMinute: null,
      manualIntervalEndMinute: null,
      ...overrides,
    };
  }

  it('EXACT со стартом t превращается в жёсткое окно нулевой ширины', () => {
    const day = buildDayFromSnapshotShape(
      { orders: [shapeOrder({ intervalKind: 'EXACT', intervalStartMinute: 840 })] },
      {},
    );

    expect(day.orders[0]?.windowStartMinute).toBe(840);
    expect(day.orders[0]?.windowEndMinute).toBe(840);
    expect(day.orders[0]?.windowExact).toBe(true);
    expect(day.orders[0]?.windowSource).toBe('MOYSKLAD');
  });

  it('EXACT уходит решателю ровно как [t*60, t*60]', () => {
    const day = buildDayFromSnapshotShape(
      { orders: [shapeOrder({ intervalKind: 'EXACT', intervalStartMinute: 840 })] },
      {},
    );
    const size = day.points.length;
    const request = buildSolverRequest({
      snapshot: day,
      matrices: {
        CAR: {
          durationsSec: Array.from({ length: size }, () => Array.from({ length: size }, () => 60)),
          distancesM: Array.from({ length: size }, () => Array.from({ length: size }, () => 100)),
        },
      },
    });

    // Прежде окна здесь не было вовсе: решатель не получал обещания,
    // а проверка требовала его соблюдения.
    expect(request.jobs[0]?.time_windows).toEqual([[840 * 60, 840 * 60]]);
  });

  it('RANGE сохраняет обе настоящие границы', () => {
    const day = buildDayFromSnapshotShape(
      {
        orders: [
          shapeOrder({ intervalKind: 'RANGE', intervalStartMinute: 600, intervalEndMinute: 780 }),
        ],
      },
      {},
    );

    expect(day.orders[0]?.windowStartMinute).toBe(600);
    expect(day.orders[0]?.windowEndMinute).toBe(780);
    expect(day.orders[0]?.windowExact).toBe(false);
  });

  it('MISSING и UNRECOGNIZED окна не получают либо честно отказывают', () => {
    const missing = buildDayFromSnapshotShape(
      { orders: [shapeOrder({ intervalKind: 'MISSING' })] },
      {},
    );
    expect(missing.orders[0]?.windowStartMinute).toBeNull();
    expect(missing.orders[0]?.windowEndMinute).toBeNull();
    expect(missing.orders[0]?.windowSource).toBeNull();

    // Нераспознанный интервал — это НЕ «без ограничений»: считать нечего,
    // и подменять его свободой значило бы пообещать другое.
    expect(() =>
      buildDayFromSnapshotShape({ orders: [shapeOrder({ intervalKind: 'UNRECOGNIZED' })] }, {}),
    ).toThrow(/SOLVER_TIME_WINDOW/);
  });

  it('полный ручной интервал сильнее импортированного', () => {
    const day = buildDayFromSnapshotShape(
      {
        orders: [
          shapeOrder({
            intervalKind: 'EXACT',
            intervalStartMinute: 840,
            manualIntervalStartMinute: 600,
            manualIntervalEndMinute: 780,
          }),
        ],
      },
      {},
    );

    expect(day.orders[0]?.windowStartMinute).toBe(600);
    expect(day.orders[0]?.windowEndMinute).toBe(780);
    expect(day.orders[0]?.windowSource).toBe('MANUAL');
  });

  it('противоречивое представление закрывается, а не ослабляет окно', () => {
    // `RANGE` без второй границы и `EXACT` без начала — не полуокна,
    // а испорченные данные. Молча превратить их в «когда угодно» нельзя.
    for (const broken of [
      shapeOrder({ intervalKind: 'RANGE', intervalStartMinute: 600 }),
      shapeOrder({ intervalKind: 'EXACT' }),
    ]) {
      expect(
        () => buildDayFromSnapshotShape({ orders: [broken] }, {}),
        broken.intervalKind,
      ).toThrow(/SOLVER_TIME_WINDOW/);
    }
  });

  it('точное время из снимка проходит весь путь: ранний приезд с ожиданием', async () => {
    // Сквозная проверка ровно того пути, который отказал: снимок → окно →
    // запрос решателю → строгая проверка начала обслуживания.
    const day = buildDayFromSnapshotShape(
      {
        orders: [
          shapeOrder({ intervalKind: 'EXACT', intervalStartMinute: 720 }),
          shapeOrder({ intervalKind: 'RANGE', intervalStartMinute: 600, intervalEndMinute: 780 }),
          shapeOrder({ intervalKind: 'MISSING' }),
        ],
      },
      { vehicleType: 'CAR' },
    );

    const report = await runPilotScenario(
      depsWith((size) => fakeMatrix(size), fakeSolve({ arriveEarly: true })),
      { label: 'снимок', orderCount: 3, vehicleType: 'CAR', repeats: 3 },
      day,
    );

    expect(report.failure).toBeNull();
    expect(report.gatesPassed).toBe(true);
    expect(report.deterministic).toBe(true);
  });

  it('форма настоящего дня: 6 диапазонов, 1 точное время, 3 без окна', () => {
    // Та же форма, что и в утверждённом снимке приёмки. Точное время обязано
    // дожить до запроса решателю, иначе прогон снова остановится на CAR.
    const orders = [
      ...Array.from({ length: 6 }, (_, index) =>
        shapeOrder({
          intervalKind: 'RANGE',
          intervalStartMinute: 600 + index * 30,
          intervalEndMinute: 780 + index * 30,
        }),
      ),
      shapeOrder({ intervalKind: 'EXACT', intervalStartMinute: 720 }),
      ...Array.from({ length: 3 }, () => shapeOrder({ intervalKind: 'MISSING' })),
    ];

    for (const vehicleType of ['CAR', 'FOOT'] as const) {
      const day = buildDayFromSnapshotShape({ orders }, { vehicleType });

      const windowed = day.orders.filter((order) => order.windowStartMinute !== null);
      const exact = day.orders.filter((order) => order.windowExact);

      expect(windowed, vehicleType).toHaveLength(7);
      expect(exact, vehicleType).toHaveLength(1);
      expect(exact[0]?.windowStartMinute, vehicleType).toBe(720);
      expect(exact[0]?.windowEndMinute, vehicleType).toBe(720);
      // Ни одного полуокна: решателю уходит либо полное окно, либо ничего.
      for (const order of day.orders) {
        expect(order.windowStartMinute === null, vehicleType).toBe(order.windowEndMinute === null);
      }
    }
  });
});

describe('ворота пилота', () => {
  it('исправный прогон проходит все ворота и не теряет заказы', async () => {
    const report = await runPilotScenario(
      depsWith((size) => fakeMatrix(size)),
      {
        label: '10 точек',
        orderCount: 10,
        vehicleType: 'CAR',
      },
    );

    expect(report.failure).toBeNull();
    expect(report.gatesPassed).toBe(true);
    expect(report.pointCount).toBe(11);
    expect(report.matrix.size).toBe(11);
    expect(report.deterministic).toBe(true);
    expect(report.solves.length).toBeGreaterThanOrEqual(2);
    expect(report.routes + report.unassigned).toBeGreaterThan(0);
    expect(report.baseline.travelSeconds).toBeGreaterThan(0);
  });

  it('больше предела точек — отказ ДО решателя', async () => {
    let solverCalls = 0;
    const deps = depsWith(
      (size) => fakeMatrix(size),
      async () => {
        solverCalls += 1;
        throw new Error('решатель не должен быть вызван');
      },
    );

    const report = await runPilotScenario(deps, {
      label: 'предел',
      orderCount: PILOT_MAX_POINTS,
      vehicleType: 'CAR',
    });

    expect(report.failure).toBe('TOO_MANY_POINTS');
    expect(report.gatesPassed).toBe(false);
    expect(solverCalls).toBe(0);
  });

  it('ровно предел точек проходит', async () => {
    const report = await runPilotScenario(
      depsWith((size) => fakeMatrix(size)),
      {
        label: 'ровно предел',
        orderCount: PILOT_MAX_POINTS - 1,
        vehicleType: 'CAR',
      },
    );

    expect(report.pointCount).toBe(PILOT_MAX_POINTS);
    expect(report.failure).toBeNull();
  });

  it('недостижимая пара — fail closed', async () => {
    const report = await runPilotScenario(
      depsWith((size) => fakeMatrix(size, { unreachable: true })),
      { label: 'дыра в графе', orderCount: 10, vehicleType: 'CAR' },
    );

    expect(report.failure).toBe('MATRIX_UNREACHABLE_PAIR');
    expect(report.matrix.unreachablePairs).toBeGreaterThan(0);
  });

  it('чужая ревизия графа отвергается', async () => {
    const report = await runPilotScenario(
      depsWith((size) => fakeMatrix(size, { wrongGraph: true })),
      { label: 'другой граф', orderCount: 10, vehicleType: 'CAR' },
    );

    expect(report.failure).toBe('MATRIX_GRAPH_MISMATCH');
  });

  it('матрица неверного размера отвергается', async () => {
    const report = await runPilotScenario(
      depsWith(() => fakeMatrix(5)),
      { label: 'обрезанная матрица', orderCount: 10, vehicleType: 'CAR' },
    );

    expect(report.failure).toBe('MATRIX_SHAPE');
  });

  it('разный план на один и тот же вход — явный отказ', async () => {
    const report = await runPilotScenario(
      depsWith((size) => fakeMatrix(size), fakeSolve({ shuffleOnSecondCall: true })),
      { label: 'недетерминизм', orderCount: 9, vehicleType: 'CAR', repeats: 2 },
    );

    expect(report.failure).toBe('NONDETERMINISTIC_REPEAT');
    expect(report.deterministic).toBe(false);
  });

  it('потерянный заказ — явный отказ, а не тихо укороченный план', async () => {
    const report = await runPilotScenario(
      depsWith((size) => fakeMatrix(size), fakeSolve({ dropOrder: true })),
      { label: 'потеря', orderCount: 9, vehicleType: 'CAR' },
    );

    // Пропажу ловит контракт самого планирования — раньше, чем собственная
    // проверка пилота. Это и требуется: ворота закрыты продуктовым кодом,
    // а пилот остаётся второй линией на случай его ослабления.
    expect(report.gatesPassed).toBe(false);
    expect(['SOLVER_PARTITION', 'ORDERS_LOST_OR_DUPLICATED']).toContain(report.failure);
  });

  it('нарушенное жёсткое окно — явный отказ', async () => {
    const report = await runPilotScenario(
      depsWith((size) => fakeMatrix(size), fakeSolve({ violateWindow: true })),
      { label: 'окно', orderCount: 9, vehicleType: 'CAR' },
    );

    expect(report.gatesPassed).toBe(false);
    expect(['WINDOW_VIOLATED', 'SOLVER_TIME_WINDOW']).toContain(report.failure);
  });

  it('раннее прибытие с сообщённым ожиданием — не нарушение окна', async () => {
    // Ровно этот случай остановил первый настоящий операционный прогон:
    // решатель, граф и матрицы были исправны, а контрольный слой сравнивал
    // сырое прибытие с началом окна.
    const report = await runPilotScenario(
      depsWith((size) => fakeMatrix(size), fakeSolve({ arriveEarly: true })),
      { label: 'ожидание', orderCount: 9, vehicleType: 'CAR', repeats: 3 },
    );

    expect(report.failure).toBeNull();
    expect(report.gatesPassed).toBe(true);
    // Повторы того же входа обязаны остаться совпадающими.
    expect(report.deterministic).toBe(true);
  });

  it('раннее прибытие БЕЗ сообщённого ожидания отказывает', async () => {
    // Обратная сторона того же правила: молчание об ожидании доказательством
    // соблюдённого окна не является.
    const report = await runPilotScenario(
      depsWith((size) => fakeMatrix(size), fakeSolve({ arriveEarlySilently: true })),
      { label: 'без ожидания', orderCount: 9, vehicleType: 'CAR' },
    );

    expect(report.gatesPassed).toBe(false);
    expect(report.failure).toBe('SOLVER_TIME_WINDOW');
  });

  it('решателю уходит наша матрица и время обслуживания по типу машины', async () => {
    let seen: VroomRequest | null = null;
    const deps = depsWith(
      (size) => fakeMatrix(size),
      async (request) => {
        seen = request;
        return fakeSolve()(request);
      },
    );

    await runPilotScenario(deps, { label: 'запрос', orderCount: 10, vehicleType: 'CAR' });

    const request = seen as VroomRequest | null;
    expect(request).not.toBeNull();
    expect(Object.keys(request!.matrices)).toEqual(['car']);
    expect(request!.matrices['car']?.durations).toHaveLength(11);
    for (const job of request!.jobs) {
      expect(job.service_per_type).toBeDefined();
    }
    // Геометрия не запрашивается: решатель не должен ходить в маршрутизатор сам.
    expect(JSON.stringify(request)).not.toContain('geometry');
  });

  it('ответ, посчитанный не по нашей матрице, отвергается', async () => {
    // Поля `matrices` в запросе присутствуют, но результат им не соответствует:
    // ровно тот случай, от которого проверка исходящего JSON не защищает.
    const report = await runPilotScenario(
      depsWith((size) => fakeMatrix(size), fakeSolve({ ignoreOurMatrix: true })),
      { label: 'чужая матрица', orderCount: 9, vehicleType: 'CAR' },
    );

    expect(report.failure).toBe('SOLVER_MATRIX_NOT_USED');
  });

  it('ответ с нулевым временем обслуживания отвергается', async () => {
    const report = await runPilotScenario(
      depsWith((size) => fakeMatrix(size), fakeSolve({ ignoreServicePerType: true })),
      { label: 'без service_per_type', orderCount: 9, vehicleType: 'CAR' },
    );

    expect(report.failure).toBe('SOLVER_SERVICE_PER_TYPE_MISSING');
  });

  it('ответ без нужных агрегатов — отказ, а не пропущенная проверка', async () => {
    const withoutAggregates = async (request: VroomRequest): Promise<VroomSolution> => {
      const vehicle = request.vehicles[0]!;
      return {
        code: 0,
        routes: [
          {
            vehicle: vehicle.id,
            steps: [
              { type: 'start', arrival: vehicle.time_window[0] },
              // Прибытие внутрь окна, если оно задано: этот случай проверяет
              // отсутствие агрегатов, а не соблюдение обещанного времени.
              ...request.jobs.map((job, index) => ({
                type: 'job',
                id: job.id,
                arrival: job.time_windows?.[0]?.[0] ?? vehicle.time_window[0] + (index + 1) * 600,
              })),
              { type: 'end', arrival: vehicle.time_window[1] },
            ],
          },
        ],
        unassigned: [],
      } as unknown as VroomSolution;
    };

    const report = await runPilotScenario(
      depsWith((size) => fakeMatrix(size), withoutAggregates),
      { label: 'без агрегатов', orderCount: 6, vehicleType: 'CAR' },
    );

    expect(report.failure).toBe('SOLVER_MATRIX_NOT_USED');
  });

  it('недоступная матрица называется своим кодом, а не испорченной формой', async () => {
    const report = await runPilotScenario(
      {
        matrix: async () => {
          throw new Error('connect ECONNREFUSED 10.0.0.1:8002 /route?json=секрет');
        },
        solve: fakeSolve(),
        clock: () => 0,
      },
      { label: 'нет Valhalla', orderCount: 9, vehicleType: 'CAR' },
    );

    expect(report.failure).toBe('MATRIX_UNAVAILABLE');
    // Текст исходного исключения наружу не выходит.
    expect(JSON.stringify(report)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(report)).not.toContain('секрет');
  });

  it('недоступный решатель называется своим кодом', async () => {
    const report = await runPilotScenario(
      {
        matrix: async (points) => fakeMatrix(points.length),
        solve: async () => {
          throw new Error('connect ECONNREFUSED 10.0.0.2:3000 /?json=секрет');
        },
        clock: () => 0,
      },
      { label: 'нет VROOM', orderCount: 9, vehicleType: 'CAR' },
    );

    expect(report.failure).toBe('SOLVER_UNAVAILABLE');
    expect(JSON.stringify(report)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(report)).not.toContain('секрет');
  });

  it('оба профиля считаются отдельно и не смешиваются', async () => {
    const report = await runPilot(
      depsWith((size) => fakeMatrix(size)),
      [
        { label: 'CAR 10', orderCount: 10, vehicleType: 'CAR' },
        { label: 'FOOT 10', orderCount: 10, vehicleType: 'FOOT' },
      ],
    );

    expect(report.scenarios.map((scenario) => scenario.profile)).toEqual(['car', 'foot']);
    expect(report.allGatesPassed).toBe(true);
  });

  it('тёплая матрица измеряется отдельно от холодной', async () => {
    let calls = 0;
    const deps: PilotDeps = {
      matrix: async (points) => {
        calls += 1;
        return { ...fakeMatrix(points.length), cached: calls > 1 } as MatrixResult;
      },
      solve: fakeSolve(),
      clock: (() => {
        let tick = 0;
        return () => {
          tick += 5;
          return tick;
        };
      })(),
    };

    const report = await runPilotScenario(deps, {
      label: 'кэш',
      orderCount: 10,
      vehicleType: 'CAR',
    });

    expect(report.matrix.coldCached).toBe(false);
    expect(report.matrix.warmCached).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('отчёт пилота не содержит персональных данных', () => {
  it('в отчёте нет координат, адресов и идентификаторов заказов', async () => {
    const report = await runPilot(
      depsWith((size) => fakeMatrix(size)),
      [{ label: '10 точек', orderCount: 10, vehicleType: 'CAR' }],
    );

    const serialized = JSON.stringify(report);

    // Координаты синтетические, но и они наружу не выходят.
    expect(serialized).not.toContain('latMicro');
    expect(serialized).not.toContain('lonMicro');
    expect(serialized).not.toContain('55.7');
    expect(serialized).not.toContain('37.6');
    expect(serialized).not.toContain('addr-');
    expect(serialized).not.toContain('rcpt-');
    // Полный отпечаток графа не печатается — только короткий префикс.
    expect(serialized).not.toContain(GRAPH);
    expect(report.scenarios[0]?.matrix.graphSha256Short).toContain('…');
  });

  it('подпись размещения не раскрывает содержимое заказов', async () => {
    const report = await runPilotScenario(
      depsWith((size) => fakeMatrix(size)),
      {
        label: '10 точек',
        orderCount: 10,
        vehicleType: 'CAR',
      },
    );

    for (const solve of report.solves) {
      // Подпись состоит из синтетических идентификаторов пилота и разделителей.
      expect(solve.placementSignature).toMatch(/^[-0-9a-z:>|#,]*$/);
    }
  });
});

describe('снимок читается штатным безопасным слоем', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pilot-snapshot-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, content: unknown): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, JSON.stringify(content), 'utf8');
    return file;
  }

  const safeOrder = {
    key: 'syn-1',
    number: 'SYN-0001',
    deliveryDate: '2026-08-20',
    intervalKind: 'RANGE',
    intervalStartMinute: 600,
    intervalEndMinute: 840,
    manualIntervalStartMinute: null,
    manualIntervalEndMinute: null,
    manualIntervalSetAt: null,
    addressAlias: 'addr-0000000001',
    recipientAlias: 'rcpt-0000000001',
    hasComment: false,
    externalStateName: 'Новый',
    externalStateType: 'Regular',
    sumMinor: '1000',
    payedSumMinor: '0',
    cashCollectable: false,
    cashToCollectMinor: '0',
    cashAnomaly: false,
    inScope: true,
    needsAttention: false,
    attentionReasons: [],
  };

  it('снимок @2 принимается и отдаёт только форму дня', async () => {
    const file = await write('ok.json', {
      format: 'flowers-logistics/orders-snapshot@2',
      takenAt: '2026-08-11T09:00:00.000Z',
      aliasSaltId: 'a1b2c3d4e5f6',
      orders: [safeOrder],
    });

    const orders = await readPilotSnapshot(file);
    expect(orders).toHaveLength(1);
    expect(orders[0]?.intervalStartMinute).toBe(600);
  });

  it('снимок @1 отвергается до матрицы, решателя и базы', async () => {
    const file = await write('v1.json', {
      format: 'flowers-logistics/orders-snapshot@1',
      takenAt: '2026-08-11T09:00:00.000Z',
      aliasSaltId: 'a1b2c3d4e5f6',
      orders: [safeOrder],
    });

    await expect(readPilotSnapshot(file)).rejects.toThrow();
  });

  it('неизвестный формат отвергается', async () => {
    const file = await write('alien.json', { format: 'что-то другое', orders: [] });

    await expect(readPilotSnapshot(file)).rejects.toThrow();
  });

  it('настоящий адрес и получатель вместо псевдонимов отвергаются', async () => {
    const file = await write('pii.json', {
      format: 'flowers-logistics/orders-snapshot@2',
      takenAt: '2026-08-11T09:00:00.000Z',
      aliasSaltId: 'a1b2c3d4e5f6',
      orders: [{ ...safeOrder, addressAlias: 'Москва, Тверская 1' }],
    });

    await expect(readPilotSnapshot(file)).rejects.toThrow();
  });

  it('ошибка разбора не цитирует содержимое файла', async () => {
    const file = path.join(dir, 'broken.json');
    await writeFile(file, '{ "orders": [ "Москва, Тверская 1" ', 'utf8');

    const error = await readPilotSnapshot(file).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('Москва');
    expect((error as Error).message).not.toContain('Тверская');
  });

  it('относительный путь и маска отвергаются', async () => {
    await expect(readPilotSnapshot('relative/snapshot.json')).rejects.toThrow();
    await expect(readPilotSnapshot('/tmp/*.json')).rejects.toThrow();
  });
});
