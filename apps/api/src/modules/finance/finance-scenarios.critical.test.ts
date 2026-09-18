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
import {
  cancelDeliveryResult,
  recordDeliveryResult,
  type DeliveryDeps,
} from '../delivery/service.js';
import { processOutboxOnce, type OutboxHandlers } from '../outbox/worker.js';
import { createOrderFinanceHandler, ORDER_FINANCE_TOPIC } from './order-sync.js';
import {
  createMkadDistanceHandler,
  enqueueMkadDistanceForRouteOrder,
  MKAD_DISTANCE_TOPIC,
} from './mkad-auto.js';
import { ensureBundledRing } from './mkad-bundle.js';
import { LEDGER_SETTING_KEY } from './tariffs.js';
import { buildSettlementReport } from './reports.js';
import { appendEntry, balanceOf, reverseEntry } from './ledger.js';
import { restateDistanceFee } from './accrual.js';
import { saveDistanceSnapshot } from './mkad.js';
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
  /*
   * Настоящее кольцо МКАД из поставки: обработчик расстояния ищет версию по
   * контрольной сумме файла, и выдуманное кольцо ему не подходит.
   */
  await ensureBundledRing(ctx.db);
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
async function runQueue(
  now: Date,
  scenario: Scenario,
  /** Ответ маршрутизатора, когда обработчик обязан посчитать заново. */
  routed?: { meters: number },
): Promise<number> {
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
      router:
        routed === undefined
          ? {
              configured: false,
              route: async () => ({ distanceMeters: null }),
            }
          : {
              configured: true,
              route: async () => ({ distanceMeters: routed.meters }),
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

/**
 * Наличные, числящиеся за курьером по заказу СЕЙЧАС.
 *
 * Начисление плюс корректировки после оплаты, без отменённых записей: именно
 * эту цифру человек видит в строке отчёта.
 */
async function cashOf(orderId: string): Promise<bigint> {
  const result = await ctx.db.courierLedgerEntry.aggregate({
    where: {
      orderId,
      kind: { in: ['CASH_RECEIVED', 'CASH_PAYMENT_CORRECTION'] },
      reversedBy: { is: null },
    },
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
async function seedDistance(
  scenario: Scenario,
  kmTenths: number,
  /*
   * Автоматический снимок отличается от ручного: у него есть координаты, по
   * которым он посчитан, и нет причины. Обработчик смены координат ручную
   * правку не перетирает, поэтому проверять его можно только на COMPUTED.
   */
  computed?: { lat: number; lon: number },
): Promise<void> {
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

  /*
   * Снимок ставится ТОЙ ЖЕ функцией, что и боевой путь: она гасит прежний
   * действующий снимок. Прямая вставка второй раз упиралась бы в уникальность
   * `activeKey` — то есть проверка правки километров была бы невозможна.
   */
  await saveDistanceSnapshot(ctx.db, {
    routeOrderId: scenario.routeOrderId,
    ringVersionId: ring.id,
    graphSha256: null,
    meters: kmTenths * 100,
    insideMkad: false,
    ...(computed === undefined
      ? {
          source: 'MANUAL' as const,
          actorUserId: admin.userId,
          reason: 'проверка позднего начисления',
        }
      : {
          source: 'COMPUTED' as const,
          targetLatMicro: computed.lat,
          targetLonMicro: computed.lon,
        }),
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
     * У вернувшегося в работу заказа появляются новые деньги: Valhalla
     * ответила позже доставки, и система начислила километры за МКАД.
     */
    const attemptId = await activeAttemptOf(scenario);
    await ctx.db.$transaction((tx) =>
      appendEntry(tx, {
        courierUserId: scenario.courierId,
        kind: 'DISTANCE_FEE',
        amountMinor: 20_000n,
        operationDate: DAY,
        actorUserId: scenario.courierId,
        reason: 'километры за МКАД после возврата заказа в работу',
        routeId: scenario.routeId,
        orderId: scenario.orderId,
        attemptId,
        idempotencyKey: unique('distance-late'),
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
    expect(await entryCount(scenario.orderId, 'DISTANCE_FEE')).toBe(1);
    expect(await entryCount(scenario.orderId, 'ADJUSTMENT')).toBe(3);
  });

  it('отмена заказа не снимает ручную операцию логиста', async () => {
    /*
     * Снимается только то, что система начислила сама по результату доставки.
     * Расход курьера логист одобрил руками — эти деньги уже потрачены, и
     * отмена заказа в источнике их не возвращает. Снимать чужое решение молча
     * нельзя: отменить его вправе тот же человек, отдельным действием.
     */
    const scenario = await seedScenario({ sum: 300_000, payedSum: 0, perOrderMinor: 20_000n });
    await deliver(scenario);

    const logist = await actorFor(['LOGISTICIAN']);
    const attemptId = await activeAttemptOf(scenario);
    await ctx.db.$transaction((tx) =>
      appendEntry(tx, {
        courierUserId: scenario.courierId,
        kind: 'EXPENSE_PARKING',
        amountMinor: 15_000n,
        operationDate: DAY,
        actorUserId: logist.userId,
        reason: 'парковка у адреса, одобрено логистом',
        routeId: scenario.routeId,
        orderId: scenario.orderId,
        attemptId,
        idempotencyKey: unique('manual-expense'),
      }),
    );

    await syncSource(scenario, { sum: 300_000, payedSum: 0, cancelled: true });
    expect(await runQueue(new Date(`${DAY}T13:00:00.000Z`), scenario)).toBe(1);

    // Начисления доставки сняты, а одобренный расход остался действующим.
    expect(await sumKind(scenario.orderId, 'CASH_RECEIVED')).toBe(0n);
    expect(await sumKind(scenario.orderId, 'DELIVERY_FEE')).toBe(0n);
    expect(await sumKind(scenario.orderId, 'EXPENSE_PARKING')).toBe(-15_000n);
    // Вклад заказа — ровно этот расход, и ничего больше.
    expect(await contribution(scenario.orderId)).toBe(-15_000n);
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
    /*
     * Столбцы берутся по ЗАГОЛОВКУ, а не по номеру: номер в проверке повторял
     * бы число из кода, и вставка столбца уехала бы незамеченной обеими
     * сторонами.
     */
    const columns = (orders?.getRow(1).values as unknown[]).map((name) => String(name ?? ''));
    const at = (row: ExcelJS.Row | undefined, header: string): unknown =>
      row?.getCell(columns.indexOf(header)).value;

    const dayRow = orders?.getRow(2);
    expect(dayRow?.getCell(1).value).toBe('Итог дня');
    expect(at(dayRow, 'Дата')).toBe(DAY);
    expect(at(dayRow, 'Наличные, ₽')).toBe(5000);
    expect(at(dayRow, 'За заказ, ₽')).toBe(300);
    expect(at(dayRow, 'За МКАД, км')).toBe(12.5);
    expect(at(dayRow, 'За МКАД, ₽')).toBe(500);
    expect(at(dayRow, 'За попытку, ₽')).toBe(0);
    expect(at(dayRow, 'Доп., ₽')).toBe(150);
    expect(at(dayRow, 'Начислено, ₽')).toBe(950);
    expect(at(dayRow, 'Курьер сдал, ₽')).toBe(2000);
    expect(at(dayRow, 'Начальный долг, ₽')).toBe(1000);
    expect(at(dayRow, 'Итог, ₽')).toBe(3050);
    /*
     * «Начислено» раскладывается на видимые столбцы файла.
     *
     * Пока столбца попытки не было, эта сумма не сходилась ни с чем, и
     * объяснить разницу в файле было нечем.
     */
    expect(at(dayRow, 'Начислено, ₽')).toBe(
      (at(dayRow, 'За заказ, ₽') as number) +
        (at(dayRow, 'За МКАД, ₽') as number) +
        (at(dayRow, 'За попытку, ₽') as number) +
        (at(dayRow, 'Доп., ₽') as number),
    );

    /*
     * Строка заказа: её «Доп.» и «Начислено» обязаны нести привязанный
     * к попытке расход. Без этого сумма строк не сходится с итогом дня,
     * и объяснить разницу человеку нечем.
     */
    const orderRow = orders?.getRow(3);
    expect(orderRow?.getCell(1).value).toBe('Заказ');
    expect(at(orderRow, 'Наличные, ₽')).toBe(5000);
    expect(at(orderRow, 'За заказ, ₽')).toBe(300);
    expect(at(orderRow, 'За МКАД, ₽')).toBe(500);
    expect(at(orderRow, 'Доп., ₽')).toBe(50); // расход, привязанный к попытке
    expect(at(orderRow, 'Начислено, ₽')).toBe(850);
    expect(at(orderRow, 'Итог, ₽')).toBe(4150);

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
          openingDebtMinor: '0',
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

/**
 * Строка обязана сходиться САМА С СОБОЙ: километры × ставка = её деньги.
 *
 * Именно эта арифметика ломалась во всех прошлых вариантах: километры брались
 * из одного среза времени, деньги — из другого, и человек видел «20 км ·
 * 500 ₽» при ставке 40 ₽/км.
 */
function expectRowConsistent(row: {
  beyondMkadKmTenths: number | null;
  perKmMinor: string | null;
  distanceFeeMinor: string;
}): void {
  const km = BigInt(row.beyondMkadKmTenths ?? 0);
  const perKm = BigInt(row.perKmMinor ?? '0');
  expect(BigInt(row.distanceFeeMinor)).toBe((perKm * km) / 10n);
}

// --- Сценарий: правка километров после доставки --------------------------------

describe('исправленные километры и деньги за них', () => {
  it('правка километров отражается ДНЁМ ИСПРАВЛЕНИЯ и не переписывает день доставки', async () => {
    /*
     * Правка, сделанная сегодня, не меняет итоги закрытого дня — по тому же
     * правилу, по которому живут все остальные отмены в модуле. Связь с
     * доставкой держат маршрут, заказ и попытка, а строка доставки показывает
     * километры, ПО КОТОРЫМ начислены деньги, и называет текущий расчёт
     * отдельно. Иначе строка показывала «20,0 км · 500,00 ₽» при ставке
     * 40 ₽/км — арифметику, не сходящуюся ни с чем.
     */
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_000n });
    await seedGeo(scenario);
    await seedDistance(scenario, 125);
    await deliver(scenario);

    const before = await report(DAY, DAY, scenario.courierId);
    expect(before.rows[0]?.beyondMkadKmTenths).toBe(125);
    expect(before.rows[0]?.currentKmTenths).toBeNull();
    // 12,5 км × 40 ₽ = 500 ₽.
    expect(BigInt(before.totals.distanceFeesMinor)).toBe(50_000n);

    /*
     * Автоматический пересчёт уточнил расстояние — деньги он не трогает.
     * Строка по-прежнему сходится сама с собой, а новый расчёт назван рядом.
     */
    await seedDistance(scenario, 200);
    const stale = await report(DAY, DAY, scenario.courierId);
    expect(stale.rows[0]?.beyondMkadKmTenths).toBe(125);
    expect(stale.rows[0]?.currentKmTenths).toBe(200);
    expect(BigInt(stale.totals.distanceFeesMinor)).toBe(50_000n);

    // Решение человека: пересчитать деньги, датой исправления.
    const admin = await actorFor(['ADMIN']);
    const changed = await ctx.db.$transaction((tx) =>
      restateDistanceFee(tx, {
        routeOrderId: scenario.routeOrderId,
        actorUserId: admin.userId,
        reason: 'Правка километров: маршрут построен по неверной точке',
        operationDate: NEXT_DAY,
      }),
    );
    expect(changed).toBe(true);

    // День доставки не изменился ни в одном показателе.
    const afterDelivery = await report(DAY, DAY, scenario.courierId);
    expect(afterDelivery.totals).toEqual(stale.totals);

    // Разница живёт в дне исправления: −500 ₽ снято, +800 ₽ начислено.
    const correction = await report(NEXT_DAY, NEXT_DAY, scenario.courierId);
    expect(BigInt(correction.totals.distanceFeesMinor)).toBe(30_000n);

    /*
     * Строка ДНЯ ДОСТАВКИ остаётся исторической: 12,5 км × 40 ₽ = 500 ₽.
     * Корректировка назад не переносится — она живёт в своём дне, и это её
     * единственное место. А пометки «расчёт уточнён» больше нет: оплаченные
     * километры сошлись с текущим расчётом.
     */
    const both = await report(DAY, NEXT_DAY, scenario.courierId);
    const row = both.rows[0]!;
    expect(row.beyondMkadKmTenths).toBe(125);
    expect(BigInt(row.distanceFeeMinor)).toBe(50_000n);
    expectRowConsistent(row);
    expect(row.currentKmTenths).toBeNull();
    // Итог периода при этом настоящий: 500 ₽ дня доставки + 300 ₽ правки.
    expect(BigInt(both.totals.distanceFeesMinor)).toBe(80_000n);

    // История цела: прежнее начисление снято обратной записью, а не стёрто.
    const entries = await ctx.db.courierLedgerEntry.findMany({
      where: { courierUserId: scenario.courierId, kind: 'DISTANCE_FEE' },
      select: { amountMinor: true, reversedBy: { select: { id: true } } },
    });
    expect(entries).toHaveLength(2);
    expect(entries.filter((entry) => entry.reversedBy !== null)).toHaveLength(1);

    expect(await balanceOf(ctx.db, scenario.courierId, NEXT_DAY)).toBe(
      BigInt(both.totals.closingBalanceMinor),
    );
  });

  it('автоматический пересчёт уточняет километры, но денег не трогает', async () => {
    /*
     * Ручной путь — не единственный: снимок обновляют и обработчик смены
     * координат, и пересчёт маршрута. Деньги меняет ТОЛЬКО решение человека,
     * поэтому автоматический пересчёт оставляет оплаченное как есть, а
     * расхождение строка называет прямо. Проверяется настоящий обработчик
     * очереди, а не прямой вызов пересчёта.
     */
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_000n });
    await seedGeo(scenario);
    // Снимок автоматический и посчитан по нынешней точке заказа.
    await seedDistance(scenario, 125, { lat: 55_200_000, lon: 37_200_000 });
    await deliver(scenario);
    expect(BigInt((await report(DAY, DAY, scenario.courierId)).totals.distanceFeesMinor)).toBe(
      50_000n,
    );

    /*
     * Точку заказа уточнили — координаты другие, значит прежний снимок
     * обработчику не подходит и он считает заново.
     */
    await ctx.db.deliveryOrder.update({
      where: { id: scenario.orderId },
      data: { geoLatMicro: 55_400_000, geoLonMicro: 37_400_000 },
    });
    await ctx.db.$transaction((tx) => enqueueMkadDistanceForRouteOrder(tx, scenario.routeOrderId));
    // Заданий может быть и больше одного: важен их итог, а не число.
    expect(
      await runQueue(new Date(`${DAY}T19:00:00.000Z`), scenario, { meters: 20_000 }),
    ).toBeGreaterThan(0);

    const active = await ctx.db.routeOrderDistance.findFirstOrThrow({
      where: { routeOrderId: scenario.routeOrderId, activeKey: { not: null } },
      select: { roundedKmTenths: true, source: true },
    });
    expect(active.source).toBe('COMPUTED');
    expect(active.roundedKmTenths).toBe(200);

    const built = await report(DAY, DAY, scenario.courierId);
    // Деньги прежние, строка сходится с ними, а новый расчёт назван отдельно.
    expect(BigInt(built.totals.distanceFeesMinor)).toBe(50_000n);
    expect(built.rows[0]?.beyondMkadKmTenths).toBe(125);
    expect(built.rows[0]?.currentKmTenths).toBe(200);
  });

  it('обнуление километров не мешает начислить их заново', async () => {
    /*
     * Признаком «финансовый результат снят» служило то, что все системные
     * начисления отменены. У полностью оплаченного заказа с нулевой ставкой за
     * заказ единственное начисление — километры, и правка их в ноль делала это
     * условие истинным. Дальше правка в 20 км уже не начисляла ничего: в
     * отчёте стояли 20 км и 0 ₽ вместо 800 ₽.
     */
    const scenario = await seedScenario({
      sum: 100_000,
      payedSum: 100_000,
      perOrderMinor: 0n,
      perKmMinor: 4_000n,
    });
    await seedGeo(scenario);
    await seedDistance(scenario, 125);
    await deliver(scenario);
    const admin = await actorFor(['ADMIN']);

    const restate = (operationDate: string): Promise<boolean> =>
      ctx.db.$transaction((tx) =>
        restateDistanceFee(tx, {
          routeOrderId: scenario.routeOrderId,
          actorUserId: admin.userId,
          reason: 'Правка километров: уточнение маршрута',
          operationDate,
        }),
      );

    // Единственным начислением заказа остаются километры.
    expect(BigInt((await report(DAY, DAY, scenario.courierId)).totals.distanceFeesMinor)).toBe(
      50_000n,
    );

    await seedDistance(scenario, 0);
    expect(await restate(NEXT_DAY)).toBe(true);
    expect(await balanceOf(ctx.db, scenario.courierId, NEXT_DAY)).toBe(0n);

    // И заново: обычное обнуление снятым результатом не является.
    await seedDistance(scenario, 200);
    expect(await restate(NEXT_DAY)).toBe(true);

    const built = await report(DAY, NEXT_DAY, scenario.courierId);
    // Итог периода — 800 ₽, а строка дня доставки остаётся исторической.
    expect(BigInt(built.totals.distanceFeesMinor)).toBe(80_000n);
    expect(built.rows[0]?.beyondMkadKmTenths).toBe(125);
    expectRowConsistent(built.rows[0]!);
    expect(built.rows[0]?.currentKmTenths).toBeNull();
  });

  it('возврат к прежним километрам начисляет заново, а не оживляет снятую запись', async () => {
    /*
     * Ключ идемпотентности брался из самих километров, и правка
     * 12,5 → 20,0 → 12,5 → 20,0 на четвёртом шаге попадала в УЖЕ ОТМЕНЁННУЮ
     * запись: вместо нового начисления возвращалась снятая, и курьер оставался
     * без денег при исправленных километрах на экране.
     */
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_000n });
    await seedGeo(scenario);
    await seedDistance(scenario, 125);
    await deliver(scenario);
    const admin = await actorFor(['ADMIN']);

    const restate = (): Promise<boolean> =>
      ctx.db.$transaction((tx) =>
        restateDistanceFee(tx, {
          routeOrderId: scenario.routeOrderId,
          actorUserId: admin.userId,
          reason: 'Правка километров: уточнение маршрута',
          operationDate: NEXT_DAY,
        }),
      );

    for (const km of [200, 125, 200]) {
      await seedDistance(scenario, km);
      expect(await restate()).toBe(true);
    }

    // Правки живут в дне исправления, поэтому период берётся целиком.
    const built = await report(DAY, NEXT_DAY, scenario.courierId);
    // Итог периода — 800 ₽; строка дня доставки историческая и согласованная.
    expect(built.rows[0]?.beyondMkadKmTenths).toBe(125);
    expectRowConsistent(built.rows[0]!);
    expect(built.rows[0]?.currentKmTenths).toBeNull();
    expect(BigInt(built.totals.distanceFeesMinor)).toBe(80_000n);
    expect(await balanceOf(ctx.db, scenario.courierId, NEXT_DAY)).toBe(
      BigInt(built.totals.closingBalanceMinor),
    );

    // Непогашенной осталась ровно одна запись километров.
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: {
          courierUserId: scenario.courierId,
          kind: 'DISTANCE_FEE',
          reversedBy: { is: null },
        },
      }),
    ).toBe(1);
  });

  it('ручная правка до расчёта Valhalla не даёт оплатить километры дважды', async () => {
    /*
     * Доставку отмечают РАНЬШЕ, чем посчитано расстояние: Valhalla недоступна,
     * задание висит в очереди. Записи километров нет — и базовый ключ
     * начисления свободен. Логист ставит километры руками, правка их
     * оплачивает. Позже задание выполняется, ручной снимок признаётся
     * подходящим (перетирать его нельзя) — и догоняющее начисление платило те
     * же километры ВТОРОЙ раз: 246 ₽ вместо 123 ₽ за одну доставку.
     */
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_000n });
    await seedGeo(scenario);
    // Расстояния ещё нет: доставка фиксируется до ответа маршрутизатора.
    await deliver(scenario);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { courierUserId: scenario.courierId, kind: 'DISTANCE_FEE' },
      }),
    ).toBe(0);

    // Задание на расчёт стоит в очереди — оно и придёт «догоняющим».
    await ctx.db.$transaction((tx) => enqueueMkadDistanceForRouteOrder(tx, scenario.routeOrderId));

    // Логист ставит километры руками, и правка их оплачивает.
    await seedDistance(scenario, 125);
    const admin = await actorFor(['ADMIN']);
    expect(
      await ctx.db.$transaction((tx) =>
        restateDistanceFee(tx, {
          routeOrderId: scenario.routeOrderId,
          actorUserId: admin.userId,
          reason: 'Правка километров: маршрутизатор не ответил',
          // Правка в день доставки: расхождения между днями здесь не проверяем.
          operationDate: DAY,
        }),
      ),
    ).toBe(true);

    // Valhalla поднялась, задание выполняется.
    expect(await runQueue(new Date(`${DAY}T18:00:00.000Z`), scenario)).toBe(1);

    const built = await report(DAY, DAY, scenario.courierId);
    // 12,5 км × 40 ₽ = 500 ₽ — ровно один раз.
    expect(BigInt(built.totals.distanceFeesMinor)).toBe(50_000n);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: {
          courierUserId: scenario.courierId,
          kind: 'DISTANCE_FEE',
          reversedBy: { is: null },
        },
      }),
    ).toBe(1);
    expect(await balanceOf(ctx.db, scenario.courierId, DAY)).toBe(
      BigInt(built.totals.closingBalanceMinor),
    );
  });

  it('после снятой отмены правка километров не оживляет деньги по частям', async () => {
    /*
     * Отмена в источнике снимает все начисления, а снятие отмены денег не
     * возвращает — это решение принимает человек. Правка километров в этом
     * состоянии заводила оплату ОДНИХ километров: заказ, за который заплачены
     * только они, без оплаты доставки и без наличных.
     */
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_000n });
    await seedGeo(scenario);
    await seedDistance(scenario, 125);
    await deliver(scenario);

    // Отмена в источнике снимает финансовый результат.
    await syncSource(scenario, { sum: 100_000, payedSum: 0, cancelled: true });
    // Заданий может быть и два (снятие денег и корректировка оплаты): важно,
    // что после них финансового результата у заказа не осталось.
    expect(await runQueue(new Date(`${DAY}T15:00:00.000Z`), scenario)).toBeGreaterThan(0);
    expect(await balanceOf(ctx.db, scenario.courierId, DAY)).toBe(0n);

    // Отмену снимают, но деньги сами не возвращаются.
    await syncSource(scenario, { sum: 100_000, payedSum: 0 });
    expect(await balanceOf(ctx.db, scenario.courierId, DAY)).toBe(0n);

    await seedDistance(scenario, 200);
    const admin = await actorFor(['ADMIN']);
    const changed = await ctx.db.$transaction((tx) =>
      restateDistanceFee(tx, {
        routeOrderId: scenario.routeOrderId,
        actorUserId: admin.userId,
        reason: 'Правка километров после снятой отмены',
        operationDate: NEXT_DAY,
      }),
    );

    expect(changed).toBe(false);
    // Баланс прежний: по частям деньги не оживают.
    expect(await balanceOf(ctx.db, scenario.courierId, DAY)).toBe(0n);
  });

  it('повторная правка тем же значением денег не трогает', async () => {
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_000n });
    await seedGeo(scenario);
    await seedDistance(scenario, 125);
    await deliver(scenario);
    const admin = await actorFor(['ADMIN']);

    const first = await ctx.db.$transaction((tx) =>
      restateDistanceFee(tx, {
        routeOrderId: scenario.routeOrderId,
        actorUserId: admin.userId,
        reason: 'Правка километров: без изменений',
        operationDate: NEXT_DAY,
      }),
    );
    // Километры те же — пересчитывать нечего, и обратной записи не появляется.
    expect(first).toBe(false);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { courierUserId: scenario.courierId, kind: 'DISTANCE_FEE' },
      }),
    ).toBe(1);
  });

  it('отменённому в источнике заказу правка километров денег не возвращает', async () => {
    /*
     * Финансовый результат отменённого заказа уже снят. Правка километров —
     * не повод вернуть его обратно: иначе деньги оживали бы у заказа, которого
     * в расчётах нет.
     */
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_000n });
    await seedGeo(scenario);
    await seedDistance(scenario, 125);
    await deliver(scenario);
    await ctx.db.deliveryOrder.update({
      where: { id: scenario.orderId },
      // Инвариант базы: отмена — это пара «признак и время».
      data: { cancelledInSource: true, cancelledInSourceAt: new Date(`${DAY}T12:00:00.000Z`) },
    });

    await seedDistance(scenario, 200);
    const admin = await actorFor(['ADMIN']);
    const changed = await ctx.db.$transaction((tx) =>
      restateDistanceFee(tx, {
        routeOrderId: scenario.routeOrderId,
        actorUserId: admin.userId,
        reason: 'Правка километров после отмены',
        operationDate: NEXT_DAY,
      }),
    );

    expect(changed).toBe(false);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { courierUserId: scenario.courierId, kind: 'DISTANCE_FEE' },
      }),
    ).toBe(1);
  });
});

