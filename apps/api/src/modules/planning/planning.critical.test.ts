/**
 * Критические проверки планирования маршрутов.
 *
 * Настоящих обращений к Valhalla и VROOM здесь нет: оба подменяются. Проверяется
 * то, нарушение чего опасно:
 *
 *  - расчёт не создаёт ни одного черновика — только неизменяемое превью;
 *  - снимок ВХОДА появляется до матрицы и решателя и не меняется никогда;
 *  - день не может считаться дважды одновременно, а готовое превью
 *    не вытесняется молча;
 *  - брошенная аренда перехватывается не больше трёх раз, а обычная ошибка
 *    не повторяется вовсе;
 *  - применение перепроверяет вход под блокировкой, при расхождении фиксирует
 *    EXPIRED ОТДЕЛЬНОЙ УСПЕШНОЙ транзакцией и не создаёт ни одного черновика;
 *  - повторное применение идемпотентно;
 *  - наружу не уходят адреса, координаты и номера заказов.
 */

import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { TEST_SECRETS } from '../../platform/testing/secrets.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import type { Role } from '@fl/shared';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { applyOrderSnapshot } from '../integrations/moysklad/import-service.js';
import { mapOrder, type OrderSnapshot } from '../integrations/moysklad/mapper.js';
import type { MatrixElement, LatLon } from '../integrations/valhalla/client.js';
import { newMatrixWorkerId, type MatrixDeps } from '../geo/matrix/service.js';
import type { VroomRequest, VroomSolution } from '../integrations/vroom/client.js';
import { VroomError } from '../integrations/vroom/client.js';
import { createDepot, findDefaultDepot } from '../depots/service.js';
import { readShift, saveShift, SETTING_KEYS } from '../settings/service.js';
import { applyPlan } from './apply.js';
import { runPlanningOnce } from './runner.js';
import {
  expirePreview,
  MAX_RECOVERY_ATTEMPTS,
  newPlanningWorkerId,
  requestPlan,
  type PlanningDeps,
} from './service.js';
import type { PlanInputSnapshot } from './input.js';

let ctx: TestContext;
const logger = pino({ level: 'silent' });
const CONTEXT = { ip: null, userAgent: null };
const IDS = MOYSKLAD_IDS;
const GRAPH = '0f'.repeat(32);
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;
const NOW = new Date('2026-08-10T09:00:00.000Z');

/** Даты подобраны так, чтобы не пересекаться с данными других файлов. */
const DAY = '2026-12-01';
const DAY_TWO = '2026-12-02';
const DAY_THREE = '2026-12-03';
const DAY_FOUR = '2026-12-04';
const DAY_FIVE = '2026-12-05';
const DAY_SIX = '2026-12-06';
const DAY_SEVEN = '2026-12-07';
const DAY_EIGHT = '2026-12-08';

const SHIFT = { startMinute: 9 * 60, endMinute: 21 * 60 };

let depotId = '';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

// --- Обвязка ---------------------------------------------------------------

async function actorWith(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return { userId: user.id, roles, familyId: randomUUID() } as AuthenticatedActor;
}

async function tokenFor(roles: Role[]): Promise<string> {
  const { hashSecretCode } = await import('../auth/crypto.js');
  const { login } = await import('../auth/service.js');
  const pin = '1234';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles, pinHash });
  const session = await login(
    ctx,
    { phone: user.phone, pin },
    { ip: null, userAgent: 'vitest', deviceLabel: null },
  );
  return session.accessToken;
}

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    name: `P-${process.hrtime.bigint() % 1_000_000n}`,
    updated: '2026-08-10 10:00:00.000',
    shipmentAddress: 'Москва, плановый адрес',
    deliveryPlannedMoment: `${DAY} 12:00:00.000`,
    sum: 100000,
    payedSum: 0,
    store: { meta: { href: href('store', IDS.store) } },
    state: {
      meta: { href: href('state', '22222222-2222-4222-8222-222222222222') },
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Новый',
      stateType: 'Regular',
    },
    attributes: [
      {
        id: IDS.deliveryMethodAttribute,
        value: {
          name: 'Доставка',
          meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
        },
      },
      { id: IDS.intervalAttribute, value: 'с 12:00 по 18:00' },
      { id: IDS.recipientAttribute, value: 'Получатель Плановый' },
    ],
    ...overrides,
  };
}

function snapshotOf(overrides: Record<string, unknown> = {}): OrderSnapshot {
  return mapOrder(source(overrides) as never, IDS).snapshot;
}

interface SeedOptions {
  day?: string;
  interval?: string | null;
  latMicro?: number;
  lonMicro?: number;
  /** Оставить заказ без подтверждённой точки. */
  withoutPoint?: boolean;
}

