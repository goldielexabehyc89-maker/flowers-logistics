/**
 * Критические проверки изолированного контура фотографий.
 *
 * Все отказы и задержки моделируются заглушкой сети и управляемым временем —
 * настоящий МойСклад не трогается. Время предохранителя задаётся инъекцией
 * `now`; единственный реальный таймер (3 с) проверяется поддельными таймерами.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhotoFetcher } from './photo-fetcher.js';

const BASE = 'https://api.moysklad.ru/api/remap/1.2';

function okResponse(): Response {
  return new Response(
    JSON.stringify({ rows: [{ meta: { downloadHref: `${BASE}/download/x` } }] }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function fileResponse(): Response {
  return new Response(Buffer.from([1, 2, 3, 4]), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}

/** Заглушка сети: images → список из одной картинки, download → png. */
function workingFetch(counter?: { n: number }): typeof globalThis.fetch {
  return (async (input: string | URL) => {
    if (counter !== undefined) {
      counter.n += 1;
    }
    return String(input).includes('/images') ? okResponse() : fileResponse();
  }) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('контур фотографий: базовое поведение', () => {
  it('успех отдаёт байты и тип, предохранитель закрыт', async () => {
    const fetcher = new PhotoFetcher({ baseUrl: BASE, token: 'tok', fetch: workingFetch() });
    const photo = await fetcher.getPhoto(['product'], 'a1');
    expect(photo).not.toBeNull();
    expect(photo?.contentType).toBe('image/png');
    expect(fetcher.snapshot().circuit).toBe('CLOSED');
  });

  it('пустой список изображений — это «нет фото», не отказ upstream', async () => {
    const emptyFetch = (async () =>
      new Response(JSON.stringify({ rows: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;
    const fetcher = new PhotoFetcher({ baseUrl: BASE, token: 'tok', fetch: emptyFetch });
    expect(await fetcher.getPhoto(['product'], 'a1')).toBeNull();
    // Предохранитель НЕ открылся: обычное отсутствие фото — не сбой.
    expect(fetcher.snapshot().circuit).toBe('CLOSED');
    expect(fetcher.snapshot().failures).toBe(0);
  });
});

describe('контур фотографий: предохранитель', () => {
  it('после отказа upstream (5xx) предохранитель открывается', async () => {
    const failFetch = (async () =>
      new Response('busy', { status: 503 })) as unknown as typeof globalThis.fetch;
    const fetcher = new PhotoFetcher({ baseUrl: BASE, token: 'tok', fetch: failFetch });
    expect(await fetcher.getPhoto(['product'], 'a1')).toBeNull();
    expect(fetcher.snapshot().circuit).toBe('OPEN');
    expect(fetcher.snapshot().failures).toBe(1);
    expect(fetcher.snapshot().opens).toBe(1);
  });

  it('пока предохранитель открыт, запросы быстро завершаются без сети', async () => {
    let now = 0;
    const counter = { n: 0 };
    let fail = true;
    const fetchImpl = (async (input: string | URL) => {
      counter.n += 1;
      if (fail) {
        return new Response('busy', { status: 503 });
      }
      return String(input).includes('/images') ? okResponse() : fileResponse();
    }) as unknown as typeof globalThis.fetch;
    const fetcher = new PhotoFetcher({
      baseUrl: BASE,
      token: 'tok',
      fetch: fetchImpl,
      now: () => now,
      breakerOpenMs: 60_000,
    });

    await fetcher.getPhoto(['product'], 'a1'); // открыл предохранитель
    expect(fetcher.snapshot().circuit).toBe('OPEN');
    const callsAfterOpen = counter.n;

    // Пока открыт — ни одного сетевого обращения, мгновенный локальный отказ.
    fail = false;
    expect(await fetcher.getPhoto(['product'], 'a2')).toBeNull();
    expect(counter.n).toBe(callsAfterOpen);
    expect(fetcher.snapshot().fastFails).toBeGreaterThanOrEqual(1);

    // После паузы — ровно один пробный запрос, успех закрывает предохранитель.
    now += 60_000;
    const photo = await fetcher.getPhoto(['product'], 'a3');
    expect(photo).not.toBeNull();
    expect(fetcher.snapshot().circuit).toBe('CLOSED');
    expect(counter.n).toBeGreaterThan(callsAfterOpen);
  });

  it('в полуоткрытом состоянии допускается ровно один пробный запрос', async () => {
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    let now = 0;
    let failNext = true;
    const pendingImages: Array<(r: Response) => void> = [];
    const fetchImpl = (async (input: string | URL) =>
      new Promise<Response>((resolve) => {
        if (failNext) {
          resolve(new Response('x', { status: 500 }));
          return;
        }
        if (String(input).includes('/images')) {
          pendingImages.push(resolve); // держим пробный запрос «в полёте»
          return;
        }
        resolve(fileResponse());
      })) as unknown as typeof globalThis.fetch;
    const fetcher = new PhotoFetcher({
      baseUrl: BASE,
      token: 'tok',
      fetch: fetchImpl,
      now: () => now,
      breakerOpenMs: 60_000,
    });

    // 1. Открываем предохранитель сбоем.
    await fetcher.getPhoto(['product'], 'a1');
    expect(fetcher.snapshot().circuit).toBe('OPEN');

    // 2. Пауза прошла; upstream «жив», но пробный запрос повиснет на images.
    now += 60_000;
    failNext = false;
    const trial = fetcher.getPhoto(['product'], 'a2');
    await flush();
    expect(pendingImages.length).toBe(1); // ровно один пробный ушёл

    // 3. Второй запрос во время пробного — быстрый отказ, второго обращения нет.
    expect(await fetcher.getPhoto(['product'], 'a3')).toBeNull();
    expect(pendingImages.length).toBe(1);

    // 4. Пробный успешен — предохранитель закрывается.
    pendingImages[0]?.(okResponse());
    expect(await trial).not.toBeNull();
    expect(fetcher.snapshot().circuit).toBe('CLOSED');
  });

  it('таймаут зависшего upstream не превышает ~3 секунд и открывает предохранитель', async () => {
    vi.useFakeTimers();
    const hangFetch = ((_input: string | URL, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof globalThis.fetch;
    const fetcher = new PhotoFetcher({
      baseUrl: BASE,
      token: 'tok',
      fetch: hangFetch,
      timeoutMs: 3000,
    });

    const promise = fetcher.getPhoto(['product'], 'a1');
    await vi.advanceTimersByTimeAsync(3000);
    expect(await promise).toBeNull();
    expect(fetcher.snapshot().circuit).toBe('OPEN');
    expect(fetcher.snapshot().timeouts).toBe(1);
  });
});

describe('контур фотографий: дедуп и ограниченная очередь', () => {
  it('одинаковый assortmentId склеивается в один upstream-запрос', async () => {
    const pending: Array<(r: Response) => void> = [];
    const deferred = (async (input: string | URL) =>
      new Promise<Response>((resolve) => {
        if (String(input).includes('/images')) {
          pending.push(resolve);
        } else {
          resolve(fileResponse());
        }
      })) as unknown as typeof globalThis.fetch;
    const fetcher = new PhotoFetcher({ baseUrl: BASE, token: 'tok', fetch: deferred });

    const p1 = fetcher.getPhoto(['product'], 'same');
    const p2 = fetcher.getPhoto(['product'], 'same');
    const p3 = fetcher.getPhoto(['product'], 'same');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Один upstream-запрос images на всех троих.
    expect(pending.length).toBe(1);
    expect(fetcher.snapshot().coalesced).toBe(2);

    pending[0]?.(okResponse());
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).not.toBeNull();
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
  });

  it('запросы сверх лимита очереди быстро отклоняются, очередь ограничена', async () => {
    const started: string[] = [];
    const deferred = (async (input: string | URL) =>
      new Promise<Response>((resolve) => {
        started.push(String(input));
        if (!String(input).includes('/images')) {
          resolve(fileResponse());
        }
        // images висят: держим слоты занятыми.
      })) as unknown as typeof globalThis.fetch;
    const fetcher = new PhotoFetcher({
      baseUrl: BASE,
      token: 'tok',
      fetch: deferred,
      maxConcurrent: 2,
      maxQueued: 3,
    });

    // 10 разных фото: 2 в работе + 3 в очереди «зависают», последние 5 — быстрый
    // отказ (очередь заполнена). Ждём только последние 5.
    const promises = Array.from({ length: 10 }, (_, i) =>
      fetcher.getPhoto(['product'], `id-${String(i)}`),
    );
    const fastFails = await Promise.all(promises.slice(5));
    for (const r of fastFails) {
      expect(r).toBeNull();
    }
    const snap = fetcher.snapshot();
    expect(snap.inFlight).toBe(2);
    expect(snap.queueLength).toBe(3);
    expect(snap.fastFails).toBe(5);
    // В upstream ушло ровно 2 запроса (по числу слотов), не 10.
    expect(started.length).toBe(2);
  });
});

describe('контур фотографий: журнал без секретов', () => {
  it('в лог предохранителя не попадают токен и адрес upstream', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const fetcher = new PhotoFetcher({
      baseUrl: BASE,
      token: 'super-secret-token',
      fetch: (async () => new Response('x', { status: 500 })) as unknown as typeof globalThis.fetch,
      logger: { info: (obj) => logs.push(obj) },
    });
    await fetcher.getPhoto(['product'], 'a1');
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain('super-secret-token');
    expect(dump).not.toContain('api.moysklad.ru');
    expect(dump).not.toContain('download');
  });
});
