/**
 * Критические проверки геокодирования: очередь, обработчик и защита от устаревшего результата.
 *
 * Автоматический геокодер — собственный Photon, и настоящих сетевых обращений
 * здесь нет: клиент подменён функцией. Проверяются свойства, нарушение которых
 * опасно, — транзакционность постановки, дедупликация, аренда заданий,
 * ограниченный backoff, кэш по нормализованному адресу и то, что ответ,
 * вернувшийся после изменения заказа, не перезаписывает ни новый адрес,
 * ни решение человека.
 *
 * Отдельно закреплено разделение сервисов: DaData допускается только подсказками
 * в ручной правке и не участвует в автоматическом проходе вовсе.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from '../../auth/testing/harness.js';
import { dadataEnvironment, loadConfig } from '../../../platform/config.js';
import { resolveTestDatabaseUrl } from '../../../platform/testing/test-database.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from '../../integrations/moysklad/config.js';
import { applyOrderSnapshot } from '../../integrations/moysklad/import-service.js';
import { mapOrder, type OrderSnapshot } from '../../integrations/moysklad/mapper.js';
import { PhotonError, precisionOf, type PhotonAnswer } from '../../integrations/photon/client.js';
import { isDadataAllowed, isPhotonConfigured, shouldGeocodeAutomatically } from './enabled.js';
import { geocodingAddress } from '../address.js';
import { normalizeAddress } from './normalize.js';
import { geocodingReport } from './report.js';
import { MAX_LIMIT, parseBackfillOptions } from './backfill-options.js';
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
import { GEOCODER_PROVIDER } from './status.js';
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

/**
 * Уникальный синтетический адрес для каждого заказа.
 *
 * Кэш геокодирования работает по нормализованному адресу, и одинаковый адрес
 * у соседних заказов означал бы, что запрос уходит один раз на всех. Это верное
 * поведение кэша, но оно скрывало бы всё остальное: проверки перестали бы
 * видеть обращения. Кэш проверяется отдельно и явно.
 */
let addressCounter = 0;
function uniqueAddress(): string {
  addressCounter += 1;
  return `${ADDRESS}, квартира ${addressCounter}`;
}

/**
 * Разобранный адрес того же заказа.
 *
 * Автоматическое геокодирование работает ТОЛЬКО по нему: строка произвольного
 * формата основанием не служит. Поэтому сценарии, ожидающие задание, обязаны
 * иметь разобранный адрес — иначе они проверяли бы отменённое поведение.
 *
 * Улица уникальна у каждого заказа: кэш работает по нормализованному адресу,
 * и одинаковый адрес у соседей означал бы один запрос на всех.
 */
function uniqueStructured(): { city: string; street: string; house: string } {
  addressCounter += 1;
  return { city: 'Москва', street: `синтетическая улица ${addressCounter}`, house: '1' };
}
const OTHER_ADDRESS = 'Москва, другая синтетическая улица, дом 2';

/** Точный дом. Координаты синтетические и в отчёты не выходят. */
const EXACT: PhotonAnswer = {
  lat: 55.751244,
  lon: 37.618423,
  precision: 'HOUSE',
  place: {
    housenumber: '1',
    street: 'синтетическая улица',
    city: 'Москва',
    countrycode: 'RU',
  },
};

/**
 * Ответ, согласованный с запрошенным адресом.
 *
 * Обработчик сверяет ответ геокодера с исходным адресом (`verify.ts`), поэтому
 * поддельный геокодер обязан отвечать про ТОТ ЖЕ адрес, о котором спросили.
 * Ответ «всегда один и тот же дом» проверял бы не очередь, а защиту от подмены,
 * и она у него самого же и срабатывала бы.
 */
