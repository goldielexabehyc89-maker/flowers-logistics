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
import { ZodError } from 'zod';
import type { AppConfig } from '../config.js';
import type { AppLogger } from '../logging/logger.js';
import { AppError, isAppError } from '../errors.js';
import type { Database } from '../db.js';
import { registerHealthRoutes } from '../../modules/health/routes.js';
import type { AppServer } from './types.js';

export interface ServerDeps {
  config: AppConfig;
  logger: AppLogger;
  db: Database;
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
  const { config, logger, db } = deps;

  const app: AppServer = Fastify({
    loggerInstance: logger,
    // Идентификатор запроса связывает ответ пользователю с записью в логе,
    // не раскрывая при этом технических деталей.
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      request.log.warn(
        { err: error, code: error.code, details: error.details },
        'обработанная ошибка приложения',
      );
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

  await registerHealthRoutes(app, { db, config });

  await app.register(async (api) => {
    api.get('/api/status', async () => ({
      // Публичное состояние приложения для индикатора в интерфейсе.
      // Реальных интеграций на этапе 1 нет, поэтому значения читаются из БД как есть.
      integrations: await db.integrationStatus.findMany({
        select: { provider: true, state: true, pendingOperations: true, updatedAt: true },
        orderBy: { provider: 'asc' },
      }),
      stage: 1,
    }));
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