/** Импортирует заказ и ставит ему подтверждённую точку. */
async function seedOrder(options: SeedOptions = {}): Promise<string> {
  const day = options.day ?? DAY;
  const attributes = [
    {
      id: IDS.deliveryMethodAttribute,
      value: {
        name: 'Доставка',
        meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
      },
    },
    ...(options.interval === null
      ? []
      : [{ id: IDS.intervalAttribute, value: options.interval ?? 'с 12:00 по 18:00' }]),
    { id: IDS.recipientAttribute, value: 'Получатель Плановый' },
  ];

  const snapshot = snapshotOf({
    deliveryPlannedMoment: `${day} 12:00:00.000`,
    attributes,
  });

  await ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, NOW));
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { externalId: snapshot.externalId },
    select: { id: true },
  });

  if (options.withoutPoint !== true) {
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: {
        geoState: 'RESOLVED',
        geoSource: 'SYNTHETIC',
        geoPrecision: 'EXACT_HOUSE',
        geoLatMicro: options.latMicro ?? 55_760_000,
        geoLonMicro: options.lonMicro ?? 37_600_000,
        geoResolvedAt: NOW,
      },
    });
  }

  return order.id;
}

/** Матрица считается подменённым маршрутизатором: все пары достижимы. */
function fakeMatrix(): MatrixDeps['valhalla'] {
  return {
    async verifyGraph() {
      return undefined;
    },
    async matrix(points: readonly LatLon[]): Promise<(MatrixElement | null)[][]> {
      return points.map((_, from) =>
        points.map((__, to) =>
          from === to
            ? { timeSeconds: 0, distanceMeters: 0 }
            : { timeSeconds: 60, distanceMeters: 1000 },
        ),
      );
    },
  };
}

interface FakeSolver {
  requests: VroomRequest[];
  solve: (request: VroomRequest) => Promise<VroomSolution>;
}

/**
 * Подменённый решатель.
 *
 * По умолчанию раскладывает все заказы в первую машину: проверяется не качество
 * оптимизации, а контракт вокруг неё.
 */
function fakeSolver(
  handler?: (request: VroomRequest) => VroomSolution | Promise<VroomSolution>,
): FakeSolver {
  const requests: VroomRequest[] = [];
  return {
    requests,
    async solve(request) {
      requests.push(request);
      if (handler !== undefined) {
        return handler(request);
      }
      const vehicle = request.vehicles[0];
      if (vehicle === undefined) {
        throw new Error('в запросе нет машин');
      }
      const at = vehicle.time_window[0];
      return {
        code: 0,
        summary: { routes: 1, unassigned: 0, duration: 120, service: 600, distance: 2000 },
        routes: [
          {
            vehicle: vehicle.id,
            steps: [
              { type: 'start', arrival: at },
              ...request.jobs.map((job) => ({ type: 'job', id: job.id, arrival: at })),
              { type: 'end', arrival: at },
            ],
            duration: 120,
            service: 600,
            distance: 2000,
          },
        ],
        unassigned: [],
      };
    },
  };
}

