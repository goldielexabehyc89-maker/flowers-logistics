/**
 * Один проход синхронизации по прямой команде.
 *
 * Логика вынесена из скрипта, чтобы её можно было проверить тестами: сам скрипт
 * остаётся тонкой обёрткой над этой функцией.
 *
 * Команда не требует `MOYSKLAD_SYNC_ENABLED=true` — она нужна для закрытого
 * production-пилота, когда автоматический worker ещё выключен. Но production
 * обязателен по обоим признакам, и токен обязателен: без них не создаются
 * ни соединение, ни блокировка, ни сетевой клиент.
 */

import type { AppConfig } from '../../../platform/config.js';
import { runSyncOnce, type PassResult, type SyncDeps } from './sync.js';

export type SyncOnceCode =
  | 0 // проход выполнен
  | 1 // проход завершился ошибкой
  | 2 // окружение не позволяет запуск
  | 3; // проход уже выполняется другим процессом

export interface SyncOnceReport {
  code: SyncOnceCode;
  reason: string;
  result: PassResult | null;
}

/** Проверяет окружение до создания каких-либо ресурсов. */
export function checkSyncOnceEnvironment(config: AppConfig): SyncOnceReport | null {
  if (config.APP_ENV !== 'production' || config.APP_ENVIRONMENT_MARKER !== 'production') {
    return {
      code: 2,
      reason: 'команда доступна только при APP_ENV=production и APP_ENVIRONMENT_MARKER=production',
      result: null,
    };
  }
  if (config.MOYSKLAD_TOKEN === undefined) {
    return { code: 2, reason: 'команда требует MOYSKLAD_TOKEN', result: null };
  }
  return null;
}

export async function performSyncOnce(config: AppConfig, deps: SyncDeps): Promise<SyncOnceReport> {
  const rejected = checkSyncOnceEnvironment(config);
  if (rejected !== null) {
    return rejected;
  }

  try {
    const result = await runSyncOnce(deps, {
      intervalMs: config.MOYSKLAD_SYNC_INTERVAL_SECONDS * 1000,
      allowReconciliation: true,
    });

    if (result.kind === 'skipped') {
      return { code: 3, reason: 'проход уже выполняется другим процессом', result };
    }
    return { code: 0, reason: 'проход завершён', result };
  } catch {
    // Текст внешней ошибки наружу не выносится: он может содержать
    // адрес запроса с фильтрами.
    return { code: 1, reason: 'проход завершился ошибкой', result: null };
  }
}