// --- Сценарий: повторная оплата после новой доставки --------------------------

describe('та же сумма оплаты после новой доставки', () => {
  it('ставит НОВОЕ задание и снижает наличные новой попытки', async () => {
    /*
     * Ключ задания состоял из заказа и величины оплаты, а выполненные
     * сообщения очереди не удаляются — значит ключ занимался навсегда.
     * Последовательность «оплата 2000 → отмена результата → новая доставка →
     * снова оплата 2000» второго задания не ставила: за новой доставкой
     * оставались все 5000 наличных вместо 3000.
     */
    const scenario = await seedScenario({ sum: 500_000, payedSum: 0, perOrderMinor: 20_000n });
    await deliver(scenario);
    expect(await contribution(scenario.orderId)).toBe(500_000n - 20_000n);

    // 1. Источник сообщает оплату 2000 ₽ — наличных остаётся 3000 ₽.
    await syncSource(scenario, { sum: 500_000, payedSum: 200_000 });
    expect(await runQueue(new Date(`${DAY}T12:00:00.000Z`), scenario)).toBe(1);
    expect(await cashOf(scenario.orderId)).toBe(300_000n);

    // 2. Результат доставки отменяют: системные проводки снимаются.
    const attempt = await ctx.db.deliveryAttempt.findFirstOrThrow({
      where: { routeOrderId: scenario.routeOrderId, activeKey: { not: null } },
      select: { id: true },
    });
    const logist = await actorFor(['LOGISTICIAN']);
    await cancelDeliveryResult(
      deliveryDeps,
      logist,
      attempt.id,
      { reason: 'ошибочная отметка' },
      CONTEXT,
    );
    expect(await contribution(scenario.orderId)).toBe(0n);

    // 3. Оплату в источнике убирают: само по себе это ничего не возвращает.
    await syncSource(scenario, { sum: 500_000, payedSum: 0 });
    await runQueue(new Date(`${DAY}T13:00:00.000Z`), scenario);

    // 4. Заказ везут заново: новая попытка законно начисляет 5000 ₽ наличных.
    await deliver(scenario);
    expect(await cashOf(scenario.orderId)).toBe(500_000n);

    // 5. Источник снова сообщает те же 2000 ₽.
    await syncSource(scenario, { sum: 500_000, payedSum: 200_000 });
    expect(await runQueue(new Date(`${DAY}T14:00:00.000Z`), scenario)).toBe(1);

    // За новой доставкой остаётся 3000 ₽, а не 5000 ₽.
    expect(await cashOf(scenario.orderId)).toBe(300_000n);
  });

  it('повторный импорт того же снимка задания не ставит и денег не создаёт', async () => {
    /*
     * Обратная сторона номера события: он растёт только на РОСТЕ оплаты.
     * Иначе каждый проход импорта ставил бы новое задание, а чинили мы ровно
     * противоположную ошибку.
     */
    const scenario = await seedScenario({ sum: 500_000, payedSum: 0, perOrderMinor: 20_000n });
    await deliver(scenario);

    await syncSource(scenario, { sum: 500_000, payedSum: 200_000 });
    expect(await runQueue(new Date(`${DAY}T12:00:00.000Z`), scenario)).toBe(1);
    const afterFirst = await cashOf(scenario.orderId);

    // Тот же снимок ещё дважды: роста нет — заданий нет.
    await syncSource(scenario, { sum: 500_000, payedSum: 200_000 });
    await syncSource(scenario, { sum: 500_000, payedSum: 200_000 });
    expect(await runQueue(new Date(`${DAY}T12:30:00.000Z`), scenario)).toBe(0);
    expect(await cashOf(scenario.orderId)).toBe(afterFirst);
  });
});

