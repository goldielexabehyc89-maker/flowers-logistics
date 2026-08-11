/**
 * Фоновый исполнитель расчётов планирования.
 *
 * Расчёт не выполняется прямо в HTTP-запросе намеренно: матрица и решатель
 * работают секунды, а иногда десятки секунд, и запрос, висящий всё это время,
 * оборвался бы на первом же прокси. Логист ставит расчёт в очередь и видит
 * его состояние; готовое превью приходит событием.
 *
 * Один проход делает ровно один шаг: берёт один запуск и считает его. Это
 * упрощает и остановку процесса, и тесты — они вызывают `runOnce()` и получают
 * предсказуемый результат вместо гонки с таймером.
 */

import type { AppLogger } from '../../platform/logging/logger.js';
import {
  claimRun,
  computeRun,
  failExhaustedRuns,
  type ComputeResult,
  type PlanningDeps,
} from './service.js';

export interface PlanningPassResult {
  /** Запуск, взятый в работу за этот проход. `null` — очередь пуста. */
  runId: string | null;
  result: ComputeResult | null;
  /** Сколько запусков закрыто как исчерпавшие восстановления. */
  exhausted: number;
}

export async function runPlanningOnce(deps: PlanningDeps): Promise<PlanningPassResult> {
  const exhausted = await failExhaustedRuns(deps);

  const claimed = await claimRun(deps);
  if (claimed === null) {
    return { runId: null, result: null, exhausted };
  }

  const result = await computeRun(deps, claimed.id);
  return { runId: claimed.id, result, exhausted };
}

export interface PlanningRunner {
  start: () => void;
  stop: () => Promise<void>;
  runOnce: () => Promise<PlanningPassResult>;
}

export function createPlanningRunner(
  deps: PlanningDeps & { logger: AppLogger },
  intervalMs = 5000,
): PlanningRunner {
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
        await runPlanningOnce(deps);
      } catch (error) {
        deps.logger.error({ err: error }, 'проход планирования завершился ошибкой');
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
    runOnce: () => runPlanningOnce(deps),
  };
}
