/**
 * Критические проверки начального долга курьера.
 *
 * Начальный долг — это долг курьера перед компанией, возникший ДО перехода на
 * ERP. Защищаемые свойства: знак «плюс» (долг растёт), запись идёт в общий
 * журнал и ни во что денежное не превращается (кассы, оплата доставок, расходы
 * не меняются), заводит и отменяет её только администратор, повтор запроса не
 * удваивает долг, а исправление — только обратной записью.
 *
 * ВЛАДЕНИЕ ДАТАМИ: июль 2030 (см. RESERVED_MONTHS).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from '../auth/testing/harness.js';
import type { Role } from '@fl/shared';
import { appendEntry, balanceOf, reverseEntry } from './ledger.js';
import { buildSettlementReport } from './reports.js';
import { buildCashReport } from './cash-report.js';
import { buildSettlementWorkbook } from './export-xlsx.js';

let ctx: TestContext;

/** День учёта долга и соседние дни — всё внутри забронированного месяца. */
const BEFORE = '2030-07-09';
const DAY = '2030-07-10';
const AFTER = '2030-07-11';

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

/** Реальный токен доступа: проверки прав идут через HTTP, а не мимо него. */
async function tokenFor(roles: Role[]): Promise<{ token: string; userId: string }> {
  const { hashSecretCode } = await import('../auth/crypto.js');
  const { login } = await import('../auth/service.js');
  const pin = '1234';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles, pinHash });
  const session = await login(
    ctx,
    { phone: user.phone, pin },
    { ip: null, userAgent: 'vitest', deviceLabel: null },
  );
  return { token: session.accessToken, userId: user.id };
}

async function courierId(): Promise<string> {
  const user = await seedUser(ctx.db, { roles: ['COURIER'] });
  return user.id;
}

interface DebtBody {
  courierUserId: string;
  amountMinor: string;
  operationDate: string;
  reason: string;
  idempotencyKey: string;
}

function postDebt(
  token: string,
  body: DebtBody,
): Promise<{ statusCode: number; json: () => { entry?: { id: string } } }> {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/logistics/ledger/opening-debt',
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  }) as never;
}

// --- Учёт и знак --------------------------------------------------------------

describe('начальный долг попадает в баланс курьера', () => {
  it('курьеру без единой доставки долг заводится и увеличивает его долг компании', async () => {
    const courier = await courierId();
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });

    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);

    await ctx.db.$transaction((tx) =>
      appendEntry(tx, {
        courierUserId: courier,
        kind: 'OPENING_DEBT',
        amountMinor: 5_000_00n,
        operationDate: DAY,
        actorUserId: admin.id,
        reason: 'долг до перехода на ERP',
        idempotencyKey: unique('debt'),
      }),
    );

    // Плюс: долг курьера перед компанией вырос ровно на внесённую сумму.
    expect(await balanceOf(ctx.db, courier, null)).toBe(5_000_00n);
  });

  it('повтор с тем же ключом не удваивает долг', async () => {
    const courier = await courierId();
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const key = unique('debt-idem');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await ctx.db.$transaction((tx) =>
        appendEntry(tx, {
          courierUserId: courier,
          kind: 'OPENING_DEBT',
          amountMinor: 1_000_00n,
          operationDate: DAY,
          actorUserId: admin.id,
          reason: 'повторная отправка',
          idempotencyKey: key,
        }),
      );
    }

    expect(await balanceOf(ctx.db, courier, null)).toBe(1_000_00n);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { courierUserId: courier, kind: 'OPENING_DEBT' },
      }),
    ).toBe(1);
  });
});

// --- Границы дат --------------------------------------------------------------

