/**
 * Критические проверки read-only клиента.
 *
 * Проверяются ровно те свойства, нарушение которых опасно: отсутствие
 * параллельных обращений и превышения темпа, поведение при 429 без скрытого
 * повтора и отсутствие токена и персональных данных в ошибках.
 *
 * Часы и ожидание инъецируются: реальных пауз в тестах нет.
 */

import { describe, expect, it } from 'vitest';
import { MoyskladClient, MoyskladError } from './client.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from './config.js';

const TOKEN = 'test-token-value-should-never-leak';

/** Управляемые часы: тест двигает время сам, вместо того чтобы ждать. */
function controlledClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function client(
  fetchImpl: typeof globalThis.fetch,
  clock = controlledClock(),
  token: string | null = TOKEN,
) {
  return {
    instance: new MoyskladClient({
      config: { baseUrl: MOYSKLAD_BASE_URL, token, ids: MOYSKLAD_IDS },
      fetch: fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      minIntervalMs: 1000,
    }),
    clock,
  };
}

describe('темп обращений', () => {
  it('не допускает параллельных обращений и держит не чаще одного запроса в секунду', async () => {
    let active = 0;
    let maxActive = 0;
    const startedAt: number[] = [];
    const clock = controlledClock();

    const fetchImpl = (async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      startedAt.push(clock.now());
      // Работа запроса занимает время: без очереди обращения наложились бы.
      clock.advance(10);
      active -= 1;
      return jsonResponse({ rows: [], meta: { size: 0 } });
    }) as unknown as typeof globalThis.fetch;

    const { instance } = client(fetchImpl, clock);

    await Promise.all([
      instance.listCustomerOrders({ limit: 1 }),
      instance.listCustomerOrders({ limit: 1 }),
      instance.listCustomerOrders({ limit: 1 }),
    ]);

    expect(maxActive).toBe(1);
    expect(startedAt).toHaveLength(3);
    for (let i = 1; i < startedAt.length; i += 1) {
      expect(startedAt[i] - startedAt[i - 1]).toBeGreaterThanOrEqual(1000);
    }
    // Ожидание было инъецированным, а не настоящим.
    expect(clock.sleeps.every((ms) => ms > 0)).toBe(true);
  });
});

describe('лимит и ошибки', () => {
  it('429 разбирается и не вызывает немедленного повтора', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('{}', {
        status: 429,
        headers: { 'x-lognex-retry-after': '3000', 'x-ratelimit-remaining': '0' },
      });
    }) as unknown as typeof globalThis.fetch;

    const { instance } = client(fetchImpl);

    await expect(instance.listCustomerOrders({ limit: 1 })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfterMs: 3000,
    });
    expect(calls).toBe(1);
  });

  it('остаток лимита читается из заголовков', async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { rows: [], meta: { size: 0 } },
        {
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-remaining': '43',
            'x-ratelimit-limit': '45',
          },
        },
      )) as unknown as typeof globalThis.fetch;

    const { instance } = client(fetchImpl);
    const page = await instance.listCustomerOrders({ limit: 1 });

    expect(page.rateLimit).toEqual({ remaining: 43, limit: 45 });
  });

  it('без токена клиент отказывает и в сеть не идёт', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ rows: [] });
    }) as unknown as typeof globalThis.fetch;

    const { instance } = client(fetchImpl, controlledClock(), null);

    await expect(instance.listCustomerOrders({ limit: 1 })).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(calls).toBe(0);
  });
});

describe('безопасность ошибок', () => {
  it('ошибка не содержит токен, заголовок авторизации, адрес запроса и PII', async () => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      // Сообщение внешней ошибки намеренно «токсичное»: в него подмешаны
      // и адрес с фильтром, и заголовок авторизации.
      throw new Error(`connect failed ${String(url)} ${JSON.stringify(init.headers)}`);
    }) as unknown as typeof globalThis.fetch;

    const { instance } = client(fetchImpl);

    const error = await instance
      .listCustomerOrders({ limit: 1, filter: 'shipmentAddress~Москва, Тестовая улица' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MoyskladError);
    const serialized = `${(error as MoyskladError).message} ${(error as MoyskladError).stack ?? ''}`;

    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Тестовая улица');
    expect(serialized).not.toContain('shipmentAddress');
    expect((error as MoyskladError).code).toBe('TRANSPORT_ERROR');
  });

  it('HTTP-статусы отображаются в безопасные коды без тела ответа', async () => {
    const cases: [number, string][] = [
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [500, 'SERVER_ERROR'],
    ];

    for (const [status, code] of cases) {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ errors: [{ error: 'Получатель Иванов, +79990000000' }] }), {
          status,
        })) as unknown as typeof globalThis.fetch;

      const { instance } = client(fetchImpl);
      const error = (await instance
        .listCustomerOrders({ limit: 1 })
        .catch((e: unknown) => e)) as MoyskladError;

      expect(error.code, String(status)).toBe(code);
      expect(error.message).not.toContain('Иванов');
      expect(error.message).not.toContain('+79990000000');
    }
  });
});

describe('загрузка заказов', () => {
  /** Минимально валидный заказ для схемы. */
  const validRow = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'A-1',
    updated: '2026-08-06 10:00:00.000',
    sum: 499000,
    payedSum: 0,
    state: {
      meta: {
        href: 'https://api.moysklad.ru/api/remap/1.2/entity/state/22222222-2222-4222-8222-222222222222',
      },
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Новый',
      stateType: 'Regular',
    },
  };

  it('запрос всегда разворачивает статус', async () => {
    let requestedUrl = '';
    const fetchImpl = (async (url: string) => {
      requestedUrl = String(url);
      return jsonResponse({ rows: [], meta: { size: 0 } });
    }) as unknown as typeof globalThis.fetch;

    const { instance } = client(fetchImpl);
    await instance.listCustomerOrders({ limit: 100 });

    const params = new URL(requestedUrl).searchParams;
    expect(params.get('expand')).toBe('state');
    expect(params.get('limit')).toBe('100');
  });

  it('строки проверяются схемой и возвращаются типизированными', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ rows: [validRow], meta: { size: 1 } })) as unknown as typeof globalThis.fetch;

    const { instance } = client(fetchImpl);
    const page = await instance.listCustomerOrders({ limit: 1 });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.state?.stateType).toBe('Regular');
    expect(page.size).toBe(1);
  });

  it('невалидная строка даёт BAD_RESPONSE без сырого ответа и PII', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        rows: [{ ...validRow, sum: 'не число', shipmentAddress: 'Москва, Тестовая улица, 1' }],
        meta: { size: 1 },
      })) as unknown as typeof globalThis.fetch;

    const { instance } = client(fetchImpl);
    const error = (await instance
      .listCustomerOrders({ limit: 1 })
      .catch((e: unknown) => e)) as MoyskladError;

    expect(error.code).toBe('BAD_RESPONSE');
    const serialized = `${error.message} ${error.stack ?? ''}`;
    expect(serialized).not.toContain('Тестовая улица');
    expect(serialized).not.toContain('не число');
    expect(serialized).not.toContain('A-1');
  });
});