// --- Продолжения сценариев из приёмки -----------------------------------------

describe('километры новой доставки после старой отмены заказа', () => {
  it('старая отмена не блокирует правку километров новой, законной доставки', async () => {
    /*
     * Признаком «финансовый результат снят» служил счётчик отмен ЗАКАЗА. Он
     * относится ко всей истории заказа, поэтому исправление работало только для
     * заказов, которые никогда не отменяли: у новой, законной доставки логист
     * исправлял 12,5 → 0 → 20 км и получал 0 ₽ вместо 800 ₽.
     */
    const scenario = await seedScenario({
      sum: 100_000,
      payedSum: 100_000,
      perOrderMinor: 0n,
      perKmMinor: 4_000n,
    });
    await seedGeo(scenario);
    await seedDistance(scenario, 125);
    await deliver(scenario);

    // 1. Заказ отменяют в источнике: финансовый результат снимается.
    await syncSource(scenario, { sum: 100_000, payedSum: 100_000, cancelled: true });
    expect(await runQueue(new Date(`${DAY}T11:00:00.000Z`), scenario)).toBeGreaterThan(0);
    expect(await balanceOf(ctx.db, scenario.courierId, DAY)).toBe(0n);

    // 2. Отмену снимают, прежний результат доставки отменяет логист.
    await syncSource(scenario, { sum: 100_000, payedSum: 100_000 });
    const oldAttempt = await ctx.db.deliveryAttempt.findFirstOrThrow({
      where: { routeOrderId: scenario.routeOrderId, activeKey: { not: null } },
      select: { id: true },
    });
    const logist = await actorFor(['LOGISTICIAN']);
    await cancelDeliveryResult(
      deliveryDeps,
      logist,
      oldAttempt.id,
      { reason: 'заказ вернули в работу' },
      CONTEXT,
    );

    // 3. Заказ везут заново — новая попытка законно получает 500 ₽ за 12,5 км.
    await deliver(scenario);
    expect(await balanceOf(ctx.db, scenario.courierId, DAY)).toBe(-50_000n);

    // 4. У НОВОЙ попытки логист исправляет километры: 12,5 → 0 → 20.
    const admin = await actorFor(['ADMIN']);
    const restate = (): Promise<boolean> =>
      ctx.db.$transaction((tx) =>
        restateDistanceFee(tx, {
          routeOrderId: scenario.routeOrderId,
          actorUserId: admin.userId,
          reason: 'Правка километров новой доставки',
          operationDate: NEXT_DAY,
        }),
      );

    await seedDistance(scenario, 0);
    expect(await restate()).toBe(true);
    await seedDistance(scenario, 200);
    expect(await restate()).toBe(true);

    // 20,0 км × 40 ₽ = 800 ₽: старая отмена новой доставке не мешает.
    const built = await report(DAY, NEXT_DAY, scenario.courierId);
    expect(BigInt(built.totals.distanceFeesMinor)).toBe(80_000n);
    expect(await balanceOf(ctx.db, scenario.courierId, NEXT_DAY)).toBe(-80_000n);
  });

  it('действительно снятую попытку правка километров не оживляет', async () => {
    /*
     * Обратная сторона того же признака: у попытки, чьи деньги сняла отмена
     * заказа, правка километров ничего не возвращает — даже когда отмену
     * в источнике уже сняли.
     */
    const scenario = await seedScenario({
      sum: 100_000,
      payedSum: 100_000,
      perOrderMinor: 0n,
      perKmMinor: 4_000n,
    });
    await seedGeo(scenario);
    await seedDistance(scenario, 125);
    await deliver(scenario);

    await syncSource(scenario, { sum: 100_000, payedSum: 100_000, cancelled: true });
    expect(await runQueue(new Date(`${DAY}T11:00:00.000Z`), scenario)).toBeGreaterThan(0);
    await syncSource(scenario, { sum: 100_000, payedSum: 100_000 });

    // Результат доставки НЕ отменяли: попытка та же, деньги сняты отменой заказа.
    await seedDistance(scenario, 200);
    const admin = await actorFor(['ADMIN']);
    const changed = await ctx.db.$transaction((tx) =>
      restateDistanceFee(tx, {
        routeOrderId: scenario.routeOrderId,
        actorUserId: admin.userId,
        reason: 'Правка километров снятой попытки',
        operationDate: NEXT_DAY,
      }),
    );

    expect(changed).toBe(false);
    expect(await balanceOf(ctx.db, scenario.courierId, NEXT_DAY)).toBe(0n);
  });
});

