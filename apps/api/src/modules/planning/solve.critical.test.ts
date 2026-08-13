/**
 * Критические проверки контракта решателя.
 *
 * Базы и сети здесь нет: проверяется то, что уходит наружу и то, чему мы верим,
 * вернувшись. Именно эти правила защищают план от правдоподобной неправды —
 * недостижимой пары, выданной за ноль; заказа, тихо выпавшего из разбиения;
 * маршрута, начинающегося не на складе.
 */

import { describe, expect, it } from 'vitest';
import {
  assertNumericRequest,
  VroomClient,
  VroomError,
  type VroomSolution,
} from '../integrations/vroom/client.js';
import {
  buildInputSnapshot,
  canonicalJson,
  orderProblem,
  orderWindow,
  snapshotHash,
  type PlanInputSnapshot,
} from './input.js';
import {
  buildSolverRequest,
  parseSolution,
  PlanContractError,
  toSolverMatrix,
  type SourceMatrix,
} from './solve.js';

const DEPOT = {
  id: 'depot-1',
  name: 'Склад',
  address: 'Москва',
  latMicro: 55_751_244,
  lonMicro: 37_618_423,
  isActive: true,
  defaultKey: 'default',
  version: 1,
};

function snapshot(overrides: Partial<PlanInputSnapshot> = {}): PlanInputSnapshot {
  const base = buildInputSnapshot({
    deliveryDate: '2026-09-01',
    graphSha256: '0f'.repeat(32),
    trafficMode: 'STATIC',
    maxPoints: 60,
    shift: { startMinute: 540, endMinute: 1080 },
    shiftVersion: 1,
    serviceTime: { carMinutes: 10, footMinutes: 15 },
    serviceTimeVersion: 1,
    depots: [DEPOT],
    orders: [
      order('order-a', 55_760_000, 37_600_000),
      order('order-b', 55_770_000, 37_640_000, { start: 600, end: 720 }),
    ],
    slots: [
      {
        slotIndex: 1,
        courierUserId: null,
        vehicleType: 'CAR',
        capacityOrders: 2,
        shiftStartMinute: 540,
        shiftEndMinute: 1080,
        startDepotId: DEPOT.id,
        endDepotId: DEPOT.id,
      },
    ],
    slotIds: ['slot-1'],
  });

  return { ...base, ...overrides };
}

function order(
  id: string,
  latMicro: number,
  lonMicro: number,
  window?: { start: number; end?: number },
) {
  const exact = window !== undefined && window.end === undefined;
  return {
    id,
    version: 1,
    geoGeneration: 1,
    geoState: 'RESOLVED' as const,
    geoLatMicro: latMicro,
    geoLonMicro: lonMicro,
    intervalKind:
      window === undefined ? ('MISSING' as const) : exact ? ('EXACT' as const) : ('RANGE' as const),
    intervalStartMinute: window?.start ?? null,
    intervalEndMinute: window?.end ?? null,
    manualIntervalStartMinute: null,
    manualIntervalEndMinute: null,
  };
}

function fullMatrix(size: number, value: number): SourceMatrix {
  const build = (): (number | null)[][] =>
    Array.from({ length: size }, (_, from) =>
      Array.from({ length: size }, (_, to) => (from === to ? 0 : value)),
    );
  return { durationsSec: build(), distancesM: build() };
}

