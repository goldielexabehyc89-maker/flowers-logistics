/**
 * Доля общего токена МоегоСклада.
 *
 * Токен делят несколько сервисов, и наш импорт не имеет права занять его
 * целиком: чужая работающая интеграция замолчит не с ошибкой в нашем журнале,
 * а у своего владельца. Поэтому проверяется не «работает ли клиент», а то,
 * из-за чего пострадали бы соседи:
 *
 *  * темп не превышает разрешённого, а параллельность остаётся единицей;
 *  * неприкосновенный остаток окна не тратится;
 *  * названная сервером пауза после `429` выдерживается целиком;
 *  * повторный `429` снижает темп до конца прохода и сам его не возвращает;
 *  * отказ доступа не превращается в шторм запросов негодным ключом;
 *  * 5xx и обрыв связи повторяются ограниченно;
 *  * запрещённый метод не доходит до сети;
 *  * токен не появляется ни в адресе, ни в ошибке, ни в отчёте.
 *
 * Настоящей сети здесь нет: `fetch`, часы и паузы подменены, поэтому проверка
 * измеряет ПОВЕДЕНИЕ, а не скорость машины.
 */

import { describe, expect, it } from 'vitest';
import { MoyskladClient, MoyskladError, MAX_EXPANDED_PAGE_SIZE } from './client.js';
import { MOYSKLAD_IDS } from './config.js';

const TOKEN = 'секретный-токен-которого-нигде-не-должно-быть';
const BASE = 'https://api.moysklad.ru/api/remap/1.2';

/** Политика владельца: два запроса в секунду, строго последовательно. */
const POLICY = { maxRequestsPerSecond: 2, maxConcurrency: 1, reserveRequests: 30 };

interface Call {
  url: string;
  at: number;
}

/**
 * Подменный контур: часы, паузы и сеть.
 *
 * Часы двигаются ТОЛЬКО паузами клиента. Так проверка видит его собственный
 * расчёт темпа, а не то, успела ли машина выполнить код за миллисекунду.
 */
function harness(responses: (call: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  let clock = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const sleeps: number[] = [];

  const client = new MoyskladClient({
    config: { baseUrl: BASE, token: TOKEN, ids: MOYSKLAD_IDS },
    rateLimit: POLICY,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    // Разброс убран: проверяется соблюдение серверной паузы, а не случайность.
    jitter: () => 0,
    fetch: (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input), at: clock });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await responses(calls.length);
      } finally {
        inFlight -= 1;
      }
    }) as typeof globalThis.fetch,
  });

  return {
    client,
    calls,
    sleeps,
    get maxInFlight(): number {
      return maxInFlight;
    },
    get clock(): number {
      return clock;
    },
  };
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const EMPTY_PAGE = { context: {}, meta: { size: 0 }, rows: [] };

describe('темп и параллельность', () => {
  it('между обращениями выдерживается пауза разрешённого темпа', async () => {
    const h = harness(() => json(EMPTY_PAGE));

    await h.client.send('GET', '/entity/customerorder?limit=1');
    await h.client.send('GET', '/entity/customerorder?limit=1');
    await h.client.send('GET', '/entity/customerorder?limit=1');

    // Два запроса в секунду — это не меньше 500 мс между началами.
    const gaps = h.calls.slice(1).map((call, index) => call.at - (h.calls[index]?.at ?? 0));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(500);
    }
    expect(h.client.rateLimitStats.requests).toBe(3);
    expect(h.client.rateLimitStats.maxRequestsPerSecond).toBeLessThanOrEqual(2);
  });

  it('параллельных обращений не бывает даже при одновременном запуске', async () => {
    const h = harness(() => json(EMPTY_PAGE));

    // Три вызова стартуют разом: очередь обязана выстроить их в цепочку.
    await Promise.all([
      h.client.send('GET', '/entity/customerorder?limit=1'),
      h.client.send('GET', '/entity/customerorder?limit=1'),
      h.client.send('GET', '/entity/customerorder?limit=1'),
    ]);

    expect(h.maxInFlight).toBe(1);
    expect(h.client.rateLimitStats.maxConcurrency).toBe(1);
  });

  it('все способы запуска делят одну очередь', async () => {
    // Страницы заказов, состав, справочник единиц и произвольное чтение —
    // разные методы клиента, но лимит у них общий: он один на токен.
    const h = harness(() => json(EMPTY_PAGE));

    await Promise.all([
      h.client.listCustomerOrders({ limit: MAX_EXPANDED_PAGE_SIZE, offset: 0, filter: 'x' }),
      h.client.listUnitsOfMeasure(),
      h.client.send('GET', '/entity/customerorder?limit=1'),
    ]);

    expect(h.maxInFlight).toBe(1);
    const gaps = h.calls.slice(1).map((call, index) => call.at - (h.calls[index]?.at ?? 0));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(500);
    }
  });

  it('страницы читаются максимальным безопасным размером', () => {
    // Больше сотни МойСклад отвечает 200 и молча теряет строки — это
    // наблюдение живых данных, а не предположение. Меньше — лишние запросы
    // по общему лимиту.
    expect(MAX_EXPANDED_PAGE_SIZE).toBe(100);
  });
});

