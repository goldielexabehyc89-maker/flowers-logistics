/**
 * Общая обвязка критических тестов авторизации.
 *
 * Тесты работают с настоящей PostgreSQL: логика опирается на транзакции,
 * блокировки строк и advisory-локи, которые невозможно достоверно изобразить моками.
 */

import { pino } from 'pino';
import type { Role } from '@fl/shared';
import { loadConfig, type AppConfig } from '../../../platform/config.js';
import { createDatabase, type Database } from '../../../platform/db.js';
import { resolveTestDatabaseUrl } from '../../../platform/testing/test-database.js';
import { TEST_SECRETS } from '../../../platform/testing/secrets.js';
import { buildServer } from '../../../platform/http/server.js';
import type { AppServer } from '../../../platform/http/types.js';

export { TEST_SECRETS };

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: resolveTestDatabaseUrl(),
    APP_ENV: 'local',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...TEST_SECRETS,
    ...overrides,
  });
}

/** Логгер в никуда: тесты не должны засорять вывод. */
function silentLogger() {
  return pino({ level: 'silent' });
}

export interface TestContext {
  db: Database;
  config: AppConfig;
  app: AppServer;
}

export async function createTestContext(): Promise<TestContext> {
  const config = testConfig();
  const db = createDatabase(config, silentLogger());
  const app = await buildServer({ config, logger: silentLogger(), db });
  return { db, config, app };
}

export async function closeTestContext(context: TestContext): Promise<void> {
  await context.app.close();
  await context.db.$disconnect();
}

/**
 * Уникальный телефон на каждый вызов: тестовых пользователей нельзя удалить,
 * поэтому фиксированные номера сделали бы тесты одноразовыми.
 */
export function uniquePhone(): string {
  const tail = String(process.hrtime.bigint() % 1_000_000_000n).padStart(9, '0');
  return `+79${tail}`;
}

/** Создаёт пользователя напрямую в базе, минуя API: нужен как фикстура. */
export async function seedUser(
  db: Database,
  options: {
    roles: Role[];
    status?: 'PENDING_ACTIVATION' | 'ACTIVE' | 'FROZEN';
    phone?: string;
    fullName?: string;
    pinHash?: string | null;
  },
): Promise<{ id: string; phone: string }> {
  const phone = options.phone ?? uniquePhone();

  const user = await db.user.create({
    data: {
      phone,
      fullName: options.fullName ?? 'Тестовый пользователь',
      status: options.status ?? 'ACTIVE',
      pinHash: options.pinHash ?? null,
      ...(options.pinHash === undefined || options.pinHash === null
        ? {}
        : { pinSetAt: new Date() }),
      roles: { create: options.roles.map((role) => ({ role })) },
      ...(options.roles.includes('COURIER') ? { courierProfile: { create: {} } } : {}),
    },
    select: { id: true, phone: true },
  });

  return user;
}
