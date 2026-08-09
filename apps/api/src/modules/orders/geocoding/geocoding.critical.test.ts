/**
 * Критические проверки геокодирования: очередь, обработчик и защита от устаревшего результата.
 *
 * Настоящих обращений к DaData здесь нет: клиент подменён функцией. Проверяются
 * свойства, нарушение которых опасно, — отсутствие запросов вне production,
 * транзакционность постановки, дедупликация, аренда заданий, ограниченный
 * backoff и то, что ответ, вернувшийся после изменения заказа, не перезаписывает
 * ни новый адрес, ни решение человека.
 */

import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from '../../auth/testing/harness.js';
import { loadConfig } from '../../../platform/config.js';
import { resolveTestDatabaseUrl } from '../../../platform/testing/test-database.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from '../../integrations/moysklad/config.js';
import { applyOrderSnapshot } from '../../integrations/moysklad/import-service.js';
import { mapOrder, type OrderSnapshot } from '../../integrations/moysklad/mapper.js';
import { DadataError } from '../../integrations/dadata/client.js';
import type { DadataAddress } from '../../integrations/dadata/dto.js';
import { shouldGeocodeAutomatically } from './enabled.js';
import { backfillGeocoding, isGeocodable, retryDelayMs, RETRY_DELAYS_MS } from './queue.js';
import {
  createGeocodeWorker,
  decideResult,
  GEOCODE_LOCK_KEY,
  processGeocodingOnce,
  staleReason,
  type GeocodeWorkerDeps,
  type Geocoder,
} from './worker.js';
import { DADATA_PROVIDER } from './status.js';
import {
  MIN_REQUEST_INTERVAL_MS,
  PROVIDER_STATE_ID,
  readProviderState,
  reserveRequestSlot,
} from './provider-state.js';

let ctx: TestContext;
const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;
/**
 * Настоящее «сейчас».
 *
 * Дата из будущего здесь недопустима: задание становится готовым по
 * `nextAttemptAt <= now`, и заказ, «созданный» завтра, обработчик не увидел бы
 * никогда — а тест показывал бы это как отсутствие результата.
 */
const NOW = new Date();

/** Синтетический адрес: настоящих адресов клиентов в тестах нет. */
const ADDRESS = 'Москва, синтетическая улица, дом 1';
const OTHER_ADDRESS = 'Москва, другая синтетическая улица, дом 2';

const EXACT: DadataAddress = { geo_lat: '55.751244', geo_lon: '37.618423', qc_geo: '0' };

const logger = pino({ level: 'silent' });

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    name: `Q-${process.hrtime.bigint() % 1_000_000n}`,
    updated: '2026-08-12 10:00:00.000',
    shipmentAddress: ADDRESS,
    deliveryPlannedMoment: '2026-08-12 12:00:00.000',
    sum: 499000,
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
      { id: IDS.intervalAttribute, value: 'с 16:00 по 19:00' },
      { id: IDS.recipientAttribute, value: 'Получатель Синтетический' },
    ],
    ...overrides,
  };
}

function snapshotOf(overrides: Record<string, unknown> = {}): OrderSnapshot {
  return mapOrder(source(overrides) as never, IDS).snapshot;
}

/** Импорт с включённым геокодированием: так работает production. */
async function apply(snapshot: OrderSnapshot, at = NOW) {
  return ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, at, { geocoding: true }));
}

async function seedOrder(overrides: Record<string, unknown> = {}) {
  const snapshot = snapshotOf(overrides);
  await apply(snapshot);
  return {
    snapshot,
    order: await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    }),
  };
}

/**
 * Откладывает чужие задания.
 *
 * База общая для всех критических тестов, и другие файлы тоже создают заказы,
 * а значит и задания. Проход берёт готовые задания без разбора, поэтому перед
 * проверкой все посторонние отодвигаются в будущее: иначе проверка измеряла бы
 * порядок запуска файлов, а не поведение обработчика.
 */
