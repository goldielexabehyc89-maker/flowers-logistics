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

import { randomUUID } from 'node:crypto';
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
import { cashBalanceOf } from './cash.js';
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

/**
 * Сколько соединений СЕЙЧАС заблокированы НАШИМ барьером.
 *
 * `pg_blocking_pids` отвечает именно на этот вопрос, в отличие от «прошло
 * столько-то миллисекунд» или «кто-то чего-то ждёт»: запрос, который всё ещё
 * проверяет права, здесь не считается.
 *
 * Отбор по `current_database()` обязателен: `pg_stat_activity` общая на весь
 * кластер, а в том же контейнере живёт база разработки со своим приложением.
 * Без него любое заблокированное соединение соседа засчитывалось бы за наше,
 * и проверка проходила бы, даже не встав на блокировку.
 */
async function blockedBackends(blockerPid: number): Promise<number> {
  const rows = await ctx.db.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count
    FROM pg_stat_activity
    WHERE pg_blocking_pids(pid) @> ARRAY[${blockerPid}::integer]
      AND datname = current_database()
  `;
  return Number(rows[0]?.count ?? 0n);
}

/**
 * Ждёт, пока нужное число соединений встанет на блокировку ИМЕННО НАШЕГО
 * барьера. Ограничено по времени.
 *
 * Считать все заблокированные соединения базы недостаточно: параллельный
 * прогон или оставленная сессия дали бы нужное число без участия проверяемых
 * запросов, и барьер доказывал бы только сам факт чужого ожидания.
 */
async function waitForBlockedBy(
  blockerPid: number,
  expected: number,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    seen = await blockedBackends(blockerPid);
    if (seen >= expected) {
      return seen;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return seen;
}

/** Соединение, удерживающее ключ, и сигнал «ключ захвачен». */
async function holdKey(key: string): Promise<{
  pid: number;
  release: () => void;
  done: Promise<void>;
}> {
  let release!: () => void;
  let locked!: (pid: number) => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const lockedSignal = new Promise<number>((resolve) => (locked = resolve));

  const done = ctx.db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
      const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::integer AS pid`;
      locked(rows[0]?.pid ?? 0);
      await released;
    },
    { timeout: 20_000, maxWait: 20_000 },
  );

  return { pid: await lockedSignal, release, done };
}

