/**
 * Общая матрица финансовых категорий.
 *
 * Проверяет не отдельный найденный дефект, а ПРАВИЛО целиком: каждый вид
 * операции принадлежит ровно одной категории отчёта, имеет один знак, входит в
 * баланс один раз, а его отмена уменьшает ту же категорию — в тот же день или
 * в свой собственный, но никогда не превращаясь в чужой показатель.
 *
 * Отдельно закреплено: начальный долг и движения наличных НЕ становятся
 * заработком, а оплачиваемая попытка не удваивается между «своим» столбцом
 * и «Доп.».
 *
 * ВЛАДЕНИЕ ДАТАМИ: сентябрь 2030 (см. RESERVED_MONTHS).
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
import { appendEntry, balanceOf, reverseEntry } from './ledger.js';
import { buildSettlementReport, type SettlementReport, type SettlementTotals } from './reports.js';

let ctx: TestContext;

const DAY = '2030-09-12';
const NEXT_DAY = '2030-09-13';

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

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return { userId: user.id, roles, familyId: randomUUID() } as AuthenticatedActor;
}

async function report(from: string, to: string, courierUserId: string): Promise<SettlementReport> {
  return buildSettlementReport(ctx.db, {
    from,
    to,
    courierUserId,
    ledgerActiveFrom: '2030-09-01',
    limit: 50,
    offset: 0,
  });
}

/** Сумма дневных групп по одному полю: она обязана сходиться с итогом периода. */
function sumDays(
  built: SettlementReport,
  field:
    'cashMinor' | 'deliveryFeesMinor' | 'distanceFeesMinor' | 'attemptFeesMinor' | 'accruedMinor',
): bigint {
  return built.days
    .flatMap((day) => day.couriers)
    .reduce((total, courier) => total + BigInt(courier[field]), 0n);
}

/** Категории итогов, по которым проверяется «ровно одна». */
const CATEGORY_FIELDS = [
  'cashReceivedMinor',
  'cashCorrectionsMinor',
  'handedToLogistMinor',
  'issuedToCourierMinor',
  'deliveryFeesMinor',
  'attemptFeesMinor',
  'distanceFeesMinor',
  'expensesMinor',
  'bonusesMinor',
  'adjustmentsMinor',
  'openingDebtMinor',
] as const;

type CategoryField = (typeof CATEGORY_FIELDS)[number];

interface Case {
  kind: string;
  /** Поле итогов, в которое обязана попасть операция. */
  field: CategoryField;
  /** Показатель категории в день операции. */
  shown: bigint;
  /** Вклад в баланс курьера в день операции (знак журнала). */
  balance: bigint;
  /** Участвует ли в «Начислено». */
  salary: boolean;
}

const AMOUNT = 200_00n;

const CASES: readonly Case[] = [
  // Долг до перехода на ERP: растит долг, заработком не является.
  {
    kind: 'OPENING_DEBT',
    field: 'openingDebtMinor',
    shown: AMOUNT,
    balance: AMOUNT,
    salary: false,
  },
  // Деньги покупателя у курьера: растят его долг, но это не заработок.
  {
    kind: 'CASH_RECEIVED',
    field: 'cashReceivedMinor',
    shown: AMOUNT,
    balance: AMOUNT,
    salary: false,
  },
  // Фактические передачи денег: тоже не заработок.
  {
    kind: 'CASH_HANDED_TO_LOGIST',
    field: 'handedToLogistMinor',
    shown: AMOUNT,
    balance: -AMOUNT,
    salary: false,
  },
  {
    kind: 'CASH_ISSUED_TO_COURIER',
    field: 'issuedToCourierMinor',
    shown: AMOUNT,
    balance: AMOUNT,
    salary: false,
  },
  // Корректировка наличных показывается знаком журнала: это уменьшение.
  {
    kind: 'CASH_PAYMENT_CORRECTION',
    field: 'cashCorrectionsMinor',
    shown: -AMOUNT,
    balance: -AMOUNT,
    salary: false,
  },
  // Заработок курьера.
  {
    kind: 'DELIVERY_FEE',
    field: 'deliveryFeesMinor',
    shown: AMOUNT,
    balance: -AMOUNT,
    salary: true,
  },
  {
    kind: 'DISTANCE_FEE',
    field: 'distanceFeesMinor',
    shown: AMOUNT,
    balance: -AMOUNT,
    salary: true,
  },
  { kind: 'ATTEMPT_FEE', field: 'attemptFeesMinor', shown: AMOUNT, balance: -AMOUNT, salary: true },
  { kind: 'BONUS', field: 'bonusesMinor', shown: AMOUNT, balance: -AMOUNT, salary: true },
  {
    kind: 'EXPENSE_PARKING',
    field: 'expensesMinor',
    shown: AMOUNT,
    balance: -AMOUNT,
    salary: true,
  },
  { kind: 'EXPENSE_TOLL', field: 'expensesMinor', shown: AMOUNT, balance: -AMOUNT, salary: true },
  {
    kind: 'EXPENSE_TRANSIT',
    field: 'expensesMinor',
    shown: AMOUNT,
    balance: -AMOUNT,
    salary: true,
  },
  { kind: 'EXPENSE_REPAIR', field: 'expensesMinor', shown: AMOUNT, balance: -AMOUNT, salary: true },
  {
    kind: 'EXPENSE_LOADING',
    field: 'expensesMinor',
    shown: AMOUNT,
    balance: -AMOUNT,
    salary: true,
  },
  { kind: 'EXPENSE_OTHER', field: 'expensesMinor', shown: AMOUNT, balance: -AMOUNT, salary: true },
];

