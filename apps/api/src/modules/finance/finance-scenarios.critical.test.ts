/**
 * Сквозные денежные сценарии НАСТОЯЩИМИ функциями продукта.
 *
 * Отличие от остальных финансовых файлов: здесь ничего не подставляется в
 * журнал руками. Заказ приходит через настоящий разбор ответа МоегоСклада
 * (`mapOrder` → `applyOrderSnapshot`), доставка фиксируется настоящим
 * `recordDeliveryResult` курьера, а денежные последствия изменений источника
 * выполняет настоящий воркер очереди (`processOutboxOnce`) настоящим
 * обработчиком `finance.order_sync`. Проверяется то, что увидит человек, а не
 * то, что вернёт отдельно вызванная функция расчёта.
 *
 * Защищаемые свойства:
 *   • доставка → частичная оплата → полная оплата → отмена даёт нулевой вклад
 *     заказа, и ни одно снятие не делается дважды;
 *   • отмена, пришедшая ДО доставки, не даёт начислению появиться вовсе;
 *   • одновременные доставка и денежное задание дают один и тот же итог при
 *     любом порядке — и оба соединения действительно встают на общую блокировку
 *     строки заказа, что доказывается `pg_blocking_pids`, а не паузой;
 *   • позднее начисление километров за МКАД работает до отмены и молчит после;
 *   • повтор задания и повтор импорта того же снимка не создают вторых записей.
 *
 * ВЛАДЕНИЕ ДАТАМИ: октябрь 2030 (см. RESERVED_MONTHS).
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
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { mapOrder } from '../integrations/moysklad/mapper.js';
import type { MoyskladOrderDto } from '../integrations/moysklad/dto.js';
import { applyOrderSnapshot } from '../integrations/moysklad/import-service.js';
import { recordDeliveryResult, type DeliveryDeps } from '../delivery/service.js';
import { processOutboxOnce, type OutboxHandlers } from '../outbox/worker.js';
import { createOrderFinanceHandler, ORDER_FINANCE_TOPIC } from './order-sync.js';
import { createMkadDistanceHandler, MKAD_DISTANCE_TOPIC } from './mkad-auto.js';
import { LEDGER_SETTING_KEY } from './tariffs.js';
import { buildSettlementReport } from './reports.js';
import { appendEntry, reverseEntry } from './ledger.js';
import { buildSettlementWorkbook } from './export-xlsx.js';
import { buildSettlementPdf, settlementPdfTitle, settlementSummaryLines } from './export-pdf.js';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';

let ctx: TestContext;
let deliveryDeps: DeliveryDeps;

/** Октябрь 2030: месяц принадлежит этому файлу целиком. */
const DAY = '2030-10-14';
const NEXT_DAY = '2030-10-15';
const LEDGER_FROM = '2030-10-01';

const CONTEXT = { ip: null, userAgent: null };
const logger = pino({ level: 'silent' });
const IDS = MOYSKLAD_IDS;

/** Одна версия тарифа на весь файл: снимок ставок маршрута ссылается на неё. */
let tariffVersionId = '';

beforeAll(async () => {
  ctx = await createTestContext();
  deliveryDeps = { db: ctx.db };
  await activateLedger(LEDGER_FROM);

  const admin = await actorFor(['ADMIN']);
  const version = await ctx.db.courierTariffVersion.create({
    data: {
      kind: 'REGULAR',
      effectiveFrom: toDateColumn(LEDGER_FROM),
      effectiveTo: null,
      perOrderWalkMinor: 0n,
      perOrderCarMinor: 0n,
      perKmMinor: 0n,
      createdById: admin.userId,
    },
    select: { id: true },
  });
  tariffVersionId = version.id;
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${seq}`;
}

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return { userId: user.id, roles, familyId: randomUUID() } as AuthenticatedActor;
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
      currentKey: LEDGER_SETTING_KEY,
      version: (previous?.version ?? 0) + 1,
      value: { activeFrom: from },
      updatedById: admin.userId,
    },
  });
}

// --- Настоящий источник --------------------------------------------------------

const href = (kind: string, id: string): string =>
  `https://api.moysklad.ru/api/remap/1.2/entity/${kind}/${id}`;

/**
 * Ответ МоегоСклада того же вида, что приходит по сети.
 *
 * Заказ наш (склад и способ доставки совпадают) и оплачивается наличными на
 * месте — иначе долга за курьером не возникает вовсе. Никакой записи в
 * настоящий МойСклад тут нет и быть не может: это входные данные разбора.
 */
function dto(input: {
  externalId: string;
  name: string;
  sum: number;
  payedSum: number;
  /** `null` — обычный рабочий статус; иначе идентификатор статуса. */
  stateId?: string;
}): MoyskladOrderDto {
  const stateId = input.stateId ?? '22222222-2222-4222-8222-222222222222';
  return {
    id: input.externalId,
    name: input.name,
    updated: `${DAY} 10:00:00.000`,
    shipmentAddress: 'Москва, Русаковская улица, 26',
    deliveryPlannedMoment: `${DAY} 12:00:00.000`,
    sum: input.sum,
    payedSum: input.payedSum,
    store: { meta: { href: href('store', IDS.store) } },
    state: {
      meta: { href: href('state', stateId) },
      id: stateId,
      name: stateId === IDS.states.cancelled ? 'Отменен' : 'Новый',
      stateType: stateId === IDS.states.cancelled ? 'Unsuccessful' : 'Regular',
    },
    attributes: [
      {
        id: IDS.deliveryMethodAttribute,
        value: {
          name: 'Доставка',
          meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
        },
      },
      {
        id: IDS.paymentTypeAttribute,
        value: {
          name: 'Наличные/карта на ТТ',
          meta: { href: href('customentity', IDS.paymentTypeCash) },
        },
      },
      { id: IDS.intervalAttribute, value: 'с 10:00 по 14:00' },
      { id: IDS.recipientAttribute, value: 'Получатель Проверочный' },
    ],
  } as MoyskladOrderDto;
}

/** Импорт настоящим путём: разбор ответа и применение снимка в транзакции. */
async function importOrder(order: MoyskladOrderDto): Promise<string> {
  const { snapshot } = mapOrder(order, IDS);
  await ctx.db.$transaction((tx) =>
    applyOrderSnapshot(tx, snapshot, new Date(`${DAY}T07:00:00.000Z`), {
      cancelledStateId: IDS.states.cancelled,
      geocoding: false,
    }),
  );
  const stored = await ctx.db.deliveryOrder.findFirstOrThrow({
    where: { externalId: order.id },
    select: { id: true },
  });
  return stored.id;
}

// --- Настоящая доставка --------------------------------------------------------

interface Scenario {
  externalId: string;
  name: string;
  orderId: string;
  routeId: string;
  routeOrderId: string;
  courierId: string;
  /** Ставка за заказ из снимка маршрута: ожидаемая оплата доставки. */
  perOrderMinor: bigint;
  perKmMinor: bigint;
}

/**
 * Заказ из источника, положенный в выданный маршрут курьера.
 *
 * Маршрут именно ACTIVE: `recordDeliveryResult` отказывает невыданному, а
 * подменять его состояние после записи результата значило бы проверять не тот
 * путь. Единственный заказ маршрута переводит его в `COMPLETED` сразу после
 * результата, поэтому в разделе выданных листов он не задерживается.
 */
async function seedScenario(input: {
  sum: number;
  payedSum: number;
  perOrderMinor?: bigint;
  perKmMinor?: bigint;
}): Promise<Scenario> {
  const admin = await actorFor(['ADMIN']);
  const courier = await actorFor(['COURIER']);
  const externalId = randomUUID();
  const name = unique('FS');

  const orderId = await importOrder(
    dto({ externalId, name, sum: input.sum, payedSum: input.payedSum }),
  );

  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('RFS'),
      deliveryDate: toDateColumn(DAY),
      state: 'ACTIVE',
      vehicleType: 'CAR',
      createdById: admin.userId,
      courierUserId: courier.userId,
    },
    select: { id: true },
  });

  const participation = await ctx.db.routeOrder.create({
    data: { routeId: route.id, orderId, position: 1, addedById: admin.userId },
    select: { id: true },
  });

  await ctx.db.routeTariffSnapshot.create({
    data: {
      routeId: route.id,
      tariffVersionId,
      vehicleType: 'CAR',
      perOrderMinor: input.perOrderMinor ?? 0n,
      perKmMinor: input.perKmMinor ?? 0n,
      deliveryDate: toDateColumn(DAY),
    },
  });

  return {
    externalId,
    name,
    orderId,
    routeId: route.id,
    routeOrderId: participation.id,
    courierId: courier.userId,
    perOrderMinor: input.perOrderMinor ?? 0n,
    perKmMinor: input.perKmMinor ?? 0n,
  };
}

