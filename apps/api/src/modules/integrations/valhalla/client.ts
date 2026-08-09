/**
 * Клиент собственной Valhalla.
 *
 * Сервис поднят рядом, внутри сети Compose, и наружу не публикуется. Его адрес
 * задаётся только серверной конфигурацией и никогда не попадает в браузер:
 * маршрутизатор, доступный из интернета, — это чужой бесплатный вычислитель
 * и заодно способ узнать, куда мы возим.
 *
 * В Valhalla уходят ТОЛЬКО координаты. Ни адреса, ни получателя, ни номера
 * заказа, ни комментария: маршрутизатору они не нужны, а попав в чужой лог,
 * они остались бы там навсегда.
 *
 * Скрытых повторов здесь нет. Клиент выполняет один запрос и возвращает либо
 * проверенный ответ, либо ошибку с кодом; повторяет вызывающая сторона,
 * которая умеет считать попытки и в конце концов сдаться.
 *
 * Используется официальный контракт `sources_to_targets`: строчно-упорядоченная
 * матрица, время в секундах, расстояние в запрошенных единицах. Единицы
 * задаются явно — умолчание сервиса могло бы измениться вместе с его версией.
 */

import { z } from 'zod';

export type ValhallaErrorCode =
  | 'NOT_CONFIGURED'
  | 'BAD_REQUEST'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'TRANSPORT_ERROR'
  | 'BAD_RESPONSE';

const MESSAGES: Record<ValhallaErrorCode, string> = {
  NOT_CONFIGURED: 'Расчёт маршрутов не настроен',
  BAD_REQUEST: 'Маршрутизатор отклонил запрос',
  RATE_LIMITED: 'Превышен лимит обращений к маршрутизатору',
  SERVER_ERROR: 'Маршрутизатор ответил ошибкой',
  TRANSPORT_ERROR: 'Не удалось связаться с маршрутизатором',
  BAD_RESPONSE: 'Ответ маршрутизатора не удалось разобрать',
};

/**
 * Ошибка маршрутизатора без подробностей запроса.
 *
 * Текст фиксирован: сообщение внешнего сервиса могло бы протащить в лог
 * координаты из тела запроса.
 */
export class ValhallaError extends Error {
  readonly code: ValhallaErrorCode;
  readonly status: number | null;

  constructor(code: ValhallaErrorCode, status: number | null = null) {
    super(MESSAGES[code]);
    this.name = 'ValhallaError';
    this.code = code;
    this.status = status;
  }
}

/** Профили Valhalla, которыми мы пользуемся. Другие не включаются. */
export const COSTING = { CAR: 'auto', FOOT: 'pedestrian' } as const;
export type Costing = (typeof COSTING)[keyof typeof COSTING];

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Элемент строки матрицы.
 *
 * `time` и `distance` равны `null`, когда пара недостижима. Ноль недопустим
 * как замена: он означает «точки совпадают», и подмена одного другим однажды
 * отправила бы курьера по маршруту, которого не существует.
 */
const elementSchema = z.object({
  from_index: z.number().int().min(0),
  to_index: z.number().int().min(0),
  time: z.number().nullable().optional(),
  distance: z.number().nullable().optional(),
});

/**
 * Официальный ответ: строчно-упорядоченная матрица.
 *
 * Принимается и вложенная форма (массив строк), и плоская: обе встречаются
 * в разных версиях сервиса, но обе несут одни и те же элементы с явными
 * `from_index` и `to_index`. Именно по индексам матрица и собирается —
 * полагаться на порядок элементов было бы неоправданным доверием.
 */
const matrixResponseSchema = z.object({
  sources_to_targets: z.union([z.array(z.array(elementSchema)), z.array(elementSchema)]),
  units: z.string().optional(),
});

const statusSchema = z.object({
  version: z.string().min(1),
  /** Unix-время последней сборки набора тайлов. Служит ревизией графа. */
  tileset_last_modified: z.number().int().min(0).optional(),
});

export interface ValhallaStatus {
  version: string;
  tilesetLastModified: number | null;
}

