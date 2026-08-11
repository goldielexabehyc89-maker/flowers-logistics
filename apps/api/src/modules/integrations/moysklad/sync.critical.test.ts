/**
 * Критические проверки синхронизации заказов.
 *
 * К настоящему API обращений нет: используется поддельный `fetch` и управляемые
 * часы. Реальных пауз в тестах не бывает — ожидание инъецируется.
 */

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  testConfig,
  type TestContext,
} from '../../auth/testing/harness.js';
import type { AppConfig } from '../../../platform/config.js';
import { ALLOWED_TEST_DATABASES } from '../../../platform/testing/test-database.js';
import { MoyskladClient, MoyskladError } from './client.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from './config.js';
import { approvedStoreFilter, deltaFilter, formatMoment } from './filters.js';
import { formatMoscow, moscowDate, MoscowTimeParseError, parseMoscow } from './moscow-time.js';
import {
  SYNC_LOCK_KEY,
  acquireSyncLock,
  type LockConnection,
  type LockDeps,
  type SyncLock,
} from './sync-lock.js';
import { checkSyncOnceEnvironment, performSyncOnce } from './sync-once.js';
import {
  backoffForAttempt,
  initialLoadSince,
  PAGE_SIZE,
  PROVIDER,
  rateLimitDelay,
  runSyncOnce,
  type SyncDeps,
} from './sync.js';

let ctx: TestContext;
const logger = pino({ level: 'silent' });
const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;

beforeAll(async () => {
  ctx = await createTestContext();
  assertDisposableDatabase(ctx.config.DATABASE_URL);
});

/**
 * Fail closed для уборки соединений.
 *
 * Уборка закрывает соединения с базой, и делать это она вправе только там, где
 * база одноразовая. `resolveTestDatabaseUrl` уже отказывает при staging- и
 * production-маркерах, но проверка повторяется здесь и по ИМЕНИ базы: между
 * созданием контекста и уборкой стоит один шаг, и полагаться на то, что
 * соседний модуль всё проверил, — это доверие вместо доказательства.
 */
function assertDisposableDatabase(connectionString: string): void {
  const name = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));

  if (!(ALLOWED_TEST_DATABASES as readonly string[]).includes(name)) {
    throw new Error(
      `Уборка соединений допустима только в одноразовой базе (${ALLOWED_TEST_DATABASES.join(', ')}), ` +
        `а подключение указывает на «${name}»`,
    );
  }
}

afterAll(async () => {
  await closeTestContext(ctx);
});

beforeEach(async () => {
  // Курсор общий на провайдера: между сценариями его состояние сбрасывается.
  await ctx.db.integrationCursor.deleteMany({ where: { provider: PROVIDER } });
});

/**
 * Страховка освобождения блокировки прохода.
 *
 * Блокировка прохода — уровня СЕССИИ: она живёт, пока живёт соединение, и это
 * правильно для боевого кода. Но прерванный сценарий уносит замок с собой:
 * продуктовый `finally` до конца не доходит, а следующие сценарии получают
 * «проход уже выполняется» и падают все подряд. Один отказ превращался в семь.
 *
 * Чужие сессии при этом НЕ завершаются, и нужды в этом нет. Все настоящие
 * соединения замка в этом файле открывает `connectTestLock`, и каждое
 * регистрируется в момент создания — включая те, что берёт продуктовый код
 * внутри прохода. Закрыть собственное соединение можно всегда, а
 * `pg_terminate_backend` бил бы по сессиям, которых мы не открывали, полагаясь
 * на признак принадлежности вместо факта владения.
 */
afterEach(async () => {
  await releaseSyncLockSessions();
});

/**
 * Уборка соединений замка. Вызывается страховкой и направленной проверкой:
 * утверждение «посторонние сессии не затрагиваются» должно проверять ту же
 * функцию, что работает после каждого сценария, а не её описание.
 */
