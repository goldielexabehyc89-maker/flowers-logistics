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
  /**
   * Сколько миллисекунд до сброса окна.
   *
   * `null` — сервер не назвал. Тогда пауза берётся консервативной: ждать
   * секунду дешевле, чем гадать и получить `429`.
   */
  resetMs?: number | null;
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
  /**
   * Доля общего токена, которую мы согласны занять.
   *
   * Отсутствие политики сохраняет прежнее поведение: интервал из
   * `minIntervalMs`, неприкосновенного остатка нет, повторы не выполняются.
   * Так работают проверки и стенды, которым чужие интеграции не мешают.
   */
  rateLimit?: RateLimitPolicy;
  /** Случайная добавка к паузе после `429`. Подменяется в проверках. */
  jitter?: () => number;
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

/**
 * Сколько раз повторять обращение, сорвавшееся не по нашей вине.
 *
 * Повтор ограничен намеренно. Токен общий с другими сервисами, и бесконечная
 * настойчивость нашего импорта отняла бы лимит у чужой работающей интеграции
 * ровно тогда, когда МоемуСкладу и так плохо.
 */
const DEFAULT_MAX_RETRIES = 3;

/** Задержки повтора: 1 → 2 → 4 секунды. Растут, но потолок близко. */
const RETRY_BACKOFF_MS = [1000, 2000, 4000] as const;

/**
 * Разброс паузы после `429`.
 *
 * Без него все экземпляры, получившие лимит одновременно, вернулись бы в сеть
 * в одну и ту же миллисекунду и получили бы его снова.
 */
const RETRY_JITTER_MS = 500;

/** Во сколько раз замедляется темп после ПОВТОРНОГО `429` в одном проходе. */
const SLOWDOWN_FACTOR = 4;

/** Окно лимита, если сервер его не назвал. Пауза не должна быть вечной. */
const DEFAULT_RESET_WINDOW_MS = 1000;

/**
 * Политика обращения к общему токену.
 *
 * Токен МоегоСклада делят несколько сервисов, поэтому предел выбирается НЕ
 * по возможностям API, а по доле, которую мы согласны занять. Значения
 * приходят из конфигурации окружения: у контура, где живут чужие интеграции,
 * они строже, чем у стенда.
 */
export interface RateLimitPolicy {
  /** Верхний предел темпа. Пауза между обращениями — обратная величина. */
  maxRequestsPerSecond: number;
  /** Параллельность. Значение больше единицы клиентом не поддерживается. */
  maxConcurrency: number;
  /**
   * Неприкосновенный остаток окна лимита.
   *
   * Когда сервер сообщает, что осталось меньше, очередь ждёт сброса окна.
   * Остаток общий: его тратят и чужие сервисы, поэтому «ещё немного можно»
   * означает «можно, но уже не нам».
   */
  reserveRequests: number;
  /** Сколько раз повторять 5xx, таймаут и обрыв связи. */
  maxRetries?: number;
}

/**
 * Что фактически происходило с лимитом.
 *
 * Нужна отчёту о проходе: «настроено два запроса в секунду» — это намерение,
 * а «фактический максимум 1.8» — факт. Ни адресов, ни токена здесь нет
 * и быть не может: это счётчики.
 */
