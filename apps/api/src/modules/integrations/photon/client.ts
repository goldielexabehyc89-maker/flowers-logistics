/**
 * Клиент собственного Photon.
 *
 * Photon — единственный автоматический геокодер новых и изменённых адресов.
 * Он поднимается нами и работает офлайн: наружу уходит только внутренний
 * запрос к своему же контейнеру, а не адрес клиента в чужой платный сервис.
 *
 * ПУБЛИЧНЫЕ СЕРВЕРЫ ЗАПРЕЩЕНЫ. Демонстрационные `photon.komoot.io` и
 * `nominatim.openstreetmap.org` не рассчитаны на рабочую нагрузку, не дают
 * гарантий доступности и увозят адреса клиентов третьей стороне. Запрет
 * проверяется до сети — см. `assertPrivatePhotonUrl`.
 *
 * Ответ разбирается схемой: непроверенное значение наружу не выходит, иначе
 * изменение формата тихо превратилось бы в координаты неизвестного качества.
 */

import { z } from 'zod';

/** Отказ Photon. Код важнее текста: по нему решают, повторять ли запрос. */
export type PhotonErrorCode =
  | 'NOT_CONFIGURED'
  | 'PUBLIC_ENDPOINT_FORBIDDEN'
  | 'BAD_REQUEST'
  | 'SERVER_ERROR'
  | 'TRANSPORT_ERROR'
  | 'BAD_RESPONSE';

const MESSAGES: Record<PhotonErrorCode, string> = {
  NOT_CONFIGURED: 'Геокодер не настроен',
  PUBLIC_ENDPOINT_FORBIDDEN: 'Публичный геокодер запрещён: нужен собственный Photon',
  BAD_REQUEST: 'Photon отклонил запрос',
  SERVER_ERROR: 'Photon ответил ошибкой',
  TRANSPORT_ERROR: 'Не удалось обратиться к Photon',
  BAD_RESPONSE: 'Photon вернул неожиданный ответ',
};

export class PhotonError extends Error {
  readonly code: PhotonErrorCode;
  readonly status: number | null;

  constructor(code: PhotonErrorCode, status: number | null = null) {
    super(MESSAGES[code]);
    this.name = 'PhotonError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Отказ, который сам не пройдёт.
 *
 * Ненастроенный и публичный адрес повторять бессмысленно: это ошибка
 * развёртывания, и её исправляет человек, а не следующая попытка.
 */
export function isPermanentPhotonFailure(code: PhotonErrorCode): boolean {
  return code === 'NOT_CONFIGURED' || code === 'PUBLIC_ENDPOINT_FORBIDDEN';
}

/** Публичные адреса, которые запрещено использовать в рабочем режиме. */
const PUBLIC_HOSTS = [
  'photon.komoot.io',
  'photon.komoot.de',
  'nominatim.openstreetmap.org',
  'nominatim.osm.org',
];

/**
 * Проверяет, что адрес указывает на СВОЙ Photon.
 *
 * Проверка до сети и по имени хоста: публичный сервис не должен получить
 * ни одного адреса клиента даже случайно, из-за забытого значения в
 * конфигурации.
 */
export function assertPrivatePhotonUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PhotonError('NOT_CONFIGURED');
  }

  // Схема проверяется явно. `new URL('photon.internal:2322')` разбирается
  // успешно — как протокол `photon.internal:` с путём `2322`, — и без этой
  // проверки забытая схема выглядела бы работающей настройкой, а имя хоста
  // оказывалось бы пустым: тогда и запрет публичных серверов ничего не сравнил бы.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PhotonError('NOT_CONFIGURED');
  }
  if (url.hostname === '') {
    throw new PhotonError('NOT_CONFIGURED');
  }

  if (PUBLIC_HOSTS.includes(url.hostname.toLowerCase())) {
    throw new PhotonError('PUBLIC_ENDPOINT_FORBIDDEN');
  }
  return url;
}

/**
 * Ответ Photon в формате GeoJSON.
 *
 * Берутся только те поля, на которые мы опираемся. Остальное игнорируется
 * намеренно: чем меньше зависимость от чужого формата, тем меньше поводов
 * сломаться при его изменении.
 */
const featureSchema = z.object({
  geometry: z.object({
    coordinates: z.tuple([z.number(), z.number()]),
  }),
  properties: z
    .object({
      osm_key: z.string().optional(),
      osm_value: z.string().optional(),
      type: z.string().optional(),
      // Поля, по которым ответ сверяется с исходным адресом. Без них
      // «Photon вернул дом» — это утверждение без доказательства.
      housenumber: z.string().optional(),
      street: z.string().optional(),
      name: z.string().optional(),
      city: z.string().optional(),
      district: z.string().optional(),
      locality: z.string().optional(),
      county: z.string().optional(),
      state: z.string().optional(),
      postcode: z.string().optional(),
      countrycode: z.string().optional(),
      country: z.string().optional(),
    })
    .default({}),
});

const responseSchema = z.object({ features: z.array(featureSchema) });