describe('неприкосновенный остаток окна', () => {
  it('очередь ждёт сброса, когда остаток меньше резерва', async () => {
    const h = harness((call) =>
      json(EMPTY_PAGE, {
        // Первый ответ сообщает, что окно почти исчерпано.
        'x-ratelimit-remaining': call === 1 ? '5' : '900',
        'x-ratelimit-limit': '1000',
        'x-ratelimit-reset': '3000',
      }),
    );

    await h.client.send('GET', '/entity/customerorder?limit=1');
    await h.client.send('GET', '/entity/customerorder?limit=1');

    expect(h.client.rateLimitStats.reservePauses).toBe(1);
    // Пауза — ровно названное сервером окно, а не наша догадка.
    expect(h.sleeps).toContain(3000);
  });

  it('достаточный остаток очередь не задерживает', async () => {
    const h = harness(() =>
      json(EMPTY_PAGE, { 'x-ratelimit-remaining': '900', 'x-ratelimit-limit': '1000' }),
    );

    await h.client.send('GET', '/entity/customerorder?limit=1');
    await h.client.send('GET', '/entity/customerorder?limit=1');

    expect(h.client.rateLimitStats.reservePauses).toBe(0);
  });
});

describe('поведение при 429', () => {
  it('выдерживается названная сервером пауза, а не наша', async () => {
    let served = 0;
    const h = harness(() => {
      served += 1;
      if (served === 1) {
        return new Response('', {
          status: 429,
          headers: { 'x-lognex-retry-after': '7000' },
        });
      }
      return json(EMPTY_PAGE);
    });

    await h.client.send('GET', '/entity/customerorder?limit=1');

    expect(h.client.rateLimitStats.rateLimited).toBe(1);
    expect(h.sleeps).toContain(7000);
    // Обращение доведено до конца: лимит — это «позже», а не «нельзя».
    expect(h.calls).toHaveLength(2);
  });

  it('повторный 429 снижает темп до конца прохода и сам его не возвращает', async () => {
    let served = 0;
    const h = harness(() => {
      served += 1;
      // Два лимита подряд в одном проходе.
      if (served <= 2) {
        return new Response('', { status: 429, headers: { 'x-lognex-retry-after': '1000' } });
      }
      return json(EMPTY_PAGE);
    });

    await h.client.send('GET', '/entity/customerorder?limit=1');
    expect(h.client.rateLimitStats.slowedDown).toBe(true);

    // Следующее обращение уже идёт медленнее: сервер дважды сказал «слишком
    // часто», и третий раз он скажет это чужой интеграции.
    const before = h.calls[h.calls.length - 1]?.at ?? 0;
    await h.client.send('GET', '/entity/customerorder?limit=1');
    const after = h.calls[h.calls.length - 1]?.at ?? 0;
    expect(after - before).toBeGreaterThanOrEqual(2000);

    // Внутри прохода темп не восстанавливается сам.
    expect(h.client.rateLimitStats.slowedDown).toBe(true);

    // И только новый проход снимает замедление.
    h.client.startPass();
    expect(h.client.rateLimitStats.slowedDown).toBe(false);
  });
});

