/**
 * Прогрессивная блокировка перебора.
 *
 * Четырёхзначный PIN даёт всего 10 000 комбинаций, поэтому ограничение попыток —
 * основная защита входа. Счётчики живут в PostgreSQL: Redis в проекте нет намеренно,
 * а храненить их в памяти процесса нельзя — перезапуск обнулил бы защиту.
 *
 * Счёт ведётся отдельно по телефону и по IP: атака с одного адреса по многим номерам
 * и атака по одному номеру с разных адресов — разные сценарии.
 */

import type { TransactionClient } from './sessions.js';

/** Пороги: при достижении количества неудач вход блокируется на указанное время. */
export const LOCKOUT_THRESHOLDS: ReadonlyArray<{ failures: number; lockMs: number }> = [
  { failures: 10, lockMs: 2 * 60 * 60 * 1000 },
  { failures: 7, lockMs: 30 * 60 * 1000 },
  { failures: 5, lockMs: 5 * 60 * 1000 },
  { failures: 3, lockMs: 30 * 1000 },
];

export function phoneKey(normalizedPhone: string): string {
  return `phone:${normalizedPhone}`;
}

export function ipKey(ip: string): string {
  return `ip:${ip}`;
}

/** Возвращает длительность блокировки для накопленного числа неудач. */
export function lockDurationFor(failures: number): number | null {
  for (const threshold of LOCKOUT_THRESHOLDS) {
    if (failures >= threshold.failures) {
      return threshold.lockMs;
    }
  }
  return null;
}

export interface LockoutState {
  locked: boolean;
  /** Сколько секунд ждать до следующей попытки; используется в заголовке Retry-After. */
  retryAfterSeconds: number;
}

/** Проверяет, заблокирован ли хотя бы один из ключей. */
export async function checkLockout(
  db: TransactionClient,
  keys: readonly string[],
): Promise<LockoutState> {
  if (keys.length === 0) {
    return { locked: false, retryAfterSeconds: 0 };
  }

  const now = new Date();
  const rows = await db.authLockout.findMany({
    where: { key: { in: [...keys] }, lockedUntil: { gt: now } },
    select: { lockedUntil: true },
  });

  if (rows.length === 0) {
    return { locked: false, retryAfterSeconds: 0 };
  }

  const longest = rows.reduce((max, row) => {
    const until = row.lockedUntil?.getTime() ?? 0;
    return until > max ? until : max;
  }, 0);

  return {
    locked: true,
    retryAfterSeconds: Math.max(1, Math.ceil((longest - now.getTime()) / 1000)),
  };
}

/**
 * Фиксирует неудачную попытку и при необходимости включает блокировку.
 * Открытый PIN или код сюда не передаётся и нигде не сохраняется.
 */
export async function registerFailure(
  db: TransactionClient,
  keys: readonly string[],
): Promise<void> {
  const now = new Date();

  for (const key of keys) {
    const existing = await db.authLockout.findUnique({
      where: { key },
      select: { failedCount: true, lockedUntil: true },
    });

    // Истёкшая блокировка сбрасывает счётчик: иначе пользователь, однажды ошибшийся
    // несколько раз, навсегда остался бы у верхнего порога.
    const previousLock = existing?.lockedUntil ?? null;
    const lockExpired = previousLock !== null && previousLock.getTime() <= now.getTime();
    const previous = existing === null || lockExpired ? 0 : existing.failedCount;
    const failedCount = previous + 1;
    const lockMs = lockDurationFor(failedCount);
    const lockedUntil = lockMs === null ? null : new Date(now.getTime() + lockMs);

    await db.authLockout.upsert({
      where: { key },
      create: { key, failedCount, firstFailedAt: now, lastFailedAt: now, lockedUntil },
      update: { failedCount, lastFailedAt: now, lockedUntil },
    });
  }
}

/** Сбрасывает счётчики после успешного входа или активации. */
export async function resetFailures(db: TransactionClient, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  await db.authLockout.deleteMany({ where: { key: { in: [...keys] } } });
}