export interface RateLimitStats {
  /** Всего сетевых обращений, включая повторы. */
  requests: number;
  /** Наибольшее число обращений, начатых в пределах одной секунды. */
  maxRequestsPerSecond: number;
  /** Наибольшая одновременность. Обязана остаться единицей. */
  maxConcurrency: number;
  /** Сколько раз сервер ответил `429`. */
  rateLimited: number;
  /** Сколько раз обращение повторялось после 5xx, таймаута или обрыва. */
  retries: number;
  /** Сколько раз очередь вставала из-за неприкосновенного остатка. */
  reservePauses: number;
  /** Замедлен ли темп до конца прохода после повторного `429`. */
  slowedDown: boolean;
}

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

  private readonly policy: RateLimitPolicy | null;
  private readonly jitter: () => number;
  /** Моменты начала обращений: по ним считается ФАКТИЧЕСКИЙ темп. */
  private readonly starts: number[] = [];
  private inFlight = 0;
  /** Множитель темпа: становится больше единицы после повторного `429`. */
  private slowdown = 1;
  private rateLimitedInPass = 0;
  private stats: RateLimitStats = {
    requests: 0,
    maxRequestsPerSecond: 0,
    maxConcurrency: 0,
    rateLimited: 0,
    retries: 0,
    reservePauses: 0,
    slowedDown: false,
  };

  constructor(deps: MoyskladClientDeps) {
    this.config = deps.config;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.policy = deps.rateLimit ?? null;
    this.jitter = deps.jitter ?? ((): number => Math.random() * RETRY_JITTER_MS);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    /*
     * Пауза между обращениями считается из разрешённого темпа.
     *
     * Политика важнее явного интервала: она названа долей общего токена,
     * а интервал — деталь исполнения. Без политики поведение прежнее.
     */
    this.minIntervalMs =
      this.policy === null
        ? (deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)
        : Math.ceil(1000 / Math.max(1, this.policy.maxRequestsPerSecond));
  }

  get rateLimit(): RateLimitSnapshot {
    return this.lastRateLimit;
  }

  /** Что фактически происходило с лимитом. Только счётчики, без PII. */
  get rateLimitStats(): RateLimitStats {
    return { ...this.stats };
  }

  /**
   * Начало прохода синхронизации.
   *
   * Замедление после повторного `429` держится ДО КОНЦА прохода и снимается
   * только здесь. Возвращать высокий темп внутри того же прохода нельзя:
   * сервер уже дважды сказал «слишком часто», и третий раз он скажет это
   * чужой интеграции, у которой с нами общий токен.
   */
  startPass(): void {
    this.slowdown = 1;
    this.rateLimitedInPass = 0;
    this.stats = {
      requests: 0,
      maxRequestsPerSecond: 0,
      maxConcurrency: 0,
      rateLimited: 0,
      retries: 0,
      reservePauses: 0,
      slowedDown: false,
    };
    this.starts.length = 0;
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
      () => this.attempt(method, path, read, extra),
      () => this.attempt(method, path, read, extra),
    );
    // Очередь не должна падать целиком из-за одной неудачи.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Обращение с повторами и соблюдением лимита.
   *
   * Повторы живут ЗДЕСЬ, а не у вызывающей стороны, потому что лимит общий:
   * решай каждый вызов сам, когда вернуться, — и три места кода спорили бы
   * за один токен. Все способы запуска — первоначальный импорт, delta,
   * ручной проход и дочитывание состава — проходят через эту очередь.
   *
   * `429` повтором не является: сервер назвал паузу, и она выдерживается
   * целиком, а не сокращается «на всякий случай».
   */
  private async attempt<T>(
    method: string,
    path: string,
    read: ResponseReader<T>,
    extra: TransportOptions,
  ): Promise<T> {
    const maxRetries = this.policy === null ? 0 : (this.policy.maxRetries ?? DEFAULT_MAX_RETRIES);

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.execute(method, path, read, extra);
      } catch (error) {
        const code = error instanceof MoyskladError ? error.code : null;

        /*
         * Лимит исчерпан. Останавливается ВСЯ очередь: она последовательна,
         * и пауза внутри обращения задерживает все следующие.
         */
        if (code === 'RATE_LIMITED' && this.policy !== null) {
          this.stats.rateLimited += 1;
          this.rateLimitedInPass += 1;

          // Повторный лимит в одном проходе — не случайность. Темп снижается
          // до конца прохода и сам обратно не поднимается.
          if (this.rateLimitedInPass >= 2) {
            this.slowdown = SLOWDOWN_FACTOR;
            this.stats.slowedDown = true;
          }

          const retryAfter =
            error instanceof MoyskladError && typeof error.retryAfterMs === 'number'
              ? error.retryAfterMs
              : DEFAULT_RESET_WINDOW_MS;
          await this.sleep(retryAfter + this.jitter());
          // Счётчик попыток лимитом не расходуется: сервер сказал «позже»,
          // а не «нельзя». Иначе один занятый час стоил бы нам прохода.
          continue;
        }

        /*
         * Отказ доступа повторять запрещено.
         *
         * Токен неверен или отозван; повтор превратился бы в шторм
         * запросов с заведомо негодным ключом — по общему для сервисов
         * лимиту и, возможно, до блокировки аккаунта.
         */
        if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'METHOD_NOT_ALLOWED') {
          throw error;
        }

        const retriable =
          code === 'SERVER_ERROR' || code === 'TRANSPORT_ERROR' || code === 'BAD_RESPONSE';
        if (!retriable || attempt >= maxRetries) {
          throw error;
        }

        this.stats.retries += 1;
        const backoff = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)] ?? 4000;
        await this.sleep(backoff);
      }
    }
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

    /*
     * Неприкосновенный остаток окна.
     *
     * Остаток общий с чужими сервисами: «осталось десять» означает не «нам
     * можно ещё десять», а «всем вместе осталось десять». Дождаться сброса
     * дешевле, чем отнять последние обращения у работающей интеграции.
     */
    if (this.policy !== null && this.policy.reserveRequests > 0) {
      const remaining = this.lastRateLimit.remaining;
      if (remaining !== null && remaining < this.policy.reserveRequests) {
        this.stats.reservePauses += 1;
        await this.sleep(this.lastRateLimit.resetMs ?? DEFAULT_RESET_WINDOW_MS);
        // Снимок устарел: следующий ответ принесёт новый остаток.
        this.lastRateLimit = { ...this.lastRateLimit, remaining: null };
      }
    }

    if (this.lastStartedAt !== null) {
      const wait = this.minIntervalMs * this.slowdown - (this.now() - this.lastStartedAt);
      if (wait > 0) {
        await this.sleep(wait);
      }
    }
    this.lastStartedAt = this.now();
    this.noteStart(this.lastStartedAt);

    this.inFlight += 1;
    this.stats.maxConcurrency = Math.max(this.stats.maxConcurrency, this.inFlight);

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
        // Политика переадресации задаётся вызывающей стороной: для JSON она
        // не важна, а для файла означает разницу между «наш адрес» и «любой».
        ...(extra.redirect === undefined ? {} : { redirect: extra.redirect }),
      });
    } catch {
      // Текст сетевой ошибки может содержать адрес запроса с фильтрами.
      throw new MoyskladError('TRANSPORT_ERROR');
    } finally {
      this.inFlight -= 1;
    }

    this.lastRateLimit = {
      remaining: numberHeader(response, 'x-ratelimit-remaining'),
      limit: numberHeader(response, 'x-ratelimit-limit'),
      resetMs: numberHeader(response, 'x-ratelimit-reset'),
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

  /**
   * Учёт фактического темпа и одновременности.
   *
   * Считается по МОМЕНТАМ НАЧАЛА обращений, а не по намерению: настройка
   * «два в секунду» — это план, а отчёту нужен факт. Одновременность
   * отслеживается тем же счётчиком: очередь последовательна, и значение
   * больше единицы означало бы, что кто-то обошёл её стороной.
   */
  private noteStart(at: number): void {
    this.stats.requests += 1;
    this.starts.push(at);
    while (this.starts.length > 0 && at - (this.starts[0] ?? at) >= 1000) {
      this.starts.shift();
    }
    this.stats.maxRequestsPerSecond = Math.max(this.stats.maxRequestsPerSecond, this.starts.length);
  }
}

/** Как прочитать успешный ответ. Разбор отделён от транспорта. */
type ResponseReader<T> = (response: Response) => Promise<T>;

/** Транспортные особенности одного обращения. Метод сюда не входит намеренно. */
interface TransportOptions {
  redirect?: 'manual' | 'error' | 'follow';
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

function statusToCode(status: number): MoyskladErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 500) return 'SERVER_ERROR';
  return 'BAD_RESPONSE';
}