/** Курьер сообщает результат — настоящей функцией, с правами и блокировками. */
async function deliver(scenario: Scenario): Promise<void> {
  const courier: AuthenticatedActor = {
    userId: scenario.courierId,
    roles: ['COURIER'],
    familyId: randomUUID(),
  } as AuthenticatedActor;

  await recordDeliveryResult(
    deliveryDeps,
    courier,
    scenario.routeOrderId,
    { outcome: 'DELIVERED' },
    CONTEXT,
  );
}

/**
 * Действующая попытка доставки этого заказа.
 *
 * Нужна там, где операцию логиста привязывают к конкретной доставке: ровно
 * такие записи и снимает отмена заказа.
 */
async function activeAttemptOf(scenario: Scenario): Promise<string> {
  const attempt = await ctx.db.deliveryAttempt.findFirstOrThrow({
    where: { orderId: scenario.orderId, activeKey: { not: null } },
    select: { id: true },
  });
  return attempt.id;
}

/** Новая оплата или отмена приходит тем же импортом, что и в проде. */
async function syncSource(
  scenario: Scenario,
  input: { sum: number; payedSum: number; cancelled?: boolean },
): Promise<void> {
  await importOrder(
    dto({
      externalId: scenario.externalId,
      name: scenario.name,
      sum: input.sum,
      payedSum: input.payedSum,
      ...(input.cancelled === true ? { stateId: IDS.states.cancelled } : {}),
    }),
  );
}

// --- Настоящая очередь ---------------------------------------------------------

/** Далёкий момент, на который откладываются чужие сообщения очереди. */
const PARKED_UNTIL = new Date('2099-01-01T00:00:00.000Z');

/**
 * Прогон настоящего воркера ТОЛЬКО по сообщениям своего заказа.
 *
 * Очередь в критической базе общая, а `claimBatch` забирает пачку без разбора:
 * ни по теме, ни тем более по заказу. Отбирать по теме недостаточно — соседние
 * финансовые файлы оставляют задания тех же тем, и счётчик обработанного
 * зависел бы от того, что накопили предыдущие проверки. Поэтому остаются
 * только задания ЭТОГО сценария, а всё прочее откладывается и возвращается
 * ровно как было.
 */
async function runQueue(now: Date, scenario: Scenario): Promise<number> {
  const mine = await ctx.db.outboxMessage.findMany({
    where: {
      status: { in: ['PENDING', 'ERROR'] },
      OR: [
        { topic: ORDER_FINANCE_TOPIC, payload: { path: ['orderId'], equals: scenario.orderId } },
        {
          topic: MKAD_DISTANCE_TOPIC,
          payload: { path: ['routeOrderId'], equals: scenario.routeOrderId },
        },
      ],
    },
    select: { id: true },
  });
  const mineIds = mine.map((message) => message.id);

  const foreign = await ctx.db.outboxMessage.findMany({
    where: { status: { in: ['PENDING', 'ERROR'] }, id: { notIn: mineIds } },
    select: { id: true, nextAttemptAt: true },
  });
  if (foreign.length > 0) {
    await ctx.db.outboxMessage.updateMany({
      where: { id: { in: foreign.map((message) => message.id) } },
      data: { nextAttemptAt: PARKED_UNTIL },
    });
  }

  const handlers: OutboxHandlers = {
    [ORDER_FINANCE_TOPIC]: createOrderFinanceHandler({ now: () => now }),
    [MKAD_DISTANCE_TOPIC]: createMkadDistanceHandler({
      db: ctx.db,
      logger,
      calcFrom: LEDGER_FROM,
      valhallaUrl: null,
      // Маршрутизатор не вызывается: действующий снимок расстояния уже есть,
      // и обработчик переходит сразу к догоняющему начислению.
      router: {
        configured: false,
        route: async () => ({ distanceMeters: null }),
      },
    }),
  };

  try {
    const result = await processOutboxOnce({
      db: ctx.db,
      logger,
      handlers,
      workerId: unique('w'),
      handlerTimeoutMs: 30_000,
    });
    expect(result.failed).toBe(0);
    expect(result.dead).toBe(0);
    expect(result.lost).toBe(0);
    return result.processed;
  } finally {
    for (const message of foreign) {
      await ctx.db.outboxMessage.update({
        where: { id: message.id },
        data: { nextAttemptAt: message.nextAttemptAt },
      });
    }
  }
}

// --- Наблюдение ----------------------------------------------------------------

/** Сумма записей одного вида по заказу, без учёта отменённых. */
async function sumKind(orderId: string, kind: string): Promise<bigint> {
  const result = await ctx.db.courierLedgerEntry.aggregate({
    where: { orderId, kind: kind as never, reversedBy: { is: null } },
    _sum: { amountMinor: true },
  });
  return result._sum.amountMinor ?? 0n;
}