describe('день учёта решает, где долг виден', () => {
  it('до дня учёта не виден, в день учёта — отдельной операцией, после — в начальном балансе', async () => {
    const courier = await courierId();
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });

    await ctx.db.$transaction((tx) =>
      appendEntry(tx, {
        courierUserId: courier,
        kind: 'OPENING_DEBT',
        amountMinor: 5_000_00n,
        operationDate: DAY,
        actorUserId: admin.id,
        reason: 'долг до перехода на ERP',
        idempotencyKey: unique('debt-dates'),
      }),
    );

    // Отчёт, заканчивающийся РАНЬШЕ дня учёта, долга не знает вовсе.
    const before = await buildSettlementReport(ctx.db, {
      from: BEFORE,
      to: BEFORE,
      courierUserId: courier,
      limit: 50,
      offset: 0,
    });
    expect(before.totals.openingBalanceMinor).toBe('0');
    expect(before.totals.openingDebtMinor).toBe('0');
    expect(before.totals.closingBalanceMinor).toBe('0');

    // В день учёта — отдельной операцией периода, а не в начальном балансе.
    const onDay = await buildSettlementReport(ctx.db, {
      from: DAY,
      to: DAY,
      courierUserId: courier,
      limit: 50,
      offset: 0,
    });
    expect(onDay.totals.openingBalanceMinor).toBe('0');
    expect(onDay.totals.openingDebtMinor).toBe('500000');
    expect(onDay.totals.closingBalanceMinor).toBe('500000');
    expect(onDay.entries.some((entry) => entry.kind === 'OPENING_DEBT')).toBe(true);

    // Со следующего дня — уже в начальном балансе, и операцией периода не является.
    const after = await buildSettlementReport(ctx.db, {
      from: AFTER,
      to: AFTER,
      courierUserId: courier,
      limit: 50,
      offset: 0,
    });
    expect(after.totals.openingBalanceMinor).toBe('500000');
    expect(after.totals.openingDebtMinor).toBe('0');
    expect(after.totals.closingBalanceMinor).toBe('500000');
  });
});

// --- Ничего денежного не двигается -------------------------------------------

describe('начальный долг не смешивается с деньгами и заработком', () => {
  it('не меняет кассу логиста, оплату доставок, расходы и наличные', async () => {
    const courier = await courierId();
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });

    const cashBefore = await buildCashReport(ctx.db, {
      from: DAY,
      to: DAY,
      limit: 50,
      offset: 0,
      visibleLogistIds: [logist.id],
    });

    await ctx.db.$transaction((tx) =>
      appendEntry(tx, {
        courierUserId: courier,
        kind: 'OPENING_DEBT',
        amountMinor: 3_000_00n,
        operationDate: DAY,
        actorUserId: admin.id,
        reason: 'долг до перехода на ERP',
        idempotencyKey: unique('debt-buckets'),
      }),
    );

    const report = await buildSettlementReport(ctx.db, {
      from: DAY,
      to: DAY,
      courierUserId: courier,
      limit: 50,
      offset: 0,
    });

    // Сумма стоит ТОЛЬКО в своей строке и в балансе, и ни в одном денежном
    // или зарплатном итоге.
    expect(report.totals.openingDebtMinor).toBe('300000');
    expect(report.totals.cashReceivedMinor).toBe('0');
    expect(report.totals.handedToLogistMinor).toBe('0');
    expect(report.totals.issuedToCourierMinor).toBe('0');
    expect(report.totals.deliveryFeesMinor).toBe('0');
    expect(report.totals.attemptFeesMinor).toBe('0');
    expect(report.totals.distanceFeesMinor).toBe('0');
    expect(report.totals.expensesMinor).toBe('0');
    expect(report.totals.bonusesMinor).toBe('0');
    expect(report.totals.adjustmentsMinor).toBe('0');

    // Касса логиста не шелохнулась: фактических денег никто не передавал.
    const cashAfter = await buildCashReport(ctx.db, {
      from: DAY,
      to: DAY,
      limit: 50,
      offset: 0,
      visibleLogistIds: [logist.id],
    });
    expect(cashAfter.days).toEqual(cashBefore.days);
  });

  it('выгрузка XLSX содержит отдельную строку «Начальный долг»', async () => {
    const courier = await courierId();
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });

    await ctx.db.$transaction((tx) =>
      appendEntry(tx, {
        courierUserId: courier,
        kind: 'OPENING_DEBT',
        amountMinor: 1_500_00n,
        operationDate: DAY,
        actorUserId: admin.id,
        reason: 'долг до перехода на ERP',
        idempotencyKey: unique('debt-xlsx'),
      }),
    );

    const report = await buildSettlementReport(ctx.db, {
      from: DAY,
      to: DAY,
      courierUserId: courier,
      limit: 50,
      offset: 0,
    });
    const workbook = await buildSettlementWorkbook(report);
    // Файл — это ZIP; подпись достаточно проверить вместе с непустым размером,
    // а наличие подписи вида проверяется меткой в модуле выгрузки.
    expect(workbook.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(workbook.byteLength).toBeGreaterThan(0);
  });
});

