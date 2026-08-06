/**
 * Точка входа приложения.
 *
 * Запуск: конфигурация → логгер → БД → слушатель сигналов → HTTP-сервер →
 * фоновые задачи. Остановка по SIGTERM/SIGINT корректно гасит таймеры,
 * очередь и открытые realtime-каналы, чтобы деплой не рвал активные соединения.
 */

import { loadConfig } from './platform/config.js';
import { createLogger } from './platform/logging/logger.js';
import { redactString } from './platform/logging/redact.js';
import { createDatabase } from './platform/db.js';
import { buildServer } from './platform/http/server.js';
import { createMaintenanceRunner } from './platform/maintenance.js';
import { createNotifier } from './modules/realtime/notifier.js';
import { createOutboxWorker } from './modules/outbox/worker.js';
import { createTestPingHandler } from './modules/outbox/handlers.js';
import { MoyskladClient } from './modules/integrations/moysklad/client.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from './modules/integrations/moysklad/config.js';
import {
  createSyncWorker,
  reportStartupStatus,
  shouldRunAutomatically,
} from './modules/integrations/moysklad/worker.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = createDatabase(config, logger);

  const notifier = createNotifier(config.DATABASE_URL, logger);
  notifier.start();

  const app = await buildServer({ config, logger, db, notifier });

  const maintenance = createMaintenanceRunner({ db, logger });
  // Первый проход сразу при старте: процесс мог быть остановлен надолго.
  await maintenance.runOnce();
  maintenance.start();

  const outbox = createOutboxWorker({
    db,
    logger,
    handlers: { 'test.ping': createTestPingHandler(logger) },
  });
  outbox.start();

  // Синхронизация МоегоСклада. Токен существует только в production, поэтому
  // в остальных окружениях worker не создаётся и ни одного сетевого обращения
  // не выполняется — интеграция честно остаётся ненастроенной.
  const moysklad = {
    db,
    client: new MoyskladClient({
      config: {
        baseUrl: MOYSKLAD_BASE_URL,
        token: config.MOYSKLAD_TOKEN ?? null,
        ids: MOYSKLAD_IDS,
      },
    }),
    logger,
    ids: MOYSKLAD_IDS,
    overlapSeconds: config.MOYSKLAD_SYNC_OVERLAP_SECONDS,
    lock: { connectionString: config.DATABASE_URL },
  };
  await reportStartupStatus(moysklad, config);

  const syncWorker = shouldRunAutomatically(config)
    ? createSyncWorker(moysklad, config.MOYSKLAD_SYNC_INTERVAL_SECONDS * 1000)
    : null;
  syncWorker?.start();

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
      // Сначала фоновые задачи: они дожидаются начатого прохода, поэтому
      // к моменту закрытия соединения с базой ни один обработчик уже не работает.
      // Общий лимит остановки при этом не меняется — он висит выше по коду.
      await Promise.all([
        outbox.stop(),
        maintenance.stop(),
        syncWorker?.stop() ?? Promise.resolve(),
      ]);
      await app.close();
      await notifier.stop();
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
