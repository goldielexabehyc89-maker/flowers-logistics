/**
 * Критические проверки синхронизации заказов.
 *
 * К настоящему API обращений нет: используется поддельный `fetch` и управляемые
 * часы. Реальных пауз в тестах не бывает — ожидание инъецируется.
 */

import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from '../../auth/testing/harness.js';
import { MoyskladClient, MoyskladError } from './client.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from './config.js';
import { deltaFilter, initialLoadFilter } from './filters.js';
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
});

afterAll(async () => {
  await closeTestContext(ctx);
});

beforeEach(async () => {
  // Курсор общий на провайдера: между сценариями его состояние сбрасывается.
  await ctx.db.integrationCursor.deleteMany({ where: { provider: PROVIDER } });
});

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

function deps(api: FakeApi, now = new Date('2026-08-06T09:00:00.000Z')): SyncDeps {
  return {
    db: ctx.db,
    client: new MoyskladClient({
      config: { baseUrl: MOYSKLAD_BASE_URL, token: 'test-token', ids: IDS },
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
  };
}

describe('нижняя граница первоначальной загрузки', () => {
  it('считается как начало дня Москвы минус три дня', () => {
    // 06.08.2026 09:00 UTC = 12:00 Москвы. Начало дня Москвы минус 3 дня — 03.08 00:00 МСК.
    expect(initialLoadSince(new Date('2026-08-06T09:00:00.000Z')).toISOString()).toBe(
      '2026-08-02T21:00:00.000Z',
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
  it('начальный фильтр содержит склад, способ доставки и нижнюю дату', () => {
    const filter = initialLoadFilter(IDS, new Date('2026-08-02T21:00:00.000Z'));

    expect(filter).toContain(`store=${MOYSKLAD_BASE_URL}/entity/store/${IDS.store}`);
    expect(filter).toContain(
      `${MOYSKLAD_BASE_URL}/entity/customerorder/metadata/attributes/${IDS.deliveryMethodAttribute}=` +
        `${MOYSKLAD_BASE_URL}/entity/customentity/${IDS.deliveryMethodDictionary}/${IDS.deliveryMethodDelivery}`,
    );
    expect(filter).toContain('deliveryPlannedMoment>=2026-08-02 21:00:00');
    expect(filter).not.toContain('state');
    expect(filter).not.toContain('updated<=');
  });

  it('delta-фильтр содержит только окно updated', () => {
    const filter = deltaFilter(
      new Date('2026-08-06T08:55:00.000Z'),
      new Date('2026-08-06T09:00:00.000Z'),
    );

    expect(filter).toBe('updated>=2026-08-06 08:55:00;updated<=2026-08-06 09:00:00');
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