async function isolateJobs(orderIds: string[]): Promise<void> {
  await ctx.db.orderGeocodeJob.updateMany({
    where: { status: { in: ['PENDING', 'PROCESSING'] }, orderId: { notIn: orderIds } },
    data: {
      status: 'PENDING',
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
}

interface FakeGeocoder extends Geocoder {
  calls: string[];
  maxInFlight: number;
}

/** Поддельный геокодер. Настоящих сетевых обращений в тестах не бывает. */
function fakeGeocoder(
  handler: (address: string, call: number) => Promise<DadataAddress> | DadataAddress,
): FakeGeocoder {
  const calls: string[] = [];
  let inFlight = 0;
  const state = { maxInFlight: 0 };

  return {
    calls,
    get maxInFlight() {
      return state.maxInFlight;
    },
    async cleanAddress(address: string) {
      calls.push(address);
      inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, inFlight);
      try {
        return await handler(address, calls.length);
      } finally {
        inFlight -= 1;
      }
    },
  };
}

function workerDeps(
  client: Geocoder,
  overrides: Partial<GeocodeWorkerDeps> = {},
): GeocodeWorkerDeps {
  return {
    db: ctx.db,
    logger,
    client,
    lock: { connectionString: ctx.config.DATABASE_URL, key: GEOCODE_LOCK_KEY },
    workerId: `test-${randomUUID()}`,
    // Ожидание общего слота подменяется: проверяется расчёт интервала,
    // а не способность теста простоять секунду на каждом запросе.
    slot: { sleep: async () => undefined },
    ...overrides,
  };
}

/**
 * Возвращает общее состояние провайдера в исходное.
 *
 * Остановка и пауза живут в базе и переживают отдельный тест намеренно —
 * именно этого от них и ждут в production. Поэтому проверки, которым нужен
 * работающий провайдер, начинают с явного сброса.
 */
async function resetProviderState(): Promise<void> {
  await ctx.db.geocodingProviderState.update({
    where: { id: PROVIDER_STATE_ID },
    data: {
      haltedReason: null,
      haltedAt: null,
      nextRequestAllowedAt: new Date(Date.now() - 60_000),
    },
  });
}

async function jobOf(orderId: string) {
  return ctx.db.orderGeocodeJob.findFirstOrThrow({
    where: { orderId },
    orderBy: { geoGeneration: 'desc' },
  });
}

// ---------------------------------------------------------------------------

describe('окружение: вне production обращений не бывает', () => {
  const base = {
    DATABASE_URL: resolveTestDatabaseUrl(),
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...TEST_SECRETS,
  };

  it('автоматическое геокодирование включается только при всех четырёх условиях', () => {
    const production = loadConfig({
      ...base,
      APP_ENV: 'production',
      APP_ENVIRONMENT_MARKER: 'production',
      DADATA_API_KEY: 'key',
      DADATA_SECRET_KEY: 'secret',
      DADATA_GEOCODING_ENABLED: 'true',
    });
    expect(shouldGeocodeAutomatically(production)).toBe(true);

    // Ни одно окружение, кроме production, не создаёт клиент и worker.
    for (const env of ['local', 'staging'] as const) {
      const config = loadConfig({ ...base, APP_ENV: env, APP_ENVIRONMENT_MARKER: env });
      expect(shouldGeocodeAutomatically(config), env).toBe(false);
    }

    // Production без ключей и без флага тоже не обращается никуда.
    const noKeys = loadConfig({
      ...base,
      APP_ENV: 'production',
      APP_ENVIRONMENT_MARKER: 'production',
    });
    expect(shouldGeocodeAutomatically(noKeys)).toBe(false);
  });

  it('ключи вне production запрещают запуск, а не молча игнорируются', () => {
    for (const env of ['local', 'staging'] as const) {
      expect(() =>
        loadConfig({ ...base, APP_ENV: env, APP_ENVIRONMENT_MARKER: env, DADATA_API_KEY: 'key' }),
      ).toThrow(/DADATA_API_KEY/);

      expect(() =>
        loadConfig({
          ...base,
          APP_ENV: env,
          APP_ENVIRONMENT_MARKER: env,
          DADATA_GEOCODING_ENABLED: 'true',
        }),
      ).toThrow(/DADATA_GEOCODING_ENABLED/);
    }
  });

  it('смешанный маркер окружения запрещён', () => {
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'production',
        APP_ENVIRONMENT_MARKER: 'staging',
        DADATA_API_KEY: 'key',
        DADATA_SECRET_KEY: 'secret',
      }),
    ).toThrow();
  });

  it('включённое геокодирование требует обоих ключей', () => {
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'production',
        APP_ENVIRONMENT_MARKER: 'production',
        DADATA_API_KEY: 'key',
        DADATA_GEOCODING_ENABLED: 'true',
      }),
    ).toThrow(/DADATA_SECRET_KEY/);
  });

  it('тестовая конфигурация геокодирование не включает', () => {
    expect(shouldGeocodeAutomatically(ctx.config)).toBe(false);
    expect(ctx.config.DADATA_API_KEY).toBeUndefined();
  });
});

describe('постановка в очередь', () => {
  it('новый заказ с адресом переводится в PENDING и получает задание', async () => {
    const { order } = await seedOrder();

    expect(order.geoState).toBe('PENDING');
    expect(order.geoGeneration).toBe(1);

    const job = await jobOf(order.id);
    expect(job.status).toBe('PENDING');
    expect(job.geoGeneration).toBe(1);
    expect(job.attempts).toBe(0);

    const history = await ctx.db.orderGeoHistory.findMany({ where: { orderId: order.id } });
    expect(history).toHaveLength(1);
    expect(history[0]?.kind).toBe('GEOCODE_REQUESTED');
    expect(history[0]?.state).toBe('PENDING');
  });

  it('в задании нет адреса ни в одном поле', async () => {
    const { order } = await seedOrder();
    const job = await jobOf(order.id);

    const text = JSON.stringify(job);
    expect(text).not.toContain('синтетическая улица');
    expect(text).not.toContain(ADDRESS);
    // Задание ссылается на заказ и поколение — этого достаточно.
    expect(Object.keys(job)).not.toContain('address');
  });

  it('пустой адрес наружу не отправляется', async () => {
    const { order } = await seedOrder({ shipmentAddress: null });

    expect(order.geoState).toBe('UNRESOLVED');
    expect(await ctx.db.orderGeocodeJob.count({ where: { orderId: order.id } })).toBe(0);
    expect(await ctx.db.orderGeoHistory.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('заказ вне области, архивный и пропавший в очередь не попадают', () => {
    const base = {
      id: randomUUID(),
      address: ADDRESS,
      inScope: true,
      sourceArchived: false,
      sourceMissing: false,
      geoState: 'UNRESOLVED' as const,
      geoSource: null,
      geoGeneration: 0,
    };

    expect(isGeocodable(base)).toBe(true);
    expect(isGeocodable({ ...base, inScope: false })).toBe(false);
    expect(isGeocodable({ ...base, sourceArchived: true })).toBe(false);
    expect(isGeocodable({ ...base, sourceMissing: true })).toBe(false);
    expect(isGeocodable({ ...base, address: null })).toBe(false);
    expect(isGeocodable({ ...base, address: '   ' })).toBe(false);
    // Решение человека автоматика не переспрашивает.
    expect(isGeocodable({ ...base, geoState: 'RESOLVED', geoSource: 'MANUAL' })).toBe(false);
    // А точку геокодера — да: она могла устареть.
    expect(isGeocodable({ ...base, geoState: 'RESOLVED', geoSource: 'DADATA' })).toBe(true);
  });

  it('заказ вне нашей области задания не получает', async () => {
    const snapshot = snapshotOf({ store: { meta: { href: href('store', randomUUID()) } } });
    await apply(snapshot);

    const stored = await ctx.db.deliveryOrder.findUnique({
      where: { externalId: snapshot.externalId },
    });
    // Чужой заказ вовсе не создаётся, а значит и задания нет.
    expect(stored).toBeNull();
  });

  it('повтор того же снимка не создаёт второе задание', async () => {
    const { snapshot, order } = await seedOrder();

    await apply(snapshot);
    await apply(snapshot);

    expect(await ctx.db.orderGeocodeJob.count({ where: { orderId: order.id } })).toBe(1);
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoGeneration).toBe(1);
  });

  it('смена адреса растит поколение и создаёт новое задание', async () => {
    const { snapshot, order } = await seedOrder();

    await apply({
      ...snapshot,
      address: OTHER_ADDRESS,
      externalUpdated: '2026-08-12 14:00:00.000',
    });

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoGeneration).toBe(2);
    expect(stored.geoState).toBe('PENDING');

    const jobs = await ctx.db.orderGeocodeJob.findMany({
      where: { orderId: order.id },
      orderBy: { geoGeneration: 'asc' },
    });
    expect(jobs.map((job) => job.geoGeneration)).toEqual([1, 2]);
  });

  it('дедупликацию держит база: одно поколение — одно задание', async () => {
    const { order } = await seedOrder();

    await expect(
      ctx.db.orderGeocodeJob.create({
        data: { orderId: order.id, geoGeneration: 1, maxAttempts: 5 },
      }),
    ).rejects.toThrow();
  });

  it('без включённого геокодирования очередь не наполняется', async () => {
    const snapshot = snapshotOf();
    // Так работают local, CI и staging: обрабатывать очередь там некому,
    // и заказ, навсегда застрявший в «Определяется», врал бы логисту.
    await ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, NOW));

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    expect(stored.geoState).toBe('UNRESOLVED');
    expect(stored.geoGeneration).toBe(0);
    expect(await ctx.db.orderGeocodeJob.count({ where: { orderId: stored.id } })).toBe(0);
    expect(await ctx.db.orderGeoHistory.count({ where: { orderId: stored.id } })).toBe(0);
  });

  it('откат бизнес-транзакции убирает и задание', async () => {
    const snapshot = snapshotOf();

    await expect(
      ctx.db.$transaction(async (tx) => {
        await applyOrderSnapshot(tx, snapshot, NOW, { geocoding: true });
        throw new Error('сбой в середине бизнес-операции');
      }),
    ).rejects.toThrow('сбой в середине');

    const stored = await ctx.db.deliveryOrder.findUnique({
      where: { externalId: snapshot.externalId },
    });
    expect(stored).toBeNull();
    // Задание не могло пережить откат: оно пишется той же транзакцией.
    expect(
      await ctx.db.orderGeocodeJob.count({ where: { order: { externalId: snapshot.externalId } } }),
    ).toBe(0);
  });
});

