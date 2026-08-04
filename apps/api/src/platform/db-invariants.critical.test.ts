/**
 * Критическая проверка инвариантов базы данных.
 *
 * Проверяется реальная PostgreSQL 16 с применёнными миграциями:
 *  * аудит неизменяем (UPDATE и DELETE запрещены);
 *  * пользователи и профили курьеров физически не удаляются;
 *  * у пользователя не может быть двух активных кодов активации одновременно;
 *  * у настройки не может быть двух текущих версий одновременно.
 *
 * Тесты разрушающие: они создают записи, которые невозможно удалить (пользователи и аудит
 * защищены триггерами). Поэтому они допускаются только к одноразовой тестовой базе —
 * см. `platform/testing/test-database.ts`. Без неё тест падает, а не «пропускается молча»:
 * молчаливый пропуск создаёт ложное ощущение проверенной защиты.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { resolveTestDatabaseUrl } from './testing/test-database.js';

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
  // Бросает исключение, если база не является одноразовой тестовой.
  const connectionString = resolveTestDatabaseUrl();
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
});

afterAll(async () => {
  // Записи остаются в базе: удалить их нельзя by design. Именно поэтому тесты
  // работают с одноразовой базой, которая пересоздаётся ./scripts/reset-test-db.sh
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

  it('в activeKey нельзя записать чужое значение в обход уникальности', async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    // Уникальный индекс по activeKey работает, только если там лежит именно userId.
    // Произвольное значение обошло бы правило «не более одного активного кода»,
    // поэтому оно отклоняется CHECK-ограничением базы.
    await expect(
      db.activationCode.create({
        data: { userId, codeHash: 'hash-mismatch', expiresAt, activeKey: otherUserId },
      }),
    ).rejects.toThrow();

    // Корректное значение по-прежнему принимается.
    await expect(
      db.activationCode.create({
        data: { userId, codeHash: 'hash-correct', expiresAt, activeKey: userId },
      }),
    ).resolves.toBeTruthy();
  });

  it('в currentKey нельзя записать чужое значение в обход уникальности', async () => {
    const key = `test.setting.check.${suffix}.${process.hrtime.bigint()}`;

    await expect(
      db.systemSetting.create({
        data: { key, version: 1, value: { enabled: true }, currentKey: `${key}.другое` },
      }),
    ).rejects.toThrow();

    await expect(
      db.systemSetting.create({
        data: { key, version: 1, value: { enabled: true }, currentKey: key },
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
