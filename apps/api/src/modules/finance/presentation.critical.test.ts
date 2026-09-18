/**
 * Одна фикстура на всём пути показа: журнал → API → дни → период → экран →
 * XLSX → PDF.
 *
 * Каждое из этих мест проверялось по отдельности, и это оставляло место
 * молчаливому расхождению: отчёт мог быть верным, выгрузка — внутренне
 * согласованной, а числа в них разными. Человек сверяет экран с файлом
 * глазами, и первая же несходящаяся копейка обесценивает оба.
 *
 * Поэтому здесь ОДИН набор денег и одно ожидание на все представления:
 * ожидаемые суммы заданы явно, и каждое представление сверяется с ними, а не
 * с соседним. Взаимная сверка двух выгрузок доказала бы лишь, что они оба
 * считаны из одного отчёта, — но не то, что отчёт верен.
 *
 * ВЛАДЕНИЕ ДАТАМИ: ноябрь 2030 (см. RESERVED_MONTHS).
 */

import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
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
import { buildSettlementReport, type SettlementReport } from './reports.js';
import { changeOf } from './grouping.js';
import { buildSettlementWorkbook, toRubles } from './export-xlsx.js';
import { formatRubles, settlementSummaryLines } from './export-pdf.js';
import {
  formatMoney,
  journalColumn,
  SETTLEMENT_COLUMNS,
} from '../../../../web/src/screens/logistics/ReportsScreen.js';

let ctx: TestContext;

const DAY = '2030-11-12';
const NEXT_DAY = '2030-11-13';
const ACTIVE_FROM = '2030-11-01';

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

/**
 * Фикстура одного дня курьера БЕЗ доставок.
 *
 * Строк заказов здесь нет намеренно: проверяется путь показа, а не расчёт
 * тарифа. Все суммы приходят журналом, и потому известны заранее до копейки.
 */
const FIXTURE = {
  openingDebt: 500_000n,
  cashReceived: 300_000n,
  deliveryFee: 120_000n,
  attemptFee: 20_000n,
  parking: 30_000n,
  handed: 250_000n,
} as const;

interface Fixture {
  courierUserId: string;
  fullName: string;
  parkingId: string;
}

async function seedFixture(): Promise<Fixture> {
  const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
  const logist = await actorFor(['LOGISTICIAN']);
  const admin = await actorFor(['ADMIN']);

  const parking = await ctx.db.$transaction(async (tx) => {
    await appendEntry(tx, {
      courierUserId: courier.id,
      kind: 'OPENING_DEBT',
      amountMinor: FIXTURE.openingDebt,
      operationDate: DAY,
      actorUserId: admin.userId,
      reason: 'долг до перехода на учёт',
      idempotencyKey: unique('show-debt'),
    });
    await appendEntry(tx, {
      courierUserId: courier.id,
      kind: 'CASH_RECEIVED',
      amountMinor: FIXTURE.cashReceived,
      operationDate: DAY,
      actorUserId: logist.userId,
      idempotencyKey: unique('show-cash'),
    });
    await appendEntry(tx, {
      courierUserId: courier.id,
      kind: 'DELIVERY_FEE',
      amountMinor: FIXTURE.deliveryFee,
      operationDate: DAY,
      actorUserId: logist.userId,
      idempotencyKey: unique('show-fee'),
    });
    await appendEntry(tx, {
      courierUserId: courier.id,
      kind: 'ATTEMPT_FEE',
      amountMinor: FIXTURE.attemptFee,
      operationDate: DAY,
      actorUserId: logist.userId,
      idempotencyKey: unique('show-attempt'),
    });
    await appendEntry(tx, {
      courierUserId: courier.id,
      kind: 'CASH_HANDED_TO_LOGIST',
      amountMinor: FIXTURE.handed,
      operationDate: DAY,
      actorUserId: logist.userId,
      idempotencyKey: unique('show-handed'),
    });
    return appendEntry(tx, {
      courierUserId: courier.id,
      kind: 'EXPENSE_PARKING',
      amountMinor: FIXTURE.parking,
      operationDate: DAY,
      actorUserId: logist.userId,
      reason: 'парковка',
      idempotencyKey: unique('show-parking'),
    });
  });

  return { courierUserId: courier.id, fullName: courier.fullName, parkingId: parking.id };
}

function report(fixture: Fixture, from: string, to: string): Promise<SettlementReport> {
  return buildSettlementReport(ctx.db, {
    from,
    to,
    courierUserId: fixture.courierUserId,
    ledgerActiveFrom: ACTIVE_FROM,
    limit: 50,
    offset: 0,
  });
}

/** Лист выгрузки как таблица значений: файл читается обратно, а не собирается. */
async function sheetOf(buffer: Buffer, name: string): Promise<unknown[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet(name);
  expect(sheet, `лист «${name}»`).toBeDefined();

  const table: unknown[][] = [];
  sheet!.eachRow((row) => {
    table.push((row.values as unknown[]).slice(1));
  });
  return table;
}

