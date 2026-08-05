/**
 * Фоновые очистки.
 *
 * Две задачи обязательны до staging:
 *  * затирание просроченных копий токена-преемника;
 *  * удаление realtime-событий за пределами окна хранения.
 *
 * Задачи не запускаются параллельно сами с собой, интервалы и часы инъецируются
 * в тестах, таймеры корректно останавливаются. Содержимое `successorTokenEnc`
 * никогда не логируется — только количество затронутых строк.
 */

import type { Database } from './db.js';
import type { AppLogger } from './logging/logger.js';

export const SUCCESSOR_CLEANUP_INTERVAL_MS = 60_000;
export const REALTIME_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

export interface MaintenanceDeps {
  db: Database;
  logger: AppLogger;
  now?: () => Date;
}

/**
 * Затирает копии преемников, чьё grace-окно истекло.
 *
 * Раньше очистка была ленивой: копия исчезала только при следующей работе
 * с той же семьёй сессий. Если устройство замолчало сразу после ротации,
 * зашифрованная копия оставалась в базе неограниченно долго.
 *
 * Сами refresh-сессии не удаляются и активное grace-окно не затрагивается.
 */
export async function cleanupExpiredSuccessorTokens(deps: MaintenanceDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();

  const result = await deps.db.refreshSession.updateMany({
    where: { successorTokenEnc: { not: null }, graceUntil: { lt: now } },
    data: { successorTokenEnc: null },
  });

  return result.count;
}

/** Удаляет realtime-события за пределами срока хранения. */
export async function cleanupExpiredRealtimeEvents(deps: MaintenanceDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();

  const result = await deps.db.realtimeEvent.deleteMany({
    where: { expiresAt: { lt: now } },
  });

  return result.count;
}

export interface MaintenanceRunner {
  start: () => void;
  stop: () => void;
  /** Один проход обеих задач; используется при старте и в тестах. */
  runOnce: () => Promise<{ successorTokens: number; realtimeEvents: number }>;
}

interface Intervals {
  successorCleanup: number;
  realtimeCleanup: number;
}

export function createMaintenanceRunner(
  deps: MaintenanceDeps,
  intervals: Intervals = {
    successorCleanup: SUCCESSOR_CLEANUP_INTERVAL_MS,
    realtimeCleanup: REALTIME_CLEANUP_INTERVAL_MS,
  },
): MaintenanceRunner {
  const timers: NodeJS.Timeout[] = [];
  let successorRunning = false;
  let realtimeRunning = false;

  const runSuccessorCleanup = async (): Promise<number> => {
    if (successorRunning) {
      return 0;
    }
    successorRunning = true;
    try {
      const cleaned = await cleanupExpiredSuccessorTokens(deps);
      if (cleaned > 0) {
        // В лог попадает только количество: содержимое поля секретно.
        deps.logger.info({ cleaned }, 'затёрты просроченные копии токена-преемника');
      }
      return cleaned;
    } catch (error) {
      deps.logger.error({ err: error }, 'очистка копий преемника завершилась ошибкой');
      return 0;
    } finally {
      successorRunning = false;
    }
  };

  const runRealtimeCleanup = async (): Promise<number> => {
    if (realtimeRunning) {
      return 0;
    }
    realtimeRunning = true;
    try {
      const removed = await cleanupExpiredRealtimeEvents(deps);
      if (removed > 0) {
        deps.logger.info({ removed }, 'удалены просроченные realtime-события');
      }
      return removed;
    } catch (error) {
      deps.logger.error({ err: error }, 'очистка realtime-событий завершилась ошибкой');
      return 0;
    } finally {
      realtimeRunning = false;
    }
  };

  return {
    start() {
      if (timers.length > 0) {
        return;
      }
      const successorTimer = setInterval(
        () => void runSuccessorCleanup(),
        intervals.successorCleanup,
      );
      const realtimeTimer = setInterval(() => void runRealtimeCleanup(), intervals.realtimeCleanup);
      successorTimer.unref();
      realtimeTimer.unref();
      timers.push(successorTimer, realtimeTimer);
    },
    stop() {
      for (const timer of timers) {
        clearInterval(timer);
      }
      timers.length = 0;
    },
    async runOnce() {
      return {
        successorTokens: await runSuccessorCleanup(),
        realtimeEvents: await runRealtimeCleanup(),
      };
    },
  };
}
