/**
 * Граница записи нагрузочного пилота — доказательство поведением.
 *
 * Про пилот легко написать «он ничего не пишет в базу», и это было бы неправдой:
 * штатный путь расчёта намеренно проходит через продуктовый кэш матриц
 * и обновляет технический статус маршрутизатора. Обещание в комментарии такую
 * разницу не ловит, поэтому здесь проверяется факт.
 *
 * Прогон выполняется на НАСТОЯЩЕЙ базе тем же `computeMatrix` и той же
 * проверкой графа, что и операторская команда. Снимаются счётчики всех таблиц
 * до и после; измениться вправе ровно две технические области —
 * `RouteMatrixCache` и `IntegrationStatus`. Любая продуктовая запись ломает
 * тест, и это единственный способ заметить её раньше сервера.
 *
 * Valhalla и VROOM здесь закреплённые: сеть в тесте означала бы, что граница
 * записи зависит от чужого сервиса.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { pino } from 'pino';
import { PrismaClient } from '../../generated/prisma/client.js';
import { resolveTestDatabaseUrl } from '../../platform/testing/test-database.js';
import { computeMatrix, newMatrixWorkerId, type MatrixDeps } from '../geo/matrix/service.js';
import { createGraphGate } from '../geo/routing-status.js';
import type { VroomRequest, VroomSolution } from '../integrations/vroom/client.js';
import { buildSyntheticDay, runPilotScenario } from './pilot.js';

let db: PrismaClient;
const logger = pino({ level: 'silent' });

/** Отпечаток графа теста: у него собственный, чтобы не делить кэш с соседями. */
const GRAPH = `${'c'.repeat(63)}1`;

beforeAll(() => {
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: resolveTestDatabaseUrl() }) });
});

afterAll(async () => {
  await db?.$disconnect();
});

/**
 * Ищет след пилота в продуктовых таблицах.
 *
 * Простое сравнение счётчиков «до и после» здесь не годится: база критических
 * тестов общая, наборы идут параллельно, и чужая запись выглядела бы как наша.
 * Поэтому проверка АТРИБУТИРУЕМАЯ — ищутся именно синтетические имена пилота
 * (`pilot-order-*`, `pilot-slot-*`, `pilot-depot`). Такой поиск не зависит
 * от соседей вовсе.
 *
 * Список таблиц и колонок задан явно, а не выведен из `information_schema`:
 * перебор всей схемы означал бы сотню полных сканов под параллельными
 * наборами — тест стал бы плохим соседом и ронял бы чужие проверки по времени.
 */
const PRODUCT_PLACES: { table: string; column: string }[] = [
  { table: 'DeliveryOrder', column: 'externalName' },
  { table: 'DeliveryOrder', column: 'address' },
  { table: 'DeliveryRoute', column: 'number' },
  { table: 'StorageCell', column: 'code' },
  { table: 'AuditLog', column: 'entityId' },
  { table: 'RealtimeEvent', column: 'payload' },
  { table: 'RoutePlanRun', column: 'id' },
  { table: 'SystemSetting', column: 'key' },
  { table: 'User', column: 'fullName' },
  { table: 'Depot', column: 'name' },
];

