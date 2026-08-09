/**
 * Конфигурация приложения из переменных окружения.
 *
 * Секреты читаются только здесь и только на сервере. Ни одно значение из этого модуля
 * не попадает в клиентскую сборку и не выводится в лог целиком.
 */

import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Логическое окружение: local | staging | production. */
  APP_ENV: z.enum(['local', 'staging', 'production']).default('local'),
  /**
   * Маркер окружения. Deploy-скрипты сверяют его с ожидаемым значением цели,
   * чтобы staging-команда не могла отработать по production-хосту и наоборот.
   */
  APP_ENVIRONMENT_MARKER: z.string().min(1).default('local'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // `silent` полностью отключает вывод и используется в тестах.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),
  /** Каталог собранного web-клиента; в production один Node-процесс отдаёт API и статику. */
  WEB_DIST_PATH: z.string().optional(),

  /**
   * Доверие к заголовкам прокси (`X-Forwarded-For`).
   *
   * По умолчанию — отключено. Безусловное доверие позволило бы клиенту подделать
   * свой IP-адрес и обойти будущий rate limit и прогрессивную блокировку перебора,
   * если приложение окажется доступно не только через доверенный reverse proxy.
   *
   * Допустимые значения:
   *   не задано | `false`  — не доверять никому (значение по умолчанию);
   *   целое число          — доверять строго указанному числу переходов;
   *   список IP или CIDR   — доверять только перечисленным адресам, через запятую.
   *
   * Значение `true` запрещено намеренно.
   */
  TRUST_PROXY: z.string().optional(),

  // --- Секреты авторизации ---
  // Обязательны во всех окружениях. Небезопасного значения по умолчанию нет намеренно:
  // сгенерированный на лету секрет молча обесценил бы подписи и шифрование,
  // а «пустой» секрет означал бы подделываемые токены.
  // Для локальной разработки значения задаются в docker-compose.yml и явно помечены dev-only.
  AUTH_ACCESS_TOKEN_SECRET: z
    .string()
    .min(32, 'AUTH_ACCESS_TOKEN_SECRET должен быть не короче 32 символов'),
  AUTH_PIN_PEPPER: z.string().min(32, 'AUTH_PIN_PEPPER должен быть не короче 32 символов'),
  // --- МойСклад ---
  // Рабочий токен существует ТОЛЬКО в production. Локальная разработка, CI и staging
  // работают на фикстурах и поддельном HTTP: настоящие заказы туда не попадают,
  // а случайно оставленный в чужом окружении токен — это доступ к живому аккаунту.
  MOYSKLAD_TOKEN: z.string().min(1).optional(),
  /** Автоматический фоновый опрос. По умолчанию выключен во всех окружениях. */
  MOYSKLAD_SYNC_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  MOYSKLAD_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  /** Перекрытие окна delta-синхронизации. Стартовое значение — пять минут. */
  MOYSKLAD_SYNC_OVERLAP_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),

  // --- DaData: геокодирование адресов ---
  // Ключи существуют ТОЛЬКО в production. Ключ даёт доступ к платному балансу
  // организации, а каждый запрос содержит адрес клиента: обращение из staging,
  // CI или локальной разработки означало бы и трату чужих денег, и отправку
  // персональных данных наружу из окружения, где их быть не должно.
  DADATA_API_KEY: z.string().min(1).optional(),
  DADATA_SECRET_KEY: z.string().min(1).optional(),
  /** Автоматическое фоновое геокодирование. По умолчанию выключено везде. */
  DADATA_GEOCODING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * Адрес стиля карты MapLibre. Пусто — карта честно не настроена.
   *
   * Ключей здесь быть не может: значение целиком уходит в браузер. Публичные
   * тайлы OSM и демонстрационные тайлы MapLibre в production запрещены —
   * их условия не допускают продуктовую нагрузку.
   */
  MAP_STYLE_URL: z.string().trim().max(500).optional(),
  /** Подпись правообладателя подложки. Показывается на карте. */
  MAP_ATTRIBUTION: z.string().trim().max(200).optional(),

  /**
   * Каталог картографических артефактов, смонтированный только на чтение.
   *
   * Подложка не хранится ни в Git, ни в образе приложения: PMTiles на регион —
   * это сотни мегабайт, которые навсегда остались бы в истории репозитория
   * и в каждом слое образа. Файлы кладутся на сервер отдельной операцией,
   * а приложение при старте сверяет их с манифестом.
   */
  MAP_ARTIFACTS_PATH: z.string().trim().max(500).optional(),

  // --- Расчёт времени и расстояний ---
  // Собственная Valhalla живёт внутри сети Compose и наружу не публикуется.
  // Адрес известен только серверу: маршрутизатор, доступный из интернета, —
  // это чужой бесплатный вычислитель и способ узнать, куда мы возим.
  VALHALLA_URL: z.string().trim().max(300).optional(),
  /**
   * Ревизия дорожного графа. Входит в ключ кэша матриц.
   * Без неё расчёт невозможен: результат нельзя было бы отнести к данным,
   * по которым он получен, и он пережил бы смену графа.
   */
  VALHALLA_GRAPH_REVISION: z.string().trim().max(200).optional(),
  /** Верхняя граница числа точек матрицы: она растёт квадратично. */
  MATRIX_MAX_POINTS: z.coerce.number().int().min(2).max(200).default(60),
  /** Срок жизни готовой матрицы. Граф между сборками не меняется. */
  MATRIX_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(30 * 24 * 3600)
    .default(86_400),

  /** Ключ AES-256-GCM в base64: ровно 32 байта после декодирования. */
  AUTH_REFRESH_REPLAY_KEY: z
    .string()
    .min(1, 'AUTH_REFRESH_REPLAY_KEY обязателен')
    .refine((value) => decodeBase64Key(value)?.length === 32, {
      message: 'AUTH_REFRESH_REPLAY_KEY должен быть 32 байтами в base64 (ключ AES-256-GCM)',
    }),
});