function planningDeps(options: {
  solver: FakeSolver;
  workerId?: string;
  now?: () => Date;
  leaseMs?: number;
}): PlanningDeps {
  return {
    db: ctx.db,
    logger,
    matrix: {
      db: ctx.db,
      logger,
      valhalla: fakeMatrix(),
      graphSha256: GRAPH,
      maxPoints: 60,
      workerId: newMatrixWorkerId(),
    },
    vroom: options.solver,
    verifySolver: async () => undefined,
    solverVersion: '1.15.0',
    workerId: options.workerId ?? newPlanningWorkerId(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
  };
}

/**
 * Завершает чужие незаконченные запуски.
 *
 * Файл работает в общей одноразовой базе, а исполнитель берёт ЛЮБОЙ запуск
 * из очереди. Без явной очистки проверка аренды поймала бы чужой запуск
 * и доказала бы совсем не то, что собиралась.
 */
async function clearQueue(): Promise<void> {
  await ctx.db.routePlanRun.updateMany({
    where: { state: { in: ['QUEUED', 'COMPUTING'] } },
    data: {
      state: 'EXPIRED',
      activeDateKey: null,
      lockedUntil: null,
      lockedBy: null,
      failureCode: 'TEST_CLEANUP',
    },
  });
}

const slot = (capacity = 10) => ({
  courierUserId: null,
  vehicleType: 'CAR' as const,
  capacityOrders: capacity,
});

// --- Подготовка окружения ---------------------------------------------------

describe('условия планирования', () => {
  it('без настроенной смены планирование отказывает и ничего не создаёт', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    // Смена снимается на время проверки: система, придумавшая рабочий день,
    // построила бы правдоподобный и неверный план.
    await ctx.db.systemSetting.deleteMany({ where: { key: SETTING_KEYS.shift } });

    const deps = planningDeps({ solver: fakeSolver() });
    await expect(
      requestPlan(deps, actor, { deliveryDate: DAY, slots: [slot()] }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'SHIFT_NOT_CONFIGURED' } });

    expect(
      await ctx.db.routePlanRun.count({ where: { deliveryDate: new Date(`${DAY}T00:00:00Z`) } }),
    ).toBe(0);

    // Настраиваем смену для остальных проверок.
    const admin = await actorWith(['ADMIN']);
    const current = await readShift(ctx.db);
    await saveShift(ctx.db, admin, {
      value: SHIFT,
      expectedVersion: current.version,
      ...CONTEXT,
    });
  });

  it('без склада по умолчанию планирование отказывает', async () => {
    const actor = await actorWith(['LOGISTICIAN']);

    const existing = await findDefaultDepot(ctx.db);
    if (existing !== null) {
      await ctx.db.$executeRawUnsafe(
        `UPDATE "Depot" SET "defaultKey" = NULL WHERE "id" = '${existing.id}'::uuid`,
      );
    }

    const deps = planningDeps({ solver: fakeSolver() });
    await expect(
      requestPlan(deps, actor, { deliveryDate: DAY, slots: [slot()] }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'DEPOT_NOT_CONFIGURED' } });

    // Возвращаем склад: остальные проверки без него бессмысленны.
    if (existing === null) {
      const admin = await actorWith(['ADMIN']);
      const created = await createDepot(
        ctx.db,
        admin,
        // Координаты намеренно отличаются от точек проверок матриц: кэш
        // ключуется набором точек, и совпадение фикстур вернуло бы чужой расчёт.
        { name: 'Склад планирования', address: 'Москва, склад', lat: 55.700111, lon: 37.500222 },
        CONTEXT,
      );
      depotId = created.id;
    } else {
      await ctx.db.$executeRawUnsafe(
        `UPDATE "Depot" SET "defaultKey" = 'default' WHERE "id" = '${existing.id}'::uuid`,
      );
      depotId = existing.id;
    }

    expect((await findDefaultDepot(ctx.db))?.id).toBe(depotId);
  });

  it('заказ без подтверждённой точки останавливает весь расчёт и назван поимённо', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    await seedOrder({ day: DAY_TWO });
    const blind = await seedOrder({ day: DAY_TWO, withoutPoint: true });

    const deps = planningDeps({ solver: fakeSolver() });
    await expect(
      requestPlan(deps, actor, { deliveryDate: DAY_TWO, slots: [slot()] }, CONTEXT),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { orderIds: expect.arrayContaining([blind]) },
    });
  });

  it('одно указанное время интервалом не считается: заказ ждёт ручного интервала', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    const exact = await seedOrder({ day: DAY_THREE, interval: 'к 14:00' });

    const deps = planningDeps({ solver: fakeSolver() });
    await expect(
      requestPlan(deps, actor, { deliveryDate: DAY_THREE, slots: [slot()] }, CONTEXT),
    ).rejects.toMatchObject({ details: { orderIds: [exact] } });

    // Логист задаёт интервал вручную — и расчёт становится возможным.
    await ctx.db.deliveryOrder.update({
      where: { id: exact },
      data: {
        manualIntervalStartMinute: 13 * 60,
        manualIntervalEndMinute: 15 * 60,
        manualIntervalSetAt: NOW,
      },
    });

    const created = await requestPlan(
      deps,
      actor,
      { deliveryDate: DAY_THREE, slots: [slot()] },
      CONTEXT,
    );
    expect(created.state).toBe('QUEUED');
  });
});

// --- Постановка и снимок входа ---------------------------------------------

