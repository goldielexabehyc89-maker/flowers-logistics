/**
 * Критические проверки денег (этап 7).
 *
 * Проверяется не «складываются ли числа», а то, нарушение чего стоит денег:
 * переписанная задним числом запись учёта, вторая запись от повторного
 * запроса, отменённая дважды операция, начисление по тарифу, которого на дату
 * доставки не было, ретропересчёт подтверждённого маршрута и баланс, который
 * не сходится с независимым подсчётом.
 *
 * Даты подобраны так, чтобы не пересекаться с другими файлами набора.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import type { Role } from '@fl/shared';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { appendEntry, balanceOf, reverseEntry, signedAmount } from './ledger.js';
import {
  ledgerCoversDate,
  readLedgerActivation,
  resolveTariff,
  validateTariffPeriod,
  LEDGER_SETTING_KEY,
} from './tariffs.js';
import { accrueDeliveryResult, captureRouteTariff, reverseDeliveryAccruals } from './accrual.js';
import { buildSettlementReport, dayBefore } from './reports.js';
import { groupSettlement, pageOfGroups } from './grouping.js';
import { assertPayloadIsSafe, publishRealtimeEvent } from '../realtime/events.js';
import { isInsideRing, nearestRingPoint, parseRing, ringSha256, toKmTenths } from './mkad.js';
import { buildSettlementWorkbook, toRubles } from './export-xlsx.js';
import { buildSettlementPdf, debtDirection, formatRubles } from './export-pdf.js';

let ctx: TestContext;

/** Дни вне диапазонов остальных файлов набора. */
const DAY = '2028-04-14';
const EARLIER = '2028-04-02';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${randomUUID().slice(0, 8)}`;
}

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return { userId: user.id, roles, familyId: randomUUID() } as AuthenticatedActor;
}

async function seedTariff(input: {
  kind?: 'REGULAR' | 'HOLIDAY';
  from: string;
  to?: string | null;
  perOrder: bigint;
  perKm: bigint;
}): Promise<string> {
  const admin = await actorFor(['ADMIN']);
  const row = await ctx.db.courierTariffVersion.create({
    data: {
      kind: input.kind ?? 'REGULAR',
      effectiveFrom: toDateColumn(input.from),
      effectiveTo: input.to === undefined || input.to === null ? null : toDateColumn(input.to),
      perOrderMinor: input.perOrder,
      perKmMinor: input.perKm,
      createdById: admin.userId,
    },
    select: { id: true },
  });
  return row.id;
}

async function seedRouteWithOrder(input: {
  courierId: string;
  day: string;
  cash?: bigint;
  cashCollectable?: boolean;
}): Promise<{ routeId: string; routeOrderId: string; orderId: string }> {
  const creator = await actorFor(['ADMIN']);
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: unique('F'),
      externalUpdated: new Date(),
      deliveryDate: toDateColumn(input.day),
      inScope: true,
      cashCollectable: input.cashCollectable ?? true,
      sumMinor: input.cash ?? 0n,
      payedSumMinor: 0n,
      // Инвариант заказа требует согласованности: сумма к получению равна
      // неоплаченному остатку, а без наличной оплаты она нулевая.
      cashToCollectMinor: (input.cashCollectable ?? true) ? (input.cash ?? 0n) : 0n,
      paymentTypeName: 'Наличные/карта на ТТ',
    },
    select: { id: true },
  });

  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('RF'),
      deliveryDate: toDateColumn(input.day),
      state: 'ACTIVE',
      vehicleType: 'CAR',
      createdById: creator.userId,
      courierUserId: input.courierId,
    },
    select: { id: true },
  });

  const participation = await ctx.db.routeOrder.create({
    data: { routeId: route.id, orderId: order.id, position: 1, addedById: creator.userId },
    select: { id: true },
  });

  return { routeId: route.id, routeOrderId: participation.id, orderId: order.id };
}

async function seedAttempt(input: {
  routeId: string;
  routeOrderId: string;
  orderId: string;
  courierId: string;
  outcome?: 'DELIVERED' | 'NOT_DELIVERED';
}): Promise<string> {
  const outcome = input.outcome ?? 'DELIVERED';

  /*
   * У недоставки причина обязательна на уровне базы: берётся действующая
   * из справочника, а не выдуманная строка.
   */
  const reason =
    outcome === 'NOT_DELIVERED'
      ? await ctx.db.deliveryFailureReason.findFirstOrThrow({
          where: { isActive: true },
          select: { id: true, name: true },
        })
      : null;

  const attempt = await ctx.db.deliveryAttempt.create({
    data: {
      routeOrderId: input.routeOrderId,
      orderId: input.orderId,
      routeId: input.routeId,
      outcome,
      reasonId: reason?.id ?? null,
      reasonNameSnapshot: reason?.name ?? null,
      courierUserId: input.courierId,
      activeKey: input.routeOrderId,
    },
    select: { id: true },
  });
  return attempt.id;
}

async function activateLedger(from: string): Promise<void> {
  const admin = await actorFor(['ADMIN']);
  await ctx.db.systemSetting.updateMany({
    where: { key: LEDGER_SETTING_KEY, currentKey: LEDGER_SETTING_KEY },
    data: { currentKey: null },
  });
  const previous = await ctx.db.systemSetting.findFirst({
    where: { key: LEDGER_SETTING_KEY },
    orderBy: [{ version: 'desc' }],
    select: { version: true },
  });
  await ctx.db.systemSetting.create({
    data: {
      key: LEDGER_SETTING_KEY,
      version: (previous?.version ?? 0) + 1,
      value: { activeFrom: from },
      currentKey: LEDGER_SETTING_KEY,
      updatedById: admin.userId,
    },
  });
}

describe('знак и баланс', () => {
  it('плюс увеличивает долг курьера, минус уменьшает', () => {
    expect(signedAmount('CASH_RECEIVED', 500n)).toBe(500n);
    expect(signedAmount('CASH_ISSUED_TO_COURIER', 500n)).toBe(500n);
    expect(signedAmount('DELIVERY_FEE', 500n)).toBe(-500n);
    expect(signedAmount('CASH_HANDED_TO_LOGIST', 500n)).toBe(-500n);
    expect(signedAmount('EXPENSE_PARKING', 500n)).toBe(-500n);
    // Величина берётся по модулю: знак задаёт вид операции, а не вызывающий код.
    expect(signedAmount('DELIVERY_FEE', -500n)).toBe(-500n);
  });

  it('баланс совпадает с независимым подсчётом по формуле владельца', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);

    const operations: [Parameters<typeof appendEntry>[1]['kind'], bigint][] = [
      ['CASH_RECEIVED', 10_000n],
      ['DELIVERY_FEE', 3_000n],
      ['DISTANCE_FEE', 1_500n],
      ['EXPENSE_PARKING', 200n],
      ['CASH_HANDED_TO_LOGIST', 4_000n],
      ['CASH_ISSUED_TO_COURIER', 700n],
    ];

    for (const [kind, amount] of operations) {
      await appendEntry(ctx.db, {
        courierUserId: courier.userId,
        kind,
        amountMinor: amount,
        operationDate: DAY,
        actorUserId: logist.userId,
        reason: kind.startsWith('EXPENSE') ? 'парковка у адреса' : null,
        idempotencyKey: unique('key'),
      });
    }

    // Наличные − оплата работы − километры − расходы − сдано + выдано.
    const expected = 10_000n - 3_000n - 1_500n - 200n - 4_000n + 700n;
    expect(await balanceOf(ctx.db, courier.userId, null)).toBe(expected);
  });
});

describe('неизменяемость учёта', () => {
  it('запись учёта нельзя изменить и нельзя удалить', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    const entry = await appendEntry(ctx.db, {
      courierUserId: courier.userId,
      kind: 'BONUS',
      amountMinor: 100n,
      operationDate: DAY,
      actorUserId: logist.userId,
      idempotencyKey: unique('key'),
    });

    await expect(
      ctx.db.courierLedgerEntry.update({ where: { id: entry.id }, data: { comment: 'правка' } }),
    ).rejects.toThrow(/неизменяема/);

    await expect(ctx.db.courierLedgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /неизменяема/,
    );
  });

  it('тариф и снимок тарифа не редактируются', async () => {
    const tariffId = await seedTariff({ from: DAY, perOrder: 20_000n, perKm: 3_000n });

    await expect(
      ctx.db.courierTariffVersion.update({
        where: { id: tariffId },
        data: { perOrderMinor: 1n },
      }),
    ).rejects.toThrow(/неизменяема/);
  });

  it('нулевая операция запрещена базой', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);

    await expect(
      ctx.db.courierLedgerEntry.create({
        data: {
          courierUserId: courier.userId,
          kind: 'BONUS',
          amountMinor: 0n,
          operationDate: toDateColumn(DAY),
          actorUserId: logist.userId,
          idempotencyKey: unique('key'),
        },
      }),
    ).rejects.toThrow();
  });
});

describe('идемпотентность и обратные корректировки', () => {
  it('повтор запроса с тем же ключом не создаёт вторую запись', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    const key = unique('key');

    const first = await appendEntry(ctx.db, {
      courierUserId: courier.userId,
      kind: 'CASH_HANDED_TO_LOGIST',
      amountMinor: 1_000n,
      operationDate: DAY,
      actorUserId: logist.userId,
      idempotencyKey: key,
    });
    const second = await appendEntry(ctx.db, {
      courierUserId: courier.userId,
      kind: 'CASH_HANDED_TO_LOGIST',
      amountMinor: 1_000n,
      operationDate: DAY,
      actorUserId: logist.userId,
      idempotencyKey: key,
    });

    expect(second.id).toBe(first.id);
    expect(await balanceOf(ctx.db, courier.userId, null)).toBe(-1_000n);
  });

  it('обратная корректировка обнуляет операцию и повторно не выполняется', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);

    const entry = await appendEntry(ctx.db, {
      courierUserId: courier.userId,
      kind: 'CASH_ISSUED_TO_COURIER',
      amountMinor: 2_500n,
      operationDate: DAY,
      actorUserId: logist.userId,
      idempotencyKey: unique('key'),
    });

    const reversal = await reverseEntry(ctx.db, {
      entryId: entry.id,
      actorUserId: logist.userId,
      reason: 'операция заведена по ошибке',
      operationDate: DAY,
    });

    expect(BigInt(reversal.amountMinor)).toBe(-2_500n);
    expect(await balanceOf(ctx.db, courier.userId, null)).toBe(0n);

    // Повтор возвращает ту же запись, а не создаёт вторую отмену.
    const again = await reverseEntry(ctx.db, {
      entryId: entry.id,
      actorUserId: logist.userId,
      reason: 'повтор',
      operationDate: DAY,
    });
    expect(again.id).toBe(reversal.id);
  });
});

describe('тарифы и отсутствие ретропересчёта', () => {
  it('праздничная версия перекрывает обычную на своих днях', async () => {
    await seedTariff({ from: EARLIER, perOrder: 10_000n, perKm: 2_000n });
    await seedTariff({ kind: 'HOLIDAY', from: DAY, to: DAY, perOrder: 30_000n, perKm: 5_000n });

    const regular = await resolveTariff(ctx.db, EARLIER);
    const holiday = await resolveTariff(ctx.db, DAY);

    expect(regular?.perOrderMinor).toBe(10_000n);
    expect(holiday?.perOrderMinor).toBe(30_000n);
  });

  it('праздничный тариф без конца периода не принимается', () => {
    expect(() =>
      validateTariffPeriod({
        kind: 'HOLIDAY',
        effectiveFrom: DAY,
        effectiveTo: null,
        perOrderMinor: 1n,
        perKmMinor: 1n,
        note: null,
      }),
    ).toThrow(
      expect.objectContaining({
        publicMessage: expect.stringContaining('последний день'),
      }) as Error,
    );
  });

  it('изменение тарифа не пересчитывает подтверждённый маршрут', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    await activateLedger(EARLIER);

    const day = '2028-04-20';
    await seedTariff({ from: day, perOrder: 15_000n, perKm: 1_000n });
    const rates = await resolveTariff(ctx.db, day);
    expect(rates).not.toBeNull();

    const seeded = await seedRouteWithOrder({ courierId: courier.userId, day, cash: 0n });
    await captureRouteTariff(ctx.db, {
      routeId: seeded.routeId,
      deliveryDate: day,
      rates: rates!,
    });

    // Новая, более дорогая версия того же вида — снимок обязан остаться прежним.
    await seedTariff({ from: day, perOrder: 99_000n, perKm: 9_000n });

    const attemptId = await seedAttempt({ ...seeded, courierId: courier.userId });
    await accrueDeliveryResult(ctx.db, await readLedgerActivation(ctx.db), {
      attemptId,
      routeOrderId: seeded.routeOrderId,
      routeId: seeded.routeId,
      orderId: seeded.orderId,
      courierUserId: courier.userId,
      actorUserId: logist.userId,
      outcome: 'DELIVERED',
    });

    const fee = await ctx.db.courierLedgerEntry.findFirst({
      where: { attemptId, kind: 'DELIVERY_FEE' },
      select: { amountMinor: true },
    });
    expect(fee?.amountMinor).toBe(-15_000n);
  });
});

describe('деньги доставки', () => {
  it('наличные попадают в долг курьера, онлайн-оплата — нет', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    const day = '2028-04-21';
    await activateLedger(EARLIER);
    await seedTariff({ from: day, perOrder: 0n, perKm: 0n });

    const cashOrder = await seedRouteWithOrder({
      courierId: courier.userId,
      day,
      cash: 4_990n,
      cashCollectable: true,
    });
    const onlineOrder = await seedRouteWithOrder({
      courierId: courier.userId,
      day,
      cash: 4_990n,
      cashCollectable: false,
    });

    const activation = await readLedgerActivation(ctx.db);
    for (const seeded of [cashOrder, onlineOrder]) {
      const attemptId = await seedAttempt({ ...seeded, courierId: courier.userId });
      await accrueDeliveryResult(ctx.db, activation, {
        attemptId,
        routeOrderId: seeded.routeOrderId,
        routeId: seeded.routeId,
        orderId: seeded.orderId,
        courierUserId: courier.userId,
        actorUserId: logist.userId,
        outcome: 'DELIVERED',
      });
    }

    const cashEntries = await ctx.db.courierLedgerEntry.findMany({
      where: { courierUserId: courier.userId, kind: 'CASH_RECEIVED' },
      select: { amountMinor: true, routeId: true },
    });

    expect(cashEntries).toHaveLength(1);
    expect(cashEntries[0]?.routeId).toBe(cashOrder.routeId);
    expect(cashEntries[0]?.amountMinor).toBe(4_990n);
  });

  it('переплата не уходит в минус', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    const day = '2028-04-22';
    await activateLedger(EARLIER);

    const seeded = await seedRouteWithOrder({
      courierId: courier.userId,
      day,
      cash: 5_000n,
    });
    /*
     * Переплата: оплачено больше суммы. Инвариант заказа требует нулевого
     * остатка к получению, и учёт обязан согласиться с ним, а не уйти в минус.
     */
    await ctx.db.deliveryOrder.update({
      where: { id: seeded.orderId },
      // Признак аномалии обязателен при переплате: этого требует инвариант заказа.
      data: { payedSumMinor: 9_000n, cashToCollectMinor: 0n, cashAnomaly: true },
    });

    const attemptId = await seedAttempt({ ...seeded, courierId: courier.userId });
    await accrueDeliveryResult(ctx.db, await readLedgerActivation(ctx.db), {
      attemptId,
      routeOrderId: seeded.routeOrderId,
      routeId: seeded.routeId,
      orderId: seeded.orderId,
      courierUserId: courier.userId,
      actorUserId: logist.userId,
      outcome: 'DELIVERED',
    });

    const fact = await ctx.db.deliveryMoneyFact.findUniqueOrThrow({ where: { attemptId } });
    expect(fact.cashToCollectMinor).toBe(0n);
  });

  it('отмена результата создаёт обратные записи и обнуляет долг', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    const day = '2028-04-23';
    await activateLedger(EARLIER);
    await seedTariff({ from: day, perOrder: 12_000n, perKm: 0n });

    const rates = await resolveTariff(ctx.db, day);
    const seeded = await seedRouteWithOrder({ courierId: courier.userId, day, cash: 3_000n });
    await captureRouteTariff(ctx.db, { routeId: seeded.routeId, deliveryDate: day, rates: rates! });

    const attemptId = await seedAttempt({ ...seeded, courierId: courier.userId });
    const activation = await readLedgerActivation(ctx.db);
    await accrueDeliveryResult(ctx.db, activation, {
      attemptId,
      routeOrderId: seeded.routeOrderId,
      routeId: seeded.routeId,
      orderId: seeded.orderId,
      courierUserId: courier.userId,
      actorUserId: logist.userId,
      outcome: 'DELIVERED',
    });

    const beforeReversal = await balanceOf(ctx.db, courier.userId, null);
    expect(beforeReversal).toBe(3_000n - 12_000n);

    await reverseDeliveryAccruals(ctx.db, {
      attemptId,
      actorUserId: logist.userId,
      reason: 'ошибочная доставка',
      operationDate: day,
    });

    expect(await balanceOf(ctx.db, courier.userId, null)).toBe(0n);

    // Исходные записи остались: история не переписана.
    const entries = await ctx.db.courierLedgerEntry.count({ where: { attemptId } });
    expect(entries).toBe(4);
  });

  it('до включения учёта начислений нет вовсе', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    const day = '2028-04-01';
    await activateLedger(EARLIER);

    const seeded = await seedRouteWithOrder({ courierId: courier.userId, day, cash: 7_000n });
    const attemptId = await seedAttempt({ ...seeded, courierId: courier.userId });

    await accrueDeliveryResult(ctx.db, await readLedgerActivation(ctx.db), {
      attemptId,
      routeOrderId: seeded.routeOrderId,
      routeId: seeded.routeId,
      orderId: seeded.orderId,
      courierUserId: courier.userId,
      actorUserId: logist.userId,
      outcome: 'DELIVERED',
    });

    expect(await ctx.db.courierLedgerEntry.count({ where: { attemptId } })).toBe(0);
    expect(await ctx.db.deliveryMoneyFact.count({ where: { attemptId } })).toBe(0);
  });

  it('доставка без тарифного снимка не начисляет оплату, но фиксирует наличные', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    const day = '2028-04-24';
    await activateLedger(EARLIER);

    const seeded = await seedRouteWithOrder({ courierId: courier.userId, day, cash: 2_000n });
    const attemptId = await seedAttempt({ ...seeded, courierId: courier.userId });

    await accrueDeliveryResult(ctx.db, await readLedgerActivation(ctx.db), {
      attemptId,
      routeOrderId: seeded.routeOrderId,
      routeId: seeded.routeId,
      orderId: seeded.orderId,
      courierUserId: courier.userId,
      actorUserId: logist.userId,
      outcome: 'DELIVERED',
    });

    const kinds = await ctx.db.courierLedgerEntry.findMany({
      where: { attemptId },
      select: { kind: true },
    });
    expect(kinds.map((row) => row.kind)).toEqual(['CASH_RECEIVED']);
  });
});

describe('расстояние за МКАД', () => {
  it('кольцо обязано быть замкнутым', () => {
    expect(() =>
      parseRing([
        [37.0, 55.0],
        [37.1, 55.0],
        [37.1, 55.1],
        [37.2, 55.2],
      ]),
    ).toThrow(
      expect.objectContaining({ publicMessage: expect.stringContaining('замкнутым') }) as Error,
    );
  });

  it('одинаковая геометрия даёт один отпечаток', () => {
    const ring = [
      { lon: 37.0, lat: 55.0 },
      { lon: 37.1, lat: 55.0 },
      { lon: 37.1, lat: 55.1 },
      { lon: 37.0, lat: 55.0 },
    ];
    expect(ringSha256(ring)).toBe(ringSha256([...ring]));
  });

  it('точка внутри кольца и ближайшая точка съезда определяются верно', () => {
    const ring = [
      { lon: 37.0, lat: 55.0 },
      { lon: 38.0, lat: 55.0 },
      { lon: 38.0, lat: 56.0 },
      { lon: 37.0, lat: 56.0 },
      { lon: 37.0, lat: 55.0 },
    ];

    expect(isInsideRing(ring, { lat: 55.5, lon: 37.5 })).toBe(true);
    expect(isInsideRing(ring, { lat: 54.0, lon: 37.5 })).toBe(false);
    expect(nearestRingPoint(ring, { lat: 55.05, lon: 37.02 })).toEqual({ lat: 55, lon: 37 });
  });

  it('округление до 0,1 км выполняется один раз', () => {
    expect(toKmTenths(0)).toBe(0);
    expect(toKmTenths(149)).toBe(1);
    expect(toKmTenths(151)).toBe(2);
    expect(toKmTenths(12_340)).toBe(123);
  });
});

describe('отчёт периода', () => {
  it('входящий баланс берётся строго до первого дня периода', async () => {
    expect(dayBefore('2028-04-14')).toBe('2028-04-13');
    expect(dayBefore('2027-01-01')).toBe('2026-12-31');
  });

  it('строка без тарифного снимка помечается «расчёт отсутствует»', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    const day = '2028-04-25';
    await activateLedger(EARLIER);

    const seeded = await seedRouteWithOrder({ courierId: courier.userId, day, cash: 1_500n });
    const attemptId = await seedAttempt({ ...seeded, courierId: courier.userId });
    await accrueDeliveryResult(ctx.db, await readLedgerActivation(ctx.db), {
      attemptId,
      routeOrderId: seeded.routeOrderId,
      routeId: seeded.routeId,
      orderId: seeded.orderId,
      courierUserId: courier.userId,
      actorUserId: logist.userId,
      outcome: 'DELIVERED',
    });

    const report = await buildSettlementReport(ctx.db, {
      from: day,
      to: day,
      courierUserId: courier.userId,
      ledgerActiveFrom: EARLIER,
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.settlementMissing).toBe(true);
    expect(report.totals.cashReceivedMinor).toBe('1500');
    expect(report.totals.closingBalanceMinor).toBe('1500');
  });

  it('выгрузки собираются настоящими файлами', async () => {
    const report = await buildSettlementReport(ctx.db, {
      from: DAY,
      to: DAY,
      ledgerActiveFrom: EARLIER,
    });

    const xlsx = await buildSettlementWorkbook(report);
    // Сигнатура zip: XLSX — это архив, а не переименованный текст.
    expect(xlsx.subarray(0, 2).toString('latin1')).toBe('PK');

    const pdf = Buffer.from(await buildSettlementPdf(report));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('деньги переводятся в рубли и называются словами', () => {
    expect(toRubles('4990')).toBe(49.9);
    expect(formatRubles('-125000')).toBe('-1250,00 ₽');
    expect(debtDirection('1')).toBe('курьер должен компании');
    expect(debtDirection('-1')).toBe('компания должна курьеру');
    expect(debtDirection('0')).toBe('взаиморасчёты закрыты');
  });
});

describe('включение учёта', () => {
  it('дата включения отделяет старые доставки от новых', () => {
    expect(ledgerCoversDate({ activeFrom: null }, '2027-01-01')).toBe(false);
    expect(ledgerCoversDate({ activeFrom: '2027-01-01' }, '2026-12-31')).toBe(false);
    expect(ledgerCoversDate({ activeFrom: '2027-01-01' }, '2027-01-01')).toBe(true);
  });
});

describe('группировка отчёта', () => {
  it('итоги группы считаются по всем строкам курьера за день', () => {
    const rows = [
      {
        attemptId: 'a1',
        orderId: 'o1',
        orderNumber: 'N-1',
        routeId: 'r1',
        routeNumber: 'R-1',
        deliveryDate: '2028-04-10',
        courierUserId: 'c1',
        outcome: 'DELIVERED',
        cancelled: false,
        cashCollectable: true,
        cashMinor: '5000',
        paymentTypeName: null,
        perOrderMinor: '2000',
        perKmMinor: '1000',
        beyondMkadKmTenths: 24,
        distanceSource: 'COMPUTED' as const,
        deliveryFeeMinor: '2000',
        distanceFeeMinor: '2400',
        attemptFeeMinor: '0',
        expensesMinor: '0',
        bonusesMinor: '0',
        totalMinor: '600',
        settlementMissing: false,
      },
      {
        attemptId: 'a2',
        orderId: 'o2',
        orderNumber: 'N-2',
        routeId: 'r1',
        routeNumber: 'R-1',
        deliveryDate: '2028-04-10',
        courierUserId: 'c1',
        outcome: 'DELIVERED',
        cancelled: false,
        cashCollectable: false,
        cashMinor: '0',
        paymentTypeName: null,
        perOrderMinor: '2000',
        perKmMinor: '1000',
        beyondMkadKmTenths: 6,
        distanceSource: 'COMPUTED' as const,
        deliveryFeeMinor: '2000',
        distanceFeeMinor: '600',
        attemptFeeMinor: '0',
        expensesMinor: '0',
        bonusesMinor: '0',
        totalMinor: '-2600',
        settlementMissing: false,
      },
    ];

    const entries = [
      {
        id: 'e1',
        courierUserId: 'c1',
        kind: 'CASH_HANDED_TO_LOGIST' as const,
        amountMinor: '-1000',
        operationDate: '2028-04-10',
        occurredAt: '2028-04-10T10:00:00.000Z',
        actorUserId: 'l1',
        reason: null,
        comment: null,
        routeId: null,
        orderId: null,
        attemptId: null,
        reversesEntryId: null,
        reversed: false,
      },
    ];

    const days = groupSettlement(
      rows,
      entries,
      new Map([['c1', { id: 'c1', fullName: 'Курьер', phone: '+79990000000' }]]),
    );

    expect(days).toHaveLength(1);
    const group = days[0]?.couriers[0];
    expect(group?.sheets).toBe(1);
    expect(group?.orders).toBe(2);
    expect(group?.cashMinor).toBe('5000');
    expect(group?.deliveryFeesMinor).toBe('4000');
    // Километры складываются как есть: 2,4 + 0,6 = 3,0 км.
    expect(group?.distanceKmTenths).toBe(30);
    expect(group?.distanceFeesMinor).toBe('3000');
    expect(group?.accruedMinor).toBe('7000');
    expect(group?.operations.count).toBe(1);
    // Итог дня: строки доставок плюс операции этого дня.
    expect(group?.totalMinor).toBe('-3000');
  });

  it('строка без снимка помечает всю группу', () => {
    const base = {
      attemptId: 'a1',
      orderId: 'o1',
      orderNumber: 'N-1',
      routeId: 'r1',
      routeNumber: 'R-1',
      deliveryDate: '2028-04-11',
      courierUserId: 'c1',
      outcome: 'DELIVERED',
      cancelled: false,
      cashCollectable: true,
      cashMinor: '0',
      paymentTypeName: null,
      perOrderMinor: null,
      perKmMinor: null,
      beyondMkadKmTenths: null,
      distanceSource: null,
      deliveryFeeMinor: '0',
      distanceFeeMinor: '0',
      attemptFeeMinor: '0',
      expensesMinor: '0',
      bonusesMinor: '0',
      totalMinor: '0',
      settlementMissing: true,
    };

    const days = groupSettlement([base], [], new Map());
    expect(days[0]?.couriers[0]?.settlementMissing).toBe(true);
    // Курьера нет в справочнике — группа всё равно называет себя честно.
    expect(days[0]?.couriers[0]?.fullName).toBe('Курьер удалён из справочника');
  });

  it('страница режется по группам, а не по строкам', () => {
    const days = [
      {
        date: '2028-04-12',
        couriers: [
          { courierUserId: 'c1', rows: [1, 2, 3] } as never,
          { courierUserId: 'c2', rows: [4] } as never,
        ],
      },
      { date: '2028-04-11', couriers: [{ courierUserId: 'c3', rows: [5, 6] } as never] },
    ];

    const first = pageOfGroups(days, 2, 0);
    expect(first.totalGroups).toBe(3);
    expect(first.hasMore).toBe(true);
    expect(first.days).toHaveLength(1);
    expect(first.days[0]?.couriers).toHaveLength(2);

    const second = pageOfGroups(days, 2, 2);
    expect(second.hasMore).toBe(false);
    expect(second.days[0]?.date).toBe('2028-04-11');
    expect(second.days[0]?.couriers).toHaveLength(1);
  });
});

describe('наличные в строке отчёта', () => {
  it('недоставленный заказ не показывает наличных, и итог группы им не завышается', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    const day = '2028-04-27';
    await activateLedger(EARLIER);
    await seedTariff({ from: day, perOrder: 40_000n, perKm: 0n });
    const rates = await resolveTariff(ctx.db, day);

    const delivered = await seedRouteWithOrder({ courierId: courier.userId, day, cash: 499_000n });
    await captureRouteTariff(ctx.db, {
      routeId: delivered.routeId,
      deliveryDate: day,
      rates: rates!,
    });
    const failed = await seedRouteWithOrder({ courierId: courier.userId, day, cash: 499_000n });
    await captureRouteTariff(ctx.db, { routeId: failed.routeId, deliveryDate: day, rates: rates! });

    const activation = await readLedgerActivation(ctx.db);

    const deliveredAttempt = await seedAttempt({ ...delivered, courierId: courier.userId });
    await accrueDeliveryResult(ctx.db, activation, {
      attemptId: deliveredAttempt,
      routeOrderId: delivered.routeOrderId,
      routeId: delivered.routeId,
      orderId: delivered.orderId,
      courierUserId: courier.userId,
      actorUserId: logist.userId,
      outcome: 'DELIVERED',
    });

    const failedAttempt = await seedAttempt({
      ...failed,
      courierId: courier.userId,
      outcome: 'NOT_DELIVERED',
    });
    await accrueDeliveryResult(ctx.db, activation, {
      attemptId: failedAttempt,
      routeOrderId: failed.routeOrderId,
      routeId: failed.routeId,
      orderId: failed.orderId,
      courierUserId: courier.userId,
      actorUserId: logist.userId,
      outcome: 'NOT_DELIVERED',
    });

    const report = await buildSettlementReport(ctx.db, {
      from: day,
      to: day,
      courierUserId: courier.userId,
      ledgerActiveFrom: EARLIER,
    });

    const deliveredRow = report.rows.find((row) => row.attemptId === deliveredAttempt);
    const failedRow = report.rows.find((row) => row.attemptId === failedAttempt);

    // Курьер получил деньги только за доставленный заказ.
    expect(deliveredRow?.cashMinor).toBe('499000');
    expect(failedRow?.cashMinor).toBe('0');

    const group = report.days[0]?.couriers[0];
    expect(group?.cashMinor).toBe('499000');
    // Итог группы сходится с балансом: наличные минус оплата за доставку.
    expect(group?.totalMinor).toBe((499_000n - 40_000n).toString());
    expect(await balanceOf(ctx.db, courier.userId, null)).toBe(499_000n - 40_000n);
  });

  it('отменённая доставка снимает наличные со строки', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    const day = '2028-04-28';
    await activateLedger(EARLIER);

    const seeded = await seedRouteWithOrder({ courierId: courier.userId, day, cash: 300_000n });
    const attemptId = await seedAttempt({ ...seeded, courierId: courier.userId });
    await accrueDeliveryResult(ctx.db, await readLedgerActivation(ctx.db), {
      attemptId,
      routeOrderId: seeded.routeOrderId,
      routeId: seeded.routeId,
      orderId: seeded.orderId,
      courierUserId: courier.userId,
      actorUserId: logist.userId,
      outcome: 'DELIVERED',
    });

    await reverseDeliveryAccruals(ctx.db, {
      attemptId,
      actorUserId: logist.userId,
      reason: 'результат отменён логистом',
      operationDate: day,
    });

    const report = await buildSettlementReport(ctx.db, {
      from: day,
      to: day,
      courierUserId: courier.userId,
      ledgerActiveFrom: EARLIER,
    });

    expect(report.rows[0]?.cashMinor).toBe('0');
    expect(report.days[0]?.couriers[0]?.cashMinor).toBe('0');
  });
});

describe('realtime денежных операций', () => {
  it('событие несёт только операционный день: ни сумм, ни курьера, ни причин', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    const day = '2028-04-26';

    await ctx.db.$transaction(async (tx) => {
      await appendEntry(tx, {
        courierUserId: courier.userId,
        kind: 'EXPENSE_OTHER',
        amountMinor: 12_345n,
        operationDate: day,
        actorUserId: logist.userId,
        reason: 'парковка у бизнес-центра',
        idempotencyKey: unique('rt'),
      });

      // Тот же вызов, что делает эндпоинт операции.
      await publishRealtimeEvent(tx, {
        topic: 'finance.ledger_changed',
        payload: { operationDate: day },
        audienceRoles: ['ADMIN', 'LOGISTICIAN'],
      });
    });

    const event = await ctx.db.realtimeEvent.findFirst({
      where: { topic: 'finance.ledger_changed' },
      orderBy: [{ id: 'desc' }],
      select: { payload: true },
    });

    expect(Object.keys((event?.payload ?? {}) as Record<string, unknown>)).toEqual([
      'operationDate',
    ]);

    const serialized = JSON.stringify(event?.payload);
    expect(serialized).not.toContain('12345');
    expect(serialized).not.toContain(courier.userId);
    expect(serialized).not.toContain('парковка');
  });

  it('денежные подробности в payload запрещены проверкой на записи', () => {
    expect(() =>
      assertPayloadIsSafe({ operationDate: '2028-04-26', phone: '+79990000000' }),
    ).toThrow();
    expect(() =>
      assertPayloadIsSafe({ operationDate: '2028-04-26', comment: 'парковка' }),
    ).toThrow();
  });
});

describe('операции из ячеек таблицы', () => {
  it('несколько операций одного вида за день суммируются и попадают в итог', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    const day = '2028-04-29';
    await activateLedger(EARLIER);

    // Три расхода, две сдачи и одна выдача за один день.
    const operations: [Parameters<typeof appendEntry>[1]['kind'], bigint, string][] = [
      ['EXPENSE_OTHER', 15_000n, 'парковка'],
      ['EXPENSE_OTHER', 5_000n, 'платная дорога'],
      ['EXPENSE_OTHER', 2_500n, 'погрузка'],
      ['CASH_HANDED_TO_LOGIST', 100_000n, 'сдача днём'],
      ['CASH_HANDED_TO_LOGIST', 50_000n, 'сдача вечером'],
      ['CASH_ISSUED_TO_COURIER', 20_000n, 'размен'],
    ];

    for (const [kind, amount, reason] of operations) {
      await appendEntry(ctx.db, {
        courierUserId: courier.userId,
        kind,
        amountMinor: amount,
        operationDate: day,
        actorUserId: logist.userId,
        reason,
        idempotencyKey: unique('cell'),
      });
    }

    const report = await buildSettlementReport(ctx.db, {
      from: day,
      to: day,
      courierUserId: courier.userId,
      ledgerActiveFrom: EARLIER,
    });

    const group = report.days[0]?.couriers[0];
    expect(group?.extraExpensesMinor).toBe('22500');
    expect(group?.handedMinor).toBe('150000');
    expect(group?.issuedMinor).toBe('20000');
    // «Доп.» входит в начисления курьеру.
    expect(group?.accruedMinor).toBe('22500');
    // Итог дня: −22 500 (расходы) − 150 000 (сдал) + 20 000 (выдано).
    expect(group?.totalMinor).toBe('-152500');
    expect(await balanceOf(ctx.db, courier.userId, null)).toBe(-152_500n);

    // Журнал: шесть операций с автором и временем.
    expect(group?.operations.count).toBe(6);
    expect(group?.operations.entries[0]?.actorName).not.toBeNull();
    expect(group?.operations.entries[0]?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('обратная корректировка операции ячейки убирает её из суммы столбца', async () => {
    const courier = await actorFor(['COURIER']);
    const logist = await actorFor(['LOGISTICIAN']);
    const day = '2028-04-30';
    await activateLedger(EARLIER);

    const entry = await appendEntry(ctx.db, {
      courierUserId: courier.userId,
      kind: 'CASH_HANDED_TO_LOGIST',
      amountMinor: 70_000n,
      operationDate: day,
      actorUserId: logist.userId,
      idempotencyKey: unique('cell'),
    });

    await reverseEntry(ctx.db, {
      entryId: entry.id,
      actorUserId: logist.userId,
      reason: 'сдача записана дважды',
      operationDate: day,
    });

    const report = await buildSettlementReport(ctx.db, {
      from: day,
      to: day,
      courierUserId: courier.userId,
      ledgerActiveFrom: EARLIER,
    });

    const group = report.days[0]?.couriers[0];
    // Исходная запись осталась в журнале и помечена отменённой.
    expect(group?.operations.entries.some((item) => item.reversed)).toBe(true);
    // Итог дня обнулился: обратная запись компенсировала исходную.
    expect(group?.totalMinor).toBe('0');
    expect(await balanceOf(ctx.db, courier.userId, null)).toBe(0n);
  });
});
