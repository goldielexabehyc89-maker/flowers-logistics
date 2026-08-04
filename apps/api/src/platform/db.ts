/**
 * Подключение к PostgreSQL.
 *
 * Prisma 7 работает через driver adapter: строка подключения передаётся клиенту явно,
 * а не читается из schema.prisma. Пул один на процесс.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import type { AppConfig } from './config.js';
import type { AppLogger } from './logging/logger.js';

export type Database = PrismaClient;

/** Событие лога Prisma при `emit: 'event'`. */
interface PrismaLogEvent {
  message: string;
  target: string;
}

export function createDatabase(config: AppConfig, logger: AppLogger): Database {
  const adapter = new PrismaPg({
    connectionString: config.DATABASE_URL,
    // Праздничная нагрузка обслуживается одним приложением; пул держим умеренным,
    // чтобы не исчерпать max_connections PostgreSQL.
    max: 20,
  });

  const db = new PrismaClient({
    adapter,
    // `emit: 'event'` обязателен. При выводе по умолчанию Prisma печатает сообщения
    // напрямую в stdout, минуя редакцию, а её сообщения об ошибках подключения
    // содержат строку подключения с паролем.
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });

  const forward = (level: 'warn' | 'error') => (event: PrismaLogEvent) => {
    // Текст события проходит через редакцию логгера вместе с остальными полями.
    logger[level]({ prisma: { target: event.target, message: event.message } }, 'событие Prisma');
  };

  db.$on('warn', forward('warn'));
  db.$on('error', forward('error'));

  return db;
}

/**
 * Проверка готовности БД для readiness-пробы.
 *
 * Ограничена по времени: проба, которая может висеть бесконечно, бесполезна —
 * балансировщик так и не узнает, что инстанс нездоров.
 */
export async function checkDatabase(db: Database, timeoutMs = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Проверка базы данных не уложилась в ${timeoutMs} мс`)),
      timeoutMs,
    );
  });

  try {
    await Promise.race([db.$queryRaw`SELECT 1`, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