describe('постановка запуска', () => {
  it('создаёт снимок входа ДО расчёта, и снимок неизменяем', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    await seedOrder({ day: DAY_FOUR, latMicro: 55_760_000, lonMicro: 37_600_000 });
    await seedOrder({ day: DAY_FOUR, latMicro: 55_770_000, lonMicro: 37_640_000 });

    const deps = planningDeps({ solver: fakeSolver() });
    const run = await requestPlan(
      deps,
      actor,
      { deliveryDate: DAY_FOUR, slots: [slot()] },
      CONTEXT,
    );

    const stored = await ctx.db.routePlanInputSnapshot.findUniqueOrThrow({
      where: { runId: run.id },
      select: { payload: true, payloadHash: true, id: true },
    });

    const snapshot = stored.payload as unknown as PlanInputSnapshot;
    expect(snapshot.orders).toHaveLength(2);
    expect(snapshot.slots[0]?.slotId).toMatch(/^[0-9a-f-]{36}$/);
    expect(snapshot.shift).toMatchObject(SHIFT);
    expect(snapshot.graphSha256).toBe(GRAPH);
    // Расчёта ещё не было: результата нет.
    expect(await ctx.db.routePlanResultSnapshot.count({ where: { runId: run.id } })).toBe(0);

    await expect(
      ctx.db.routePlanInputSnapshot.update({
        where: { id: stored.id },
        data: { payloadHash: 'x'.repeat(64) },
      }),
    ).rejects.toThrow();

    await expect(
      ctx.db.routePlanInputSnapshot.delete({ where: { id: stored.id } }),
    ).rejects.toThrow();
  });

  it('слоты машин после постановки неизменяемы', async () => {
    const run = await ctx.db.routePlanRun.findFirstOrThrow({
      where: { deliveryDate: new Date(`${DAY_FOUR}T00:00:00Z`) },
      select: { id: true },
    });
    const [first] = await ctx.db.routePlanVehicleSlot.findMany({ where: { runId: run.id } });

    await expect(
      ctx.db.routePlanVehicleSlot.update({
        where: { id: first?.id ?? '' },
        data: { capacityOrders: 999 },
      }),
    ).rejects.toThrow();

    await expect(
      ctx.db.routePlanVehicleSlot.delete({ where: { id: first?.id ?? '' } }),
    ).rejects.toThrow();
  });

  it('один курьер не может занять два слота одного запуска', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
    await seedOrder({ day: DAY_FIVE });

    const deps = planningDeps({ solver: fakeSolver() });
    await expect(
      requestPlan(
        deps,
        actor,
        {
          deliveryDate: DAY_FIVE,
          slots: [
            { ...slot(), courierUserId: courier.id },
            { ...slot(), courierUserId: courier.id },
          ],
        },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('день не может считаться дважды одновременно', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    const deps = planningDeps({ solver: fakeSolver() });

    await expect(
      requestPlan(deps, actor, { deliveryDate: DAY_FOUR, slots: [slot()] }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'PLAN_RUN_IN_PROGRESS' } });
  });

  it('предел размера задачи считается по уникальным точкам с учётом склада', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    // Два заказа по одному адресу: точек — две (склад и адрес), а не три.
    await seedOrder({ day: DAY_SIX, latMicro: 55_780_000, lonMicro: 37_650_000 });
    await seedOrder({ day: DAY_SIX, latMicro: 55_780_000, lonMicro: 37_650_000 });

    const tight = planningDeps({ solver: fakeSolver() });
    tight.matrix.maxPoints = 2;
    const run = await requestPlan(
      tight,
      actor,
      { deliveryDate: DAY_SIX, slots: [slot()] },
      CONTEXT,
    );

    const stored = await ctx.db.routePlanInputSnapshot.findUniqueOrThrow({
      where: { runId: run.id },
      select: { payload: true },
    });
    expect((stored.payload as unknown as PlanInputSnapshot).points).toHaveLength(2);

    await expirePreviewOrFail(run.id);

    // Третий адрес выводит день за предел, и день НЕ делится автоматически.
    await seedOrder({ day: DAY_SIX, latMicro: 55_790_000, lonMicro: 37_660_000 });
    await expect(
      requestPlan(tight, actor, { deliveryDate: DAY_SIX, slots: [slot()] }, CONTEXT),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

/** Освобождает день: запуски завершаются явно, а не сами по себе. */
async function expirePreviewOrFail(runId: string): Promise<void> {
  await ctx.db.routePlanRun.update({
    where: { id: runId },
    data: { state: 'EXPIRED', activeDateKey: null, failureCode: 'TEST_CLEANUP' },
  });
}

// --- Расчёт -----------------------------------------------------------------

describe('расчёт', () => {
  it('доводит запуск до превью и записывает неизменяемый снимок результата', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    const first = await seedOrder({ day: DAY_SEVEN, latMicro: 55_760_000, lonMicro: 37_600_000 });
    const second = await seedOrder({ day: DAY_SEVEN, latMicro: 55_770_000, lonMicro: 37_640_000 });

    const solver = fakeSolver();
    const deps = planningDeps({ solver });
    await clearQueue();
    const run = await requestPlan(
      deps,
      actor,
      { deliveryDate: DAY_SEVEN, slots: [slot()] },
      CONTEXT,
    );

    const pass = await runPlanningOnce(deps);
    expect(pass.runId).toBe(run.id);
    expect(pass.result?.state).toBe('PREVIEW');

    const stored = await ctx.db.routePlanResultSnapshot.findUniqueOrThrow({
      where: { runId: run.id },
      select: { id: true, request: true, response: true, plan: true, solverVersion: true },
    });

    expect(stored.solverVersion).toBe('1.15.0');

    // Запрос решателя сохранён и не содержит ни адресов, ни координат,
    // ни номеров заказов.
    const request = JSON.stringify(stored.request);
    expect(request).toContain('location_index');
    expect(request).toContain('start_index');
    expect(request).not.toContain(first);
    expect(request).not.toContain(second);
    expect(request).not.toContain('Москва');
    expect(request).not.toContain('Получатель');
    expect(request).not.toContain('55.7');
    expect(request).not.toContain('geometry');

    // Обе матрицы для использованного профиля.
    const sent = solver.requests[0];
    expect(Object.keys(sent?.matrices ?? {})).toEqual(['car']);
    expect(sent?.matrices['car']?.durations).toHaveLength(3);
    expect(sent?.matrices['car']?.distances).toHaveLength(3);

    // Черновиков по-прежнему ноль: превью данными не является.
    expect(await ctx.db.deliveryRoute.count({ where: { planRunId: run.id } })).toBe(0);

    await expect(
      ctx.db.routePlanResultSnapshot.update({
        where: { id: stored.id },
        data: { solverVersion: '9.9.9' },
      }),
    ).rejects.toThrow();
  });

  it('недостижимая пара останавливает расчёт целиком', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    await seedOrder({ day: DAY_EIGHT, latMicro: 55_700_000, lonMicro: 37_500_000 });
    await seedOrder({ day: DAY_EIGHT, latMicro: 55_710_000, lonMicro: 37_510_000 });

    const deps = planningDeps({ solver: fakeSolver() });
    deps.matrix.valhalla = {
      async verifyGraph() {
        return undefined;
      },
      async matrix(points: readonly LatLon[]) {
        // Одна пара недостижима: подставлять вместо неё большое число значило бы
        // выдумать дорогу, которой нет.
        return points.map((_, from) =>
          points.map((__, to) =>
            from === to
              ? { timeSeconds: 0, distanceMeters: 0 }
              : from === 0 && to === 1
                ? null
                : { timeSeconds: 60, distanceMeters: 1000 },
          ),
        );
      },
    };

    await clearQueue();
    const run = await requestPlan(
      deps,
      actor,
      { deliveryDate: DAY_EIGHT, slots: [slot()] },
      CONTEXT,
    );

    const pass = await runPlanningOnce(deps);
    expect(pass.runId).toBe(run.id);
    expect(pass.result?.state).toBe('FAILED');
    expect(pass.result?.failureCode).toBe('MATRIX_UNREACHABLE_PAIR');

    const stored = await ctx.db.routePlanRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { state: true, activeDateKey: true, failureCode: true },
    });
    // День освобождается: отказ не должен держать его навсегда.
    expect(stored.state).toBe('FAILED');
    expect(stored.activeDateKey).toBeNull();
  });

  it('обычная ошибка решателя не повторяется автоматически', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    const day = '2026-12-09';
    await seedOrder({ day, latMicro: 55_761_000, lonMicro: 37_601_000 });
    await seedOrder({ day, latMicro: 55_771_000, lonMicro: 37_641_000 });

    let calls = 0;
    const solver = fakeSolver(() => {
      calls += 1;
      throw new VroomError('SERVER_ERROR', 500);
    });
    const deps = planningDeps({ solver });

    await clearQueue();
    await requestPlan(deps, actor, { deliveryDate: day, slots: [slot()] }, CONTEXT);

    const first = await runPlanningOnce(deps);
    expect(first.result?.state).toBe('FAILED');

    // Следующий проход не находит работы: неудача повторов не порождает.
    const second = await runPlanningOnce(deps);
    expect(second.runId).toBeNull();
    expect(calls).toBe(1);
  });

  it('брошенная аренда перехватывается не больше трёх раз', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    const day = '2026-12-10';
    await seedOrder({ day, latMicro: 55_762_000, lonMicro: 37_602_000 });
    await seedOrder({ day, latMicro: 55_772_000, lonMicro: 37_642_000 });

    const owner = planningDeps({ solver: fakeSolver(), leaseMs: 60_000 });
    await clearQueue();
    const run = await requestPlan(owner, actor, { deliveryDate: day, slots: [slot()] }, CONTEXT);

    // Запуск «взят» умершим процессом: аренда есть, но она истекла.
    const expire = async (): Promise<void> => {
      await ctx.db.routePlanRun.update({
        where: { id: run.id },
        data: {
          state: 'COMPUTING',
          lockedBy: 'умерший процесс',
          lockedUntil: new Date(Date.now() - 60_000),
        },
      });
    };

    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt += 1) {
      await expire();
      const claimed = await claimOnly(owner);
      expect(claimed).toBe(run.id);
      const state = await ctx.db.routePlanRun.findUniqueOrThrow({
        where: { id: run.id },
        select: { recoveryAttempts: true },
      });
      expect(state.recoveryAttempts).toBe(attempt);
    }

    // Четвёртого перехвата не будет: запуск закрывается как исчерпавший попытки.
    await expire();
    const pass = await runPlanningOnce(owner);
    expect(pass.exhausted).toBe(1);
    expect(pass.runId).toBeNull();

    const finished = await ctx.db.routePlanRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { state: true, failureCode: true, activeDateKey: true },
    });
    expect(finished.state).toBe('FAILED');
    expect(finished.failureCode).toBe('RECOVERY_EXHAUSTED');
    expect(finished.activeDateKey).toBeNull();
  });

  it('живая чужая аренда не перехватывается', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    const day = '2026-12-11';
    await seedOrder({ day, latMicro: 55_763_000, lonMicro: 37_603_000 });
    await seedOrder({ day, latMicro: 55_773_000, lonMicro: 37_643_000 });

    const deps = planningDeps({ solver: fakeSolver() });
    await clearQueue();
    const run = await requestPlan(deps, actor, { deliveryDate: day, slots: [slot()] }, CONTEXT);

    await ctx.db.routePlanRun.update({
      where: { id: run.id },
      data: {
        state: 'COMPUTING',
        lockedBy: 'живой процесс',
        lockedUntil: new Date(Date.now() + 300_000),
      },
    });

    expect(await claimOnly(deps)).toBeNull();
  });
});

