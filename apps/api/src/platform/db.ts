/**
 * Подключение к PostgreSQL.
 *
 * Prisma 7 работает через driver adapter: строка подключения передаётся клиенту явно,
 * а не читается из schema.prisma. Пул один на процесс.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import type { AppConfig } from './config.js';

export type Database = PrismaClient;

export function createDatabase(config: AppConfig): Database {
  const adapter = new PrismaPg({
    connectionString: config.DATABASE_URL,
    // Праздничная нагрузка обслуживается одним приложением; пул держим умеренным,
    // чтобы не исчерпать max_connections PostgreSQL.
    max: 20,
  });

  return new PrismaClient({
    adapter,
    // Логи запросов уходят в общий структурированный логгер приложения,
    // а не в stdout Prisma, чтобы к ним применялась редакция.
    log: config.isProduction ? ['warn', 'error'] : ['warn', 'error'],
  });
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
