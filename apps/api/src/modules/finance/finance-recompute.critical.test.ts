/**
 * Разовый пересчёт доставок за дату включения учёта.
 *
 * Проверяется, что процедура считает ТЕМИ ЖЕ доменными функциями, платит только
 * за доставленное, сторнирует отменённое, создаёт недостающие снимки тарифа,
 * включает учёт и — главное — идемпотентна: повтор не создаёт новых записей.
 * Сухой прогон не пишет ничего.
 *
 * ВЛАДЕНИЕ ДАТАМИ: июнь 2030 — месяц вне диапазонов остальных файлов набора,
 * поэтому маршруты и попытки этого дня принадлежат только этим проверкам.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import type { Role } from '@fl/shared';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { readLedgerActivation } from './tariffs.js';
import { recomputeDeliveriesForDate } from './recompute.js';

let ctx: TestContext;
const DAY = '2030-06-15';
const PER_ORDER = 50000n;
const PER_KM = 0n;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await closeTestContext(ctx);
});

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${seq}`;
}

async function adminId(): Promise<string> {
  const user = await seedUser(ctx.db, { roles: ['ADMIN'], status: 'ACTIVE' });
  return user.id;
}
async function courierId(): Promise<string> {
  const user = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE' });
  return user.id;
}

async function seedTariff(from: string, perOrder: bigint, perKm: bigint): Promise<void> {
  await ctx.db.courierTariffVersion.create({
    data: {
      kind: 'REGULAR',
      effectiveFrom: toDateColumn(from),
      effectiveTo: null,
      perOrderMinor: perOrder,
      perKmMinor: perKm,
      createdById: await adminId(),
    },
  });
}

async function seedRoute(input: {
  courier: string;
  day: string;
  cash?: bigint;
}): Promise<{ routeId: string; routeOrderId: string; orderId: string }> {
  const creator = await adminId();
  const cash = input.cash ?? 0n;
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: unique('FR'),
      externalUpdated: new Date(),
      deliveryDate: toDateColumn(input.day),
      inScope: true,
      cashCollectable: true,
      sumMinor: cash,
      payedSumMinor: 0n,
      cashToCollectMinor: cash,
      paymentTypeName: 'Наличные',
    },
    select: { id: true },
  });
  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('RR'),
      deliveryDate: toDateColumn(input.day),
      state: 'ACTIVE',
      vehicleType: 'CAR',
      createdById: creator,
      courierUserId: input.courier,
    },
    select: { id: true },
  });
  const participation = await ctx.db.routeOrder.create({
    data: { routeId: route.id, orderId: order.id, position: 1, addedById: creator },
    select: { id: true },
  });
  return { routeId: route.id, routeOrderId: participation.id, orderId: order.id };
}

async function seedAttempt(input: {
  route: { routeId: string; routeOrderId: string; orderId: string };
  courier: string;
  outcome: 'DELIVERED' | 'NOT_DELIVERED';
}): Promise<string> {
  const reason =
    input.outcome === 'NOT_DELIVERED'
      ? await ctx.db.deliveryFailureReason.findFirstOrThrow({
          where: { isActive: true },
          select: { id: true, name: true },
        })
      : null;
  const attempt = await ctx.db.deliveryAttempt.create({
    data: {
      routeOrderId: input.route.routeOrderId,
      orderId: input.route.orderId,
      routeId: input.route.routeId,
      outcome: input.outcome,
      reasonId: reason?.id ?? null,
      reasonNameSnapshot: reason?.name ?? null,
      courierUserId: input.courier,
      activeKey: input.route.routeOrderId,
    },
    select: { id: true },
  });
  return attempt.id;
}

async function recompute(dryRun: boolean, date: string = DAY) {
  return recomputeDeliveriesForDate(ctx.db, {
    date,
    actorUserId: await adminId(),
    actorRoles: ['ADMIN'] as Role[],
    ip: null,
    userAgent: 'test',
    dryRun,
    expectedPerOrderMinor: PER_ORDER,
    expectedPerKmMinor: PER_KM,
  });
}

const feesOf = (courier: string) =>
  ctx.db.courierLedgerEntry.count({ where: { courierUserId: courier, kind: 'DELIVERY_FEE' } });

describe('пересчёт доставок за дату включения учёта', () => {
  it('платит за доставленное, не платит за недоставленное, сухой прогон ничего не пишет, повтор идемпотентен', async () => {
    await seedTariff('2030-06-01', PER_ORDER, PER_KM);
    const courier = await courierId();
    const delivered = await seedRoute({ courier, day: DAY });
    await seedAttempt({ route: delivered, courier, outcome: 'DELIVERED' });
    const failed = await seedRoute({ courier, day: DAY });
    await seedAttempt({ route: failed, courier, outcome: 'NOT_DELIVERED' });

    const activationBefore = (await readLedgerActivation(ctx.db)).activeFrom;

    // Сухой прогон: план есть, база не тронута.
    const dry = await recompute(true);
    expect(dry.deliveredCount).toBe(1);
    expect(dry.notDeliveredCount).toBe(1);
    expect(dry.snapshotsCreated).toBe(2);
    expect(dry.totalMinor).toBe(-PER_ORDER); // оплата курьеру — кредит (минус долга)
    expect(await feesOf(courier)).toBe(0);
    expect(
      await ctx.db.routeTariffSnapshot.count({
        where: { routeId: { in: [delivered.routeId, failed.routeId] } },
      }),
    ).toBe(0);
    expect((await readLedgerActivation(ctx.db)).activeFrom).toBe(activationBefore);

    // Применение: включение, снимки, оплата за доставленный.
    const applied = await recompute(false);
    expect(applied.snapshotsCreated).toBe(2);
    expect(applied.ledgerEntriesCreated).toBe(1);
    expect((await readLedgerActivation(ctx.db)).activeFrom).toBe(DAY);
    expect(await feesOf(courier)).toBe(1);
    const fee = await ctx.db.courierLedgerEntry.findFirstOrThrow({
      where: { courierUserId: courier, kind: 'DELIVERY_FEE' },
    });
    expect(fee.amountMinor).toBe(-PER_ORDER);
    // Денежный факт снимается по КАЖДОЙ попытке, даже недоставленной.
    expect(await ctx.db.deliveryMoneyFact.count({ where: { courierUserId: courier } })).toBe(2);

    // Повтор — 0 новых действий.
    const again = await recompute(false);
    expect(again.activation.changed).toBe(false);
    expect(again.snapshotsCreated).toBe(0);
    expect(again.ledgerEntriesCreated).toBe(0);
    expect(await feesOf(courier)).toBe(1);
  });

  it('отменённый результат сторнируется обратной записью, повтор не создаёт второго сторно', async () => {
    await seedTariff('2030-06-01', PER_ORDER, PER_KM);
    const date = '2030-06-16';
    const courier = await courierId();
    const route = await seedRoute({ courier, day: date });
    const attemptId = await seedAttempt({ route, courier, outcome: 'DELIVERED' });
    // Отмена результата: технический ключ снят, есть запись отмены.
    await ctx.db.deliveryAttempt.update({ where: { id: attemptId }, data: { activeKey: null } });
    await ctx.db.deliveryAttemptCancellation.create({
      data: {
        attemptId,
        kind: 'MANAGER_CORRECTION',
        reason: 'Ошибочный результат',
        actorUserId: await adminId(),
      },
    });

    const applied = await recompute(false, date);
    expect(applied.reversalsApplied).toBe(1);

    const fee = await ctx.db.courierLedgerEntry.findFirstOrThrow({
      where: { attemptId, kind: 'DELIVERY_FEE' },
    });
    const adjustment = await ctx.db.courierLedgerEntry.findFirstOrThrow({
      where: { attemptId, kind: 'ADJUSTMENT' },
    });
    // Начисление осталось историей, сторно — связанная обратная запись.
    expect(adjustment.amountMinor).toBe(PER_ORDER); // сторно кредита — плюс
    expect(adjustment.reversesEntryId).toBe(fee.id);
    // Итог курьера по этой попытке — ноль: начислили и сняли.
    const summary = applied.couriers.find((entry) => entry.courierUserId === courier);
    expect(summary?.netMinor).toBe(0n);

    // Повтор не создаёт второго сторно.
    await recompute(false, date);
    expect(
      await ctx.db.courierLedgerEntry.count({ where: { attemptId, kind: 'ADJUSTMENT' } }),
    ).toBe(1);
  });

  it('несовпадение действующего тарифа останавливает пересчёт', async () => {
    await seedTariff('2030-06-01', 40000n, PER_KM); // не 50000 — противоречие
    await expect(recompute(true)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('подтверждённый незавершённый маршрут будущего дня получает снимок тарифа', async () => {
    await seedTariff('2030-06-01', PER_ORDER, PER_KM);
    const date = '2030-06-18';
    const courier = await courierId();
    // Маршрут будущего дня (>= даты включения), без результатов — «незавершён».
    const future = await seedRoute({ courier, day: '2030-06-25' });

    await recompute(false, date);

    const snapshot = await ctx.db.routeTariffSnapshot.findUnique({
      where: { routeId: future.routeId },
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.perOrderMinor).toBe(PER_ORDER);
    // Результатов у него нет — платить пока не за что.
    expect(await feesOf(courier)).toBe(0);
  });
});