function exactAnswerFor(address: string): PhotonAnswer {
  // Запрос приходит собранным из разобранных частей: «город, улица, дом».
  const parts = address.split(',').map((part) => part.trim());
  const street = parts[1] ?? 'синтетическая улица';
  // Photon отдаёт голый номер дома, без слова «дом». Поддельный геокодер обязан
  // вести себя так же, иначе сверка ответа с запросом отвергнет собственную
  // выдумку теста, а не поведение продукта.
  const housenumber = (parts[2] ?? '1').replace(/^дом\s+/i, '');
  return {
    lat: 55.751244,
    lon: 37.618423,
    precision: 'HOUSE',
    place: { housenumber, street, city: 'Москва', countrycode: 'RU' },
  };
}

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
    shipmentAddress: uniqueAddress(),
    shipmentAddressFull: uniqueStructured(),
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
  return mapOrder(source(overrides) as never, IDS, 'shipmentAddressFull').snapshot;
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
  handler: (address: string, call: number) => Promise<PhotonAnswer | null> | PhotonAnswer | null,
): FakeGeocoder {
  const calls: string[] = [];
  let inFlight = 0;
  const state = { maxInFlight: 0 };

  return {
    calls,
    get maxInFlight() {
      return state.maxInFlight;
    },
    async search(address: string) {
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

  // Кэш тоже общий и переживает отдельный тест — как и в production. Проверки,
  // считающие обращения, начинают с чистого кэша: иначе они измеряли бы порядок
  // запуска тестов, а не поведение обработчика.
  await ctx.db.geocodeCacheEntry.deleteMany({});
}

async function jobOf(orderId: string) {
  return ctx.db.orderGeocodeJob.findFirstOrThrow({
    where: { orderId },
    orderBy: { geoGeneration: 'desc' },
  });
}

// ---------------------------------------------------------------------------

describe('окружение: свой Photon и чужая DaData подчиняются разным правилам', () => {
  const base = {
    DATABASE_URL: resolveTestDatabaseUrl(),
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...TEST_SECRETS,
  };

  const withKeys = {
    DADATA_API_KEY: 'key',
    DADATA_GEOCODING_ENABLED: 'true',
  };

  it('подсказки DaData включаются только при совпавших маркерах, ключе и флаге', () => {
    // Владелец разрешил staging наравне с production: адреса настоящие,
    // расход квоты принят. Прежний абсолютный запрет вне production заменён.
    for (const env of ['production', 'staging'] as const) {
      const config = loadConfig({
        ...base,
        APP_ENV: env,
        APP_ENVIRONMENT_MARKER: env,
        ...withKeys,
      });
      expect(isDadataAllowed(config), env).toBe(true);
    }

    // Разрешённое окружение без ключей и без флага никуда не обращается:
    // «не настраивали» — это не согласие тратить чужие деньги.
    for (const env of ['production', 'staging'] as const) {
      const bare = loadConfig({ ...base, APP_ENV: env, APP_ENVIRONMENT_MARKER: env });
      expect(isDadataAllowed(bare), env).toBe(false);
    }
  });

  it('ключи DaData автоматического геокодирования НЕ включают', () => {
    // Главное разделение задания: платный сервис не геокодирует ничего сам.
    // Полный комплект ключей в разрешённом окружении — этого мало.
    for (const env of ['production', 'staging'] as const) {
      const config = loadConfig({
        ...base,
        APP_ENV: env,
        APP_ENVIRONMENT_MARKER: env,
        ...withKeys,
      });
      expect(isDadataAllowed(config), env).toBe(true);
      expect(shouldGeocodeAutomatically(config), env).toBe(false);
      expect(isPhotonConfigured(config), env).toBe(false);
    }
  });

  it('настроенный Photon сам по себе автоматический режим НЕ включает', () => {
    // Главное разделение этой контрольной точки: «геокодер настроен» и «ему
    // разрешено обработать всю очередь» — разные решения. На новом наборе
    // сначала нужен управляемый проход, а не молчаливая обработка всех
    // накопленных заказов.
    for (const env of ['local', 'production'] as const) {
      const config = loadConfig({
        ...base,
        APP_ENV: env,
        APP_ENVIRONMENT_MARKER: env,
        PHOTON_URL: 'http://photon.internal:2322/api',
        MOYSKLAD_GEOCODING_ADDRESS_SOURCE: 'shipmentAddressFull',
      });
      expect(isPhotonConfigured(config), env).toBe(true);
      expect(shouldGeocodeAutomatically(config), env).toBe(false);
      // И при этом ни одна подсказка DaData не разрешена: ключей нет.
      expect(isDadataAllowed(config), env).toBe(false);
    }
  });

  it('автоматический режим включается только обоими условиями сразу', () => {
    // Настроенный Photon обязан идти вместе с разобранным источником: иначе
    // конфигурация отвергается — заданий не появилось бы ни одного.
    const withUrl = {
      PHOTON_URL: 'http://photon.internal:2322/api',
      MOYSKLAD_GEOCODING_ADDRESS_SOURCE: 'shipmentAddressFull',
    };

    // Оба условия.
    const both = loadConfig({
      ...base,
      APP_ENV: 'local',
      APP_ENVIRONMENT_MARKER: 'local',
      ...withUrl,
      PHOTON_AUTO_GEOCODING_ENABLED: 'true',
    });
    expect(shouldGeocodeAutomatically(both)).toBe(true);

    // Флаг без геокодера ничего не включает: включать нечего.
    const flagOnly = loadConfig({
      ...base,
      APP_ENV: 'local',
      APP_ENVIRONMENT_MARKER: 'local',
      PHOTON_AUTO_GEOCODING_ENABLED: 'true',
    });
    expect(isPhotonConfigured(flagOnly)).toBe(false);
    expect(shouldGeocodeAutomatically(flagOnly)).toBe(false);

    // Fail closed: умолчание, пустое значение и явное «false» — всё выключено.
    for (const value of [undefined, '', '   ', 'false']) {
      const config = loadConfig({
        ...base,
        APP_ENV: 'local',
        APP_ENVIRONMENT_MARKER: 'local',
        ...withUrl,
        ...(value === undefined ? {} : { PHOTON_AUTO_GEOCODING_ENABLED: value }),
      });
      expect(config.PHOTON_AUTO_GEOCODING_ENABLED, JSON.stringify(value)).toBe(false);
      expect(shouldGeocodeAutomatically(config), JSON.stringify(value)).toBe(false);
      // Геокодер при этом настроен: ручной проход им пользоваться может.
      expect(isPhotonConfigured(config), JSON.stringify(value)).toBe(true);
    }

    // Значение не из перечисления — ошибка развёртывания, а не тихое «false».
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'local',
        APP_ENVIRONMENT_MARKER: 'local',
        ...withUrl,
        PHOTON_AUTO_GEOCODING_ENABLED: 'yes',
      }),
    ).toThrow(/PHOTON_AUTO_GEOCODING_ENABLED/);
  });

  it('ручной ограниченный проход от флага не зависит', async () => {
    // Пилот и существует для того, чтобы пройти два десятка адресов при
    // выключенном автоматическом режиме. Если бы ручной проход смотрел на тот
    // же флаг, включить его можно было бы только вместе с обработкой всей
    // очереди — то есть ровно тем, чего пилот и избегает.
    const script = await readFile(
      new URL('../../../scripts/geocoding-backfill.ts', import.meta.url),
      'utf8',
    );

    expect(script).toContain('isPhotonConfigured(config)');
    expect(script).not.toContain('PHOTON_AUTO_GEOCODING_ENABLED');
    expect(script).not.toContain('shouldGeocodeAutomatically');

    // И потолок обращений остаётся обязательным.
    expect(script).toContain('parseBackfillOptions');
  });

  it('пустой адрес Photon — это «не настроен», а не «настроен пустотой»', () => {
    const blank = loadConfig({
      ...base,
      APP_ENV: 'local',
      APP_ENVIRONMENT_MARKER: 'local',
      PHOTON_URL: '   ',
      PHOTON_AUTO_GEOCODING_ENABLED: 'true',
    });
    expect(isPhotonConfigured(blank)).toBe(false);
    expect(shouldGeocodeAutomatically(blank)).toBe(false);
  });

  it('local и CI остаются запрещёнными: ключи там не размещаются вовсе', () => {
    expect(() =>
      loadConfig({ ...base, APP_ENV: 'local', APP_ENVIRONMENT_MARKER: 'local', ...withKeys }),
    ).toThrow(/DADATA_API_KEY/);

    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'local',
        APP_ENVIRONMENT_MARKER: 'local',
        DADATA_GEOCODING_ENABLED: 'true',
      }),
    ).toThrow(/DADATA_GEOCODING_ENABLED/);

    const local = loadConfig({ ...base, APP_ENV: 'local', APP_ENVIRONMENT_MARKER: 'local' });
    expect(isDadataAllowed(local)).toBe(false);
  });

  it('смешанные маркеры запрещены в обе стороны', () => {
    // Ошибка развёртывания опаснее отсутствия настройки: продолжать с платным
    // ключом там, где неясно, какое это окружение, нельзя.
    for (const [env, marker] of [
      ['production', 'staging'],
      ['staging', 'production'],
      ['staging', 'local'],
      ['production', 'local'],
    ] as const) {
      expect(dadataEnvironment({ APP_ENV: env, APP_ENVIRONMENT_MARKER: marker })).toBe('denied');
      expect(
        () => loadConfig({ ...base, APP_ENV: env, APP_ENVIRONMENT_MARKER: marker, ...withKeys }),
        `${env}/${marker}`,
      ).toThrow();
    }
  });

  it('подсказкам нужен ровно один ключ, и секретный среди них не значится', () => {
    for (const env of ['production', 'staging'] as const) {
      // Секретный ключ требовался платному Clean API, которого больше нет.
      // Один API-ключ — полная и достаточная настройка подсказок.
      const config = loadConfig({
        ...base,
        APP_ENV: env,
        APP_ENVIRONMENT_MARKER: env,
        DADATA_API_KEY: 'key',
        DADATA_GEOCODING_ENABLED: 'true',
      });
      expect(isDadataAllowed(config), env).toBe(true);

      // А включённые подсказки без ключа — ошибка развёртывания: экран обещал
      // бы подсказки, которых не будет.
      expect(() =>
        loadConfig({
          ...base,
          APP_ENV: env,
          APP_ENVIRONMENT_MARKER: env,
          DADATA_GEOCODING_ENABLED: 'true',
        }),
      ).toThrow(/DADATA_API_KEY/);
    }

    // Секретного ключа в конфигурации нет вовсе: он не читается и не хранится.
    expect('DADATA_SECRET_KEY' in ctx.config).toBe(false);
  });

  it('тестовая конфигурация не включает ни один живой сервис', () => {
    expect(isDadataAllowed(ctx.config)).toBe(false);
    expect(shouldGeocodeAutomatically(ctx.config)).toBe(false);
    expect(isPhotonConfigured(ctx.config)).toBe(false);
    expect(ctx.config.DADATA_API_KEY).toBeUndefined();
    expect(ctx.config.PHOTON_URL).toBeUndefined();
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
    const { order } = await seedOrder({ shipmentAddress: null, shipmentAddressFull: null });

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

  it('смена адреса снимает точку, но нового поколения и задания не создаёт', async () => {
    // Обновление заказа в МоемСкладе событием геокодирования не является:
    // обращаться к геокодеру за исторический заказ никто не просил.
    const { snapshot, order } = await seedOrder();

    await apply({
      ...snapshot,
      address: OTHER_ADDRESS,
      externalUpdated: '2026-08-12 14:00:00.000',
    });

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    // Поколение прежнее: новую версию адреса на разрешение не отправляли.
    expect(stored.geoGeneration).toBe(1);
    // Но прежняя точка снята — она относилась к другому адресу и молча
    // увела бы курьера.
    expect(stored.geoLatMicro).toBeNull();
    expect(stored.geoSource).toBeNull();

    const jobs = await ctx.db.orderGeocodeJob.findMany({
      where: { orderId: order.id },
      orderBy: { geoGeneration: 'asc' },
    });
    expect(jobs.map((job) => job.geoGeneration)).toEqual([1]);
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

    const client = fakeGeocoder((address) => exactAnswerFor(address));
    const result = await processGeocodingOnce(workerDeps(client));

    expect(result.skippedBusy).toBe(false);
    expect(result.resolved).toBe(1);
    // В геокодер уходит собранный запрос, а не операционный адрес заказа.
    expect(client.calls).toEqual([order.geocodeAddress]);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoState).toBe('RESOLVED');
    expect(stored.geoSource).toBe('PHOTON');
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

    const client = fakeGeocoder(() => ({ lat: 55.7, lon: 37.6, precision: 'STREET' }));
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

  it('точкой считается только точный дом', () => {
    expect(decideResult(EXACT, ADDRESS)).toMatchObject({ kind: 'RESOLVED' });

    // Улица и район — это «где-то там». Курьер едет по конкретному адресу,
    // поэтому такой ответ зовёт человека, а не становится точкой заказа.
    for (const precision of ['STREET', 'AREA'] as const) {
      expect(decideResult({ ...EXACT, precision }, ADDRESS), precision).toMatchObject({
        kind: 'LOW_PRECISION',
      });
    }

    // Ответа нет вовсе.
    expect(decideResult(null, ADDRESS)).toMatchObject({ kind: 'LOW_PRECISION' });

    // Точность заявлена, а координата невозможна.
    expect(decideResult({ ...EXACT, lat: 95, lon: 37.6 }, ADDRESS)).toMatchObject({
      kind: 'LOW_PRECISION',
    });
    expect(decideResult({ ...EXACT, lat: 55.7, lon: 181 }, ADDRESS)).toMatchObject({
      kind: 'LOW_PRECISION',
    });
    expect(decideResult({ ...EXACT, lat: Number.NaN, lon: 37.6 }, ADDRESS)).toMatchObject({
      kind: 'LOW_PRECISION',
    });
  });

  it('точность определяется по ответу Photon, а не по нашему желанию', () => {
    // Номер дома — главный признак; он важнее типа объекта.
    expect(
      precisionOf({
        geometry: { coordinates: [37.6, 55.7] },
        properties: { housenumber: '1', street: 'синтетическая', osm_key: 'place' },
      }),
    ).toBe('HOUSE');

    // Photon сообщает дом и вторым способом — типом объекта.
    for (const properties of [
      { type: 'house' },
      { osm_value: 'house' },
      { osm_value: 'building' },
      { osm_key: 'building' },
    ]) {
      expect(
        precisionOf({ geometry: { coordinates: [37.6, 55.7] }, properties }),
        JSON.stringify(properties),
      ).toBe('HOUSE');
    }

    // Пустой номер дома домом не считается: это отсутствие данных.
    expect(
      precisionOf({
        geometry: { coordinates: [37.6, 55.7] },
        properties: { housenumber: '  ', street: 'синтетическая' },
      }),
    ).toBe('STREET');

    expect(
      precisionOf({ geometry: { coordinates: [37.6, 55.7] }, properties: { city: 'Москва' } }),
    ).toBe('AREA');
  });

  it('отказ сервиса повторяется с ограниченным backoff', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const now = new Date(Date.now() + 1000);
    const client = fakeGeocoder(() => {
      throw new PhotonError('SERVER_ERROR', 500);
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

  it('пауза после отказа растёт вместе с попытками', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    // Третья попытка: короткий сбой уже не объясняет происходящее.
    await ctx.db.orderGeocodeJob.updateMany({
      where: { orderId: order.id },
      data: { attempts: 2, maxAttempts: 5 },
    });

    const now = new Date(Date.now() + 1000);
    const client = fakeGeocoder(() => {
      throw new PhotonError('SERVER_ERROR', 503);
    });

    await processGeocodingOnce(workerDeps(client, { now: () => now }));

    const job = await jobOf(order.id);
    // Непрерывный опрос мёртвого сервиса не помогает никому: пауза растёт.
    expect(job.attempts).toBe(3);
    expect(job.nextAttemptAt.getTime()).toBe(now.getTime() + RETRY_DELAYS_MS[2]);
  });

  it('неразобранный ответ считается отказом сервиса, а не адреса', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    // Сменившийся формат ответа — это неисправность геокодера. Объявлять из-за
    // него адрес неразрешимым нельзя: с адресом всё в порядке.
    const client = fakeGeocoder(() => {
      throw new PhotonError('BAD_RESPONSE', 200);
    });
    const result = await processGeocodingOnce(workerDeps(client));

    expect(result.retried).toBe(1);
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoState).toBe('PENDING');
    expect(stored.geoLatMicro).toBeNull();
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

    // Контрольные утверждения ДО прохода: без них «ничего не произошло»
    // читается как отказ обработчика, хотя задания могло просто не быть.
    const ready = await ctx.db.orderGeocodeJob.findFirstOrThrow({ where: { orderId: order.id } });
    expect(ready.status, 'задание не в PENDING').toBe('PENDING');
    expect(ready.attempts).toBe(4);
    expect(ready.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    const seeded = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(seeded.geocodeAddress, 'у заказа нет собранного запроса').not.toBeNull();

    const client = fakeGeocoder(() => {
      throw new PhotonError('TRANSPORT_ERROR');
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

  it('неверная настройка не тратит попытки: виноват не адрес', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder(() => {
      throw new PhotonError('PUBLIC_ENDPOINT_FORBIDDEN');
    });
    await processGeocodingOnce(workerDeps(client));

    // Задание возвращается нетронутым: причина отказа относится к настройке
    // геокодера, а не к адресу, и живёт в общем состоянии провайдера.
    const job = await jobOf(order.id);
    expect(job.status).toBe('PENDING');
    expect(job.attempts).toBe(0);
    expect(job.lockedBy).toBeNull();

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoState).toBe('PENDING');

    const state = await readProviderState(ctx.db);
    expect(state.haltedReason).toBe('PUBLIC_ENDPOINT_FORBIDDEN');

    const status = await ctx.db.integrationStatus.findUniqueOrThrow({
      where: { provider: GEOCODER_PROVIDER },
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

    const client = fakeGeocoder(async (address) => {
      // Уступаем управление: при параллельной обработке счётчик это заметит.
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      return exactAnswerFor(address);
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

  it('медленный геокодер и смена адреса: результат не применяется к новому адресу', async () => {
    const { snapshot, order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder(async (address) => {
      // Пока запрос «летит», приходит новая версия заказа с другим адресом.
      await apply({
        ...snapshot,
        geocodeAddress: 'Москва, другая синтетическая улица, 2',
        externalUpdated: '2026-08-12 15:00:00.000',
      });
      return exactAnswerFor(address);
    });

    const result = await processGeocodingOnce(workerDeps(client));
    expect(result.stale).toBe(1);
    expect(result.resolved).toBe(0);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    // Точка от прежнего адреса не досталась новому.
    expect(stored.geoLatMicro).toBeNull();
    /*
     * Поколение выросло: появившийся другой адрес — это событие, и заказ
     * отправлен на разрешение заново. Защита от устаревшего ответа держится
     * не на поколении, а на сравнении АДРЕСА: ответ по прежнему адресу
     * отброшен независимо от того, есть ли новое задание.
     */
    expect(stored.geoGeneration).toBe(2);

    const firstJob = await ctx.db.orderGeocodeJob.findFirstOrThrow({
      where: { orderId: order.id, geoGeneration: 1 },
    });
    expect(firstJob.status).toBe('DONE');
    expect(firstJob.staleResults).toBe(1);
    /*
     * Устаревание опознано по поколению.
     *
     * Защит две, и обе на месте: адрес сравнивается с тем, что уходил в
     * запрос, а поколение — с тем, что было на момент постановки. Появившееся
     * новое задание срабатывает раньше, и код причины называет именно его.
     */
    expect(firstJob.lastErrorCode).toBe('GENERATION_CHANGED');

    // Новому адресу — новое задание: без него заказ остался бы без координат.
    expect(await ctx.db.orderGeocodeJob.count({ where: { orderId: order.id } })).toBe(2);
    const secondJob = await ctx.db.orderGeocodeJob.findFirstOrThrow({
      where: { orderId: order.id, geoGeneration: 2 },
    });
    expect(secondJob.status).toBe('PENDING');
  });

  it('медленный геокодер и ручная точка: решение человека не перезаписывается', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const token = await tokenFor(['LOGISTICIAN']);

    const client = fakeGeocoder(async (address) => {
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
      return exactAnswerFor(address);
    });

    const result = await processGeocodingOnce(workerDeps(client));
    expect(result.stale).toBe(1);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoSource).toBe('MANUAL');
    expect(stored.geoLatMicro).toBe(55_760_000);

    const job = await jobOf(order.id);
    expect(job.lastErrorCode).toBe('MANUAL_POINT_SET');
  });

  it('медленный геокодер и выход заказа из области: результат отброшен', async () => {
    const { snapshot, order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder(async (address) => {
      await apply({
        ...snapshot,
        storeId: '33333333-3333-4333-8333-333333333333',
        inScope: false,
        scopeExitReason: 'STORE_CHANGED',
        externalUpdated: '2026-08-12 16:00:00.000',
      });
      return exactAnswerFor(address);
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

    const client = fakeGeocoder(async (address) => {
      // Короткий lock_timeout: если бы worker держал строку заказа под
      // FOR UPDATE, этот запрос не дождался бы и упал.
      await ctx.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
        await tx.$executeRaw`UPDATE "DeliveryOrder" SET "updatedAt" = now() WHERE "id" = ${order.id}::uuid`;
      });
      updatedDuringRequest = true;
      return exactAnswerFor(address);
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
    const client = fakeGeocoder((address) => exactAnswerFor(address));
    await processGeocodingOnce(workerDeps(client));

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoSource).toBe('MANUAL');
    expect(stored.geoLatMicro).toBe(55_770_000);
  });
});

describe('аренда, конкуренция и восстановление', () => {
  it('второй экземпляр не обращается к геокодеру параллельно', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    let started = 0;
    const slow = fakeGeocoder(async (address) => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return exactAnswerFor(address);
    });
    const second = fakeGeocoder((address) => exactAnswerFor(address));

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
    const clientA = fakeGeocoder((address) => exactAnswerFor(address));
    const clientB = fakeGeocoder((address) => exactAnswerFor(address));

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

    const client = fakeGeocoder((address) => exactAnswerFor(address));
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

    const client = fakeGeocoder(async (address) => {
      // Пока идёт запрос, аренду перехватил другой экземпляр.
      await ctx.db.orderGeocodeJob.updateMany({
        where: { orderId: order.id },
        data: { lockedBy: 'другой-экземпляр' },
      });
      return exactAnswerFor(address);
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
    const client = fakeGeocoder((address) => exactAnswerFor(address));
    const worker = createGeocodeWorker(workerDeps(client), 10_000);
    worker.start();
    await worker.stop();
    // Повторная остановка безопасна.
    await worker.stop();
  });
});

describe('отказ провайдера останавливает пачку целиком', () => {
  const PERMANENT = ['NOT_CONFIGURED', 'PUBLIC_ENDPOINT_FORBIDDEN'] as const;

  for (const code of PERMANENT) {
    it(`${code}: ровно один запрос на всю пачку и остановка до перезапуска`, async () => {
      const orders = [await seedOrder(), await seedOrder(), await seedOrder()];
      const ids = orders.map((seeded) => seeded.order.id);
      await isolateJobs(ids);
      await resetProviderState();

      const client = fakeGeocoder(() => {
        throw new PhotonError(code);
      });

      const result = await processGeocodingOnce(workerDeps(client, { batchSize: 3 }));

      // Настройка неверна для всех заданий одинаково: девять лишних обращений
      // ничего не выяснили бы, а стоили бы времени.
      expect(client.calls).toHaveLength(1);
      expect(result.requests).toBe(1);
      expect(result.claimed).toBe(3);
      expect(result.released).toBe(2);
      expect(result.haltedReason).toBe(code);

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
      expect(state.haltedReason).toBe(code);

      // Следующий проход не делает ни одного обращения и заданий не берёт.
      const second = fakeGeocoder((address) => exactAnswerFor(address));
      const again = await processGeocodingOnce(workerDeps(second, { batchSize: 3 }));
      expect(second.calls).toHaveLength(0);
      expect(again.claimed).toBe(0);
      expect(again.haltedReason).toBe(code);
    });
  }

  it('отказ сервиса: один запрос, общая пауза и возврат остальных заданий без попыток', async () => {
    const orders = [await seedOrder(), await seedOrder(), await seedOrder()];
    const ids = orders.map((seeded) => seeded.order.id);
    await isolateJobs(ids);
    await resetProviderState();

    const now = new Date(Date.now() + 1000);
    const client = fakeGeocoder(() => {
      throw new PhotonError('SERVER_ERROR', 500);
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

    // Пауза общая: недоступен сервис целиком, а не один адрес.
    const state = await readProviderState(ctx.db);
    expect(state.haltedReason).toBeNull();
    expect(state.nextRequestAllowedAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 30_000);

    // До истечения паузы обращений нет.
    const second = fakeGeocoder((address) => exactAnswerFor(address));
    const again = await processGeocodingOnce(workerDeps(second, { batchSize: 3, now: () => now }));
    expect(second.calls).toHaveLength(0);
    expect(again.claimed).toBe(0);
    expect(again.skippedCooldown).toBe(true);
  });

  it('недоступность геокодера тоже останавливает пачку', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const now = new Date(Date.now() + 1000);
    const client = fakeGeocoder(() => {
      throw new PhotonError('TRANSPORT_ERROR');
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
    const clientA = fakeGeocoder((address) => {
      track();
      return exactAnswerFor(address);
    });
    await processGeocodingOnce(workerDeps(clientA, { batchSize: 1, slot, now: () => frozen }));

    const clientB = fakeGeocoder((address) => {
      track();
      return exactAnswerFor(address);
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
    const withoutAddress = await seedOrder({ shipmentAddress: null, shipmentAddressFull: null });

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
      withoutAddress.push(
        await seedOrder({ shipmentAddress: i === 0 ? null : '   ', shipmentAddressFull: null }),
      );
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

  it('запуск приложения историю не сканирует и ждать при остановке нечего', async () => {
    // Проверка читает исходный код точки входа: поднимать процесс ради этого
    // незачем, а вернувшееся стартовое наполнение проявилось бы только
    // на реальной базе — 685 заданий за минуту, как это и случилось.
    const { readFile } = await import('node:fs/promises');
    const code = await readFile(new URL('../../../index.ts', import.meta.url), 'utf8');

    // Массового прохода по истории при старте нет вовсе.
    expect(code).not.toContain('backfillGeocoding');
    expect(code).not.toContain('backfillStopping');
    // И останавливать при завершении тоже нечего.
    expect(code).not.toContain('backfill ?? Promise.resolve()');

    // Создание заданий и обращение к геокодеру — разные решения.
    expect(code).toContain('enqueueOnImport');
    expect(code).toContain('shouldGeocodeAutomatically');
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

describe('очередь наполняется событиями, а не состоянием', () => {
  /**
   * Разобранный адрес: синтетический, настоящих адресов тут нет.
   *
   * Прежде приложение при каждом запуске ставило в очередь ВСЕ исторические
   * заказы без координат — 685 заданий за минуту на staging. Геокодировать
   * надо событие, а не состояние: отсутствие координат у старого заказа
   * событием не является.
   */
  const FULL = {
    postalCode: '141014',
    country: { name: 'Россия' },
    region: { name: 'Московская область' },
    city: 'Мытищи',
    street: 'Олимпийский проспект',
    house: '29',
    apartment: '137',
  };

  async function jobsOf(orderId: string): Promise<number> {
    return ctx.db.orderGeocodeJob.count({ where: { orderId } });
  }

  it('первый импорт нового заказа создаёт ровно одно задание с geocodeAddress', async () => {
    const snapshot = mapOrder(
      source({ shipmentAddressFull: FULL }) as never,
      IDS,
      'shipmentAddressFull',
    ).snapshot;
    await apply(snapshot);

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    expect(await jobsOf(order.id)).toBe(1);
    expect(order.geocodeAddress).not.toBeNull();
    // Источником запроса стал разобранный адрес, а не строка источника.
    expect(order.geoState).toBe('PENDING');
  });

  it('повторный импорт того же снимка второго задания не создаёт', async () => {
    const snapshot = mapOrder(
      source({ shipmentAddressFull: FULL }) as never,
      IDS,
      'shipmentAddressFull',
    ).snapshot;
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });

    await apply(snapshot);
    expect(await jobsOf(order.id)).toBe(1);
  });

  it('появившийся адрес создаёт задание: заказ импортирован пустым, адрес пришёл потом', async () => {
    /*
     * Тот самый случай 137977CRM.
     *
     * Заказ создаётся в МоемСкладе без адреса доставки, склад дозаполняет
     * `shipmentAddressFull` позже, и повторный импорт приносит адрес. Прежде
     * событие «у заказа появился адрес» не фиксировалось вовсе: задания
     * не возникало, и заказ навсегда оставался без координат, хотя адрес
     * у него уже был.
     */
    const empty = mapOrder(
      source({ shipmentAddress: null, shipmentAddressFull: null }) as never,
      IDS,
      'shipmentAddressFull',
    ).snapshot;
    await apply(empty);

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: empty.externalId },
    });
    expect(order.geocodeAddress).toBeNull();
    expect(await jobsOf(order.id)).toBe(0);

    /*
     * Адрес берётся тем же генератором, что и в остальных проверках файла:
     * поддельный геокодер отвечает по разобранному запросу, и синтетический
     * адрес обязан пройти сверку ответа так же, как у обычного заказа.
     */
    const filled = mapOrder(
      source({
        id: empty.externalId,
        name: empty.externalName,
        updated: '2026-08-12 15:00:00.000',
      }) as never,
      IDS,
      'shipmentAddressFull',
    ).snapshot;
    await apply({ ...filled, externalUpdated: '2026-08-12 15:00:00.000' });

    const withAddress = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(withAddress.geocodeAddress).not.toBeNull();
    expect(withAddress.geoState).toBe('PENDING');
    expect(await jobsOf(order.id)).toBe(1);

    // Повторный импорт того же адреса второго задания не создаёт.
    await apply({ ...filled, externalUpdated: '2026-08-12 15:00:00.000' });
    expect(await jobsOf(order.id)).toBe(1);

    // И после обработки у заказа появляются координаты.
    await isolateJobs([order.id]);
    await resetProviderState();
    const client = fakeGeocoder((address) => exactAnswerFor(address));
    const processed = await processGeocodingOnce(workerDeps(client));
    expect(processed.resolved).toBe(1);

    const resolved = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(resolved.geoState).toBe('RESOLVED');
    expect(resolved.geoLatMicro).not.toBeNull();
    expect(resolved.geoLonMicro).not.toBeNull();
  });

  it('изменившийся адрес источника ставит заказ в очередь заново', async () => {
    const first = mapOrder(
      source({ shipmentAddressFull: FULL }) as never,
      IDS,
      'shipmentAddressFull',
    ).snapshot;
    await apply(first);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: first.externalId },
    });
    const before = await jobsOf(order.id);

    const changed = mapOrder(
      source({
        id: first.externalId,
        name: first.externalName,
        shipmentAddressFull: { ...FULL, house: '31' },
        updated: '2026-08-12 15:00:00.000',
      }) as never,
      IDS,
      'shipmentAddressFull',
    ).snapshot;
    await apply({ ...changed, externalUpdated: '2026-08-12 15:00:00.000' });

    // Адрес другой — значит и точка нужна другая: прежняя снята, задание есть.
    expect(await jobsOf(order.id)).toBe(before + 1);
    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.geoLatMicro).toBeNull();
    expect(after.geoState).toBe('PENDING');
  });

  it('правка логиста сильнее источника: ни адрес, ни точка не перетираются', async () => {
    const first = mapOrder(
      source({ shipmentAddressFull: FULL }) as never,
      IDS,
      'shipmentAddressFull',
    ).snapshot;
    await apply(first);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: first.externalId },
    });

    // Логист задал собственный адрес и подтвердил точку руками.
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'], status: 'ACTIVE' });
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: {
        localAddress: 'Москва, адрес логиста, дом 7',
        localAddressSetAt: new Date(),
        localAddressSetById: logist.id,
        sourceAddressAtLocalEdit: order.address,
        geoState: 'RESOLVED',
        geoSource: 'MANUAL',
        geoPrecision: 'EXACT_HOUSE',
        geoLatMicro: 55_700_000,
        geoLonMicro: 37_600_000,
        geoResolvedAt: new Date(),
      },
    });
    const before = await jobsOf(order.id);

    const changed = mapOrder(
      source({
        id: first.externalId,
        name: first.externalName,
        shipmentAddressFull: { ...FULL, house: '41' },
        updated: '2026-08-12 16:00:00.000',
      }) as never,
      IDS,
      'shipmentAddressFull',
    ).snapshot;
    await apply({ ...changed, externalUpdated: '2026-08-12 16:00:00.000' });

    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    // Автоматический источник равен адресу логиста и не менялся: ни нового
    // задания, ни потери подтверждённой человеком точки.
    expect(await jobsOf(order.id)).toBe(before);
    expect(after.localAddress).toBe('Москва, адрес логиста, дом 7');
    expect(after.geoSource).toBe('MANUAL');
    expect(after.geoLatMicro).toBe(55_700_000);
  });

  it('без включённого создания заданий импорт очередь не трогает', async () => {
    const snapshot = snapshotOf();
    await ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, NOW, { geocoding: false }));

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    expect(await jobsOf(order.id)).toBe(0);
  });
});

describe('кэш по нормализованному адресу', () => {
  it('нормализация приводит разные написания одного адреса к одному ключу', () => {
    const canonical = normalizeAddress('Москва, улица Синтетическая, дом 1, корпус 2');

    for (const variant of [
      'москва, ул. Синтетическая, д.1, к.2',
      'Москва,  ул.Синтетическая,  д. 1,  корп. 2',
      'МОСКВА, УЛ СИНТЕТИЧЕСКАЯ, Д 1, К 2',
      'Москва; ул. Синтетическая; д.1; к.2',
    ]) {
      expect(normalizeAddress(variant), variant).toBe(canonical);
    }

    // Ё и е в адресах пишут вперемешку, и это один и тот же адрес.
    expect(normalizeAddress('Посёлок Берёзовый')).toBe(normalizeAddress('Поселок Березовый'));

    // Разные адреса не должны сливаться: иначе кэш выдал бы чужую точку.
    expect(normalizeAddress('улица Синтетическая, дом 1')).not.toBe(
      normalizeAddress('улица Синтетическая, дом 2'),
    );

    // Пусто — значит ключа нет: пустой адрес не ищут и не кэшируют.
    for (const blank of ['', '   ', ',,;', null, undefined]) {
      expect(normalizeAddress(blank), JSON.stringify(blank)).toBe('');
    }
  });

  it('один и тот же адрес геокодируется ровно один раз', async () => {
    // Два разных заказа с одинаковым адресом — обычное дело: один дом,
    // несколько букетов. Платить за это двумя обращениями незачем.
    const full = uniqueStructured();
    // Ожидаемая строка записана здесь явно, а не собрана продуктовым кодом:
    // иначе проверка согласилась бы с любой его ошибкой.
    const address = `${full.city}, ${full.street}, ${full.house}`;
    const first = await seedOrder({ shipmentAddressFull: full });
    const second = await seedOrder({ shipmentAddressFull: { ...full } });
    const ids = [first.order.id, second.order.id];

    await isolateJobs(ids);
    await resetProviderState();

    const client = fakeGeocoder((address) => exactAnswerFor(address));
    const result = await processGeocodingOnce(workerDeps(client, { batchSize: 2 }));

    expect(result.resolved).toBe(2);
    // Главное утверждение: обращение ровно одно на оба заказа.
    expect(client.calls).toHaveLength(1);
    expect(result.requests).toBe(1);

    // При этом точку получили ОБА заказа: кэш экономит запрос, а не результат.
    for (const id of ids) {
      const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id } });
      expect(stored.geoState).toBe('RESOLVED');
      expect(stored.geoSource).toBe('PHOTON');
      expect(stored.geoLatMicro).toBe(55_751_244);
    }

    const entry = await ctx.db.geocodeCacheEntry.findUniqueOrThrow({
      where: { normalizedAddress: normalizeAddress(address) },
    });
    expect(entry.outcome).toBe('HOUSE');
    expect(entry.source).toBe('PHOTON');
    // Второй заказ пришёл из кэша, и это видно в счётчике.
    expect(entry.hits).toBe(1);
  });

  it('отрицательный ответ тоже кэшируется и не повторяется', async () => {
    // «Не найдено» — такой же ответ, как найденный дом. Повторять безнадёжный
    // поиск на каждом проходе значит нагружать сервис ради того же ответа.
    const full = uniqueStructured();
    const address = `${full.city}, ${full.street}, ${full.house}`;
    const first = await seedOrder({ shipmentAddressFull: full });
    const second = await seedOrder({ shipmentAddressFull: { ...full } });
    const ids = [first.order.id, second.order.id];

    await isolateJobs(ids);
    await resetProviderState();

    const client = fakeGeocoder(() => null);
    const result = await processGeocodingOnce(workerDeps(client, { batchSize: 2 }));

    expect(result.lowPrecision).toBe(2);
    expect(client.calls).toHaveLength(1);

    const entry = await ctx.db.geocodeCacheEntry.findUniqueOrThrow({
      where: { normalizedAddress: normalizeAddress(address) },
    });
    expect(entry.outcome).toBe('NOT_FOUND');
    // Координат у отрицательного ответа нет и быть не может.
    expect(entry.latMicro).toBeNull();
    expect(entry.lonMicro).toBeNull();

    for (const id of ids) {
      const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id } });
      expect(stored.geoState).toBe('NEEDS_REVIEW');
      expect(stored.geoLatMicro).toBeNull();
    }
  });

  it('неточный ответ кэшируется без координат: пригодной точкой он не станет', async () => {
    const full = uniqueStructured();
    const address = `${full.city}, ${full.street}, ${full.house}`;
    const { order } = await seedOrder({ shipmentAddressFull: full });
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder(() => ({ lat: 55.7, lon: 37.6, precision: 'STREET' }));
    await processGeocodingOnce(workerDeps(client));

    const entry = await ctx.db.geocodeCacheEntry.findUniqueOrThrow({
      where: { normalizedAddress: normalizeAddress(address) },
    });
    expect(entry.outcome).toBe('AMBIGUOUS');
    expect(entry.latMicro).toBeNull();
    expect(entry.lonMicro).toBeNull();
  });

  it('повторный проход по тому же заказу нового обращения не делает', async () => {
    const full = uniqueStructured();
    const { order } = await seedOrder({ shipmentAddressFull: full });
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder((address) => exactAnswerFor(address));
    await processGeocodingOnce(workerDeps(client));
    expect(client.calls).toHaveLength(1);

    // Заказ не менялся — значит и спрашивать нечего. Задание ставится заново
    // только руками, и даже тогда ответ берётся из кэша.
    await ctx.db.orderGeocodeJob.updateMany({
      where: { orderId: order.id },
      data: { status: 'PENDING', finishedAt: null, lockedAt: null, lockedBy: null },
    });
    await isolateJobs([order.id]);

    const again = await processGeocodingOnce(workerDeps(client));
    expect(again.resolved).toBe(1);
    expect(client.calls).toHaveLength(1);
    expect(again.requests).toBe(0);
  });

  it('ручная правка адреса обращается заново: ключ кэша изменился вместе с адресом', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder((address) => exactAnswerFor(address));
    await processGeocodingOnce(workerDeps(client));
    expect(client.calls).toHaveLength(1);

    // Правку делает логист — это событие, и оно создаёт новое задание.
    // Правка идёт настоящим путём логиста: у локального адреса есть инварианты
    // базы — автор и время, — и обходить их в проверке значило бы проверять
    // не тот путь, которым пользуются.
    const token = await tokenFor(['LOGISTICIAN']);
    const edit = await ctx.app.inject({
      method: 'PUT',
      url: `/api/orders/${order.id}/address`,
      headers: { authorization: `Bearer ${token}` },
      payload: { address: OTHER_ADDRESS },
    });
    expect(edit.statusCode).toBe(200);

    // Контрольные утверждения СРАЗУ после правки: причина должна быть доказана
    // до любой правки продуктового кода.
    const afterEdit = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterEdit.localAddress, 'правка не сохранилась').toBe(OTHER_ADDRESS);
    const jobsAfterEdit = await ctx.db.orderGeocodeJob.findMany({
      where: { orderId: order.id },
      orderBy: { geoGeneration: 'asc' },
    });
    expect(jobsAfterEdit, 'нового задания нет').toHaveLength(2);
    expect(jobsAfterEdit[1]?.geoGeneration, 'поколение не выросло').toBe(
      (jobsAfterEdit[0]?.geoGeneration ?? 0) + 1,
    );
    expect(jobsAfterEdit[1]?.status).toBe('PENDING');
    // Источник запроса — адрес логиста.
    expect(afterEdit.localAddress).toBe(OTHER_ADDRESS);

    await isolateJobs([order.id]);

    const again = await processGeocodingOnce(workerDeps(client));
    expect(again.resolved).toBe(1);
    // Новый адрес — новый запрос: старый ответ к нему не относится.
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]).toBe(OTHER_ADDRESS);
  });

  it('в кэше нет ничего, кроме ключа, исхода и координат', async () => {
    const entries = await ctx.db.geocodeCacheEntry.findMany({ take: 50 });
    for (const entry of entries) {
      // Кэш — не история: ни заказа, ни получателя, ни телефона в нём нет.
      expect(Object.keys(entry).sort()).toEqual(
        [
          'createdAt',
          'hits',
          'latMicro',
          'lonMicro',
          'normalizedAddress',
          'outcome',
          'source',
          'updatedAt',
        ].sort(),
      );
    }
  });
});

