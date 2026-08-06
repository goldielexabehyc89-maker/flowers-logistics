/**
 * Планировщик фоновой синхронизации.
 *
 * `setInterval` здесь не используется намеренно: при проходе длиннее интервала
 * он поставил бы проходы внахлёст. Следующий запуск планируется только после
 * завершения предыдущего.
 *
 * Автоматический запуск возможен ровно при трёх условиях сразу: маркер
 * production, наличие токена и явно включённая синхронизация. Во всех остальных
 * окружениях worker не стартует и ни одного сетевого обращения не делает.
 */

import type { AppConfig } from '../../../platform/config.js';
import { runSyncOnce, setIntegrationStatus, type SyncDeps } from './sync.js';

export interface SyncWorker {
  start: () => void;
  stop: () => Promise<void>;
}

export function shouldRunAutomatically(config: AppConfig): boolean {
  return (
    config.APP_ENV === 'production' &&
    config.APP_ENVIRONMENT_MARKER === 'production' &&
    config.MOYSKLAD_TOKEN !== undefined &&
    config.MOYSKLAD_SYNC_ENABLED
  );
}

export function createSyncWorker(deps: SyncDeps, intervalMs: number): SyncWorker {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const scheduleNext = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    if (stopped || inFlight !== null) {
      return;
    }

    const pass = (async () => {
      try {
        await runSyncOnce(deps, { intervalMs, allowReconciliation: true });
      } catch (error) {
        // Проход уже записал состояние интеграции и запланировал backoff.
        // Здесь остаётся только не уронить процесс: приложение продолжает
        // работать по последней сохранённой копии заказов.
        deps.logger.error({ err: error }, 'проход синхронизации МоегоСклада завершился ошибкой');
      }
    })();

    inFlight = pass;
    try {
      await pass;
    } finally {
      inFlight = null;
      scheduleNext(intervalMs);
    }
  };

  return {
    start() {
      if (timer !== null) {
        return;
      }
      stopped = false;
      scheduleNext(intervalMs);
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight !== null) {
        await inFlight;
      }
    },
  };
}

/**
 * Отражает состояние интеграции при старте приложения.
 * Настроенная, но выключенная синхронизация — это `CONFIGURED`, а не ошибка.
 */
export async function reportStartupStatus(deps: SyncDeps, config: AppConfig): Promise<void> {
  if (config.MOYSKLAD_TOKEN === undefined) {
    await setIntegrationStatus(deps, 'NOT_CONFIGURED', { reason: 'no-token' });
    return;
  }
  if (!config.MOYSKLAD_SYNC_ENABLED) {
    await setIntegrationStatus(deps, 'CONFIGURED', { reason: 'sync-disabled' });
  }
}
