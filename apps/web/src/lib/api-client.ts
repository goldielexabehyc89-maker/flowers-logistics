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
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    conflict?: { kind: string; routeNumber?: string; orderIds?: string[] };
  };
}

/** Ошибка запроса с кодом и понятным текстом от сервера. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Секунды до следующей попытки: заполняется при 429 из заголовка Retry-After. */
  readonly retryAfterSeconds: number | null;
  /**
   * Машинная причина конфликта. Общего кода `CONFLICT` интерфейсу мало: устаревшую
   * версию достаточно перезапросить, а занятый чужой маршрут требует другого текста
   * и другой кнопки. Разбирать ради этого сообщение для человека нельзя.
   */
  readonly conflict: { kind: string; routeNumber?: string; orderIds?: string[] } | null;

  constructor(
    status: number,
    code: string,
    message: string,
    retryAfterSeconds: number | null,
    conflict: { kind: string; routeNumber?: string; orderIds?: string[] } | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.conflict = conflict;
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
  /**
   * Счётчик поколений токена. Запрос запоминает поколение в момент отправки:
   * если к моменту его 401 токен уже успел обновиться другим запросом,
   * второй refresh не нужен — достаточно повторить запрос с новым токеном.
   */
  #tokenGeneration = 0;
  #refreshInFlight: Promise<boolean> | null = null;
  /** Сессия теряется один раз: интерфейс не должен получать несколько уведомлений. */
  #sessionLostNotified = false;
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
    this.#tokenGeneration += 1;
    if (token !== null) {
      // Появился рабочий токен — значит сессия снова жива.
      this.#sessionLostNotified = false;
    }
  }

  /** Полностью очищает память клиента. Вызывается при выходе и потере сессии. */
  clear(): void {
    this.#accessToken = null;
    this.#tokenGeneration += 1;
    this.#refreshInFlight = null;
  }

  /**
   * Сессия окончательно потеряна: память очищается, интерфейс возвращает на вход.
   * Уведомление отправляется ровно один раз, сколько бы запросов ни завершилось 401.
   */
  #loseSession(): void {
    this.clear();
    if (this.#sessionLostNotified) {
      return;
    }
    this.#sessionLostNotified = true;
    this.#onSessionLost?.();
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

  /** PUT используется там, где значение задаётся целиком и заменяет предыдущее. */
  async put<T>(path: string, body: unknown): Promise<T> {
    return this.#json<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  }

  /**
   * Открывает поток событий.
   *
   * Нативный EventSource не используется: он не позволяет передать заголовок
   * Authorization, а токен в URL попал бы в логи прокси и историю браузера.
   * При 401 выполняется тот же single-flight refresh, что и для обычных запросов.
   */
  async openEventStream(
    path: string,
    lastEventId: string | null,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (lastEventId !== null) {
      headers['Last-Event-ID'] = lastEventId;
    }

    const response = await this.#requestWithRetry(path, { method: 'GET', headers, signal }, true);

    if (!response.ok) {
      throw await toApiError(response);
    }

    return response;
  }

  /** Вход и активация возвращают access-токен: он сразу кладётся в память. */
  async authenticate<T extends { accessToken: string; user: SessionUser }>(
    path: string,
    body: unknown,
  ): Promise<T> {
    const result = await this.#json<T>(path, { method: 'POST', body: JSON.stringify(body) }, false);
    this.setAccessToken(result.accessToken);
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
    const generationAtSend = this.#tokenGeneration;
    const response = await this.#rawRequest(path, init);

    // Обновление сессии не пытается обновить само себя.
    if (response.status !== 401 || !allowRefresh || path === AUTH_REFRESH_PATH) {
      return response;
    }

    // Запрос ушёл со старым токеном, но пока он выполнялся, токен уже обновил
    // другой запрос. Второй refresh не нужен: достаточно повторить запрос.
    if (this.#tokenGeneration !== generationAtSend) {
      return this.#retryOnce(path, init);
    }

    const refreshed = await this.#refreshOnce();
    if (!refreshed) {
      this.#loseSession();
      return response;
    }

    return this.#retryOnce(path, init);
  }

  /**
   * Ровно одна повторная попытка. Если и она отвечает 401, сессия считается
   * потерянной: иначе пользователь остался бы внутри приложения с мёртвым токеном,
   * а каждый следующий запрос снова запускал бы обновление.
   */
  async #retryOnce(path: string, init: RequestInit): Promise<Response> {
    const retried = await this.#rawRequest(path, init);
    if (retried.status === 401) {
      this.#loseSession();
    }
    return retried;
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
      this.setAccessToken(body.accessToken);
      return true;
    } catch {
      return false;
    }
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'INTERNAL_ERROR';
  let message = 'Не удалось выполнить запрос.';
  let conflict: { kind: string; routeNumber?: string; orderIds?: string[] } | null = null;

  try {
    const body = (await response.json()) as ApiErrorBodyShape;
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
    conflict = body.error?.conflict ?? null;
  } catch {
    // Тело может отсутствовать или быть не JSON — остаются значения по умолчанию.
  }

  return new ApiError(response.status, code, message, parseRetryAfter(response), conflict);
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