describe('отказы', () => {
  it('401 и 403 останавливают проход без повторов', async () => {
    for (const status of [401, 403]) {
      const h = harness(() => new Response('', { status }));

      await expect(h.client.send('GET', '/entity/customerorder?limit=1')).rejects.toBeInstanceOf(
        MoyskladError,
      );

      // Ровно одно обращение: повтор заведомо негодным ключом отнял бы
      // общий лимит у чужой интеграции и приблизил бы блокировку аккаунта.
      expect(h.calls, String(status)).toHaveLength(1);
      expect(h.client.rateLimitStats.retries, String(status)).toBe(0);
    }
  });

  it('5xx повторяется ограниченно и с растущей задержкой', async () => {
    const h = harness(() => new Response('', { status: 503 }));

    await expect(h.client.send('GET', '/entity/customerorder?limit=1')).rejects.toBeInstanceOf(
      MoyskladError,
    );

    // Первая попытка плюс три повтора — и всё: настойчивость ограничена.
    expect(h.calls).toHaveLength(4);
    expect(h.client.rateLimitStats.retries).toBe(3);
    expect(h.sleeps).toContain(1000);
    expect(h.sleeps).toContain(2000);
    expect(h.sleeps).toContain(4000);
  });

  it('обрыв связи повторяется, а успех после него принимается', async () => {
    let served = 0;
    const h = harness(() => {
      served += 1;
      if (served === 1) {
        throw new Error('соединение разорвано');
      }
      return json(EMPTY_PAGE);
    });

    await h.client.send('GET', '/entity/customerorder?limit=1');

    expect(h.calls).toHaveLength(2);
    expect(h.client.rateLimitStats.retries).toBe(1);
  });

  it('запрещённый метод не доходит до сети', async () => {
    const h = harness(() => json(EMPTY_PAGE));

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      await expect(h.client.send(method, '/entity/customerorder')).rejects.toMatchObject({
        code: 'METHOD_NOT_ALLOWED',
      });
    }

    // Ни одного сетевого вызова: запрещённый глагол не тратит ни лимит
    // аккаунта, ни место в очереди.
    expect(h.calls).toHaveLength(0);
    expect(h.client.rateLimitStats.requests).toBe(0);
  });
});

describe('токен', () => {
  it('не появляется ни в адресе, ни в ошибке, ни в отчёте', async () => {
    const h = harness(() => new Response('', { status: 500 }));

    let message = '';
    try {
      await h.client.send('GET', '/entity/customerorder?limit=1');
    } catch (error) {
      message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    }

    for (const call of h.calls) {
      expect(call.url).not.toContain(TOKEN);
    }
    expect(message).not.toContain(TOKEN);
    expect(JSON.stringify(h.client.rateLimitStats)).not.toContain(TOKEN);
    expect(JSON.stringify(h.client.rateLimit)).not.toContain(TOKEN);
  });

  it('уходит только заголовком Authorization: Bearer', async () => {
    const seen: Record<string, string>[] = [];
    const client = new MoyskladClient({
      config: { baseUrl: BASE, token: TOKEN, ids: MOYSKLAD_IDS },
      rateLimit: POLICY,
      now: () => 0,
      sleep: async () => undefined,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ ...((init?.headers ?? {}) as Record<string, string>) });
        return json(EMPTY_PAGE);
      }) as typeof globalThis.fetch,
    });

    await client.send('GET', '/entity/customerorder?limit=1');

    const headers = seen[0] ?? {};
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    // Больше нигде: ни в отдельном заголовке, ни в адресе.
    const elsewhere = Object.entries(headers).filter(
      ([name, value]) => name !== 'Authorization' && value.includes(TOKEN),
    );
    expect(elsewhere).toEqual([]);
  });
});
