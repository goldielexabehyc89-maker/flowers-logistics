/**
 * Глобальная блокировка прохода синхронизации.
 *
 * Проход длится минуты и содержит сетевые вызовы, поэтому транзакционный
 * `pg_advisory_xact_lock` не подходит: он живёт ровно столько, сколько открыта
 * транзакция, а держать её открытой всё это время нельзя.
 *
 * Поэтому используется блокировка уровня СЕССИИ на отдельном соединении `pg`.
 * Она удерживается от проверки курсора до полного завершения прохода и снимается
 * в `finally`. Если процесс умрёт, PostgreSQL закроет соединение и освободит
 * блокировку сам — зависшего замка не остаётся.
 *
 * `pg_try_advisory_lock` вместо `pg_advisory_lock` выбран намеренно: второй worker
 * или ручной запуск должны немедленно получить «занято», а не выстроиться в очередь
 * и выполнить лишний проход следом.
 */

import { Client } from 'pg';

/** Ключ блокировки. Один и тот же у worker и ручной команды. */
export const SYNC_LOCK_KEY = 730_201n;

export interface SyncLock {
  release: () => Promise<void>;
}

export interface LockDeps {
  connectionString: string;
  /** Подменяется в тестах: настоящее соединение там не открывается. */
  connect?: (connectionString: string) => Promise<LockConnection>;
}

export interface LockConnection {
  tryLock: (key: bigint) => Promise<boolean>;
  unlock: (key: bigint) => Promise<void>;
  close: () => Promise<void>;
}

async function connectPg(connectionString: string): Promise<LockConnection> {
  const client = new Client({ connectionString });
  await client.connect();

  return {
    async tryLock(key) {
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [key.toString()],
      );
      return result.rows[0]?.locked === true;
    },
    async unlock(key) {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [key.toString()]);
    },
    async close() {
      await client.end();
    },
  };
}

/**
 * Пытается занять проход.
 * Возвращает `null`, если проход уже выполняется другим процессом.
 */
export async function acquireSyncLock(deps: LockDeps): Promise<SyncLock | null> {
  const connection = await (deps.connect ?? connectPg)(deps.connectionString);

  let locked = false;
  try {
    locked = await connection.tryLock(SYNC_LOCK_KEY);
  } catch (error) {
    await connection.close();
    throw error;
  }

  if (!locked) {
    await connection.close();
    return null;
  }

  return {
    async release() {
      try {
        await connection.unlock(SYNC_LOCK_KEY);
      } finally {
        // Соединение закрывается в любом случае: иначе блокировка держалась бы
        // до конца жизни процесса.
        await connection.close();
      }
    },
  };
}
