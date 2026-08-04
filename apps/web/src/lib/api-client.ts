/**
 * Единый клиент API.
 *
 * Access-токен хранится ТОЛЬКО в памяти этого модуля: ни localStorage,
 * ни sessionStorage, ни IndexedDB, ни URL, ни кэш service worker. Токен, попавший
 * в хранилище, переживает вкладку и достаётся любым скриптом на странице.
 *
 * При ответе 401 выполняется один общий refresh на все параллельные запросы
 * (single-flight) и ровно одна повторная попытка. Бесконечных циклов нет:
 * повтор выполняется без права на ещё один refresh.
 */

import type { Role } from '@fl/shared';

export interface SessionUser {
  id: string;
  phone: string;
  fullName: string;
  roles: Role[];
}

export interface ApiErrorBodyShape {
  error?: { code?: string; message?: string; requestId?: string };
}

/** Ошибка запроса с кодом и понятным текстом от сервера. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Секунды до следующей попытки: заполняется при 429 из заголовка Retry-After. */
  readonly retryAfterSeconds: number | null;

  constructor(status: number, code: string, message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const AUTH_REFRESH_PATH = '/api/auth/refresh';

export interface ApiClientOptions {
  /** Вызывается, когда сессия окончательно потеряна: интерфейс возвращает на вход. */
  onSessionLost?: () => void;
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  /** Токен живёт только здесь. Наружу не отдаётся и никуда не сохраняется. */
  #accessToken: string | null = null;
  #refreshInFlight: Promise<boolean> | null = null;
  readonly #onSessionLost: (() => void) | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.#onSessionLost = options.onSessionLost;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get hasAccessToken(): boolean {
    return this.#accessToken !== null;
  }

  setAccessToken(token: string | null): void {
    this.#accessToken = token;
  }

  /** Полностью очищает память клиента. Вызывается при выходе и потере сессии. */
  clear(): void {
    this.#accessToken = null;
    this.#refreshInFlight = null;
  }

  /**
   * Восстанавливает сессию при запуске приложения.
   * Refresh-токен лежит в httpOnly cookie, поэтому клиент его не видит и не хранит.
   */
  async restoreSession(): Promise<SessionUser | null> {
    const restored = await this.#runRefresh();
    if (!restored) {
      return null;
    }
    try {
      const me = await this.get<{ user: SessionUser }>('/api/auth/me');
      return me.user;
    } catch {
      this.clear();
      return null;
    }
  }

  async get<T>(path: string): Promise<T> {
    return this.#json<T>(path, { method: 'GET' });
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.#json<T>(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.#json<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  /** Вход и активация возвращают access-токен: он сразу кладётся в память. */
  async authenticate<T extends { accessToken: string; user: SessionUser }>(
    path: string,
    body: unknown,
  ): Promise<T> {
    const result = await this.#json<T>(path, { method: 'POST', body: JSON.stringify(body) }, false);
    this.#accessToken = result.accessToken;
    return result;
  }

  async #json<T>(path: string, init: RequestInit, allowRefresh = true): Promise<T> {
    const response = await this.#requestWithRetry(path, init, allowRefresh);

    if (!response.ok) {
      throw await toApiError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  async #requestWithRetry(
    path: string,
    init: RequestInit,
    allowRefresh: boolean,
  ): Promise<Response> {
    const response = await this.#rawRequest(path, init);

    // Обновление сессии не пытается обновить само себя.
    if (response.status !== 401 || !allowRefresh || path === AUTH_REFRESH_PATH) {
      return response;
    }

    const refreshed = await this.#refreshOnce();
    if (!refreshed) {
      this.clear();
      this.#onSessionLost?.();
      return response;
    }

    // Ровно одна повторная попытка: рекурсии и циклов нет.
    return this.#rawRequest(path, init);
  }

  async #rawRequest(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');

    if (init.body !== undefined && init.body !== null) {
      headers.set('Content-Type', 'application/json');
    }
    if (this.#accessToken !== null) {
      headers.set('Authorization', `Bearer ${this.#accessToken}`);
    }

    return this.#fetch(path, {
      ...init,
      headers,
      // Refresh-токен передаётся cookie того же origin.
      credentials: 'same-origin',
      cache: 'no-store',
    });
  }

  /**
   * Один refresh на все параллельные запросы. Без этого десять одновременных 401
   * запустили бы десять ротаций, и все, кроме одной, были бы приняты за повторное
   * использование токена — сервер отозвал бы всю семью сессий.
   */
  #refreshOnce(): Promise<boolean> {
    this.#refreshInFlight ??= this.#runRefresh().finally(() => {
      this.#refreshInFlight = null;
    });
    return this.#refreshInFlight;
  }

  async #runRefresh(): Promise<boolean> {
    try {
      const response = await this.#rawRequest(AUTH_REFRESH_PATH, { method: 'POST' });
      if (!response.ok) {
        return false;
      }
      const body = (await response.json()) as { accessToken?: string };
      if (typeof body.accessToken !== 'string') {
        return false;
      }
      this.#accessToken = body.accessToken;
      return true;
    } catch {
      return false;
    }
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'INTERNAL_ERROR';
  let message = 'Не удалось выполнить запрос.';

  try {
    const body = (await response.json()) as ApiErrorBodyShape;
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // Тело может отсутствовать или быть не JSON — остаются значения по умолчанию.
  }

  return new ApiError(response.status, code, message, parseRetryAfter(response));
}

/** Разбирает Retry-After: сервер присылает его в секундах при блокировке. */
export function parseRetryAfter(response: Pick<Response, 'headers'>): number | null {
  const raw = response.headers.get('Retry-After');
  if (raw === null) {
    return null;
  }
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}