describe('одна фикстура на всём пути показа', () => {
  /*
   * Ожидание задано здесь и один раз.
   *
   * Знаки — ОТЧЁТНЫЕ, а не журнальные. В журнале заработок и расходы курьера
   * отрицательны (они уменьшают его долг), но отчёт показывает заработок
   * заработком: плюсом. Журнальный знак сохраняют только те виды, что растят
   * долг, — полученные наличные, выданные курьеру деньги и начальный долг.
   */
  const expected = {
    cash: FIXTURE.cashReceived,
    deliveryFees: FIXTURE.deliveryFee,
    attemptFees: FIXTURE.attemptFee,
    extra: FIXTURE.parking,
    handed: FIXTURE.handed,
    openingDebt: FIXTURE.openingDebt,
  };
  const accrued = expected.deliveryFees + expected.attemptFees + expected.extra;
  /*
   * Итог дня — вклад в БАЛАНС, и он считается журнальными знаками: заработок
   * и сдача наличных долг уменьшают. Совпадение с `balanceOf` ниже и есть
   * доказательство, что показанное и посчитанное — одни деньги.
   */
  const total =
    FIXTURE.cashReceived -
    FIXTURE.deliveryFee -
    FIXTURE.attemptFee -
    FIXTURE.parking -
    FIXTURE.handed +
    FIXTURE.openingDebt;

  it('журнал, дневная группа и итог периода говорят одно и то же', async () => {
    const fixture = await seedFixture();
    const built = await report(fixture, DAY, DAY);

    const group = built.days.find((day) => day.date === DAY)?.couriers[0];
    expect(group?.courierUserId).toBe(fixture.courierUserId);

    // 1. Журнал группы — ровно записи этого курьера за этот день, без чужих.
    const stored = await ctx.db.courierLedgerEntry.findMany({
      where: {
        courierUserId: fixture.courierUserId,
        operationDate: new Date(`${DAY}T00:00:00.000Z`),
      },
      select: { id: true, amountMinor: true },
    });
    expect([...(group?.operations.entries ?? [])].map((entry) => entry.id).sort()).toEqual(
      stored.map((entry) => entry.id).sort(),
    );

    // 2. Показатели группы — ожидаемые суммы, а не пересчёт соседнего места.
    expect(BigInt(group!.cashMinor)).toBe(expected.cash);
    expect(BigInt(group!.deliveryFeesMinor)).toBe(expected.deliveryFees);
    expect(BigInt(group!.attemptFeesMinor)).toBe(expected.attemptFees);
    expect(BigInt(group!.extraExpensesMinor)).toBe(expected.extra);
    expect(BigInt(group!.handedMinor)).toBe(expected.handed);
    expect(BigInt(group!.openingDebtMinor)).toBe(expected.openingDebt);
    expect(BigInt(group!.accruedMinor)).toBe(accrued);
    expect(BigInt(group!.totalMinor)).toBe(total);

    // 3. Итог периода — те же деньги и то же изменение баланса курьера.
    expect(BigInt(built.totals.closingBalanceMinor)).toBe(total);
    expect(await balanceOf(ctx.db, fixture.courierUserId, null)).toBe(total);
    expect(BigInt(built.totals.cashReceivedMinor)).toBe(expected.cash);
    expect(BigInt(built.totals.openingDebtMinor)).toBe(expected.openingDebt);
    expect(BigInt(built.totals.deliveryFeesMinor)).toBe(expected.deliveryFees);
    expect(BigInt(built.totals.attemptFeesMinor)).toBe(expected.attemptFees);
    expect(BigInt(built.totals.expensesMinor)).toBe(expected.extra);
    expect(BigInt(built.totals.handedToLogistMinor)).toBe(expected.handed);
  });

  it('экран ставит каждую сумму журнала под столбец её же показателя', async () => {
    /*
     * Связь экрана с расчётом: сумма строки журнала обязана встать под тем
     * заголовком, в чей показатель дня она вошла. Иначе свёрнутая строка и
     * раскрытый журнал показывают одно и то же число в разных местах, и
     * сверить их глазами нельзя.
     */
    const fixture = await seedFixture();
    const built = await report(fixture, DAY, DAY);
    const group = built.days.find((day) => day.date === DAY)!.couriers[0]!;

    const shownUnder = new Map<string, bigint>([
      ['Наличные', BigInt(group.cashMinor)],
      ['За заказ', BigInt(group.deliveryFeesMinor)],
      ['Начислено', BigInt(group.attemptFeesMinor)],
      ['Доп.', BigInt(group.extraExpensesMinor)],
      ['Курьер сдал', BigInt(group.handedMinor)],
    ]);

    for (const entry of group.operations.entries) {
      if (entry.kind === 'OPENING_DEBT') {
        // У начального долга своя строка журнала: он не показатель заработка.
        continue;
      }
      const header = SETTLEMENT_COLUMNS[journalColumn(entry.kind) - 1] ?? '';
      /*
       * Вклад ОДНОЙ записи в показатель считает та же функция, что и день:
       * повторять здесь правило знака значило бы проверять свою копию правила.
       */
      const contribution = changeOf([entry], [entry.kind]);
      expect(shownUnder.get(header), `${entry.kind} → «${header}»`).toBe(contribution);
    }

    // И деньги на экране пишутся тем же правилом, что в отчёте.
    expect(formatMoney(group.totalMinor)).toBe(formatRubles(group.totalMinor));
  });

  it('XLSX и PDF показывают те же числа, что отчёт', async () => {
    const fixture = await seedFixture();
    const built = await report(fixture, DAY, DAY);
    const group = built.days.find((day) => day.date === DAY)!.couriers[0]!;

    const workbook = await buildSettlementWorkbook(built);

    // «Итоги»: подпись → число. Сверяется со значением отчёта, а не с PDF.
    const summary = new Map(
      (await sheetOf(workbook, 'Итоги'))
        .slice(1)
        .map((row) => [String(row[0]), row[1]] as [string, unknown]),
    );
    expect(summary.get('Наличные, полученные курьером')).toBe(toRubles(expected.cash.toString()));
    expect(summary.get('Начальный долг')).toBe(toRubles(expected.openingDebt.toString()));
    expect(summary.get('Сдано логисту')).toBe(toRubles(expected.handed.toString()));
    expect(summary.get('Конечный баланс')).toBe(toRubles(total.toString()));

    // «Заказы»: строка итога дня — те же показатели, что у дневной группы.
    const orders = await sheetOf(workbook, 'Заказы');
    const header = orders[0]!.map((name) => String(name));
    const dayRow = orders.slice(1).find((row) => String(row[0]) === 'Итог дня')!;
    const cell = (name: string): unknown => dayRow[header.indexOf(name)];
    expect(cell('Дата')).toBe(DAY);
    expect(cell('Наличные, ₽')).toBe(toRubles(group.cashMinor));
    expect(cell('За заказ, ₽')).toBe(toRubles(group.deliveryFeesMinor));
    expect(cell('Доп., ₽')).toBe(toRubles(group.extraExpensesMinor));
    expect(cell('Начислено, ₽')).toBe(toRubles(group.accruedMinor));
    expect(cell('Курьер сдал, ₽')).toBe(toRubles(group.handedMinor));
    expect(cell('Начальный долг, ₽')).toBe(toRubles(group.openingDebtMinor));
    expect(cell('Итог, ₽')).toBe(toRubles(group.totalMinor));

    // PDF: те же подписи и те же суммы, только уже строками для бумаги.
    const pdf = new Map(settlementSummaryLines(built));
    expect(pdf.get('Наличные, полученные курьером')).toBe(formatRubles(expected.cash.toString()));
    expect(pdf.get('Начальный долг')).toBe(formatRubles(expected.openingDebt.toString()));
    expect(pdf.get('Сдано логисту')).toBe(formatRubles(expected.handed.toString()));
    expect(pdf.get('Оплачиваемые попытки')).toBe(formatRubles(expected.attemptFees.toString()));
  });

  it('отмена следующего дня уходит в СВОЙ день и не переписывает прошлый', async () => {
    /*
     * Правка задним числом — самый дорогой способ потерять доверие к отчёту:
     * закрытый день обязан остаться прежним. Отмена живёт в своём дне и
     * уменьшает ту же категорию, что и отменённая запись.
     */
    const fixture = await seedFixture();
    const admin = await actorFor(['ADMIN']);
    const before = await report(fixture, DAY, DAY);

    await ctx.db.$transaction((tx) =>
      reverseEntry(tx, {
        entryId: fixture.parkingId,
        actorUserId: admin.userId,
        reason: 'парковка не подтверждена',
        operationDate: NEXT_DAY,
      }),
    );

    // Прошлый день не изменился ни в одном показателе.
    const after = await report(fixture, DAY, DAY);
    expect(after.totals).toEqual(before.totals);

    // А в своём дне отмена уменьшает «Доп.» — ту же категорию, с обратным знаком.
    const nextDay = await report(fixture, NEXT_DAY, NEXT_DAY);
    expect(BigInt(nextDay.totals.expensesMinor)).toBe(-FIXTURE.parking);
    /*
     * Конечный баланс — накопленный, а не изменение: закрытый день приходит
     * входящим сальдо, и отмена добавляет к нему ровно снятый расход.
     */
    expect(BigInt(nextDay.totals.openingBalanceMinor)).toBe(total);
    expect(BigInt(nextDay.totals.closingBalanceMinor)).toBe(total + FIXTURE.parking);

    // За оба дня вместе — сумма дней, и она же входящее сальдо третьего дня.
    const both = await report(fixture, DAY, NEXT_DAY);
    expect(BigInt(both.totals.closingBalanceMinor)).toBe(total + FIXTURE.parking);
    expect(
      both.days
        .flatMap((day) => day.couriers)
        .reduce((sum, courier) => sum + BigInt(courier.totalMinor), 0n),
    ).toBe(total + FIXTURE.parking);
  });
});
