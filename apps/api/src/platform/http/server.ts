/**
 * Сборка HTTP-сервера.
 *
 * В production один и тот же Node-процесс обслуживает API и собранный web-клиент:
 * отдельного веб-сервера у проекта нет.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { ZodError } from 'zod';
import type { AppConfig } from '../config.js';
import type { AppLogger } from '../logging/logger.js';
import { AppError, isAppError } from '../errors.js';
import type { Database } from '../db.js';
import { registerHealthRoutes } from '../../modules/health/routes.js';
import { registerAuthRoutes } from '../../modules/auth/routes.js';
import { registerUserRoutes } from '../../modules/users/routes.js';
import { registerRealtimeRoutes } from '../../modules/realtime/routes.js';
import { registerOutboxRoutes } from '../../modules/outbox/routes.js';
import { registerOrderRoutes } from '../../modules/orders/routes.js';
import { registerRoutingRoutes } from '../../modules/routing/routes.js';
import { registerDepotRoutes } from '../../modules/depots/routes.js';
import {
  registerWarehouseRoutes,
  registerWarehouseFlowRoutes,
} from '../../modules/warehouse/routes.js';
import { registerDeliveryRoutes } from '../../modules/delivery/routes.js';
import { registerFinanceRoutes } from '../../modules/finance/routes.js';
import { registerReturnRoutes } from '../../modules/returns/routes.js';
import { registerTestingRoutes } from '../../modules/testing/routes.js';
import { registerFloristRoutes } from '../../modules/fulfillment/routes.js';
import { registerPickupRoutes } from '../../modules/pickup/routes.js';
import { registerPrintingRoutes } from '../../modules/printing/routes.js';
import { registerSettingsRoutes } from '../../modules/settings/routes.js';
import { registerPlanningRoutes } from '../../modules/planning/routes.js';
import { createPlanningDeps } from '../../modules/planning/deps.js';
import { registerBasemapRoutes } from '../../modules/geo/basemap/routes.js';
import { loadBasemap, type BasemapState } from '../../modules/geo/basemap/manifest.js';
import { setBasemapStatus } from '../../modules/geo/basemap/status.js';
import { authenticateWithRoles } from '../../modules/auth/guards.js';
import type { Notifier } from '../../modules/realtime/notifier.js';
import type { AppServer } from './types.js';

export interface ServerDeps {
  config: AppConfig;
  logger: AppLogger;
  db: Database;
  /** Слушатель сигналов PostgreSQL для realtime-канала. */
  notifier: Notifier;
  /**
   * Уже проверенная подложка.
   *
   * Проверка читает и хеширует сотни мегабайт, поэтому выполняется один раз
   * при старте. Тесты передают готовое состояние и не платят за пересчёт.
   */
  basemap?: BasemapState;
}

function resolveWebDist(config: AppConfig): string {
  if (config.WEB_DIST_PATH !== undefined) {
    return path.resolve(config.WEB_DIST_PATH);
  }
  // По умолчанию — собранный клиент рядом с приложением: apps/api/dist -> apps/web/dist
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../web/dist');
}

