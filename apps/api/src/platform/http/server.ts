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
import { authenticateWithRoles } from '../../modules/auth/guards.js';
import type { Notifier } from '../../modules/realtime/notifier.js';
import type { AppServer } from './types.js';

export interface ServerDeps {
  config: AppConfig;
  logger: AppLogger;
  db: Database;
  /** Слушатель сигналов PostgreSQL для realtime-канала. */
  notifier: Notifier;
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
  await registerOrderRoutes(app, { db, config });

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

    /** Технические подробности интеграций. Только ADMIN. */
    api.get('/api/status/integrations', async (request) => {
      await authenticateWithRoles(request, { db, config }, ['ADMIN']);
      return {
        integrations: await db.integrationStatus.findMany({
          select: {
            provider: true,
            state: true,
            pendingOperations: true,
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