/** Вклад заказа в расчёты: сумма ВСЕХ его записей, включая обратные. */
async function contribution(orderId: string): Promise<bigint> {
  const result = await ctx.db.courierLedgerEntry.aggregate({
    where: { orderId },
    _sum: { amountMinor: true },
  });
  return result._sum.amountMinor ?? 0n;
}

async function entryCount(orderId: string, kind: string): Promise<number> {
  return ctx.db.courierLedgerEntry.count({ where: { orderId, kind: kind as never } });
}

/**
 * Курсор ленты событий.
 *
 * Считать по времени нельзя: часы Node и часы базы расходятся, и соседнее
 * событие попадало бы в выборку через раз. Идентификатор растёт монотонно.
 */
async function lastEventId(): Promise<bigint> {
  const row = await ctx.db.realtimeEvent.findFirst({
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  return row?.id ?? 0n;
}

/** События финансового журнала, появившиеся после курсора. */
async function ledgerEventsAfter(cursor: bigint): Promise<{ audienceRoles: string[] }[]> {
  return ctx.db.realtimeEvent.findMany({
    where: { topic: 'finance.ledger_changed', id: { gt: cursor } },
    select: { audienceRoles: true },
  });
}

/** Записи аудита по заказу с указанным действием. */
async function auditCount(orderId: string, action: string): Promise<number> {
  return ctx.db.auditLog.count({
    where: { action, entityType: 'DeliveryOrder', entityId: orderId },
  });
}

async function report(from: string, to: string, courierUserId: string) {
  return buildSettlementReport(ctx.db, {
    from,
    to,
    courierUserId,
    ledgerActiveFrom: LEDGER_FROM,
    limit: 50,
    offset: 0,
  });
}

/**
 * Сколько соединений СЕЙЧАС заблокированы чужой транзакцией.
 *
 * `pg_blocking_pids` отвечает именно на этот вопрос. Произвольная пауза не
 * доказывает ничего: запрос мог всё это время проверять права.
 */
async function blockedBackends(): Promise<number> {
  const rows = await ctx.db.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count
    FROM pg_stat_activity
    WHERE cardinality(pg_blocking_pids(pid)) > 0
      AND datname = current_database()
  `;
  return Number(rows[0]?.count ?? 0n);
}

async function waitForBlocked(expected: number, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    seen = await blockedBackends();
    if (seen >= expected) {
      return seen;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return seen;
}

/**
 * Подтверждённая точка заказа.
 *
 * Ставится ДО доставки: без координат задание `mkad.distance` не ставится
 * вовсе, и «позднего расчёта» не бывает. Само геокодирование проверяется
 * своими тестами, здесь нужен только его результат.
 */
async function seedGeo(scenario: Scenario): Promise<void> {
  await ctx.db.deliveryOrder.update({
    where: { id: scenario.orderId },
    data: {
      geoState: 'RESOLVED',
      geoSource: 'MANUAL',
      // Инвариант базы: подтверждённая точка существует только целиком —
      // с координатами, источником, точностью и временем разрешения.
      geoPrecision: 'EXACT_HOUSE',
      geoResolvedAt: new Date(`${DAY}T08:00:00.000Z`),
      geoLatMicro: 55_200_000,
      geoLonMicro: 37_200_000,
    },
  });
}

/** Действующий ненулевой снимок расстояния за МКАД. */
async function seedDistance(scenario: Scenario, kmTenths: number): Promise<void> {
  const admin = await actorFor(['ADMIN']);
  const ring =
    (await ctx.db.mkadRingVersion.findFirst({ select: { id: true } })) ??
    (await ctx.db.mkadRingVersion.create({
      data: {
        points: [
          [37_000_000, 55_000_000],
          [37_100_000, 55_000_000],
          [37_100_000, 55_100_000],
          [37_000_000, 55_000_000],
        ],
        pointCount: 4,
        sha256: `ring-${process.hrtime.bigint().toString(16)}`,
        source: 'проверка',
      },
      select: { id: true },
    }));

  await ctx.db.routeOrderDistance.create({
    data: {
      routeOrderId: scenario.routeOrderId,
      ringVersionId: ring.id,
      meters: kmTenths * 100,
      roundedKmTenths: kmTenths,
      insideMkad: false,
      source: 'MANUAL',
      actorUserId: admin.userId,
      reason: 'проверка позднего начисления',
      activeKey: scenario.routeOrderId,
    },
  });
}

// --- Сценарий 1: доставка → частичная оплата → полная оплата → отмена ----------

describe('доставка, оплаты и отмена одним заказом', () => {
  it('частичная и полная оплата снимают наличные по разу, отмена обнуляет вклад', async () => {
    // Заказ 5 000 ₽, оплачено 1 000 ₽, ставка за заказ 300 ₽.
    const scenario = await seedScenario({
      sum: 500_000,
      payedSum: 100_000,
      perOrderMinor: 30_000n,
    });

    await deliver(scenario);
    expect(await sumKind(scenario.orderId, 'CASH_RECEIVED')).toBe(400_000n);
    expect(await sumKind(scenario.orderId, 'DELIVERY_FEE')).toBe(-30_000n);

    // Частичная оплата: пришло ещё 2 000 ₽, за курьером остаётся 2 000 ₽.
    await syncSource(scenario, { sum: 500_000, payedSum: 300_000 });
    const afterDelivery = await lastEventId();
    expect(await runQueue(new Date(`${DAY}T15:00:00.000Z`), scenario)).toBe(1);
    expect(await sumKind(scenario.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(-200_000n);

    // Открытый отчёт обязан обновиться сам — ровно одним событием на роли отчёта.
    const paymentEvents = await ledgerEventsAfter(afterDelivery);
    expect(paymentEvents).toHaveLength(1);
    expect([...(paymentEvents[0]?.audienceRoles ?? [])].sort()).toEqual([
      'ADMIN',
      'LOGISTICIAN',
      'SUPERVISOR',
    ]);

    // Полная оплата: наличных за курьером не остаётся.
    await syncSource(scenario, { sum: 500_000, payedSum: 500_000 });
    expect(await runQueue(new Date(`${DAY}T16:00:00.000Z`), scenario)).toBe(1);
    expect(await sumKind(scenario.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(-400_000n);
    // Снятий ровно два — по одному на каждое изменение оплаты.
    expect(await entryCount(scenario.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(2);

    // Оплата работы курьера при этом не тронута: он всё отвёз.
    expect(await sumKind(scenario.orderId, 'DELIVERY_FEE')).toBe(-30_000n);
    expect(await contribution(scenario.orderId)).toBe(-30_000n);

    // Отмена в источнике на следующий день снимает финансовый результат целиком.
    await syncSource(scenario, { sum: 500_000, payedSum: 500_000, cancelled: true });
    // Отмену заказа импорт фиксирует аудитом один раз.
    expect(await auditCount(scenario.orderId, 'ORDER_CANCELLED_IN_SOURCE')).toBe(1);

    const beforeCancelJob = await lastEventId();
    expect(await runQueue(new Date(`${NEXT_DAY}T09:00:00.000Z`), scenario)).toBe(1);
    expect(await contribution(scenario.orderId)).toBe(0n);
    expect(await ledgerEventsAfter(beforeCancelJob)).toHaveLength(1);

    // Исходные записи остались в истории: снятие сделано обратными записями.
    expect(await entryCount(scenario.orderId, 'CASH_RECEIVED')).toBe(1);
    expect(await entryCount(scenario.orderId, 'DELIVERY_FEE')).toBe(1);

    /*
     * Отчёт: день доставки сохраняет историю, день отмены показывает снятие,
     * а за оба дня заработка не остаётся. Даты проводок не переписаны.
     */
    const both = await report(DAY, NEXT_DAY, scenario.courierId);
    expect(both.totals.deliveryFeesMinor).toBe('0');
    expect(both.totals.closingBalanceMinor).toBe('0');

    const dayOnly = await report(DAY, DAY, scenario.courierId);
    expect(dayOnly.totals.deliveryFeesMinor).toBe('30000');

    const nextOnly = await report(NEXT_DAY, NEXT_DAY, scenario.courierId);
    expect(nextOnly.totals.deliveryFeesMinor).toBe('-30000');

    // Дневные группы общего отчёта совпадают с отдельными отчётами тех же дней.
    const groupOf = (
      result: Awaited<ReturnType<typeof report>>,
      date: string,
    ): { accruedMinor: string } | undefined =>
      result.days.find((day) => day.date === date)?.couriers[0];
    expect(groupOf(both, DAY)?.accruedMinor).toBe(groupOf(dayOnly, DAY)?.accruedMinor);
    expect(groupOf(both, NEXT_DAY)?.accruedMinor).toBe(groupOf(nextOnly, NEXT_DAY)?.accruedMinor);
  });

  it('повтор задания и повтор импорта того же снимка не создают вторых записей', async () => {
    const scenario = await seedScenario({ sum: 400_000, payedSum: 0, perOrderMinor: 20_000n });
    await deliver(scenario);

    // Тот же снимок приходит дважды: второе применение ничего не меняет,
    // поэтому и задания на корректировку не появляется.
    await syncSource(scenario, { sum: 400_000, payedSum: 200_000 });
    await syncSource(scenario, { sum: 400_000, payedSum: 200_000 });
    expect(
      await ctx.db.outboxMessage.count({
        where: {
          topic: ORDER_FINANCE_TOPIC,
          payload: { path: ['orderId'], equals: scenario.orderId },
        },
      }),
    ).toBe(1);

    expect(await runQueue(new Date(`${DAY}T15:00:00.000Z`), scenario)).toBe(1);
    const afterFirstRun = await lastEventId();
    // Повторный прогон воркера: обработчику ничего не осталось.
    expect(await runQueue(new Date(`${DAY}T15:30:00.000Z`), scenario)).toBe(0);

    expect(await sumKind(scenario.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(-200_000n);
    expect(await entryCount(scenario.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(1);
    // Второго события тоже нет: воркеру нечего было обрабатывать.
    expect(await ledgerEventsAfter(afterFirstRun)).toHaveLength(0);

    /*
     * Тот же обработчик запускается ЯВНО, будто задание пришло повторно.
     *
     * Без этого проверка доказывала бы только «сообщения в очереди нет»:
     * ожидание «события не появилось» выполнялось бы ещё до того, как
     * обработчик решил его не публиковать. Здесь он честно отрабатывает
     * и обязан промолчать — записывать нечего.
     */
    const beforeReplay = await lastEventId();
    await ctx.db.$transaction((tx) =>
      createOrderFinanceHandler({ now: () => new Date(`${DAY}T16:00:00.000Z`) })(
        {
          id: randomUUID(),
          topic: ORDER_FINANCE_TOPIC,
          idempotencyKey: unique('replay'),
          payload: { reason: 'PAYMENT', orderId: scenario.orderId },
          attempts: 0,
          maxAttempts: 5,
        },
        tx,
      ),
    );
    expect(await entryCount(scenario.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(1);
    expect(await ledgerEventsAfter(beforeReplay)).toHaveLength(0);
  });

  it('корректировка, отменённая человеком, повторным заданием не воскресает', async () => {
    /*
     * Ключ корректировки один на попытку и состояние оплаты. Если человек
     * отменил корректировку обратной записью, снятое перестаёт учитываться,
     * и разница снова окажется положительной — но запись по этому ключу уже
     * есть, и новой не появится. Значит и событие «журнал изменился» слать
     * не о чем: иначе отчёт звали бы перечитывать то, что не менялось.
     */
    const scenario = await seedScenario({ sum: 500_000, payedSum: 0, perOrderMinor: 20_000n });
    await deliver(scenario);
    await syncSource(scenario, { sum: 500_000, payedSum: 200_000 });
    expect(await runQueue(new Date(`${DAY}T15:00:00.000Z`), scenario)).toBe(1);

    const correction = await ctx.db.courierLedgerEntry.findFirstOrThrow({
      where: { orderId: scenario.orderId, kind: 'CASH_PAYMENT_CORRECTION' },
      select: { id: true },
    });
    const admin = await actorFor(['ADMIN']);
    await ctx.db.$transaction((tx) =>
      reverseEntry(tx, {
        entryId: correction.id,
        actorUserId: admin.userId,
        reason: 'снято по решению администратора',
        operationDate: DAY,
      }),
    );

    const beforeReplay = await lastEventId();
    await ctx.db.$transaction((tx) =>
      createOrderFinanceHandler({ now: () => new Date(`${DAY}T17:00:00.000Z`) })(
        {
          id: randomUUID(),
          topic: ORDER_FINANCE_TOPIC,
          idempotencyKey: unique('replay-after-reversal'),
          payload: { reason: 'PAYMENT', orderId: scenario.orderId },
          attempts: 0,
          maxAttempts: 5,
        },
        tx,
      ),
    );

    // Вторая корректировка не появилась, и события об изменении журнала нет.
    expect(await entryCount(scenario.orderId, 'CASH_PAYMENT_CORRECTION')).toBe(1);
    expect(await ledgerEventsAfter(beforeReplay)).toHaveLength(0);
  });
});

// --- Сценарий 2: отмена до доставки --------------------------------------------

describe('отмена до доставки', () => {
  it('отменённый заказ не даёт начислений, хотя доставка физически состоялась', async () => {
    const scenario = await seedScenario({ sum: 600_000, payedSum: 0, perOrderMinor: 30_000n });

    await syncSource(scenario, { sum: 600_000, payedSum: 0, cancelled: true });
    // Задание отмены отрабатывает на пустом журнале и ничего не находит.
    const beforeJob = await lastEventId();
    expect(await runQueue(new Date(`${DAY}T11:00:00.000Z`), scenario)).toBe(1);
    // Журнал не изменился — значит и события отчёту слать не о чем.
    expect(await ledgerEventsAfter(beforeJob)).toHaveLength(0);

    await deliver(scenario);

    // Денежный факт доставки записан — история физической работы сохраняется.
    expect(await ctx.db.deliveryMoneyFact.count({ where: { orderId: scenario.orderId } })).toBe(1);
    // Начислений нет ни одного: ни наличных, ни оплаты доставки.
    expect(await ctx.db.courierLedgerEntry.count({ where: { orderId: scenario.orderId } })).toBe(0);
    expect(await contribution(scenario.orderId)).toBe(0n);
  });

  it('снятая и поставленная заново отмена снимает деньги ОБА раза', async () => {
    /*
     * Отмену в источнике снимают: заказ возвращается в работу, его везут ещё
     * раз и он получает новые начисления. Вторая отмена обязана снять и их.
     *
     * Ключ задания «один заказ — одна отмена» держался бы вечно: сообщения
     * очереди не удаляются, повторная постановка вставляла бы ноль строк, и
     * снятие не выполнялось бы никогда — деньги отменённого заказа так и
     * оставались бы за курьером.
     */
    const scenario = await seedScenario({ sum: 400_000, payedSum: 0, perOrderMinor: 20_000n });
    await deliver(scenario);
    expect(await contribution(scenario.orderId)).toBe(380_000n);

    await syncSource(scenario, { sum: 400_000, payedSum: 0, cancelled: true });
    expect(await runQueue(new Date(`${DAY}T12:00:00.000Z`), scenario)).toBe(1);
    expect(await contribution(scenario.orderId)).toBe(0n);

    // Отмену сняли: заказ снова в работе.
    await syncSource(scenario, { sum: 400_000, payedSum: 0 });
    const restored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: scenario.orderId },
      select: { cancelledInSource: true },
    });
    expect(restored.cancelledInSource).toBe(false);

    /*
     * У вернувшегося в работу заказа появляются новые деньги: логист оплатил
     * курьеру попытку. Это обычная ручная операция, привязанная к доставке.
     */
    const logist = await actorFor(['LOGISTICIAN']);
    const attemptId = await activeAttemptOf(scenario);
    await ctx.db.$transaction((tx) =>
      appendEntry(tx, {
        courierUserId: scenario.courierId,
        kind: 'ATTEMPT_FEE',
        amountMinor: 20_000n,
        operationDate: DAY,
        actorUserId: logist.userId,
        reason: 'оплачиваемая попытка после возврата заказа в работу',
        routeId: scenario.routeId,
        orderId: scenario.orderId,
        attemptId,
        idempotencyKey: unique('attempt-fee'),
      }),
    );
    expect(await contribution(scenario.orderId)).toBe(-20_000n);

    // Вторая отмена обязана поставить СВОЁ задание и снять новые деньги.
    await syncSource(scenario, { sum: 400_000, payedSum: 0, cancelled: true });
    expect(await runQueue(new Date(`${NEXT_DAY}T09:00:00.000Z`), scenario)).toBe(1);
    expect(await contribution(scenario.orderId)).toBe(0n);

    /*
     * И ровно два задания на весь заказ: повторные импорты уже отменённого
     * заказа номеров не плодят. Иначе счётчик рос бы от каждого прохода
     * синхронизации, а очередь наполнялась пустой работой.
     */
    await syncSource(scenario, { sum: 400_000, payedSum: 0, cancelled: true });
    await syncSource(scenario, { sum: 400_000, payedSum: 0, cancelled: true });
    expect(
      await ctx.db.outboxMessage.count({
        where: {
          topic: ORDER_FINANCE_TOPIC,
          payload: { path: ['reason'], equals: 'CANCEL' },
          idempotencyKey: { startsWith: `${ORDER_FINANCE_TOPIC}:cancel:${scenario.orderId}:` },
        },
      }),
    ).toBe(2);
    expect(await runQueue(new Date(`${NEXT_DAY}T10:00:00.000Z`), scenario)).toBe(0);

    /*
     * Номер берётся из счётчика заказа, и он вырос ровно дважды.
     *
     * Без этого утверждения проверка не отличила бы «счётчик сработал» от
     * «второе задание встало по другой причине».
     */
    const counted = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: scenario.orderId },
      select: { cancellationCount: true },
    });
    expect(counted.cancellationCount).toBe(2);
    expect(
      await ctx.db.outboxMessage.count({
        where: {
          topic: ORDER_FINANCE_TOPIC,
          idempotencyKey: `${ORDER_FINANCE_TOPIC}:cancel:${scenario.orderId}:2`,
        },
      }),
    ).toBe(1);

    // Исходные записи целы, снятие сделано обратными: 3 начисления — 3 отмены.
    expect(await entryCount(scenario.orderId, 'CASH_RECEIVED')).toBe(1);
    expect(await entryCount(scenario.orderId, 'DELIVERY_FEE')).toBe(1);
    expect(await entryCount(scenario.orderId, 'ATTEMPT_FEE')).toBe(1);
    expect(await entryCount(scenario.orderId, 'ADJUSTMENT')).toBe(3);
  });
});

// --- Сценарий 3: одновременная доставка и денежное задание ---------------------

describe('одновременные доставка и задание источника', () => {
  /**
   * Управляемая гонка на общей блокировке строки заказа.
   *
   * Барьером служит отдельная транзакция, держащая `FOR UPDATE` на строке
   * заказа. Оба участника обязаны встать именно на неё — это проверяется
   * `pg_blocking_pids`, а не ожиданием. Порядок после снятия барьера
   * планировщик выбирает сам: итог обязан быть один и тот же.
   */
  async function raceUnderBarrier(
    scenario: Scenario,
    now: Date,
  ): Promise<{ blocked: number; queued: number }> {
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (): void => undefined;
    const lockedSignal = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const barrier = ctx.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "DeliveryOrder" WHERE "id" = ${scenario.orderId}::uuid FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
    await lockedSignal;

    const delivery = deliver(scenario);
    const queue = runQueue(now, scenario);

    // Оба участника действительно ждут освобождения строки заказа.
    const blocked = await waitForBlocked(2);
    release();
    await barrier;

    const queued = await queue;
    await delivery;
    return { blocked, queued };
  }

  it('оплата, пришедшая одновременно с доставкой, не оставляет лишних наличных', async () => {
    const scenario = await seedScenario({ sum: 500_000, payedSum: 0, perOrderMinor: 30_000n });

    // Источник сообщил полную оплату ДО того, как курьер нажал «Доставлен».
    await syncSource(scenario, { sum: 500_000, payedSum: 500_000 });

    const cursor = await lastEventId();
    const { blocked } = await raceUnderBarrier(scenario, new Date(`${DAY}T14:00:00.000Z`));
    expect(blocked).toBeGreaterThanOrEqual(2);

    /*
     * Событие отчёта — не более одного: либо задание сняло разницу и сообщило
     * об этом, либо снимать было нечего и сообщать не о чем. Двух событий не
     * бывает ни в одном порядке — задание выполняется ровно раз.
     */
    expect((await ledgerEventsAfter(cursor)).length).toBeLessThanOrEqual(1);
    // Результат доставки записан один раз, чем бы гонка ни кончилась.
    expect(
      await ctx.db.deliveryAttempt.count({
        where: { routeOrderId: scenario.routeOrderId, activeKey: { not: null } },
      }),
    ).toBe(1);

    /*
     * Любой порядок даёт одно и то же: либо начисление посчитано уже по новой
     * оплате и снимать нечего, либо задание увидело начисление и сняло разницу.
     */
    const cash =
      (await sumKind(scenario.orderId, 'CASH_RECEIVED')) +
      (await sumKind(scenario.orderId, 'CASH_PAYMENT_CORRECTION'));
    expect(cash).toBe(0n);
    // Работа курьера оплачена в обоих случаях.
    expect(await sumKind(scenario.orderId, 'DELIVERY_FEE')).toBe(-30_000n);
    expect(await contribution(scenario.orderId)).toBe(-30_000n);
  });

  it('отмена, пришедшая одновременно с доставкой, обнуляет вклад заказа', async () => {
    const scenario = await seedScenario({ sum: 500_000, payedSum: 0, perOrderMinor: 30_000n });

    await syncSource(scenario, { sum: 500_000, payedSum: 0, cancelled: true });

    const { blocked } = await raceUnderBarrier(scenario, new Date(`${DAY}T14:30:00.000Z`));
    expect(blocked).toBeGreaterThanOrEqual(2);

    /*
     * Либо доставка успела начислить и снятие отменило начисления, либо
     * начисления не появилось вовсе. Ненулевого вклада не остаётся ни в одном
     * из порядков — именно это и защищает общая блокировка строки заказа.
     */
    expect(await contribution(scenario.orderId)).toBe(0n);
    const report0 = await report(DAY, NEXT_DAY, scenario.courierId);
    expect(report0.totals.closingBalanceMinor).toBe('0');
    expect(report0.totals.deliveryFeesMinor).toBe('0');

    // Отмена зафиксирована аудитом один раз, результат доставки — тоже.
    expect(await auditCount(scenario.orderId, 'ORDER_CANCELLED_IN_SOURCE')).toBe(1);
    expect(
      await ctx.db.deliveryAttempt.count({
        where: { routeOrderId: scenario.routeOrderId, activeKey: { not: null } },
      }),
    ).toBe(1);
  });
});

// --- Сценарий 4: позднее начисление МКАД ---------------------------------------

describe('позднее начисление километров за МКАД', () => {
  it('расстояние, пришедшее после доставки, начисляется догоняющим заданием', async () => {
    const scenario = await seedScenario({
      sum: 300_000,
      payedSum: 300_000,
      perOrderMinor: 30_000n,
      perKmMinor: 4_000n,
    });
    await seedGeo(scenario);
    await deliver(scenario);

    // На момент доставки расстояния не было: километры не начислены.
    expect(await sumKind(scenario.orderId, 'DISTANCE_FEE')).toBe(0n);

    // Valhalla ответила уже после доставки — 12,5 км за МКАД.
    await seedDistance(scenario, 125);
    expect(await runQueue(new Date(`${DAY}T18:00:00.000Z`), scenario)).toBe(1);

    // 40 ₽/км × 12,5 км = 500 ₽; в журнале заработок отрицателен.
    expect(await sumKind(scenario.orderId, 'DISTANCE_FEE')).toBe(-50_000n);
    expect(await entryCount(scenario.orderId, 'DISTANCE_FEE')).toBe(1);

    const day = await report(DAY, DAY, scenario.courierId);
    expect(day.totals.distanceFeesMinor).toBe('50000');
  });

  it('уже начисленные при доставке километры задание не начисляет второй раз', async () => {
    const scenario = await seedScenario({
      sum: 300_000,
      payedSum: 300_000,
      perOrderMinor: 30_000n,
      perKmMinor: 4_000n,
    });
    await seedGeo(scenario);
    // Расстояние известно ДО доставки: начисляет сама доставка.
    await seedDistance(scenario, 125);
    await deliver(scenario);
    expect(await sumKind(scenario.orderId, 'DISTANCE_FEE')).toBe(-50_000n);

    // Задание, поставленное результатом «Доставлен», проходит по тому же
    // заказу. Ключ `attempt:<id>:DISTANCE_FEE` не даёт второй записи.
    expect(await runQueue(new Date(`${DAY}T18:00:00.000Z`), scenario)).toBe(1);
    expect(await entryCount(scenario.orderId, 'DISTANCE_FEE')).toBe(1);
    expect(await sumKind(scenario.orderId, 'DISTANCE_FEE')).toBe(-50_000n);
  });

  it('после отмены поздний расчёт километров не возвращает заказу денег', async () => {
    const scenario = await seedScenario({
      sum: 300_000,
      payedSum: 300_000,
      perOrderMinor: 30_000n,
      perKmMinor: 4_000n,
    });
    await seedGeo(scenario);
    await deliver(scenario);

    // Отмена приходит раньше, чем расстояние.
    await syncSource(scenario, { sum: 300_000, payedSum: 300_000, cancelled: true });
    await seedDistance(scenario, 125);

    // В очереди оба задания: снятие денег отменённого заказа и расчёт МКАД.
    expect(await runQueue(new Date(`${DAY}T18:00:00.000Z`), scenario)).toBe(2);

    // Снимок расстояния остаётся историей, а денег у отменённого заказа нет.
    expect(await sumKind(scenario.orderId, 'DISTANCE_FEE')).toBe(0n);
    expect(await contribution(scenario.orderId)).toBe(0n);
    const days = await report(DAY, NEXT_DAY, scenario.courierId);
    expect(days.totals.distanceFeesMinor).toBe('0');
    expect(days.totals.closingBalanceMinor).toBe('0');
  });
});

// --- Сценарий 5: один набор данных по всей цепочке представления ---------------

describe('один набор данных: журнал → API → дни → период → XLSX → PDF', () => {
  it('суммы, знаки, даты и подписи совпадают на каждом шаге', async () => {
    /*
     * Набор подобран так, чтобы в нём была каждая сторона расчёта: наличные
     * заказа, оплата работы, километры за МКАД, расход, сдача денег логисту и
     * начальный долг. Одинокая категория ничего не доказала бы: путаница
     * возникает именно там, где рядом стоят приход, заработок и долг.
     */
    const scenario = await seedScenario({
      sum: 500_000,
      payedSum: 0,
      perOrderMinor: 30_000n,
      perKmMinor: 4_000n,
    });
    await seedGeo(scenario);
    await seedDistance(scenario, 125);
    await deliver(scenario);

    /*
     * Операции дня, не привязанные к доставке, пишутся тем же `appendEntry`,
     * что и всё остальное: проверяется представление, а не способ ввода.
     */
    const admin = await actorFor(['ADMIN']);
    const manual = [
      { kind: 'OPENING_DEBT' as const, amountMinor: 100_000n, reason: 'долг до перехода на ERP' },
      { kind: 'CASH_HANDED_TO_LOGIST' as const, amountMinor: 200_000n, reason: 'сдача выручки' },
      { kind: 'EXPENSE_PARKING' as const, amountMinor: 10_000n, reason: 'парковка у подъезда' },
    ];
    for (const operation of manual) {
      await ctx.db.$transaction((tx) =>
        appendEntry(tx, {
          courierUserId: scenario.courierId,
          kind: operation.kind,
          amountMinor: operation.amountMinor,
          operationDate: DAY,
          actorUserId: admin.userId,
          reason: operation.reason,
          idempotencyKey: unique(operation.kind),
        }),
      );
    }

    /*
     * Ещё один расход — ПРИВЯЗАННЫЙ к доставке.
     *
     * У отчёта две дороги: запись без попытки показывается журналом дня,
     * а запись своей попытки уходит в строку заказа. Набор без второй дороги
     * не проверил бы согласие строки с итогом дня.
     */
    const attemptId = await activeAttemptOf(scenario);
    await ctx.db.$transaction((tx) =>
      appendEntry(tx, {
        courierUserId: scenario.courierId,
        kind: 'EXPENSE_TOLL',
        amountMinor: 5_000n,
        operationDate: DAY,
        actorUserId: admin.userId,
        reason: 'платная дорога по пути к адресу',
        routeId: scenario.routeId,
        orderId: scenario.orderId,
        attemptId,
        idempotencyKey: unique('EXPENSE_TOLL'),
      }),
    );

    // 1. ЖУРНАЛ. Знак и день каждой записи — то, из чего растёт всё остальное.
    const journal = await ctx.db.courierLedgerEntry.findMany({
      where: { courierUserId: scenario.courierId },
      select: { kind: true, amountMinor: true, operationDate: true },
    });
    const byKind = new Map(journal.map((entry) => [entry.kind, entry.amountMinor]));
    expect(byKind.get('CASH_RECEIVED')).toBe(500_000n);
    expect(byKind.get('DELIVERY_FEE')).toBe(-30_000n);
    expect(byKind.get('DISTANCE_FEE')).toBe(-50_000n);
    expect(byKind.get('OPENING_DEBT')).toBe(100_000n);
    expect(byKind.get('CASH_HANDED_TO_LOGIST')).toBe(-200_000n);
    expect(byKind.get('EXPENSE_PARKING')).toBe(-10_000n);
    expect(byKind.get('EXPENSE_TOLL')).toBe(-5_000n);
    for (const entry of journal) {
      expect(entry.operationDate.toISOString().slice(0, 10)).toBe(DAY);
    }
    // Долг курьера за день: 5000 − 300 − 500 + 1000 − 2000 − 150 = 3050 ₽.
    expect(journal.reduce((total, entry) => total + entry.amountMinor, 0n)).toBe(305_000n);

    // 2. API. Отчёт видит те же операции тем же днём.
    const built = await report(DAY, DAY, scenario.courierId);
    expect(built.period).toEqual({ from: DAY, to: DAY });
    expect(built.entries.map((entry) => entry.operationDate)).toEqual(built.entries.map(() => DAY));
    // `entries` — весь журнал периода, включая записи доставки.
    expect(built.entries.map((entry) => entry.kind).sort()).toEqual([
      'CASH_HANDED_TO_LOGIST',
      'CASH_RECEIVED',
      'DELIVERY_FEE',
      'DISTANCE_FEE',
      'EXPENSE_PARKING',
      'EXPENSE_TOLL',
      'OPENING_DEBT',
    ]);

    // 3. ИТОГ ПЕРИОДА. Каждая категория показана положительной величиной,
    //    кроме корректировок наличных, у которых минус — часть смысла.
    expect(built.totals).toMatchObject({
      openingBalanceMinor: '0',
      cashReceivedMinor: '500000',
      cashCorrectionsMinor: '0',
      handedToLogistMinor: '200000',
      issuedToCourierMinor: '0',
      deliveryFeesMinor: '30000',
      attemptFeesMinor: '0',
      distanceFeesMinor: '50000',
      expensesMinor: '15000',
      bonusesMinor: '0',
      adjustmentsMinor: '0',
      openingDebtMinor: '100000',
      closingBalanceMinor: '305000',
    });

    // 4. ДНЕВНЫЕ ГРУППЫ. Итог дня объясняет изменение баланса целиком.
    expect(built.days).toHaveLength(1);
    const day = built.days[0];
    expect(day?.date).toBe(DAY);
    const group = day?.couriers[0];
    expect(group?.orders).toBe(1);
    expect(group?.sheets).toBe(1);
    expect(group?.cashMinor).toBe('500000');
    expect(group?.deliveryFeesMinor).toBe('30000');
    expect(group?.distanceFeesMinor).toBe('50000');
    expect(group?.distanceKmTenths).toBe(125);
    expect(group?.extraExpensesMinor).toBe('15000');
    expect(group?.handedMinor).toBe('200000');
    expect(group?.issuedMinor).toBe('0');
    // Начислено — заработок дня: 300 + 500 + 150 = 950 ₽.
    expect(group?.accruedMinor).toBe('95000');
    expect(group?.totalMinor).toBe(built.totals.closingBalanceMinor);
    /*
     * Журнал дня — только то, что не легло в строку доставки. Записи самой
     * доставки показаны строкой заказа, и повторять их операциями нельзя:
     * это был бы двойной счёт.
     */
    expect(group?.operations.entries.map((entry) => entry.kind).sort()).toEqual([
      'CASH_HANDED_TO_LOGIST',
      'EXPENSE_PARKING',
      'OPENING_DEBT',
    ]);
    // Начальный долг остался отдельной операцией, а не ушёл в «Доп.».
    expect(group?.extraExpensesMinor).toBe('15000');

    // 5. XLSX. Лист «Итоги» — подписи и рубли, лист «Заказы» — та же группа.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await buildSettlementWorkbook(built)) as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const summary = workbook.getWorksheet('Итоги');
    const named = new Map<string, unknown>();
    summary?.eachRow((row) => named.set(String(row.getCell(1).value ?? ''), row.getCell(2).value));
    expect(named.get('Период')).toBe(`${DAY} — ${DAY}`);
    expect(named.get('Наличные, полученные курьером')).toBe(5000);
    expect(named.get('Базовая оплата доставок')).toBe(300);
    expect(named.get('Километры за МКАД')).toBe(500);
    expect(named.get('Расходы')).toBe(150);
    expect(named.get('Сдано логисту')).toBe(2000);
    expect(named.get('Начальный долг')).toBe(1000);
    expect(named.get('Корректировки наличных (оплата в МойСклад)')).toBe(0);
    expect(named.get('Конечный баланс')).toBe(3050);

    const orders = workbook.getWorksheet('Заказы');
    const dayRow = orders?.getRow(2);
    expect(dayRow?.getCell(1).value).toBe('Итог дня');
    expect(dayRow?.getCell(2).value).toBe(DAY);
    expect(dayRow?.getCell(11).value).toBe(5000); // Наличные
    expect(dayRow?.getCell(14).value).toBe(300); // За заказ
    expect(dayRow?.getCell(15).value).toBe(12.5); // За МКАД, км
    expect(dayRow?.getCell(16).value).toBe(500); // За МКАД, ₽
    expect(dayRow?.getCell(17).value).toBe(150); // Доп.
    expect(dayRow?.getCell(18).value).toBe(950); // Начислено
    expect(dayRow?.getCell(19).value).toBe(2000); // Курьер сдал
    expect(dayRow?.getCell(21).value).toBe(3050); // Итог

    /*
     * Строка заказа: её «Доп.» и «Начислено» обязаны нести привязанный
     * к попытке расход. Без этого сумма строк не сходится с итогом дня,
     * и объяснить разницу человеку нечем.
     */
    const orderRow = orders?.getRow(3);
    expect(orderRow?.getCell(1).value).toBe('Заказ');
    expect(orderRow?.getCell(11).value).toBe(5000); // Наличные
    expect(orderRow?.getCell(14).value).toBe(300); // За заказ
    expect(orderRow?.getCell(16).value).toBe(500); // За МКАД, ₽
    expect(orderRow?.getCell(17).value).toBe(50); // Доп. строки: расход попытки
    expect(orderRow?.getCell(18).value).toBe(850); // Начислено строки
    expect(orderRow?.getCell(21).value).toBe(4150); // Итог строки

    /*
     * 6. PDF. Проверяются те самые подписи и суммы, что уходят на бумагу.
     *
     * Текст из готового файла обратно не разбирается: парсера PDF в проекте
     * нет, а разбор доказывал бы работу чужой библиотеки. Содержимое сводки
     * рождается в `settlementSummaryLines`, и доказывается оно там же; сам
     * файл проверяется как документ — он открывается, у него одна страница
     * и верный заголовок с периодом.
     */
    expect(settlementSummaryLines(built)).toEqual([
      ['Начальный баланс', '0,00 ₽'],
      ['Наличные, полученные курьером', '5000,00 ₽'],
      ['Корректировки наличных', '0,00 ₽'],
      ['Сдано логисту', '2000,00 ₽'],
      ['Выдано курьеру', '0,00 ₽'],
      ['Базовая оплата доставок', '300,00 ₽'],
      ['Оплачиваемые попытки', '0,00 ₽'],
      ['Километры за МКАД', '500,00 ₽'],
      ['Расходы', '150,00 ₽'],
      ['Доплаты', '0,00 ₽'],
      ['Обратные корректировки', '0,00 ₽'],
      ['Начальный долг', '1000,00 ₽'],
    ]);

    const pdfBytes = await buildSettlementPdf(built);
    const reopened = await PDFDocument.load(pdfBytes);
    expect(reopened.getPageCount()).toBe(1);
    expect(reopened.getTitle()).toBe(settlementPdfTitle(built));
    expect(reopened.getTitle()).toContain(DAY);
  });

  it('длинный период продолжается на следующих страницах, а не обрывается', async () => {
    /*
     * Документ состоял ровно из одной страницы, и всё, что на неё не
     * помещалось, просто не печаталось — молча. За период в несколько дней
     * бумажный отчёт оказывался неполным, и сказано об этом не было.
     *
     * Группы выдумываются прямо здесь: проверяется поведение бумаги при
     * большом числе групп, а не расчёт — его доказывают соседние проверки.
     */
    const many = Array.from({ length: 60 }, (_, index) => ({
      date: DAY,
      couriers: [
        {
          courierUserId: `c${index}`,
          fullName: `Курьер ${index}`,
          phone: null,
          sheets: 1,
          orders: 1,
          cashMinor: '0',
          deliveryFeesMinor: '0',
          distanceKmTenths: 0,
          distanceFeesMinor: '0',
          attemptFeesMinor: '0',
          extraExpensesMinor: '0',
          handedMinor: '0',
          issuedMinor: '0',
          accruedMinor: '0',
          totalMinor: '0',
          settlementMissing: false,
          rows: [],
          operations: { count: 0, totalMinor: '0', entries: [] },
        },
      ],
    }));

    const base = await report(DAY, DAY, (await actorFor(['COURIER'])).userId);
    const long = { ...base, days: many };
    const document = await PDFDocument.load(await buildSettlementPdf(long));

    // Шестьдесят групп на одну страницу не помещаются — значит их больше одной.
    expect(document.getPageCount()).toBeGreaterThan(1);

    // Короткий отчёт по-прежнему помещается на одну: лишних страниц не завелось.
    const short = await PDFDocument.load(
      await buildSettlementPdf({ ...base, days: many.slice(0, 3) }),
    );
    expect(short.getPageCount()).toBe(1);

    // Больше групп — больше страниц: разбивка растёт вместе с содержимым.
    const huge = await PDFDocument.load(
      await buildSettlementPdf({ ...base, days: [...many, ...many] }),
    );
    expect(huge.getPageCount()).toBeGreaterThan(document.getPageCount());

    /*
     * Повторная выгрузка того же периода обязана давать тот же файл: иначе
     * «файл изменился» перестаёт что-либо значить. Разбивка на страницы этого
     * свойства лишить не должна.
     */
    const first = await buildSettlementPdf(long);
    const second = await buildSettlementPdf(long);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });
});
