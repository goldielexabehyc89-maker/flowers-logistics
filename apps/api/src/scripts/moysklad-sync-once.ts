/**
 * Один проход синхронизации МоегоСклада вручную.
 *
 * Нужен для будущего закрытого production-пилота: позволяет выполнить импорт,
 * не включая автоматический worker. Поэтому команда НЕ требует
 * `MOYSKLAD_SYNC_ENABLED=true`, но требует production-маркер и токен.
 *
 * Команда берёт ту же аренду прохода, что и worker, поэтому одновременно
 * с фоновым проходом не выполняется.
 *
 *   npm run moysklad:sync-once
 */

import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { MoyskladClient } from '../modules/integrations/moysklad/client.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from '../modules/integrations/moysklad/config.js';
import { auditManualPass, runSyncOnce } from '../modules/integrations/moysklad/sync.js';

async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);

  if (config.APP_ENVIRONMENT_MARKER !== 'production') {
    logger.error('команда доступна только при APP_ENVIRONMENT_MARKER=production');
    return 2;
  }
  if (config.MOYSKLAD_TOKEN === undefined) {
    logger.error('команда требует MOYSKLAD_TOKEN');
    return 2;
  }

  const db = createDatabase(config, logger);
  const client = new MoyskladClient({
    config: { baseUrl: MOYSKLAD_BASE_URL, token: config.MOYSKLAD_TOKEN, ids: MOYSKLAD_IDS },
  });

  const deps = {
    db,
    client,
    logger,
    ids: MOYSKLAD_IDS,
    overlapSeconds: config.MOYSKLAD_SYNC_OVERLAP_SECONDS,
  };

  try {
    const result = await runSyncOnce(deps, {
      intervalMs: config.MOYSKLAD_SYNC_INTERVAL_SECONDS * 1000,
      allowReconciliation: true,
    });

    if (result.kind === 'skipped') {
      logger.warn('проход уже выполняется другим процессом, повтор не требуется');
      await auditManualPass(deps, 'skipped');
      return 3;
    }

    logger.info(
      {
        pass: result.kind,
        pages: result.pages,
        processed: result.processed,
        created: result.created,
        updated: result.updated,
        skippedOutOfScope: result.skippedOutOfScope,
        missing: result.missing,
      },
      'проход синхронизации завершён',
    );
    await auditManualPass(deps, result.kind);
    return 0;
  } catch (error) {
    logger.error({ err: error }, 'проход синхронизации завершился ошибкой');
    await auditManualPass(deps, 'failed');
    return 1;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('Не удалось выполнить проход:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
