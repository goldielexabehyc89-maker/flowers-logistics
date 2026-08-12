/**
 * Модель времени в базе: одна ли шкала у приложения и у самой PostgreSQL.
 *
 * Все колонки абсолютного времени объявлены как `TIMESTAMP(3) WITHOUT TIME ZONE`.
 * У такой колонки нет собственного часового пояса — есть только соглашение,
 * какое время в неё кладут. Соглашение проекта: там лежит UTC.
 *
 * Раньше соглашение держалось на одном лишь приложении. Сервер базы работал
 * в московском поясе, и значение, записанное самой базой (`CURRENT_TIMESTAMP`,
 * `now()`), ложилось на три часа впереди соглашения; ручной SQL при этом
 * показывал ложный сдвиг у совершенно исправных строк.
 *
 * Теперь пояс сервера задан явно: `timezone=UTC` в параметрах запуска и
 * `TZ`/`PGTZ=Etc/UTC` в окружении контейнера. Обе шкалы совпали, и тест это
 * требует, а не описывает: ненулевое смещение сессии больше не легализуется.
 *
 * Бизнес-пояс приложения при этом остаётся московским — это другой уровень
 * контракта (`docs/OWNER_DECISIONS.md`, `TZ-001`): база хранит абсолютную
 * шкалу, а «сегодня» и показ человеку считает приложение.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { resolveTestDatabaseUrl } from './testing/test-database.js';

let db: PrismaClient;

beforeAll(() => {
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: resolveTestDatabaseUrl() }) });
});

afterAll(async () => {
  await db?.$disconnect();
});

/** Смещение сессии базы относительно UTC в миллисекундах. */
async function sessionOffsetMs(): Promise<number> {
  const rows = await db.$queryRaw<{ offset_ms: number }[]>`
    SELECT EXTRACT(EPOCH FROM (localtimestamp - (now() AT TIME ZONE 'UTC'))) * 1000 AS offset_ms
  `;
  return Math.round(Number(rows[0]?.offset_ms ?? 0));
}

describe('шкала времени в базе', () => {
  it('момент, записанный приложением, читается тем же моментом', async () => {
    // Известное мгновение: если бы колонка молча жила в местном времени,
    // обратное чтение сдвинулось бы на смещение сессии.
    const known = new Date('2026-08-12T09:00:00.000Z');
    const key = `time.app.${randomUUID()}`;

    await db.outboxMessage.create({
      data: { topic: 'test.ping', idempotencyKey: key, payload: {}, createdAt: known },
    });

    const stored = await db.outboxMessage.findUniqueOrThrow({
      where: { idempotencyKey: key },
      select: { createdAt: true },
    });

    expect(stored.createdAt.toISOString()).toBe(known.toISOString());
  });

  it('значение по умолчанию тоже ставит приложение, а не база', async () => {
    // Поле опущено. Если бы срабатывал DEFAULT CURRENT_TIMESTAMP, отметка
    // ушла бы вперёд на смещение сессии; на деле её подставляет Prisma.
    const key = `time.default.${randomUUID()}`;
    const before = Date.now();
    const created = await db.outboxMessage.create({
      data: { topic: 'test.ping', idempotencyKey: key, payload: {} },
      select: { createdAt: true },
    });

    const skew = created.createdAt.getTime() - before;
    // Запас на сеть и планировщик, но заведомо меньше любого часового смещения.
    expect(Math.abs(skew)).toBeLessThan(60_000);
  });

  it('запись самой базой попадает в ту же шкалу, что и запись приложением', async () => {
    // Прежде здесь был промах в три часа: naive-колонка получала местное время
    // сессии, а приложение читало её как UTC. После явного UTC у сервера обе
    // записи обязаны лечь на одну шкалу.
    const key = `time.raw.${randomUUID()}`;
    const before = Date.now();

    await db.$executeRaw`
      INSERT INTO "OutboxMessage" ("id", "topic", "idempotencyKey", "payload", "updatedAt")
      VALUES (gen_random_uuid(), 'test.ping', ${key}, '{}'::jsonb, CURRENT_TIMESTAMP)
    `;

    const stored = await db.outboxMessage.findUniqueOrThrow({
      where: { idempotencyKey: key },
      select: { createdAt: true },
    });

    const skew = stored.createdAt.getTime() - before;
    // Запас на сеть и планировщик, но заведомо меньше любого часового смещения.
    expect(Math.abs(skew)).toBeLessThan(60_000);
  });

  it('пояс сессии базы — UTC, а не «какой получился»', async () => {
    const rows = await db.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    const timeZone = rows[0]?.tz ?? '';

    // Допускаются оба написания одной и той же зоны: `UTC` приходит из параметра
    // запуска сервера, `Etc/UTC` — из окружения контейнера. Разными зонами
    // они не являются, и это подтверждает нулевое смещение ниже.
    expect(['UTC', 'Etc/UTC', 'GMT']).toContain(timeZone);
    expect(await sessionOffsetMs()).toBe(0);
  });

  it('три источника значения дают одну абсолютную шкалу', async () => {
    // Один и тот же момент, записанный тремя разными путями, обязан совпасть
    // с точностью до задержки запроса. Именно это свойство и ломалось раньше.
    const explicitKey = `time.three.explicit.${randomUUID()}`;
    const defaultKey = `time.three.default.${randomUUID()}`;
    const rawKey = `time.three.raw.${randomUUID()}`;
    const known = new Date('2026-08-12T09:00:00.000Z');

    await db.outboxMessage.create({
      data: { topic: 'test.ping', idempotencyKey: explicitKey, payload: {}, createdAt: known },
    });
    const byDefault = await db.outboxMessage.create({
      data: { topic: 'test.ping', idempotencyKey: defaultKey, payload: {} },
      select: { createdAt: true },
    });
    await db.$executeRaw`
      INSERT INTO "OutboxMessage" ("id", "topic", "idempotencyKey", "payload", "updatedAt")
      VALUES (gen_random_uuid(), 'test.ping', ${rawKey}, '{}'::jsonb, CURRENT_TIMESTAMP)
    `;
    const byRaw = await db.outboxMessage.findUniqueOrThrow({
      where: { idempotencyKey: rawKey },
      select: { createdAt: true },
    });
    const explicit = await db.outboxMessage.findUniqueOrThrow({
      where: { idempotencyKey: explicitKey },
      select: { createdAt: true },
    });

    // Явный инстант не сдвинулся ни на миллисекунду.
    expect(explicit.createdAt.toISOString()).toBe(known.toISOString());
    // Значение Prisma и значение базы отличаются только временем выполнения.
    expect(Math.abs(byRaw.createdAt.getTime() - byDefault.createdAt.getTime())).toBeLessThan(
      60_000,
    );
  });

  it('календарная дата не зависит ни от пояса сессии, ни от пояса процесса', async () => {
    // Колонка типа DATE хранит день без времени. Запись полуночи UTC обязана
    // вернуться тем же днём — иначе дата доставки съезжала бы на сутки.
    const rows = await db.$queryRaw<{ day: Date }[]>`SELECT '2026-08-12'::date AS day`;
    expect(rows[0]?.day.toISOString().slice(0, 10)).toBe('2026-08-12');
  });
});