describe('обработка задания', () => {
  it('точный дом становится точкой заказа, историей, аудитом и событием', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder(() => EXACT);
    const result = await processGeocodingOnce(workerDeps(client));

    expect(result.skippedBusy).toBe(false);
    expect(result.resolved).toBe(1);
    expect(client.calls).toEqual([ADDRESS]);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoState).toBe('RESOLVED');
    expect(stored.geoSource).toBe('DADATA');
    expect(stored.geoPrecision).toBe('EXACT_HOUSE');
    expect(stored.geoLatMicro).toBe(55_751_244);
    expect(stored.geoLonMicro).toBe(37_618_423);
    expect(stored.version).toBe(order.version + 1);

    const job = await jobOf(order.id);
    expect(job.status).toBe('DONE');
    expect(job.finishedAt).not.toBeNull();
    expect(job.lockedBy).toBeNull();

    const history = await ctx.db.orderGeoHistory.findMany({
      where: { orderId: order.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(history.map((entry) => entry.kind)).toEqual(['GEOCODE_REQUESTED', 'GEOCODE_RESOLVED']);

    const audit = await ctx.db.auditLog.findMany({
      where: { entityId: order.id, action: 'ORDER_GEO_RESOLVED' },
    });
    expect(audit).toHaveLength(1);
  });

  it('неточный результат не сохраняет координат и зовёт человека', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder(() => ({ geo_lat: '55.7', geo_lon: '37.6', qc_geo: '1' }));
    const result = await processGeocodingOnce(workerDeps(client));

    expect(result.lowPrecision).toBe(1);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoState).toBe('NEEDS_REVIEW');
    expect(stored.geoReviewReason).toBe('LOW_PRECISION');
    // Координата «ближайшего дома» не сохраняется вовсе.
    expect(stored.geoLatMicro).toBeNull();
    expect(stored.geoSource).toBeNull();

    const history = await ctx.db.orderGeoHistory.findMany({ where: { orderId: order.id } });
    expect(history.map((entry) => entry.kind)).toContain('GEOCODE_LOW_PRECISION');
  });

  it('точкой считается только qc_geo = 0', () => {
    expect(decideResult(EXACT)).toMatchObject({ kind: 'RESOLVED' });
    expect(decideResult({ ...EXACT, qc_geo: 0 })).toMatchObject({ kind: 'RESOLVED' });

    for (const qc of ['1', '2', '3', '4', '5', null, undefined, '', 'нет']) {
      expect(decideResult({ ...EXACT, qc_geo: qc as never }), String(qc)).toMatchObject({
        kind: 'LOW_PRECISION',
      });
    }

    // Точность заявлена, а координат нет либо они невозможны.
    expect(decideResult({ geo_lat: null, geo_lon: null, qc_geo: '0' })).toMatchObject({
      kind: 'LOW_PRECISION',
    });
    expect(decideResult({ geo_lat: '95.0', geo_lon: '37.6', qc_geo: '0' })).toMatchObject({
      kind: 'LOW_PRECISION',
    });
    expect(decideResult({ geo_lat: '', geo_lon: '37.6', qc_geo: '0' })).toMatchObject({
      kind: 'LOW_PRECISION',
    });
  });

  it('сетевой отказ повторяется с ограниченным backoff', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const now = new Date(Date.now() + 1000);
    const client = fakeGeocoder(() => {
      throw new DadataError('SERVER_ERROR', 500);
    });

    const result = await processGeocodingOnce(workerDeps(client, { now: () => now }));
    expect(result.retried).toBe(1);

    const job = await jobOf(order.id);
    expect(job.status).toBe('PENDING');
    expect(job.attempts).toBe(1);
    expect(job.lastErrorCode).toBe('SERVER_ERROR');
    expect(job.nextAttemptAt.getTime()).toBe(now.getTime() + RETRY_DELAYS_MS[0]);

    // Заказ не тронут: одна неудача не повод объявлять адрес неразрешимым.
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoState).toBe('PENDING');
  });

  it('backoff ограничен таблицей и не растёт бесконечно', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
    expect(retryDelayMs(4)).toBe(300_000);
    expect(retryDelayMs(5)).toBe(900_000);
    expect(retryDelayMs(50)).toBe(900_000);
  });

  it('429 с Retry-After откладывает ровно на указанный срок', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const now = new Date(Date.now() + 1000);
    const client = fakeGeocoder(() => {
      throw new DadataError('RATE_LIMITED', 429, 42_000);
    });

    await processGeocodingOnce(workerDeps(client, { now: () => now }));

    const job = await jobOf(order.id);
    // Указание сервиса важнее нашей таблицы: спорить с чужим лимитом бессмысленно.
    expect(job.nextAttemptAt.getTime()).toBe(now.getTime() + 42_000);
  });

  it('429 без Retry-After откладывает на безопасную задержку из таблицы', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const now = new Date(Date.now() + 1000);
    const client = fakeGeocoder(() => {
      throw new DadataError('RATE_LIMITED', 429, null);
    });

    await processGeocodingOnce(workerDeps(client, { now: () => now }));

    const job = await jobOf(order.id);
    expect(job.nextAttemptAt.getTime()).toBe(now.getTime() + RETRY_DELAYS_MS[0]);
  });

  it('исчерпание повторов переводит заказ в FAILED с причиной провайдера', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    // Последняя попытка: дальше повторять нечего.
    await ctx.db.orderGeocodeJob.updateMany({
      where: { orderId: order.id },
      data: { attempts: 4, maxAttempts: 5 },
    });

    const client = fakeGeocoder(() => {
      throw new DadataError('TRANSPORT_ERROR');
    });
    const result = await processGeocodingOnce(workerDeps(client));
    expect(result.failed).toBe(1);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoState).toBe('FAILED');
    expect(stored.geoReviewReason).toBe('PROVIDER_FAILED');
    expect(stored.geoLatMicro).toBeNull();

    const job = await jobOf(order.id);
    expect(job.status).toBe('FAILED');

    const history = await ctx.db.orderGeoHistory.findMany({ where: { orderId: order.id } });
    expect(history.map((entry) => entry.kind)).toContain('GEOCODE_FAILED');

    const audit = await ctx.db.auditLog.findMany({
      where: { entityId: order.id, action: 'ORDER_GEO_FAILED' },
    });
    expect(audit).toHaveLength(1);
    // Даже здесь наружу уходит только технический код.
    expect(JSON.stringify(audit[0]?.newValue)).not.toContain(ADDRESS);
  });

  it('отказ авторизации не тратит попытки: виновата конфигурация, а не адрес', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder(() => {
      throw new DadataError('UNAUTHORIZED', 401);
    });
    await processGeocodingOnce(workerDeps(client));

    // Задание возвращается нетронутым: причина отказа относится к ключу,
    // а не к адресу, и живёт в общем состоянии провайдера.
    const job = await jobOf(order.id);
    expect(job.status).toBe('PENDING');
    expect(job.attempts).toBe(0);
    expect(job.lockedBy).toBeNull();

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoState).toBe('PENDING');

    const state = await readProviderState(ctx.db);
    expect(state.haltedReason).toBe('UNAUTHORIZED');

    const status = await ctx.db.integrationStatus.findUniqueOrThrow({
      where: { provider: DADATA_PROVIDER },
    });
    expect(status.state).toBe('ERROR');
  });

  it('запросы идут строго по одному и последовательно', async () => {
    const first = await seedOrder();
    const second = await seedOrder();
    const third = await seedOrder();
    const ids = [first.order.id, second.order.id, third.order.id];
    await isolateJobs(ids);
    await resetProviderState();

    const client = fakeGeocoder(async () => {
      // Уступаем управление: при параллельной обработке счётчик это заметит.
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      return EXACT;
    });

    const result = await processGeocodingOnce(workerDeps(client));

    expect(result.resolved).toBe(3);
    expect(client.maxInFlight).toBe(1);
    expect(client.calls).toHaveLength(3);
  });
});

