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

  return Object.freeze({
    ...parsed.data,
    isProduction: parsed.data.NODE_ENV === 'production',
    isLocal: parsed.data.APP_ENV === 'local',
    trustProxy: parseTrustProxy(parsed.data.TRUST_PROXY),
    refreshReplayKey: Buffer.from(parsed.data.AUTH_REFRESH_REPLAY_KEY, 'base64'),
  });
}

export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Только для тестов: сбрасывает закешированную конфигурацию. */
export function resetConfigCache(): void {
  cached = null;
}
