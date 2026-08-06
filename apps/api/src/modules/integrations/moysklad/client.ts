/**
 * Read-only клиент МоегоСклада.
 *
 * Универсального метода с произвольным HTTP-глаголом здесь нет намеренно:
 * на этом этапе интеграция ничего не изменяет в аккаунте, и возможность
 * отправить POST не должна существовать даже как случайно доступная функция.
 *
 * Лимит аккаунта общий для всех приложений, поэтому темп консервативный:
 * одно обращение одновременно и не чаще одного запроса в секунду. Часы
 * и ожидание инъецируются, чтобы тесты проверяли лимитер без реальных пауз.
 *
 * Наружу не выходит ничего чувствительного: ни токен, ни заголовок
 * Authorization, ни тело ответа, ни адрес запроса с фильтрами. Ошибка содержит
 * только безопасный код, HTTP-статус и очищенное сообщение.
 */

import type { MoyskladConfig } from './config.js';

export type MoyskladErrorCode =
  | 'NOT_CONFIGURED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'TRANSPORT_ERROR'
  | 'BAD_RESPONSE';

/**
 * Ошибка интеграции без подробностей запроса.
 * Сообщение фиксированное: динамический текст от внешнего сервиса мог бы
 * протащить в лог фильтр с персональными данными.
 */
export class MoyskladError extends Error {
  readonly code: MoyskladErrorCode;
  readonly status: number | null;
  /** Сколько миллисекунд ждать до повтора; заполняется только при 429. */
  readonly retryAfterMs: number | null;

  constructor(
    code: MoyskladErrorCode,
    status: number | null = null,
    retryAfterMs: number | null = null,
  ) {
    super(MESSAGES[code]);
    this.name = 'MoyskladError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const MESSAGES: Record<MoyskladErrorCode, string> = {
  NOT_CONFIGURED: 'Интеграция с МоимСкладом не настроена',
  UNAUTHORIZED: 'МойСклад отклонил авторизацию',
  FORBIDDEN: 'У пользователя интеграции нет прав на эту операцию',
  NOT_FOUND: 'Запрошенный объект в МоемСкладе не найден',
  RATE_LIMITED: 'Превышен лимит обращений к МоемуСкладу',
  SERVER_ERROR: 'МойСклад ответил ошибкой',
  TRANSPORT_ERROR: 'Не удалось связаться с МоимСкладом',
  BAD_RESPONSE: 'Ответ МоегоСклада не удалось разобрать',
};

export interface RateLimitSnapshot {
  /** Остаток запросов в текущем интервале лимита. */
  remaining: number | null;
  limit: number | null;
}

export interface MoyskladClientDeps {
  config: MoyskladConfig;
  /** Инъецируется в тестах: реальных сетевых вызовов там нет. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Минимальный интервал между запросами. Консервативный старт — 1 секунда. */
  minIntervalMs?: number;
  timeoutMs?: number;
}

export interface OrderPageQuery {
  limit: number;
  offset?: number;
  /** Готовое выражение фильтра. Пользовательский ввод сюда не попадает. */
  filter?: string;
  order?: string;
}

export interface OrderPage {
  rows: unknown[];
  size: number;
  rateLimit: RateLimitSnapshot;
}

const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 20_000;

export class MoyskladClient {
  private readonly config: MoyskladConfig;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;

  /** Хвост очереди: обращения выстраиваются в цепочку, параллельных нет. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastStartedAt: number | null = null;
  private lastRateLimit: RateLimitSnapshot = { remaining: null, limit: null };

  constructor(deps: MoyskladClientDeps) {
    this.config = deps.config;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get rateLimit(): RateLimitSnapshot {
    return this.lastRateLimit;
  }

  /** Одна страница заказов покупателя. Других операций записи и чтения нет. */
  async listCustomerOrders(query: OrderPageQuery): Promise<OrderPage> {
    const params = new URLSearchParams();
    params.set('limit', String(query.limit));
    if (query.offset !== undefined) {
      params.set('offset', String(query.offset));
    }
    if (query.order !== undefined) {
      params.set('order', query.order);
    }
    if (query.filter !== undefined) {
      params.set('filter', query.filter);
    }

    const body = await this.request(`/entity/customerorder?${params.toString()}`);
    const parsed = body as { rows?: unknown; meta?: { size?: unknown } };

    if (!Array.isArray(parsed.rows)) {
      throw new MoyskladError('BAD_RESPONSE');
    }

    return {
      rows: parsed.rows,
      size: typeof parsed.meta?.size === 'number' ? parsed.meta.size : parsed.rows.length,
      rateLimit: this.lastRateLimit,
    };
  }

  /**
   * Ставит обращение в общую очередь и выдерживает минимальный интервал.
   * Параллельных обращений не бывает: следующий ждёт завершения предыдущего.
   */
  private request(path: string): Promise<unknown> {
    const run = this.queue.then(
      () => this.execute(path),
      () => this.execute(path),
    );
    // Очередь не должна падать целиком из-за одной неудачи.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async execute(path: string): Promise<unknown> {
    const token = this.config.token;
    if (token === null) {
      throw new MoyskladError('NOT_CONFIGURED');
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
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json;charset=utf-8',
          'Accept-Encoding': 'gzip',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Текст сетевой ошибки может содержать адрес запроса с фильтрами.
      throw new MoyskladError('TRANSPORT_ERROR');
    }

    this.lastRateLimit = {
      remaining: numberHeader(response, 'x-ratelimit-remaining'),
      limit: numberHeader(response, 'x-ratelimit-limit'),
    };

    if (response.status === 429) {
      // Повтор здесь не выполняется: паузу выбирает вызывающая сторона,
      // иначе один лимит превратился бы в скрытый цикл повторов.
      throw new MoyskladError('RATE_LIMITED', 429, numberHeader(response, 'x-lognex-retry-after'));
    }

    if (!response.ok) {
      throw new MoyskladError(statusToCode(response.status), response.status);
    }

    try {
      return await response.json();
    } catch {
      throw new MoyskladError('BAD_RESPONSE', response.status);
    }
  }
}

function numberHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function statusToCode(status: number): MoyskladErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 500) return 'SERVER_ERROR';
  return 'BAD_RESPONSE';
}