/** Берёт запуск в работу, не считая его: нужно для проверок аренды. */
async function claimOnly(deps: PlanningDeps): Promise<string | null> {
  const { claimRun } = await import('./service.js');
  const claimed = await claimRun(deps);
  return claimed?.id ?? null;
}

// --- Применение -------------------------------------------------------------

describe('применение превью', () => {
  const DAY_APPLY = '2026-12-12';
  let runId = '';
  let orderIds: string[] = [];

  it('создаёт черновики со складами, ссылкой на запуск и слот', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    orderIds = [
      await seedOrder({ day: DAY_APPLY, latMicro: 55_764_000, lonMicro: 37_604_000 }),
      await seedOrder({ day: DAY_APPLY, latMicro: 55_774_000, lonMicro: 37_644_000 }),
    ];

    const deps = planningDeps({ solver: fakeSolver() });
    await clearQueue();
    const run = await requestPlan(
      deps,
      actor,
      { deliveryDate: DAY_APPLY, slots: [slot()] },
      CONTEXT,
    );
    runId = run.id;

    await runPlanningOnce(deps);

    const preview = await ctx.db.routePlanRun.findUniqueOrThrow({
      where: { id: runId },
      select: { state: true, version: true },
    });
    expect(preview.state).toBe('PREVIEW');

    const applied = await applyPlan(
      { db: ctx.db },
      actor,
      runId,
      { expectedVersion: preview.version, allowUnassigned: false },
      CONTEXT,
    );

    expect(applied.routeIds).toHaveLength(1);
    expect(applied.alreadyApplied).toBe(false);

    const route = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: applied.routeIds[0] ?? '' },
      select: {
        startDepotId: true,
        endDepotId: true,
        planRunId: true,
        planVehicleSlotId: true,
        state: true,
        orders: { where: { removedAt: null }, select: { orderId: true, position: true } },
      },
    });

    expect(route.state).toBe('DRAFT');
    expect(route.startDepotId).toBe(depotId);
    expect(route.endDepotId).toBe(depotId);
    expect(route.planRunId).toBe(runId);
    expect(route.planVehicleSlotId).not.toBeNull();
    expect(route.orders.map((item) => item.orderId).sort()).toEqual([...orderIds].sort());
  });

  it('повторное применение идемпотентно: вторых черновиков нет', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    const before = await ctx.db.deliveryRoute.count({ where: { planRunId: runId } });

    const again = await applyPlan(
      { db: ctx.db },
      actor,
      runId,
      { expectedVersion: 1, allowUnassigned: false },
      CONTEXT,
    );

    expect(again.alreadyApplied).toBe(true);
    expect(again.routeIds).toHaveLength(before);
    expect(await ctx.db.deliveryRoute.count({ where: { planRunId: runId } })).toBe(before);
  });

  it('один слот не может породить два маршрута', async () => {
    const route = await ctx.db.deliveryRoute.findFirstOrThrow({
      where: { planRunId: runId },
      select: { planVehicleSlotId: true, deliveryDate: true, createdById: true },
    });

    await expect(
      ctx.db.deliveryRoute.create({
        data: {
          number: `R-DUP-${process.hrtime.bigint() % 1_000_000n}`,
          deliveryDate: route.deliveryDate,
          vehicleType: 'CAR',
          createdById: route.createdById,
          startDepotId: depotId,
          endDepotId: depotId,
          planRunId: runId,
          planVehicleSlotId: route.planVehicleSlotId,
        },
      }),
    ).rejects.toThrow();
  });

  it('автоматический маршрут без складов запрещён базой', async () => {
    const route = await ctx.db.deliveryRoute.findFirstOrThrow({
      where: { planRunId: runId },
      select: { deliveryDate: true, createdById: true },
    });

    await expect(
      ctx.db.$executeRawUnsafe(
        `INSERT INTO "DeliveryRoute" ("id","number","deliveryDate","state","vehicleType","createdById","version","createdAt","updatedAt","planRunId","planVehicleSlotId")
         VALUES (gen_random_uuid(), 'R-NO-DEPOT-${process.hrtime.bigint() % 1_000_000n}', DATE '${DAY_APPLY}', 'DRAFT', 'CAR', '${route.createdById}'::uuid, 1, now(), now(), '${runId}'::uuid, NULL)`,
      ),
    ).rejects.toThrow();
  });

  it('изменение заказа после расчёта фиксирует EXPIRED и отказывает без единого черновика', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    const day = '2026-12-13';
    const staleOrder = await seedOrder({ day, latMicro: 55_765_000, lonMicro: 37_605_000 });
    await seedOrder({ day, latMicro: 55_775_000, lonMicro: 37_645_000 });

    const deps = planningDeps({ solver: fakeSolver() });
    await clearQueue();
    const run = await requestPlan(deps, actor, { deliveryDate: day, slots: [slot()] }, CONTEXT);
    await runPlanningOnce(deps);

    const preview = await ctx.db.routePlanRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { version: true },
    });

    // Мир изменился: адрес заказа переразрешён другой точкой.
    await ctx.db.deliveryOrder.update({
      where: { id: staleOrder },
      data: { geoLatMicro: 55_700_000, geoGeneration: { increment: 1 } },
    });

    await expect(
      applyPlan(
        { db: ctx.db },
        actor,
        run.id,
        { expectedVersion: preview.version, allowUnassigned: false },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'PLAN_INPUT_STALE' } });

    // Переход в EXPIRED зафиксирован отдельной успешной транзакцией.
    const after = await ctx.db.routePlanRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { state: true, failureCode: true, activeDateKey: true },
    });
    expect(after.state).toBe('EXPIRED');
    expect(after.failureCode).toBe('INPUT_STALE');
    expect(after.activeDateKey).toBeNull();

    expect(await ctx.db.deliveryRoute.count({ where: { planRunId: run.id } })).toBe(0);
  });

  it('переезд склада после расчёта тоже снимает превью', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    const admin = await actorWith(['ADMIN']);
    const day = '2026-12-14';
    await seedOrder({ day, latMicro: 55_766_000, lonMicro: 37_606_000 });
    await seedOrder({ day, latMicro: 55_776_000, lonMicro: 37_646_000 });

    const deps = planningDeps({ solver: fakeSolver() });
    await clearQueue();
    const run = await requestPlan(deps, actor, { deliveryDate: day, slots: [slot()] }, CONTEXT);
    await runPlanningOnce(deps);

    const preview = await ctx.db.routePlanRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { version: true },
    });

    const { updateDepot } = await import('../depots/service.js');
    const depot = await findDefaultDepot(ctx.db);
    await updateDepot(
      ctx.db,
      admin,
      depot?.id ?? '',
      {
        name: depot?.name ?? 'Склад',
        address: depot?.address ?? 'Москва',
        lat: 55.8,
        lon: 37.7,
        expectedVersion: depot?.version ?? 1,
      },
      CONTEXT,
    );

    await expect(
      applyPlan(
        { db: ctx.db },
        actor,
        run.id,
        { expectedVersion: preview.version, allowUnassigned: false },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'PLAN_INPUT_STALE' } });

    expect(await ctx.db.deliveryRoute.count({ where: { planRunId: run.id } })).toBe(0);
  });

  it('изменение смены после расчёта снимает превью', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    const admin = await actorWith(['ADMIN']);
    const day = '2026-12-15';
    await seedOrder({ day, latMicro: 55_767_000, lonMicro: 37_607_000 });
    await seedOrder({ day, latMicro: 55_777_000, lonMicro: 37_647_000 });

    const deps = planningDeps({ solver: fakeSolver() });
    await clearQueue();
    const run = await requestPlan(deps, actor, { deliveryDate: day, slots: [slot()] }, CONTEXT);
    await runPlanningOnce(deps);

    const preview = await ctx.db.routePlanRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { version: true, result: { select: { plan: true } } },
    });
    const planBefore = JSON.stringify(preview.result?.plan);

    const shift = await readShift(ctx.db);
    await saveShift(ctx.db, admin, {
      value: { startMinute: 8 * 60, endMinute: 20 * 60 },
      expectedVersion: shift.version,
      ...CONTEXT,
    });

    // Само превью при этом не изменилось: оно неизменяемо.
    const preserved = await ctx.db.routePlanResultSnapshot.findUniqueOrThrow({
      where: { runId: run.id },
      select: { plan: true },
    });
    expect(JSON.stringify(preserved.plan)).toBe(planBefore);

    await expect(
      applyPlan(
        { db: ctx.db },
        actor,
        run.id,
        { expectedVersion: preview.version, allowUnassigned: false },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'PLAN_INPUT_STALE' } });

    // Возвращаем смену, чтобы остальные проверки шли в прежних условиях.
    const restored = await readShift(ctx.db);
    await saveShift(ctx.db, admin, {
      value: SHIFT,
      expectedVersion: restored.version,
      ...CONTEXT,
    });
  });

  it('неразмещённые заказы требуют отдельного подтверждения', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    const day = '2026-12-16';
    await seedOrder({ day, latMicro: 55_768_000, lonMicro: 37_608_000 });
    await seedOrder({ day, latMicro: 55_778_000, lonMicro: 37_648_000 });

    // Решатель оставляет один заказ без машины.
    const solver = fakeSolver((request) => {
      const vehicle = request.vehicles[0];
      const at = vehicle?.time_window[0] ?? 0;
      const [head, ...rest] = request.jobs;
      return {
        code: 0,
        routes: [
          {
            vehicle: vehicle?.id ?? 1,
            steps: [
              { type: 'start', arrival: at },
              { type: 'job', id: head?.id ?? 1, arrival: at },
              { type: 'end', arrival: at },
            ],
          },
        ],
        unassigned: rest.map((job) => ({ id: job.id, type: 'job' })),
      };
    });

    const deps = planningDeps({ solver });
    await clearQueue();
    const run = await requestPlan(deps, actor, { deliveryDate: day, slots: [slot()] }, CONTEXT);
    await runPlanningOnce(deps);

    const preview = await ctx.db.routePlanRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { version: true },
    });

    await expect(
      applyPlan(
        { db: ctx.db },
        actor,
        run.id,
        { expectedVersion: preview.version, allowUnassigned: false },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'PLAN_HAS_UNASSIGNED' } });

    // Отказ превью не снял: логист может подтвердить частичное применение.
    const still = await ctx.db.routePlanRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { state: true },
    });
    expect(still.state).toBe('PREVIEW');

    const applied = await applyPlan(
      { db: ctx.db },
      actor,
      run.id,
      { expectedVersion: preview.version, allowUnassigned: true },
      CONTEXT,
    );
    expect(applied.routeIds).toHaveLength(1);
    expect(applied.unassignedOrderIds).toHaveLength(1);

    // Неразмещённый заказ остаётся нераспределённым.
    const unassigned = applied.unassignedOrderIds[0] ?? '';
    expect(await ctx.db.routeOrder.count({ where: { orderId: unassigned, removedAt: null } })).toBe(
      0,
    );
  });
});

