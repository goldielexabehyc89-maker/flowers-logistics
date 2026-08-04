/**
 * Критическая проверка инвариантов базы данных.
 *
 * Проверяется реальная PostgreSQL 16 с применёнными миграциями:
 *  * аудит неизменяем (UPDATE и DELETE запрещены);
 *  * пользователи и профили курьеров физически не удаляются;
 *  * у пользователя не может быть двух активных кодов активации одновременно;
 *  * у настройки не может быть двух текущих версий одновременно.
 *
 * Требуется переменная DATABASE_URL. Тест не «пропускается молча»: без базы он падает,
 * потому что молчаливый пропуск создаёт ложное ощущение проверенной защиты.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

const databaseUrl = process.env.DATABASE_URL;
const suffix = process.env.VITEST_WORKER_ID ?? '0';

let db: PrismaClient;

/**
 * Уникальный телефон для каждого прогона.
 * Тестовые пользователи остаются в базе разработки навсегда — удалить их нельзя by design,
 * поэтому фиксированные номера сделали бы тест одноразовым.
 */
function uniquePhone(): string {
  const tail = String(process.hrtime.bigint() % 1_000_000_000n).padStart(9, '0');
  return `+79${tail}`;
}

beforeAll(() => {
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'DATABASE_URL не задан. Запускайте критические тесты через docker compose (см. README).',
    );
  }
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
});

afterAll(async () => {
  // Пользователей удалить нельзя by design, поэтому тестовые записи остаются в базе
  // разработки. Это осознанно: проверка ровно про невозможность удаления.
  await db?.$disconnect();
});

async function createUser(): Promise<string> {
  const user = await db.user.create({
    data: { phone: uniquePhone(), fullName: 'Тестовый пользователь' },
    select: { id: true },
  });
  return user.id;
}

describe('инварианты базы данных', () => {
  it('аудит нельзя изменить', async () => {
    const entry = await db.auditLog.create({
      data: { action: 'TEST_ACTION', entityType: 'Test', actorRoles: ['ADMIN'] },
      select: { id: true },
    });

    await expect(
      db.auditLog.update({ where: { id: entry.id }, data: { action: 'ПОДМЕНА' } }),
    ).rejects.toThrow();

    const stored = await db.auditLog.findUniqueOrThrow({ where: { id: entry.id } });
    expect(stored.action).toBe('TEST_ACTION');
  });

  it('аудит нельзя удалить', async () => {
    const entry = await db.auditLog.create({
      data: { action: 'TEST_ACTION_DELETE', entityType: 'Test', actorRoles: [] },
      select: { id: true },
    });

    await expect(db.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow();
    await expect(db.auditLog.findUniqueOrThrow({ where: { id: entry.id } })).resolves.toBeTruthy();
  });

  it('пользователя нельзя удалить физически', async () => {
    const userId = await createUser();

    await expect(db.user.delete({ where: { id: userId } })).rejects.toThrow();

    const stored = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.status).toBe('PENDING_ACTIVATION');
  });

  it('профиль курьера нельзя удалить физически', async () => {
    const userId = await createUser();
    await db.courierProfile.create({ data: { userId } });

    await expect(db.courierProfile.delete({ where: { userId } })).rejects.toThrow();
    await expect(db.courierProfile.findUniqueOrThrow({ where: { userId } })).resolves.toBeTruthy();
  });

  it('у пользователя не может быть двух активных кодов активации', async () => {
    const userId = await createUser();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await db.activationCode.create({
      data: { userId, codeHash: 'hash-1', expiresAt, activeKey: userId },
    });

    await expect(
      db.activationCode.create({
        data: { userId, codeHash: 'hash-2', expiresAt, activeKey: userId },
      }),
    ).rejects.toThrow();

    // После инвалидации предыдущего кода новый выдать можно.
    await db.activationCode.updateMany({
      where: { userId, activeKey: userId },
      data: { activeKey: null, invalidatedAt: new Date() },
    });

    await expect(
      db.activationCode.create({
        data: { userId, codeHash: 'hash-3', expiresAt, activeKey: userId },
      }),
    ).resolves.toBeTruthy();
  });

  it('у настройки не может быть двух текущих версий', async () => {
    const key = `test.setting.${suffix}.${process.hrtime.bigint()}`;

    await db.systemSetting.create({
      data: { key, version: 1, value: { enabled: true }, currentKey: key },
    });

    await expect(
      db.systemSetting.create({
        data: { key, version: 2, value: { enabled: false }, currentKey: key },
      }),
    ).rejects.toThrow();
  });

  it('ключ идемпотентности outbox уникален', async () => {
    const idempotencyKey = `test.outbox.${suffix}.${process.hrtime.bigint()}`;

    await db.outboxMessage.create({
      data: { topic: 'test.ping', idempotencyKey, payload: { value: 1 } },
    });

    await expect(
      db.outboxMessage.create({
        data: { topic: 'test.ping', idempotencyKey, payload: { value: 2 } },
      }),
    ).rejects.toThrow();
  });
});