describe('ограниченный backfill: потолок обязателен', () => {
  it('проход без явного потолка не запускается', () => {
    // Умолчания нет намеренно: «ограниченный» проход без потолка ограниченным
    // не является, а молчаливое умолчание однажды окажется не тем.
    expect(parseBackfillOptions([])).toMatch(/--limit/);
    expect(parseBackfillOptions(['--limit'])).toMatch(/--limit/);
  });

  it('нечисловой, нулевой, отрицательный и запредельный потолок отвергаются', () => {
    for (const raw of ['0', '-1', '1.5', 'много', '', String(MAX_LIMIT + 1)]) {
      expect(parseBackfillOptions(['--limit', raw]), raw).toBeTypeOf('string');
    }
  });

  it('осмысленный потолок принимается, и это именно число обращений', () => {
    expect(parseBackfillOptions(['--limit', '200'])).toEqual({ limit: 200, reportOnly: false });
    expect(parseBackfillOptions([String('--report-only')])).toEqual({ limit: 0, reportOnly: true });
  });

  it('неизвестный аргумент останавливает проход, а не игнорируется', () => {
    // Опечатка в имени флага не должна тихо превращаться в проход без потолка.
    expect(parseBackfillOptions(['--limitt', '200'])).toMatch(/Неизвестный аргумент/);
    expect(parseBackfillOptions(['--limit', '200', '--force'])).toMatch(/Неизвестный аргумент/);
  });
});