/** Декодирует base64 без выбрасывания исключения; возвращает null при некорректном значении. */
function decodeBase64Key(value: string): Buffer | null {
  try {
    const buffer = Buffer.from(value, 'base64');
    // Buffer.from не сообщает об ошибке, поэтому проверяем обратимость кодирования.
    return buffer.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')
      ? buffer
      : null;
  } catch {
    return null;
  }
}

/** Значение, которое принимает Fastify в опции `trustProxy`. */
export type TrustProxySetting = false | number | string[];

export type AppConfig = Readonly<z.infer<typeof configSchema>> & {
  readonly isProduction: boolean;
  /** Локальная разработка: только здесь допустимы cookie без флага Secure. */
  readonly isLocal: boolean;
  readonly trustProxy: TrustProxySetting;
  /** Ключ AES-256-GCM для кратковременного хранения преемника refresh-токена. */
  readonly refreshReplayKey: Buffer;
};

const IP_OR_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-f:]+(\/\d{1,3})?$/i;

/**
 * Разбирает и проверяет настройку доверия к прокси.
 * Некорректное значение — причина отказать в запуске, а не молча доверять всем.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = raw?.trim() ?? '';

  if (value === '' || value.toLowerCase() === 'false') {
    return false;
  }

  if (value.toLowerCase() === 'true') {
    throw new Error(
      'TRUST_PROXY=true запрещено: безусловное доверие заголовкам прокси позволяет ' +
        'подделать IP-адрес клиента. Укажите список IP/CIDR доверенных прокси ' +
        'либо число доверенных переходов.',
    );
  }

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1 || hops > 10) {
      throw new Error('TRUST_PROXY: число доверенных переходов должно быть от 1 до 10');
    }
    return hops;
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  const invalid = entries.filter((entry) => !IP_OR_CIDR.test(entry));
  if (entries.length === 0 || invalid.length > 0) {
    throw new Error(
      `TRUST_PROXY: ожидается false, число переходов или список IP/CIDR. ` +
        `Не распознано: ${invalid.join(', ')}`,
    );
  }

  return entries;
}

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);

  if (!parsed.success) {
    // Печатаем только имена переменных и текст правила — без значений,
    // иначе некорректный секрет попал бы в вывод процесса.
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n  ');
    throw new Error(`Некорректная конфигурация окружения:\n  ${problems}`);
  }

  assertMoyskladEnvironment(parsed.data);
  assertDadataEnvironment(parsed.data);

  return Object.freeze({
    ...parsed.data,
    isProduction: parsed.data.NODE_ENV === 'production',
    isLocal: parsed.data.APP_ENV === 'local',
    trustProxy: parseTrustProxy(parsed.data.TRUST_PROXY),
    refreshReplayKey: Buffer.from(parsed.data.AUTH_REFRESH_REPLAY_KEY, 'base64'),
  });
}

/**
 * Fail closed для интеграции с МоимСкладом.
 *
 * Рабочий токен даёт полный доступ к живому аккаунту с реальными заказами.
 * Поэтому запуск останавливается, а не продолжается с предупреждением: приложение,
 * молча стартовавшее с production-токеном в staging, однажды сходит в чужие данные.
 */