export async function buildServer(deps: ServerDeps): Promise<AppServer> {
  const { config, logger, db, notifier } = deps;

  // Подложка проверяется один раз при сборке сервера. Несовпадение контрольной
  // суммы означает «карта не настроена»: приложение продолжает работать
  // и никуда наружу за тайлами не идёт.
  const basemap: BasemapState = deps.basemap ?? (await loadBasemap(config.MAP_ARTIFACTS_PATH));

  if (!basemap.ok && config.MAP_ARTIFACTS_PATH !== undefined) {
    logger.warn(
      { basemap: { problem: basemap.problem, artifact: basemap.artifact ?? null } },
      'подложка карты не прошла проверку: карта объявлена ненастроенной',
    );
  }

  // Индикатор интеграций обязан говорить о карте то же самое, что и `/maps/*`.
  // Запись `maps` появилась заглушкой на этапе 1 и с тех пор не обновлялась:
  // интерфейс показывал «Интеграция не настроена» при работающей подложке.
  // Отказ записи не должен мешать приложению подняться — это индикатор.
  await setBasemapStatus(db, basemap).catch((error: unknown) => {
    logger.warn({ err: error }, 'не удалось записать состояние подложки в индикатор');
  });

  const app: AppServer = Fastify({
    loggerInstance: logger,
    // Идентификатор запроса связывает ответ пользователю с записью в логе,
    // не раскрывая при этом технических деталей.
    genReqId: () => crypto.randomUUID(),
    // По умолчанию заголовкам прокси не доверяем: иначе клиент подделает свой IP
    // и обойдёт rate limit. Доверенные прокси задаются переменной TRUST_PROXY.
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
  });

  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      request.log.warn(
        { err: error, code: error.code, details: error.details },
        'обработанная ошибка приложения',
      );

      // При блокировке клиент должен узнать, когда повторять. Значение берётся
      // из details, но сами details наружу не отдаются: в теле только код и текст.
      if (error.code === 'RATE_LIMITED') {
        const retryAfter = error.details?.['retryAfterSeconds'];
        if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
          reply.header('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
        }
      }

      return reply.code(error.statusCode).send(error.toBody(request.id));
    }

    if (error instanceof ZodError) {
      const appError = new AppError('VALIDATION_FAILED', {
        details: { issues: error.issues.map((issue) => issue.path.join('.')) },
      });
      request.log.warn({ err: appError, details: appError.details }, 'ошибка валидации');
      return reply.code(appError.statusCode).send(appError.toBody(request.id));
    }

    // Неожиданная ошибка: наружу уходит только общий текст и requestId.
    request.log.error({ err: error }, 'необработанная ошибка');
    const internal = new AppError('INTERNAL_ERROR');
    return reply.code(internal.statusCode).send(internal.toBody(request.id));
  });

  // Cookie нужны только для refresh-токена: он передаётся исключительно так.
  await app.register(fastifyCookie);

  await registerHealthRoutes(app, { db, config });
  await registerAuthRoutes(app, { db, config });
  await registerUserRoutes(app, { db, config });
  await registerRealtimeRoutes(app, { db, config, notifier });
  await registerOutboxRoutes(app, { db, config });
  await registerOrderRoutes(app, { db, config, basemap: () => basemap });
  await registerBasemapRoutes(app, { state: () => basemap });
  await registerRoutingRoutes(app, { db, config });
  await registerDepotRoutes(app, { db, config });
  await registerWarehouseRoutes(app, { db, config });
  await registerWarehouseFlowRoutes(app, { db, config });
  // Печать: точки, подключение агента и выдача заданий на принтер.
  await registerPrintingRoutes(app, { db, config });
  // Работа курьера: результат доставки и автоматическое завершение маршрута.
  await registerDeliveryRoutes(app, { db, config });
  await registerFinanceRoutes(app, { db, config });
  registerReturnRoutes(app, { db, config });

  /*
   * Вход, воспроизводящий ВНЕШНИЙ сигнал отмены.
   *
   * Регистрируется только при явном `E2E_TEST_HOOKS=true`, а конфигурация
   * допускает это значение только в local. В staging и production такого
   * пути нет вовсе: он отсутствует в списке маршрутов, а не отвечает отказом.
   */
  if (config.E2E_TEST_HOOKS) {
    registerTestingRoutes(app, { db, config });
  }
  // Раздел флориста. Клиент МоегоСклада собирается внутри и только при наличии
  // токена: без него проксирование фотографий отвечает «Фото отсутствует»
  // и ни одного сетевого обращения не выполняет.
  await registerFloristRoutes(app, { db, config });
  // Раздел самовывоза: выдача покупателю. Прав склада и логистики не требует
  // и не выдаёт — у него собственная пара ролей.
  await registerPickupRoutes(app, { db, config });
  await registerSettingsRoutes(app, { db, config });
  // HTTP-слой планирования аренд не берёт и в сеть не ходит: расчёт выполняет
  // фоновый исполнитель со своим владельцем аренды (см. index.ts).
  await registerPlanningRoutes(app, {
    db,
    config,
    planning: createPlanningDeps({ db, config, logger }),
  });

  await app.register(async (api) => {
    /**
     * Публичное состояние приложения для индикатора в интерфейсе.
     *
     * Маршрут доступен без авторизации, поэтому отдаёт только высокоуровневое
     * состояние интеграции: работает, настроена, ошибка. Технические счётчики
     * рассказывают постороннему о внутреннем устройстве и объёме работы системы,
     * поэтому живут на отдельном маршруте для администратора.
     */
    api.get('/api/status', async () => ({
      integrations: await db.integrationStatus.findMany({
        select: { provider: true, state: true, updatedAt: true },
        orderBy: { provider: 'asc' },
      }),
      stage: 1,
    }));

    /**
     * Технические подробности интеграций. Только ADMIN.
     *
     * `details` содержит исключительно очищенные сведения — коды отказа, числа
     * и причины. Ключи, заголовки, тела ответов провайдеров, адреса и координаты
     * туда не попадают: это обеспечивается на стороне записи.
     */
    api.get('/api/status/integrations', async (request) => {
      await authenticateWithRoles(request, { db, config }, ['ADMIN']);
      return {
        integrations: await db.integrationStatus.findMany({
          select: {
            provider: true,
            state: true,
            pendingOperations: true,
            details: true,
            lastOkAt: true,
            lastErrorAt: true,
            updatedAt: true,
          },
          orderBy: { provider: 'asc' },
        }),
      };
    });
  });

  // Статика web-клиента подключается только там, где сборка существует.
  const webDist = resolveWebDist(config);
  const hasWebBuild = await import('node:fs/promises')
    .then((fs) => fs.access(path.join(webDist, 'index.html')))
    .then(() => true)
    .catch(() => false);

  if (hasWebBuild) {
    await app.register(fastifyStatic, { root: webDist, index: ['index.html'] });
  } else {
    logger.warn(
      { webDist },
      'сборка web-клиента не найдена: отдаётся только API (ожидаемо в режиме разработки)',
    );
  }

  app.setNotFoundHandler((request, reply) => {
    // Для API отвечаем машинно-читаемой ошибкой, для остальных путей —
    // отдаём SPA, чтобы клиентский роутинг работал после перезагрузки страницы.
    if (request.url.startsWith('/api/') || !hasWebBuild) {
      const notFound = new AppError('NOT_FOUND');
      return reply.code(notFound.statusCode).send(notFound.toBody(request.id));
    }
    return reply.sendFile('index.html');
  });

  return app;
}