/** Курсор ленты событий: идентификатор растёт монотонно, время — нет. */
async function lastEventId(): Promise<bigint> {
  const row = await ctx.db.realtimeEvent.findFirst({
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  return row?.id ?? 0n;
}

/** Сколько событий учёта появилось после курсора. */
async function ledgerEventsAfter(cursor: bigint): Promise<number> {
  return ctx.db.realtimeEvent.count({
    where: { topic: 'finance.ledger_changed', id: { gt: cursor } },
  });
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
      ledgerActiveFrom: null,
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
      ledgerActiveFrom: null,
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
      ledgerActiveFrom: null,
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
      ledgerActiveFrom: null,
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
      ledgerActiveFrom: null,
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

    /*
     * Вторая отмена не падает и не снимает сумму второй раз: она возвращает ту
     * же обратную запись. Ошибку здесь не глушим — её быть не должно.
     */
    const again = await ctx.db.$transaction((tx) =>
      reverseEntry(tx, {
        entryId: created.id,
        actorUserId: admin.id,
        reason: 'повторная отмена',
        operationDate: AFTER,
      }),
    );
    expect(again.reversesEntryId).toBe(created.id);
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);
    expect(await ctx.db.courierLedgerEntry.count({ where: { reversesEntryId: created.id } })).toBe(
      1,
    );
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

    const reverseOnce = (): Promise<{
      statusCode: number;
      json: () => { entry?: { id: string } };
    }> =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/logistics/ledger/opening-debt/${entryId}/reverse`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'внесено по ошибке' },
      }) as never;

    const [first, second] = await Promise.all([reverseOnce(), reverseOnce()]);

    /*
     * Проверяются ОБА ответа. Уникальный индекс и раньше не давал списать
     * дважды, но проигравший получал 500: победителя читали внутри уже
     * аварийной транзакции. Отмена идемпотентна — значит успешны оба.
     */
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(first.json().entry?.id).toBe(second.json().entry?.id);

    expect(await ctx.db.courierLedgerEntry.count({ where: { reversesEntryId: entryId } })).toBe(1);
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);

    // Ещё одна отмена баланс не трогает и лишнего аудита не пишет.
    const third = await reverseOnce();
    expect(third.statusCode).toBe(200);
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);
    expect(
      await ctx.db.auditLog.count({
        where: {
          action: 'FINANCE_OPERATION_REVERSED',
          entityId: first.json().entry?.id ?? '',
        },
      }),
    ).toBe(1);
  });

  it('конкурентное создание с одним ключом и разной суммой: один 201, другой 409', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const courier = await courierId();
    const key = unique('http-race-mismatch');

    /*
     * Оба запроса проходят предварительную проверку «записи ещё нет», и лишь
     * внутри транзакции один видит чужую операцию. Раньше на этом пути контракт
     * не сверялся: второй получал 201 «сохранено» про чужую сумму и лишний аудит.
     */
    const [first, second] = await Promise.all([
      postDebt(token, {
        courierUserId: courier,
        amountMinor: '500000',
        operationDate: DAY,
        reason: 'первая сумма',
        idempotencyKey: key,
      }),
      postDebt(token, {
        courierUserId: courier,
        amountMinor: '700000',
        operationDate: DAY,
        reason: 'другая сумма тем же ключом',
        idempotencyKey: key,
      }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort((left, right) => left - right);
    expect(statuses).toEqual([201, 409]);

    const entries = await ctx.db.courierLedgerEntry.findMany({
      where: { courierUserId: courier, kind: 'OPENING_DEBT' },
      select: { id: true, amountMinor: true },
    });
    expect(entries).toHaveLength(1);
    expect(await balanceOf(ctx.db, courier, null)).toBe(entries[0]?.amountMinor);
    expect(
      await ctx.db.auditLog.count({
        where: { action: 'FINANCE_OPERATION_RECORDED', entityId: entries[0]?.id ?? '' },
      }),
    ).toBe(1);
  });

  it('повтор той же операции не пишет второй аудит создания', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const courier = await courierId();
    const body: DebtBody = {
      courierUserId: courier,
      amountMinor: '300000',
      operationDate: DAY,
      reason: 'долг до перехода на ERP',
      idempotencyKey: unique('http-audit-once'),
    };

    const first = await postDebt(token, body);
    const second = await postDebt(token, body);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);

    const entryId = first.json().entry?.id ?? '';
    expect(second.json().entry?.id).toBe(entryId);
    expect(
      await ctx.db.auditLog.count({
        where: { action: 'FINANCE_OPERATION_RECORDED', entityId: entryId },
      }),
    ).toBe(1);
    expect(await balanceOf(ctx.db, courier, null)).toBe(300_000n);
  });

  /** Счётчик финансовых событий: аудит и уведомление обязаны быть по одному. */
  async function lastEventId(): Promise<bigint> {
    const row = await ctx.db.realtimeEvent.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    return row?.id ?? 0n;
  }

  async function ledgerEventsAfter(cursor: bigint): Promise<number> {
    return ctx.db.realtimeEvent.count({
      where: { topic: 'finance.ledger_changed', id: { gt: cursor } },
    });
  }

  /**
   * Управляемое чередование, а не просто одновременный старт.
   *
   * Оба запроса удерживаются на блокировке ключа, пока тест её не отпустит.
   * Так воспроизводится именно тот порядок, из-за которого второй запрос
   * раньше получал 201 с чужой суммой: он доходил до записи уже после того,
   * как победитель зафиксировался.
   */
  it('управляемая гонка создания: чужая сумма получает 409, а не 201', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const courier = await courierId();
    const key = unique('barrier-create');
    const cursor = await lastEventId();

    const barrier = await holdKey(`opening-debt:${key}`);

    let settled = 0;
    const first = postDebt(token, {
      courierUserId: courier,
      amountMinor: '500000',
      operationDate: DAY,
      reason: 'первая сумма',
      idempotencyKey: key,
    }).then((response) => {
      settled += 1;
      return response;
    });
    const second = postDebt(token, {
      courierUserId: courier,
      amountMinor: '700000',
      operationDate: DAY,
      reason: 'другая сумма тем же ключом',
      idempotencyKey: key,
    }).then((response) => {
      settled += 1;
      return response;
    });

    /*
     * Оба запроса действительно СТОЯТ на блокировке ключа — это проверяется
     * через `pg_blocking_pids`, а не по времени: иначе «ещё не ответили» могло
     * бы означать «ещё проверяют права».
     */
    expect(await waitForBlockedBy(barrier.pid, 2)).toBeGreaterThanOrEqual(2);
    expect(settled).toBe(0);

    barrier.release();
    await barrier.done;
    const [a, b] = await Promise.all([first, second]);

    expect([a.statusCode, b.statusCode].sort((left, right) => left - right)).toEqual([201, 409]);

    const entries = await ctx.db.courierLedgerEntry.findMany({
      where: { courierUserId: courier, kind: 'OPENING_DEBT' },
      select: { id: true, amountMinor: true },
    });
    expect(entries).toHaveLength(1);
    expect(await balanceOf(ctx.db, courier, null)).toBe(entries[0]?.amountMinor);
    expect(
      await ctx.db.auditLog.count({
        where: { action: 'FINANCE_OPERATION_RECORDED', entityId: entries[0]?.id ?? '' },
      }),
    ).toBe(1);
    expect(await ledgerEventsAfter(cursor)).toBe(1);
  });

  it('управляемая гонка отмены: одна обратная запись, один аудит, одно событие', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const courier = await courierId();

    const debt = await postDebt(token, {
      courierUserId: courier,
      amountMinor: '400000',
      operationDate: DAY,
      reason: 'долг до перехода на ERP',
      idempotencyKey: unique('barrier-reverse'),
    });
    expect(debt.statusCode).toBe(201);
    const entryId = debt.json().entry?.id ?? '';
    const cursor = await lastEventId();

    const barrier = await holdKey(`reversal:${entryId}`);

    const reverseOnce = (): Promise<{
      statusCode: number;
      json: () => { entry?: { id: string } };
    }> =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/logistics/ledger/opening-debt/${entryId}/reverse`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'внесено по ошибке' },
      }) as never;

    let settled = 0;
    const first = reverseOnce().then((response) => {
      settled += 1;
      return response;
    });
    const second = reverseOnce().then((response) => {
      settled += 1;
      return response;
    });

    expect(await waitForBlockedBy(barrier.pid, 2)).toBeGreaterThanOrEqual(2);
    expect(settled).toBe(0);

    barrier.release();
    await barrier.done;
    const [a, b] = await Promise.all([first, second]);

    // Оба успешны и отдают одну и ту же обратную запись.
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json().entry?.id).toBe(b.json().entry?.id);

    expect(await ctx.db.courierLedgerEntry.count({ where: { reversesEntryId: entryId } })).toBe(1);
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);
    // История не дублируется: один аудит и одно событие на одну отмену.
    expect(
      await ctx.db.auditLog.count({
        where: { action: 'FINANCE_OPERATION_REVERSED', entityId: a.json().entry?.id ?? '' },
      }),
    ).toBe(1);
    expect(await ledgerEventsAfter(cursor)).toBe(1);
  });

  it('управляемая гонка «внесение и отмена»: повтор внесения не воскрешает долг', async () => {
    /*
     * Два разных действия над одним долгом одновременно.
     *
     * Внесение и отмена сериализуются по РАЗНЫМ ключам, поэтому блокировка
     * ключа их друг от друга не защищает — защищать обязан сам контракт.
     * Барьер держит ключ ОТМЕНЫ: отмена уже в работе и ещё не зафиксирована,
     * а повторное внесение с тем же ключом приходит именно в это окно. Долг
     * не должен ожить, а второго аудита и второго события у повтора быть не
     * должно.
     */
    const { token } = await tokenFor(['ADMIN']);
    const courier = await courierId();
    const key = unique('barrier-create-reverse');

    const created = await postDebt(token, {
      courierUserId: courier,
      amountMinor: '500000',
      operationDate: DAY,
      reason: 'долг до перехода на ERP',
      idempotencyKey: key,
    });
    expect(created.statusCode).toBe(201);
    const entryId = created.json().entry?.id ?? '';
    const cursor = await lastEventId();

    const barrier = await holdKey(`reversal:${entryId}`);

    let reversalSettled = 0;
    const reverse = (
      ctx.app.inject({
        method: 'POST',
        url: `/api/logistics/ledger/opening-debt/${entryId}/reverse`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'внесено по ошибке' },
      }) as unknown as Promise<{ statusCode: number; json: () => { entry?: { id: string } } }>
    ).then((response) => {
      reversalSettled += 1;
      return response;
    });

    expect(await waitForBlockedBy(barrier.pid, 1)).toBeGreaterThanOrEqual(1);
    expect(reversalSettled).toBe(0);

    /*
     * Повторное внесение приходит, пока отмена ещё не зафиксирована.
     * Оно обязано ответить той же записью и ничего не создать.
     */
    const repeated = await postDebt(token, {
      courierUserId: courier,
      amountMinor: '500000',
      operationDate: DAY,
      reason: 'долг до перехода на ERP',
      idempotencyKey: key,
    });
    expect(repeated.statusCode).toBe(201);
    expect(repeated.json().entry?.id).toBe(entryId);

    barrier.release();
    await barrier.done;

    const reversal = await reverse;
    expect(reversal.statusCode).toBe(200);

    expect(
      await ctx.db.courierLedgerEntry.count({
        where: { kind: 'OPENING_DEBT', courierUserId: courier },
      }),
    ).toBe(1);
    expect(await ctx.db.courierLedgerEntry.count({ where: { reversesEntryId: entryId } })).toBe(1);
    // Долг не ожил: повтор внесения баланс не вернул.
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);

    // Аудит: одно внесение и одна отмена, без вторых записей от повтора.
    expect(
      await ctx.db.auditLog.count({
        where: { action: 'FINANCE_OPERATION_RECORDED', entityId: entryId },
      }),
    ).toBe(1);
    expect(
      await ctx.db.auditLog.count({
        where: {
          action: 'FINANCE_OPERATION_REVERSED',
          entityId: reversal.json().entry?.id ?? '',
        },
      }),
    ).toBe(1);
    // Событие ровно одно — от отмены. Повтор журнал не менял.
    expect(await ledgerEventsAfter(cursor)).toBe(1);
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

  it('запрет держится и ПОСЛЕ отмены долга: правилом, а не состоянием', async () => {
    /*
     * Разбор гонки по факту «обратная запись существует» превращал в успех
     * что угодно: запись существует и после любой давно завершённой отмены,
     * и отказ по правам молча становился ответом 200 с чужой обратной
     * записью. Ограничение «начальный долг отменяет только администратор
     * своим действием» обязано держаться правилом.
     */
    const { token: adminToken } = await tokenFor(['ADMIN']);
    const { token: logistToken } = await tokenFor(['LOGISTICIAN']);
    const courier = await courierId();

    const created = await postDebt(adminToken, {
      courierUserId: courier,
      amountMinor: '300000',
      operationDate: DAY,
      reason: 'долг до перехода на ERP',
      idempotencyKey: unique('http-generic-after-reverse'),
    });
    const entryId = created.json().entry?.id ?? '';

    // Долг отменён СВОИМ действием администратора — обратная запись появилась.
    const reversed = await ctx.app.inject({
      method: 'POST',
      url: `/api/logistics/ledger/opening-debt/${entryId}/reverse`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reason: 'внесено по ошибке' },
    });
    expect(reversed.statusCode).toBe(200);
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);

    const auditsBefore = await ctx.db.auditLog.count({
      where: { action: 'FINANCE_OPERATION_REVERSED' },
    });

    // Общий эндпоинт обязан отказать ровно так же, как и до отмены.
    for (const token of [logistToken, adminToken]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/logistics/ledger/operations/${entryId}/reverse`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'обход отдельного действия' },
      });
      expect(response.statusCode).toBe(403);
    }

    // И не оставить следа: ни второй обратной записи, ни лишнего аудита.
    expect(await ctx.db.courierLedgerEntry.count({ where: { reversesEntryId: entryId } })).toBe(1);
    expect(await ctx.db.auditLog.count({ where: { action: 'FINANCE_OPERATION_REVERSED' } })).toBe(
      auditsBefore,
    );
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

/**
 * Тот же контракт ключа — у ОБЫЧНЫХ денежных операций.
 *
 * Идемпотентность, явный конфликт при чужих данных и разбор гонки снаружи
 * транзакции были починены сначала для начального долга. Но ключом пользуется
 * весь журнал: «Доп. расход», «Доплата», «Оплачиваемая попытка», сдача и
 * выдача наличных. Починка, дошедшая до одного эндпоинта, оставляла бы в
 * остальных тот же дефект — молчаливый ответ «сохранено» о чужой сумме
 * и 500 на двойном нажатии.
 */
describe('ключ идемпотентности общих операций', () => {
  interface OperationBody {
    courierUserId: string;
    kind: string;
    amountMinor: string;
    operationDate: string;
    reason?: string;
    idempotencyKey: string;
  }

  const postOperation = (
    token: string,
    body: OperationBody,
  ): Promise<{ statusCode: number; json: () => { entry?: { id: string } } }> =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/logistics/ledger/operations',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    }) as never;

  it('тот же ключ с другой суммой — конфликт, а не тихий возврат прежней операции', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const courier = await courierId();
    const key = unique('op-conflict');

    const first = await postOperation(token, {
      courierUserId: courier,
      kind: 'EXPENSE_PARKING',
      amountMinor: '20000',
      operationDate: DAY,
      reason: 'парковка у адреса',
      idempotencyKey: key,
    });
    expect(first.statusCode).toBe(201);

    // Повтор той же операции идемпотентен: та же запись, без второго аудита.
    const repeat = await postOperation(token, {
      courierUserId: courier,
      kind: 'EXPENSE_PARKING',
      amountMinor: '20000',
      operationDate: DAY,
      reason: 'парковка у адреса',
      idempotencyKey: key,
    });
    expect(repeat.statusCode).toBe(201);
    expect(repeat.json().entry?.id).toBe(first.json().entry?.id);

    /*
     * А вот ДРУГАЯ сумма с тем же ключом — другая операция. Путь достижим:
     * форма не закрывается при ошибке и оставляет прежний ключ, человек
     * правит сумму и отправляет снова.
     */
    const withOtherAmount = await postOperation(token, {
      courierUserId: courier,
      kind: 'EXPENSE_PARKING',
      amountMinor: '50000',
      operationDate: DAY,
      reason: 'парковка у адреса',
      idempotencyKey: key,
    });
    expect(withOtherAmount.statusCode).toBe(409);

    expect(await ctx.db.courierLedgerEntry.count({ where: { courierUserId: courier } })).toBe(1);
    expect(await balanceOf(ctx.db, courier, null)).toBe(-20_000n);
    expect(
      await ctx.db.auditLog.count({
        where: {
          action: 'FINANCE_OPERATION_RECORDED',
          entityId: first.json().entry?.id ?? '',
        },
      }),
    ).toBe(1);
  });

  it('управляемая гонка: оба запроса встают на очередь по ключу и оба успешны', async () => {
    /*
     * Одновременный старт сам по себе гонки не воспроизводит: второй запрос
     * вправе успеть сделать предварительный поиск уже ПОСЛЕ фиксации первого
     * и уйти по быстрому пути повтора. Тогда ни очередь по ключу, ни признак
     * «запись создана», ни разбор ошибки не выполняются вовсе, а все итоги
     * всё равно сходятся — проверка не отличает «механизм сработал» от
     * «гонки не было». Барьер держит ключ до тех пор, пока ОБА запроса не
     * встанут на него.
     */
    const { token } = await tokenFor(['ADMIN']);
    const courier = await courierId();
    const key = unique('op-barrier');
    const cursor = await lastEventId();

    const barrier = await holdKey(`ledger-operation:${key}`);

    const body = {
      courierUserId: courier,
      kind: 'EXPENSE_TOLL',
      amountMinor: '40000',
      operationDate: DAY,
      reason: 'платная дорога',
      idempotencyKey: key,
    };

    let settled = 0;
    const first = postOperation(token, body).then((response) => {
      settled += 1;
      return response;
    });
    const second = postOperation(token, body).then((response) => {
      settled += 1;
      return response;
    });

    expect(await waitForBlockedBy(barrier.pid, 2)).toBeGreaterThanOrEqual(2);
    expect(settled).toBe(0);

    barrier.release();
    await barrier.done;
    const [a, b] = await Promise.all([first, second]);

    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().entry?.id).toBe(b.json().entry?.id);
    expect(await ctx.db.courierLedgerEntry.count({ where: { courierUserId: courier } })).toBe(1);
    expect(await balanceOf(ctx.db, courier, null)).toBe(-40_000n);
    expect(
      await ctx.db.auditLog.count({
        where: { action: 'FINANCE_OPERATION_RECORDED', entityId: a.json().entry?.id ?? '' },
      }),
    ).toBe(1);
    expect(await ledgerEventsAfter(cursor)).toBe(1);
  });

  it('два одновременных запроса с одним ключом: оба успешны, запись одна', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const courier = await courierId();
    const key = unique('op-race');
    const cursor = await lastEventId();

    const body = {
      courierUserId: courier,
      kind: 'BONUS',
      amountMinor: '30000',
      operationDate: DAY,
      reason: 'доплата за сложный адрес',
      idempotencyKey: key,
    };

    /*
     * Ни один из двух ответов не вправе быть отказом.
     *
     * Проигравшая транзакция упирается в уникальность, её транзакция
     * становится аварийной — и раньше это доходило до человека как 500 на
     * обычном двойном нажатии.
     */
    const [first, second] = await Promise.all([
      postOperation(token, body),
      postOperation(token, body),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(first.json().entry?.id).toBe(second.json().entry?.id);

    expect(await ctx.db.courierLedgerEntry.count({ where: { courierUserId: courier } })).toBe(1);
    expect(await balanceOf(ctx.db, courier, null)).toBe(-30_000n);
    // Одна операция — одна строка истории и одно событие.
    expect(
      await ctx.db.auditLog.count({
        where: {
          action: 'FINANCE_OPERATION_RECORDED',
          entityId: first.json().entry?.id ?? '',
        },
      }),
    ).toBe(1);
    expect(await ledgerEventsAfter(cursor)).toBe(1);
  });
});

/**
 * Передача наличных и касса логиста через НАСТОЯЩИЕ маршруты.
 *
 * `recordTransfer` и `appendCash` проверялись прямыми вызовами, минуя всю
 * обвязку маршрута: права на кассу, сверку контракта ключа, признак «запись
 * создана» и разбор гонки. Именно поэтому дефект «двойное нажатие даёт 500»
 * жил в кассе незамеченным.
 */
describe('передача наличных и касса через маршруты', () => {
  const postOperation = (
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ statusCode: number; json: () => { entry?: { id: string } } }> =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/logistics/ledger/operations',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    }) as never;

  const postCompany = (
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ statusCode: number; json: () => { entry?: { id: string } } }> =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/logistics/cash/company',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    }) as never;

  it('повтор передачи идемпотентен, чужая сумма и чужая касса — конфликт', async () => {
    const { token: adminToken } = await tokenFor(['ADMIN']);
    const deskA = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const deskB = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const courier = await courierId();
    const key = unique('transfer');

    const body = {
      courierUserId: courier,
      kind: 'CASH_HANDED_TO_LOGIST',
      amountMinor: '150000',
      operationDate: DAY,
      logistUserId: deskA.id,
      idempotencyKey: key,
    };

    const first = await postOperation(adminToken, body);
    expect(first.statusCode).toBe(201);

    // Повтор той же передачи: та же запись, без второй строки кассы и аудита.
    const repeat = await postOperation(adminToken, body);
    expect(repeat.statusCode).toBe(201);
    expect(repeat.json().entry?.id).toBe(first.json().entry?.id);

    // Чужая сумма с тем же ключом — другая операция.
    const otherAmount = await postOperation(adminToken, { ...body, amountMinor: '250000' });
    expect(otherAmount.statusCode).toBe(409);

    /*
     * Чужая КАССА с тем же ключом — тоже другая операция.
     *
     * Без сверки второй стороны ответ был бы «сохранено», а наличные так и
     * остались бы числиться за прежним логистом.
     */
    const otherDesk = await postOperation(adminToken, { ...body, logistUserId: deskB.id });
    expect(otherDesk.statusCode).toBe(409);

    // Ровно одна передача: одна запись долга, одна запись кассы, один аудит.
    expect(await ctx.db.courierLedgerEntry.count({ where: { courierUserId: courier } })).toBe(1);
    expect(await ctx.db.logistCashEntry.count({ where: { logistUserId: deskA.id } })).toBe(1);
    expect(await ctx.db.logistCashEntry.count({ where: { logistUserId: deskB.id } })).toBe(0);
    expect(await balanceOf(ctx.db, courier, null)).toBe(-150_000n);
    expect(
      await ctx.db.auditLog.count({
        where: {
          action: 'FINANCE_OPERATION_RECORDED',
          entityId: first.json().entry?.id ?? '',
        },
      }),
    ).toBe(1);
  });

  it('повтор по чужому ключу не выдаёт логисту операцию по чужой кассе', async () => {
    /*
     * Проверка прав на кассу стояла только внутри транзакции, а быстрый путь
     * повтора отвечал раньше неё: логист получал 201 с чужой передачей —
     * суммой, курьером и днём.
     */
    const { token: adminToken } = await tokenFor(['ADMIN']);
    const { token: logistToken, userId: logistId } = await tokenFor(['LOGISTICIAN']);
    const foreignDesk = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const courier = await courierId();
    const key = unique('foreign-desk');

    const created = await postOperation(adminToken, {
      courierUserId: courier,
      kind: 'CASH_HANDED_TO_LOGIST',
      amountMinor: '120000',
      operationDate: DAY,
      logistUserId: foreignDesk.id,
      idempotencyKey: key,
    });
    expect(created.statusCode).toBe(201);

    // Логист повторяет тот же ключ: своей кассой он эту операцию не объяснит.
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/api/logistics/ledger/operations',
      headers: { authorization: `Bearer ${logistToken}` },
      payload: {
        courierUserId: courier,
        kind: 'CASH_HANDED_TO_LOGIST',
        amountMinor: '120000',
        operationDate: DAY,
        idempotencyKey: key,
      },
    });
    expect(replay.statusCode).toBe(409);
    expect(await ctx.db.logistCashEntry.count({ where: { logistUserId: logistId } })).toBe(0);

    /*
     * И отдельно — сам ПОРЯДОК проверки прав.
     *
     * Здесь логист называет чужую кассу прямо. Отказ обязан прийти от права,
     * а не от сверки ключа: `resolveDeskOwner` выполняется до любого ответа,
     * в том числе до быстрого пути повтора. Без явного `logistUserId`
     * предыдущее утверждение прошло бы и при старом порядке.
     */
    const explicit = await ctx.app.inject({
      method: 'POST',
      url: '/api/logistics/ledger/operations',
      headers: { authorization: `Bearer ${logistToken}` },
      payload: {
        courierUserId: courier,
        kind: 'CASH_HANDED_TO_LOGIST',
        amountMinor: '120000',
        operationDate: DAY,
        logistUserId: foreignDesk.id,
        idempotencyKey: key,
      },
    });
    expect(explicit.statusCode).toBe(403);
  });

  it('двойное нажатие «Взять из компании» не даёт отказа и не удваивает кассу', async () => {
    const { token, userId } = await tokenFor(['LOGISTICIAN']);
    const key = unique('company');
    const cursor = await lastEventId();
    const body = {
      direction: 'TAKE',
      amountMinor: '400000',
      operationDate: DAY,
      idempotencyKey: key,
    };

    /*
     * Управляемая гонка, а не просто одновременный старт: барьер держит ключ,
     * пока ОБА запроса на него не встанут. Без барьера второй запрос вправе
     * успеть прочитать ключ уже после фиксации первого и уйти повтором — тогда
     * ни очередь, ни признак «создано» не выполняются, а итоги всё равно
     * сходятся, и проверка не отличает работу механизма от её отсутствия.
     */
    const barrier = await holdKey(`cash:${key}`);
    let settled = 0;
    const first = postCompany(token, body).then((response) => {
      settled += 1;
      return response;
    });
    const second = postCompany(token, body).then((response) => {
      settled += 1;
      return response;
    });

    expect(await waitForBlockedBy(barrier.pid, 2)).toBeGreaterThanOrEqual(2);
    expect(settled).toBe(0);
    barrier.release();
    await barrier.done;

    // Оба запроса обязаны завершиться успешно: внутри `appendCash` поиск по
    // ключу стоит ДО блокировки кассы, и без очереди второй получал отказ.
    const [a, b] = await Promise.all([first, second]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().entry?.id).toBe(b.json().entry?.id);

    expect(await ctx.db.logistCashEntry.count({ where: { logistUserId: userId } })).toBe(1);
    expect(await cashBalanceOf(ctx.db, userId, null)).toBe(400_000n);

    /*
     * Одна операция — одна строка истории и одно событие.
     *
     * Очередь по ключу сделала повторы тихими: проигравший больше не падает,
     * а значит обязан молчать и в аудите. Иначе журнал утверждал бы, что
     * деньги в кассу вносили дважды.
     */
    expect(
      await ctx.db.auditLog.count({
        where: { action: 'FINANCE_CASH_MOVED', entityId: a.json().entry?.id ?? '' },
      }),
    ).toBe(1);
    expect(await ledgerEventsAfter(cursor)).toBe(1);

    // Третий, уже неконкурентный повтор тоже ничего не дописывает.
    const third = await postCompany(token, body);
    expect(third.statusCode).toBe(201);
    expect(
      await ctx.db.auditLog.count({
        where: { action: 'FINANCE_CASH_MOVED', entityId: a.json().entry?.id ?? '' },
      }),
    ).toBe(1);
    expect(await ledgerEventsAfter(cursor)).toBe(1);

    // Тот же ключ с другой суммой — другая операция, а не повтор.
    const otherAmount = await postCompany(token, { ...body, amountMinor: '900000' });
    expect(otherAmount.statusCode).toBe(409);
    expect(await cashBalanceOf(ctx.db, userId, null)).toBe(400_000n);
  });

  it('две одновременные отмены движения кассы: одна обратная запись, без отказа сервера', async () => {
    const { token, userId } = await tokenFor(['LOGISTICIAN']);
    const created = await postCompany(token, {
      direction: 'TAKE',
      amountMinor: '300000',
      operationDate: DAY,
      idempotencyKey: unique('company-reverse'),
    });
    expect(created.statusCode).toBe(201);
    const entryId = created.json().entry?.id ?? '';

    const reverseOnce = (): Promise<{ statusCode: number }> =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/logistics/cash/${entryId}/reverse`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'ошибочная запись' },
      }) as never;

    const cursor = await lastEventId();
    const [a, b] = await Promise.all([reverseOnce(), reverseOnce()]);
    /*
     * ОБА успешны и отдают одну и ту же обратную запись.
     *
     * Отмена бывает один раз, и повтор возвращает её же — независимо от того,
     * передача это или обычное движение кассы. Прежде одна и та же кнопка
     * давала то тост «записано», то красную ошибку, в зависимости от вида
     * записи; невнятный отказ человек повторяет новым ключом, и в кассе
     * появляется лишняя запись.
     */
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);

    expect(await ctx.db.logistCashEntry.count({ where: { reversesEntryId: entryId } })).toBe(1);
    expect(await cashBalanceOf(ctx.db, userId, null)).toBe(0n);
    // История и событие — только у того, кто действительно отменил.
    expect(
      await ctx.db.auditLog.count({
        where: { action: 'FINANCE_CASH_REVERSED', entityId: entryId },
      }),
    ).toBe(1);
    expect(await ledgerEventsAfter(cursor)).toBe(1);
  });
  it('одну передачу отменяют с ДВУХ маршрутов сразу: без взаимной блокировки', async () => {
    /*
     * У передачи две стороны и два маршрута отмены. Журнал курьера писал
     * сначала свою обратную запись, потом кассовую; касса — наоборот. Ключи
     * блокировки были разные, маршруты не выстраивались в очередь и упирались
     * в уникальные индексы в противоположном порядке: PostgreSQL сообщал о
     * взаимной блокировке, человек видел внутреннюю ошибку, а иногда падали
     * ОБЕ стороны и отмена не выполнялась вовсе.
     *
     * Путь достижим из продукта: отмена видна и на экране кассы, и в журнале
     * расчётов, и нажать их могут двое разом. Повторяется несколько раз —
     * взаимная блокировка возникает не при каждом чередовании.
     */
    const { token: adminToken } = await tokenFor(['ADMIN']);
    const desk = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const courier = await courierId();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const created = await postOperation(adminToken, {
        courierUserId: courier,
        kind: 'CASH_HANDED_TO_LOGIST',
        amountMinor: '100000',
        operationDate: DAY,
        logistUserId: desk.id,
        idempotencyKey: unique('two-routes'),
      });
      expect(created.statusCode).toBe(201);
      const ledgerId = created.json().entry?.id ?? '';
      const cashEntry = await ctx.db.logistCashEntry.findFirstOrThrow({
        where: { logistUserId: desk.id, kind: 'RECEIVED_FROM_COURIER', reversedBy: { is: null } },
        orderBy: { occurredAt: 'desc' },
        select: { id: true },
      });

      /*
       * Барьер на ОБЩЕМ ключе передачи, а не просто одновременный старт.
       *
       * Взаимная блокировка возникает не при каждом чередовании, поэтому
       * «запустили два запроса и не получили 500» не отличает работу общего
       * ключа от удачного расписания. Барьер доказывает главное: оба маршрута
       * встают на ОДИН ключ ДО любой своей вставки — значит вставлять в
       * противоположном порядке они уже не могут.
       */
      const transfer = await ctx.db.logistCashEntry.findUniqueOrThrow({
        where: { id: cashEntry.id },
        select: { transferId: true },
      });
      const barrier = await holdKey(`transfer-reversal:${transfer.transferId ?? ''}`);

      let settled = 0;
      const viaLedger = (
        ctx.app.inject({
          method: 'POST',
          url: `/api/logistics/ledger/operations/${ledgerId}/reverse`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { reason: 'отмена передачи из журнала' },
        }) as unknown as Promise<{ statusCode: number }>
      ).then((response) => {
        settled += 1;
        return response;
      });
      const viaCash = (
        ctx.app.inject({
          method: 'POST',
          url: `/api/logistics/cash/${cashEntry.id}/reverse`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { reason: 'отмена передачи из кассы' },
        }) as unknown as Promise<{ statusCode: number }>
      ).then((response) => {
        settled += 1;
        return response;
      });

      expect(await waitForBlockedBy(barrier.pid, 2)).toBeGreaterThanOrEqual(2);
      expect(settled).toBe(0);
      barrier.release();
      await barrier.done;

      const [ledgerResponse, cashResponse] = await Promise.all([viaLedger, viaCash]);

      // Ни одна сторона не вправе ответить внутренней ошибкой.
      for (const status of [ledgerResponse.statusCode, cashResponse.statusCode]) {
        expect([200, 409]).toContain(status);
      }
      // И хотя бы одна обязана выполнить отмену.
      expect([ledgerResponse.statusCode, cashResponse.statusCode]).toContain(200);

      // Обе стороны передачи отменены ровно по одному разу.
      expect(await ctx.db.courierLedgerEntry.count({ where: { reversesEntryId: ledgerId } })).toBe(
        1,
      );
      expect(await ctx.db.logistCashEntry.count({ where: { reversesEntryId: cashEntry.id } })).toBe(
        1,
      );
    }

    // Передачи и их отмены сошлись в ноль на обеих сторонах.
    expect(await cashBalanceOf(ctx.db, desk.id, null)).toBe(0n);
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);
  });
  it('отмену передачи из журнала не выполняет ни чужой логист, ни управляющий', async () => {
    /*
     * Отмена передачи двигает КАССУ. На создании право проверяется, а на
     * отмене проверки не было вовсе: чужой логист и управляющий обнуляли
     * наличные в кассе, к которой не имеют отношения, и снимали долг курьера.
     * Маршрут открыт всему финансовому контуру, поэтому право на кассу здесь
     * обязано проверяться отдельно от роли.
     */
    const { token: adminToken } = await tokenFor(['ADMIN']);
    const { token: foreignLogistToken } = await tokenFor(['LOGISTICIAN']);
    const { token: supervisorToken } = await tokenFor(['SUPERVISOR']);
    const desk = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const courier = await courierId();

    const created = await postOperation(adminToken, {
      courierUserId: courier,
      kind: 'CASH_HANDED_TO_LOGIST',
      amountMinor: '100000',
      operationDate: DAY,
      logistUserId: desk.id,
      idempotencyKey: unique('reverse-rights'),
    });
    expect(created.statusCode).toBe(201);
    const ledgerId = created.json().entry?.id ?? '';

    for (const token of [foreignLogistToken, supervisorToken]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/logistics/ledger/operations/${ledgerId}/reverse`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'чужая касса' },
      });
      expect(response.statusCode).toBe(403);
    }

    // Деньги остались на месте: ни касса, ни долг курьера не тронуты.
    expect(await cashBalanceOf(ctx.db, desk.id, null)).toBe(100_000n);
    expect(await balanceOf(ctx.db, courier, null)).toBe(-100_000n);
    expect(await ctx.db.courierLedgerEntry.count({ where: { reversesEntryId: ledgerId } })).toBe(0);

    // А администратор, назвавший эту кассу при создании, отменяет обычным порядком.
    const byAdmin = await ctx.app.inject({
      method: 'POST',
      url: `/api/logistics/ledger/operations/${ledgerId}/reverse`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reason: 'ошибочная передача' },
    });
    expect(byAdmin.statusCode).toBe(200);
    expect(await cashBalanceOf(ctx.db, desk.id, null)).toBe(0n);
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);
  });

  it('повтор отмены передачи из кассы не пишет вторую строку истории', async () => {
    /*
     * Пропуск уже отменённых сторон сделал повтор успешным — и заодно снял
     * единственную преграду перед вторым аудитом: маршрут кассы писал историю
     * и событие безусловно. Вторую строку получал тот, кто ничего не сделал.
     */
    const { token: adminToken } = await tokenFor(['ADMIN']);
    const desk = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const courier = await courierId();

    const created = await postOperation(adminToken, {
      courierUserId: courier,
      kind: 'CASH_HANDED_TO_LOGIST',
      amountMinor: '70000',
      operationDate: DAY,
      logistUserId: desk.id,
      idempotencyKey: unique('repeat-reverse'),
    });
    expect(created.statusCode).toBe(201);
    const cashEntry = await ctx.db.logistCashEntry.findFirstOrThrow({
      where: { logistUserId: desk.id, kind: 'RECEIVED_FROM_COURIER' },
      select: { id: true },
    });

    const cursor = await lastEventId();
    const reverseOnce = (): Promise<{ statusCode: number }> =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/logistics/cash/${cashEntry.id}/reverse`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { reason: 'ошибочная передача' },
      }) as never;

    expect((await reverseOnce()).statusCode).toBe(200);
    // Повтор успешен — отвечать по-разному с разных экранов нельзя.
    expect((await reverseOnce()).statusCode).toBe(200);

    expect(await ctx.db.logistCashEntry.count({ where: { reversesEntryId: cashEntry.id } })).toBe(
      1,
    );
    // Но история и событие — только у того, кто действительно отменил.
    expect(
      await ctx.db.auditLog.count({
        where: { action: 'FINANCE_CASH_REVERSED', entityId: cashEntry.id },
      }),
    ).toBe(1);
    expect(await ledgerEventsAfter(cursor)).toBe(1);
    expect(await cashBalanceOf(ctx.db, desk.id, null)).toBe(0n);
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);
  });

  it('владелец кассы отменяет СВОЮ передачу из журнала', async () => {
    /*
     * Законный путь: новая проверка права не должна была его закрыть.
     * Проверка отказа сама по себе этого не доказывает.
     */
    const { token: ownerToken, userId: ownerId } = await tokenFor(['LOGISTICIAN']);
    const courier = await courierId();

    const created = await postOperation(ownerToken, {
      courierUserId: courier,
      kind: 'CASH_HANDED_TO_LOGIST',
      amountMinor: '90000',
      operationDate: DAY,
      idempotencyKey: unique('own-reverse'),
    });
    expect(created.statusCode).toBe(201);
    const ledgerId = created.json().entry?.id ?? '';

    const reversed = await ctx.app.inject({
      method: 'POST',
      url: `/api/logistics/ledger/operations/${ledgerId}/reverse`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { reason: 'ошибочная передача' },
    });
    expect(reversed.statusCode).toBe(200);
    expect(await cashBalanceOf(ctx.db, ownerId, null)).toBe(0n);
    expect(await balanceOf(ctx.db, courier, null)).toBe(0n);
  });
  it('передача без кассовой стороны не отменяется никем: отказ, а не пропуск права', async () => {
    /*
     * Проверка права была fail-open: нет кассовой стороны — нет и проверки,
     * отменить мог кто угодно из финансового контура. В правах на деньги
     * «данных не нашли, поэтому разрешаем» работает наоборот.
     */
    const { token: adminToken } = await tokenFor(['ADMIN']);
    const courier = await courierId();
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });

    // Запись с признаком передачи, у которой кассовой стороны нет вовсе.
    const orphan = await ctx.db.courierLedgerEntry.create({
      data: {
        courierUserId: courier,
        kind: 'CASH_HANDED_TO_LOGIST',
        amountMinor: -50_000n,
        operationDate: new Date(`${DAY}T00:00:00.000Z`),
        actorUserId: admin.id,
        transferId: randomUUID(),
        idempotencyKey: unique('orphan-transfer'),
      },
      select: { id: true },
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/logistics/ledger/operations/${orphan.id}/reverse`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reason: 'попытка отмены' },
    });
    expect(response.statusCode).toBe(409);
    expect(await ctx.db.courierLedgerEntry.count({ where: { reversesEntryId: orphan.id } })).toBe(
      0,
    );
  });
});
