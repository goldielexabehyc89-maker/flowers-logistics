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
import { PhotonClient } from './modules/integrations/photon/client.js';
import { createGeocodeWorker, GEOCODE_LOCK_KEY } from './modules/orders/geocoding/worker.js';
import { reportGeocodingStartupStatus } from './modules/orders/geocoding/status.js';
import { clearHalt } from './modules/orders/geocoding/provider-state.js';
import { ValhallaClient } from './modules/integrations/valhalla/client.js';
import { probeRouting } from './modules/geo/routing-status.js';
import {
  isPhotonConfigured,
  shouldGeocodeAutomatically,
} from './modules/orders/geocoding/enabled.js';
import { VroomClient } from './modules/integrations/vroom/client.js';
import { probeSolver } from './modules/planning/solver-status.js';
import { createPlanningDeps } from './modules/planning/deps.js';
import { createPlanningRunner } from './modules/planning/runner.js';
import { newPlanningWorkerId } from './modules/planning/service.js';

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

  // Создание заданий и их обработка — РАЗНЫЕ решения.
  //
  // Задание описывает событие «у этого заказа появился адрес, который никто
  // ещё не разрешал». Оно возникает независимо от того, разрешено ли сейчас
  // обращаться к геокодеру: иначе выключенный обработчик молча терял бы
  // события, и после включения о них никто бы не узнал.
  const enqueueOnImport = isPhotonConfigured(config);
  // А вот ОБРАБОТКА требует и настроенного геокодера, и явного разрешения.
  const geocodingEnabled = shouldGeocodeAutomatically(config);

  // Синхронизация МоегоСклада. Токен допускается только в production и в
  // staging-режиме read-only, поэтому в остальных окружениях worker не создаётся
  // и ни одного сетевого обращения не выполняется — интеграция честно остаётся
  // ненастроенной.
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
    enqueueOnImport,
    // Источник запроса к геокодеру. Адрес заказа этим не управляется.
    addressSource: config.MOYSKLAD_GEOCODING_ADDRESS_SOURCE,
  };
  await reportStartupStatus(moysklad, config);

  const syncWorker = shouldRunAutomatically(config)
    ? createSyncWorker(moysklad, config.MOYSKLAD_SYNC_INTERVAL_SECONDS * 1000)
    : null;
  syncWorker?.start();

  // Геокодирование адресов выполняет собственный Photon. Без адреса Photon
  // worker не создаётся вовсе: геокодер честно остаётся ненастроенным, заказы
  // остаются в «Требует внимания», и точку ставит человек. Ни одного обращения
  // к внешнему платному сервису отсюда не происходит.
  await reportGeocodingStartupStatus(db, {
    configured: isPhotonConfigured(config),
    enabled: geocodingEnabled,
  });

  const geocodeWorker = geocodingEnabled
    ? createGeocodeWorker({
        db,
        logger,
        // Собственный Photon: ключей у него нет, наружу адреса не уходят.
        client: new PhotonClient({ url: config.PHOTON_URL ?? null }),
        lock: { connectionString: config.DATABASE_URL, key: GEOCODE_LOCK_KEY },
      })
    : null;
  // Стартового наполнения очереди НЕТ и быть не должно.
  //
  // Раньше приложение при каждом запуске ставило в очередь все исторические
  // заказы без координат — 685 заданий за одну минуту на staging. Это неверно
  // по смыслу: геокодировать надо СОБЫТИЕ, а не состояние. Заказ попадает
  // в очередь, когда он впервые импортирован либо когда логист исправил адрес;
  // отсутствие координат у старого заказа событием не является и само по себе
  // основанием для обращения к геокодеру не служит.
  //
  // Массовый проход по истории остался ровно один — явная операторская команда
  // `npm run geocode:backfill -- --limit N`. Сама она не запускается никогда.
  if (geocodeWorker !== null) {
    // Остановка обращений снимается при старте: приложение поднялось, значит,
    // конфигурацию проверял человек. Та же неверная настройка снова остановит
    // обращения после первого же отказа, и это стоит одного запроса.
    await clearHalt(db);
  }

  geocodeWorker?.start();

  // Собственный маршрутизатор. Живёт внутри сети Compose и наружу не выходит.
  // Его недоступность не влияет на готовность приложения: ручные маршруты —
  // основной способ работы, а расчёт времени только ускоряет его.
  const valhalla = new ValhallaClient({ baseUrl: config.VALHALLA_URL ?? null });
  await probeRouting(db, valhalla, config.VALHALLA_GRAPH_SHA256 ?? null).catch((error: unknown) => {
    logger.error({ err: error }, 'не удалось определить состояние маршрутизатора');
    return null;
  });

  // Решатель VROOM. Его недоступность тоже не влияет на готовность приложения:
  // без планирования логист продолжает собирать маршруты руками.
  //
  // Пробная задача при старте проверяет не версию из настройки, а фактическую
  // возможность: решатель обязан учитывать время обслуживания по типу машины.
  const vroom = new VroomClient({ baseUrl: config.VROOM_URL ?? null });
  await probeSolver(db, vroom, config.VROOM_VERSION ?? null).catch((error: unknown) => {
    logger.error({ err: error }, 'не удалось определить состояние решателя');
    return null;
  });

  // Расчёты планирования выполняет фоновый исполнитель со своим владельцем
  // аренды: HTTP-запрос столько ждать не может, а без отдельного владельца
  // два экземпляра приложения считали бы аренду друг друга своей.
  const planningRunner =
    config.VROOM_URL === undefined
      ? null
      : createPlanningRunner(
          createPlanningDeps({ db, config, logger, workerId: newPlanningWorkerId() }),
        );
  planningRunner?.start();

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
        geocodeWorker?.stop() ?? Promise.resolve(),
        planningRunner?.stop() ?? Promise.resolve(),
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