describe('дробная ставка за километр', () => {
  it('километры не восстанавливаются из округлённой суммы и ложной пометки нет', async () => {
    /*
     * При ставке 40,01 ₽/км 12,5 км дают 500,12 ₽ после округления в копейках.
     * Обратная формула «сумма ÷ ставка» возвращала 12,4 км, и отчёт сообщал
     * «расчёт уточнён: 12,5 км» там, где километры никто не менял.
     */
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_001n });
    await seedGeo(scenario);
    await seedDistance(scenario, 125);
    await deliver(scenario);

    const built = await report(DAY, DAY, scenario.courierId);
    const row = built.rows[0]!;
    // 12,5 км × 40,01 ₽ = 500,12 ₽ — ровно то, что начислено.
    expect(row.beyondMkadKmTenths).toBe(125);
    expect(BigInt(row.distanceFeeMinor)).toBe(50_012n);
    expectRowConsistent(row);
    // И никакой пометки: никто ничего не уточнял.
    expect(row.currentKmTenths).toBeNull();
  });
});

describe('рассчитанный ноль километров', () => {
  it('позднее уточнение нуля денег не меняет: это решение человека', async () => {
    /*
     * Ноль километров — завершённый расчёт (адрес внутри МКАД), а не его
     * отсутствие. Автоматика начисляла по нему 800 ₽ днём доставки, никого не
     * спросив: при ненулевых километрах действовало одно правило, при нулевых —
     * другое.
     */
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_000n });
    await seedGeo(scenario);
    // Честный нулевой расчёт на момент доставки.
    await seedDistance(scenario, 0, { lat: 55_200_000, lon: 37_200_000 });
    await deliver(scenario);
    expect(await entryCount(scenario.orderId, 'DISTANCE_FEE')).toBe(0);

    // Позже координаты уточнили, автоматический расчёт даёт 20 км.
    await ctx.db.deliveryOrder.update({
      where: { id: scenario.orderId },
      data: { geoLatMicro: 55_400_000, geoLonMicro: 37_400_000 },
    });
    await ctx.db.$transaction((tx) => enqueueMkadDistanceForRouteOrder(tx, scenario.routeOrderId));
    expect(
      await runQueue(new Date(`${DAY}T19:00:00.000Z`), scenario, { meters: 20_000 }),
    ).toBeGreaterThan(0);

    // Снимок обновился, денег автоматика не завела.
    const active = await ctx.db.routeOrderDistance.findFirstOrThrow({
      where: { routeOrderId: scenario.routeOrderId, activeKey: { not: null } },
      select: { roundedKmTenths: true },
    });
    expect(active.roundedKmTenths).toBe(200);
    expect(await entryCount(scenario.orderId, 'DISTANCE_FEE')).toBe(0);
    // За курьером только наличные заказа: километров ему не начислили.
    expect(await balanceOf(ctx.db, scenario.courierId, DAY)).toBe(100_000n);

    // Решение человека деньги заводит — и своим днём.
    const admin = await actorFor(['ADMIN']);
    expect(
      await ctx.db.$transaction((tx) =>
        restateDistanceFee(tx, {
          routeOrderId: scenario.routeOrderId,
          actorUserId: admin.userId,
          reason: 'Правка километров: расчёт уточнён',
          operationDate: NEXT_DAY,
        }),
      ),
    ).toBe(true);
    expect(
      BigInt((await report(NEXT_DAY, NEXT_DAY, scenario.courierId)).totals.distanceFeesMinor),
    ).toBe(80_000n);
  });

  it('а отсутствовавший расчёт по-прежнему начисляется догоняющим', async () => {
    /*
     * Штатный случай не должен пострадать: маршрутизатор не ответил к моменту
     * доставки, снимка не было вовсе — позднее начисление обязано сработать.
     */
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_000n });
    await seedGeo(scenario);
    await deliver(scenario);
    expect(await entryCount(scenario.orderId, 'DISTANCE_FEE')).toBe(0);

    await ctx.db.$transaction((tx) => enqueueMkadDistanceForRouteOrder(tx, scenario.routeOrderId));
    expect(
      await runQueue(new Date(`${DAY}T19:00:00.000Z`), scenario, { meters: 20_000 }),
    ).toBeGreaterThan(0);

    // 20,0 км × 40 ₽ = 800 ₽ — днём доставки, как и было задумано.
    expect(BigInt((await report(DAY, DAY, scenario.courierId)).totals.distanceFeesMinor)).toBe(
      80_000n,
    );
  });
});