describe('сводка для отчёта', () => {
  it('разрешённый Photon заказ виден в сводке, и знаменатель не сдвигается', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    // Сводка снимается ПОСЛЕ сброса: он чистит кэш, и снимок до него сравнивал
    // бы разные состояния.
    await resetProviderState();
    const before = await geocodingReport(ctx.db);

    await processGeocodingOnce(workerDeps(fakeGeocoder((address) => exactAnswerFor(address))));
    const after = await geocodingReport(ctx.db);

    // Заказ переходит из «в очереди» в «найдено». Знаменатель при этом
    // не растёт: адрес был и остался одним и тем же.
    expect(after.exactByPhoton).toBe(before.exactByPhoton + 1);
    expect(after.pending).toBe(before.pending - 1);
    expect(after.totalAddresses).toBe(before.totalAddresses);
    expect(after.cachedAddresses).toBe(before.cachedAddresses + 1);
    // Точку поставил Photon, а не человек: ручные счётчики не сдвинулись.
    expect(after.correctedViaDadata).toBe(before.correctedViaDadata);
    expect(after.correctedManually).toBe(before.correctedManually);
  });

  it('ненайденный адрес попадает в свою строку, а не теряется', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();
    const before = await geocodingReport(ctx.db);

    await processGeocodingOnce(workerDeps(fakeGeocoder(() => null)));
    const after = await geocodingReport(ctx.db);

    // «Не найдено» видно и в кэше, и среди требующих человека заказов.
    expect(after.notFound).toBe(before.notFound + 1);
    expect(after.ambiguous).toBe(before.ambiguous + 1);
    expect(after.exactByPhoton).toBe(before.exactByPhoton);
  });

  it('в сводку не попадает ни одной строки: только числа', async () => {
    const report = await geocodingReport(ctx.db);

    // Эта сводка идёт в отчёт владельцу. Одно строковое поле — и однажды в нём
    // окажется адрес.
    for (const [key, value] of Object.entries(report)) {
      expect(typeof value, key).toBe('number');
      expect(Number.isInteger(value), key).toBe(true);
      expect(value, key).toBeGreaterThanOrEqual(0);
    }

    const text = JSON.stringify(report);
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain('улица');
  });
});