describe('устаревший результат и гонки', () => {
  it('чистая функция распознаёт все причины устаревания', () => {
    const order = {
      id: 'x',
      address: ADDRESS,
      inScope: true,
      sourceArchived: false,
      sourceMissing: false,
      geoState: 'PENDING' as const,
      geoSource: null,
      geoGeneration: 2,
      version: 1,
    };

    expect(staleReason(order, { geoGeneration: 2 }, ADDRESS)).toBeNull();
    expect(staleReason(null, { geoGeneration: 2 }, ADDRESS)).toBe('ORDER_GONE');
    expect(staleReason(order, { geoGeneration: 1 }, ADDRESS)).toBe('GENERATION_CHANGED');
    expect(staleReason(order, { geoGeneration: 2 }, OTHER_ADDRESS)).toBe('ADDRESS_CHANGED');
    expect(staleReason({ ...order, inScope: false }, { geoGeneration: 2 }, ADDRESS)).toBe(
      'OUT_OF_SCOPE',
    );
    expect(
      staleReason(
        { ...order, geoState: 'RESOLVED', geoSource: 'MANUAL' },
        { geoGeneration: 2 },
        ADDRESS,
      ),
    ).toBe('MANUAL_POINT_SET');
  });

  it('медленный DaData и смена адреса: результат не применяется к новому адресу', async () => {
    const { snapshot, order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder(async () => {
      // Пока запрос «летит», приходит новая версия заказа с другим адресом.
      await apply({
        ...snapshot,
        address: OTHER_ADDRESS,
        externalUpdated: '2026-08-12 15:00:00.000',
      });
      return EXACT;
    });

    const result = await processGeocodingOnce(workerDeps(client));
    expect(result.stale).toBe(1);
    expect(result.resolved).toBe(0);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    // Точка от прежнего адреса не досталась новому.
    expect(stored.geoState).toBe('PENDING');
    expect(stored.geoLatMicro).toBeNull();
    expect(stored.geoGeneration).toBe(2);

    const firstJob = await ctx.db.orderGeocodeJob.findFirstOrThrow({
      where: { orderId: order.id, geoGeneration: 1 },
    });
    expect(firstJob.status).toBe('DONE');
    expect(firstJob.staleResults).toBe(1);
    expect(firstJob.lastErrorCode).toBe('GENERATION_CHANGED');
  });

  it('медленный DaData и ручная точка: решение человека не перезаписывается', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const token = await tokenFor(['LOGISTICIAN']);

    const client = fakeGeocoder(async () => {
      // Логист успевает поставить точку руками, пока идёт запрос.
      const fresh = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/api/orders/${order.id}/geo-point`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          lat: '55.760000',
          lon: '37.600000',
          reason: 'Логист уточнил дом по звонку',
          expectedVersion: fresh.version,
        },
      });
      expect(response.statusCode).toBe(200);
      return EXACT;
    });

    const result = await processGeocodingOnce(workerDeps(client));
    expect(result.stale).toBe(1);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoSource).toBe('MANUAL');
    expect(stored.geoLatMicro).toBe(55_760_000);

    const job = await jobOf(order.id);
    expect(job.lastErrorCode).toBe('MANUAL_POINT_SET');
  });

  it('медленный DaData и выход заказа из области: результат отброшен', async () => {
    const { snapshot, order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder(async () => {
      await apply({
        ...snapshot,
        storeId: '33333333-3333-4333-8333-333333333333',
        inScope: false,
        scopeExitReason: 'STORE_CHANGED',
        externalUpdated: '2026-08-12 16:00:00.000',
      });
      return EXACT;
    });

    const result = await processGeocodingOnce(workerDeps(client));
    expect(result.stale).toBe(1);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoState).not.toBe('RESOLVED');
    expect(stored.geoLatMicro).toBeNull();

    const job = await jobOf(order.id);
    expect(job.lastErrorCode).toBe('OUT_OF_SCOPE');
  });

  it('во время запроса заказ не заблокирован и не держится транзакция', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    let updatedDuringRequest = false;

    const client = fakeGeocoder(async () => {
      // Короткий lock_timeout: если бы worker держал строку заказа под
      // FOR UPDATE, этот запрос не дождался бы и упал.
      await ctx.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
        await tx.$executeRaw`UPDATE "DeliveryOrder" SET "updatedAt" = now() WHERE "id" = ${order.id}::uuid`;
      });
      updatedDuringRequest = true;
      return EXACT;
    });

    await processGeocodingOnce(workerDeps(client));
    expect(updatedDuringRequest).toBe(true);
  });

  it('ручная точка побеждает даже при повторном проходе', async () => {
    await resetProviderState();
    const { order } = await seedOrder();
    const token = await tokenFor(['LOGISTICIAN']);

    const fresh = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    const manual = await ctx.app.inject({
      method: 'PUT',
      url: `/api/orders/${order.id}/geo-point`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        lat: '55.770000',
        lon: '37.610000',
        reason: 'Ручная точка до ответа провайдера',
        expectedVersion: fresh.version,
      },
    });
    expect(manual.statusCode).toBe(200);

    await isolateJobs([order.id]);

    await resetProviderState();
    const client = fakeGeocoder(() => EXACT);
    await processGeocodingOnce(workerDeps(client));

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoSource).toBe('MANUAL');
    expect(stored.geoLatMicro).toBe(55_770_000);
  });
});

describe('аренда, конкуренция и восстановление', () => {
  it('второй экземпляр не обращается к DaData параллельно', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    let started = 0;
    const slow = fakeGeocoder(async () => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return EXACT;
    });
    const second = fakeGeocoder(() => EXACT);

    const [first, other] = await Promise.all([
      processGeocodingOnce(workerDeps(slow)),
      // Второму экземпляру нужно время, чтобы первый успел взять замок.
      new Promise((resolve) => setTimeout(resolve, 30)).then(() =>
        processGeocodingOnce(workerDeps(second)),
      ),
    ]);

    expect(first.skippedBusy).toBe(false);
    expect(other.skippedBusy).toBe(true);
    expect(second.calls).toHaveLength(0);
    expect(started).toBe(1);
  });

  it('два обработчика без общего замка не берут одно задание дважды', async () => {
    const first = await seedOrder();
    const second = await seedOrder();
    await isolateJobs([first.order.id, second.order.id]);
    await resetProviderState();

    // Разные ключи замка: проверяется именно захват заданий через SKIP LOCKED.
    const clientA = fakeGeocoder(() => EXACT);
    const clientB = fakeGeocoder(() => EXACT);

    const [resultA, resultB] = await Promise.all([
      processGeocodingOnce(
        workerDeps(clientA, { lock: { connectionString: ctx.config.DATABASE_URL, key: 730_291n } }),
      ),
      processGeocodingOnce(
        workerDeps(clientB, { lock: { connectionString: ctx.config.DATABASE_URL, key: 730_292n } }),
      ),
    ]);

    // Каждое задание досталось ровно одному обработчику.
    expect(resultA.claimed + resultB.claimed).toBe(2);
    expect(clientA.calls.length + clientB.calls.length).toBe(2);

    for (const id of [first.order.id, second.order.id]) {
      const job = await jobOf(id);
      expect(job.status).toBe('DONE');
      expect(
        await ctx.db.orderGeoHistory.count({ where: { orderId: id, kind: 'GEOCODE_RESOLVED' } }),
      ).toBe(1);
    }
  });

  it('задание умершего процесса возвращается в очередь', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    // Процесс взял задание и умер: аренда осталась в прошлом.
    await ctx.db.orderGeocodeJob.updateMany({
      where: { orderId: order.id },
      data: {
        status: 'PROCESSING',
        lockedBy: 'умерший-процесс',
        lockedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    const client = fakeGeocoder(() => EXACT);
    const result = await processGeocodingOnce(workerDeps(client));

    expect(result.resolved).toBe(1);
    const job = await jobOf(order.id);
    expect(job.status).toBe('DONE');
    expect(job.lockedBy).toBeNull();
  });

  it('чужую аренду обработчик не перезаписывает', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder(async () => {
      // Пока идёт запрос, аренду перехватил другой экземпляр.
      await ctx.db.orderGeocodeJob.updateMany({
        where: { orderId: order.id },
        data: { lockedBy: 'другой-экземпляр' },
      });
      return EXACT;
    });

    const result = await processGeocodingOnce(workerDeps(client));

    // Результат не записан: владелец сменился.
    expect(result.resolved).toBe(0);
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoState).toBe('PENDING');
    expect(
      await ctx.db.orderGeoHistory.count({
        where: { orderId: order.id, kind: 'GEOCODE_RESOLVED' },
      }),
    ).toBe(0);
  });

  it('планировщик останавливается корректно и не начинает новых проходов', async () => {
    const client = fakeGeocoder(() => EXACT);
    const worker = createGeocodeWorker(workerDeps(client), 10_000);
    worker.start();
    await worker.stop();
    // Повторная остановка безопасна.
    await worker.stop();
  });
});

describe('отказ провайдера останавливает пачку целиком', () => {
  const PERMANENT: { code: 'UNAUTHORIZED' | 'FORBIDDEN'; status: number }[] = [
    { code: 'UNAUTHORIZED', status: 401 },
    { code: 'FORBIDDEN', status: 403 },
  ];

  for (const testCase of PERMANENT) {
    it(`${testCase.status}: ровно один запрос на всю пачку и остановка до перезапуска`, async () => {
      const orders = [await seedOrder(), await seedOrder(), await seedOrder()];
      const ids = orders.map((seeded) => seeded.order.id);
      await isolateJobs(ids);
      await resetProviderState();

      const client = fakeGeocoder(() => {
        throw new DadataError(testCase.code, testCase.status);
      });

      const result = await processGeocodingOnce(workerDeps(client, { batchSize: 3 }));

      // Ключ неверен для всех заданий одинаково: девять лишних обращений
      // ничего не выяснили бы, а стоили бы денег и времени.
      expect(client.calls).toHaveLength(1);
      expect(result.requests).toBe(1);
      expect(result.claimed).toBe(3);
      expect(result.released).toBe(2);
      expect(result.haltedReason).toBe(testCase.code);

      // Ни одно задание не потратило попытку: они ни в чём не виноваты.
      const jobs = await ctx.db.orderGeocodeJob.findMany({ where: { orderId: { in: ids } } });
      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        expect(job.status).toBe('PENDING');
        expect(job.attempts).toBe(0);
        expect(job.lockedBy).toBeNull();
      }

      // Заказы не тронуты.
      for (const id of ids) {
        const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id } });
        expect(stored.geoState).toBe('PENDING');
      }

      const state = await readProviderState(ctx.db);
      expect(state.haltedReason).toBe(testCase.code);

      // Следующий проход не делает ни одного обращения и заданий не берёт.
      const second = fakeGeocoder(() => EXACT);
      const again = await processGeocodingOnce(workerDeps(second, { batchSize: 3 }));
      expect(second.calls).toHaveLength(0);
      expect(again.claimed).toBe(0);
      expect(again.haltedReason).toBe(testCase.code);
    });
  }

  it('429: один запрос, общая пауза и возврат остальных заданий без попыток', async () => {
    const orders = [await seedOrder(), await seedOrder(), await seedOrder()];
    const ids = orders.map((seeded) => seeded.order.id);
    await isolateJobs(ids);
    await resetProviderState();

    const now = new Date(Date.now() + 1000);
    const client = fakeGeocoder(() => {
      throw new DadataError('RATE_LIMITED', 429, 42_000);
    });

    const result = await processGeocodingOnce(workerDeps(client, { batchSize: 3, now: () => now }));

    expect(client.calls).toHaveLength(1);
    expect(result.requests).toBe(1);
    expect(result.released).toBe(2);
    expect(result.skippedCooldown).toBe(true);

    const jobs = await ctx.db.orderGeocodeJob.findMany({
      where: { orderId: { in: ids } },
      orderBy: { createdAt: 'asc' },
    });
    // Попытку тратит только тот заказ, который получил отказ.
    expect(jobs.filter((job) => job.attempts === 1)).toHaveLength(1);
    expect(jobs.filter((job) => job.attempts === 0)).toHaveLength(2);
    for (const job of jobs) {
      expect(job.status).toBe('PENDING');
    }

    // Пауза общая: она относится к ключу, а не к одному заказу.
    const state = await readProviderState(ctx.db);
    expect(state.haltedReason).toBeNull();
    expect(state.nextRequestAllowedAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 42_000);

    // До истечения паузы обращений нет.
    const second = fakeGeocoder(() => EXACT);
    const again = await processGeocodingOnce(workerDeps(second, { batchSize: 3, now: () => now }));
    expect(second.calls).toHaveLength(0);
    expect(again.claimed).toBe(0);
    expect(again.skippedCooldown).toBe(true);
  });

  it('429 без Retry-After даёт безопасную паузу в тридцать секунд', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const now = new Date(Date.now() + 1000);
    const client = fakeGeocoder(() => {
      throw new DadataError('RATE_LIMITED', 429, null);
    });

    await processGeocodingOnce(workerDeps(client, { now: () => now }));

    const state = await readProviderState(ctx.db);
    expect(state.nextRequestAllowedAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 30_000);
  });
});

describe('общий интервал между запросами', () => {
  it('второй экземпляр начинает запрос не раньше секунды после первого', async () => {
    await resetProviderState();

    // Один и тот же момент времени у обоих экземпляров: если бы интервал жил
    // полем внутри клиента, второй начал бы запрос немедленно.
    const now = new Date();
    const waits: number[] = [];

    const first = await reserveRequestSlot(ctx.db, {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const second = await reserveRequestSlot(ctx.db, {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(first.granted).toBe(true);
    expect(second.granted).toBe(true);
    expect(first.waitMs).toBe(0);
    // Второму слоту велено подождать: интервал общий на все процессы.
    expect(second.waitMs).toBeGreaterThanOrEqual(MIN_REQUEST_INTERVAL_MS);
    expect(waits).toEqual([MIN_REQUEST_INTERVAL_MS]);
  });

  it('интервал соблюдается при передаче замка двум разным проходам', async () => {
    const first = await seedOrder();
    const second = await seedOrder();
    await isolateJobs([first.order.id, second.order.id]);
    await resetProviderState();

    const startedAt: number[] = [];
    const base = Date.now();
    // Часы стоят: любое расхождение стартов может прийти только из общего слота.
    const frozen = new Date(base);

    const track = (): void => {
      startedAt.push(base);
    };

    const waits: number[] = [];
    const slot = {
      now: () => frozen,
      sleep: async (ms: number): Promise<void> => {
        waits.push(ms);
      },
    };

    // Два разных экземпляра: каждый со своим клиентом и своим worker id.
    const clientA = fakeGeocoder(() => {
      track();
      return EXACT;
    });
    await processGeocodingOnce(workerDeps(clientA, { batchSize: 1, slot, now: () => frozen }));

    const clientB = fakeGeocoder(() => {
      track();
      return EXACT;
    });
    await processGeocodingOnce(workerDeps(clientB, { batchSize: 1, slot, now: () => frozen }));

    expect(clientA.calls).toHaveLength(1);
    expect(clientB.calls).toHaveLength(1);
    // Второму экземпляру пришлось ждать ровно интервал, хотя его клиент
    // никаких запросов до этого не делал.
    expect(waits).toEqual([MIN_REQUEST_INTERVAL_MS]);
  });
});

describe('backfill существующих заказов', () => {
  it('ставит в очередь только подходящие заказы и не дублирует задания', async () => {
    const ready = await seedOrder();
    const withoutAddress = await seedOrder({ shipmentAddress: null });

    // Заказ, пришедший до включения геокодирования: задания у него нет.
    await ctx.db.orderGeocodeJob.deleteMany({ where: { orderId: ready.order.id } });
    await ctx.db.deliveryOrder.update({
      where: { id: ready.order.id },
      data: { geoState: 'UNRESOLVED', geoGeneration: 0 },
    });

    // Пачки маленькие, но проход доводится до конца: база общая для всех
    // критических тестов, и нужный заказ не обязан попасть в первую пачку.
    const result = await backfillGeocoding(ctx.db, { batchSize: 20, maxBatches: 100 });
    expect(result.enqueued).toBeGreaterThanOrEqual(1);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: ready.order.id } });
    expect(stored.geoState).toBe('PENDING');
    expect(stored.geoGeneration).toBe(1);
    expect(await ctx.db.orderGeocodeJob.count({ where: { orderId: ready.order.id } })).toBe(1);

    // Заказ без адреса наружу не отправляется ни при каком наполнении.
    expect(
      await ctx.db.orderGeocodeJob.count({ where: { orderId: withoutAddress.order.id } }),
    ).toBe(0);

    // Повторный запуск ничего не добавляет: задание уже есть.
    const again = await backfillGeocoding(ctx.db, { batchSize: 20, maxBatches: 100 });
    expect(await ctx.db.orderGeocodeJob.count({ where: { orderId: ready.order.id } })).toBe(1);
    expect(again.enqueued).toBe(0);
  });

  it('маленькие пачки, ведущие пустые адреса и объём выше предела: ставится всё и по разу', async () => {
    // Заказы «до включения геокодирования»: они в UNRESOLVED и без заданий.
    const withoutAddress = [];
    for (let i = 0; i < 3; i += 1) {
      withoutAddress.push(await seedOrder({ shipmentAddress: i === 0 ? null : '   ' }));
    }

    const suitable = [];
    for (let i = 0; i < 7; i += 1) {
      const seeded = await seedOrder();
      await ctx.db.orderGeocodeJob.deleteMany({ where: { orderId: seeded.order.id } });
      await ctx.db.deliveryOrder.update({
        where: { id: seeded.order.id },
        data: { geoState: 'UNRESOLVED', geoGeneration: 0 },
      });
      suitable.push(seeded.order.id);
    }

    // Пачка меньше числа заказов: наполнение обязано дойти до конца само,
    // а не остановиться на первой пачке и молча оставить остальные без точки.
    const result = await backfillGeocoding(ctx.db, { batchSize: 2 });

    expect(result.exhaustedBatches).toBe(false);
    expect(result.stopped).toBe(false);

    for (const id of suitable) {
      const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id } });
      expect(stored.geoState).toBe('PENDING');
      expect(stored.geoGeneration).toBe(1);
      // Ровно одно задание: повторная постановка обесценила бы уже летящий ответ.
      expect(await ctx.db.orderGeocodeJob.count({ where: { orderId: id } })).toBe(1);
    }

    // Пустой и пробельный адрес отсекается прямо в выборке и место в пачке
    // не занимает: иначе он не пускал бы к следующим подходящим заказам.
    for (const seeded of withoutAddress) {
      expect(await ctx.db.orderGeocodeJob.count({ where: { orderId: seeded.order.id } })).toBe(0);
      const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
        where: { id: seeded.order.id },
      });
      expect(stored.geoState).toBe('UNRESOLVED');
    }

    // Повтор ничего не добавляет.
    const again = await backfillGeocoding(ctx.db, { batchSize: 2 });
    expect(again.enqueued).toBe(0);
    for (const id of suitable) {
      expect(await ctx.db.orderGeocodeJob.count({ where: { orderId: id } })).toBe(1);
    }
  });

  it('достижение аварийного предела пачек видно в результате, а не молчит', async () => {
    const seeded = await seedOrder();
    await ctx.db.orderGeocodeJob.deleteMany({ where: { orderId: seeded.order.id } });
    await ctx.db.deliveryOrder.update({
      where: { id: seeded.order.id },
      data: { geoState: 'UNRESOLVED', geoGeneration: 0 },
    });

    const result = await backfillGeocoding(ctx.db, { batchSize: 1, maxBatches: 1 });

    // Одна пачка выбрана, но подходящие заказы могли остаться: об этом
    // обязаны узнать и вызывающая сторона, и журнал.
    expect(result.exhaustedBatches).toBe(true);
  });

  it('остановка приложения дожидается наполнения', async () => {
    // Наполнение работает с базой, которую остановка вот-вот закроет. Проверка
    // читает исходный код точки входа: поднимать процесс ради этого незачем,
    // а пропущенное ожидание проявилось бы только в редком сбое при деплое.
    const { readFile } = await import('node:fs/promises');
    const code = await readFile(new URL('../../../index.ts', import.meta.url), 'utf8');

    expect(code).toContain('backfillStopping = true;');
    expect(code).toContain('backfill ?? Promise.resolve(),');
    expect(code).toContain('shouldStop: () => backfillStopping');
  });

  it('остановка процесса прекращает наполнение между пачками', async () => {
    for (let i = 0; i < 4; i += 1) {
      const seeded = await seedOrder();
      await ctx.db.orderGeocodeJob.deleteMany({ where: { orderId: seeded.order.id } });
      await ctx.db.deliveryOrder.update({
        where: { id: seeded.order.id },
        data: { geoState: 'UNRESOLVED', geoGeneration: 0 },
      });
    }

    let stopping = false;
    const result = await backfillGeocoding(ctx.db, {
      batchSize: 1,
      shouldStop: () => stopping,
      now: () => {
        // Первая пачка проходит, дальше процесс объявляется останавливающимся.
        stopping = true;
        return new Date();
      },
    });

    expect(result.stopped).toBe(true);
    // Наполнение завершилось само, а не оборвалось посреди пачки.
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
  });

  it('заказ с ручной точкой наполнение не трогает', async () => {
    const { order } = await seedOrder();
    const token = await tokenFor(['LOGISTICIAN']);

    const fresh = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/orders/${order.id}/geo-point`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        lat: '55.780000',
        lon: '37.620000',
        reason: 'Ручная точка до наполнения очереди',
        expectedVersion: fresh.version,
      },
    });

    const before = await ctx.db.orderGeocodeJob.count({ where: { orderId: order.id } });
    await backfillGeocoding(ctx.db, { batchSize: 20, maxBatches: 100 });
    expect(await ctx.db.orderGeocodeJob.count({ where: { orderId: order.id } })).toBe(before);
  });
});