describe('совместимость ключей очереди оплаты', () => {
  it('ключ прежнего формата не выдаёт новое событие за выполненное', async () => {
    /*
     * Прежний ключ отличался от нового только смыслом последнего числа: оплата
     * в одну копейку давала ровно тот же ключ, что событие номер один. На
     * обновлении существующей очереди первое же новое задание считалось бы
     * выполненным, и наличные новой доставки остались бы несниженными.
     */
    const scenario = await seedScenario({ sum: 500_000, payedSum: 0, perOrderMinor: 20_000n });
    await deliver(scenario);

    // В очереди уже лежит ВЫПОЛНЕННОЕ сообщение прежнего формата.
    await ctx.db.outboxMessage.create({
      data: {
        topic: ORDER_FINANCE_TOPIC,
        idempotencyKey: `${ORDER_FINANCE_TOPIC}:payment:${scenario.orderId}:1`,
        payload: { reason: 'PAYMENT', orderId: scenario.orderId },
        status: 'DONE',
      },
    });

    // Первое новое событие оплаты — задание ставится и выполняется.
    await syncSource(scenario, { sum: 500_000, payedSum: 200_000 });
    expect(await runQueue(new Date(`${DAY}T12:00:00.000Z`), scenario)).toBe(1);
    expect(await cashOf(scenario.orderId)).toBe(300_000n);
  });
});

