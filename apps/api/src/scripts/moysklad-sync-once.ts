/**
 * Один проход синхронизации МоегоСклада вручную.
 *
 * Нужен для будущего закрытого production-пилота: позволяет выполнить импорт,
 * не включая автоматический worker. Вся логика лежит в `performSyncOnce`
 * и покрыта тестами; здесь только сборка зависимостей и коды возврата.
 *
 *   npm run moysklad:sync-once
 */

import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { redactString } from '../platform/logging/redact.js';
import { createDatabase } from '../platform/db.js';
import { MoyskladClient } from '../modules/integrations/moysklad/client.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from '../modules/integrations/moysklad/config.js';
import {
  checkSyncOnceEnvironment,
  performSyncOnce,
} from '../modules/integrations/moysklad/sync-once.js';
import { auditManualPass } from '../modules/integrations/moysklad/sync.js';

async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);

  // Проверка окружения выполняется ДО создания базы, блокировки и клиента.
  const rejected = checkSyncOnceEnvironment(config);
  if (rejected !== null) {
    logger.error(rejected.reason);
    return rejected.code;
  }

  const db = createDatabase(config, logger);
  const deps = {
    db,
    client: new MoyskladClient({
      config: {
        baseUrl: MOYSKLAD_BASE_URL,
        token: config.MOYSKLAD_TOKEN ?? null,
        ids: MOYSKLAD_IDS,
        readOnly: config.MOYSKLAD_READ_ONLY,
      },
    }),
    logger,
    ids: MOYSKLAD_IDS,
    overlapSeconds: config.MOYSKLAD_SYNC_OVERLAP_SECONDS,
    lock: { connectionString: config.DATABASE_URL },
  };

  try {
    const report = await performSyncOnce(config, deps);
    logger.info({ code: report.code, pass: report.result?.kind ?? null }, report.reason);
    await auditManualPass(deps, report.result?.kind ?? String(report.code));
    return report.code;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // Текст ошибки очищается: строка подключения и фильтры не должны попасть в вывод.
    const message = error instanceof Error ? error.message : String(error);
    console.error('Не удалось выполнить проход:', redactString(message));
    process.exit(1);
  });