/** Все категории, кроме названной, обязаны быть нулевыми. */
function expectOnly(totals: SettlementTotals, field: CategoryField, value: bigint): void {
  for (const name of CATEGORY_FIELDS) {
    const actual = BigInt(totals[name]);
    if (name === field) {
      expect(`${name}=${actual}`).toBe(`${name}=${value}`);
    } else {
      expect(`${name}=${actual}`).toBe(`${name}=0`);
    }
  }
}

async function append(
  courierUserId: string,
  kind: string,
  key: string,
  day: string,
): Promise<string> {
  const admin = await actorFor(['ADMIN']);
  const entry = await ctx.db.$transaction((tx) =>
    appendEntry(tx, {
      courierUserId,
      kind: kind as never,
      amountMinor: AMOUNT,
      operationDate: day,
      actorUserId: admin.userId,
      // У расходов причина обязательна на уровне базы.
      reason: 'проверка матрицы категорий',
      idempotencyKey: key,
    }),
  );
  return entry.id;
}

describe.each(CASES)('категория $kind', (item) => {
  it('знак, баланс, единственная категория, повтор и отмена следующего дня', async () => {
    const courier = (await actorFor(['COURIER'])).userId;
    const key = unique(`m-${item.kind}`);

    const entryId = await append(courier, item.kind, key, DAY);
    // Повтор с тем же ключом не создаёт вторую запись и не двоит суммы.
    await append(courier, item.kind, key, DAY);
    expect(await ctx.db.courierLedgerEntry.count({ where: { courierUserId: courier } })).toBe(1);

    // --- день операции ---
    const onDay = await report(DAY, DAY, courier);
    expectOnly(onDay.totals, item.field, item.shown);
    expect(onDay.totals.closingBalanceMinor).toBe(item.balance.toString());
    expect(await balanceOf(ctx.db, courier, null)).toBe(item.balance);
    // Заработок дня: только зарплатные виды.
    expect(sumDays(onDay, 'accruedMinor')).toBe(item.salary ? AMOUNT : 0n);

    // --- отмена на СЛЕДУЮЩИЙ день ---
    const admin = await actorFor(['ADMIN']);
    await ctx.db.$transaction((tx) =>
      reverseEntry(tx, {
        entryId,
        actorUserId: admin.userId,
        reason: 'отмена в проверке матрицы',
        operationDate: NEXT_DAY,
      }),
    );

    const onNext = await report(NEXT_DAY, NEXT_DAY, courier);
    // Та же категория с обратным знаком, а не «обратные корректировки».
    expectOnly(onNext.totals, item.field, -item.shown);
    expect(onNext.totals.openingBalanceMinor).toBe(item.balance.toString());
    expect(onNext.totals.closingBalanceMinor).toBe('0');
    expect(sumDays(onNext, 'accruedMinor')).toBe(item.salary ? -AMOUNT : 0n);

    // --- общий период ---
    const both = await report(DAY, NEXT_DAY, courier);
    expectOnly(both.totals, item.field, 0n);
    expect(both.totals.closingBalanceMinor).toBe('0');
    expect(sumDays(both, 'accruedMinor')).toBe(0n);
    // Движения обоих дней сохранены: две группы, а не одна.
    expect(both.days.map((day) => day.date).sort()).toEqual([DAY, NEXT_DAY]);
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);
  });

  it('отмена в тот же день обнуляет категорию и заработок', async () => {
    const courier = (await actorFor(['COURIER'])).userId;
    const entryId = await append(courier, item.kind, unique(`s-${item.kind}`), DAY);

    const admin = await actorFor(['ADMIN']);
    await ctx.db.$transaction((tx) =>
      reverseEntry(tx, {
        entryId,
        actorUserId: admin.userId,
        reason: 'отмена в тот же день',
        operationDate: DAY,
      }),
    );

    const onDay = await report(DAY, DAY, courier);
    expectOnly(onDay.totals, item.field, 0n);
    expect(onDay.totals.closingBalanceMinor).toBe('0');
    expect(sumDays(onDay, 'accruedMinor')).toBe(0n);
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);

    // Исходная запись и её отмена остались в журнале: история не переписана.
    expect(await ctx.db.courierLedgerEntry.count({ where: { courierUserId: courier } })).toBe(2);
  });
});