describe('состояние интеграции и отсутствие персональных данных', () => {
  it('публичный статус отдаёт только высокоуровневое состояние', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/status' });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      integrations: { provider: string; state: string; pendingOperations?: number }[];
    };
    const dadata = body.integrations.find((row) => row.provider === GEOCODER_PROVIDER);
    expect(dadata).toBeDefined();
    expect(dadata?.pendingOperations).toBeUndefined();
    expect(Object.keys(dadata ?? {}).sort()).toEqual(['provider', 'state', 'updatedAt']);
  });

  it('администратору видны счётчик и очищенные детали, но не ключи и не адреса', async () => {
    const { order } = await seedOrder();
    await isolateJobs([order.id]);
    await resetProviderState();

    const client = fakeGeocoder(() => {
      throw new PhotonError('SERVER_ERROR', 500);
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
    const dadata = body.integrations.find((row) => row.provider === GEOCODER_PROVIDER);
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

    const client = fakeGeocoder((address) => exactAnswerFor(address));
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

describe('заключительные гарантии контракта', () => {
  it('настроенный Photon без разобранного источника — конфигурационная ошибка', () => {
    // Иначе геокодирование выглядело бы включённым и не работало: разобранный
    // адрес не собирается, а старый address источником не является.
    const base = {
      DATABASE_URL: resolveTestDatabaseUrl(),
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_ENV: 'local',
      APP_ENVIRONMENT_MARKER: 'local',
      ...TEST_SECRETS,
    };

    expect(() => loadConfig({ ...base, PHOTON_URL: 'http://photon.internal:2322/api' })).toThrow(
      /MOYSKLAD_GEOCODING_ADDRESS_SOURCE/,
    );

    // С разобранным источником — поднимается.
    expect(() =>
      loadConfig({
        ...base,
        PHOTON_URL: 'http://photon.internal:2322/api',
        MOYSKLAD_GEOCODING_ADDRESS_SOURCE: 'shipmentAddressFull',
      }),
    ).not.toThrow();

    // Без Photon источник роли не играет: геокодировать всё равно нечем.
    expect(() => loadConfig(base)).not.toThrow();
  });

  it('при источнике по умолчанию событийного задания не возникает', async () => {
    // Старый address заполнен, но основанием не служит.
    const snapshot = mapOrder(source() as never, IDS).snapshot;
    expect(snapshot.address).not.toBeNull();
    expect(snapshot.geocodeAddress).toBeNull();

    await ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, NOW, { geocoding: true }));

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    expect(await ctx.db.orderGeocodeJob.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('явный операторский backfill по-прежнему берёт старый address', async () => {
    // Единственное место, где запасной вариант сохранён: выбор делает человек,
    // а не автоматика. Потерять это значило бы лишить оператора возможности
    // разобрать историю.
    const snapshot = mapOrder(source() as never, IDS).snapshot;
    await ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, NOW, { geocoding: true }));

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    expect(order.localAddress).toBeNull();
    expect(order.geocodeAddress).toBeNull();
    expect(order.address).not.toBeNull();
    expect(await ctx.db.orderGeocodeJob.count({ where: { orderId: order.id } })).toBe(0);

    // Оператор запускает проход явно — и заказ в очередь попадает.
    await backfillGeocoding(ctx.db, { batchSize: 200 });

    const jobs = await ctx.db.orderGeocodeJob.findMany({ where: { orderId: order.id } });
    expect(jobs, 'явный backfill не поставил заказ в очередь').toHaveLength(1);
    // И запросом для него служит именно старый address.
    expect(geocodingAddress(order)).toBe(order.address);
  });
});