// --- Приёмка 57ff861: километры строки и переход со старых данных ---------------

describe('правка километров в день доставки', () => {
  it('километры строки — итоговые, а не сумма всех правок', async () => {
    /*
     * Деньги дня учитывают отмену, а километры складывались по всем записям
     * подряд: 12,5 → 20 давали «32,5 км · 800 ₽», а несколько правок — 65 км.
     * Сумма верна, километры — нет, и строка снова не сходится сама с собой.
     */
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_000n });
    await seedGeo(scenario);
    await seedDistance(scenario, 125);
    await deliver(scenario);
    const admin = await actorFor(['ADMIN']);

    const restate = (): Promise<boolean> =>
      ctx.db.$transaction((tx) =>
        restateDistanceFee(tx, {
          routeOrderId: scenario.routeOrderId,
          actorUserId: admin.userId,
          reason: 'Правка километров в тот же день',
          // ДЕНЬ ДОСТАВКИ: правка и её отмена ложатся в ту же строку.
          operationDate: DAY,
        }),
      );

    await seedDistance(scenario, 200);
    expect(await restate()).toBe(true);

    const once = await report(DAY, DAY, scenario.courierId);
    expect(once.rows[0]?.beyondMkadKmTenths).toBe(200);
    expect(BigInt(once.rows[0]!.distanceFeeMinor)).toBe(80_000n);
    expectRowConsistent(once.rows[0]!);
    // Дневная группа складывается из строк и обязана показывать те же 20,0 км.
    expect(once.days[0]?.couriers[0]?.distanceKmTenths).toBe(200);

    // Ещё две правки туда-обратно — итог всё тот же.
    await seedDistance(scenario, 125);
    expect(await restate()).toBe(true);
    await seedDistance(scenario, 200);
    expect(await restate()).toBe(true);

    const repeated = await report(DAY, DAY, scenario.courierId);
    expect(repeated.rows[0]?.beyondMkadKmTenths).toBe(200);
    expect(BigInt(repeated.rows[0]!.distanceFeeMinor)).toBe(80_000n);
    expectRowConsistent(repeated.rows[0]!);
    expect(repeated.days[0]?.couriers[0]?.distanceKmTenths).toBe(200);
  });

  it('полная отмена километров в тот же день оставляет ноль, а не прежние километры', async () => {
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_000n });
    await seedGeo(scenario);
    await seedDistance(scenario, 125);
    await deliver(scenario);
    const admin = await actorFor(['ADMIN']);

    await seedDistance(scenario, 0);
    expect(
      await ctx.db.$transaction((tx) =>
        restateDistanceFee(tx, {
          routeOrderId: scenario.routeOrderId,
          actorUserId: admin.userId,
          reason: 'Правка километров: адрес внутри МКАД',
          operationDate: DAY,
        }),
      ),
    ).toBe(true);

    const built = await report(DAY, DAY, scenario.courierId);
    expect(built.rows[0]?.beyondMkadKmTenths).toBe(0);
    expect(BigInt(built.rows[0]!.distanceFeeMinor)).toBe(0n);
    expect(built.rows[0]?.currentKmTenths).toBeNull();
  });
});

