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
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),
  /** Каталог собранного web-клиента; в production один Node-процесс отдаёт API и статику. */
  WEB_DIST_PATH: z.string().optional(),

  // --- Секреты авторизации ---
  // На этапе 1 модуль auth ещё не реализован, поэтому значения необязательны.
  // Ветка feat/stage1-auth делает их обязательными для APP_ENV !== 'local'.
  AUTH_ACCESS_TOKEN_SECRET: z.string().min(32).optional(),
  AUTH_PIN_PEPPER: z.string().min(32).optional(),
  AUTH_REFRESH_REPLAY_KEY: z.string().min(32).optional(),
});

export type AppConfig = Readonly<z.infer<typeof configSchema>> & {
  readonly isProduction: boolean;
};

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
