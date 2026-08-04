/**
 * Критические проверки клиента API.
 *
 * Проверяется то, что нельзя увидеть глазами на экране: токен не попадает
 * в браузерное хранилище, параллельные 401 не превращаются в несколько ротаций,
 * повтор запроса выполняется ровно один раз, а окончательный отказ очищает сессию.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api-client';

interface StubCall {
  url: string;
  init: RequestInit;
}

/** Собирает поддельный fetch с заданной последовательностью ответов. */
function stubFetch(handler: (call: StubCall, index: number) => Response) {
  const calls: StubCall[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    const response = handler(call, calls.length);
    calls.push(call);
    return response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Заглушки браузерных хранилищ: тест следит, что клиент к ним не обращается. */
function installStorageSpies() {
  const setItem = vi.fn();
  const storage = {
    setItem,
    getItem: vi.fn(() => null),
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: vi.fn(() => null),
    length: 0,
  };

  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('sessionStorage', storage);
  vi.stubGlobal('indexedDB', { open: vi.fn() });

  return {
    setItem,
    open: (globalThis as unknown as { indexedDB: { open: unknown } }).indexedDB.open,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('хранение access-токена', () => {
  it('токен не записывается в localStorage, sessionStorage и IndexedDB', async () => {
    const spies = installStorageSpies();
    const secretToken = 'access-token-must-stay-in-memory';

    const { impl } = stubFetch(() =>
      jsonResponse(200, { accessToken: secretToken, user: { id: 'u1', roles: ['ADMIN'] } }),
    );
    const client = new ApiClient({ fetchImpl: impl });

    await client.authenticate('/api/auth/login', { phone: '+79161234567', pin: '1234' });

    expect(client.hasAccessToken).toBe(true);
    expect(spies.setItem).not.toHaveBeenCalled();
    expect(spies.open).not.toHaveBeenCalled();
  });

  it('токен передаётся заголовком Authorization и очищается вместе с сессией', async () => {
    const token = 'bearer-value';
    const { impl, calls } = stubFetch((call) =>
      call.url === '/api/auth/login'
        ? jsonResponse(200, { accessToken: token, user: {} })
        : jsonResponse(200, { ok: true }),
    );
    const client = new ApiClient({ fetchImpl: impl });

    await client.authenticate('/api/auth/login', {});
    await client.get('/api/users');

    const headers = new Headers(calls[1]?.init.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${token}`);
    expect(calls[1]?.init.credentials).toBe('same-origin');

    client.clear();
    expect(client.hasAccessToken).toBe(false);
  });
});

describe('обновление сессии при 401', () => {
  it('параллельные 401 вызывают ровно один refresh', async () => {
    let refreshCalls = 0;
    let protectedCalls = 0;

    const { impl } = stubFetch((call) => {
      if (call.url === '/api/auth/refresh') {
        refreshCalls += 1;
        return jsonResponse(200, { accessToken: 'fresh-token' });
      }
      protectedCalls += 1;
      // Первые три обращения (по одному на каждый параллельный запрос) отвечают 401,
      // после обновления — успехом.
      return protectedCalls <= 3
        ? jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } })
        : jsonResponse(200, { ok: true });
    });

    const client = new ApiClient({ fetchImpl: impl });
    client.setAccessToken('stale-token');

    const results = await Promise.all([
      client.get('/api/users'),
      client.get('/api/users?page=2'),
      client.get('/api/status'),
    ]);

    expect(results).toHaveLength(3);
    expect(refreshCalls).toBe(1);
  });

  it('запрос повторяется максимум один раз', async () => {
    let protectedCalls = 0;
    let refreshCalls = 0;

    const { impl } = stubFetch((call) => {
      if (call.url === '/api/auth/refresh') {
        refreshCalls += 1;
        return jsonResponse(200, { accessToken: 'fresh-token' });
      }
      protectedCalls += 1;
      // Сервер продолжает отвечать 401 даже после обновления.
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Требуется вход.' } });
    });

    const client = new ApiClient({ fetchImpl: impl });
    client.setAccessToken('stale-token');

    await expect(client.get('/api/users')).rejects.toBeInstanceOf(ApiError);

    // Исходный запрос + ровно один повтор. Бесконечного цикла нет.
    expect(protectedCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  });

  it('повторный 401 после успешного refresh очищает сессию ровно один раз', async () => {
    const onSessionLost = vi.fn();
    let refreshCalls = 0;

    const { impl } = stubFetch((call) => {
      if (call.url === '/api/auth/refresh') {
        refreshCalls += 1;
        return jsonResponse(200, { accessToken: 'fresh-token' });
      }
      // Сервер отвечает 401 и до, и после обновления: сессия действительно мертва.
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } });
    });

    const client = new ApiClient({ fetchImpl: impl, onSessionLost });
    client.setAccessToken('stale-token');

    await expect(client.get('/api/users')).rejects.toBeInstanceOf(ApiError);

    // Без этого пользователь остался бы внутри приложения с мёртвым токеном,
    // а каждый следующий запрос снова запускал бы обновление.
    expect(client.hasAccessToken).toBe(false);
    expect(onSessionLost).toHaveBeenCalledTimes(1);
    expect(refreshCalls).toBe(1);
  });

  it('отложенный 401 со старым токеном не запускает второй refresh', async () => {
    let refreshCalls = 0;
    let releaseSlow: (() => void) | null = null;

    // Ответ медленного запроса придёт уже после того, как токен обновит другой запрос.
    const slowResponse = new Promise<Response>((resolve) => {
      releaseSlow = () => resolve(jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } }));
    });

    let slowAttempts = 0;
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === '/api/auth/refresh') {
        refreshCalls += 1;
        return jsonResponse(200, { accessToken: 'fresh-token' });
      }

      if (url === '/api/slow') {
        slowAttempts += 1;
        // Первая попытка «зависает», повтор после обновления проходит успешно.
        return slowAttempts === 1 ? slowResponse : jsonResponse(200, { ok: true });
      }

      // Быстрый запрос получает 401 и запускает единственный refresh.
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } });
    }) as unknown as typeof fetch;

    const client = new ApiClient({ fetchImpl: impl });
    client.setAccessToken('stale-token');

    const slow = client.get('/api/slow');
    // Быстрый запрос успевает целиком: 401 → refresh → повтор.
    await client.get('/api/fast').catch(() => undefined);

    releaseSlow?.();
    await expect(slow).resolves.toEqual({ ok: true });

    // Второй refresh не запускался: токен уже был обновлён.
    expect(refreshCalls).toBe(1);
  });

  it('окончательный отказ очищает сессию и сообщает интерфейсу', async () => {
    const onSessionLost = vi.fn();
    const { impl } = stubFetch((call) =>
      call.url === '/api/auth/refresh'
        ? jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } })
        : jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } }),
    );

    const client = new ApiClient({ fetchImpl: impl, onSessionLost });
    client.setAccessToken('stale-token');

    await expect(client.get('/api/users')).rejects.toBeInstanceOf(ApiError);

    expect(client.hasAccessToken).toBe(false);
    expect(onSessionLost).toHaveBeenCalledTimes(1);
  });

  it('обновление сессии не пытается обновить само себя', async () => {
    let refreshCalls = 0;
    const { impl } = stubFetch(() => {
      refreshCalls += 1;
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } });
    });

    const client = new ApiClient({ fetchImpl: impl });
    const user = await client.restoreSession();

    expect(user).toBeNull();
    expect(refreshCalls).toBe(1);
  });
});

describe('ошибки API', () => {
  it('разбирает код, сообщение и Retry-After', async () => {
    const { impl } = stubFetch(() =>
      jsonResponse(
        429,
        { error: { code: 'RATE_LIMITED', message: 'Слишком много попыток.' } },
        { 'Retry-After': '30' },
      ),
    );

    const client = new ApiClient({ fetchImpl: impl });

    await expect(client.post('/api/auth/login', {})).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 30,
    });
  });
});