describe('что именно показывает строка про километры', () => {
  it('рассчитанный ноль после уточнения назван уточнением, а не оплаченными километрами', async () => {
    /*
     * Деньги автоматика правильно не трогает, но отчёт показывал «20 км · 0 ₽»
     * без единого слова о том, что это лишь новый расчёт. Живой снимок не
     * должен выдаваться за оплаченные километры.
     */
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_000n });
    await seedGeo(scenario);
    await seedDistance(scenario, 0, { lat: 55_200_000, lon: 37_200_000 });
    await deliver(scenario);

    await ctx.db.deliveryOrder.update({
      where: { id: scenario.orderId },
      data: { geoLatMicro: 55_400_000, geoLonMicro: 37_400_000 },
    });
    await ctx.db.$transaction((tx) => enqueueMkadDistanceForRouteOrder(tx, scenario.routeOrderId));
    expect(
      await runQueue(new Date(`${DAY}T19:00:00.000Z`), scenario, { meters: 20_000 }),
    ).toBeGreaterThan(0);

    const built = await report(DAY, DAY, scenario.courierId);
    const row = built.rows[0]!;
    // Оплачено ноль километров — это и показано, а 20,0 названы уточнением.
    expect(row.beyondMkadKmTenths).toBe(0);
    expect(BigInt(row.distanceFeeMinor)).toBe(0n);
    expect(row.currentKmTenths).toBe(200);
    expect(row.distanceBasisUnknown).toBe(false);
  });

  it('нерассчитанное расстояние остаётся нерассчитанным, а не нулём', async () => {
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_000n });
    await seedGeo(scenario);
    await deliver(scenario);

    const row = (await report(DAY, DAY, scenario.courierId)).rows[0]!;
    expect(row.beyondMkadKmTenths).toBeNull();
    expect(row.currentKmTenths).toBeNull();
  });

  it('у прежних начислений основание названо неизвестным, а не подменено снимком', async () => {
    /*
     * У записей, начисленных до появления колонки, километров нет. Подставлять
     * им действующий снимок нельзя: строка показывала «20 км · 500 ₽» — чужие
     * километры рядом с прежними деньгами и без предупреждения.
     */
    const scenario = await seedScenario({ sum: 100_000, payedSum: 0, perKmMinor: 4_000n });
    await seedGeo(scenario);
    await deliver(scenario);

    /*
     * Фикстура прежних данных: начисление километров БЕЗ их величины — ровно
     * так писала версия до появления поля. Записи журнала неизменяемы, поэтому
     * прежнее состояние именно создаётся, а не правится.
     */
    const attempt = await ctx.db.deliveryAttempt.findFirstOrThrow({
      where: { routeOrderId: scenario.routeOrderId, activeKey: { not: null } },
      select: { id: true },
    });
    const admin = await actorFor(['ADMIN']);
    await ctx.db.$transaction((tx) =>
      appendEntry(tx, {
        courierUserId: scenario.courierId,
        kind: 'DISTANCE_FEE',
        amountMinor: 50_000n,
        operationDate: DAY,
        actorUserId: admin.userId,
        routeId: scenario.routeId,
        orderId: scenario.orderId,
        attemptId: attempt.id,
        idempotencyKey: unique('legacy-distance'),
      }),
    );
    await seedDistance(scenario, 200);

    const row = (await report(DAY, DAY, scenario.courierId)).rows[0]!;
    expect(row.distanceBasisUnknown).toBe(true);
    expect(row.beyondMkadKmTenths).toBeNull();
    expect(BigInt(row.distanceFeeMinor)).toBe(50_000n);
    expect(row.currentKmTenths).toBe(200);
  });
});

