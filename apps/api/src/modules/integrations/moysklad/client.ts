/**
 * Read-only клиент МоегоСклада.
 *
 * Единственная сетевая граница — `send`. Все обращения проходят через неё,
 * и другого места, где вызывается `fetch`, в клиенте нет.
 *
 * Проверка метода БЕЗУСЛОВНА и не настраивается: ни одно окружение и ни одно
 * значение конфигурации не может довести до `fetch` метод, отличный от `GET`
 * и `HEAD`. Запись в живой аккаунт вводится отдельным заданием — узкой
 * именованной операцией с идемпотентностью и аудитом, а не заранее открытым
 * универсальным глаголом (`FUL-006`).
 *
 * Отсутствие публичной операции записи защитой само по себе не считается:
 * договорённость «мы не будем это вызывать» проверить нельзя, а проверку
 * метода — можно (`ENV-004`). Поэтому `send` остаётся видимым, но при любом
 * запрещённом методе отвечает `METHOD_NOT_ALLOWED` и нулём сетевых вызовов:
 * произвольный `POST path` продуктовым API клиента не является ни при каких
 * настройках.
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
import { moyskladOrderSchema, type MoyskladOrderDto } from './dto.js';
import {
  bundleComponentsPageSchema,
  orderPositionsPageSchema,
  type MoyskladBundleComponentDto,
  type MoyskladOrderPositionDto,
} from './composition-dto.js';

export type MoyskladErrorCode =
  | 'NOT_CONFIGURED'
  | 'METHOD_NOT_ALLOWED'
  | 'INVALID_QUERY'
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
  METHOD_NOT_ALLOWED: 'Контур МоегоСклада работает только на чтение',
  INVALID_QUERY: 'Некорректные параметры запроса к МоемуСкладу',
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
  /**
   * Запрашивать ли состав заказа вместе со страницей (`expand=positions.assortment`).
   *
   * Поле ОБЯЗАТЕЛЬНОЕ, а не необязательное с умолчанием. Умолчание позволило бы
   * новому вызывающему коду молча импортировать заказы без состава: заказ
   * сохранился бы, состав остался бы неподтверждённым, и заметить это было бы
   * некому. Обязательное поле заставляет каждый путь ответить на вопрос явно.
   */
  withPositions: boolean;
}

export interface OrderPage {
  /** Проверенные заказы. Непроверенный ответ наружу не выходит. */
  rows: MoyskladOrderDto[];
  size: number;
  rateLimit: RateLimitSnapshot;
}

/** Полностью прочитанная коллекция: число строк доказанно равно `meta.size`. */
export interface CollectionPage<T> {
  rows: T[];
  size: number;
  rateLimit: RateLimitSnapshot;
}

/**
 * Предел размера страницы при развёрнутых полях.
 *
 * Клиент всегда запрашивает как минимум `expand=state`, поэтому больший `limit`
 * недопустим. Проверка выполняется ДО сетевого обращения.
 *
 * Важно, ПОЧЕМУ именно так. Раньше здесь было написано, что API отвергает
 * больший `limit`. Живое наблюдение (`docs/MOYSKLAD_MAPPING.md` §13б) показало
 * обратное и худшее: при `limit` больше 100 МойСклад отвечает `200`, но молча
 * перестаёт разворачивать связанные данные — состав приходит пустым и выглядит
 * как настоящий пустой состав. Отказ был бы безопаснее молчания, поэтому
 * границу держит наша проверка, а импорт состава дополнительно доказывает
 * его полноту по `meta.size`.
 */
export const MAX_EXPANDED_PAGE_SIZE = 100;

/**
 * Политика чтения: точное сравнение вместо изменяемого списка.
 *
 * Экспортированный массив можно было бы дополнить во время исполнения — из
 * другого модуля, теста или случайной строки кода, — и политика перестала бы
 * быть политикой. Прямое сравнение изменить нельзя.
 *
 * `HEAD` разрешён намеренно: он отличается от `GET` только отсутствием тела
 * и ничего не изменяет. Сравнение регистрозависимое: «post» в нижнем регистре
 * известным методом не является и отвергается.
 */