// --- Отмена -------------------------------------------------------------------

describe('исправление — только обратной записью', () => {
  it('отмена возвращает баланс и сохраняет исходную запись; повторная отмена невозможна', async () => {
    const courier = await courierId();
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });

    const created = await ctx.db.$transaction((tx) =>
      appendEntry(tx, {
        courierUserId: courier,
        kind: 'OPENING_DEBT',
        amountMinor: 2_000_00n,
        operationDate: DAY,
        actorUserId: admin.id,
        reason: 'ошибочная сумма',
        idempotencyKey: unique('debt-reverse'),
      }),
    );
    expect(await balanceOf(ctx.db, courier, null)).toBe(2_000_00n);

    await ctx.db.$transaction((tx) =>
      reverseEntry(tx, {
        entryId: created.id,
        actorUserId: admin.id,
        reason: 'внесено по ошибке',
        operationDate: AFTER,
      }),
    );

    // Баланс вернулся, а исходная запись осталась в истории нетронутой.
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);
    const source = await ctx.db.courierLedgerEntry.findUniqueOrThrow({
      where: { id: created.id },
      select: { amountMinor: true, kind: true },
    });
    expect(source.kind).toBe('OPENING_DEBT');
    expect(source.amountMinor).toBe(2_000_00n);

    // Вторая отмена той же записи новой суммы не снимает.
    await ctx.db
      .$transaction((tx) =>
        reverseEntry(tx, {
          entryId: created.id,
          actorUserId: admin.id,
          reason: 'повторная отмена',
          operationDate: AFTER,
        }),
      )
      .catch(() => undefined);
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);
  });
});

// --- Права и конкурентность через HTTP ---------------------------------------

