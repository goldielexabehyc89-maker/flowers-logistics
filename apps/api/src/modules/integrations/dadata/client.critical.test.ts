/**
 * Критические проверки клиента DaData.
 *
 * Настоящих сетевых вызовов здесь нет: `fetch` подменён. Проверяются ровно те
 * свойства, нарушение которых опасно, — точный контракт запроса, отсутствие
 * параллельных обращений и скрытых повторов, разбор ошибок и то, что ни ключи,
 * ни адрес не попадают ни в ошибку, ни в её текст.
 *
 * Часы и ожидание инъецируются: реальных пауз в тестах нет.
 */

import { describe, expect, it } from 'vitest';
import {
  DADATA_CLEAN_ADDRESS_URL,
  DadataClient,
  DadataError,
  isPermanentDadataFailure,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
} from './client.js';
import { parseQcGeo } from './dto.js';

const API_KEY = 'test-api-key-should-never-leak';
const SECRET_KEY = 'test-secret-key-should-never-leak';
const ADDRESS = 'Москва, синтетическая улица, дом 1';

function controlledClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number): void => {
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

const EXACT = [{ geo_lat: '55.751244', geo_lon: '37.618423', qc_geo: '0' }];

function client(
  fetchImpl: typeof globalThis.fetch,
  clock = controlledClock(),
  credentials: { apiKey: string | null; secretKey: string | null } = {
    apiKey: API_KEY,
    secretKey: SECRET_KEY,
  },
) {
  return {
    instance: new DadataClient({
      credentials,
      fetch: fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      minIntervalMs: 1000,
    }),
    clock,
  };
}

describe('контракт запроса', () => {
  it('точный адрес, метод, заголовки и тело из одного адреса', async () => {
    let captured: { url: string; init: RequestInit | undefined } | null = null;

    const { instance } = client(async (url, init) => {
      captured = { url: String(url), init };
      return jsonResponse(EXACT);
    });

    await instance.cleanAddress(ADDRESS);

    expect(captured).not.toBeNull();
    const call = captured as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe(DADATA_CLEAN_ADDRESS_URL);
    expect(call.url).toBe('https://cleaner.dadata.ru/api/v1/clean/address');
    expect(call.init.method).toBe('POST');

    const headers = call.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Token ${API_KEY}`);
    expect(headers['X-Secret']).toBe(SECRET_KEY);
    expect(headers['Content-Type']).toBe('application/json');

    // Тело — массив ровно из одного адреса: сопоставлять ответы по позиции
    // в пакете значило бы однажды выдать координаты одного клиента другому.
    expect(JSON.parse(String(call.init.body))).toEqual([ADDRESS]);
  });

  it('без ключей запрос не выполняется вовсе', async () => {
    let calls = 0;
    const { instance } = client(
      async () => {
        calls += 1;
        return jsonResponse(EXACT);
      },
      controlledClock(),
      { apiKey: null, secretKey: null },
    );

    await expect(instance.cleanAddress(ADDRESS)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(calls).toBe(0);
    expect(instance.configured).toBe(false);
  });
});

describe('темп обращений', () => {
  it('не допускает параллельных обращений и держит не чаще одного запроса в секунду', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const startedAt: number[] = [];
    const clock = controlledClock();

    const { instance } = client(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      startedAt.push(clock.now());
      // Запрос занимает время: без очереди второй начался бы одновременно.
      clock.advance(10);
      inFlight -= 1;
      return jsonResponse(EXACT);
    }, clock);

    await Promise.all([
      instance.cleanAddress(ADDRESS),
      instance.cleanAddress(ADDRESS),
      instance.cleanAddress(ADDRESS),
    ]);

    expect(maxInFlight).toBe(1);
    expect(startedAt).toHaveLength(3);
    for (let i = 1; i < startedAt.length; i += 1) {
      expect((startedAt[i] ?? 0) - (startedAt[i - 1] ?? 0)).toBeGreaterThanOrEqual(1000);
    }
  });

  it('одна неудача не ломает очередь для следующих обращений', async () => {
    let calls = 0;
    const { instance } = client(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('', { status: 500 });
      }
      return jsonResponse(EXACT);
    });

    await expect(instance.cleanAddress(ADDRESS)).rejects.toBeInstanceOf(DadataError);
    await expect(instance.cleanAddress(ADDRESS)).resolves.toMatchObject({ qc_geo: '0' });
  });
});

describe('ошибки провайдера', () => {
  const CASES: { status: number; code: string }[] = [
    { status: 400, code: 'BAD_REQUEST' },
    { status: 401, code: 'UNAUTHORIZED' },
    { status: 403, code: 'FORBIDDEN' },
    { status: 500, code: 'SERVER_ERROR' },
    { status: 502, code: 'SERVER_ERROR' },
  ];

  for (const testCase of CASES) {
    it(`HTTP ${testCase.status} → ${testCase.code} без повтора`, async () => {
      let calls = 0;
      const { instance } = client(async () => {
        calls += 1;
        return new Response('подробности сервиса', { status: testCase.status });
      });

      await expect(instance.cleanAddress(ADDRESS)).rejects.toMatchObject({
        code: testCase.code,
        status: testCase.status,
      });
      // Скрытых повторов в клиенте нет: повторяет только очередь.
      expect(calls).toBe(1);
    });
  }

  it('429 отдаёт RATE_LIMITED и разобранный Retry-After', async () => {
    const { instance } = client(
      async () => new Response('', { status: 429, headers: { 'retry-after': '12' } }),
    );

    await expect(instance.cleanAddress(ADDRESS)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfterMs: 12_000,
    });
  });

  it('429 без Retry-After не выдумывает задержку', async () => {
    const { instance } = client(async () => new Response('', { status: 429 }));

    await expect(instance.cleanAddress(ADDRESS)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: null,
    });
  });

  it('таймаут и обрыв соединения дают TRANSPORT_ERROR', async () => {
    const { instance } = client(async () => {
      throw new Error(`timeout при обращении к ${DADATA_CLEAN_ADDRESS_URL} с телом ${ADDRESS}`);
    });

    const error = await instance.cleanAddress(ADDRESS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DadataError);
    expect((error as DadataError).code).toBe('TRANSPORT_ERROR');
    // Текст ошибки транспорта содержал адрес — наружу он не выходит.
    expect((error as DadataError).message).not.toContain(ADDRESS);
  });

  it('невалидный JSON и неполный ответ дают BAD_RESPONSE', async () => {
    const broken = client(
      async () =>
        new Response('{не json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await expect(broken.instance.cleanAddress(ADDRESS)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });

    // Не массив.
    const notArray = client(async () => jsonResponse({ geo_lat: '55.7' }));
    await expect(notArray.instance.cleanAddress(ADDRESS)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });

    // Пустой массив: сопоставить ответ с заказом невозможно.
    const empty = client(async () => jsonResponse([]));
    await expect(empty.instance.cleanAddress(ADDRESS)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });

    // Два результата на один отправленный адрес — тоже несопоставимо.
    const two = client(async () => jsonResponse([...EXACT, ...EXACT]));
    await expect(two.instance.cleanAddress(ADDRESS)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });

    // Тип поля не соответствует схеме.
    const wrongType = client(async () => jsonResponse([{ geo_lat: { value: 1 }, qc_geo: '0' }]));
    await expect(wrongType.instance.cleanAddress(ADDRESS)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });

  it('ни ключи, ни адрес не попадают в текст ошибки', async () => {
    const { instance } = client(
      async () =>
        new Response(`ключ ${API_KEY} отклонён для адреса ${ADDRESS}`, {
          status: 403,
        }),
    );

    const error = await instance.cleanAddress(ADDRESS).catch((caught: unknown) => caught);
    const text = JSON.stringify({
      message: (error as Error).message,
      error: String(error),
    });

    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain(ADDRESS);
  });

  it('отказ авторизации и прав признан неустранимым повтором', () => {
    expect(isPermanentDadataFailure('UNAUTHORIZED')).toBe(true);
    expect(isPermanentDadataFailure('FORBIDDEN')).toBe(true);
    expect(isPermanentDadataFailure('NOT_CONFIGURED')).toBe(true);
    expect(isPermanentDadataFailure('SERVER_ERROR')).toBe(false);
    expect(isPermanentDadataFailure('TRANSPORT_ERROR')).toBe(false);
    expect(isPermanentDadataFailure('RATE_LIMITED')).toBe(false);
  });
});

describe('разбор Retry-After', () => {
  it('секунды, дата и мусор', () => {
    expect(parseRetryAfter('30', 0)).toBe(30_000);
    expect(parseRetryAfter(' 30 ', 0)).toBe(30_000);
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter('', 0)).toBeNull();
    expect(parseRetryAfter('позже', 0)).toBeNull();

    const now = Date.parse('2026-08-12T10:00:00.000Z');
    expect(parseRetryAfter('Wed, 12 Aug 2026 10:00:30 GMT', now)).toBe(30_000);
    // Дата в прошлом означает «можно сразу», а не отрицательную паузу.
    expect(parseRetryAfter('Wed, 12 Aug 2026 09:00:00 GMT', now)).toBe(0);
  });

  it('ограничен сверху: сервис не усыпляет очередь на сутки', () => {
    expect(parseRetryAfter('86400', 0)).toBe(MAX_RETRY_AFTER_MS);
    const now = Date.parse('2026-08-12T10:00:00.000Z');
    expect(parseRetryAfter('Thu, 13 Aug 2026 10:00:00 GMT', now)).toBe(MAX_RETRY_AFTER_MS);
  });
});

describe('разбор qc_geo', () => {
  it('строка, число и всё остальное', () => {
    expect(parseQcGeo('0')).toBe(0);
    expect(parseQcGeo(' 0 ')).toBe(0);
    expect(parseQcGeo(0)).toBe(0);
    expect(parseQcGeo('3')).toBe(3);
    expect(parseQcGeo(5)).toBe(5);

    // Ничто из этого не должно превратиться в «точный дом».
    for (const value of [null, undefined, '', ' ', 'нет', '0x0', '0.5', 0.5, Number.NaN]) {
      expect(parseQcGeo(value as never), String(value)).not.toBe(0);
    }
  });
});