describe('защита снятой попытки на прежних данных', () => {
  it('отмена без сохранённой причины тоже закрывает финансовый результат', async () => {
    /*
     * У отмен, созданных прежней версией, причины нет вовсе. NULL означает
     * «причина неизвестна», а не «отмены не было»: иначе после обновления
     * правка километров возвращала 800 ₽ попытке, деньги которой сняты.
     */
    const scenario = await seedScenario({
      sum: 100_000,
      payedSum: 100_000,
      perOrderMinor: 0n,
      perKmMinor: 4_000n,
    });
    await seedGeo(scenario);
    await seedDistance(scenario, 125);
    await deliver(scenario);

    /*
     * Фикстура прежних данных: отмена заказа сняла деньги ДО появления поля
     * причины, поэтому обратная запись есть, а причины у неё нет. Отметки на
     * попытке тоже нет — её тогда не существовало.
     */
    const accrual = await ctx.db.courierLedgerEntry.findFirstOrThrow({
      where: { orderId: scenario.orderId, kind: 'DISTANCE_FEE' },
      select: { id: true, amountMinor: true, routeId: true, attemptId: true },
    });
    await ctx.db.courierLedgerEntry.create({
      data: {
        courierUserId: scenario.courierId,
        kind: 'ADJUSTMENT',
        amountMinor: -accrual.amountMinor,
        operationDate: new Date(`${DAY}T00:00:00.000Z`),
        actorUserId: (await actorFor(['ADMIN'])).userId,
        reason: 'Отмена в МойСклад: заказ исключён из расчётов с курьером',
        routeId: accrual.routeId,
        orderId: scenario.orderId,
        attemptId: accrual.attemptId,
        reversesEntryId: accrual.id,
        idempotencyKey: `reversal:${accrual.id}`,
      },
    });

    await seedDistance(scenario, 200);
    const admin = await actorFor(['ADMIN']);
    const changed = await ctx.db.$transaction((tx) =>
      restateDistanceFee(tx, {
        routeOrderId: scenario.routeOrderId,
        actorUserId: admin.userId,
        reason: 'Правка километров после обновления',
        operationDate: NEXT_DAY,
      }),
    );

    expect(changed).toBe(false);
    expect(await balanceOf(ctx.db, scenario.courierId, NEXT_DAY)).toBe(0n);
  });

  it('отмена заказа с НУЛЕВЫМ результатом тоже закрывает попытку', async () => {
    /*
     * Событие отмены не должно зависеть от того, нашлась ли ненулевая проводка
     * для сторно. Иначе попытка, обнулённая до отмены, после снятия отмены
     * снова получала деньги.
     */
    const scenario = await seedScenario({
      sum: 100_000,
      payedSum: 100_000,
      perOrderMinor: 0n,
      perKmMinor: 4_000n,
    });
    await seedGeo(scenario);
    await seedDistance(scenario, 125);
    await deliver(scenario);
    const admin = await actorFor(['ADMIN']);

    // Результат попытки обнулён ещё ДО отмены заказа.
    await seedDistance(scenario, 0);
    expect(
      await ctx.db.$transaction((tx) =>
        restateDistanceFee(tx, {
          routeOrderId: scenario.routeOrderId,
          actorUserId: admin.userId,
          reason: 'Правка километров: адрес внутри МКАД',
          operationDate: DAY,
        }),
      ),
    ).toBe(true);
    expect(await balanceOf(ctx.db, scenario.courierId, DAY)).toBe(0n);

    // Заказ отменяют и отмену снимают.
    await syncSource(scenario, { sum: 100_000, payedSum: 100_000, cancelled: true });
    expect(await runQueue(new Date(`${DAY}T11:00:00.000Z`), scenario)).toBeGreaterThan(0);
    await syncSource(scenario, { sum: 100_000, payedSum: 100_000 });

    await seedDistance(scenario, 200);
    const changed = await ctx.db.$transaction((tx) =>
      restateDistanceFee(tx, {
        routeOrderId: scenario.routeOrderId,
        actorUserId: admin.userId,
        reason: 'Правка километров снятой попытки',
        operationDate: NEXT_DAY,
      }),
    );

    expect(changed).toBe(false);
    expect(await balanceOf(ctx.db, scenario.courierId, NEXT_DAY)).toBe(0n);
  });
});
