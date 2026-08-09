/**
 * Критические проверки маршрутизатора и кэша матриц.
 *
 * Настоящих обращений к Valhalla здесь нет: `fetch` и клиент подменяются.
 * Проверяется то, нарушение чего опасно: в маршрутизатор уходят только
 * координаты; направленная матрица не выдаётся за симметричную; недостижимая
 * пара не превращается в ноль; ключ кэша меняется вместе с профилем, порядком
 * точек и ревизией графа; два экземпляра не считают одно и то же; сетевой
 * вызов не выполняется внутри транзакции.
 */

import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from '../../auth/testing/harness.js';
import { COSTING, ValhallaClient, ValhallaError } from '../../integrations/valhalla/client.js';
import type { LatLon, MatrixElement } from '../../integrations/valhalla/client.js';
import { createGraphGate, probeRouting, VALHALLA_PROVIDER } from '../routing-status.js';
import {
  computeMatrix,
  CURRENT_TRAFFIC_MODE,
  matrixCacheKey,
  newMatrixWorkerId,
  normalize,
  type MatrixDeps,
} from './service.js';
import { cleanupExpiredMatrixCache } from '../../../platform/maintenance.js';

let ctx: TestContext;
const logger = pino({ level: 'silent' });

const POINTS: LatLon[] = [
  { lat: 55.751244, lon: 37.618423 },
  { lat: 55.76, lon: 37.6 },
  { lat: 55.77, lon: 37.64 },
];

const GRAPH = 'graph-2026-08-01';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

/** Ответ Valhalla в официальной форме: строчно-упорядоченная матрица. */
function rows(size: number, value: { time: number | null; distance: number | null }): unknown {
  const result: unknown[][] = [];
  for (let from = 0; from < size; from += 1) {
    const row: unknown[] = [];
    for (let to = 0; to < size; to += 1) {
      row.push({
        from_index: from,
        to_index: to,
        time: from === to ? 0 : value.time,
        distance: from === to ? 0 : value.distance,
      });
    }
    result.push(row);
  }
  return result;
}