export type PhotonFeature = z.infer<typeof featureSchema>;

/** Насколько точно Photon привязал адрес. */
export type PhotonPrecision = 'HOUSE' | 'STREET' | 'AREA';

/**
 * Точность привязки.
 *
 * В маршрут без проверки человеком допускается только дом: улица и район
 * означают «где-то там», а курьер едет по конкретному адресу. Признаком дома
 * считается номер дома в ответе либо тип объекта `house`/`building` — Photon
 * сообщает и то, и другое, и полагаться на одно поле ненадёжно.
 */
export function precisionOf(feature: PhotonFeature): PhotonPrecision {
  const { housenumber, osm_key: key, osm_value: value, type, street } = feature.properties;

  if (housenumber !== undefined && housenumber.trim() !== '') {
    return 'HOUSE';
  }
  if (type === 'house' || value === 'house' || value === 'building' || key === 'building') {
    return 'HOUSE';
  }
  if (street !== undefined && street.trim() !== '') {
    return 'STREET';
  }
  return 'AREA';
}

/**
 * Что Photon рассказал о найденном месте.
 *
 * Возвращается наружу целиком, потому что решение «принимать ли точку» нельзя
 * принять по одной лишь точности: дом с подходящим номером может оказаться
 * в другом городе. Сверку выполняет `verifyPhotonMatch`.
 */
export interface PhotonPlace {
  housenumber?: string | undefined;
  street?: string | undefined;
  name?: string | undefined;
  city?: string | undefined;
  district?: string | undefined;
  locality?: string | undefined;
  county?: string | undefined;
  state?: string | undefined;
  postcode?: string | undefined;
  countrycode?: string | undefined;
  country?: string | undefined;
}

export interface PhotonAnswer {
  lat: number;
  lon: number;
  precision: PhotonPrecision;
  /** Описание найденного места. Нужно, чтобы сверить ответ с запросом. */
  place: PhotonPlace;
}

export interface PhotonClientDeps {
  /** Адрес собственного Photon. Пусто — геокодер просто не настроен. */
  url: string | null;
  /** Инъецируется в тестах: настоящих сетевых обращений там нет. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /**
   * Рабочая область поиска.
   *
   * Индекс собран по Москве и области, и запрос ограничивается той же рамкой:
   * совпадение названия улицы в другом регионе не должно выдаваться за наш
   * адрес (`docs/OWNER_DECISIONS.md`, решение о рабочей области Photon).
   */
  bbox?: readonly [number, number, number, number];
}

const DEFAULT_TIMEOUT_MS = 5000;
/** Москва и Московская область с запасом: minLon, minLat, maxLon, maxLat. */
export const MOSCOW_REGION_BBOX = [35.1, 54.2, 40.3, 56.96] as const;

export class PhotonClient {
  private readonly url: URL | null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly bbox: readonly [number, number, number, number];

  constructor(deps: PhotonClientDeps) {
    this.url = deps.url === null || deps.url === '' ? null : assertPrivatePhotonUrl(deps.url);
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.bbox = deps.bbox ?? MOSCOW_REGION_BBOX;
  }

  get configured(): boolean {
    return this.url !== null;
  }

  /**
   * Ищет адрес и возвращает лучший вариант.
   *
   * `null` — Photon ничего не нашёл. Это обычный ответ, а не ошибка: заказ
   * попадёт в «Требует внимания», и адрес исправит человек.
   */
  async search(address: string): Promise<PhotonAnswer | null> {
    if (this.url === null) {
      throw new PhotonError('NOT_CONFIGURED');
    }
    const query = address.trim();
    if (query === '') {
      throw new PhotonError('BAD_REQUEST');
    }

    const target = new URL(this.url.toString());
    target.searchParams.set('q', query);
    target.searchParams.set('limit', '1');
    target.searchParams.set('lang', 'ru');
    target.searchParams.set('bbox', this.bbox.join(','));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(target.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch {
      // Текст ошибки наружу не идёт: он может содержать сам запрос, то есть адрес.
      throw new PhotonError('TRANSPORT_ERROR');
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 400) {
      throw new PhotonError('BAD_REQUEST', response.status);
    }
    if (!response.ok) {
      throw new PhotonError('SERVER_ERROR', response.status);
    }

    let parsed: z.infer<typeof responseSchema>;
    try {
      parsed = responseSchema.parse(await response.json());
    } catch {
      throw new PhotonError('BAD_RESPONSE', response.status);
    }

    const feature = parsed.features[0];
    if (feature === undefined) {
      return null;
    }

    const [lon, lat] = feature.geometry.coordinates;
    const {
      housenumber,
      street,
      name,
      city,
      district,
      locality,
      county,
      state,
      postcode,
      countrycode,
      country,
    } = feature.properties;

    return {
      lat,
      lon,
      precision: precisionOf(feature),
      place: {
        housenumber,
        street,
        name,
        city,
        district,
        locality,
        county,
        state,
        postcode,
        countrycode,
        country,
      },
    };
  }
}
