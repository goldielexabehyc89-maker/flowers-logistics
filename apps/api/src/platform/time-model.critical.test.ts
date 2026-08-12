/**
 * Модель времени в базе: одна ли шкала у приложения и у самой PostgreSQL.
 *
 * Все колонки абсолютного времени объявлены как `TIMESTAMP(3) WITHOUT TIME ZONE`.
 * У такой колонки нет собственного часового пояса — есть только соглашение,
 * какое время в неё кладут. Соглашение проекта: там лежит UTC.
 *
 * Соглашение соблюдает приложение: Prisma отправляет `Date` как UTC-момент
 * и читает его обратно тем же моментом. Но сама база при записи `CURRENT_TIMESTAMP`
 * в такую колонку приводит значение к ЧАСОВОМУ ПОЯСУ СЕССИИ. Контейнер базы
 * инициализирован с `TZ=Europe/Moscow`, поэтому серверный пояс — московский,
 * и значение, записанное базой, оказывается на три часа впереди.
 *
 * Отсюда правило, которое и охраняет этот тест: **время в колонки пишет
 * приложение, а не база**. `DEFAULT CURRENT_TIMESTAMP` в схеме остаётся, но
 * до него не доходит ни один продуктовый путь — Prisma подставляет значение
 * сама. Любая новая сырая вставка, забывшая колонку времени, промахнётся
 * на величину смещения сессии, и заметить это по данным почти невозможно.
 *
 * Тест сформулирован так, чтобы остаться верным и после возможного перевода
 * серверного пояса на UTC: он сравнивает промах не с «тремя часами», а
 * с фактическим смещением сессии.
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

  it('запись самой базой промахивается ровно на смещение сессии', async () => {
    // Это и есть известный модельный дефект: naive-колонка получает местное
    // время сессии, а приложение читает её как UTC. Тест не «проверяет
    // дефект ради дефекта» — он не даёт незаметно начать полагаться на
    // серверные значения времени и ломается, если смещение изменится.
    const offset = await sessionOffsetMs();
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
    // Промах равен смещению сессии: при московском поясе это три часа,
    // при UTC — ноль. Обе конфигурации описываются одним правилом.
    expect(Math.abs(skew - offset)).toBeLessThan(60_000);
  });

  it('часовой пояс сессии приложения назван явно, а не подразумевается', async () => {
    const rows = await db.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    const timeZone = rows[0]?.tz ?? '';

    // Значение не проверяется на равенство: оно задаётся окружением базы.
    // Важно другое — оно известно тесту и участвует в проверке выше.
    expect(timeZone).not.toBe('');
    const offset = await sessionOffsetMs();
    if (timeZone === 'UTC' || timeZone === 'Etc/UTC') {
      expect(offset).toBe(0);
    } else {
      expect(offset).not.toBe(0);
    }
  });

  it('календарная дата не зависит ни от пояса сессии, ни от пояса процесса', async () => {
    // Колонка типа DATE хранит день без времени. Запись полуночи UTC обязана
    // вернуться тем же днём — иначе дата доставки съезжала бы на сутки.
    const rows = await db.$queryRaw<{ day: Date }[]>`SELECT '2026-08-12'::date AS day`;
    expect(rows[0]?.day.toISOString().slice(0, 10)).toBe('2026-08-12');
  });
});
