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

import { describe, expect, it } from 'vitest';
import type { VroomRequest, VroomSolution } from '../integrations/vroom/client.js';
import type { MatrixResult } from '../geo/matrix/service.js';
import {
  buildDayFromSnapshotShape,
  buildSyntheticDay,
  PILOT_MAX_POINTS,
  runPilot,
  runPilotScenario,
  type PilotDeps,
} from './pilot.js';

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
  options: { shuffleOnSecondCall?: boolean; dropOrder?: boolean; violateWindow?: boolean } = {},
) {
  let call = 0;

  return async (request: VroomRequest): Promise<VroomSolution> => {
    call += 1;
    const jobs = request.jobs.map((job) => job.id);
    const ordered = options.shuffleOnSecondCall === true && call === 2 ? [...jobs].reverse() : jobs;
    const placed = options.dropOrder === true ? ordered.slice(1) : ordered;
    const windowOf = new Map(request.jobs.map((job) => [job.id, job.time_windows?.[0] ?? null]));

    const perVehicle = Math.ceil(placed.length / Math.max(1, request.vehicles.length));

    const routes = request.vehicles.map((current, index) => {
      const slice = placed.slice(index * perVehicle, (index + 1) * perVehicle);
      let second = current.time_window[0];

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
          return { type: 'job' as const, id: job, arrival: second };
        }),
        { type: 'end' as const, arrival: second + 20 * 60 },
      ];

      return {
        vehicle: current.id,
        cost: slice.length * 100,
        duration: slice.length * 600,
        service: slice.length * 480,
        distance: slice.length * 1600,
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

  it('разные зёрна дают разные дни', () => {
    const first = buildSyntheticDay({ orderCount: 10, seed: 1 });
    const second = buildSyntheticDay({ orderCount: 10, seed: 2 });

    expect(JSON.stringify(first.points)).not.toBe(JSON.stringify(second.points));
  });

  it('из снимка берётся форма дня, а не его содержимое', () => {
    const day = buildDayFromSnapshotShape(
      {
        orders: [
          {
            intervalStartMinute: 600,
            intervalEndMinute: 840,
            manualIntervalStartMinute: null,
            manualIntervalEndMinute: null,
          },
          {
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
    // Ручной интервал сильнее исходного, а совпавшие границы — точное время.
    expect(day.orders[1]?.windowStartMinute).toBe(720);
    expect(day.orders[1]?.windowExact).toBe(true);
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
