/**
 * Критические проверки автоматического расчёта расстояния за МКАД.
 *
 * Проверяется не «складывается ли число», а то, нарушение чего стоит денег и
 * доверия к отчёту: расчёт до даты включения (быть не должно), ложный ноль при
 * недоступной Valhalla (быть не должно), перетёртый ручной или прежний снимок
 * (быть не должно), второй активный снимок при повторе, потерянная или удвоенная
 * оплата километров в гонке с результатом «Доставлен».
 *
 * Месяц 2029-07 забронирован за файлом в реестре тестовых дней.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import type { Role } from '@fl/shared';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import type { OutboxMessageView } from '../outbox/worker.js';
import type { DistanceRouter } from './mkad.js';
import { ensureBundledRing } from './mkad-bundle.js';
import { captureRouteTariff, accrueDeliveryResult } from './accrual.js';
import { readLedgerActivation, resolveTariff, LEDGER_SETTING_KEY } from './tariffs.js';
import {
  createMkadDistanceHandler,
  enqueueMkadDistanceForRoute,
  runMkadDistanceRecoverySweep,
  MKAD_DISTANCE_TOPIC,
} from './mkad-auto.js';

let ctx: TestContext;
const logger = pino({ level: 'silent' });

/** Граница включения и дни по обе стороны от неё. */
const CALC_FROM = '2029-07-10';
const IN_DAY = '2029-07-15';
const BEFORE_DAY = '2029-07-05';

/** Внутри МКАД (Красная площадь) и заведомо за МКАД (Подольск). */
const INSIDE = { latMicro: 55_753_900, lonMicro: 37_620_800 };
const OUTSIDE = { latMicro: 55_431_200, lonMicro: 37_554_700 };