async function rowsCarryingPilotMarks(): Promise<string[]> {
  const found: string[] = [];
  for (const { table, column } of PRODUCT_PLACES) {
    const rows = await db.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM "${table}" WHERE "${column}"::text LIKE '%pilot-%'`,
    );
    if (Number(rows[0]?.count ?? 0) > 0) {
      found.push(`${table}.${column}`);
    }
  }
  return found;
}

describe('граница записи пилота', () => {
  it('успешный прогон меняет только кэш матриц и технический статус', async () => {
    const day = buildSyntheticDay({ orderCount: 8, seed: 4242, graphSha256: GRAPH });
    // Ключ кэша уникален для прогона: база критических тестов общая, и попадание
    // в чужую строку превратило бы холодный расчёт в тёплый.
    day.points[0] = {
      latMicro:
        55_700_000 + (Number.parseInt(randomUUID().replace(/-/g, '').slice(0, 8), 16) % 1_000_000),
      lonMicro: 37_500_000,
    };

    const matrixDeps: MatrixDeps = {
      db,
      logger,
      valhalla: {
        matrix: async (points) => {
          const size = points.length;
          return Array.from({ length: size }, (_, from) =>
            Array.from({ length: size }, (_, to) => ({
              timeSeconds: Math.abs(from - to) * 60,
              distanceMeters: Math.abs(from - to) * 800,
            })),
          );
        },
        // Проверка графа — тот же общий механизм, что и в операторской команде.
        verifyGraph: createGraphGate({
          db,
          client: {
            configured: true,
            status: async () => ({
              tilesetLastModified: 1_786_365_674,
              version: '3.8.3',
              hasTiles: true,
            }),
          } as never,
          expectedGraphSha256: GRAPH,
        }).verifyGraph,
      },
      graphSha256: GRAPH,
      maxPoints: 60,
      ttlSeconds: 3600,
      workerId: newMatrixWorkerId(),
    };

    const solve = async (request: VroomRequest): Promise<VroomSolution> => {
      const jobs = request.jobs.map((job) => job.id);
      const vehicle = request.vehicles[0]!;
      const pointOf = new Map(request.jobs.map((job) => [job.id, job.location_index]));
      const matrix = request.matrices['car']!;

      let distance = 0;
      let previous = vehicle.start_index;
      for (const job of jobs) {
        const next = pointOf.get(job)!;
        distance += matrix.distances[previous]![next]!;
        previous = next;
      }
      distance += matrix.distances[previous]![vehicle.end_index]!;

      let second = vehicle.time_window[0];
      const windowOf = new Map(request.jobs.map((job) => [job.id, job.time_windows?.[0] ?? null]));

      return {
        code: 0,
        routes: [
          {
            vehicle: vehicle.id,
            distance,
            duration: jobs.length * 600,
            service: jobs.length * request.jobs[0]!.service_per_type!.CAR,
            steps: [
              { type: 'start', arrival: second },
              ...jobs.map((job) => {
                const window = windowOf.get(job) ?? null;
                second = window === null ? second + 20 * 60 : window[0];
                return { type: 'job', id: job, arrival: second };
              }),
              { type: 'end', arrival: second + 20 * 60 },
            ],
          },
        ],
        unassigned: [],
      } as unknown as VroomSolution;
    };

    const report = await runPilotScenario(
      {
        matrix: (points, vehicleType) =>
          computeMatrix(matrixDeps, { points, profile: vehicleType }),
        solve,
      },
      { label: 'граница записи', orderCount: 8, vehicleType: 'CAR' },
      day,
    );

    expect(report.failure).toBeNull();
    expect(report.gatesPassed).toBe(true);

    // Ни одна таблица схемы, кроме кэша матриц, не несёт следа пилота.
    // Появись здесь заказ, маршрут, план, запись аудита или событие — пилот
    // начал бы менять то, что измеряет.
    expect(await rowsCarryingPilotMarks()).toEqual([]);

    // Разрешённая область записи существует и заполнена именно этим прогоном.
    const cacheRows = await db.routeMatrixCache.count({ where: { graphSha256: GRAPH } });
    expect(cacheRows).toBeGreaterThan(0);

    // Вторая разрешённая область: технический статус маршрутизатора.
    const routingStatus = await db.integrationStatus.findUnique({
      where: { provider: 'valhalla' },
    });
    expect(routingStatus?.state).toBe('OK');
  });

  it('кэш матриц действительно используется: второй расчёт не идёт в маршрутизатор', async () => {
    let valhallaCalls = 0;
    const graphGate = createGraphGate({
      db,
      client: {
        configured: true,
        status: async () => ({
          tilesetLastModified: 1_786_365_674,
          version: '3.8.3',
          hasTiles: true,
        }),
      } as never,
      expectedGraphSha256: GRAPH,
    });

    const matrixDeps: MatrixDeps = {
      db,
      logger,
      valhalla: {
        matrix: async (points) => {
          valhallaCalls += 1;
          const size = points.length;
          return Array.from({ length: size }, (_, from) =>
            Array.from({ length: size }, (_, to) => ({
              timeSeconds: Math.abs(from - to) * 60,
              distanceMeters: Math.abs(from - to) * 800,
            })),
          );
        },
        verifyGraph: graphGate.verifyGraph,
      },
      graphSha256: GRAPH,
      maxPoints: 60,
      ttlSeconds: 3600,
      workerId: newMatrixWorkerId(),
    };

    const unique = randomUUID().slice(0, 8);
    const points = [
      { lat: 55.75 + Number.parseInt(unique.slice(0, 4), 16) / 1e9, lon: 37.61 },
      { lat: 55.76, lon: 37.62 },
      { lat: 55.77, lon: 37.63 },
    ];

    const cold = await computeMatrix(matrixDeps, { points, profile: 'CAR' });
    const warm = await computeMatrix(matrixDeps, { points, profile: 'CAR' });

    expect(cold.cached).toBe(false);
    expect(warm.cached).toBe(true);
    // Тёплый путь и есть то, ради чего пилот не обходит кэш: второй расчёт
    // не тратит ни одного обращения к маршрутизатору.
    expect(valhallaCalls).toBe(1);
  });
});
