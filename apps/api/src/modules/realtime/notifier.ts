/**
 * Слушатель сигналов PostgreSQL.
 *
 * `LISTEN/NOTIFY` только ускоряет доставку: полезной нагрузки в сигнале нет,
 * подписчик обязан перечитать базу. Поэтому обрыв слушателя не приводит к потере
 * событий — они всё равно будут прочитаны периодическим опросом.
 *
 * Соединение восстанавливается само: без этого канал молча «замирал» бы
 * после первой же сетевой ошибки.
 */

import { Client } from 'pg';
import type { AppLogger } from '../../platform/logging/logger.js';
import { REALTIME_NOTIFY_CHANNEL } from './events.js';

const RECONNECT_DELAY_MS = 2000;

export interface Notifier {
  /** Подписка на сигнал. Возвращает функцию отписки. */
  subscribe: (listener: () => void) => () => void;
  start: () => void;
  stop: () => Promise<void>;
}

export function createNotifier(connectionString: string, logger: AppLogger): Notifier {
  const listeners = new Set<() => void>();
  let client: Client | null = null;
  let stopped = false;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const notifyAll = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        logger.warn({ err: error }, 'подписчик realtime упал при обработке сигнала');
      }
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
    reconnectTimer.unref();
  };

  const connect = (): void => {
    if (stopped) {
      return;
    }

    const connection = new Client({ connectionString });
    client = connection;

    connection.on('notification', () => notifyAll());
    connection.on('error', (error) => {
      logger.warn({ err: error }, 'слушатель realtime потерял соединение');
      void connection.end().catch(() => undefined);
      if (client === connection) {
        client = null;
      }
      scheduleReconnect();
    });

    connection
      .connect()
      .then(() => connection.query(`LISTEN ${REALTIME_NOTIFY_CHANNEL}`))
      .then(() => {
        logger.info('слушатель realtime подключён');
      })
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'не удалось подключить слушателя realtime');
        if (client === connection) {
          client = null;
        }
        scheduleReconnect();
      });
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      stopped = false;
      connect();
    },
    async stop() {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      listeners.clear();
      const connection = client;
      client = null;
      if (connection !== null) {
        await connection.end().catch(() => undefined);
      }
    },
  };
}
