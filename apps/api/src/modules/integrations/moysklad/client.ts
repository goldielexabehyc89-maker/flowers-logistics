/**
 * Клиент МоегоСклада: чтение и РОВНО ОДНА названная операция записи.
 *
 * Единственная сетевая граница — `execute`. Другого места, где вызывается
 * `fetch`, в клиенте нет.
 *
 * Универсальной записи по-прежнему не существует. `send` остаётся строго
 * read-only и при любом другом методе отвечает `METHOD_NOT_ALLOWED` с нулём
 * сетевых вызовов: произвольный `POST path` продуктовым API клиента не
 * является ни при каких настройках (`FUL-006`, `ENV-004`).
 *
 * Запись введена так, как это и было условлено: узкой именованной операцией
 * `cancelCustomerOrder` с идемпотентностью и аудитом на стороне вызывающего.
 * У неё два независимых замка, и оба проверяются ДО сети:
 *
 * 1. `writesAllowed` — разрешение окружения. Оно берётся из
 *    `MOYSKLAD_READ_ONLY`: при `true` операция отвечает `WRITE_FORBIDDEN`
 *    и не выполняет ни одного обращения;
 * 2. отсутствие токена — `NOT_CONFIGURED`.
 *
 * Проверка «а вдруг кто-то передаст сюда PUT» не нужна: метод и путь у этой
 * операции зашиты в коде и снаружи не задаются.
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
  assortmentImagesPageSchema,
  bundleComponentsPageSchema,
  orderPositionsPageSchema,
  uomPageSchema,
  type MoyskladAssortmentImage,
  type MoyskladBundleComponentDto,
  type MoyskladOrderPositionDto,
  type MoyskladUomDto,
} from './composition-dto.js';

export type MoyskladErrorCode =
  | 'NOT_CONFIGURED'
  | 'METHOD_NOT_ALLOWED'
  /** Окружение работает только на чтение: запись запрещена до сети. */
  | 'WRITE_FORBIDDEN'
  | 'INVALID_QUERY'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'TRANSPORT_ERROR'
  | 'BAD_RESPONSE'
  /** Файл больше разрешённого предела: чтение прекращено, а не «почти влезло». */
  | 'FILE_TOO_LARGE'
  /** Тип содержимого не входит в разрешённый список изображений. */
  | 'FILE_TYPE_NOT_ALLOWED';

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
  WRITE_FORBIDDEN: 'Отправка в МойСклад заблокирована режимом только чтение',
  INVALID_QUERY: 'Некорректные параметры запроса к МоемуСкладу',
  UNAUTHORIZED: 'МойСклад отклонил авторизацию',
  FORBIDDEN: 'У пользователя интеграции нет прав на эту операцию',
  NOT_FOUND: 'Запрошенный объект в МоемСкладе не найден',
  RATE_LIMITED: 'Превышен лимит обращений к МоемуСкладу',
  SERVER_ERROR: 'МойСклад ответил ошибкой',
  TRANSPORT_ERROR: 'Не удалось связаться с МоимСкладом',
  BAD_RESPONSE: 'Ответ МоегоСклада не удалось разобрать',
  FILE_TOO_LARGE: 'Файл больше допустимого размера',
  FILE_TYPE_NOT_ALLOWED: 'Недопустимый тип файла',
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
  /** Разрешена ли запись. Значение окружения, а не решение вызывающего. */
  private readonly writesAllowed: boolean;
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
    // Отсутствующее значение — запрет: см. `MoyskladConfig.writesAllowed`.
    this.writesAllowed = deps.config.writesAllowed === true;
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
    /**
     * Что разворачивать. `null` — не разворачивать ничего: справочнику единиц
     * `expand=assortment` не нужен и смысла не имеет.
     */
    expand: string | null = 'assortment',
  ): Promise<CollectionPage<T>> {
    const rows: T[] = [];
    let offset = 0;
    let size: number | null = null;

    for (;;) {
      const params = new URLSearchParams();
      params.set('limit', String(MAX_EXPANDED_PAGE_SIZE));
      params.set('offset', String(offset));
      if (expand !== null) {
        params.set('expand', expand);
      }

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
   * Изображения номенклатуры.
   *
   * Источником фотографии считаются ТОЛЬКО изображения, прикреплённые к товару
   * или комплекту (`FUL-002` §2.7.3). Другого внешнего источника нет, и пустой
   * список — не ошибка, а честное «фото отсутствует».
   *
   * Тип сущности не собирается из пользовательского ввода: он приходит нашим
   * перечислением, и произвольный путь в API отсюда не построить.
   */
  async listAssortmentImages(
    kind: 'product' | 'bundle' | 'variant',
    assortmentId: string,
  ): Promise<MoyskladAssortmentImage[]> {
    if (!UUID_LIKE.test(assortmentId)) {
      throw new MoyskladError('INVALID_QUERY');
    }

    const body = await this.send(
      'GET',
      `/entity/${kind}/${assortmentId}/images?limit=${MAX_EXPANDED_PAGE_SIZE}`,
    );
    const parsed = assortmentImagesPageSchema.safeParse(body);
    if (!parsed.success) {
      throw new MoyskladError('BAD_RESPONSE');
    }
    return parsed.data.rows;
  }

  /**
   * Загрузка файла изображения — ОГРАНИЧЕННАЯ ПО-НАСТОЯЩЕМУ.
   *
   * Адрес не берётся на веру: он обязан принадлежать тому же базовому адресу
   * API. Иначе изменившийся или подменённый ответ увёл бы наш сервер вместе
   * с нашим токеном на произвольный хост — это классический SSRF, и одной
   * надежды на добросовестность внешнего сервиса здесь недостаточно.
   *
   * РЕДИРЕКТ НЕ СЛЕДУЕТСЯ. `redirect: 'manual'` означает, что `302` на чужой
   * домен остаётся ответом `302`, а не превращается во второй запрос
   * с заголовком `Authorization`. Проверка «адрес наш» без этого бессмысленна:
   * разрешённый URL мог бы одним заголовком `Location` стать любым другим.
   *
   * ЧТЕНИЕ ПОТОКОВОЕ И С ОСТАНОВКОЙ. `arrayBuffer()` для непроверенного тела
   * не вызывается вовсе: он сначала принял бы в память сколько угодно байт и
   * только потом сравнил бы с лимитом — то есть предел существовал бы лишь
   * на бумаге. Чтение прекращается и поток отменяется на первом же куске,
   * который переводит сумму за границу.
   *
   * Заголовку `content-length` доверия нет ни в какую сторону: честный слишком
   * большой размер отвергается до чтения тела, а отсутствующий или заниженный
   * ограничивается фактическими байтами.
   */
  async downloadFile(
    href: string,
    limits: { maxBytes: number; allowedTypes: readonly string[] },
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const prefix = `${this.config.baseUrl}/`;
    if (!href.startsWith(prefix)) {
      throw new MoyskladError('INVALID_QUERY');
    }
    const path = href.slice(this.config.baseUrl.length);

    return this.request(
      'GET',
      path,
      async (response) => {
        // Конечный адрес обязан остаться нашим и после ответа: переадресация,
        // прошедшая мимо `redirect: 'manual'`, не должна быть принята молча.
        if (!response.url.startsWith(prefix) && response.url !== '') {
          throw new MoyskladError('INVALID_QUERY');
        }

        const contentType =
          (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
        if (!limits.allowedTypes.includes(contentType)) {
          throw new MoyskladError('FILE_TYPE_NOT_ALLOWED');
        }

        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > limits.maxBytes) {
          throw new MoyskladError('FILE_TOO_LARGE');
        }

        return { bytes: await readLimited(response, limits.maxBytes), contentType };
      },
      // Переадресация — это уже другой адрес, а значит другое решение о доверии.
      { redirect: 'manual' },
    );
  }

  /**
   * Справочник единиц измерения целиком.
   *
   * Читается ОДИН раз за проход и кэшируется вызывающей стороной. Альтернатива —
   * запрос единицы на каждую позицию — превратила бы сотню строк состава в сотню
   * обращений к лимиту, который делится со всеми приложениями аккаунта.
   *
   * Полнота доказывается тем же способом, что и у состава: число строк
   * сверяется с `meta.size`, страницы читаются до конца.
   */
  async listUnitsOfMeasure(): Promise<CollectionPage<MoyskladUomDto>> {
    return this.readCollection('/entity/uom', uomPageSchema, null);
  }

  /**
   * Единственная сетевая граница клиента.
   *
   * Проверка метода выполняется ДО постановки в очередь и до любого обращения
   * к сети: запрещённый глагол не тратит ни лимит аккаунта, ни место в очереди.
   */
  /**
   * Перевод заказа покупателя в статус «Отменен».
   *
   * Официальный способ: `PUT /entity/customerorder/{id}` с ссылкой на статус
   * в поле `state`. Идентификатор статуса согласован владельцем и приходит
   * значением — угадывать его по названию нельзя, названия переименовывают.
   *
   * Операция сначала ЧИТАЕТ заказ. Это не лишний запрос, а идемпотентность:
   * повторная доставка сообщения очереди не должна писать второй раз, а уже
   * отменённый в источнике заказ — вообще не должен вызывать запись.
   */
  async cancelCustomerOrder(input: {
    orderId: string;
    stateId: string;
  }): Promise<{ alreadyCancelled: boolean }> {
    if (!this.writesAllowed) {
      // До сети дело не доходит: замок стоит здесь, а не в вызывающем коде.
      throw new MoyskladError('WRITE_FORBIDDEN');
    }
    if (!UUID_PATTERN.test(input.orderId) || !UUID_PATTERN.test(input.stateId)) {
      throw new MoyskladError('INVALID_QUERY');
    }

    const current = await this.request(
      'GET',
      `/entity/customerorder/${input.orderId}?expand=state`,
      readJson,
    );
    if (stateIdOf(current) === input.stateId) {
      return { alreadyCancelled: true };
    }

    await this.write(`/entity/customerorder/${input.orderId}`, {
      state: {
        meta: {
          href: `${this.config.baseUrl}/entity/customerorder/metadata/states/${input.stateId}`,
          type: 'state',
          mediaType: 'application/json',
        },
      },
    });

    return { alreadyCancelled: false };
  }

  async send(method: string, path: string): Promise<unknown> {
    if (!isReadOnlyMethod(method)) {
      throw new MoyskladError('METHOD_NOT_ALLOWED');
    }
    return this.request(method, path, readJson);
  }

  /**
   * Ставит обращение в общую очередь и выдерживает минимальный интервал.
   * Параллельных обращений не бывает: следующий ждёт завершения предыдущего.
   */
  private request<T>(
    method: string,
    path: string,
    read: ResponseReader<T>,
    extra: TransportOptions = {},
  ): Promise<T> {
    if (!isReadOnlyMethod(method)) {
      throw new MoyskladError('METHOD_NOT_ALLOWED');
    }
    const run = this.queue.then(
      () => this.execute(method, path, read, extra),
      () => this.execute(method, path, read, extra),
    );
    // Очередь не должна падать целиком из-за одной неудачи.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Единственный путь записи. Через ту же очередь и тот же лимитер:
   * лимит аккаунта общий, и запись его тоже расходует.
   */
  private write(path: string, body: unknown): Promise<unknown> {
    const run = this.queue.then(
      () => this.execute('PUT', path, readJson, { body }),
      () => this.execute('PUT', path, readJson, { body }),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async execute<T>(
    method: string,
    path: string,
    read: ResponseReader<T>,
    extra: TransportOptions = {},
  ): Promise<T> {
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
          ...(extra.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(extra.body === undefined ? {} : { body: JSON.stringify(extra.body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
        // Политика переадресации задаётся вызывающей стороной: для JSON она
        // не важна, а для файла означает разницу между «наш адрес» и «любой».
        ...(extra.redirect === undefined ? {} : { redirect: extra.redirect }),
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

    return read(response);
  }
}

/** Как прочитать успешный ответ. Разбор отделён от транспорта. */
type ResponseReader<T> = (response: Response) => Promise<T>;

/** Транспортные особенности одного обращения. Метод сюда не входит намеренно. */
interface TransportOptions {
  redirect?: 'manual' | 'error' | 'follow';
  /** Тело запроса. Есть только у названной операции записи. */
  body?: unknown;
}

/**
 * Чтение тела с жёстким пределом.
 *
 * Куски складываются по мере поступления, и как только сумма превышает предел,
 * поток ОТМЕНЯЕТСЯ: сервер перестаёт отправлять данные, а память не растёт.
 * Именно этим ограниченная загрузка отличается от «скачали всё и проверили
 * размер» — при последнем варианте предел не защищает ни от чего.
 *
 * Отсутствующее тело считается отказом, а не пустым файлом: пустая картинка
 * ничем не лучше её отсутствия, а различать эти случаи наружу всё равно нельзя.
 */
async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    throw new MoyskladError('BAD_RESPONSE', response.status);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }

      total += value.byteLength;
      if (total > maxBytes) {
        // Отмена, а не молчаливое дочитывание: остаток нам не нужен и платить
        // за него трафиком и памятью незачем.
        await reader.cancel().catch(() => undefined);
        throw new MoyskladError('FILE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MoyskladError) {
      throw error;
    }
    // Обрыв соединения посреди файла — транспортная неудача, а не «файл такой».
    await reader.cancel().catch(() => undefined);
    throw new MoyskladError('TRANSPORT_ERROR');
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Обычный ответ API — JSON. Непригодное тело наружу не выходит. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new MoyskladError('BAD_RESPONSE', response.status);
  }
}

/** Форма идентификатора МоегоСклада: вариант `0`, а не строгий RFC 4122. */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function numberHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Идентификаторы приходят и уходят только в этом виде. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Идентификатор статуса из ответа о заказе.
 *
 * Берётся из `state.meta.href` — развёрнутый статус кладёт туда ссылку,
 * последний сегмент которой и есть идентификатор. Ничего не додумывается:
 * непонятный ответ даёт `null`, и запись выполняется как обычно.
 */
function stateIdOf(order: unknown): string | null {
  const state = (order as { state?: { meta?: { href?: unknown } } } | null)?.state;
  const href = state?.meta?.href;
  if (typeof href !== 'string') {
    return null;
  }
  const tail = href.split('/').pop() ?? '';
  return UUID_PATTERN.test(tail) ? tail : null;
}

function statusToCode(status: number): MoyskladErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 500) return 'SERVER_ERROR';
  return 'BAD_RESPONSE';
}
