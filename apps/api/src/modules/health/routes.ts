/**
 * Health и readiness.
 *
 * `/health` — liveness: процесс жив, внешние зависимости не проверяются.
 * `/ready` — readiness: приложение готово принимать трафик, база отвечает.
 * Балансировщик и deploy-скрипты ориентируются на `/ready`.
 */

import { checkDatabase, type Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import type { AppServer } from '../../platform/http/types.js';

interface HealthDeps {
  db: Database;
  config: AppConfig;
}

export async function registerHealthRoutes(app: AppServer, deps: HealthDeps): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok',
    env: deps.config.APP_ENV,
    time: new Date().toISOString(),
  }));

  app.get('/ready', async (_request, reply) => {
    try {
      await checkDatabase(deps.db);
      return {
        status: 'ready',
        checks: { database: 'ok' },
        time: new Date().toISOString(),
      };
    } catch (error) {
      // Текст ошибки БД может содержать строку подключения, поэтому наружу он не уходит.
      app.log.error({ err: error }, 'readiness: база данных недоступна');
      return reply.code(503).send({
        status: 'not_ready',
        checks: { database: 'error' },
        time: new Date().toISOString(),
      });
    }
  });
}