describe('состояние интеграции и отсутствие персональных данных', () => {
  it('публичный статус отдаёт только высокоуровневое состояние', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/status' });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      integrations: { provider: string; state: string; pendingOperations?: number }[];
    };
    const dadata = body.integrations.find((row) => row.provider === DADATA_PROVIDER);
    expect(dadata).toBeDefined();
    expect(dadata?.pendingOperations).toBeUndefined();
    expect(Object.keys(dadata ?? {}).sort()).toEqual(['provider', 'state', 'updatedAt']);
  });

  it('администратору видны счётчик и очищенные детали, но не ключи и не адреса', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder(() => {
      throw new DadataError('SERVER_ERROR', 500);
    });
    await processGeocodingOnce(workerDeps(client));

    const token = await tokenFor(['ADMIN']);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/status/integrations',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      integrations: {
        provider: string;
        state: string;
        pendingOperations: number;
        details: unknown;
      }[];
    };
    const dadata = body.integrations.find((row) => row.provider === DADATA_PROVIDER);
    expect(dadata?.state).toBe('DEGRADED');
    expect(dadata?.pendingOperations).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(dadata?.details)).toBe(JSON.stringify({ code: 'SERVER_ERROR' }));

    const text = response.body;
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain('синтетическая улица');
  });

  it('ни адрес, ни координаты не попадают в аудит и realtime автоматического разрешения', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder(() => EXACT);
    await processGeocodingOnce(workerDeps(client));

    const audit = await ctx.db.auditLog.findMany({
      where: { entityId: order.id, action: 'ORDER_GEO_RESOLVED' },
    });
    const events = await ctx.db.realtimeEvent.findMany({ where: { topic: 'order.geo_changed' } });
    const own = events.filter((event) => JSON.stringify(event.payload).includes(order.id));

    const text = JSON.stringify({ audit, own }, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );

    expect(own.length).toBeGreaterThan(0);
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain('синтетическая улица');
    expect(text).not.toContain('55.751244');
    expect(text).not.toContain('55751244');
  });

  it('в записях очереди нет ни адресов, ни ключей', async () => {
    const jobs = await ctx.db.orderGeocodeJob.findMany({ take: 200 });
    const text = JSON.stringify(jobs);

    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain('синтетическая улица');
    expect(text).not.toContain('Token ');
    expect(text).not.toContain('X-Secret');
  });
});

async function tokenFor(roles: Parameters<typeof seedUser>[1]['roles']): Promise<string> {
  const { hashSecretCode } = await import('../../auth/crypto.js');
  const { login } = await import('../../auth/service.js');
  const pin = '1234';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles, status: 'ACTIVE', pinHash });
  const session = await login(
    ctx,
    { phone: user.phone, pin },
    { ip: null, userAgent: 'vitest', deviceLabel: null },
  );
  return session.accessToken;
}
