/**
 * Критические проверки статистики смен флориста.
 *
 * Считаем по неизменяемой истории (смены, аудит взятия/сборки, доступность
 * очереди). Проверяем то, нарушение чего искажает картину работы: длительность
 * смены, уникальный счёт без удвоения повторной сборкой, время цикла сборки,
 * рабочее время как ОБЪЕДИНЕНИЕ (одновременные заказы время не множат),
 * разбиение простоя по доступности очереди и границу точного накопления.
 *
 * ВЛАДЕНИЕ ДАТАМИ: май 2029 года (см. RESERVED_MONTHS).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { buildFloristStatistics } from './statistics.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await closeTestContext(ctx);
});

/** Момент московского дня `2029-05-DD чч:мм` в UTC (Москва = UTC+3). */
function at(day: string, hhmm: string): Date {
  return new Date(`2029-05-${day}T${hhmm}:00.000+03:00`);
}

async function seedShift(userId: string, startedAt: Date, closedAt: Date | null): Promise<void> {
  await ctx.db.floristShift.create({
    data: {
      userId,
      startedAt,
      closedAt,
      // Закрытая смена обязана называть, как и кем закрыта (CHECK базы).
      ...(closedAt === null
        ? { activeKey: userId }
        : { closeKind: 'SELF', closedById: userId, activeKey: null }),
    },
  });
}

async function seedAudit(
  action: 'ORDER_FULFILLMENT_CLAIMED' | 'ORDER_FULFILLMENT_ASSEMBLED',
  userId: string,
  orderId: string,
  occurredAt: Date,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await ctx.db.auditLog.create({
    data: {
      action,
      entityType: 'DeliveryOrder',
      entityId: orderId,
      actorUserId: userId,
      actorRoles: ['FLORIST'],
      occurredAt,
      newValue: extra,
    },
  });
}

async function seedAvailability(occurredAt: Date, available: boolean): Promise<void> {
  await ctx.db.floristQueueAvailabilityEvent.create({ data: { occurredAt, available } });
}