describe('снимок входа', () => {
  it('склад и заказы делят набор уникальных точек, совпадающие адреса — одну строку', () => {
    const built = buildInputSnapshot({
      deliveryDate: '2026-09-01',
      graphSha256: '0f'.repeat(32),
      trafficMode: 'STATIC',
      maxPoints: 60,
      shift: { startMinute: 540, endMinute: 1080 },
      shiftVersion: 1,
      serviceTime: { carMinutes: 10, footMinutes: 10 },
      serviceTimeVersion: 1,
      depots: [DEPOT],
      // Два заказа по одному адресу и третий — по адресу самого склада.
      orders: [
        order('order-a', 55_760_000, 37_600_000),
        order('order-b', 55_760_000, 37_600_000),
        order('order-c', DEPOT.latMicro, DEPOT.lonMicro),
      ],
      slots: [
        {
          slotIndex: 1,
          courierUserId: null,
          vehicleType: 'CAR',
          capacityOrders: 3,
          shiftStartMinute: 540,
          shiftEndMinute: 1080,
          startDepotId: DEPOT.id,
          endDepotId: DEPOT.id,
        },
      ],
      slotIds: ['slot-1'],
    });

    // Склад и три заказа дают всего ДВЕ уникальные точки.
    expect(built.points).toHaveLength(2);
    expect(built.orders[0]?.pointIndex).toBe(built.orders[1]?.pointIndex);
    expect(built.orders[2]?.pointIndex).toBe(built.depots[0]?.pointIndex);
    // Совпадающие склад начала и конца — одна и та же строка матрицы.
    expect(built.slots[0]?.startPointIndex).toBe(built.slots[0]?.endPointIndex);
  });

  it('канонический хеш не зависит от порядка ключей', () => {
    const left = snapshot();
    const right = JSON.parse(JSON.stringify(left)) as PlanInputSnapshot;
    // Пересобираем объект с другим порядком ключей.
    const reordered = { ...right, orders: right.orders, version: right.version };
    expect(snapshotHash(left)).toBe(snapshotHash(reordered as PlanInputSnapshot));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe('точное время доставки', () => {
  const exactOrder = order('order-exact', 55_780_000, 37_660_000, { start: 840 });

  it('становится окном нулевой ширины, а не достроенным диапазоном', () => {
    const window = orderWindow(exactOrder);

    expect(window).toEqual({
      startMinute: 840,
      endMinute: 840,
      source: 'MOYSKLAD',
      exact: true,
    });
  });

  it('не блокирует расчёт: непригодным заказ от этого не становится', () => {
    // Прежде такой заказ требовал ручного интервала до запуска. Ответ на вопрос
    // «успеем ли» даёт расчёт, а не человек вслепую.
    expect(orderProblem(exactOrder)).toBeNull();
  });

  it('невыполнимое окно вне смены тоже не блокирует расчёт', () => {
    // Ограничение невыполнимо — это вывод решателя, а не порок данных:
    // заказ уйдёт в неразмещённые вместе с остальными невыполнимыми.
    const nightly = order('order-night', 55_781_000, 37_661_000, { start: 60, end: 120 });
    expect(orderProblem(nightly)).toBeNull();
  });

  it('нераспознанное время по-прежнему блокирует: считать нечего', () => {
    const broken = {
      ...order('order-broken', 55_782_000, 37_662_000),
      intervalKind: 'UNRECOGNIZED' as const,
    };
    expect(orderProblem(broken)).toBe('INTERVAL_UNRECOGNIZED');
  });

  it('уходит решателю ровно как [t, t]: границы окна включительны с обеих сторон', () => {
    const built = buildInputSnapshot({
      deliveryDate: '2026-09-01',
      graphSha256: '0f'.repeat(32),
      trafficMode: 'STATIC',
      maxPoints: 60,
      shift: { startMinute: 540, endMinute: 1080 },
      shiftVersion: 1,
      serviceTime: { carMinutes: 10, footMinutes: 10 },
      serviceTimeVersion: 1,
      depots: [DEPOT],
      orders: [exactOrder, order('order-free', 55_790_000, 37_670_000)],
      slots: [
        {
          slotIndex: 1,
          courierUserId: null,
          vehicleType: 'CAR',
          capacityOrders: 2,
          shiftStartMinute: 540,
          shiftEndMinute: 1080,
          startDepotId: DEPOT.id,
          endDepotId: DEPOT.id,
        },
      ],
      slotIds: ['slot-1'],
    });

    expect(built.orders[0]?.windowExact).toBe(true);

    const request = buildSolverRequest({
      snapshot: built,
      matrices: { CAR: fullMatrix(built.points.length, 60) },
    });

    expect(request.jobs[0]?.time_windows).toEqual([[840 * 60, 840 * 60]]);
    // Заказ без интервала окна не получает: отсутствие интервала не срочность.
    expect(request.jobs[1]?.time_windows).toBeUndefined();
  });

  it('прибытие позже точного времени отвергается как нарушение обещания', () => {
    const built = buildInputSnapshot({
      deliveryDate: '2026-09-01',
      graphSha256: '0f'.repeat(32),
      trafficMode: 'STATIC',
      maxPoints: 60,
      shift: { startMinute: 540, endMinute: 1080 },
      shiftVersion: 1,
      serviceTime: { carMinutes: 10, footMinutes: 10 },
      serviceTimeVersion: 1,
      depots: [DEPOT],
      orders: [exactOrder],
      slots: [
        {
          slotIndex: 1,
          courierUserId: null,
          vehicleType: 'CAR',
          capacityOrders: 1,
          shiftStartMinute: 540,
          shiftEndMinute: 1080,
          startDepotId: DEPOT.id,
          endDepotId: DEPOT.id,
        },
      ],
      slotIds: ['slot-1'],
    });

    const late: VroomSolution = {
      code: 0,
      routes: [
        {
          vehicle: 1,
          steps: [
            { type: 'start', arrival: 540 * 60 },
            { type: 'job', id: 1, arrival: 900 * 60 },
            { type: 'end', arrival: 950 * 60 },
          ],
        },
      ],
      unassigned: [],
    };

    expect(() => parseSolution(built, late)).toThrowError(PlanContractError);

    // Приезд РАНЬШЕ точного времени нарушением не является: курьер подождёт,
    // а обслуживание начнётся в названную минуту. Но ожидание обязано быть
    // СООБЩЁННЫМ: молчание решателя доказательством не является.
    const early: VroomSolution = {
      code: 0,
      routes: [
        {
          vehicle: 1,
          steps: [
            { type: 'start', arrival: 540 * 60 },
            { type: 'job', id: 1, arrival: 800 * 60, waiting_time: 40 * 60 },
            { type: 'end', arrival: 860 * 60 },
          ],
        },
      ],
      unassigned: [],
    };

    expect(parseSolution(built, early).routes[0]?.stops).toHaveLength(1);
    // Наружу по-прежнему показывается физическое прибытие, а не начало
    // обслуживания: подменять одно другим значило бы врать в маршрутном листе.
    expect(parseSolution(built, early).routes[0]?.stops[0]?.arrivalMinute).toBe(800);
  });

  it('невыполнимое точное время возвращается неразмещённым заказом', () => {
    const built = buildInputSnapshot({
      deliveryDate: '2026-09-01',
      graphSha256: '0f'.repeat(32),
      trafficMode: 'STATIC',
      maxPoints: 60,
      shift: { startMinute: 540, endMinute: 1080 },
      shiftVersion: 1,
      serviceTime: { carMinutes: 10, footMinutes: 10 },
      serviceTimeVersion: 1,
      depots: [DEPOT],
      orders: [exactOrder],
      slots: [
        {
          slotIndex: 1,
          courierUserId: null,
          vehicleType: 'CAR',
          capacityOrders: 1,
          shiftStartMinute: 540,
          shiftEndMinute: 1080,
          startDepotId: DEPOT.id,
          endDepotId: DEPOT.id,
        },
      ],
      slotIds: ['slot-1'],
    });

    const solution: VroomSolution = { code: 0, routes: [], unassigned: [{ id: 1, type: 'job' }] };
    const plan = parseSolution(built, solution);

    expect(plan.unassignedOrderIds).toEqual(['order-exact']);
    expect(plan.routes).toHaveLength(0);
  });
});

describe('матрицы решателя', () => {
  it('недостижимая пара останавливает расчёт целиком', () => {
    const broken: SourceMatrix = {
      durationsSec: [
        [0, null],
        [10, 0],
      ],
      distancesM: [
        [0, 100],
        [100, 0],
      ],
    };

    expect(() => toSolverMatrix(broken, 2)).toThrowError(PlanContractError);
    try {
      toSolverMatrix(broken, 2);
    } catch (error) {
      expect((error as PlanContractError).code).toBe('MATRIX_UNREACHABLE_PAIR');
    }
  });

  it('дробные значения округляются ВВЕРХ: план не должен быть оптимистичнее правды', () => {
    const fractional: SourceMatrix = {
      durationsSec: [
        [0, 10.2],
        [10.9, 0],
      ],
      distancesM: [
        [0, 100.1],
        [100.9, 0],
      ],
    };

    const result = toSolverMatrix(fractional, 2);
    expect(result.durations[0]?.[1]).toBe(11);
    expect(result.durations[1]?.[0]).toBe(11);
    expect(result.distances[0]?.[1]).toBe(101);
  });

  it('матрица неверного размера отвергается', () => {
    expect(() => toSolverMatrix(fullMatrix(2, 10), 3)).toThrowError(PlanContractError);
  });

  it('отсутствие матрицы для использованного профиля — отказ', () => {
    expect(() => buildSolverRequest({ snapshot: snapshot(), matrices: {} })).toThrowError(
      PlanContractError,
    );
  });
});

describe('запрос к решателю', () => {
  it('содержит обе матрицы для каждого использованного профиля', () => {
    const built = snapshot();
    const twoProfiles: PlanInputSnapshot = {
      ...built,
      slots: [
        built.slots[0]!,
        { ...built.slots[0]!, slotId: 'slot-2', slotIndex: 2, vehicleType: 'FOOT' },
      ],
    };

    const size = twoProfiles.points.length;
    const request = buildSolverRequest({
      snapshot: twoProfiles,
      matrices: { CAR: fullMatrix(size, 60), FOOT: fullMatrix(size, 600) },
    });

    expect(Object.keys(request.matrices).sort()).toEqual(['car', 'foot']);
    for (const matrix of Object.values(request.matrices)) {
      expect(matrix.durations).toHaveLength(size);
      expect(matrix.distances).toHaveLength(size);
    }
  });

  it('несёт только индексы: ни координат, ни адресов, ни номеров заказов', () => {
    const built = snapshot();
    const request = buildSolverRequest({
      snapshot: built,
      matrices: { CAR: fullMatrix(built.points.length, 60) },
    });

    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain('order-a');
    expect(serialized).not.toContain('slot-1');
    expect(serialized).not.toContain('55.7');
    expect(serialized).not.toContain('depot-1');
    expect(serialized).not.toContain('location"');
    expect(serialized).not.toContain('description');

    expect(request.jobs[0]).toMatchObject({ id: 1, location_index: expect.any(Number) });
    expect(request.vehicles[0]).toMatchObject({ start_index: 0, end_index: 0 });
    // Геометрия не запрашивается.
    expect(serialized).not.toContain('geometry');
  });

  it('время обслуживания задаётся по типу машины, а запасное значение — максимум из них', () => {
    const built = snapshot();
    const request = buildSolverRequest({
      snapshot: built,
      matrices: { CAR: fullMatrix(built.points.length, 60) },
    });

    expect(request.jobs[0]?.service_per_type).toEqual({ CAR: 600, FOOT: 900 });
    // Запасное значение консервативно: решатель, не знающий service_per_type,
    // получит бо́льшую длительность, а не нулевую.
    expect(request.jobs[0]?.service).toBe(900);
    expect(request.vehicles[0]?.type).toBe('CAR');
  });

  it('интервал доставки превращается в жёсткое окно, его отсутствие — нет', () => {
    const built = snapshot();
    const request = buildSolverRequest({
      snapshot: built,
      matrices: { CAR: fullMatrix(built.points.length, 60) },
    });

    expect(request.jobs[0]?.time_windows).toBeUndefined();
    expect(request.jobs[1]?.time_windows).toEqual([[600 * 60, 720 * 60]]);
    expect(request.vehicles[0]?.time_window).toEqual([540 * 60, 1080 * 60]);
  });

  it('вместимость выражена в заказах: одна единица на заказ', () => {
    const built = snapshot();
    const request = buildSolverRequest({
      snapshot: built,
      matrices: { CAR: fullMatrix(built.points.length, 60) },
    });

    expect(request.jobs.every((job) => job.delivery.length === 1 && job.delivery[0] === 1)).toBe(
      true,
    );
    expect(request.vehicles[0]?.capacity).toEqual([2]);
  });
});

describe('граница клиента решателя', () => {
  it('отвергает адрес, координату и описание в запросе', () => {
    expect(() => assertNumericRequest({ jobs: [{ id: 1, description: 'Иванов' }] })).toThrowError(
      VroomError,
    );
    expect(() => assertNumericRequest({ jobs: [{ id: 1, location: [37.6, 55.7] }] })).toThrowError(
      VroomError,
    );
    expect(() => assertNumericRequest({ vehicles: [{ id: 1, name: 'Пётр' }] })).toThrowError(
      VroomError,
    );
  });

  it('произвольная строка в значении недопустима', () => {
    expect(() => assertNumericRequest({ jobs: [{ id: 1, note: 'Москва' }] })).toThrowError(
      VroomError,
    );
  });

  it('профиль и тип машины — единственные допустимые строки', () => {
    expect(() =>
      assertNumericRequest({ vehicles: [{ id: 1, profile: 'car', type: 'CAR' }] }),
    ).not.toThrow();
  });
});

describe('проверка ответа решателя', () => {
  const built = snapshot();

  function solution(overrides: Partial<VroomSolution> = {}): VroomSolution {
    return {
      code: 0,
      routes: [
        {
          vehicle: 1,
          steps: [
            { type: 'start', arrival: 540 * 60 },
            { type: 'job', id: 1, arrival: 560 * 60 },
            { type: 'job', id: 2, arrival: 620 * 60 },
            { type: 'end', arrival: 700 * 60 },
          ],
        },
      ],
      unassigned: [],
      ...overrides,
    };
  }

  it('разбирает корректный ответ в план', () => {
    const plan = parseSolution(built, solution());
    expect(plan.routes).toHaveLength(1);
    expect(plan.routes[0]?.stops.map((stop) => stop.orderId)).toEqual(['order-a', 'order-b']);
    expect(plan.routes[0]?.stops[0]?.position).toBe(1);
    expect(plan.unassignedOrderIds).toEqual([]);
  });

  it('пропущенный заказ ломает разбиение', () => {
    const partial = solution({
      routes: [
        {
          vehicle: 1,
          steps: [
            { type: 'start', arrival: 540 * 60 },
            { type: 'job', id: 1, arrival: 560 * 60 },
            { type: 'end', arrival: 700 * 60 },
          ],
        },
      ],
    });

    expect(() => parseSolution(built, partial)).toThrowError(PlanContractError);
  });

  it('повторённый заказ ломает разбиение', () => {
    const duplicated = solution({
      routes: [
        {
          vehicle: 1,
          steps: [
            { type: 'start', arrival: 540 * 60 },
            { type: 'job', id: 1, arrival: 560 * 60 },
            { type: 'job', id: 1, arrival: 600 * 60 },
            { type: 'job', id: 2, arrival: 620 * 60 },
            { type: 'end', arrival: 700 * 60 },
          ],
        },
      ],
    });

    expect(() => parseSolution(built, duplicated)).toThrowError(PlanContractError);
  });

  it('заказ и в маршруте, и в неразмещённых — тоже нарушение разбиения', () => {
    const both = solution({ unassigned: [{ id: 1 }] });
    expect(() => parseSolution(built, both)).toThrowError(PlanContractError);
  });

  it('неизвестный идентификатор заказа отвергается', () => {
    expect(() => parseSolution(built, solution({ unassigned: [{ id: 99 }] }))).toThrowError(
      PlanContractError,
    );
  });

  it('неизвестная машина отвергается', () => {
    const alien = solution({
      routes: [
        {
          vehicle: 42,
          steps: [
            { type: 'start' },
            { type: 'job', id: 1 },
            { type: 'job', id: 2 },
            { type: 'end' },
          ],
        },
      ],
    });
    expect(() => parseSolution(built, alien)).toThrowError(PlanContractError);
  });

  it('маршрут, начинающийся не на складе, отвергается', () => {
    const headless = solution({
      routes: [
        {
          vehicle: 1,
          steps: [{ type: 'job', id: 1 }, { type: 'job', id: 2 }, { type: 'end' }],
        },
      ],
    });
    expect(() => parseSolution(built, headless)).toThrowError(PlanContractError);
  });

  it('превышение вместимости отвергается', () => {
    const tight: PlanInputSnapshot = {
      ...built,
      slots: [{ ...built.slots[0]!, capacityOrders: 1 }],
    };
    expect(() => parseSolution(tight, solution())).toThrowError(PlanContractError);
  });

  it('выход за пределы смены отвергается', () => {
    const late = solution({
      routes: [
        {
          vehicle: 1,
          steps: [
            { type: 'start', arrival: 540 * 60 },
            { type: 'job', id: 1, arrival: 560 * 60 },
            { type: 'job', id: 2, arrival: 620 * 60 },
            { type: 'end', arrival: 1200 * 60 },
          ],
        },
      ],
    });
    expect(() => parseSolution(built, late)).toThrowError(PlanContractError);
  });

  it('нарушенный интервал доставки отвергается', () => {
    // Второй заказ имеет окно 10:00–12:00; прибытие в 12:30 — нарушение обещания.
    const late = solution({
      routes: [
        {
          vehicle: 1,
          steps: [
            { type: 'start', arrival: 540 * 60 },
            { type: 'job', id: 1, arrival: 560 * 60 },
            { type: 'job', id: 2, arrival: 750 * 60 },
            { type: 'end', arrival: 800 * 60 },
          ],
        },
      ],
    });
    expect(() => parseSolution(built, late)).toThrowError(PlanContractError);
  });

  it('шаг неизвестного рода отвергается: перерывов мы не запрашивали', () => {
    const withBreak = solution({
      routes: [
        {
          vehicle: 1,
          steps: [
            { type: 'start', arrival: 540 * 60 },
            { type: 'job', id: 1, arrival: 560 * 60 },
            { type: 'break', id: 7, arrival: 600 * 60 },
            { type: 'job', id: 2, arrival: 620 * 60 },
            { type: 'end', arrival: 700 * 60 },
          ],
        },
      ],
    });
    expect(() => parseSolution(built, withBreak)).toThrowError(PlanContractError);
  });

  it('неразмещённые заказы возвращаются как есть, а не прячутся', () => {
    const partial = solution({
      routes: [
        {
          vehicle: 1,
          steps: [
            { type: 'start', arrival: 540 * 60 },
            { type: 'job', id: 1, arrival: 560 * 60 },
            { type: 'end', arrival: 700 * 60 },
          ],
        },
      ],
      unassigned: [{ id: 2, type: 'job' }],
    });

    const plan = parseSolution(built, partial);
    expect(plan.unassignedOrderIds).toEqual(['order-b']);
    expect(plan.routes[0]?.stops).toHaveLength(1);
  });
});

/**
 * Окно ограничивает НАЧАЛО ОБСЛУЖИВАНИЯ, а не прибытие.
 *
 * Проверка появилась после первого настоящего операционного прогона пилота.
 * Решатель, граф и матрицы были исправны, все 3600 элементов посчитались, —
 * и четыре сценария из шести отказали, потому что контрольный слой сравнивал
 * сырой `arrival` с началом окна. Приехать раньше и подождать — нормальная
 * работа курьера, а не нарушение обещания.
 *
 * Обратная ошибка не менее опасна: посчитать `Math.max(arrival, start)`
 * значило бы объявить окно соблюдённым, ни разу не прочитав, ждал ли решатель
 * на самом деле. Поэтому доказательством служит сумма `arrival + waiting_time`,
 * и считается она в секундах.
 */
describe('начало обслуживания внутри окна', () => {
  const windowed = order('order-win', 55_780_000, 37_660_000, { start: 600, end: 720 });

  function withWindow(): PlanInputSnapshot {
    return buildInputSnapshot({
      deliveryDate: '2026-09-01',
      graphSha256: '0f'.repeat(32),
      trafficMode: 'STATIC',
      maxPoints: 60,
      shift: { startMinute: 540, endMinute: 1080 },
      shiftVersion: 1,
      serviceTime: { carMinutes: 10, footMinutes: 10 },
      serviceTimeVersion: 1,
      depots: [DEPOT],
      orders: [windowed],
      slots: [
        {
          slotIndex: 1,
          courierUserId: null,
          vehicleType: 'CAR',
          capacityOrders: 1,
          shiftStartMinute: 540,
          shiftEndMinute: 1080,
          startDepotId: DEPOT.id,
          endDepotId: DEPOT.id,
        },
      ],
      slotIds: ['slot-1'],
    });
  }

  /** Ответ решателя с одной остановкой: секунды задаются явно. */
  function answer(step: Record<string, unknown>): VroomSolution {
    return {
      code: 0,
      routes: [
        {
          vehicle: 1,
          steps: [
            { type: 'start', arrival: 540 * 60 },
            { type: 'job', id: 1, ...step },
            { type: 'end', arrival: 1000 * 60 },
          ],
        },
      ],
      unassigned: [],
    } as unknown as VroomSolution;
  }

  it('раннее прибытие с достаточным ожиданием принимается', () => {
    const plan = parseSolution(withWindow(), answer({ arrival: 540 * 60, waiting_time: 60 * 60 }));

    expect(plan.routes[0]?.stops).toHaveLength(1);
    expect(plan.routes[0]?.stops[0]?.arrivalMinute).toBe(540);
  });

  it('раннее прибытие БЕЗ сообщённого ожидания отвергается', () => {
    // Именно здесь проходит граница между доказательством и доверием: без
    // `waiting_time` мы не знаем, дождался решатель или начал раньше срока.
    expect(() => parseSolution(withWindow(), answer({ arrival: 540 * 60 }))).toThrowError(
      PlanContractError,
    );
  });

  it('раннее прибытие с НЕДОСТАТОЧНЫМ ожиданием отвергается', () => {
    expect(() =>
      parseSolution(withWindow(), answer({ arrival: 540 * 60, waiting_time: 59 * 60 })),
    ).toThrowError(PlanContractError);
  });

  it('прибытие внутри окна с нулевым ожиданием принимается', () => {
    const plan = parseSolution(withWindow(), answer({ arrival: 660 * 60, waiting_time: 0 }));

    expect(plan.routes[0]?.stops[0]?.arrivalMinute).toBe(660);
  });

  it('ожидание, уводящее начало обслуживания за конец окна, отвергается', () => {
    // Прибытие внутри окна, но обслуживание начинается после его конца.
    // Проверять один `arrival` этого не заметило бы.
    expect(() =>
      parseSolution(withWindow(), answer({ arrival: 700 * 60, waiting_time: 30 * 60 })),
    ).toThrowError(PlanContractError);
  });

  it('нарушение короче минуты не прячется округлением', () => {
    // Округление до минуты вернуло бы ровно границу окна и объявило бы
    // ответ корректным. Поэтому сравнение идёт в секундах.
    expect(() =>
      parseSolution(withWindow(), answer({ arrival: 720 * 60 + 20, waiting_time: 0 })),
    ).toThrowError(PlanContractError);

    // Ровно граница — принимается: обе стороны окна включительны.
    expect(
      parseSolution(withWindow(), answer({ arrival: 720 * 60, waiting_time: 0 })).routes[0]?.stops,
    ).toHaveLength(1);
  });

  it('заказ с окном без сообщённого прибытия недоказуем и отвергается', () => {
    expect(() => parseSolution(withWindow(), answer({}))).toThrowError(PlanContractError);
  });

  it('заказ без окна ожидания не требует', () => {
    const free = buildInputSnapshot({
      deliveryDate: '2026-09-01',
      graphSha256: '0f'.repeat(32),
      trafficMode: 'STATIC',
      maxPoints: 60,
      shift: { startMinute: 540, endMinute: 1080 },
      shiftVersion: 1,
      serviceTime: { carMinutes: 10, footMinutes: 10 },
      serviceTimeVersion: 1,
      depots: [DEPOT],
      orders: [order('order-free', 55_790_000, 37_670_000)],
      slots: [
        {
          slotIndex: 1,
          courierUserId: null,
          vehicleType: 'CAR',
          capacityOrders: 1,
          shiftStartMinute: 540,
          shiftEndMinute: 1080,
          startDepotId: DEPOT.id,
          endDepotId: DEPOT.id,
        },
      ],
      slotIds: ['slot-1'],
    });

    // Обещания нет — доказывать нечего. Старые сохранённые ответы без поля
    // ломать из-за этого неправильно.
    expect(parseSolution(free, answer({ arrival: 600 * 60 })).routes[0]?.stops).toHaveLength(1);
  });

  it('точное окно [t,t]: ожидание ровно до t принимается, раньше и позже — нет', () => {
    const exact = buildInputSnapshot({
      deliveryDate: '2026-09-01',
      graphSha256: '0f'.repeat(32),
      trafficMode: 'STATIC',
      maxPoints: 60,
      shift: { startMinute: 540, endMinute: 1080 },
      shiftVersion: 1,
      serviceTime: { carMinutes: 10, footMinutes: 10 },
      serviceTimeVersion: 1,
      depots: [DEPOT],
      orders: [order('order-exact', 55_780_000, 37_660_000, { start: 840 })],
      slots: [
        {
          slotIndex: 1,
          courierUserId: null,
          vehicleType: 'CAR',
          capacityOrders: 1,
          shiftStartMinute: 540,
          shiftEndMinute: 1080,
          startDepotId: DEPOT.id,
          endDepotId: DEPOT.id,
        },
      ],
      slotIds: ['slot-1'],
    });

    expect(
      parseSolution(exact, answer({ arrival: 800 * 60, waiting_time: 40 * 60 })).routes[0]?.stops,
    ).toHaveLength(1);
    // Начало на секунду раньше названной минуты — уже не «ровно в 14:00».
    expect(() =>
      parseSolution(exact, answer({ arrival: 800 * 60, waiting_time: 40 * 60 - 1 })),
    ).toThrowError(PlanContractError);
    expect(() =>
      parseSolution(exact, answer({ arrival: 800 * 60, waiting_time: 40 * 60 + 1 })),
    ).toThrowError(PlanContractError);
  });
});

describe('клиент решателя сохраняет ожидание', () => {
  /** Клиент с подставленным ответом: сеть не нужна, схема та же самая. */
  function clientReturning(body: unknown): VroomClient {
    return new VroomClient({
      baseUrl: 'http://solver.invalid',
      fetch: (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof globalThis.fetch,
    });
  }

  function solutionWith(waiting: unknown): unknown {
    return {
      code: 0,
      routes: [
        {
          vehicle: 1,
          steps: [
            { type: 'start', arrival: 0 },
            { type: 'job', id: 1, arrival: 60, waiting_time: waiting },
            { type: 'end', arrival: 120 },
          ],
        },
      ],
      unassigned: [],
    };
  }

  const problem = {
    jobs: [{ id: 1, location_index: 1, service: 0, delivery: [1] }],
    vehicles: [
      {
        id: 1,
        profile: 'car' as const,
        type: 'CAR' as const,
        start_index: 0,
        end_index: 0,
        capacity: [1],
        time_window: [0, 86_400] as [number, number],
      },
    ],
    matrices: {
      car: {
        durations: [
          [0, 10],
          [10, 0],
        ],
        distances: [
          [0, 10],
          [10, 0],
        ],
      },
    },
  } as unknown as Parameters<VroomClient['solve']>[0];

  it('доносит ожидание до продукта, а не отбрасывает его', async () => {
    // Пока поле терялось в схеме, доказать начало обслуживания было нечем.
    const solved = await clientReturning(solutionWith(120)).solve(problem);

    expect(solved.routes[0]?.steps[1]?.waiting_time).toBe(120);
  });

  it('отвергает отрицательное, нечисловое и бесконечное ожидание', async () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '60', null]) {
      await expect(
        clientReturning(solutionWith(bad)).solve(problem),
        `ожидание ${String(bad)}`,
      ).rejects.toThrowError(VroomError);
    }
  });

  it('нулевое ожидание — обычное значение, а не отсутствие', async () => {
    const solved = await clientReturning(solutionWith(0)).solve(problem);

    expect(solved.routes[0]?.steps[1]?.waiting_time).toBe(0);
  });
});
