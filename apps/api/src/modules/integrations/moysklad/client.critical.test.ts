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
import { isReadOnlyMethod, MoyskladClient, MoyskladError } from './client.js';
import { loadMoyskladConfig, MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from './config.js';
import { loadConfig } from '../../../platform/config.js';
import { TEST_SECRETS } from '../../../platform/testing/secrets.js';

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
  writesAllowed = false,
) {
  return {
    instance: new MoyskladClient({
      config: { baseUrl: MOYSKLAD_BASE_URL, token, ids: MOYSKLAD_IDS, writesAllowed },
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
      instance.listCustomerOrders({ limit: 1, withPositions: false }),
      instance.listCustomerOrders({ limit: 1, withPositions: false }),
      instance.listCustomerOrders({ limit: 1, withPositions: false }),
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

describe('режим только чтения: HTTP-метод проверяется до сети', () => {
  const FORBIDDEN = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'get', 'post', ''];

  /** Считающий fetch: любой вызов был бы уже нарушением. */
  function countingFetch(): { calls: number; impl: typeof globalThis.fetch } {
    const state = { calls: 0, impl: null as unknown as typeof globalThis.fetch };
    state.impl = (async (_url: string, init?: RequestInit) => {
      state.calls += 1;
      return jsonResponse({ rows: [], meta: { size: 0 }, method: init?.method });
    }) as unknown as typeof globalThis.fetch;
    return state as { calls: number; impl: typeof globalThis.fetch };
  }

  it('каждый запрещённый метод отвергается с нулём сетевых вызовов', async () => {
    const fetchState = countingFetch();
    const { instance } = client(fetchState.impl);

    for (const method of FORBIDDEN) {
      await expect(instance.send(method, '/entity/customerorder')).rejects.toMatchObject({
        code: 'METHOD_NOT_ALLOWED',
      });
    }

    // Ни одного обращения: проверка выполнена ДО fetch, а не по ответу сервера.
    expect(fetchState.calls).toBe(0);
  });

  it('запрещённый метод не занимает очередь и не расходует темп', async () => {
    const clock = controlledClock();
    const fetchState = countingFetch();
    const { instance } = client(fetchState.impl, clock);

    await expect(instance.send('POST', '/entity/customerorder')).rejects.toBeInstanceOf(
      MoyskladError,
    );

    // Разрешённое обращение сразу после отказа идёт первым и без паузы.
    await instance.send('GET', '/entity/customerorder');
    expect(fetchState.calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('GET и HEAD проходят и доходят до fetch именно с этим методом', async () => {
    const seen: (string | undefined)[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.method);
      return jsonResponse({ rows: [], meta: { size: 0 } });
    }) as unknown as typeof globalThis.fetch;
    const { instance } = client(fetchImpl);

    await instance.send('GET', '/entity/customerorder');
    await instance.send('HEAD', '/entity/customerorder');

    expect(seen).toEqual(['GET', 'HEAD']);
  });

  it('чтение заказов проходит через ту же границу и остаётся GET', async () => {
    const seen: (string | undefined)[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.method);
      return jsonResponse({ rows: [], meta: { size: 0 } });
    }) as unknown as typeof globalThis.fetch;
    const { instance } = client(fetchImpl);

    await instance.listCustomerOrders({ limit: 1, withPositions: false });
    expect(seen).toEqual(['GET']);
  });

  it('универсальная запись невозможна ни в одном окружении, включая режим записи', async () => {
    /*
     * Правило не изменилось и не смягчилось: произвольного глагола у клиента
     * нет НИ ПРИ КАКОЙ конфигурации. Разрешение записи открывает ровно одну
     * названную операцию — отмену заказа, — а `send` остаётся read-only.
     */
    const environments = [
      { APP_ENV: 'production', APP_ENVIRONMENT_MARKER: 'production' },
      { APP_ENV: 'production', APP_ENVIRONMENT_MARKER: 'production', MOYSKLAD_READ_ONLY: 'true' },
      { APP_ENV: 'production', APP_ENVIRONMENT_MARKER: 'production', MOYSKLAD_READ_ONLY: 'false' },
      { APP_ENV: 'staging', APP_ENVIRONMENT_MARKER: 'staging', MOYSKLAD_READ_ONLY: 'true' },
    ];

    for (const env of environments) {
      const config = loadMoyskladConfig({ ...env, MOYSKLAD_TOKEN: TOKEN } as NodeJS.ProcessEnv);
      const fetchState = countingFetch();
      const instance = new MoyskladClient({ config, fetch: fetchState.impl, minIntervalMs: 0 });

      for (const method of FORBIDDEN) {
        await expect(
          instance.send(method, '/entity/customerorder'),
          `${env.APP_ENV}/${method}`,
        ).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
      }

      expect(fetchState.calls, env.APP_ENV).toBe(0);
    }
  });

  it('режим только чтения запрещает и названную операцию отмены', async () => {
    // Молчание конфигурации — тоже запрет: отсутствующее значение
    // `MOYSKLAD_READ_ONLY` не открывает запись.
    const environments = [
      { APP_ENV: 'production', APP_ENVIRONMENT_MARKER: 'production' },
      { APP_ENV: 'staging', APP_ENVIRONMENT_MARKER: 'staging', MOYSKLAD_READ_ONLY: 'true' },
    ];

    for (const env of environments) {
      const config = loadMoyskladConfig({ ...env, MOYSKLAD_TOKEN: TOKEN } as NodeJS.ProcessEnv);
      const fetchState = countingFetch();
      const instance = new MoyskladClient({ config, fetch: fetchState.impl, minIntervalMs: 0 });

      await expect(
        instance.cancelCustomerOrder({
          orderId: '11111111-2222-3333-4444-555555555555',
          stateId: '45533b00-2ea3-11ed-0a80-09c5000d6027',
        }),
        env.APP_ENV,
      ).rejects.toMatchObject({ code: 'WRITE_FORBIDDEN' });

      expect(fetchState.calls, env.APP_ENV).toBe(0);
    }
  });

  it('снять режим чтения можно только там, где это осмысленно', () => {
    const base = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      ...TEST_SECRETS,
    } as NodeJS.ProcessEnv;

    /*
     * Staging смотрит в РАБОЧИЙ аккаунт. Разрешённая там запись меняла бы
     * настоящие заказы живого магазина, поэтому запуск останавливается.
     */
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'staging',
        APP_ENVIRONMENT_MARKER: 'staging',
        MOYSKLAD_READ_ONLY: 'false',
      } as NodeJS.ProcessEnv),
    ).toThrow(/MOYSKLAD_READ_ONLY=false допустим только/);

    // Production — ради него операция и вводилась; local — поддельный HTTP.
    expect(
      loadConfig({
        ...base,
        APP_ENV: 'production',
        APP_ENVIRONMENT_MARKER: 'production',
        MOYSKLAD_READ_ONLY: 'false',
      } as NodeJS.ProcessEnv).MOYSKLAD_READ_ONLY,
    ).toBe('false');
    expect(
      loadConfig({
        ...base,
        APP_ENV: 'local',
        APP_ENVIRONMENT_MARKER: 'local',
        MOYSKLAD_READ_ONLY: 'false',
      } as NodeJS.ProcessEnv).MOYSKLAD_READ_ONLY,
    ).toBe('false');
  });

  it('политику нельзя дополнить во время исполнения', () => {
    // Список методов не экспортируется изменяемой структурой: политика —
    // это функция с точным сравнением, и дописать в неё «POST» неоткуда.
    expect(isReadOnlyMethod('GET')).toBe(true);
    expect(isReadOnlyMethod('HEAD')).toBe(true);
    for (const method of FORBIDDEN) {
      expect(isReadOnlyMethod(method), method).toBe(false);
    }
  });

  it('отказ по методу не раскрывает токен и адрес', async () => {
    const fetchState = countingFetch();
    const { instance } = client(fetchState.impl);

    const error = await instance
      .send('DELETE', '/entity/customerorder/secret-id')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MoyskladError);
    const message = (error as MoyskladError).message;
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain('secret-id');
    expect(message).not.toContain('moysklad.ru');
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

    await expect(
      instance.listCustomerOrders({ limit: 1, withPositions: false }),
    ).rejects.toMatchObject({
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
    const page = await instance.listCustomerOrders({ limit: 1, withPositions: false });

    expect(page.rateLimit).toEqual({ remaining: 43, limit: 45 });
  });

  it('без токена клиент отказывает и в сеть не идёт', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ rows: [] });
    }) as unknown as typeof globalThis.fetch;

    const { instance } = client(fetchImpl, controlledClock(), null);

    await expect(
      instance.listCustomerOrders({ limit: 1, withPositions: false }),
    ).rejects.toMatchObject({
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
      .listCustomerOrders({
        limit: 1,
        filter: 'shipmentAddress~Москва, Тестовая улица',
        withPositions: false,
      })
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
        .listCustomerOrders({ limit: 1, withPositions: false })
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
    await instance.listCustomerOrders({ limit: 100, withPositions: false });

    const params = new URL(requestedUrl).searchParams;
    expect(params.get('expand')).toBe('state');
    expect(params.get('limit')).toBe('100');
  });

  it('строки проверяются схемой и возвращаются типизированными', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ rows: [validRow], meta: { size: 1 } })) as unknown as typeof globalThis.fetch;

    const { instance } = client(fetchImpl);
    const page = await instance.listCustomerOrders({ limit: 1, withPositions: false });

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
      .listCustomerOrders({ limit: 1, withPositions: false })
      .catch((e: unknown) => e)) as MoyskladError;

    expect(error.code).toBe('BAD_RESPONSE');
    const serialized = `${error.message} ${error.stack ?? ''}`;
    expect(serialized).not.toContain('Тестовая улица');
    expect(serialized).not.toContain('не число');
    expect(serialized).not.toContain('A-1');
  });
});

