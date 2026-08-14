/**
 * Критические проверки клиента Photon.
 *
 * Настоящей сети здесь нет: `fetch` подменён. Проверяется то, нарушение чего
 * опасно, — запрет публичных серверов до обращения к сети, ограничение поиска
 * рабочей областью, отсутствие адреса в сообщениях об ошибках и разбор ответа
 * схемой вместо доверия чужому формату.
 */

import { describe, expect, it } from 'vitest';
import {
  assertPrivatePhotonUrl,
  isPermanentPhotonFailure,
  MOSCOW_REGION_BBOX,
  PhotonClient,
  PhotonError,
} from './client.js';

/** Синтетический адрес: настоящих адресов клиентов в тестах нет. */
const ADDRESS = 'Москва, синтетическая улица, дом 1';
const PRIVATE_URL = 'http://photon.internal:2322/api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Записывает обращения вместо того, чтобы их выполнять. */
function recordingFetch(response: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return response();
  }) as typeof globalThis.fetch;
  return { calls, impl };
}

const HOUSE = {
  features: [
    {
      geometry: { coordinates: [37.618423, 55.751244] },
      properties: { housenumber: '1', street: 'синтетическая', city: 'Москва' },
    },
  ],
};

describe('запрет публичных серверов', () => {
  const PUBLIC_URLS = [
    'https://photon.komoot.io/api',
    'https://photon.komoot.de/api',
    'https://nominatim.openstreetmap.org/search',
    'https://NOMINATIM.OSM.ORG/search',
  ];

  it('публичный адрес отвергается до сети, а не после первого запроса', () => {
    for (const url of PUBLIC_URLS) {
      // Проверка на конструкторе: демонстрационный сервис не должен получить
      // ни одного адреса клиента даже случайно, из-за забытого значения
      // в конфигурации.
      expect(() => new PhotonClient({ url }), url).toThrow(PhotonError);
      try {
        assertPrivatePhotonUrl(url);
        expect.unreachable(`публичный адрес принят: ${url}`);
      } catch (error) {
        expect((error as PhotonError).code, url).toBe('PUBLIC_ENDPOINT_FORBIDDEN');
      }
    }
  });

  it('ни один публичный адрес не доходит до fetch', async () => {
    const fetchImpl = recordingFetch(() => jsonResponse(HOUSE));

    for (const url of PUBLIC_URLS) {
      expect(() => new PhotonClient({ url, fetch: fetchImpl.impl })).toThrow();
    }

    // Главное утверждение: сетевых обращений не было вовсе.
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('свой адрес принимается', () => {
    for (const url of [
      PRIVATE_URL,
      'http://127.0.0.1:2322/api',
      'http://photon:2322/api',
      'https://geo.internal.example/api',
    ]) {
      expect(() => assertPrivatePhotonUrl(url), url).not.toThrow();
    }
  });

  it('неразборчивое значение — это «не настроен», а не «настроен как-нибудь»', () => {
    for (const url of ['не адрес', 'photon.internal:2322', '///']) {
      try {
        assertPrivatePhotonUrl(url);
        expect.unreachable(`мусор принят: ${url}`);
      } catch (error) {
        expect((error as PhotonError).code, url).toBe('NOT_CONFIGURED');
      }
    }
  });

  it('отказ настройки сам не пройдёт, а отказ сервиса может пройти', () => {
    // По этому делению очередь решает, останавливаться навсегда или ждать.
    expect(isPermanentPhotonFailure('NOT_CONFIGURED')).toBe(true);
    expect(isPermanentPhotonFailure('PUBLIC_ENDPOINT_FORBIDDEN')).toBe(true);

    for (const code of ['SERVER_ERROR', 'TRANSPORT_ERROR', 'BAD_RESPONSE', 'BAD_REQUEST'] as const) {
      expect(isPermanentPhotonFailure(code), code).toBe(false);
    }
  });
});

describe('запрос', () => {
  it('ненастроенный клиент не обращается никуда', async () => {
    const fetchImpl = recordingFetch(() => jsonResponse(HOUSE));
    const client = new PhotonClient({ url: null, fetch: fetchImpl.impl });

    expect(client.configured).toBe(false);
    await expect(client.search(ADDRESS)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('поиск ограничен рабочей областью — Москвой и областью', async () => {
    const fetchImpl = recordingFetch(() => jsonResponse(HOUSE));
    const client = new PhotonClient({ url: PRIVATE_URL, fetch: fetchImpl.impl });

    await client.search(ADDRESS);

    const requested = new URL(fetchImpl.calls[0] ?? '');
    // Без рамки совпадение названия улицы в другом регионе выдалось бы за наш
    // адрес, и курьер уехал бы в другую область.
    expect(requested.searchParams.get('bbox')).toBe(MOSCOW_REGION_BBOX.join(','));
    expect(requested.searchParams.get('q')).toBe(ADDRESS);
    expect(requested.searchParams.get('limit')).toBe('1');
    expect(requested.searchParams.get('lang')).toBe('ru');
  });

  it('пустой адрес наружу не отправляется', async () => {
    const fetchImpl = recordingFetch(() => jsonResponse(HOUSE));
    const client = new PhotonClient({ url: PRIVATE_URL, fetch: fetchImpl.impl });

    for (const blank of ['', '   ']) {
      await expect(client.search(blank)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('точный дом разбирается в точку', async () => {
    const client = new PhotonClient({
      url: PRIVATE_URL,
      fetch: recordingFetch(() => jsonResponse(HOUSE)).impl,
    });

    // Photon отдаёт GeoJSON: сначала долгота, потом широта. Перепутанный порядок
    // увёз бы курьера в другое полушарие, поэтому он закреплён проверкой.
    await expect(client.search(ADDRESS)).resolves.toEqual({
      lat: 55.751244,
      lon: 37.618423,
      precision: 'HOUSE',
    });
  });

  it('пустой ответ — это «не найдено», а не ошибка', async () => {
    const client = new PhotonClient({
      url: PRIVATE_URL,
      fetch: recordingFetch(() => jsonResponse({ features: [] })).impl,
    });

    // Обычный ответ: заказ попадёт в «Требует внимания», и адрес исправит человек.
    await expect(client.search(ADDRESS)).resolves.toBeNull();
  });

  it('неожиданный формат не превращается в координаты неизвестного качества', async () => {
    for (const body of [
      { features: [{ geometry: { coordinates: ['37.6', '55.7'] }, properties: {} }] },
      { features: [{ geometry: {} , properties: {} }] },
      { features: [{ geometry: { coordinates: [37.6] }, properties: {} }] },
      { results: [] },
      'не json-объект',
    ]) {
      const client = new PhotonClient({
        url: PRIVATE_URL,
        fetch: recordingFetch(() => jsonResponse(body)).impl,
      });
      await expect(client.search(ADDRESS), JSON.stringify(body)).rejects.toMatchObject({
        code: 'BAD_RESPONSE',
      });
    }
  });

  it('коды ответа различают отказ запроса и отказ сервиса', async () => {
    const cases = [
      { status: 400, code: 'BAD_REQUEST' },
      { status: 500, code: 'SERVER_ERROR' },
      { status: 503, code: 'SERVER_ERROR' },
      { status: 404, code: 'SERVER_ERROR' },
    ] as const;

    for (const { status, code } of cases) {
      const client = new PhotonClient({
        url: PRIVATE_URL,
        fetch: recordingFetch(() => new Response('', { status })).impl,
      });
      await expect(client.search(ADDRESS), String(status)).rejects.toMatchObject({ status, code });
    }
  });

  it('сообщение об отказе не содержит ни адреса, ни ответа сервиса', async () => {
    const client = new PhotonClient({
      url: PRIVATE_URL,
      fetch: (async () => {
        // Настоящая ошибка fetch несёт в себе весь URL, то есть и адрес клиента.
        throw new Error(`connect ECONNREFUSED ${PRIVATE_URL}?q=${encodeURIComponent(ADDRESS)}`);
      }) as typeof globalThis.fetch,
    });

    const error = await client.search(ADDRESS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PhotonError);

    const text = `${(error as PhotonError).message} ${String((error as PhotonError).stack)}`;
    expect(text).not.toContain('синтетическая');
    expect(text).not.toContain(encodeURIComponent(ADDRESS));
    expect((error as PhotonError).code).toBe('TRANSPORT_ERROR');
  });

  it('запрос не висит бесконечно: истёкшее ожидание — обычный отказ связи', async () => {
    const client = new PhotonClient({
      url: PRIVATE_URL,
      timeoutMs: 10,
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as typeof globalThis.fetch,
    });

    await expect(client.search(ADDRESS)).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
  });
});