function assertMoyskladEnvironment(data: z.infer<typeof configSchema>): void {
  // Оба признака обязаны совпасть: смешанная конфигурация вроде
  // APP_ENV=staging с production-маркером означает ошибку развёртывания,
  // и продолжать с рабочим токеном в такой ситуации нельзя.
  const isProductionMarker =
    data.APP_ENVIRONMENT_MARKER === 'production' && data.APP_ENV === 'production';

  if (data.MOYSKLAD_TOKEN !== undefined && !isProductionMarker) {
    throw new Error(
      'MOYSKLAD_TOKEN допустим только при APP_ENV=production и ' +
        'APP_ENVIRONMENT_MARKER=production: рабочий токен не размещается в local, CI и staging',
    );
  }

  if (data.MOYSKLAD_SYNC_ENABLED && !isProductionMarker) {
    throw new Error(
      'MOYSKLAD_SYNC_ENABLED=true допустим только при APP_ENV=production и APP_ENVIRONMENT_MARKER=production',
    );
  }

  if (data.MOYSKLAD_SYNC_ENABLED && data.MOYSKLAD_TOKEN === undefined) {
    throw new Error('MOYSKLAD_SYNC_ENABLED=true требует MOYSKLAD_TOKEN');
  }
}

/**
 * Fail closed для геокодирования.
 *
 * Ключ DaData — это платный баланс организации, а каждый запрос несёт адрес
 * клиента. Приложение, молча стартовавшее с рабочим ключом в staging, однажды
 * отправит наружу настоящие адреса и потратит чужие деньги. Поэтому запуск
 * останавливается, а не продолжается с предупреждением.
 */
function assertDadataEnvironment(data: z.infer<typeof configSchema>): void {
  const isProductionMarker =
    data.APP_ENVIRONMENT_MARKER === 'production' && data.APP_ENV === 'production';

  const hasKey = data.DADATA_API_KEY !== undefined || data.DADATA_SECRET_KEY !== undefined;

  if (hasKey && !isProductionMarker) {
    throw new Error(
      'DADATA_API_KEY и DADATA_SECRET_KEY допустимы только при APP_ENV=production и ' +
        'APP_ENVIRONMENT_MARKER=production: рабочие ключи не размещаются в local, CI и staging',
    );
  }

  if (data.DADATA_GEOCODING_ENABLED && !isProductionMarker) {
    throw new Error(
      'DADATA_GEOCODING_ENABLED=true допустим только при APP_ENV=production и ' +
        'APP_ENVIRONMENT_MARKER=production',
    );
  }

  // Оба ключа обязательны вместе: запрос к DaData требует и Authorization,
  // и X-Secret, а половина пары означает ошибку развёртывания.
  if (
    data.DADATA_GEOCODING_ENABLED &&
    (data.DADATA_API_KEY === undefined || data.DADATA_SECRET_KEY === undefined)
  ) {
    throw new Error('DADATA_GEOCODING_ENABLED=true требует и DADATA_API_KEY, и DADATA_SECRET_KEY');
  }
}

export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Только для тестов: сбрасывает закешированную конфигурацию. */
export function resetConfigCache(): void {
  cached = null;
}