async function releaseSyncLockSessions(): Promise<void> {
  // 1. Поддельная блокировка. Это состояние ТЕСТА, а не продукта: множество
  //    ключей живёт в модуле и между сценариями обязано быть пустым.
  heldLocks.clear();

  // 2. Настоящие соединения, открытые этим файлом. Закрытие сессии снимает
  //    её session-lock — отдельный unlock для этого не нужен и не всегда
  //    возможен: прерванный сценарий ссылки на замок не оставляет.
  const opened = [...openedLockClients];
  openedLockClients.clear();
  for (const client of opened) {
    await client.end().catch(() => undefined);
  }

  // 3. Ожидание ФАКТА, а не времени. Сервер освобождает session-lock при выходе
  //    backend-процесса, и между end() и этим моментом есть окно. Пауза здесь
  //    гадала бы о его длине; вместо неё тот же ключ берётся транзакционно —
  //    запрос ждёт ровно до освобождения и возвращается сразу, как только оно
  //    произошло. lock_timeout ограничивает ожидание сверху, чтобы настоящая
  //    утечка стала громким отказом, а не зависанием.
  await ctx.db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${Number(SYNC_LOCK_KEY)}::bigint)`;
  });
}

/**
 * Настоящее соединение блокировки, принадлежащее ТЕСТУ.
 *
 * Отличается от боевого одним: у клиента есть обработчик `error`. Страховка
 * закрывает сессию прерванного сценария, и клиент этой сессии узнаёт об этом
 * событием — без обработчика оно всплывает как необработанная ошибка процесса
 * и роняет прогон уже после того, как все проверки прошли.
 *
 * В боевом коде такого обработчика нет намеренно: там сессию никто не закрывает
 * снаружи, а молчаливое проглатывание ошибки соединения скрыло бы настоящий
 * обрыв связи с базой.
 */
const openedLockClients = new Set<Client>();

/** Метка сессий этого файла. Нужна для разбора, а не для принятия решений. */
const TEST_LOCK_APPLICATION = 'fl-critical-sync-lock';

/** Соседний ключ: им пользуется геокодирование. Уборка его не касается. */
const FOREIGN_LOCK_KEY = 730_205n;

async function connectTestLock(connectionString: string): Promise<LockConnection> {
  const client = new Client({ connectionString, application_name: TEST_LOCK_APPLICATION });
  // Обрыв соединения ожидаем: страховка закрывает его сама.
  client.on('error', () => undefined);
  await client.connect();
  // Регистрация в момент создания — до того, как соединение кому-либо отдано.
  // Именно это делает ненужным завершение чужих сессий: даже если замок возьмёт
  // продуктовый код, а сценарий прервётся, соединение останется нашим.
  openedLockClients.add(client);

  return {
    async tryLock(key: bigint) {
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [key.toString()],
      );
      return result.rows[0]?.locked === true;
    },
    async unlock(key: bigint) {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [key.toString()]);
    },
    async close() {
      openedLockClients.delete(client);
      // Соединение уже могло быть закрыто страховкой: это не ошибка.
      await client.end().catch(() => undefined);
    },
  };
}

/** Настоящая блокировка на тестовой базе. Соединение принадлежит тесту. */
function realLock(): LockDeps {
  return { connectionString: ctx.config.DATABASE_URL, connect: connectTestLock };
}

/**
 * Захват настоящей блокировки с учётом.
 *
 * Сценарий не обязан помнить об освобождении: забытый замок снимет страховка.
 * Но забытым он при этом не становится незаметно — учёт и есть способ
 * отличить «освободили» от «повезло».
 */
const trackedLocks = new Set<{ release: () => Promise<void> }>();

async function acquireTracked(deps: LockDeps): Promise<SyncLock | null> {
  const lock = await acquireSyncLock(deps);
  if (lock !== null) {
    trackedLocks.add(lock);
  }
  return lock;
}

async function releaseTracked(lock: SyncLock | null): Promise<void> {
  if (lock === null) {
    return;
  }
  trackedLocks.delete(lock);
  await lock.release();
}

/** Заказ МоегоСклада в нашей области. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    name: `A-${process.hrtime.bigint() % 1_000_000n}`,
    updated: '2026-08-06 10:00:00.000',
    shipmentAddress: 'Москва, тестовый адрес',
    deliveryPlannedMoment: '2026-08-07 12:00:00.000',
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
      { id: IDS.recipientAttribute, value: 'Получатель Тестовый' },
    ],
    ...overrides,
  };
}

/** Значение способа получения «Самовывоз» из справочника МоегоСклада. */
const PICKUP_METHOD_ID = '76f4977e-d33e-11ef-0a80-03b6000e555e';

/** Заказ утверждённого склада с самовывозом: производственная область без логистической. */
function pickupRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = row(overrides);
  const attributes = (base['attributes'] as Record<string, unknown>[]).filter(
    (attribute) => attribute['id'] !== IDS.deliveryMethodAttribute,
  );
  return {
    ...base,
    attributes: [
      ...attributes,
      {
        id: IDS.deliveryMethodAttribute,
        value: { name: 'Самовывоз', meta: { href: href('customentity', PICKUP_METHOD_ID) } },
      },
    ],
  };
}

interface FakeApi {
  calls: { url: string; filter: string; limit: string; offset: string; expand: string }[];
  fetch: typeof globalThis.fetch;
}

/** Поддельный API: отдаёт заранее заданные страницы и записывает запросы. */
function fakeApi(
  pages: Record<string, unknown>[][],
  options: { failAtPage?: number; status?: number; headers?: Record<string, string> } = {},
): FakeApi {
  const calls: FakeApi['calls'] = [];
  const total = pages.reduce((sum, page) => sum + page.length, 0);

  const fetchImpl = (async (url: string) => {
    const parsed = new URL(String(url));
    const params = parsed.searchParams;
    calls.push({
      url: String(url),
      filter: params.get('filter') ?? '',
      limit: params.get('limit') ?? '',
      offset: params.get('offset') ?? '0',
      expand: params.get('expand') ?? '',
    });

    const index = calls.length - 1;
    if (options.failAtPage !== undefined && index === options.failAtPage) {
      return new Response('{}', { status: options.status ?? 500, headers: options.headers });
    }

    const page = pages[index] ?? [];
    return new Response(JSON.stringify({ rows: page, meta: { size: total } }), {
      status: 200,
      headers: { 'content-type': 'application/json', ...options.headers },
    });
  }) as unknown as typeof globalThis.fetch;

  return { calls, fetch: fetchImpl };
}

/** Реестр занятых ключей: заменяет соединение PostgreSQL в тестах. */
const heldLocks = new Set<string>();
let closedConnections = 0;

function fakeLock() {
  return {
    connectionString: 'postgres://fake',
    connect: async () => ({
      tryLock: async (key: bigint) => {
        if (heldLocks.has(key.toString())) {
          return false;
        }
        heldLocks.add(key.toString());
        return true;
      },
      unlock: async (key: bigint) => {
        heldLocks.delete(key.toString());
      },
      close: async () => {
        closedConnections += 1;
      },
    }),
  };
}

function deps(api: FakeApi, now = new Date('2026-08-06T09:00:00.000Z')): SyncDeps {
  return {
    db: ctx.db,
    client: new MoyskladClient({
      config: { baseUrl: MOYSKLAD_BASE_URL, token: 'test-token', ids: IDS, readOnly: true },
      fetch: api.fetch,
      now: () => 0,
      sleep: async () => undefined,
      minIntervalMs: 0,
    }),
    logger,
    ids: IDS,
    now: () => now,
    sleep: async () => undefined,
    overlapSeconds: 300,
    lock: fakeLock(),
  };
}

describe('нижняя граница первоначальной загрузки', () => {
  it('считается как начало дня Москвы минус три дня', () => {
    // 06.08.2026 09:00 UTC = 12:00 Москвы. Начало дня Москвы минус 3 дня — 03.08 00:00 МСК.
    expect(initialLoadSince(new Date('2026-08-06T09:00:00.000Z')).toISOString()).toBe(
      '2026-08-02T21:00:00.000Z',
    );
    // То же значение, отправленное в фильтр, обязано быть московским.
    expect(formatMoment(initialLoadSince(new Date('2026-08-06T09:00:00.000Z')))).toBe(
      '2026-08-03 00:00:00',
    );
  });

  it('около полуночи Москвы день не съезжает', () => {
    // 21:30 UTC = 00:30 следующего дня по Москве.
    expect(initialLoadSince(new Date('2026-08-05T21:30:00.000Z')).toISOString()).toBe(
      '2026-08-02T21:00:00.000Z',
    );
  });

  it('смена месяца и года обрабатывается календарно', () => {
    expect(initialLoadSince(new Date('2026-03-01T10:00:00.000Z')).toISOString()).toBe(
      '2026-02-25T21:00:00.000Z',
    );
    expect(initialLoadSince(new Date('2026-01-01T10:00:00.000Z')).toISOString()).toBe(
      '2025-12-28T21:00:00.000Z',
    );
  });
});

describe('фильтры', () => {
  it('полный фильтр содержит склад и нижнюю дату, но НЕ способ получения', () => {
    const filter = approvedStoreFilter(IDS, new Date('2026-08-02T21:00:00.000Z'));

    expect(filter).toContain(`store=${MOYSKLAD_BASE_URL}/entity/store/${IDS.store}`);
    // Московское время, а не UTC: иначе окно уехало бы на три часа назад.
    expect(filter).toContain('deliveryPlannedMoment>=2026-08-03 00:00:00');
    // Способ получения на сервере не фильтруется: иначе самовывоз утверждённого
    // склада не попал бы ни в первоначальную загрузку, ни в контрольную сверку.
    expect(filter).not.toContain(IDS.deliveryMethodAttribute);
    expect(filter).not.toContain(IDS.deliveryMethodDelivery);
    expect(filter).not.toContain('state');
    expect(filter).not.toContain('updated<=');
  });

  it('delta-фильтр содержит только окно updated', () => {
    const filter = deltaFilter(
      new Date('2026-08-06T08:55:00.000Z'),
      new Date('2026-08-06T09:00:00.000Z'),
    );

    expect(filter).toBe('updated>=2026-08-06 11:55:00;updated<=2026-08-06 12:00:00');
    expect(filter).not.toContain('store');
    expect(filter).not.toContain('attributes');
    expect(filter).not.toContain('state');
  });

  it('значение фильтра доходит до API без двойного кодирования', async () => {
    const api = fakeApi([[]]);
    await runSyncOnce(deps(api));

    const call = api.calls[0];
    expect(call?.expand).toBe('state');
    expect(call?.limit).toBe(String(PAGE_SIZE));
    // URLSearchParams декодирует значение обратно: href остаётся href.
    expect(call?.filter).toContain('https://api.moysklad.ru/api/remap/1.2/entity/store/');
    expect(call?.filter).not.toContain('%3A%2F%2F');
    expect(call?.url).toContain('%3B');
  });
});

describe('первоначальная загрузка', () => {
  it('пустая выборка завершает загрузку одной страницей', async () => {
    const api = fakeApi([[]]);
    const result = await runSyncOnce(deps(api));

    expect(result.kind).toBe('initial');
    expect(api.calls).toHaveLength(1);

    const cursor = await ctx.db.integrationCursor.findUniqueOrThrow({
      where: { provider: PROVIDER },
    });
    expect(cursor.initialLoadCompleted).toBe(true);
  });

  it('несколько страниц читаются последовательно без отдельных GET на заказ', async () => {
    const first = Array.from({ length: PAGE_SIZE }, () => row());
    const second = [row(), row()];
    const api = fakeApi([first, second]);

    const result = await runSyncOnce(deps(api));

    expect(result.processed).toBe(PAGE_SIZE + 2);
    expect(api.calls).toHaveLength(2);
    expect(api.calls.every((call) => call.limit === String(PAGE_SIZE))).toBe(true);
    // Индивидуальных запросов карточек нет: все обращения — к списку.
    expect(api.calls.every((call) => call.url.includes('/entity/customerorder?'))).toBe(true);
  });

  it('ошибка средней страницы не завершает загрузку и не двигает курсор', async () => {
    const api = fakeApi([[row()], [row()]], { failAtPage: 1, status: 500 });

    await expect(runSyncOnce(deps(api))).rejects.toBeInstanceOf(MoyskladError);

    const cursor = await ctx.db.integrationCursor.findUniqueOrThrow({
      where: { provider: PROVIDER },
    });
    expect(cursor.initialLoadCompleted).toBe(false);
    expect(cursor.updatedCursor).toBeNull();
    expect(cursor.consecutiveFailures).toBe(1);
  });

  it('повторный запуск после ошибки не создаёт дубликатов ревизий и событий', async () => {
    const shared = row();
    const failing = fakeApi([[shared], [row()]], { failAtPage: 1, status: 500 });
    await expect(runSyncOnce(deps(failing))).rejects.toBeInstanceOf(MoyskladError);

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: shared['id'] as string },
    });
    const revisionsAfterFailure = await ctx.db.deliveryOrderRevision.count({
      where: { orderId: order.id },
    });

    // Второй проход: аренда снимается backoff-ом, поэтому сдвигаем часы вперёд.
    const retry = fakeApi([[shared]]);
    await runSyncOnce(deps(retry, new Date('2026-08-06T10:00:00.000Z')));

    expect(await ctx.db.deliveryOrderRevision.count({ where: { orderId: order.id } })).toBe(
      revisionsAfterFailure,
    );
    expect(
      await ctx.db.deliveryOrder.count({ where: { externalId: shared['id'] as string } }),
    ).toBe(1);
  });
});

describe('область заказа', () => {
  async function importOne(
    source: Record<string, unknown>,
    at = new Date('2026-08-06T09:00:00.000Z'),
  ) {
    await runSyncOnce(deps(fakeApi([[source]]), at));
    return ctx.db.deliveryOrder.findUnique({ where: { externalId: source['id'] as string } });
  }

  it('заказ нашей области импортируется', async () => {
    const order = await importOne(row());

    expect(order?.inScope).toBe(true);
    expect(order?.externalStateType).toBe('Regular');
  });

  it('никогда не относившийся заказ не оставляет в базе PII', async () => {
    const foreign = row({
      store: { meta: { href: href('store', '33333333-3333-4333-8333-333333333333') } },
      shipmentAddress: 'Секретный адрес чужого склада',
    });

    const order = await importOne(foreign);

    expect(order).toBeNull();
    expect(
      await ctx.db.deliveryOrder.count({ where: { address: 'Секретный адрес чужого склада' } }),
    ).toBe(0);
  });

  it('реальный идентификатор МоегоСклада принимается, статус Unsuccessful область не меняет', async () => {
    const cancelled = row({
      state: {
        meta: { href: href('state', '45533b00-2ea3-11ed-0a80-09c5000d6027') },
        id: '45533b00-2ea3-11ed-0a80-09c5000d6027',
        name: 'Отменен',
        stateType: 'Unsuccessful',
      },
    });

    const order = await importOne(cancelled);
    expect(order?.inScope).toBe(true);
    expect(order?.externalStateType).toBe('Unsuccessful');
  });
});

describe('расширенная загрузка производственной области', () => {
  /** База, где узкий логистический initial уже завершён, а широкий — ещё нет. */
  async function cursorAfterOldInitialLoad(updatedCursor: Date): Promise<void> {
    await ctx.db.integrationCursor.create({
      data: {
        provider: PROVIDER,
        initialLoadCompleted: true,
        initialLoadCompletedAt: new Date('2026-08-01T09:00:00.000Z'),
        fulfillmentLoadCompleted: false,
        updatedCursor,
      },
    });
  }

  /** Снимает аренду прохода, чтобы следующий проход начался в тех же часах. */
  async function allowNextPass(): Promise<void> {
    await ctx.db.integrationCursor.update({
      where: { provider: PROVIDER },
      data: { nextAttemptAt: null },
    });
  }

  it('на чистой базе один широкий проход закрывает оба признака', async () => {
    const delivery = row();
    const pickup = pickupRow();
    const api = fakeApi([[delivery, pickup]]);

    const first = await runSyncOnce(deps(api));
    expect(first.kind).toBe('initial');

    const cursor = await ctx.db.integrationCursor.findUniqueOrThrow({
      where: { provider: PROVIDER },
    });
    expect(cursor.initialLoadCompleted).toBe(true);
    expect(cursor.fulfillmentLoadCompleted).toBe(true);
    expect(cursor.updatedCursor).not.toBeNull();

    // Второй полной загрузки не бывает: следующий проход — обычная delta.
    await allowNextPass();
    const second = await runSyncOnce(deps(fakeApi([[]]), new Date('2026-08-06T09:05:00.000Z')));
    expect(second.kind).toBe('delta');
  });

  it('база со старым завершённым initial дочитывает самовывоз одним проходом', async () => {
    const previousCursor = new Date('2026-08-05T09:00:00.000Z');
    await cursorAfterOldInitialLoad(previousCursor);

    const pickup = pickupRow();
    const api = fakeApi([[pickup]]);
    const result = await runSyncOnce(deps(api));

    // Проход именно полный, а не delta: delta ходит по окну `updated`
    // и заказы, которых никогда не читала, сама не подберёт.
    expect(result.kind).toBe('initial');
    expect(api.calls[0]?.filter).toContain(`store=${MOYSKLAD_BASE_URL}/entity/store/${IDS.store}`);
    expect(api.calls[0]?.filter).not.toContain(IDS.deliveryMethodAttribute);

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: pickup['id'] as string },
    });
    expect(order.inScope).toBe(false);
    expect(order.fulfillmentInScope).toBe(true);
    expect(order.scopeExitReason).toBe('DELIVERY_METHOD_CHANGED');

    const cursor = await ctx.db.integrationCursor.findUniqueOrThrow({
      where: { provider: PROVIDER },
    });
    expect(cursor.fulfillmentLoadCompleted).toBe(true);
    // Курсор потока изменений НЕ сдвигается: перестановка его вперёд пропустила бы
    // всё, что менялось между прежним значением и этим проходом.
    expect(cursor.updatedCursor?.toISOString()).toBe(previousCursor.toISOString());
  });

  it('повтор расширенной загрузки идемпотентен: ни второго заказа, ни лишней ревизии', async () => {
    await cursorAfterOldInitialLoad(new Date('2026-08-05T09:00:00.000Z'));
    const pickup = pickupRow();

    await runSyncOnce(deps(fakeApi([[pickup]])));
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: pickup['id'] as string },
    });
    const revisions = await ctx.db.deliveryOrderRevision.count({ where: { orderId: order.id } });
    const audits = await ctx.db.auditLog.count({ where: { entityId: order.id } });

    // Признак уже закрыт, поэтому второй проход — delta по тем же данным.
    await allowNextPass();
    const second = await runSyncOnce(deps(fakeApi([[pickup]])));

    expect(second.kind).toBe('delta');
    expect(
      await ctx.db.deliveryOrder.count({ where: { externalId: pickup['id'] as string } }),
    ).toBe(1);
    expect(await ctx.db.deliveryOrderRevision.count({ where: { orderId: order.id } })).toBe(
      revisions,
    );
    expect(await ctx.db.auditLog.count({ where: { entityId: order.id } })).toBe(audits);
  });

  it('один заказ и одна страница обслуживают обе области', async () => {
    const delivery = row();
    const pickup = pickupRow();
    const api = fakeApi([[delivery, pickup]]);

    const result = await runSyncOnce(deps(api));

    // Одно обращение к списку на обе области: второго прохода, второго клиента
    // и повторного скачивания того же заказа не существует.
    expect(api.calls).toHaveLength(1);
    expect(result.processed).toBe(2);

    for (const source of [delivery, pickup]) {
      const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
        where: { externalId: source['id'] as string },
      });
      expect(await ctx.db.deliveryOrderRevision.count({ where: { orderId: order.id } })).toBe(1);
    }
  });

  it('смена доставки на самовывоз не теряет заказ и не делает его пропавшим', async () => {
    const source = row();
    await runSyncOnce(deps(fakeApi([[source]])));

    const before = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: source['id'] as string },
    });
    expect(before.inScope).toBe(true);

    await allowNextPass();
    const switched = pickupRow({
      id: source['id'],
      name: source['name'],
      updated: '2026-08-06 11:00:00.000',
      shipmentAddress: 'Москва, новый адрес',
    });
    await runSyncOnce(deps(fakeApi([[switched]]), new Date('2026-08-06T09:05:00.000Z')));

    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: source['id'] as string },
    });
    expect(after.inScope).toBe(false);
    expect(after.fulfillmentInScope).toBe(true);
    expect(after.sourceMissing).toBe(false);
    // Производственная область продолжает получать полное обновление полей.
    expect(after.address).toBe('Москва, новый адрес');
    expect(after.version).toBe(before.version + 1);
  });
});

describe('backoff и лимит', () => {
  it('шаги backoff: 30, 60, 120, 300 секунд с потолком', () => {
    expect(backoffForAttempt(0)).toBe(30_000);
    expect(backoffForAttempt(1)).toBe(60_000);
    expect(backoffForAttempt(2)).toBe(120_000);
    expect(backoffForAttempt(3)).toBe(300_000);
    expect(backoffForAttempt(10)).toBe(300_000);
  });

  it('429 использует X-Lognex-Retry-After, иначе консервативные 30 секунд', () => {
    expect(rateLimitDelay(new MoyskladError('RATE_LIMITED', 429, 7000))).toBe(7000);
    expect(rateLimitDelay(new MoyskladError('RATE_LIMITED', 429, null))).toBe(30_000);
    expect(rateLimitDelay(new MoyskladError('RATE_LIMITED', 429, 0))).toBe(30_000);
  });

  it('успешный проход сбрасывает счётчик неудач', async () => {
    const failing = fakeApi([[]], { failAtPage: 0, status: 500 });
    await expect(runSyncOnce(deps(failing))).rejects.toBeInstanceOf(MoyskladError);
    expect(
      (await ctx.db.integrationCursor.findUniqueOrThrow({ where: { provider: PROVIDER } }))
        .consecutiveFailures,
    ).toBe(1);

    await runSyncOnce(deps(fakeApi([[]]), new Date('2026-08-06T10:00:00.000Z')));
    expect(
      (await ctx.db.integrationCursor.findUniqueOrThrow({ where: { provider: PROVIDER } }))
        .consecutiveFailures,
    ).toBe(0);
  });
});

describe('взаимное исключение проходов', () => {
  it('второй проход не выполняется, пока действует аренда первого', async () => {
    await runSyncOnce(deps(fakeApi([[]])));

    // Аренда и запланированный интервал ещё действуют.
    const second = fakeApi([[row()]]);
    const result = await runSyncOnce(deps(second));

    expect(result.kind).toBe('skipped');
    expect(second.calls).toHaveLength(0);
  });
});

describe('состояние интеграции', () => {
  it('успешный проход даёт OK, ошибка — DEGRADED, отказ прав — ERROR', async () => {
    await runSyncOnce(deps(fakeApi([[]])));
    expect(
      (await ctx.db.integrationStatus.findUniqueOrThrow({ where: { provider: PROVIDER } })).state,
    ).toBe('OK');

    const failing = fakeApi([[]], { failAtPage: 0, status: 500 });
    await expect(
      runSyncOnce(deps(failing, new Date('2026-08-06T10:00:00.000Z'))),
    ).rejects.toThrow();
    expect(
      (await ctx.db.integrationStatus.findUniqueOrThrow({ where: { provider: PROVIDER } })).state,
    ).toBe('DEGRADED');

    const forbidden = fakeApi([[]], { failAtPage: 0, status: 403 });
    await expect(
      runSyncOnce(deps(forbidden, new Date('2026-08-06T11:00:00.000Z'))),
    ).rejects.toThrow();

    const status = await ctx.db.integrationStatus.findUniqueOrThrow({
      where: { provider: PROVIDER },
    });
    expect(status.state).toBe('ERROR');
    // В деталях только коды и числа: ни токена, ни адресов, ни тел ответов.
    const details = JSON.stringify(status.details);
    expect(details).not.toContain('test-token');
    expect(details).not.toContain('moysklad.ru');
    expect(details).not.toContain('Москва');
  });
});

describe('московское время на границе интеграции', () => {
  it('фильтр всегда московский, а не UTC', () => {
    expect(formatMoscow(new Date('2026-08-02T21:00:00.000Z'))).toBe('2026-08-03 00:00:00');
    expect(formatMoscow(new Date('2026-08-06T09:00:00.000Z'))).toBe('2026-08-06 12:00:00');
  });

  it('границы суток, месяца и года не съезжают', () => {
    // 20:59:59 UTC — ещё вчера по Москве; 21:00:00 UTC — уже следующий день.
    expect(formatMoscow(new Date('2026-08-06T20:59:59.000Z'))).toBe('2026-08-06 23:59:59');
    expect(formatMoscow(new Date('2026-08-06T21:00:00.000Z'))).toBe('2026-08-07 00:00:00');
    expect(formatMoscow(new Date('2026-02-28T21:00:00.000Z'))).toBe('2026-03-01 00:00:00');
    expect(formatMoscow(new Date('2025-12-31T21:00:00.000Z'))).toBe('2026-01-01 00:00:00');
  });

  it('время МоегоСклада разбирается как московское, а не по TZ процесса', () => {
    expect(parseMoscow('2026-08-06 12:00:00.000').toISOString()).toBe('2026-08-06T09:00:00.000Z');
    expect(parseMoscow('2026-01-01 00:00:00').toISOString()).toBe('2025-12-31T21:00:00.000Z');
    // Разбор и обратное форматирование дают исходную строку.
    expect(formatMoscow(parseMoscow('2026-08-06 12:00:00'))).toBe('2026-08-06 12:00:00');
  });

  it('несуществующее время отвергается, а не нормализуется молча', () => {
    // `Date.UTC` сам превратил бы 13-й месяц в январь следующего года,
    // 30 февраля — в март, а 24:00 — в полночь следующих суток.
    const invalid = [
      'вчера',
      '',
      '2026-13-01 10:00',
      '2026-02-30 10:00',
      '2025-02-29 10:00',
      '2026-08-06 24:00',
      '2026-08-06 10:60',
      '2026-08-06 10:00:60',
      '2026-00-10 10:00',
      '2026-08-00 10:00',
      '2026-08-32 10:00',
    ];

    for (const value of invalid) {
      let error: unknown = null;
      try {
        parseMoscow(value);
      } catch (thrown) {
        error = thrown;
      }
      expect(error, value).toBeInstanceOf(MoscowTimeParseError);
      // Значение приходит из внешнего ответа и в сообщение попасть не должно.
      if (value !== '') {
        expect((error as Error).message).not.toContain(value);
      }
    }
  });

  it('високосный день принимается', () => {
    expect(parseMoscow('2024-02-29 12:00:00').toISOString()).toBe('2024-02-29T09:00:00.000Z');
    expect(parseMoscow('2026-08-06 23:59:59').toISOString()).toBe('2026-08-06T20:59:59.000Z');
  });

  it('календарная дата Москвы считается от смещения, а не от UTC', () => {
    expect(moscowDate(new Date('2026-08-06T21:30:00.000Z'))).toBe('2026-08-07');
  });
});

describe('глобальная блокировка прохода', () => {
  it('второй проход получает skipped даже после истечения аренды', async () => {
    // Первый проход держит блокировку и «застревает» внутри поддельного API.
    let releaseFirst: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const slowApi: FakeApi = {
      calls: [],
      fetch: (async () => {
        slowApi.calls.push({ url: '', filter: '', limit: '', offset: '0', expand: '' });
        await gate;
        return new Response(JSON.stringify({ rows: [], meta: { size: 0 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof globalThis.fetch,
    };

    const first = runSyncOnce(deps(slowApi));
    // Даём первому проходу дойти до сетевого вызова.
    await new Promise((resolve) => setImmediate(resolve));

    // Часы второго прохода — далеко за пределами десятиминутной аренды.
    const second = fakeApi([[row()]]);
    const result = await runSyncOnce(deps(second, new Date('2026-08-06T23:00:00.000Z')));

    expect(result.kind).toBe('skipped');
    expect(second.calls).toHaveLength(0);

    releaseFirst?.();
    await first;
  });

  it('после успеха блокировка освобождена', async () => {
    await runSyncOnce(deps(fakeApi([[]])));
    expect(heldLocks.has(SYNC_LOCK_KEY.toString())).toBe(false);
  });

  it('после ошибки блокировка освобождена', async () => {
    const failing = fakeApi([[]], { failAtPage: 0, status: 500 });
    await expect(
      runSyncOnce(deps(failing, new Date('2026-08-06T12:00:00.000Z'))),
    ).rejects.toThrow();
    expect(heldLocks.has(SYNC_LOCK_KEY.toString())).toBe(false);
  });

  it('соединение закрывается и при занятой блокировке', async () => {
    const before = closedConnections;
    const lock = await acquireSyncLock(fakeLock());
    expect(lock).not.toBeNull();

    // Второй захватчик того же ключа обязан закрыть соединение, а не оставить его.
    expect(await acquireSyncLock(fakeLock())).toBeNull();
    expect(closedConnections).toBeGreaterThan(before);

    await lock?.release();
    expect(heldLocks.has(SYNC_LOCK_KEY.toString())).toBe(false);
  });
});

describe('backoff отсчитывается от завершения прохода', () => {
  it('долгий проход планирует следующую попытку от момента окончания', async () => {
    // Часы двигаются вперёд в момент сетевого вызова: проход длится два часа.
    let current = new Date('2026-08-06T09:00:00.000Z');
    const api = fakeApi([[]]);
    const slowApi: FakeApi = {
      calls: api.calls,
      fetch: (async (url: string) => {
        current = new Date('2026-08-06T11:00:00.000Z');
        return (api.fetch as unknown as (input: string) => Promise<Response>)(url);
      }) as unknown as typeof globalThis.fetch,
    };

    const slowClock: SyncDeps = { ...deps(slowApi), now: () => current };
    await runSyncOnce(slowClock, { intervalMs: 30_000 });

    const cursor = await ctx.db.integrationCursor.findUniqueOrThrow({
      where: { provider: PROVIDER },
    });
    // 11:00 завершение + 30 секунд, а не 09:00 + 30 секунд.
    expect(cursor.nextAttemptAt?.toISOString()).toBe('2026-08-06T11:00:30.000Z');
  });
});

describe('контрольная сверка', () => {
  /**
   * Локальный запас времени только этим сценариям.
   *
   * Сверка читает выборку целиком и трогает базу заметно больше соседей:
   * локально это около ста шестидесяти миллисекунд, но на загруженной машине
   * тот же сценарий однажды встал на пять секунд ровно — то есть упёрся
   * в стандартный предел. Общий предел Vitest при этом не меняется: остальные
   * сценарии обязаны оставаться быстрыми, и прятать их замедление незачем.
   */
  const SLOW_RECONCILIATION_MS = 15_000;
  /** Импорт заказа и подготовка курсора к сверке: аренда снята, сверки ещё не было. */
  async function importThenAllowReconciliation(source: Record<string, unknown>): Promise<void> {
    await runSyncOnce(deps(fakeApi([[source]])));
    await ctx.db.integrationCursor.update({
      where: { provider: PROVIDER },
      data: { nextAttemptAt: null, lastReconciliationAt: null },
    });
  }

  it(
    'заказ, отсутствующий в полностью прочитанной выборке, помечается пропавшим',
    async () => {
      const source = row();
      await importThenAllowReconciliation(source);

      const api = fakeApi([[]]);
      const result = await runSyncOnce(deps(api, new Date('2026-08-06T10:00:00.000Z')), {
        allowReconciliation: true,
      });

      expect(result.kind).toBe('reconciliation');
      // База критических тестов общая: точное число зависит от соседних сценариев,
      // поэтому проверяется факт пометки и состояние конкретного заказа.
      expect(result.missing).toBeGreaterThanOrEqual(1);

      const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
        where: { externalId: source['id'] as string },
      });
      expect(order.sourceMissing).toBe(true);
      expect(order.inScope).toBe(false);
      expect(order.scopeExitReason).toBe('SOURCE_MISSING');
    },
    SLOW_RECONCILIATION_MS,
  );

  it(
    'ошибка сверки никого не помечает и не двигает отметку сверки',
    async () => {
      const source = row();
      await importThenAllowReconciliation(source);

      const failing = fakeApi([[]], { failAtPage: 0, status: 500 });
      await expect(
        runSyncOnce(deps(failing, new Date('2026-08-06T10:00:00.000Z')), {
          allowReconciliation: true,
        }),
      ).rejects.toBeInstanceOf(MoyskladError);

      const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
        where: { externalId: source['id'] as string },
      });
      // Ни один заказ не объявлен пропавшим по неполной выборке.
      expect(order.sourceMissing).toBe(false);
      expect(order.inScope).toBe(true);

      const cursor = await ctx.db.integrationCursor.findUniqueOrThrow({
        where: { provider: PROVIDER },
      });
      expect(cursor.lastReconciliationAt).toBeNull();
    },
    SLOW_RECONCILIATION_MS,
  );

  it(
    'заказ восстанавливается даже при полностью идентичном снимке',
    async () => {
      const source = row();
      await importThenAllowReconciliation(source);

      // Сверка не нашла заказ — он помечен пропавшим.
      await runSyncOnce(deps(fakeApi([[]]), new Date('2026-08-06T10:00:00.000Z')), {
        allowReconciliation: true,
      });
      const missing = await ctx.db.deliveryOrder.findUniqueOrThrow({
        where: { externalId: source['id'] as string },
      });
      expect(missing.sourceMissing).toBe(true);

      await ctx.db.integrationCursor.update({
        where: { provider: PROVIDER },
        data: { nextAttemptAt: null, lastReconciliationAt: null },
      });

      // Тот же самый заказ, ни одно поле не изменилось.
      await runSyncOnce(deps(fakeApi([[source]]), new Date('2026-08-06T11:00:00.000Z')), {
        allowReconciliation: true,
      });

      const restored = await ctx.db.deliveryOrder.findUniqueOrThrow({
        where: { externalId: source['id'] as string },
      });
      expect(restored.sourceMissing).toBe(false);
      expect(restored.inScope).toBe(true);
      expect(restored.scopeExitReason).toBeNull();

      const reasons = (
        await ctx.db.deliveryOrderRevision.findMany({
          where: { orderId: restored.id },
          select: { reason: true },
        })
      ).map((revision) => revision.reason);
      expect(reasons).toContain('SOURCE_RESTORED');

      expect(
        await ctx.db.auditLog.count({
          where: { entityId: restored.id, action: 'ORDER_SOURCE_RESTORED' },
        }),
      ).toBe(1);
    },
    SLOW_RECONCILIATION_MS,
  );

  it(
    'самовывоз не объявляется пропавшим: сверка читает широкую выборку',
    async () => {
      const pickup = pickupRow();
      await importThenAllowReconciliation(pickup);

      const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
        where: { externalId: pickup['id'] as string },
      });
      expect(stored.inScope).toBe(false);
      expect(stored.fulfillmentInScope).toBe(true);

      // Выборка сверки содержит тот же самовывоз: серверный фильтр по способу
      // получения снят, поэтому объявлять заказ исчезнувшим не за что.
      const api = fakeApi([[pickup]]);
      const result = await runSyncOnce(deps(api, new Date('2026-08-06T10:00:00.000Z')), {
        allowReconciliation: true,
      });

      expect(result.kind).toBe('reconciliation');
      expect(api.calls[0]?.filter).not.toContain(IDS.deliveryMethodAttribute);

      const after = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: stored.id } });
      expect(after.sourceMissing).toBe(false);
      expect(after.fulfillmentInScope).toBe(true);
    },
    SLOW_RECONCILIATION_MS,
  );

  it(
    'реально исчезнувший самовывоз помечается пропавшим и возвращается штатным импортом',
    async () => {
      const pickup = pickupRow();
      await importThenAllowReconciliation(pickup);
      const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
        where: { externalId: pickup['id'] as string },
      });

      await runSyncOnce(deps(fakeApi([[]]), new Date('2026-08-06T10:00:00.000Z')), {
        allowReconciliation: true,
      });

      const missing = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: stored.id } });
      expect(missing.sourceMissing).toBe(true);
      // Отсутствие документа выводит заказ из ОБЕИХ областей: собирать нечего.
      expect(missing.inScope).toBe(false);
      expect(missing.fulfillmentInScope).toBe(false);
      expect(missing.scopeExitReason).toBe('SOURCE_MISSING');

      await ctx.db.integrationCursor.update({
        where: { provider: PROVIDER },
        data: { nextAttemptAt: null, lastReconciliationAt: null },
      });

      // Документ вернулся: тот же заказ, ни одно поле не изменилось.
      await runSyncOnce(deps(fakeApi([[pickup]]), new Date('2026-08-06T11:00:00.000Z')), {
        allowReconciliation: true,
      });

      const restored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: stored.id } });
      expect(restored.sourceMissing).toBe(false);
      expect(restored.fulfillmentInScope).toBe(true);
      // В логистическую область самовывоз не возвращается: способ получения прежний.
      expect(restored.inScope).toBe(false);
      expect(restored.scopeExitReason).toBe('DELIVERY_METHOD_CHANGED');
    },
    SLOW_RECONCILIATION_MS,
  );
});

describe('заказ вне области не накапливает PII', () => {
  it('обновления чужого заказа не попадают ни в ревизии, ни в аудит, ни в события', async () => {
    const source = row();
    await runSyncOnce(deps(fakeApi([[source]])));
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: source['id'] as string },
    });

    // Шаг 1: заказ уходит на чужой склад. Выход из области фиксируется.
    const foreignStore = { meta: { href: href('store', '33333333-3333-4333-8333-333333333333') } };
    await runSyncOnce(
      deps(
        fakeApi([[{ ...source, updated: '2026-08-06 10:15:00.000', store: foreignStore }]]),
        new Date('2026-08-06T10:20:00.000Z'),
      ),
    );
    const exited = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(exited.inScope).toBe(false);
    const revisionsAfterExit = await ctx.db.deliveryOrderRevision.count({
      where: { orderId: order.id },
    });

    // Шаг 2: чужой заказ продолжает меняться. Контрольная строка не должна
    // оказаться нигде в наших данных.
    const SECRET = 'Контрольная-строка-чужого-склада-7731';
    await runSyncOnce(
      deps(
        fakeApi([
          [
            {
              ...source,
              updated: '2026-08-06 10:40:00.000',
              store: foreignStore,
              shipmentAddress: SECRET,
              attributes: [
                { id: IDS.intervalAttribute, value: 'с 10:00 по 12:00' },
                { id: IDS.recipientAttribute, value: SECRET },
              ],
            },
          ],
        ]),
        new Date('2026-08-06T10:45:00.000Z'),
      ),
    );

    // Новых ревизий у заказа вне области не появилось.
    expect(await ctx.db.deliveryOrderRevision.count({ where: { orderId: order.id } })).toBe(
      revisionsAfterExit,
    );

    // Денежные поля хранятся в BigInt, поэтому сериализация с заменителем.
    const serialize = (value: unknown): string =>
      JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));

    const revisions = await ctx.db.deliveryOrderRevision.findMany({ where: { orderId: order.id } });
    expect(serialize(revisions)).not.toContain(SECRET);

    const audit = await ctx.db.auditLog.findMany({ where: { entityId: order.id } });
    expect(serialize(audit)).not.toContain(SECRET);

    const events = await ctx.db.realtimeEvent.findMany({
      where: { topic: { startsWith: 'order' } },
    });
    expect(serialize(events)).not.toContain(SECRET);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.address).not.toBe(SECRET);
    expect(stored.recipient).not.toBe(SECRET);
  });
});

describe('последняя ревизия определяется устойчиво', () => {
  it('при одинаковом receivedAt берётся ревизия с большим идентификатором', async () => {
    const source = row();
    await runSyncOnce(deps(fakeApi([[source]])));
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: source['id'] as string },
    });

    const first = await ctx.db.deliveryOrderRevision.findFirstOrThrow({
      where: { orderId: order.id },
    });

    // Вторая ревизия с ТЕМ ЖЕ receivedAt: при пакетной обработке одинаковые
    // миллисекунды реальны. Отличается только адрес.
    // Круговой JSON: снимок хранится как jsonb, работать с ним как с объектом
    // проще, чем сужать тип Prisma.
    const snapshot = JSON.parse(JSON.stringify(first.snapshot));
    await ctx.db.deliveryOrderRevision.create({
      data: {
        orderId: order.id,
        receivedAt: first.receivedAt,
        externalUpdated: first.externalUpdated,
        snapshot: { ...snapshot, address: 'Промежуточный адрес' },
        snapshotHash: 'f'.repeat(64),
        changedFields: ['address'],
        reason: 'EXTERNAL_UPDATE',
      },
    });

    // Приходит исходный заказ. Относительно НОВЕЙШЕЙ ревизии адрес изменился,
    // относительно первой — нет. Правильный порядок обязан заметить изменение.
    await runSyncOnce(
      deps(
        fakeApi([[{ ...source, updated: '2026-08-06 10:30:00.000' }]]),
        new Date('2026-08-06T10:35:00.000Z'),
      ),
    );

    const latest = await ctx.db.deliveryOrderRevision.findFirstOrThrow({
      where: { orderId: order.id },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    });
    expect(latest.changedFields).toContain('address');
    expect(JSON.parse(JSON.stringify(latest.snapshot)).address).toBe(source['shipmentAddress']);
  });
});

describe('ручной проход moysklad:sync-once', () => {
  const productionConfig = (overrides: Record<string, string> = {}): AppConfig =>
    testConfig({
      APP_ENV: 'production',
      APP_ENVIRONMENT_MARKER: 'production',
      MOYSKLAD_TOKEN: 'test-token',
      ...overrides,
    });

  it('вне production команда отказывает до создания любых ресурсов', () => {
    expect(checkSyncOnceEnvironment(testConfig())?.code).toBe(2);
    // Совпадать обязаны ОБА признака: одного маркера мало.
    expect(
      checkSyncOnceEnvironment(testConfig({ APP_ENVIRONMENT_MARKER: 'production' }))?.code,
    ).toBe(2);
  });

  it('без токена команда отказывает', () => {
    const withoutToken = testConfig({
      APP_ENV: 'production',
      APP_ENVIRONMENT_MARKER: 'production',
    });
    expect(withoutToken.MOYSKLAD_TOKEN).toBeUndefined();
    expect(checkSyncOnceEnvironment(withoutToken)?.code).toBe(2);
  });

  it('выключенная автоматическая синхронизация ручному проходу не мешает', async () => {
    const config = productionConfig();
    expect(config.MOYSKLAD_SYNC_ENABLED).toBe(false);

    const report = await performSyncOnce(config, deps(fakeApi([[]])));
    expect(report.code).toBe(0);
    expect(report.result?.kind).toBe('initial');
  });

  it('занятая блокировка даёт отдельный код возврата, а не ошибку', async () => {
    const busy = await acquireSyncLock(fakeLock());
    try {
      const api = fakeApi([[row()]]);
      const report = await performSyncOnce(productionConfig(), deps(api));

      expect(report.code).toBe(3);
      expect(api.calls).toHaveLength(0);
    } finally {
      await busy?.release();
    }
  });

  it('ошибка прохода даёт код 1 без текста внешней ошибки', async () => {
    const failing = fakeApi([[]], { failAtPage: 0, status: 500 });
    const report = await performSyncOnce(productionConfig(), deps(failing));

    expect(report.code).toBe(1);
    expect(report.result).toBeNull();
    expect(report.reason).not.toContain('moysklad.ru');
    expect(report.reason).not.toContain('test-token');
  });
});

describe('блокировка на настоящей PostgreSQL', () => {
  /**
   * Технический предохранитель: без него зависший проход держал бы тест
   * до общего таймаута прогона. Реальных пауз здесь нет — таймер срабатывает
   * только при дефекте.
   */
  async function withTimeout<T>(promise: Promise<T>, hint: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`проход завис: ${hint}`)), 15_000);
    });
    try {
      return await Promise.race([promise, guard]);
    } finally {
      clearTimeout(timer);
    }
  }

  it('проход с настоящей блокировкой доходит до API, а параллельный получает skipped', async () => {
    // Настоящее соединение PostgreSQL и настоящий pg_try_advisory_lock.
    // Ключ тот же, что раньше брался транзакционно внутри прохода: старая
    // реализация ждала бы его на соединении Prisma и не дошла бы до API.
    const lockDeps = realLock();

    let openGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let markReached: (() => void) | null = null;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });

    const slowApi: FakeApi = {
      calls: [],
      fetch: (async () => {
        slowApi.calls.push({ url: '', filter: '', limit: '', offset: '0', expand: '' });
        markReached?.();
        await gate;
        return new Response(JSON.stringify({ rows: [], meta: { size: 0 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof globalThis.fetch,
    };

    const first = runSyncOnce({ ...deps(slowApi), lock: lockDeps });
    // Самоблокировки нет: проход дошёл до поддельного API, удерживая замок.
    await withTimeout(reached, 'первый проход не дошёл до API');

    const second = fakeApi([[row()]]);
    const skipped = await withTimeout(
      runSyncOnce({ ...deps(second, new Date('2026-08-06T23:00:00.000Z')), lock: lockDeps }),
      'параллельный проход не завершился',
    );

    expect(skipped.kind).toBe('skipped');
    expect(second.calls).toHaveLength(0);

    openGate?.();
    const result = await withTimeout(first, 'первый проход не завершился');
    expect(result.kind).toBe('initial');
    expect(slowApi.calls).toHaveLength(1);

    // Замок снят: следующий захватчик получает его сразу.
    const after = await withTimeout(acquireTracked(lockDeps), 'замок не освобождён');
    expect(after).not.toBeNull();
    await releaseTracked(after);
  });

  it('отказ прохода не оставляет замок: следующий получает его сразу', async () => {
    const lockDeps = realLock();

    // Проход обрывается ПОСЛЕ захвата замка: именно этот случай раньше
    // заражал соседние сценарии.
    const failing: FakeApi = {
      calls: [],
      fetch: (async () => {
        failing.calls.push({ url: '', filter: '', limit: '', offset: '0', expand: '' });
        throw new Error('обрыв связи с источником');
      }) as unknown as typeof globalThis.fetch,
    };

    // Проход не «возвращает отказ», а бросает: ошибка источника поднимается
    // наружу, и освобождение замка держится только на продуктовом `finally`.
    await expect(
      withTimeout(
        runSyncOnce({ ...deps(failing), lock: lockDeps }),
        'проход с отказом не завершился',
      ),
    ).rejects.toThrow();
    expect(failing.calls.length).toBeGreaterThan(0);

    // Следующий проход НЕ получает «уже выполняется»: он берёт замок сразу
    // и доходит до источника.
    const next = fakeApi([[row()]]);
    const after = await withTimeout(
      runSyncOnce({ ...deps(next, new Date('2026-08-06T23:30:00.000Z')), lock: lockDeps }),
      'следующий проход не завершился',
    );

    expect(after.kind).not.toBe('skipped');
    expect(next.calls.length).toBeGreaterThan(0);
  });
});

describe('прерванный сценарий не заражает следующие', () => {
  // Два сценария подряд: первый намеренно бросает замок, второй обязан
  // работать как ни в чём не бывало. Ровно эта пара воспроизводит каскад,
  // из-за которого один отказ давал семь.
  it('сценарий обрывается, не освободив ни поддельный, ни настоящий замок', async () => {
    const fake = await acquireSyncLock(fakeLock());
    expect(fake).not.toBeNull();

    // Ссылка НЕ сохраняется: так выглядит прерванный сценарий — дотянуться
    // до соединения объектом уже невозможно.
    const real = await acquireSyncLock(realLock());
    expect(real).not.toBeNull();

    expect(heldLocks.has(SYNC_LOCK_KEY.toString())).toBe(true);
  });

  it('уборка отказывается работать вне одноразовой базы', () => {
    // Fail closed по ИМЕНИ базы, а не по маркерам окружения: маркеры проверяет
    // соседний модуль, и полагаться на это — доверие вместо доказательства.
    for (const name of ['fl_production', 'fl_staging', 'fl_dev', 'postgres']) {
      expect(
        () => assertDisposableDatabase(`postgresql://u:p@db:5432/${name}?schema=public`),
        name,
      ).toThrow(/одноразовой базе/);
    }

    for (const name of ALLOWED_TEST_DATABASES) {
      expect(
        () => assertDisposableDatabase(`postgresql://u:p@db:5432/${name}?schema=public`),
        name,
      ).not.toThrow();
    }
  });

  it('посторонняя сессия PostgreSQL уборкой не затрагивается', async () => {
    // Соединение открыто НАПРЯМУЮ, минуя connectTestLock: для уборки оно чужое.
    const foreign = new Client({
      connectionString: ctx.config.DATABASE_URL,
      application_name: 'посторонняя сессия проверки',
    });
    foreign.on('error', () => undefined);
    await foreign.connect();

    try {
      const identity = await foreign.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = identity.rows[0]?.pid ?? 0;
      expect(pid).toBeGreaterThan(0);

      // Держит СВОЙ ключ — соседний замок геокодирования. Наш ключ трогать
      // нельзя: это была бы настоящая утечка, и страховка обязана её заметить.
      await foreign.query('SELECT pg_advisory_lock($1::bigint)', [FOREIGN_LOCK_KEY.toString()]);

      // Та же уборка, что работает после каждого сценария.
      await releaseSyncLockSessions();

      // Сессия жива и отвечает.
      const alive = await foreign.query<{ ok: number }>('SELECT 1 AS ok');
      expect(alive.rows[0]?.ok).toBe(1);

      // И по-прежнему держит свой замок: уборка не сняла чужую блокировку.
      const held = await ctx.db.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM pg_locks
        WHERE locktype = 'advisory' AND objid = ${Number(FOREIGN_LOCK_KEY)} AND pid = ${pid}
      `;
      expect(Number(held[0]?.count ?? 0)).toBe(1);
    } finally {
      await foreign.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      await foreign.end().catch(() => undefined);
    }
  });

  it('следующий сценарий берёт оба замка сразу и доходит до источника', async () => {
    // Поддельный замок свободен: состояние теста приведено в порядок.
    expect(heldLocks.has(SYNC_LOCK_KEY.toString())).toBe(false);

    const api = fakeApi([[row()]]);
    const result = await runSyncOnce({ ...deps(api), lock: fakeLock() });
    expect(result.kind).not.toBe('skipped');
    expect(api.calls.length).toBeGreaterThan(0);

    // Настоящий замок тоже свободен: сессия прерванного сценария закрыта.
    const real = await acquireTracked(realLock());
    expect(real, 'настоящий замок остался занят прерванным сценарием').not.toBeNull();
    await releaseTracked(real);
  });
});