describe('заработок считается ровно один раз', () => {
  it('оплачиваемая попытка не удваивается между своим столбцом и «Доп.»', async () => {
    const courier = (await actorFor(['COURIER'])).userId;
    await append(courier, 'ATTEMPT_FEE', unique('attempt-once'), DAY);

    const onDay = await report(DAY, DAY, courier);
    const group = onDay.days.find((day) => day.date === DAY)?.couriers[0];

    expect(group?.attemptFeesMinor).toBe(AMOUNT.toString());
    // «Доп.» о попытке ничего не знает: у неё собственный столбец.
    expect(group?.extraExpensesMinor).toBe('0');
    // Поэтому «Начислено» равно самой попытке, а не её удвоению.
    expect(group?.accruedMinor).toBe(AMOUNT.toString());
    expect(onDay.totals.closingBalanceMinor).toBe((-AMOUNT).toString());
  });

  it('дневные суммы категорий сходятся с итогами периода', async () => {
    const courier = (await actorFor(['COURIER'])).userId;

    // По одной операции каждого вида в один день.
    for (const item of CASES) {
      await append(courier, item.kind, unique(`all-${item.kind}`), DAY);
    }

    const onDay = await report(DAY, DAY, courier);

    expect(sumDays(onDay, 'cashMinor')).toBe(
      BigInt(onDay.totals.cashReceivedMinor) + BigInt(onDay.totals.cashCorrectionsMinor),
    );
    expect(sumDays(onDay, 'deliveryFeesMinor')).toBe(BigInt(onDay.totals.deliveryFeesMinor));
    expect(sumDays(onDay, 'distanceFeesMinor')).toBe(BigInt(onDay.totals.distanceFeesMinor));
    expect(sumDays(onDay, 'attemptFeesMinor')).toBe(BigInt(onDay.totals.attemptFeesMinor));

    /*
     * «Доп.» по определению объединяет расходы и доплаты — но ничего сверх них.
     * Начальный долг и движения наличных сюда не попадают.
     */
    const extra = onDay.days
      .flatMap((day) => day.couriers)
      .reduce((total, courier2) => total + BigInt(courier2.extraExpensesMinor), 0n);
    expect(extra).toBe(BigInt(onDay.totals.expensesMinor) + BigInt(onDay.totals.bonusesMinor));

    // «Начислено» — только заработок: доставка, МКАД, попытка, расходы и доплаты.
    const salary = CASES.filter((item) => item.salary).reduce((total) => total + AMOUNT, 0n);
    expect(sumDays(onDay, 'accruedMinor')).toBe(salary);

    // Баланс сходится с журналом.
    expect(onDay.totals.closingBalanceMinor).toBe(
      (await balanceOf(ctx.db, courier, DAY)).toString(),
    );
  });

  it('начальный долг и наличные никогда не попадают в заработок', async () => {
    const courier = (await actorFor(['COURIER'])).userId;

    for (const kind of [
      'OPENING_DEBT',
      'CASH_RECEIVED',
      'CASH_HANDED_TO_LOGIST',
      'CASH_ISSUED_TO_COURIER',
      'CASH_PAYMENT_CORRECTION',
    ]) {
      await append(courier, kind, unique(`nosalary-${kind}`), DAY);
    }

    const onDay = await report(DAY, DAY, courier);
    expect(sumDays(onDay, 'accruedMinor')).toBe(0n);
    expect(onDay.totals.deliveryFeesMinor).toBe('0');
    expect(onDay.totals.distanceFeesMinor).toBe('0');
    expect(onDay.totals.attemptFeesMinor).toBe('0');
    expect(onDay.totals.expensesMinor).toBe('0');
    expect(onDay.totals.bonusesMinor).toBe('0');
  });
});