beforeAll(async () => {
  ctx = await createTestContext();
  await ensureBundledRing(ctx.db);
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${randomUUID().slice(0, 8)}`;
}

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return { userId: user.id, roles, familyId: randomUUID() } as AuthenticatedActor;
}

/** Маршрутизатор, отвечающий заданной длиной пути. */
function workingRouter(meters: number): DistanceRouter {
  return { configured: true, route: async () => ({ distanceMeters: meters }) };
}

/** Недоступная Valhalla: путь не построен (тайм-аут/сеть/5xx сводятся к этому). */
const downRouter: DistanceRouter = {
  configured: true,
  route: async () => ({ distanceMeters: null }),
};

interface SeedInput {
  day?: string;
  latMicro?: number;
  lonMicro?: number;
  geoState?: 'RESOLVED' | 'NEEDS_REVIEW' | 'UNRESOLVED';
  state?: 'DRAFT' | 'CONFIRMED' | 'ACTIVE' | 'COMPLETED';
  courierId?: string;
}

async function seed(input: SeedInput = {}): Promise<{
  routeId: string;
  routeOrderId: string;
  orderId: string;
  courierId: string;
}> {
  const creator = await actorFor(['ADMIN']);
  const courierId = input.courierId ?? (await actorFor(['COURIER'])).userId;
  const day = input.day ?? IN_DAY;
  const geoState = input.geoState ?? 'RESOLVED';

  // Инвариант базы: RESOLVED требует полной пары координат и источника; иное
  // состояние обязано быть без координат вовсе.
  const resolved = geoState === 'RESOLVED';
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: unique('F'),
      externalUpdated: new Date(),
      deliveryDate: toDateColumn(day),
      inScope: true,
      cashCollectable: false,
      sumMinor: 0n,
      payedSumMinor: 0n,
      cashToCollectMinor: 0n,
      paymentTypeName: 'Наличные/карта на ТТ',
      geoState,
      geoReviewReason: geoState === 'NEEDS_REVIEW' ? 'LOW_PRECISION' : null,
      geoSource: resolved ? 'MANUAL' : null,
      geoPrecision: resolved ? 'EXACT_HOUSE' : null,
      geoResolvedAt: resolved ? new Date() : null,
      geoLatMicro: resolved ? (input.latMicro ?? OUTSIDE.latMicro) : null,
      geoLonMicro: resolved ? (input.lonMicro ?? OUTSIDE.lonMicro) : null,
    },
    select: { id: true },
  });

  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('RF'),
      deliveryDate: toDateColumn(day),
      // CONFIRMED по умолчанию: обработчику состояние маршрута безразлично, а
      // глобальный (без фильтра даты) тест «Отгруженные» в sheets.critical
      // считает именно ACTIVE-листы — незачем засорять его чужими заказами.
      state: input.state ?? 'CONFIRMED',
      vehicleType: 'CAR',
      createdById: creator.userId,
      courierUserId: courierId,
    },
    select: { id: true },
  });

  const participation = await ctx.db.routeOrder.create({
    data: { routeId: route.id, orderId: order.id, position: 1, addedById: creator.userId },
    select: { id: true },
  });

  return { routeId: route.id, routeOrderId: participation.id, orderId: order.id, courierId };
}

function message(routeOrderId: string): OutboxMessageView {
  return {
    id: randomUUID(),
    topic: MKAD_DISTANCE_TOPIC,
    idempotencyKey: unique('k'),
    payload: { routeOrderId },
    attempts: 0,
    maxAttempts: 10,
  };
}

/** Прогон обработчика в одной транзакции, как это делает воркер. */
async function run(
  routeOrderId: string,
  opts: { calcFrom?: string | undefined; router?: DistanceRouter } = {},
): Promise<void> {
  const handler = createMkadDistanceHandler({
    db: ctx.db,
    logger,
    calcFrom: 'calcFrom' in opts ? opts.calcFrom : CALC_FROM,
    valhallaUrl: null,
    router: opts.router ?? workingRouter(12_345),
  });
  await ctx.db.$transaction((tx) => handler(message(routeOrderId), tx));
}

async function activeDistance(routeOrderId: string) {
  return ctx.db.routeOrderDistance.findFirst({
    where: { routeOrderId, activeKey: { not: null } },
    select: {
      roundedKmTenths: true,
      insideMkad: true,
      source: true,
      targetLatMicro: true,
      targetLonMicro: true,
      reason: true,
    },
  });
}

async function activateLedger(from: string): Promise<void> {
  const admin = await actorFor(['ADMIN']);
  await ctx.db.systemSetting.updateMany({
    where: { key: LEDGER_SETTING_KEY, currentKey: LEDGER_SETTING_KEY },
    data: { currentKey: null },
  });
  const previous = await ctx.db.systemSetting.findFirst({
    where: { key: LEDGER_SETTING_KEY },
    orderBy: [{ version: 'desc' }],
    select: { version: true },
  });
  await ctx.db.systemSetting.create({
    data: {
      key: LEDGER_SETTING_KEY,
      version: (previous?.version ?? 0) + 1,
      value: { activeFrom: from },
      currentKey: LEDGER_SETTING_KEY,
      updatedById: admin.userId,
    },
  });
}

describe('отсечка по дате включения', () => {
  it('без переменной автоматика ничего не считает', async () => {
    const s = await seed();
    await run(s.routeOrderId, { calcFrom: undefined });
    expect(await activeDistance(s.routeOrderId)).toBeNull();
  });

  it('дата доставки строго раньше границы не трогается', async () => {
    const s = await seed({ day: BEFORE_DAY });
    await run(s.routeOrderId);
    expect(await activeDistance(s.routeOrderId)).toBeNull();
  });

  it('дата доставки не раньше границы — расчёт выполняется', async () => {
    const s = await seed({ day: IN_DAY });
    await run(s.routeOrderId);
    expect(await activeDistance(s.routeOrderId)).not.toBeNull();
  });
});

describe('расчёт и снимок', () => {
  it('внутри МКАД — честный ноль без обращения к Valhalla', async () => {
    const s = await seed({ latMicro: INSIDE.latMicro, lonMicro: INSIDE.lonMicro });
    // Даже недоступная Valhalla не мешает: точка внутри кольца считается без неё.
    await run(s.routeOrderId, { router: downRouter });
    const d = await activeDistance(s.routeOrderId);
    expect(d?.insideMkad).toBe(true);
    expect(d?.roundedKmTenths).toBe(0);
    expect(d?.source).toBe('COMPUTED');
  });

  it('за МКАД — расстояние считается и снимок хранит координаты', async () => {
    const s = await seed();
    await run(s.routeOrderId, { router: workingRouter(12_345) });
    const d = await activeDistance(s.routeOrderId);
    // 12345 м → 123 десятых километра (12,3 км).
    expect(d?.roundedKmTenths).toBe(123);
    expect(d?.insideMkad).toBe(false);
    expect(d?.targetLatMicro).toBe(OUTSIDE.latMicro);
    expect(d?.targetLonMicro).toBe(OUTSIDE.lonMicro);
  });

  it('нерешённые координаты — расчёта нет', async () => {
    const s = await seed({ geoState: 'NEEDS_REVIEW' });
    await run(s.routeOrderId);
    expect(await activeDistance(s.routeOrderId)).toBeNull();
  });
});

describe('недоступная Valhalla', () => {
  it('оставляет задачу на повтор и не сохраняет ложный ноль', async () => {
    const s = await seed();
    // Обработчик обязан бросить ошибку: воркер повторит с backoff, снимка нет.
    await expect(run(s.routeOrderId, { router: downRouter })).rejects.toThrow();
    expect(await activeDistance(s.routeOrderId)).toBeNull();
  });
});

describe('идемпотентность и версии', () => {
  it('повторный проход не создаёт второй активный снимок', async () => {
    const s = await seed();
    await run(s.routeOrderId, { router: workingRouter(12_345) });
    await run(s.routeOrderId, { router: workingRouter(99_999) });
    const active = await ctx.db.routeOrderDistance.count({
      where: { routeOrderId: s.routeOrderId, activeKey: { not: null } },
    });
    expect(active).toBe(1);
    // Подходящий снимок уже есть — второй расчёт (99999) не применился.
    expect((await activeDistance(s.routeOrderId))?.roundedKmTenths).toBe(123);
  });

  it('изменение координат — новая версия, прежняя остаётся в истории', async () => {
    const s = await seed();
    await run(s.routeOrderId, { router: workingRouter(12_345) });

    // Координаты заказа сменились (логист подтвердил другую точку).
    const moved = { latMicro: OUTSIDE.latMicro + 5_000, lonMicro: OUTSIDE.lonMicro + 5_000 };
    await ctx.db.deliveryOrder.update({
      where: { id: s.orderId },
      data: { geoLatMicro: moved.latMicro, geoLonMicro: moved.lonMicro },
    });
    await run(s.routeOrderId, { router: workingRouter(20_000) });

    const active = await activeDistance(s.routeOrderId);
    expect(active?.roundedKmTenths).toBe(200);
    expect(active?.targetLatMicro).toBe(moved.latMicro);

    const total = await ctx.db.routeOrderDistance.count({
      where: { routeOrderId: s.routeOrderId },
    });
    const activeCount = await ctx.db.routeOrderDistance.count({
      where: { routeOrderId: s.routeOrderId, activeKey: { not: null } },
    });
    expect(total).toBe(2); // прежняя версия сохранилась
    expect(activeCount).toBe(1); // действующая ровно одна
  });

  it('ручной снимок логиста не перетирается', async () => {
    const s = await seed();
    const admin = await actorFor(['ADMIN']);
    await ctx.db.routeOrderDistance.create({
      data: {
        routeOrderId: s.routeOrderId,
        ringVersionId: (await ctx.db.mkadRingVersion.findFirstOrThrow({ select: { id: true } })).id,
        graphSha256: null,
        meters: 5_000,
        roundedKmTenths: 50,
        insideMkad: false,
        source: 'MANUAL',
        actorUserId: admin.userId,
        reason: 'ручная правка',
        activeKey: s.routeOrderId,
      },
    });

    await run(s.routeOrderId, { router: workingRouter(12_345) });
    const active = await activeDistance(s.routeOrderId);
    // Ручные 5,0 км остались; автоматический расчёт их не тронул.
    expect(active?.source).toBe('MANUAL');
    expect(active?.roundedKmTenths).toBe(50);
  });
});

describe('гонка с результатом «Доставлен»', () => {
  it('расстояние пришло после доставки — добавляется только DISTANCE_FEE', async () => {
    await activateLedger(BEFORE_DAY);
    const courier = await actorFor(['COURIER']);
    const s = await seed({ courierId: courier.userId, state: 'CONFIRMED' });

    // Тариф: за заказ 15000, за км 1000 (минорные единицы).
    await ctx.db.courierTariffVersion.create({
      data: {
        kind: 'REGULAR',
        effectiveFrom: toDateColumn(BEFORE_DAY),
        effectiveTo: null,
        perOrderWalkMinor: 15_000n,
        perOrderCarMinor: 15_000n,
        perKmMinor: 1_000n,
        createdById: (await actorFor(['ADMIN'])).userId,
      },
    });
    const rates = await resolveTariff(ctx.db, IN_DAY);
    await captureRouteTariff(ctx.db, {
      routeId: s.routeId,
      deliveryDate: IN_DAY,
      vehicleType: 'CAR',
      rates: rates!,
    });

    // Доставка зафиксирована ДО расчёта расстояния (Valhalla была недоступна).
    const attempt = await ctx.db.deliveryAttempt.create({
      data: {
        routeOrderId: s.routeOrderId,
        orderId: s.orderId,
        routeId: s.routeId,
        outcome: 'DELIVERED',
        courierUserId: courier.userId,
        activeKey: s.routeOrderId,
      },
      select: { id: true },
    });
    await accrueDeliveryResult(ctx.db, await readLedgerActivation(ctx.db), {
      attemptId: attempt.id,
      routeOrderId: s.routeOrderId,
      routeId: s.routeId,
      orderId: s.orderId,
      courierUserId: courier.userId,
      actorUserId: courier.userId,
      outcome: 'DELIVERED',
    });

    // Основная оплата уже есть, километров ещё нет.
    const deliveryFeeBefore = await ctx.db.courierLedgerEntry.findFirst({
      where: { attemptId: attempt.id, kind: 'DELIVERY_FEE' },
      select: { amountMinor: true },
    });
    expect(deliveryFeeBefore?.amountMinor).toBe(-15_000n);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { attemptId: attempt.id, kind: 'DISTANCE_FEE' },
      }),
    ).toBe(0);

    // Valhalla ответила позднее: расстояние сохраняется, добавляется километры.
    await run(s.routeOrderId, { router: workingRouter(12_345) });

    const distanceFee = await ctx.db.courierLedgerEntry.findMany({
      where: { attemptId: attempt.id, kind: 'DISTANCE_FEE' },
      select: { amountMinor: true },
    });
    // 1000 * 123 / 10 = 12300, знак начисления отрицательный.
    expect(distanceFee).toHaveLength(1);
    expect(distanceFee[0]?.amountMinor).toBe(-12_300n);

    // Основная оплата не изменилась.
    const deliveryFeeAfter = await ctx.db.courierLedgerEntry.count({
      where: { attemptId: attempt.id, kind: 'DELIVERY_FEE' },
    });
    expect(deliveryFeeAfter).toBe(1);

    // Повторный проход километры не удваивает.
    await run(s.routeOrderId, { router: workingRouter(12_345) });
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { attemptId: attempt.id, kind: 'DISTANCE_FEE' },
      }),
    ).toBe(1);
  });

  it('не доставленный заказ километров не начисляет', async () => {
    await activateLedger(BEFORE_DAY);
    const courier = await actorFor(['COURIER']);
    const s = await seed({ courierId: courier.userId });
    const reason = await ctx.db.deliveryFailureReason.findFirstOrThrow({
      where: { isActive: true },
      select: { id: true, name: true },
    });
    await ctx.db.deliveryAttempt.create({
      data: {
        routeOrderId: s.routeOrderId,
        orderId: s.orderId,
        routeId: s.routeId,
        outcome: 'NOT_DELIVERED',
        reasonId: reason.id,
        reasonNameSnapshot: reason.name,
        courierUserId: courier.userId,
        activeKey: s.routeOrderId,
      },
    });
    await run(s.routeOrderId, { router: workingRouter(12_345) });
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { routeId: s.routeId, kind: 'DISTANCE_FEE' },
      }),
    ).toBe(0);
  });
});

describe('постановка задания и восстановительный проход', () => {
  it('подтверждение маршрута ставит задание по координатам, повтор не дублирует', async () => {
    const s = await seed({ state: 'CONFIRMED' });
    await ctx.db.$transaction((tx) => enqueueMkadDistanceForRoute(tx, s.routeId));
    await ctx.db.$transaction((tx) => enqueueMkadDistanceForRoute(tx, s.routeId));
    const count = await ctx.db.outboxMessage.count({
      where: {
        topic: MKAD_DISTANCE_TOPIC,
        idempotencyKey: `${MKAD_DISTANCE_TOPIC}:${s.routeOrderId}:${OUTSIDE.latMicro}:${OUTSIDE.lonMicro}`,
      },
    });
    expect(count).toBe(1);
  });

  it('восстановительный проход берёт только заказы не раньше границы и оживляет мёртвые', async () => {
    const eligible = await seed({ day: IN_DAY, state: 'CONFIRMED' });
    const early = await seed({ day: BEFORE_DAY, state: 'CONFIRMED' });

    // Мёртвое задание после долгой недоступности Valhalla.
    const dead = await ctx.db.outboxMessage.create({
      data: {
        topic: MKAD_DISTANCE_TOPIC,
        idempotencyKey: unique('dead'),
        payload: { routeOrderId: unique('ro') },
        status: 'DEAD',
        attempts: 10,
      },
      select: { id: true },
    });

    const result = await runMkadDistanceRecoverySweep(ctx.db, { calcFrom: CALC_FROM });
    expect(result.revived).toBeGreaterThanOrEqual(1);

    const revived = await ctx.db.outboxMessage.findUniqueOrThrow({
      where: { id: dead.id },
      select: { status: true },
    });
    expect(revived.status).toBe('PENDING');

    // Заказ не раньше границы получил задание…
    const eligibleMsg = await ctx.db.outboxMessage.count({
      where: {
        topic: MKAD_DISTANCE_TOPIC,
        idempotencyKey: {
          startsWith: `${MKAD_DISTANCE_TOPIC}:${eligible.routeOrderId}:`,
        },
      },
    });
    expect(eligibleMsg).toBe(1);

    // …а заказ раньше границы — нет.
    const earlyMsg = await ctx.db.outboxMessage.count({
      where: {
        topic: MKAD_DISTANCE_TOPIC,
        idempotencyKey: { startsWith: `${MKAD_DISTANCE_TOPIC}:${early.routeOrderId}:` },
      },
    });
    expect(earlyMsg).toBe(0);
  });

  it('без переменной восстановительный проход ничего не делает', async () => {
    const result = await runMkadDistanceRecoverySweep(ctx.db, { calcFrom: undefined });
    expect(result).toEqual({ revived: 0, enqueued: 0 });
  });
});