export function isReadOnlyMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
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

  /**
   * Одна страница заказов покупателя. Других операций записи и чтения нет.
   *
   * Статус всегда запрашивается развёрнутым: без `expand=state` приходит только
   * ссылка, и `stateType` навсегда остался бы пустым.
   *
   * Каждая строка проверяется схемой. Непроверенный ответ наружу не выходит:
   * иначе изменение чужого API тихо превратилось бы в испорченные данные заказа.
   */
  async listCustomerOrders(query: OrderPageQuery): Promise<OrderPage> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_EXPANDED_PAGE_SIZE) {
      throw new MoyskladError('INVALID_QUERY');
    }

    // Значения собираются обычными строками и кодируются один раз здесь.
    // Ручное кодирование частей дало бы двойное кодирование, и фильтр по href
    // перестал бы совпадать с идентификатором на стороне МоегоСклада.
    const params = new URLSearchParams();
    params.set('limit', String(query.limit));
    // Состав запрашивается вложенным: отдельный GET на каждый заказ стоил бы
    // тысячу лишних обращений на полной загрузке при темпе один запрос в секунду.
    // Полноту вложенного состава доказывает потребитель по `positions.meta.size`.
    params.set('expand', query.withPositions ? 'state,positions.assortment' : 'state');
    if (query.offset !== undefined) {
      params.set('offset', String(query.offset));
    }
    if (query.order !== undefined) {
      params.set('order', query.order);
    }
    if (query.filter !== undefined) {
      params.set('filter', query.filter);
    }

    const body = await this.send('GET', `/entity/customerorder?${params.toString()}`);
    const parsed = body as { rows?: unknown; meta?: { size?: unknown } };

    if (!Array.isArray(parsed.rows)) {
      throw new MoyskladError('BAD_RESPONSE');
    }

    const rows: MoyskladOrderDto[] = [];
    for (const row of parsed.rows) {
      const result = moyskladOrderSchema.safeParse(row);
      if (!result.success) {
        // Текст ошибки zod содержит фактические значения полей, то есть PII.
        // Наружу уходит только безопасный код.
        throw new MoyskladError('BAD_RESPONSE');
      }
      rows.push(result.data);
    }

    return {
      rows,
      size: typeof parsed.meta?.size === 'number' ? parsed.meta.size : rows.length,
      rateLimit: this.lastRateLimit,
    };
  }

  /**
   * Позиции одного заказа — резервный путь.
   *
   * Основной путь — состав, развёрнутый вместе со страницей заказов. Этот метод
   * нужен там, где вложенный состав не пришёл или пришёл неполным, и для заказов
   * с числом позиций больше вложенного предела.
   *
   * Страницы читаются последовательно до `meta.size`. Пустая страница раньше
   * этого — ошибка, а не повод остановиться: молчаливо принятая половина состава
   * неотличима от полного состава.
   */
  async listOrderPositions(orderId: string): Promise<CollectionPage<MoyskladOrderPositionDto>> {
    return this.readCollection(
      `/entity/customerorder/${orderId}/positions`,
      orderPositionsPageSchema,
    );
  }

  /**
   * Компоненты комплекта.
   *
   * Правило полноты то же самое: неполный список компонентов превратил бы букет
   * в неверную инструкцию по сборке, причём выглядящую достоверно.
   */
  async listBundleComponents(
    bundleId: string,
  ): Promise<CollectionPage<MoyskladBundleComponentDto>> {
    return this.readCollection(`/entity/bundle/${bundleId}/components`, bundleComponentsPageSchema);
  }

  /**
   * Последовательное чтение коллекции с доказательством полноты.
   *
   * Один ответ полным не считается: `meta.size` сравнивается с фактически
   * собранным числом строк, и расхождение — ошибка.
   */
  private async readCollection<T>(
    path: string,
    schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } },
  ): Promise<CollectionPage<T>> {
    const rows: T[] = [];
    let offset = 0;
    let size: number | null = null;

    for (;;) {
      const params = new URLSearchParams();
      params.set('limit', String(MAX_EXPANDED_PAGE_SIZE));
      params.set('offset', String(offset));
      params.set('expand', 'assortment');

      const body = await this.send('GET', `${path}?${params.toString()}`);
      const parsed = schema.safeParse(body);
      if (!parsed.success || parsed.data === undefined) {
        // Текст ошибки zod содержит фактические значения полей, то есть данные
        // заказа. Наружу уходит только безопасный код.
        throw new MoyskladError('BAD_RESPONSE');
      }

      const page = parsed.data as { rows: T[]; meta: { size: number } };
      size ??= page.meta.size;
      rows.push(...page.rows);

      if (rows.length >= size) {
        break;
      }
      if (page.rows.length === 0) {
        // Строк меньше обещанного, но новых больше не дают: продолжать —
        // бесконечный цикл, принять — молча потерять часть состава.
        throw new MoyskladError('BAD_RESPONSE');
      }
      offset += page.rows.length;
    }

    if (rows.length !== size) {
      throw new MoyskladError('BAD_RESPONSE');
    }

    return { rows, size, rateLimit: this.lastRateLimit };
  }

  /**
   * Единственная сетевая граница клиента.
   *
   * Проверка метода выполняется ДО постановки в очередь и до любого обращения
   * к сети: запрещённый глагол не тратит ни лимит аккаунта, ни место в очереди.
   */
  async send(method: string, path: string): Promise<unknown> {
    if (!isReadOnlyMethod(method)) {
      throw new MoyskladError('METHOD_NOT_ALLOWED');
    }
    return this.request(method, path);
  }

  /**
   * Ставит обращение в общую очередь и выдерживает минимальный интервал.
   * Параллельных обращений не бывает: следующий ждёт завершения предыдущего.
   */
  private request(method: string, path: string): Promise<unknown> {
    const run = this.queue.then(
      () => this.execute(method, path),
      () => this.execute(method, path),
    );
    // Очередь не должна падать целиком из-за одной неудачи.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async execute(method: string, path: string): Promise<unknown> {
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
        method,
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