// --- Явное истечение превью -------------------------------------------------

describe('истечение превью', () => {
  it('без явного действия новое превью старое не вытесняет, а с ним — вытесняет', async () => {
    const actor = await actorWith(['LOGISTICIAN']);
    const day = '2026-12-17';
    await seedOrder({ day, latMicro: 55_769_000, lonMicro: 37_609_000 });
    await seedOrder({ day, latMicro: 55_779_000, lonMicro: 37_649_000 });

    const deps = planningDeps({ solver: fakeSolver() });
    await clearQueue();
    const first = await requestPlan(deps, actor, { deliveryDate: day, slots: [slot()] }, CONTEXT);
    await runPlanningOnce(deps);

    await expect(
      requestPlan(deps, actor, { deliveryDate: day, slots: [slot()] }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'PLAN_RUN_IN_PROGRESS' } });

    const second = await requestPlan(
      deps,
      actor,
      { deliveryDate: day, slots: [slot()], replacePreviewId: first.id },
      CONTEXT,
    );

    const replaced = await ctx.db.routePlanRun.findUniqueOrThrow({
      where: { id: first.id },
      select: { state: true, failureCode: true },
    });
    expect(replaced.state).toBe('EXPIRED');
    expect(replaced.failureCode).toBe('REPLACED');
    expect(second.state).toBe('QUEUED');

    // Отдельная команда истечения освобождает день.
    await runPlanningOnce(deps);
    const preview = await ctx.db.routePlanRun.findUniqueOrThrow({
      where: { id: second.id },
      select: { version: true },
    });

    await expect(
      expirePreview(deps, actor, second.id, { expectedVersion: preview.version + 5 }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'STALE_VERSION' } });

    await expirePreview(deps, actor, second.id, { expectedVersion: preview.version }, CONTEXT);

    const expired = await ctx.db.routePlanRun.findUniqueOrThrow({
      where: { id: second.id },
      select: { state: true, activeDateKey: true },
    });
    expect(expired.state).toBe('EXPIRED');
    expect(expired.activeDateKey).toBeNull();

    // День снова свободен.
    const third = await requestPlan(deps, actor, { deliveryDate: day, slots: [slot()] }, CONTEXT);
    expect(third.state).toBe('QUEUED');
  });
});