function client(fetchImpl: typeof globalThis.fetch): ValhallaClient {
  return new ValhallaClient({ baseUrl: 'http://valhalla.internal:8002', fetch: fetchImpl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface FakeRouter {
  calls: number;
  matrix: (points: readonly LatLon[], costing: string) => Promise<(MatrixElement | null)[][]>;
  verifyGraph: () => Promise<void>;
}

function fakeRouter(
  handler?: (points: readonly LatLon[], costing: string) => (MatrixElement | null)[][],
): FakeRouter {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    // Граф подтверждён: отдельные проверки отказа живут ниже, в своём блоке.
    async verifyGraph() {
      return undefined;
    },
    async matrix(points, costing) {
      state.calls += 1;
      if (handler !== undefined) {
        return handler(points, costing);
      }
      return points.map((_, from) =>
        points.map((__, to) =>
          from === to
            ? { timeSeconds: 0, distanceMeters: 0 }
            : { timeSeconds: 100 + from * 10 + to, distanceMeters: 1000 + from * 100 + to },
        ),
      );
    },
  };
}

function matrixDeps(router: FakeRouter, overrides: Partial<MatrixDeps> = {}): MatrixDeps {
  return {
    db: ctx.db,
    logger,
    valhalla: router,
    graphRevision: GRAPH,
    workerId: `test-${randomUUID()}`,
    waitAttempts: 2,
    waitDelayMs: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('клиент маршрутизатора', () => {
  it('в запрос уходят только координаты, профиль и единицы', async () => {
    let captured: { url: string; body: unknown } | null = null;

    const instance = client(async (url, init) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return jsonResponse({ sources_to_targets: rows(2, { time: 60, distance: 1.5 }) });
    });

    await instance.matrix(POINTS.slice(0, 2), COSTING.CAR);

    const call = captured as unknown as { url: string; body: Record<string, unknown> };
    expect(call.url).toBe('http://valhalla.internal:8002/sources_to_targets');
    expect(call.body['costing']).toBe('auto');
    expect(call.body['units']).toBe('km');

    // Ни адреса, ни получателя, ни номера заказа: маршрутизатору они не нужны,
    // а попав в чужой лог, остались бы там навсегда.
    const text = JSON.stringify(call.body);
    expect(Object.keys(call.body).sort()).toEqual(['costing', 'sources', 'targets', 'units']);
    expect(text).not.toContain('address');
    expect(text).not.toContain('recipient');
    expect(text).not.toContain('order');

    for (const location of call.body['sources'] as Record<string, unknown>[]) {
      expect(Object.keys(location).sort()).toEqual(['lat', 'lon']);
    }
  });

  it('профили CAR и FOOT переводятся в auto и pedestrian', async () => {
    const seen: string[] = [];
    const instance = client(async (_url, init) => {
      seen.push(String((JSON.parse(String(init?.body)) as { costing: string }).costing));
      return jsonResponse({ sources_to_targets: rows(2, { time: 60, distance: 1.5 }) });
    });

    await instance.matrix(POINTS.slice(0, 2), COSTING.CAR);
    await instance.matrix(POINTS.slice(0, 2), COSTING.FOOT);

    expect(seen).toEqual(['auto', 'pedestrian']);
  });

  it('километры ответа переводятся в целые метры', async () => {
    const instance = client(async () =>
      jsonResponse({ sources_to_targets: rows(2, { time: 61.4, distance: 1.5 }) }),
    );

    const matrix = await instance.matrix(POINTS.slice(0, 2), COSTING.CAR);
    expect(matrix[0]?.[1]).toEqual({ timeSeconds: 61, distanceMeters: 1500 });
  });

  it('недостижимая пара приходит как null и остаётся null', async () => {
    const instance = client(async () =>
      jsonResponse({ sources_to_targets: rows(2, { time: null, distance: null }) }),
    );

    const matrix = await instance.matrix(POINTS.slice(0, 2), COSTING.CAR);
    expect(matrix[0]?.[1]).toEqual({ timeSeconds: null, distanceMeters: null });
  });

  it('плоский ответ без вложенных строк тоже разбирается по индексам', async () => {
    const flat = [
      { from_index: 0, to_index: 0, time: 0, distance: 0 },
      { from_index: 0, to_index: 1, time: 60, distance: 1 },
      { from_index: 1, to_index: 0, time: 90, distance: 2 },
      { from_index: 1, to_index: 1, time: 0, distance: 0 },
    ];
    const instance = client(async () => jsonResponse({ sources_to_targets: flat }));

    const matrix = await instance.matrix(POINTS.slice(0, 2), COSTING.CAR);
    expect(matrix[0]?.[1]?.timeSeconds).toBe(60);
    expect(matrix[1]?.[0]?.timeSeconds).toBe(90);
  });

  const BAD: { title: string; body: unknown }[] = [
    { title: 'не тот ключ', body: { matrix: [] } },
    { title: 'элемент без индексов', body: { sources_to_targets: [[{ time: 1, distance: 1 }]] } },
    {
      title: 'индекс за пределами матрицы',
      body: { sources_to_targets: [[{ from_index: 0, to_index: 9, time: 1, distance: 1 }]] },
    },
    {
      title: 'отрицательное время',
      body: {
        sources_to_targets: [
          [
            { from_index: 0, to_index: 0, time: 0, distance: 0 },
            { from_index: 0, to_index: 1, time: -5, distance: 1 },
            { from_index: 1, to_index: 0, time: 5, distance: 1 },
            { from_index: 1, to_index: 1, time: 0, distance: 0 },
          ],
        ],
      },
    },
    {
      title: 'неполная матрица',
      body: { sources_to_targets: [[{ from_index: 0, to_index: 0, time: 0, distance: 0 }]] },
    },
  ];

  for (const testCase of BAD) {
    it(`некорректный ответ отвергается: ${testCase.title}`, async () => {
      const instance = client(async () => jsonResponse(testCase.body));
      await expect(instance.matrix(POINTS.slice(0, 2), COSTING.CAR)).rejects.toBeInstanceOf(
        ValhallaError,
      );
    });
  }

  it('таймаут, 4xx и 5xx различаются кодами и не содержат координат', async () => {
    const timeout = client(async () => {
      throw new Error(`timeout http://valhalla.internal:8002 lat=55.75 lon=37.61`);
    });
    const error = await timeout.matrix(POINTS.slice(0, 2), COSTING.CAR).catch((e: unknown) => e);
    expect((error as ValhallaError).code).toBe('TRANSPORT_ERROR');
    expect((error as ValhallaError).message).not.toContain('55.75');

    const bad = client(async () => new Response('', { status: 400 }));
    await expect(bad.matrix(POINTS.slice(0, 2), COSTING.CAR)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    const server = client(async () => new Response('', { status: 503 }));
    await expect(server.matrix(POINTS.slice(0, 2), COSTING.CAR)).rejects.toMatchObject({
      code: 'SERVER_ERROR',
    });
  });

  it('ненастроенный клиент не выполняет запросов', async () => {
    let calls = 0;
    const instance = new ValhallaClient({
      baseUrl: null,
      fetch: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });

    expect(instance.configured).toBe(false);
    await expect(instance.matrix(POINTS, COSTING.CAR)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(calls).toBe(0);
  });
});

describe('состояние маршрутизатора', () => {
  it('ненастроенный сервис не влияет на готовность приложения', async () => {
    const ready = await ctx.app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);

    await probeRouting(ctx.db, new ValhallaClient({ baseUrl: null }), null);

    const after = await ctx.app.inject({ method: 'GET', url: '/ready' });
    expect(after.statusCode).toBe(200);

    const status = await ctx.db.integrationStatus.findUnique({
      where: { provider: VALHALLA_PROVIDER },
    });
    expect(status?.state).toBe('NOT_CONFIGURED');
  });

  it('несовпадение ревизии графа — это отказ, а не мелочь', async () => {
    const instance = client(async () =>
      jsonResponse({ version: '3.8.3', tileset_last_modified: 1_700_000_000 }),
    );

    const result = await probeRouting(ctx.db, instance, 'другая-ревизия');

    expect(result.state).toBe('ERROR');
    expect(result.revisionMatches).toBe(false);

    const status = await ctx.db.integrationStatus.findUniqueOrThrow({
      where: { provider: VALHALLA_PROVIDER },
    });
    expect(status.state).toBe('ERROR');
    expect(JSON.stringify(status.details)).toContain('graph-revision-mismatch');
  });

  it('совпадение ревизии переводит интеграцию в OK', async () => {
    const instance = client(async () =>
      jsonResponse({ version: '3.8.3', tileset_last_modified: 1_700_000_000 }),
    );

    const result = await probeRouting(ctx.db, instance, '1700000000');
    expect(result.state).toBe('OK');
    expect(result.revisionMatches).toBe(true);

    const status = await ctx.db.integrationStatus.findUniqueOrThrow({
      where: { provider: VALHALLA_PROVIDER },
    });
    expect(JSON.stringify(status.details)).not.toContain('valhalla.internal');
  });
});

describe('матрица', () => {
  it('направленная, размером N×N, с нулевой диагональю', async () => {
    const router = fakeRouter();
    const result = await computeMatrix(matrixDeps(router), { points: POINTS, profile: 'CAR' });

    expect(result.durationsSec).toHaveLength(3);
    for (const row of result.durationsSec) {
      expect(row).toHaveLength(3);
    }

    expect(result.durationsSec[0]?.[0]).toBe(0);
    expect(result.durationsSec[1]?.[1]).toBe(0);
    expect(result.distancesM[2]?.[2]).toBe(0);

    // Симметричной матрица не является: односторонние улицы и развороты
    // делают путь «туда» и «обратно» разным.
    expect(result.durationsSec[0]?.[1]).not.toBe(result.durationsSec[1]?.[0]);
    expect(result.trafficMode).toBe(CURRENT_TRAFFIC_MODE);
    expect(result.trafficMode).toBe('STATIC');
  });

  it('недостижимая пара остаётся null и не превращается в ноль', () => {
    const raw: (MatrixElement | null)[][] = [
      [
        { timeSeconds: 0, distanceMeters: 0 },
        { timeSeconds: null, distanceMeters: null },
      ],
      [
        { timeSeconds: 120, distanceMeters: 3000 },
        { timeSeconds: 0, distanceMeters: 0 },
      ],
    ];

    const { durationsSec, distancesM } = normalize(raw, 2);
    expect(durationsSec[0]?.[1]).toBeNull();
    expect(distancesM[0]?.[1]).toBeNull();
    expect(durationsSec[1]?.[0]).toBe(120);
  });

  it('слишком много точек отклоняется с понятной ошибкой', async () => {
    const router = fakeRouter();
    const many = Array.from({ length: 5 }, (_, index) => ({
      lat: 55.7 + index / 1000,
      lon: 37.6,
    }));

    await expect(
      computeMatrix(matrixDeps(router, { maxPoints: 4 }), { points: many, profile: 'CAR' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(router.calls).toBe(0);
  });

  it('без ревизии графа расчёт не начинается', async () => {
    const router = fakeRouter();
    await expect(
      computeMatrix(matrixDeps(router, { graphRevision: null }), {
        points: POINTS,
        profile: 'CAR',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(router.calls).toBe(0);
  });
});

describe('кэш матриц', () => {
  it('повторный запрос не обращается к маршрутизатору', async () => {
    const points = uniquePoints();
    const router = fakeRouter();
    const deps = matrixDeps(router);

    const first = await computeMatrix(deps, { points, profile: 'CAR' });
    const second = await computeMatrix(deps, { points, profile: 'CAR' });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(router.calls).toBe(1);
    expect(second.durationsSec).toEqual(first.durationsSec);
  });

  it('порядок точек, профиль и ревизия графа дают разные ключи', () => {
    const base = { graphRevision: GRAPH, profile: 'CAR' as const, trafficMode: 'STATIC' as const };

    const key = matrixCacheKey({ ...base, points: POINTS });
    const reordered = matrixCacheKey({ ...base, points: [...POINTS].reverse() });
    const otherProfile = matrixCacheKey({ ...base, profile: 'FOOT', points: POINTS });
    const otherGraph = matrixCacheKey({
      ...base,
      graphRevision: 'graph-2026-09-01',
      points: POINTS,
    });
    const otherTraffic = matrixCacheKey({ ...base, trafficMode: 'NONE', points: POINTS });

    expect(new Set([key, reordered, otherProfile, otherGraph, otherTraffic]).size).toBe(5);
    // Тот же набор в том же порядке — тот же ключ.
    expect(matrixCacheKey({ ...base, points: [...POINTS] })).toBe(key);
  });

  it('смена ревизии графа не переиспользует старый результат', async () => {
    const points = uniquePoints();
    const router = fakeRouter();

    await computeMatrix(matrixDeps(router), { points, profile: 'CAR' });
    expect(router.calls).toBe(1);

    await computeMatrix(matrixDeps(router, { graphRevision: 'graph-2026-12-31' }), {
      points,
      profile: 'CAR',
    });
    expect(router.calls).toBe(2);
  });

  it('смена профиля не переиспользует автомобильный результат', async () => {
    const points = uniquePoints();
    const router = fakeRouter();
    const deps = matrixDeps(router);

    await computeMatrix(deps, { points, profile: 'CAR' });
    await computeMatrix(deps, { points, profile: 'FOOT' });

    expect(router.calls).toBe(2);
  });

  it('ошибка не сохраняется как успех', async () => {
    const points = uniquePoints();
    const failing: FakeRouter = {
      calls: 0,
      verifyGraph: async () => undefined,
      matrix: async () => {
        throw new ValhallaError('SERVER_ERROR', 500);
      },
    };

    await expect(
      computeMatrix(matrixDeps(failing), { points, profile: 'CAR' }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

    const keyHash = matrixCacheKey({
      graphRevision: GRAPH,
      profile: 'CAR',
      trafficMode: CURRENT_TRAFFIC_MODE,
      points,
    });
    const row = await ctx.db.routeMatrixCache.findUniqueOrThrow({ where: { keyHash } });
    expect(row.status).toBe('FAILED');
    expect(row.durationsSec).toBeNull();
    expect(row.lastErrorCode).toBe('SERVER_ERROR');

    // Следующая попытка считает заново, а не выдаёт отказ за результат.
    const working = fakeRouter();
    const result = await computeMatrix(matrixDeps(working), { points, profile: 'CAR' });
    expect(result.cached).toBe(false);
    expect(working.calls).toBe(1);
  });

  it('два экземпляра не считают один ключ одновременно', async () => {
    const points = uniquePoints();
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;

    const slow = (): FakeRouter => ({
      calls: 0,
      verifyGraph: async () => undefined,
      matrix: async (input) => {
        calls += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 120));
        concurrent -= 1;
        return input.map((_, from) =>
          input.map((__, to) =>
            from === to
              ? { timeSeconds: 0, distanceMeters: 0 }
              : { timeSeconds: 60, distanceMeters: 1000 },
          ),
        );
      },
    });

    // Терпение ожидающего заведомо больше расчёта: проверяется single-flight,
    // а не скорость машины, на которой идёт весь набор тестов сразу.
    const patient = { waitAttempts: 100, waitDelayMs: 50 };

    const [first, second] = await Promise.all([
      computeMatrix(matrixDeps(slow(), patient), { points, profile: 'CAR' }),
      computeMatrix(matrixDeps(slow(), patient), { points, profile: 'CAR' }),
    ]);

    // Ровно один расчёт: второй дождался чужого результата.
    expect(calls).toBe(1);
    expect(maxConcurrent).toBe(1);
    expect(first.durationsSec).toEqual(second.durationsSec);
    expect([first.cached, second.cached].filter(Boolean)).toHaveLength(1);
  });

  it('во время расчёта строка кэша не заблокирована транзакцией', async () => {
    const points = uniquePoints();
    let updatedDuringRequest = false;

    const router: FakeRouter = {
      calls: 0,
      verifyGraph: async () => undefined,
      matrix: async (input) => {
        // Короткий lock_timeout: если бы расчёт шёл внутри транзакции,
        // этот запрос не дождался бы и упал.
        await ctx.db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
          await tx.$executeRaw`UPDATE "RouteMatrixCache" SET "updatedAt" = now() WHERE "status" = 'PENDING'`;
        });
        updatedDuringRequest = true;
        return input.map((_, from) =>
          input.map((__, to) =>
            from === to
              ? { timeSeconds: 0, distanceMeters: 0 }
              : { timeSeconds: 60, distanceMeters: 1000 },
          ),
        );
      },
    };

    await computeMatrix(matrixDeps(router), { points, profile: 'CAR' });
    expect(updatedDuringRequest).toBe(true);
  });

  it('брошенный расчёт перехватывается по истечении аренды', async () => {
    const points = uniquePoints();
    const keyHash = matrixCacheKey({
      graphRevision: GRAPH,
      profile: 'CAR',
      trafficMode: CURRENT_TRAFFIC_MODE,
      points,
    });

    // Процесс взял ключ и умер: аренда осталась в прошлом.
    await ctx.db.routeMatrixCache.create({
      data: {
        keyHash,
        graphRevision: GRAPH,
        profile: 'CAR',
        trafficMode: CURRENT_TRAFFIC_MODE,
        pointCount: points.length,
        status: 'PENDING',
        lockedAt: new Date(Date.now() - 10 * 60 * 1000),
        lockedBy: 'умерший-процесс',
      },
    });

    const router = fakeRouter();
    const result = await computeMatrix(matrixDeps(router), { points, profile: 'CAR' });

    expect(router.calls).toBe(1);
    expect(result.cached).toBe(false);

    const row = await ctx.db.routeMatrixCache.findUniqueOrThrow({ where: { keyHash } });
    expect(row.status).toBe('READY');
    expect(row.lockedBy).toBeNull();
  });

  it('просроченные записи удаляются фоновой очисткой', async () => {
    const points = uniquePoints();
    const router = fakeRouter();
    await computeMatrix(matrixDeps(router, { ttlSeconds: 60 }), { points, profile: 'CAR' });

    const keyHash = matrixCacheKey({
      graphRevision: GRAPH,
      profile: 'CAR',
      trafficMode: CURRENT_TRAFFIC_MODE,
      points,
    });

    await ctx.db.routeMatrixCache.update({
      where: { keyHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const removed = await cleanupExpiredMatrixCache({ db: ctx.db, logger });
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await ctx.db.routeMatrixCache.findUnique({ where: { keyHash } })).toBeNull();
  });

  it('просроченный результат заново считается, а не отдаётся', async () => {
    const points = uniquePoints();
    const router = fakeRouter();
    const deps = matrixDeps(router, { ttlSeconds: 60 });

    await computeMatrix(deps, { points, profile: 'CAR' });

    const keyHash = matrixCacheKey({
      graphRevision: GRAPH,
      profile: 'CAR',
      trafficMode: CURRENT_TRAFFIC_MODE,
      points,
    });
    await ctx.db.routeMatrixCache.update({
      where: { keyHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const again = await computeMatrix(deps, { points, profile: 'CAR' });
    expect(again.cached).toBe(false);
    expect(router.calls).toBe(2);
  });

  it('в кэше нет ни координат отдельным снимком, ни персональных данных', async () => {
    const points = uniquePoints();
    await computeMatrix(matrixDeps(fakeRouter()), { points, profile: 'CAR' });

    const rowsInCache = await ctx.db.routeMatrixCache.findMany({ take: 50 });
    const text = JSON.stringify(rowsInCache);

    // Хранится хеш ключа, а не сами координаты: кэш не должен становиться
    // второй копией геоданных заказов.
    expect(text).not.toContain('"lat"');
    expect(text).not.toContain('"lon"');
    expect(text).not.toContain('55.751244');
    for (const row of rowsInCache) {
      expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('строгая проверка ответа матрицы', () => {
  it('повтор одной пары и пропуск другой не проходят по количеству', async () => {
    // Количество элементов совпадает с N², но пара (1,0) пришла дважды,
    // а (0,1) не пришла вовсе. Счётчик такого не замечает — замечает
    // проверка занятости ячейки.
    const broken = [
      { from_index: 0, to_index: 0, time: 0, distance: 0 },
      { from_index: 1, to_index: 0, time: 90, distance: 2 },
      { from_index: 1, to_index: 0, time: 95, distance: 2.1 },
      { from_index: 1, to_index: 1, time: 0, distance: 0 },
    ];
    const instance = client(async () => jsonResponse({ sources_to_targets: broken }));

    await expect(instance.matrix(POINTS.slice(0, 2), COSTING.CAR)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });

  it('время без расстояния и расстояние без времени отвергаются', async () => {
    const cases = [
      { time: null, distance: 1.5 },
      { time: 60, distance: null },
    ];

    for (const value of cases) {
      const body = {
        sources_to_targets: [
          { from_index: 0, to_index: 0, time: 0, distance: 0 },
          { from_index: 0, to_index: 1, ...value },
          { from_index: 1, to_index: 0, time: 60, distance: 1.5 },
          { from_index: 1, to_index: 1, time: 0, distance: 0 },
        ],
      };
      const instance = client(async () => jsonResponse(body));

      await expect(
        instance.matrix(POINTS.slice(0, 2), COSTING.CAR),
        JSON.stringify(value),
      ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    }
  });

  it('отсутствие полей времени и расстояния не считается недостижимостью', async () => {
    // Отсутствие поля — это не «недостижимо», а «сервис ответил не тем».
    // Молчаливое превращение одного в другое вычеркнуло бы существующий
    // маршрут из расчёта, и планировщик построил бы объезд без него.
    const variants: { title: string; element: Record<string, unknown> }[] = [
      { title: 'нет обоих полей', element: {} },
      { title: 'нет расстояния', element: { time: 60 } },
      { title: 'нет времени', element: { distance: 1.5 } },
      { title: 'нет времени при null расстоянии', element: { distance: null } },
      { title: 'нет расстояния при null времени', element: { time: null } },
    ];

    for (const variant of variants) {
      const body = {
        sources_to_targets: [
          { from_index: 0, to_index: 0, time: 0, distance: 0 },
          { from_index: 0, to_index: 1, ...variant.element },
          { from_index: 1, to_index: 0, time: 60, distance: 1.5 },
          { from_index: 1, to_index: 1, time: 0, distance: 0 },
        ],
      };
      const instance = client(async () => jsonResponse(body));

      await expect(
        instance.matrix(POINTS.slice(0, 2), COSTING.CAR),
        variant.title,
      ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    }
  });

  it('пустой элемент не проходит даже вместе с полными соседями', async () => {
    const instance = client(async () =>
      jsonResponse({
        sources_to_targets: [
          [
            { from_index: 0, to_index: 0 },
            { from_index: 0, to_index: 1, time: 60, distance: 1 },
            { from_index: 1, to_index: 0, time: 60, distance: 1 },
            { from_index: 1, to_index: 1, time: 0, distance: 0 },
          ],
        ],
      }),
    );

    await expect(instance.matrix(POINTS.slice(0, 2), COSTING.CAR)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });

  it('согласованная недостижимость принимается', async () => {
    const body = {
      sources_to_targets: [
        { from_index: 0, to_index: 0, time: 0, distance: 0 },
        { from_index: 0, to_index: 1, time: null, distance: null },
        { from_index: 1, to_index: 0, time: 60, distance: 1.5 },
        { from_index: 1, to_index: 1, time: 0, distance: 0 },
      ],
    };
    const instance = client(async () => jsonResponse(body));

    const matrix = await instance.matrix(POINTS.slice(0, 2), COSTING.CAR);
    expect(matrix[0]?.[1]).toEqual({ timeSeconds: null, distanceMeters: null });
  });
});

describe('расчёт запрещён без подтверждённого графа', () => {
  it('неподтверждённый граф не даёт дойти до маршрутизатора', async () => {
    const router = fakeRouter();
    router.verifyGraph = async () => {
      throw new Error('граф не подтверждён');
    };

    await expect(
      computeMatrix(matrixDeps(router), { points: uniquePoints(), profile: 'CAR' }),
    ).rejects.toThrow('граф не подтверждён');

    // Ни одного обращения: запрет физический, а не индикаторный.
    expect(router.calls).toBe(0);
  });

  it('ворота графа отказывают при отсутствующей ревизии в ответе сервиса', async () => {
    const instance = client(async () => jsonResponse({ version: '3.8.3' }));
    const gate = createGraphGate({ db: ctx.db, client: instance, expectedRevision: GRAPH });

    await expect(gate.verifyGraph()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

    const status = await ctx.db.integrationStatus.findUniqueOrThrow({
      where: { provider: VALHALLA_PROVIDER },
    });
    expect(status.state).toBe('ERROR');
    expect(JSON.stringify(status.details)).toContain('graph-revision-unknown');
  });

  it('ворота графа отказывают при несовпадении ревизии', async () => {
    const instance = client(async () =>
      jsonResponse({ version: '3.8.3', tileset_last_modified: 1_700_000_000 }),
    );
    const gate = createGraphGate({ db: ctx.db, client: instance, expectedRevision: 'другая' });

    await expect(gate.verifyGraph()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('подтверждение выполняется один раз на процесс', async () => {
    let calls = 0;
    const instance = client(async () => {
      calls += 1;
      return jsonResponse({ version: '3.8.3', tileset_last_modified: 1_700_000_000 });
    });
    const gate = createGraphGate({ db: ctx.db, client: instance, expectedRevision: '1700000000' });

    await gate.verifyGraph();
    await gate.verifyGraph();
    await gate.verifyGraph();

    // Подтверждать граф на каждую матрицу — значит добавлять сетевой запрос
    // к каждому расчёту.
    expect(calls).toBe(1);
  });

  it('неудача не запоминается: следующая попытка проверяет снова', async () => {
    let calls = 0;
    const instance = client(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('сервис ещё не поднялся');
      }
      return jsonResponse({ version: '3.8.3', tileset_last_modified: 1_700_000_000 });
    });
    const gate = createGraphGate({ db: ctx.db, client: instance, expectedRevision: '1700000000' });

    await expect(gate.verifyGraph()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(gate.verifyGraph()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe('владелец аренды расчёта', () => {
  it('потерявший аренду не выдаёт свой результат за сохранённый', async () => {
    const points = uniquePoints();
    const keyHash = matrixCacheKey({
      graphRevision: GRAPH,
      profile: 'CAR',
      trafficMode: CURRENT_TRAFFIC_MODE,
      points,
    });

    const router: FakeRouter = {
      calls: 0,
      verifyGraph: async () => undefined,
      matrix: async (input) => {
        // Пока идёт расчёт, аренду перехватил другой экземпляр.
        await ctx.db.routeMatrixCache.updateMany({
          where: { keyHash },
          data: { lockedBy: 'другой-экземпляр' },
        });
        return input.map((_, from) =>
          input.map((__, to) =>
            from === to
              ? { timeSeconds: 0, distanceMeters: 0 }
              : { timeSeconds: 60, distanceMeters: 1000 },
          ),
        );
      },
    };

    // Результат не записан, поэтому и возвращать его как успешный нельзя:
    // вызывающая сторона считала бы, что он лежит в кэше.
    await expect(
      computeMatrix(matrixDeps(router), { points, profile: 'CAR' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const row = await ctx.db.routeMatrixCache.findUniqueOrThrow({ where: { keyHash } });
    expect(row.status).toBe('PENDING');
    expect(row.durationsSec).toBeNull();
  });

  it('владелец аренды уникален у каждого процесса', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newMatrixWorkerId()));
    expect(ids.size).toBe(50);
  });
});

/** Уникальный набор точек на каждый тест: база общая для всех проверок. */
function uniquePoints(): LatLon[] {
  const seed = Number(process.hrtime.bigint() % 100_000n);
  return [
    { lat: 55.7 + seed / 1_000_000, lon: 37.6 },
    { lat: 55.75 + seed / 1_000_000, lon: 37.62 },
    { lat: 55.78 + seed / 1_000_000, lon: 37.64 },
  ];
}