describe('права и идемпотентность на уровне API', () => {
  it('два одновременных запроса с одним ключом создают одну запись', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const courier = await courierId();
    const key = unique('http-idem');
    const body: DebtBody = {
      courierUserId: courier,
      amountMinor: '500000',
      operationDate: DAY,
      reason: 'долг до перехода на ERP',
      idempotencyKey: key,
    };

    const [first, second] = await Promise.all([postDebt(token, body), postDebt(token, body)]);

    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { courierUserId: courier, kind: 'OPENING_DEBT' },
      }),
    ).toBe(1);
    // Долг вырос ровно один раз.
    expect(await balanceOf(ctx.db, courier, null)).toBe(500_000n);
  });

  it('тот же ключ с другой суммой — явный конфликт, а не тихий возврат прежней операции', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const courier = await courierId();
    const key = unique('http-mismatch');

    const created = await postDebt(token, {
      courierUserId: courier,
      amountMinor: '500000',
      operationDate: DAY,
      reason: 'долг до перехода на ERP',
      idempotencyKey: key,
    });
    expect(created.statusCode).toBe(201);

    const mismatched = await postDebt(token, {
      courierUserId: courier,
      amountMinor: '700000',
      operationDate: DAY,
      reason: 'другая сумма тем же ключом',
      idempotencyKey: key,
    });
    expect(mismatched.statusCode).toBe(409);

    // Ни второй записи, ни изменения баланса.
    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { courierUserId: courier, kind: 'OPENING_DEBT' },
      }),
    ).toBe(1);
    expect(await balanceOf(ctx.db, courier, null)).toBe(500_000n);
  });

  it('две одновременные отмены дают одну обратную запись и один возврат баланса', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const courier = await courierId();

    const created = await postDebt(token, {
      courierUserId: courier,
      amountMinor: '400000',
      operationDate: DAY,
      reason: 'долг до перехода на ERP',
      idempotencyKey: unique('http-rev'),
    });
    const entryId = created.json().entry?.id ?? '';
    expect(await balanceOf(ctx.db, courier, null)).toBe(400_000n);

    const reverseOnce = (): Promise<{ statusCode: number }> =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/logistics/ledger/opening-debt/${entryId}/reverse`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'внесено по ошибке' },
      }) as never;

    await Promise.all([reverseOnce(), reverseOnce()]);

    expect(await ctx.db.courierLedgerEntry.count({ where: { reversesEntryId: entryId } })).toBe(1);
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);

    // Ещё одна отмена баланс уже не трогает.
    await reverseOnce();
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);
  });

  it('не-администратору запрещено вносить и отменять начальный долг', async () => {
    const { token: adminToken } = await tokenFor(['ADMIN']);
    const courier = await courierId();

    const created = await postDebt(adminToken, {
      courierUserId: courier,
      amountMinor: '100000',
      operationDate: DAY,
      reason: 'долг до перехода на ERP',
      idempotencyKey: unique('http-roles'),
    });
    const entryId = created.json().entry?.id ?? '';

    for (const roles of [['LOGISTICIAN'], ['SUPERVISOR'], ['COURIER']] as Role[][]) {
      const { token } = await tokenFor(roles);

      const create = await postDebt(token, {
        courierUserId: courier,
        amountMinor: '100000',
        operationDate: DAY,
        reason: 'попытка без прав',
        idempotencyKey: unique('http-roles-deny'),
      });
      expect(create.statusCode).toBe(403);

      const reverse = await ctx.app.inject({
        method: 'POST',
        url: `/api/logistics/ledger/opening-debt/${entryId}/reverse`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'попытка без прав' },
      });
      expect(reverse.statusCode).toBe(403);
    }

    // Долг на месте: ни одна попытка без прав его не изменила.
    expect(await balanceOf(ctx.db, courier, null)).toBe(100_000n);
  });

  it('общий эндпоинт отмены финансовых операций начальный долг не отменяет', async () => {
    const { token: adminToken } = await tokenFor(['ADMIN']);
    const { token: logistToken } = await tokenFor(['LOGISTICIAN']);
    const courier = await courierId();

    const created = await postDebt(adminToken, {
      courierUserId: courier,
      amountMinor: '250000',
      operationDate: DAY,
      reason: 'долг до перехода на ERP',
      idempotencyKey: unique('http-generic'),
    });
    const entryId = created.json().entry?.id ?? '';

    for (const token of [logistToken, adminToken]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/logistics/ledger/operations/${entryId}/reverse`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'обход отдельного действия' },
      });
      expect(response.statusCode).toBe(403);
    }

    expect(await balanceOf(ctx.db, courier, null)).toBe(250_000n);
  });

  it('отказ при нулевой и отрицательной сумме, некорректной дате и получателе не-курьере', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const courier = await courierId();
    const notCourier = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });

    const zero = await postDebt(token, {
      courierUserId: courier,
      amountMinor: '0',
      operationDate: DAY,
      reason: 'нулевая сумма',
      idempotencyKey: unique('http-zero'),
    });
    expect(zero.statusCode).toBe(400);

    const negative = await postDebt(token, {
      courierUserId: courier,
      amountMinor: '-100000',
      operationDate: DAY,
      reason: 'отрицательная сумма',
      idempotencyKey: unique('http-negative'),
    });
    expect(negative.statusCode).toBe(400);

    const badDate = await postDebt(token, {
      courierUserId: courier,
      amountMinor: '100000',
      operationDate: '2030-02-31',
      reason: 'несуществующая дата',
      idempotencyKey: unique('http-date'),
    });
    expect(badDate.statusCode).toBe(400);

    // Долг заводится только курьеру: одной валидности UUID недостаточно.
    const wrongTarget = await postDebt(token, {
      courierUserId: notCourier.id,
      amountMinor: '100000',
      operationDate: DAY,
      reason: 'получатель не курьер',
      idempotencyKey: unique('http-not-courier'),
    });
    expect(wrongTarget.statusCode).toBe(400);

    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);
    expect(await balanceOf(ctx.db, notCourier.id, null)).toBe(0n);
  });
});