// --- Права и следы ----------------------------------------------------------

describe('права и следы', () => {
  it('логист планирует, курьер и кладовщик — нет, аноним получает 401', async () => {
    const logistician = await tokenFor(['LOGISTICIAN']);
    const courier = await tokenFor(['COURIER']);
    const warehouse = await tokenFor(['WAREHOUSE']);

    const allowed = await ctx.app.inject({
      method: 'GET',
      url: '/api/route-plans',
      headers: { authorization: `Bearer ${logistician}` },
    });
    expect(allowed.statusCode).toBe(200);

    for (const token of [courier, warehouse]) {
      const denied = await ctx.app.inject({
        method: 'GET',
        url: '/api/route-plans',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(denied.statusCode).toBe(403);
    }

    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/route-plans' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('в аудите и событиях планирования нет адресов, координат и номеров заказов', async () => {
    const entries = await ctx.db.auditLog.findMany({
      where: { entityType: 'RoutePlanRun' },
      select: { newValue: true },
    });
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const serialized = JSON.stringify(entry.newValue);
      expect(serialized).not.toContain('Москва');
      expect(serialized).not.toContain('Получатель');
      expect(serialized).not.toMatch(/55\.\d/);
    }

    const events = await ctx.db.realtimeEvent.findMany({
      where: { topic: 'route_plan.updated' },
      select: { payload: true, audienceRoles: true },
      take: 20,
    });
    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      expect(Object.keys(event.payload as Record<string, unknown>).sort()).toEqual([
        'runId',
        'state',
      ]);
      expect(event.audienceRoles.sort()).toEqual(['ADMIN', 'LOGISTICIAN']);
    }
  });

  it('запуск планирования нельзя удалить', async () => {
    const run = await ctx.db.routePlanRun.findFirstOrThrow({ select: { id: true } });
    await expect(ctx.db.routePlanRun.delete({ where: { id: run.id } })).rejects.toThrow();
  });
});
