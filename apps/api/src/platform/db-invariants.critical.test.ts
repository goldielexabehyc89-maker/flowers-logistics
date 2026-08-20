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

import { randomUUID } from 'node:crypto';
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

  describe('производственная область строго шире логистической', () => {
    /**
     * Вставка «как у прежней версии»: колонки `fulfillmentInScope` в списке нет
     * вовсе. Именно так пишет код, развёрнутый до этой миграции, — и именно
     * этот случай база обязана дополнить сама.
     */
    async function insertWithoutFulfillmentColumn(inScope: boolean): Promise<string> {
      const externalId = randomUUID();
      await db.$executeRaw`
        INSERT INTO "DeliveryOrder" (
          "id", "externalId", "externalName", "externalUpdated", "externalMoment",
          "sumMinor", "payedSumMinor", "cashToCollectMinor",
          "inScope", "sourceArchived", "sourceMissing", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid(), ${externalId}::uuid, 'INV', now(), now(),
          0, 0, 0, ${inScope}, false, false, now(), now()
        )
      `;
      return externalId;
    }

    async function scopesOf(
      externalId: string,
    ): Promise<{ inScope: boolean; fulfillment: boolean }> {
      const order = await db.deliveryOrder.findUniqueOrThrow({
        where: { externalId },
        select: { inScope: true, fulfillmentInScope: true },
      });
      return { inScope: order.inScope, fulfillment: order.fulfillmentInScope };
    }

    it('вставка без новой колонки всё равно попадает в производственную область', async () => {
      const externalId = await insertWithoutFulfillmentColumn(true);

      expect(await scopesOf(externalId)).toEqual({ inScope: true, fulfillment: true });
    });

    it('заказ вне логистической области новую колонку не получает даром', async () => {
      const externalId = await insertWithoutFulfillmentColumn(false);

      // Значение по умолчанию не превращается в безусловное включение всех строк.
      expect(await scopesOf(externalId)).toEqual({ inScope: false, fulfillment: false });
    });

    it('возврат в логистическую область через UPDATE тоже дополняется', async () => {
      const externalId = await insertWithoutFulfillmentColumn(false);

      await db.$executeRaw`
        UPDATE "DeliveryOrder" SET "inScope" = true WHERE "externalId" = ${externalId}::uuid
      `;

      expect(await scopesOf(externalId)).toEqual({ inScope: true, fulfillment: true });
    });

    it('самовывоз и явный выход из обеих областей текущим кодом сохраняются как есть', async () => {
      const pickup = randomUUID();
      const foreign = randomUUID();

      await db.deliveryOrder.create({
        data: {
          externalId: pickup,
          externalName: 'PICKUP',
          externalUpdated: new Date(),
          externalMoment: new Date(),
          sumMinor: 0n,
          payedSumMinor: 0n,
          cashToCollectMinor: 0n,
          inScope: false,
          fulfillmentInScope: true,
        },
      });
      await db.deliveryOrder.create({
        data: {
          externalId: foreign,
          externalName: 'FOREIGN',
          externalUpdated: new Date(),
          externalMoment: new Date(),
          sumMinor: 0n,
          payedSumMinor: 0n,
          cashToCollectMinor: 0n,
          inScope: false,
          fulfillmentInScope: false,
        },
      });

      expect(await scopesOf(pickup)).toEqual({ inScope: false, fulfillment: true });
      expect(await scopesOf(foreign)).toEqual({ inScope: false, fulfillment: false });
    });

    it('инвариант записан ограничением, а не только триггером', async () => {
      const constraint = await db.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname = 'DeliveryOrder_fulfillment_scope_covers_logistics'
      `;

      expect(constraint).toHaveLength(1);
      expect(constraint[0]?.definition).toContain('fulfillmentInScope');
    });
  });

  /*
   * Складская выдача: отметки проверки и привязки маршрутных полок.
   *
   * Оба инварианта держит база, а не приложение. Приложение можно обойти
   * вторым процессом, прямым запросом или будущей правкой — полка, занятая
   * двумя листами сразу, и вторая действующая отметка на тот же заказ
   * означают разъехавшийся счётчик и коробки, уехавшие дважды.
   */
  describe('инварианты выдачи маршрутного листа', () => {
    async function createRoute(createdById: string, courierUserId: string): Promise<string> {
      const route = await db.deliveryRoute.create({
        data: {
          number: `INV-${process.hrtime.bigint() % 1_000_000n}`,
          deliveryDate: new Date('2028-02-02T00:00:00.000Z'),
          state: 'CONFIRMED',
          vehicleType: 'CAR',
          createdById,
          courierUserId,
        },
        select: { id: true },
      });
      return route.id;
    }

    async function createOrder(): Promise<string> {
      const order = await db.deliveryOrder.create({
        data: {
          externalId: randomUUID(),
          externalName: `INVO-${process.hrtime.bigint() % 1_000_000n}`,
          externalUpdated: new Date(),
          inScope: true,
        },
        select: { id: true },
      });
      return order.id;
    }

    async function createCell(createdById: string): Promise<string> {
      const code = `INVC-${process.hrtime.bigint() % 1_000_000n}`;
      const cell = await db.storageCell.create({
        data: { code, normalizedCode: code, kind: 'ROUTE', createdById },
        select: { id: true },
      });
      return cell.id;
    }

    async function createSession(routeId: string, userId: string): Promise<string> {
      const session = await db.routeIssueSession.create({
        data: {
          routeId,
          courierUserId: userId,
          state: 'OPEN',
          openKey: routeId,
          confirmedById: userId,
        },
        select: { id: true },
      });
      return session.id;
    }

    it('второй действующей отметки на тот же заказ не существует', async () => {
      const user = await createUser();
      const routeId = await createRoute(user, user);
      const sessionId = await createSession(routeId, user);
      const orderId = await createOrder();

      await db.routeIssueCheck.create({ data: { sessionId, orderId, checkedById: user } });

      await expect(
        db.routeIssueCheck.create({ data: { sessionId, orderId, checkedById: user } }),
      ).rejects.toThrow();
    });

    it('снятая отметка освобождает место для новой', async () => {
      const user = await createUser();
      const routeId = await createRoute(user, user);
      const sessionId = await createSession(routeId, user);
      const orderId = await createOrder();

      const first = await db.routeIssueCheck.create({
        data: { sessionId, orderId, checkedById: user },
        select: { id: true },
      });
      await db.routeIssueCheck.update({
        where: { id: first.id },
        data: { clearedAt: new Date(), clearedById: user },
      });

      // Сброс закрывает отметку, а не стирает: после него лист вносят заново.
      const second = await db.routeIssueCheck.create({
        data: { sessionId, orderId, checkedById: user },
        select: { id: true },
      });
      expect(second.id).not.toBe(first.id);
    });

    it('снятие отметки без автора база не принимает', async () => {
      const user = await createUser();
      const routeId = await createRoute(user, user);
      const sessionId = await createSession(routeId, user);
      const orderId = await createOrder();

      const check = await db.routeIssueCheck.create({
        data: { sessionId, orderId, checkedById: user },
        select: { id: true },
      });

      // Кто сбросил проверку — это ответ на вопрос «почему счётчик обнулился».
      await expect(
        db.routeIssueCheck.update({ where: { id: check.id }, data: { clearedAt: new Date() } }),
      ).rejects.toThrow();
    });

    it('отметку нельзя удалить: история внесения не переписывается', async () => {
      const user = await createUser();
      const routeId = await createRoute(user, user);
      const sessionId = await createSession(routeId, user);
      const orderId = await createOrder();

      const check = await db.routeIssueCheck.create({
        data: { sessionId, orderId, checkedById: user },
        select: { id: true },
      });

      await expect(db.routeIssueCheck.delete({ where: { id: check.id } })).rejects.toThrow();
    });

    it('одна полка не может принадлежать двум листам сразу', async () => {
      const user = await createUser();
      const cellId = await createCell(user);
      const first = await createRoute(user, user);
      const second = await createRoute(user, user);

      await db.routeCellBinding.create({
        data: { routeId: first, cellId, cellKind: 'ROUTE', boundById: user },
      });

      await expect(
        db.routeCellBinding.create({
          data: { routeId: second, cellId, cellKind: 'ROUTE', boundById: user },
        }),
      ).rejects.toThrow();
    });

    it('одну полку нельзя привязать к листу дважды', async () => {
      const user = await createUser();
      const cellId = await createCell(user);
      const routeId = await createRoute(user, user);

      await db.routeCellBinding.create({
        data: { routeId, cellId, cellKind: 'ROUTE', boundById: user },
      });

      await expect(
        db.routeCellBinding.create({
          data: { routeId, cellId, cellKind: 'ROUTE', boundById: user },
        }),
      ).rejects.toThrow();
    });

    it('у листа может быть НЕСКОЛЬКО полок одновременно', async () => {
      const user = await createUser();
      const routeId = await createRoute(user, user);
      const first = await createCell(user);
      const second = await createCell(user);

      await db.routeCellBinding.create({
        data: { routeId, cellId: first, cellKind: 'ROUTE', boundById: user },
      });
      await db.routeCellBinding.create({
        data: { routeId, cellId: second, cellKind: 'ROUTE', boundById: user },
      });

      // Ровно то, ради чего снималось прежнее ограничение: коробки одного
      // листа физически не помещаются на одну полку.
      expect(await db.routeCellBinding.count({ where: { routeId, releasedAt: null } })).toBe(2);
    });

    it('освобождённая полка достаётся другому листу', async () => {
      const user = await createUser();
      const cellId = await createCell(user);
      const first = await createRoute(user, user);
      const second = await createRoute(user, user);

      const binding = await db.routeCellBinding.create({
        data: { routeId: first, cellId, cellKind: 'ROUTE', boundById: user },
        select: { id: true },
      });
      await db.routeCellBinding.update({
        where: { id: binding.id },
        data: { releasedAt: new Date(), releasedById: user },
      });

      const moved = await db.routeCellBinding.create({
        data: { routeId: second, cellId, cellKind: 'ROUTE', boundById: user },
        select: { routeId: true },
      });
      expect(moved.routeId).toBe(second);
    });
  });
});
