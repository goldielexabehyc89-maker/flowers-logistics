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
import { escalateOverdueResolutions } from '../modules/notifications/escalation.js';

export const SUCCESSOR_CLEANUP_INTERVAL_MS = 60_000;
export const REALTIME_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
/** Как часто проверять задачи логиста на просрочку >30 мин без реакции. */
export const ESCALATION_SWEEP_INTERVAL_MS = 60_000;
/**
 * Очистка просроченных матриц.
 *
 * Реже остальных: матрицы живут сутками, и убирать их чаще незачем — лишний
 * проход по таблице ничего не освобождает, а нагрузку создаёт.
 */
export const MATRIX_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

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

/**
 * Удаляет просроченные записи кэша матриц.
 *
 * Без неё таблица растёт вечно: просроченная матрица всё равно не используется,
 * а строка с двумя матрицами на шестьдесят точек весит заметно.
 */
export async function cleanupExpiredMatrixCache(deps: MaintenanceDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();

  const result = await deps.db.routeMatrixCache.deleteMany({
    where: { expiresAt: { lt: now } },
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
  /** Запрещает новые проходы и дожидается выполняющихся. */
  stop: () => Promise<void>;
  /** Один проход всех задач; используется при старте и в тестах. */
  runOnce: () => Promise<{
    successorTokens: number;
    realtimeEvents: number;
    matrixEntries: number;
    escalations: number;
  }>;
}

interface Intervals {
  successorCleanup: number;
  realtimeCleanup: number;
  matrixCleanup: number;
  escalationSweep: number;
}

export function createMaintenanceRunner(
  deps: MaintenanceDeps,
  intervals: Intervals = {
    successorCleanup: SUCCESSOR_CLEANUP_INTERVAL_MS,
    realtimeCleanup: REALTIME_CLEANUP_INTERVAL_MS,
    matrixCleanup: MATRIX_CLEANUP_INTERVAL_MS,
    escalationSweep: ESCALATION_SWEEP_INTERVAL_MS,
  },
): MaintenanceRunner {
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;
  let successorInFlight: Promise<number> | null = null;
  let realtimeInFlight: Promise<number> | null = null;
  let matrixInFlight: Promise<number> | null = null;
  let escalationInFlight: Promise<number> | null = null;

  const runSuccessorCleanup = async (): Promise<number> => {
    if (successorInFlight !== null || stopped) {
      return 0;
    }
    const pass = (async (): Promise<number> => {
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
      }
    })();
    successorInFlight = pass;
    try {
      return await pass;
    } finally {
      successorInFlight = null;
    }
  };

  const runRealtimeCleanup = async (): Promise<number> => {
    if (realtimeInFlight !== null || stopped) {
      return 0;
    }
    const pass = (async (): Promise<number> => {
      try {
        const removed = await cleanupExpiredRealtimeEvents(deps);
        if (removed > 0) {
          deps.logger.info({ removed }, 'удалены просроченные realtime-события');
        }
        return removed;
      } catch (error) {
        deps.logger.error({ err: error }, 'очистка realtime-событий завершилась ошибкой');
        return 0;
      }
    })();
    realtimeInFlight = pass;
    try {
      return await pass;
    } finally {
      realtimeInFlight = null;
    }
  };

  const runMatrixCleanup = async (): Promise<number> => {
    if (matrixInFlight !== null || stopped) {
      return 0;
    }
    const pass = (async (): Promise<number> => {
      try {
        const removed = await cleanupExpiredMatrixCache(deps);
        if (removed > 0) {
          // Только количество: координаты в лог не попадают.
          deps.logger.info({ removed }, 'удалены просроченные матрицы');
        }
        return removed;
      } catch (error) {
        deps.logger.error({ err: error }, 'очистка кэша матриц завершилась ошибкой');
        return 0;
      }
    })();
    matrixInFlight = pass;
    try {
      return await pass;
    } finally {
      matrixInFlight = null;
    }
  };

  const runEscalationSweep = async (): Promise<number> => {
    if (escalationInFlight !== null || stopped) {
      return 0;
    }
    const pass = (async (): Promise<number> => {
      try {
        const now = (deps.now ?? (() => new Date()))();
        const count = await escalateOverdueResolutions(deps.db, { now });
        if (count > 0) {
          deps.logger.info({ escalated: count }, 'эскалированы задачи логиста без реакции >30 мин');
        }
        return count;
      } catch (error) {
        deps.logger.error({ err: error }, 'эскалация задач логиста завершилась ошибкой');
        return 0;
      }
    })();
    escalationInFlight = pass;
    try {
      return await pass;
    } finally {
      escalationInFlight = null;
    }
  };

  return {
    start() {
      if (timers.length > 0) {
        return;
      }
      stopped = false;
      const successorTimer = setInterval(
        () => void runSuccessorCleanup(),
        intervals.successorCleanup,
      );
      const realtimeTimer = setInterval(() => void runRealtimeCleanup(), intervals.realtimeCleanup);
      const matrixTimer = setInterval(() => void runMatrixCleanup(), intervals.matrixCleanup);
      const escalationTimer = setInterval(
        () => void runEscalationSweep(),
        intervals.escalationSweep,
      );
      successorTimer.unref();
      realtimeTimer.unref();
      matrixTimer.unref();
      escalationTimer.unref();
      timers.push(successorTimer, realtimeTimer, matrixTimer, escalationTimer);
    },
    /**
     * Снимает таймеры и дожидается уже начатых проходов.
     *
     * Иначе очистка продолжила бы работать с базой, которую вызывающая
     * сторона закрывает сразу после остановки.
     */
    async stop() {
      stopped = true;
      for (const timer of timers) {
        clearInterval(timer);
      }
      timers.length = 0;
      await Promise.allSettled([
        successorInFlight,
        realtimeInFlight,
        matrixInFlight,
        escalationInFlight,
      ]);
    },
    async runOnce() {
      return {
        successorTokens: await runSuccessorCleanup(),
        realtimeEvents: await runRealtimeCleanup(),
        matrixEntries: await runMatrixCleanup(),
        escalations: await runEscalationSweep(),
      };
    },
  };
}