// --- Единственная операция записи ---------------------------------------------

describe('отмена заказа: единственная операция записи', () => {
  /** Согласованный владельцем статус «Отменен». Угадывать его нельзя. */
  const STATE = '45533b00-2ea3-11ed-0a80-09c5000d6027';
  const ORDER = '11111111-2222-3333-4444-555555555555';

  interface Call {
    url: string;
    method: string | undefined;
    body: string | undefined;
    headers: Record<string, string>;
  }

  function recordingFetch(respond: (call: Call, index: number) => Response): {
    calls: Call[];
    impl: typeof globalThis.fetch;
  } {
    const calls: Call[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      const call: Call = {
        url,
        method: init?.method,
        body: typeof init?.body === 'string' ? init.body : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      calls.push(call);
      return respond(call, calls.length - 1);
    }) as unknown as typeof globalThis.fetch;
    return { calls, impl };
  }

  it('при режиме только чтения отказывает с нулём сетевых вызовов', async () => {
    const fetchState = recordingFetch(() => jsonResponse({}));
    const { instance } = client(fetchState.impl, controlledClock(), TOKEN, false);

    await expect(
      instance.cancelCustomerOrder({ orderId: ORDER, stateId: STATE }),
    ).rejects.toMatchObject({ code: 'WRITE_FORBIDDEN' });

    /*
     * Ноль обращений — это и есть смысл запрета.
     *
     * Отказ по ответу сервера означал бы, что запрос уже ушёл в чужую систему
     * и был отклонён ею, а не нами.
     */
    expect(fetchState.calls).toHaveLength(0);
  });

  it('при разрешённой записи читает состояние и ставит согласованный статус', async () => {
    const fetchState = recordingFetch((call) =>
      call.method === 'GET'
        ? jsonResponse({
            id: ORDER,
            state: {
              meta: {
                href: `${MOYSKLAD_BASE_URL}/entity/customerorder/metadata/states/99999999-0000-0000-0000-000000000000`,
              },
            },
          })
        : jsonResponse({ id: ORDER }),
    );
    const { instance } = client(fetchState.impl, controlledClock(), TOKEN, true);

    const result = await instance.cancelCustomerOrder({ orderId: ORDER, stateId: STATE });
    expect(result.alreadyCancelled).toBe(false);
    expect(fetchState.calls.map((call) => call.method)).toEqual(['GET', 'PUT']);

    const write = fetchState.calls[1];
    expect(write?.url).toBe(`${MOYSKLAD_BASE_URL}/entity/customerorder/${ORDER}`);
    // Тело — официальный способ: ссылка на статус, а не выдуманное поле.
    expect(JSON.parse(write?.body ?? '{}')).toEqual({
      state: {
        meta: {
          href: `${MOYSKLAD_BASE_URL}/entity/customerorder/metadata/states/${STATE}`,
          type: 'state',
          mediaType: 'application/json',
        },
      },
    });
  });

  it('уже отменённый заказ второй записи не получает', async () => {
    const fetchState = recordingFetch(() =>
      jsonResponse({
        id: ORDER,
        state: {
          meta: {
            href: `${MOYSKLAD_BASE_URL}/entity/customerorder/metadata/states/${STATE}`,
          },
        },
      }),
    );
    const { instance } = client(fetchState.impl, controlledClock(), TOKEN, true);

    const result = await instance.cancelCustomerOrder({ orderId: ORDER, stateId: STATE });
    expect(result.alreadyCancelled).toBe(true);
    // Ровно одно обращение — чтение. Записи не было.
    expect(fetchState.calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('ошибка записи не выносит наружу ни токена, ни адреса запроса', async () => {
    const fetchState = recordingFetch((call) =>
      call.method === 'GET'
        ? jsonResponse({ id: ORDER })
        : jsonResponse({ errors: [{ error: `отказ по заказу ${ORDER}` }] }, { status: 500 }),
    );
    const { instance } = client(fetchState.impl, controlledClock(), TOKEN, true);

    const error = await instance
      .cancelCustomerOrder({ orderId: ORDER, stateId: STATE })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MoyskladError);
    const serialized = JSON.stringify({
      message: (error as MoyskladError).message,
      code: (error as MoyskladError).code,
      stack: (error as MoyskladError).stack,
    });
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(ORDER);
  });

  it('чужой идентификатор в запись не попадает', async () => {
    const fetchState = recordingFetch(() => jsonResponse({}));
    const { instance } = client(fetchState.impl, controlledClock(), TOKEN, true);

    await expect(
      instance.cancelCustomerOrder({ orderId: '../../entity/organization', stateId: STATE }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(fetchState.calls).toHaveLength(0);
  });
});
