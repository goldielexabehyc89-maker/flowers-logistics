/**
 * Клиент стандартизации адресов DaData.
 *
 * Используется единственный официальный метод — `POST /api/v1/clean/address`
 * сервиса стандартизации. Тело запроса — массив ровно из одного адреса:
 * пакетная отправка нескольких адресов не применяется намеренно, потому что
 * ответ пришлось бы сопоставлять с заказами по позиции в массиве, а ошибка
 * в сопоставлении означала бы координаты одного клиента у заказа другого.
 *
 * Официальный предел — 20 запросов в секунду и 60 новых соединений в минуту.
 * Наш темп заведомо строже: одно обращение одновременно и не чаще одного
 * запроса в секунду. Начинать у платного сервиса с предельной нагрузки незачем.
 *
 * Скрытых повторов здесь нет. Клиент один раз выполняет запрос и возвращает
 * либо результат, либо ошибку с кодом; повторяет только очередь, которая
 * умеет считать попытки, ждать и в конце концов сдаться.
 *
 * Наружу не выходит ничего чувствительного: ни ключи, ни заголовки, ни адрес,
 * ни тело ответа. Ошибка содержит только безопасный код и HTTP-статус.
 */

import { dadataAddressSchema, type DadataAddress } from './dto.js';

export const DADATA_CLEAN_ADDRESS_URL = 'https://cleaner.dadata.ru/api/v1/clean/address';

export type DadataErrorCode =
  | 'NOT_CONFIGURED'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'TRANSPORT_ERROR'
  | 'BAD_RESPONSE';

const MESSAGES: Record<DadataErrorCode, string> = {
  NOT_CONFIGURED: 'Геокодирование не настроено',
  BAD_REQUEST: 'DaData отклонила запрос',
  UNAUTHORIZED: 'DaData отклонила авторизацию',
  FORBIDDEN: 'У ключа DaData нет прав на этот метод либо исчерпан баланс',
  RATE_LIMITED: 'Превышен лимит обращений к DaData',
  SERVER_ERROR: 'DaData ответила ошибкой',
  TRANSPORT_ERROR: 'Не удалось связаться с DaData',
  BAD_RESPONSE: 'Ответ DaData не удалось разобрать',
};

/**
 * Ошибка провайдера без подробностей запроса.
 *
 * Текст фиксирован: динамическое сообщение внешнего сервиса могло бы протащить
 * в лог отправленный адрес.
 */
export class DadataError extends Error {
  readonly code: DadataErrorCode;
  readonly status: number | null;
  /** Сколько миллисекунд ждать до повтора. Заполняется по Retry-After при 429. */
  readonly retryAfterMs: number | null;

  constructor(
    code: DadataErrorCode,
    status: number | null = null,
    retryAfterMs: number | null = null,
  ) {
    super(MESSAGES[code]);
    this.name = 'DadataError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Отказ провайдера, который сам не пройдёт: нужен человек, а не повтор. */
export function isPermanentDadataFailure(code: DadataErrorCode): boolean {
  return code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'NOT_CONFIGURED';
}

export interface DadataCredentials {
  apiKey: string | null;
  secretKey: string | null;
}

export interface DadataClientDeps {
  credentials: DadataCredentials;
  /** Инъецируется в тестах: настоящих сетевых вызовов там нет. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Минимальный интервал между обращениями. Консервативный старт — 1 секунда. */
  minIntervalMs?: number;
  timeoutMs?: number;
  url?: string;
}

const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
/** Верхняя граница ожидания по Retry-After: сервис не должен усыпить очередь навсегда. */
export const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

export class DadataClient {
  private readonly credentials: DadataCredentials;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly url: string;

  /** Хвост очереди: обращения выстраиваются в цепочку, параллельных не бывает. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastStartedAt: number | null = null;

  constructor(deps: DadataClientDeps) {
    this.credentials = deps.credentials;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.url = deps.url ?? DADATA_CLEAN_ADDRESS_URL;
  }

  get configured(): boolean {
    return this.credentials.apiKey !== null && this.credentials.secretKey !== null;
  }

  /**
   * Стандартизует один адрес и возвращает проверенный результат.
   *
   * Ответ проверяется схемой: непроверенное значение наружу не выходит, иначе
   * изменение чужого API тихо превратилось бы в координаты неизвестного качества.
   */
  async cleanAddress(address: string): Promise<DadataAddress> {
    const run = this.queue.then(
      () => this.execute(address),
      () => this.execute(address),
    );
    // Одна неудача не должна ронять очередь целиком.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async execute(address: string): Promise<DadataAddress> {
    const { apiKey, secretKey } = this.credentials;
    if (apiKey === null || secretKey === null) {
      throw new DadataError('NOT_CONFIGURED');
    }

    if (this.lastStartedAt !== null) {
      const wait = this.minIntervalMs - (this.now() - this.lastStartedAt);
      if (wait > 0) {
        await this.sleep(wait);
      }
    }
    this.lastStartedAt = this.now();

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Token ${apiKey}`,
          'X-Secret': secretKey,
        },
        // Массив ровно из одного адреса — требование метода стандартизации.
        body: JSON.stringify([address]),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Текст сетевой ошибки может содержать адрес запроса и тело.
      throw new DadataError('TRANSPORT_ERROR');
    }

    if (response.status === 429) {
      throw new DadataError(
        'RATE_LIMITED',
        429,
        parseRetryAfter(response.headers.get('retry-after'), this.now()),
      );
    }

    if (!response.ok) {
      throw new DadataError(statusToCode(response.status), response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new DadataError('BAD_RESPONSE', response.status);
    }

    if (!Array.isArray(body) || body.length !== 1) {
      // Метод обязан вернуть ровно один результат на один отправленный адрес.
      // Иное количество означает, что сопоставить ответ с заказом нельзя.
      throw new DadataError('BAD_RESPONSE', response.status);
    }

    const parsed = dadataAddressSchema.safeParse(body[0]);
    if (!parsed.success) {
      // Текст ошибки zod содержит фактические значения полей, то есть адрес.
      throw new DadataError('BAD_RESPONSE', response.status);
    }

    return parsed.data;
  }
}

/**
 * Разбирает `Retry-After`.
 *
 * Поддерживаются обе официальные формы: количество секунд и абсолютная дата.
 * Значение ограничивается сверху: сервис не должен усыпить очередь на сутки.
 */
export function parseRetryAfter(raw: string | null, now: number): number | null {
  if (raw === null) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return null;
  }
  return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS);
}

function statusToCode(status: number): DadataErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status >= 500) return 'SERVER_ERROR';
  return 'BAD_REQUEST';
}
