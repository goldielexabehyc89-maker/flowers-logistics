/**
 * Точка входа приложения.
 *
 * Запуск: загрузка конфигурации → логгер → подключение к БД → HTTP-сервер.
 * Остановка: корректное завершение по SIGTERM/SIGINT, чтобы деплой не рвал активные запросы.
 */

import { loadConfig } from './platform/config.js';
import { createLogger } from './platform/logging/logger.js';
import { redactString } from './platform/logging/redact.js';
import { createDatabase } from './platform/db.js';
import { buildServer } from './platform/http/server.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = createDatabase(config, logger);
  const app = await buildServer({ config, logger, db });

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'получен сигнал остановки, завершаем работу');

    const forceExit = setTimeout(() => {
      logger.error({ signal }, 'корректное завершение не уложилось в лимит, выходим принудительно');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      await app.close();
      await db.$disconnect();
      logger.info('работа завершена');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'ошибка при завершении работы');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info(
    { port: config.PORT, env: config.APP_ENV, marker: config.APP_ENVIRONMENT_MARKER },
    'приложение запущено',
  );
}

main().catch((error: unknown) => {
  // Логгер может быть ещё не создан, поэтому пишем в stderr напрямую.
  // Текст ошибки обязательно очищается: сбой подключения к базе на старте
  // содержит строку подключения с паролем.
  const message = error instanceof Error ? error.message : String(error);
  console.error('Не удалось запустить приложение:', redactString(message));
  process.exit(1);
});