export interface MatrixElement {
  /** Секунды. `null` — пара недостижима. */
  timeSeconds: number | null;
  /** Метры. `null` — пара недостижима. */
  distanceMeters: number | null;
}

export interface ValhallaClientDeps {
  /** Базовый адрес сервиса. `null` — расчёт не настроен. */
  baseUrl: string | null;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** Километры в ответе Valhalla переводятся в целые метры один раз и здесь. */
const METERS_IN_KM = 1000;

export class ValhallaClient {
  private readonly baseUrl: string | null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(deps: ValhallaClientDeps) {
    this.baseUrl = deps.baseUrl === null ? null : deps.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get configured(): boolean {
    return this.baseUrl !== null;
  }

  /** Состояние сервиса и ревизия набора тайлов. */
  async status(): Promise<ValhallaStatus> {
    const body = await this.request('/status', { method: 'GET' });
    const parsed = statusSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValhallaError('BAD_RESPONSE');
    }
    return {
      version: parsed.data.version,
      tilesetLastModified: parsed.data.tileset_last_modified ?? null,
    };
  }

  /**
   * Матрица времени и расстояния между точками.
   *
   * Квадратная: каждая точка выступает и источником, и целью. Симметричной
   * она при этом не является — односторонние улицы и развороты делают путь
   * «туда» и «обратно» разным, и считать половину матрицы нельзя.
   */
  async matrix(points: readonly LatLon[], costing: Costing): Promise<(MatrixElement | null)[][]> {
    const locations = points.map((point) => ({ lat: point.lat, lon: point.lon }));

    const body = await this.request('/sources_to_targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sources: locations,
        targets: locations,
        costing,
        // Единицы задаются явно: умолчание сервиса может измениться с версией,
        // а километры, принятые за метры, дали бы ошибку в тысячу раз.
        units: 'km',
      }),
    });

    const parsed = matrixResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValhallaError('BAD_RESPONSE');
    }

    const flat = parsed.data.sources_to_targets.flat();
    const size = points.length;
    const result: (MatrixElement | null)[][] = Array.from({ length: size }, () =>
      Array.from<MatrixElement | null>({ length: size }).fill(null),
    );

    let filled = 0;
    for (const element of flat) {
      if (element.from_index >= size || element.to_index >= size) {
        throw new ValhallaError('BAD_RESPONSE');
      }

      const row = result[element.from_index];
      if (row === undefined) {
        throw new ValhallaError('BAD_RESPONSE');
      }

      row[element.to_index] = {
        timeSeconds: toSeconds(element.time),
        distanceMeters: toMeters(element.distance),
      };
      filled += 1;
    }

    // Ответ обязан покрыть матрицу целиком. Недостающая пара — это не «ноль»
    // и не «недостижимо», а неизвестность, выдавать которую за результат нельзя.
    if (filled !== size * size) {
      throw new ValhallaError('BAD_RESPONSE');
    }

    return result;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    if (this.baseUrl === null) {
      throw new ValhallaError('NOT_CONFIGURED');
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Текст сетевой ошибки содержит адрес и может содержать тело запроса.
      throw new ValhallaError('TRANSPORT_ERROR');
    }

    if (response.status === 429) {
      throw new ValhallaError('RATE_LIMITED', 429);
    }
    if (!response.ok) {
      throw new ValhallaError(
        response.status >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST',
        response.status,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new ValhallaError('BAD_RESPONSE', response.status);
    }
  }
}

/**
 * Секунды из ответа.
 *
 * Отрицательное, бесконечное и нечисловое значение — не время в пути.
 * Такой ответ разбирать нельзя: он означает, что сервис вернул что-то другое.
 */
function toSeconds(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new ValhallaError('BAD_RESPONSE');
  }
  return Math.round(value);
}

/** Километры ответа в целые метры. Дробные метры для доставки бессмысленны. */
function toMeters(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new ValhallaError('BAD_RESPONSE');
  }
  return Math.round(value * METERS_IN_KM);
}