describe('агрегация статистики смен', () => {
  it('длительность, уникальный счёт, время цикла и деньги считаются по истории', async () => {
    const florist = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: 'Флорист Статный' });
    const day = '04';
    const o1 = randomUUID();
    const o2 = randomUUID();

    // Смена 09:00–17:00 = 480 минут.
    await seedShift(florist.id, at(day, '09:00'), at(day, '17:00'));
    // Цикл 1: взял 09:10, собрал 09:30 (20 мин), сумма 500000 минор.
    await seedAudit('ORDER_FULFILLMENT_CLAIMED', florist.id, o1, at(day, '09:10'));
    await seedAudit('ORDER_FULFILLMENT_ASSEMBLED', florist.id, o1, at(day, '09:30'), {
      assembledSumMinor: '500000',
    });
    // Цикл 2: взял 10:00, собрал 10:15 (15 мин), сумма 300000.
    await seedAudit('ORDER_FULFILLMENT_CLAIMED', florist.id, o2, at(day, '10:00'));
    await seedAudit('ORDER_FULFILLMENT_ASSEMBLED', florist.id, o2, at(day, '10:15'), {
      assembledSumMinor: '300000',
    });
    // Доступность очереди фиксировалась с начала смены — простой известен полно.
    await seedAvailability(at(day, '08:00'), true);
    await seedAvailability(at(day, '10:30'), false);

    const stats = await buildFloristStatistics(ctx.db, {
      from: `2029-05-${day}`,
      to: `2029-05-${day}`,
      now: at(day, '18:00'),
    });

    const row = stats.rows.find((r) => r.floristId === florist.id);
    expect(row).toBeDefined();
    expect(row?.shiftDurationMinutes).toBe(480);
    // Рабочее время — объединение [09:10–09:30] и [10:00–10:15] = 35 минут.
    expect(row?.workingMinutes).toBe(35);
    expect(row?.uniqueAssembledCount).toBe(2);
    expect(row?.avgAssemblyMinutes).toBe(17.5);
    expect(row?.medianAssemblyMinutes).toBe(17.5);
    expect(row?.totalSumMinor).toBe('800000');
    expect(row?.moneyIncomplete).toBe(false);
    expect(row?.idleIncomplete).toBe(false);
    // Простой = 480 − 35 = 445; разбиение по очереди суммируется в простой.
    const withQ = row?.idleWithQueueMinutes ?? 0;
    const withoutQ = row?.idleWithoutQueueMinutes ?? 0;
    expect(Math.round(withQ + withoutQ)).toBe(445);
    // До 10:30 очередь была, после — нет: простой «с очередью» ненулевой.
    expect(withQ).toBeGreaterThan(0);
    expect(withoutQ).toBeGreaterThan(0);
    // Ритм: 2 заказа за 8 часов.
    expect(row?.ordersPerHour).toBe(0.3);
    expect(stats.accurateFrom).toBe(`2029-05-${day}`);
  });

  it('повторная сборка не удваивает уникальный счёт, но добавляет цикл', async () => {
    const florist = await seedUser(ctx.db, { roles: ['FLORIST'] });
    const day = '06';
    const order = randomUUID();
    await seedShift(florist.id, at(day, '09:00'), at(day, '13:00'));
    // Собран, возвращён, собран заново — тот же заказ, два цикла.
    await seedAudit('ORDER_FULFILLMENT_CLAIMED', florist.id, order, at(day, '09:10'));
    await seedAudit('ORDER_FULFILLMENT_ASSEMBLED', florist.id, order, at(day, '09:20'), {
      assembledSumMinor: '100000',
    });
    await seedAudit('ORDER_FULFILLMENT_CLAIMED', florist.id, order, at(day, '10:00'));
    await seedAudit('ORDER_FULFILLMENT_ASSEMBLED', florist.id, order, at(day, '10:30'), {
      assembledSumMinor: '100000',
    });

    const stats = await buildFloristStatistics(ctx.db, {
      from: `2029-05-${day}`,
      to: `2029-05-${day}`,
      now: at(day, '14:00'),
    });
    const row = stats.rows.find((r) => r.floristId === florist.id);
    // Один уникальный заказ, но среднее по ДВУМ циклам: (10 + 30) / 2 = 20.
    expect(row?.uniqueAssembledCount).toBe(1);
    expect(row?.avgAssemblyMinutes).toBe(20);
  });

  it('до первого события доступности простой неполон, деньги без суммы — неполны', async () => {
    const florist = await seedUser(ctx.db, { roles: ['FLORIST'] });
    // День РАНЬШЕ самого первого события доступности (04-е): простой этой смены
    // приходится на зону «неизвестно» и честно помечается неполным.
    const day = '02';
    const order = randomUUID();
    await seedShift(florist.id, at(day, '09:00'), at(day, '12:00'));
    await seedAudit('ORDER_FULFILLMENT_CLAIMED', florist.id, order, at(day, '09:30'));
    // Сборка без зафиксированной суммы (как у прежней истории).
    await seedAudit('ORDER_FULFILLMENT_ASSEMBLED', florist.id, order, at(day, '09:50'));
    // Событий доступности за этот день нет вовсе.

    const stats = await buildFloristStatistics(ctx.db, {
      from: `2029-05-${day}`,
      to: `2029-05-${day}`,
      now: at(day, '13:00'),
    });
    const row = stats.rows.find((r) => r.floristId === florist.id);
    expect(row?.idleIncomplete).toBe(true);
    expect(row?.idleWithQueueMinutes).toBeNull();
    expect(row?.moneyIncomplete).toBe(true);
    expect(row?.totalSumMinor).toBeNull();
    expect(row?.rublesPerHour).toBeNull();
    // Честно восстановимое считается всё равно: длительность и уникальный счёт.
    expect(row?.shiftDurationMinutes).toBe(180);
    expect(row?.uniqueAssembledCount).toBe(1);
  });

  it('смена через полночь целиком относится к дате начала', async () => {
    const florist = await seedUser(ctx.db, { roles: ['FLORIST'] });
    // Смена 22:00 10-го → 02:00 11-го. Начало — 10-е, туда и относится вся.
    await seedShift(florist.id, at('10', '22:00'), at('11', '02:00'));

    const onStart = await buildFloristStatistics(ctx.db, {
      from: '2029-05-10',
      to: '2029-05-10',
      now: at('11', '03:00'),
    });
    const onNext = await buildFloristStatistics(ctx.db, {
      from: '2029-05-11',
      to: '2029-05-11',
      now: at('11', '03:00'),
    });
    // Вся смена (240 минут) отнесена к 10-му и не появляется у 11-го.
    expect(onStart.rows.find((r) => r.floristId === florist.id)?.shiftDurationMinutes).toBe(240);
    expect(onNext.rows.find((r) => r.floristId === florist.id)).toBeUndefined();
  });
});
