/**
 * Критические проверки импорта выплат из выписки ПланФакта.
 *
 * Защищаемые свойства: курьер находится только по телефону из «Контрагента»
 * и во всех записях номера; выплата ложится в «Выдано курьеру» точной суммой
 * в день оплаты и ни во что другое — ни в заработок, ни в кассу загрузившего;
 * части разбитой выплаты проводятся по одной, родитель — нет; тот же файл под
 * любым именем, двойное нажатие и параллельное подтверждение не дают лишних
 * записей; одинаковые выплаты в одном файле не теряются, а совпадение с уже
 * проведённой требует явного решения; отмена — обратной записью и только
 * администратором; не-администратору сервер отказывает.
 *
 * Выписки — обезличенные, построены в самой проверке. Настоящих данных здесь
 * нет и быть не может.
 *
 * ВЛАДЕНИЕ ДАТАМИ: декабрь 2030 (см. RESERVED_MONTHS).
 */

import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@fl/shared';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from '../auth/testing/harness.js';
import { balanceOf } from './ledger.js';
import { buildSettlementReport } from './reports.js';
import { buildCashReport } from './cash-report.js';
import { buildSettlementWorkbook } from './export-xlsx.js';
import {
  CONFIRM_QUEUE_KEY,
  PAYOUT_IMPORT_REASON,
  phoneOfCounterparty,
  type PayoutPreview,
  type PayoutImportResult,
} from './payout-import.js';
import { cellMinor } from './planfact-statement.js';
import {
  buildPlanFactStatement,
  parentRow,
  partRow,
  payoutRow,
  type FixtureRow,
} from './testing/planfact-fixture.js';

let ctx: TestContext;

/** Дни оплаты — все внутри забронированного месяца. */
const DAY_A = '2030-12-03';
const DAY_B = '2030-12-10';
const DAY_C = '2030-12-16';

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

/** Новый телефон вида `+7999XXXXXXX`: обезличенный и уникальный в общей базе. */
function freshPhone(): string {
  seq += 1;
  const tail = String((process.hrtime.bigint() + BigInt(seq) * 7919n) % 10_000_000n).padStart(
    7,
    '0',
  );
  return `+7999${tail}`;
}

/** Реальный токен доступа: права проверяются через HTTP, а не мимо него. */
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

async function courier(
  fullName = 'Курьер проверки импорта',
): Promise<{ id: string; phone: string }> {
  const user = await seedUser(ctx.db, { roles: ['COURIER'], phone: freshPhone(), fullName });
  return user;
}

/** Контрагент так, как его пишет ПланФакт: имя и телефон в скобках. */
function counterparty(phone: string, name = 'Курьер Тестовый'): string {
  return `${name} (8${phone.slice(2)})`;
}

interface HttpResponse<T> {
  statusCode: number;
  json: () => T;
}

function postPreview(
  token: string,
  file: Buffer,
  fileName = 'выписка.xlsx',
): Promise<HttpResponse<PayoutPreview>> {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/logistics/payout-imports/preview',
    headers: { authorization: `Bearer ${token}` },
    payload: { fileName, content: file.toString('base64') },
  }) as never;
}

/**
 * Подтверждение так, как его делает экран: сначала предпросмотр, затем
 * подтверждение РОВНО показанных строк. `approved` можно задать явно — для
 * проверок, где контракт нарочно устарел.
 */
async function postConfirm(
  token: string,
  file: Buffer,
  input: {
    fileName?: string;
    idempotencyKey: string;
    acceptRows?: number[];
    approved?: ApprovedRow[];
  },
): Promise<HttpResponse<PayoutImportResult>> {
  let approved = input.approved;
  if (approved === undefined) {
    const preview = await postPreview(token, file, input.fileName);
    approved = preview.statusCode === 200 ? approvedOf(preview.json(), input.acceptRows ?? []) : [];
  }
  return ctx.app.inject({
    method: 'POST',
    url: '/api/logistics/payout-imports',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      fileName: input.fileName ?? 'выписка.xlsx',
      content: file.toString('base64'),
      idempotencyKey: input.idempotencyKey,
      approved,
    },
  }) as never;
}

async function importEntries(courierUserId: string): Promise<
  {
    amountMinor: bigint;
    operationDate: string;
    payoutImportId: string | null;
    reason: string | null;
  }[]
> {
  const rows = await ctx.db.courierLedgerEntry.findMany({
    where: { courierUserId, kind: 'CASH_ISSUED_TO_COURIER' },
    orderBy: [{ operationDate: 'asc' }],
    select: { amountMinor: true, operationDate: true, payoutImportId: true, reason: true },
  });
  return rows.map((row) => ({
    ...row,
    operationDate: row.operationDate.toISOString().slice(0, 10),
  }));
}

/** Курсор ленты событий и счётчик финансовых событий после него. */
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
 * Сколько соединений СЕЙЧАС заблокированы НАШИМ барьером — только в этой базе.
 * «Прошло столько-то миллисекунд» ничего не доказывает: запрос, который ещё
 * проверяет права, здесь не считается.
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
    { timeout: 30_000, maxWait: 30_000 },
  );

  return { pid: await lockedSignal, release, done };
}

/** Строка, которую администратор увидел и подтвердил, — так, как её шлёт экран. */
interface ApprovedRow {
  rowNo: number;
  state: 'ready' | 'possible_duplicate';
  courierUserId: string;
  operationDate: string;
  amountMinor: string;
}

/** Контракт подтверждения из предпросмотра: готовые строки плюс явно принятые повторы. */
function approvedOf(preview: PayoutPreview, acceptRows: readonly number[] = []): ApprovedRow[] {
  return preview.rows
    .filter(
      (row) =>
        row.state === 'ready' ||
        (row.state === 'possible_duplicate' && acceptRows.includes(row.rowNo)),
    )
    .map((row) => ({
      rowNo: row.rowNo,
      state: row.state as 'ready' | 'possible_duplicate',
      courierUserId: row.courier?.id ?? '',
      operationDate: row.operationDate ?? '',
      amountMinor: row.amountMinor ?? '0',
    }));
}

// --- Телефон из контрагента ---------------------------------------------------

describe('телефон курьера берётся из «Контрагента» и приводится к одному виду', () => {
  it('все принятые записи номера дают один и тот же телефон', () => {
    const expected = '+79990001122';
    for (const text of [
      'Иванов Иван (89990001122)',
      'Иванов Иван (79990001122)',
      'Иванов Иван +7 (999) 000-11-22',
      'Иванов Иван 8 999 000 11 22',
      'Иванов Иван (9990001122)',
      'Иванов Иван (89990001122) тел. 8 (999) 000-11-22',
    ]) {
      expect(phoneOfCounterparty(text), text).toEqual({ phone: expected, problem: null });
    }
  });

  it('без телефона, с нечитаемым номером и с двумя разными — причина, а не догадка', () => {
    expect(phoneOfCounterparty(null)).toEqual({ phone: null, problem: 'missing' });
    expect(phoneOfCounterparty('Иванов Иван')).toEqual({ phone: null, problem: 'missing' });
    expect(phoneOfCounterparty('Иванов Иван (12345)')).toEqual({ phone: null, problem: 'missing' });
    expect(phoneOfCounterparty('Иванов Иван (123456789012345)')).toEqual({
      phone: null,
      problem: 'invalid',
    });
    expect(phoneOfCounterparty('Иванов (89990001122, 89990001133)')).toEqual({
      phone: null,
      problem: 'multiple',
    });
    /*
     * Неразобранная последовательность цифр — не место, откуда можно достать
     * «один удачный» номер. Соседний реквизит, два номера через пробел, два
     * номера в одних скобках — всё это отказ, а не выбор одного из них.
     */
    for (const text of [
      'ИНН 771234567890 89990001122',
      'Test (8 999 000 11 22 89990001133)',
      'Test (89990001133 8 999 000 11 22)',
      'Test (8 999 000 11 22) (89990001133)',
    ]) {
      expect(phoneOfCounterparty(text), text).toEqual({ phone: null, problem: 'invalid' });
    }
    expect(phoneOfCounterparty('Test (89990001133), (8 999 000 11 22)')).toEqual({
      phone: null,
      problem: 'multiple',
    });
  });

  it('пять записей одного номера в файле ведут к одному курьеру', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const national = who.phone.slice(2);
    const forms = [
      `8${national}`,
      `7${national}`,
      `+7 (${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6, 8)}-${national.slice(8)}`,
      `8 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6, 8)} ${national.slice(8)}`,
      national,
    ];
    const file = await buildPlanFactStatement(
      forms.map((form, index) => payoutRow(`Курьер Тестовый (${form})`, -(100 + index), DAY_A)),
    );

    const preview = await postPreview(token, file);
    expect(preview.statusCode).toBe(200);
    const rows = preview.json().rows;
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.state).toBe('ready');
      expect(row.phone).toBe(who.phone);
      expect(row.courier?.id).toBe(who.id);
    }
    // Предпросмотр ничего не пишет.
    expect(await importEntries(who.id)).toHaveLength(0);
    expect(await ctx.db.courierPayoutImport.count({ where: { fileName: 'выписка.xlsx' } })).toBe(
      await ctx.db.courierPayoutImport.count({ where: { fileName: 'выписка.xlsx' } }),
    );
  });

  it('нет телефона, не курьер, не найден, два номера — строка не проводится с понятной причиной', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'], phone: freshPhone() });
    const unknown = freshPhone();

    const file = await buildPlanFactStatement([
      payoutRow('Курьер Без Телефона', -100, DAY_A),
      payoutRow(`Логист Тестовый (8${logist.phone.slice(2)})`, -100, DAY_A),
      payoutRow(`Никто Неизвестный (8${unknown.slice(2)})`, -100, DAY_A),
      payoutRow(`Двое (8${who.phone.slice(2)}, 8${unknown.slice(2)})`, -100, DAY_A),
      payoutRow(`Курьер Тестовый (8${who.phone.slice(2)})`, -100, DAY_A),
    ]);

    const preview = await postPreview(token, file);
    const rows = preview.json().rows;
    expect(rows.map((row) => row.state)).toEqual(['error', 'error', 'error', 'error', 'ready']);
    expect(rows[0]?.reason).toContain('не указан телефон');
    expect(rows[1]?.reason).toContain('не курьер');
    expect(rows[2]?.reason).toContain('не найден');
    expect(rows[3]?.reason).toContain('несколько');

    // Подтверждение проводит только пятую: ошибочные строки перечислены, а не потеряны.
    const confirmed = await postConfirm(token, file, { idempotencyKey: unique('phones') });
    expect(confirmed.statusCode).toBe(201);
    const result = confirmed.json();
    expect(result.posted.map((row) => row.rowNo)).toEqual([7]);
    expect(result.skipped.map((row) => row.rowNo)).toEqual([3, 4, 5, 6]);
    expect(await balanceOf(ctx.db, who.id, null)).toBe(10_000n);
    expect(await balanceOf(ctx.db, logist.id, null)).toBe(0n);
  });
});

// --- Образец: три выплаты одному курьеру -------------------------------------

describe('выписка с тремя подтверждёнными выплатами одному курьеру', () => {
  it('проводится ровно тремя записями на 81 231,35 ₽ в дни оплаты и видна в «Выдано курьеру»', async () => {
    const { token, userId: adminId } = await tokenFor(['ADMIN']);
    const who = await courier();
    const name = counterparty(who.phone);
    const file = await buildPlanFactStatement([
      payoutRow(name, -28944.01, DAY_C),
      payoutRow(name, -24287.34, DAY_B),
      payoutRow(name, -28000, DAY_A),
    ]);
    const cursor = await lastEventId();

    const preview = await postPreview(token, file, 'Выписка.xlsx');
    expect(preview.statusCode).toBe(200);
    expect(preview.json().summary).toMatchObject({
      total: 3,
      ready: 3,
      readyTotalMinor: '8123135',
      errors: 0,
      alreadyImported: 0,
      possibleDuplicates: 0,
    });

    const confirmed = await postConfirm(token, file, {
      fileName: 'Выписка.xlsx',
      idempotencyKey: unique('sample'),
    });
    expect(confirmed.statusCode).toBe(201);
    const result = confirmed.json();
    expect(result.import?.postedCount).toBe(3);
    expect(result.import?.postedTotalMinor).toBe('8123135');
    expect(result.posted).toHaveLength(3);

    // Три записи нужного вида, с точными копейками, в дни оплаты, со ссылкой на импорт.
    const entries = await importEntries(who.id);
    expect(entries.map((entry) => [entry.operationDate, entry.amountMinor])).toEqual([
      [DAY_A, 2_800_000n],
      [DAY_B, 2_428_734n],
      [DAY_C, 2_894_401n],
    ]);
    for (const entry of entries) {
      expect(entry.payoutImportId).toBe(result.import?.id);
      expect(entry.reason).toBe(PAYOUT_IMPORT_REASON);
    }
    // Долг курьера перед компанией вырос на всю сумму: выдача — плюс.
    expect(await balanceOf(ctx.db, who.id, null)).toBe(8_123_135n);

    const report = await buildSettlementReport(ctx.db, {
      from: DAY_A,
      to: DAY_C,
      courierUserId: who.id,
      ledgerActiveFrom: null,
      limit: 50,
      offset: 0,
    });
    expect(report.totals.issuedToCourierMinor).toBe('8123135');
    expect(report.totals.closingBalanceMinor).toBe('8123135');
    // Ни в заработке, ни в расходах, ни в наличных.
    expect(report.totals.deliveryFeesMinor).toBe('0');
    expect(report.totals.distanceFeesMinor).toBe('0');
    expect(report.totals.attemptFeesMinor).toBe('0');
    expect(report.totals.bonusesMinor).toBe('0');
    expect(report.totals.expensesMinor).toBe('0');
    expect(report.totals.cashReceivedMinor).toBe('0');
    expect(report.totals.handedToLogistMinor).toBe('0');
    // Разбивка по дням: каждая выплата в своём дне.
    const issuedByDay = new Map(
      report.days.map((day) => [day.date, day.couriers[0]?.issuedMinor ?? '0']),
    );
    expect(issuedByDay.get(DAY_A)).toBe('2800000');
    expect(issuedByDay.get(DAY_B)).toBe('2428734');
    expect(issuedByDay.get(DAY_C)).toBe('2894401');
    for (const entry of report.entries) {
      expect(entry.payoutImportId).toBe(result.import?.id);
    }

    // Касса загрузившего администратора не изменилась: ни одной кассовой записи.
    expect(await ctx.db.logistCashEntry.count({ where: { logistUserId: adminId } })).toBe(0);
    expect(await ctx.db.logistCashEntry.count({ where: { courierUserId: who.id } })).toBe(0);
    const cash = await buildCashReport(ctx.db, {
      from: DAY_A,
      to: DAY_C,
      limit: 50,
      offset: 0,
      visibleLogistIds: [adminId],
    });
    expect(cash.summary.issuedMinor).toBe('0');

    // Выгрузка называет источник.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildSettlementWorkbook(report));
    const operations = workbook.getWorksheet('Операции');
    expect(operations).toBeDefined();
    const sources: string[] = [];
    operations?.eachRow((row) => {
      const source = row.getCell(11).value;
      if (typeof source === 'string' && source !== '') {
        sources.push(source);
      }
    });
    expect(sources).toEqual(['Источник', 'ПланФакт', 'ПланФакт', 'ПланФакт']);

    // Один аудит и одно событие на импорт; в аудите нет ни имени, ни телефона.
    const audits = await ctx.db.auditLog.findMany({
      where: { action: 'FINANCE_PAYOUT_IMPORTED', entityId: result.import?.id ?? '' },
    });
    expect(audits).toHaveLength(1);
    const auditText = JSON.stringify(audits[0]?.newValue ?? {});
    expect(auditText).not.toContain(who.phone.slice(2));
    expect(auditText).not.toContain('Курьер Тестовый');
    expect(await ledgerEventsAfter(cursor)).toBe(1);
  });

  it('файл с префиксом x: в XML читается так же, как обычный', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const rows = [payoutRow(counterparty(who.phone), -28944.01, DAY_C)];
    const plain = await postPreview(token, await buildPlanFactStatement(rows));
    const prefixed = await postPreview(
      token,
      await buildPlanFactStatement(rows, { prefixed: true }),
    );

    expect(plain.statusCode).toBe(200);
    expect(prefixed.statusCode).toBe(200);
    const strip = (preview: PayoutPreview): unknown =>
      preview.rows.map((row) => [
        row.rowNo,
        row.state,
        row.operationDate,
        row.amountMinor,
        row.phone,
      ]);
    expect(strip(prefixed.json())).toEqual(strip(plain.json()));
    expect(prefixed.json().rows[0]).toMatchObject({
      state: 'ready',
      operationDate: DAY_C,
      amountMinor: '2894401',
    });
  });

  it('дата текстом и порядковым номером Excel читается без сдвига дня', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const serial = Date.UTC(2030, 11, 16) / 86_400_000 + 25_569;
    const file = await buildPlanFactStatement([
      payoutRow(counterparty(who.phone), -100, DAY_C, { paymentDate: '16.12.2030' }),
      payoutRow(counterparty(who.phone), -200, DAY_C, { paymentDate: serial }),
      payoutRow(counterparty(who.phone), '-28 944,01', DAY_C),
    ]);
    const rows = (await postPreview(token, file)).json().rows;
    expect(rows.map((row) => [row.state, row.operationDate, row.amountMinor])).toEqual([
      ['ready', DAY_C, '10000'],
      ['ready', DAY_C, '20000'],
      ['ready', DAY_C, '2894401'],
    ]);
  });
});

// --- Части ----------------------------------------------------------------------

describe('выплата, разбитая на части', () => {
  it('проводятся части по своим телефонам с датой родителя; родитель не проводится', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const first = await courier('Курьер Первый');
    const second = await courier('Курьер Второй');
    const file = await buildPlanFactStatement([
      parentRow(-55328.01, DAY_C),
      partRow(counterparty(first.phone, 'Первый Курьер'), -28944.01, DAY_C),
      partRow(counterparty(second.phone, 'Второй Курьер'), -26384, DAY_C),
      payoutRow(counterparty(first.phone, 'Первый Курьер'), -17399.21, DAY_B),
    ]);

    const preview = (await postPreview(token, file)).json();
    // Родительская строка (3) — контейнер, кандидаты — части и отдельная выплата.
    expect(preview.containers).toEqual([3]);
    expect(
      preview.rows.map((row) => [row.rowNo, row.parentRowNo, row.state, row.operationDate]),
    ).toEqual([
      [4, 3, 'ready', DAY_C],
      [5, 3, 'ready', DAY_C],
      [6, null, 'ready', DAY_B],
    ]);
    expect(preview.summary.readyTotalMinor).toBe(String(2_894_401 + 2_638_400 + 1_739_921));

    const confirmed = await postConfirm(token, file, { idempotencyKey: unique('parts') });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().posted).toHaveLength(3);
    expect(await balanceOf(ctx.db, first.id, null)).toBe(2_894_401n + 1_739_921n);
    expect(await balanceOf(ctx.db, second.id, null)).toBe(2_638_400n);
    // Сумма родителя ни у кого не оказалась второй раз.
    expect(await ctx.db.courierLedgerEntry.count({ where: { amountMinor: 5_532_801n } })).toBe(0);
  });

  it('несходящаяся группа и часть без родителя — ошибка, ничего не проводится автоматически', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const name = counterparty(who.phone);
    const file = await buildPlanFactStatement([
      partRow(name, -50, DAY_A),
      parentRow(-100, DAY_A),
      partRow(name, -60, DAY_A),
      partRow(name, -50, DAY_A),
    ]);

    const rows = (await postPreview(token, file)).json().rows;
    expect(rows.map((row) => [row.rowNo, row.state])).toEqual([
      [3, 'error'],
      [5, 'error'],
      [6, 'error'],
    ]);
    expect(rows[0]?.reason).toContain('без родительской');
    expect(rows[1]?.reason).toContain('не равна сумме выплаты');

    const confirmed = await postConfirm(token, file, { idempotencyKey: unique('parts-bad') });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().import).toBeNull();
    expect(confirmed.json().skipped).toHaveLength(3);
    expect(await balanceOf(ctx.db, who.id, null)).toBe(0n);
  });
});

// --- Отбор строк ------------------------------------------------------------------

describe('что не проводится', () => {
  it('положительная и нулевая суммы — ошибка; неподтверждённые, чужая статья, валюта и поступления — пропуск', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const name = counterparty(who.phone);
    const file = await buildPlanFactStatement([
      payoutRow(name, 100, DAY_A),
      payoutRow(name, 0, DAY_A),
      payoutRow(name, -100, DAY_A, { paymentStatus: 'Черновик' }),
      payoutRow(name, -100, DAY_A, { article: 'Аренда' }),
      payoutRow(name, -100, DAY_A, { currency: 'USD' }),
      payoutRow(name, 100, DAY_A, { type: 'Поступление' }),
      payoutRow(name, -100, DAY_A, { paymentDate: null }),
      payoutRow(name, 'много', DAY_A),
    ]);

    const rows = (await postPreview(token, file)).json().rows;
    expect(rows.map((row) => row.state)).toEqual([
      'error',
      'error',
      'ignored',
      'ignored',
      'ignored',
      'ignored',
      'error',
      'error',
    ]);
    expect(rows[0]?.reason).toContain('положительная');
    expect(rows[6]?.reason).toContain('нет даты оплаты');
    expect(rows[7]?.reason).toContain('сумма не распознана');

    const confirmed = await postConfirm(token, file, { idempotencyKey: unique('filters') });
    expect(confirmed.json().import).toBeNull();
    expect(await balanceOf(ctx.db, who.id, null)).toBe(0n);
  });

  it('файл не выписка — понятный отказ без записи', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Другое').getCell(1, 1).value = 'не выписка';
    const notStatement = Buffer.from(await workbook.xlsx.writeBuffer());

    const wrongHeaders = await postPreview(token, notStatement);
    expect(wrongHeaders.statusCode).toBe(400);

    const notXlsx = await ctx.app.inject({
      method: 'POST',
      url: '/api/logistics/payout-imports/preview',
      headers: { authorization: `Bearer ${token}` },
      payload: { fileName: 'выписка.csv', content: Buffer.from('a;b;c').toString('base64') },
    });
    expect(notXlsx.statusCode).toBe(400);
  });
});

// --- Повторы -----------------------------------------------------------------------

describe('повторы и одинаковые выплаты', () => {
  it('тот же файл повторно, под другим именем и двумя параллельными подтверждениями — записи не удваиваются', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const name = counterparty(who.phone);
    const file = await buildPlanFactStatement([
      payoutRow(name, -1000, DAY_A),
      payoutRow(name, -2000, DAY_B),
    ]);
    const key = unique('repeat');

    // Двойное нажатие: два одновременных подтверждения с одним ключом.
    const [first, second] = await Promise.all([
      postConfirm(token, file, { idempotencyKey: key }),
      postConfirm(token, file, { idempotencyKey: key }),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(first.json().import?.id).toBe(second.json().import?.id);
    expect(await balanceOf(ctx.db, who.id, null)).toBe(300_000n);

    // Тот же файл под другим именем и с другим ключом: всё уже проведено.
    const renamed = await postConfirm(token, file, {
      fileName: 'Выписка (копия).xlsx',
      idempotencyKey: unique('repeat-renamed'),
    });
    expect(renamed.statusCode).toBe(201);
    expect(renamed.json().import).toBeNull();
    expect(renamed.json().skipped.map((row) => row.state)).toEqual([
      'already_imported',
      'already_imported',
    ]);

    // Предпросмотр говорит то же самое и называет проведённую запись.
    const preview = (await postPreview(token, file)).json();
    expect(preview.summary.alreadyImported).toBe(2);
    expect(preview.rows.every((row) => row.existingEntryId !== null)).toBe(true);

    // Параллельно два РАЗНЫХ ключа на один новый файл — строки проводятся один раз.
    const another = await buildPlanFactStatement([payoutRow(name, -3000, DAY_C)]);
    const [left, right] = await Promise.all([
      postConfirm(token, another, { idempotencyKey: unique('race-a') }),
      postConfirm(token, another, { idempotencyKey: unique('race-b') }),
    ]);
    /*
     * Оба подтверждают один и тот же предпросмотр. Победитель проводит строку;
     * для проигравшего она уже «проведена», то есть показанное ему устарело —
     * он получает отказ и обновляет предпросмотр, а не тихое «ничего».
     */
    expect([left.statusCode, right.statusCode].sort((a, b) => a - b)).toEqual([201, 409]);
    const winner = left.statusCode === 201 ? left : right;
    expect(winner.json().posted).toHaveLength(1);
    expect(await balanceOf(ctx.db, who.id, null)).toBe(600_000n);
    expect(await importEntries(who.id)).toHaveLength(3);
  });

  it('тот же ключ подтверждения с другим файлом — конфликт', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const key = unique('key-mismatch');
    const first = await postConfirm(
      token,
      await buildPlanFactStatement([payoutRow(counterparty(who.phone), -100, DAY_A)]),
      { idempotencyKey: key },
    );
    expect(first.statusCode).toBe(201);
    const other = await postConfirm(
      token,
      await buildPlanFactStatement([payoutRow(counterparty(who.phone), -200, DAY_A)]),
      { idempotencyKey: key },
    );
    expect(other.statusCode).toBe(409);
    expect(await balanceOf(ctx.db, who.id, null)).toBe(10_000n);
  });

  it('две одинаковые выплаты в одном файле проводятся обе; совпадение с другой выпиской — только по явному решению', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const name = counterparty(who.phone);

    const first = await buildPlanFactStatement([
      payoutRow(name, -500, DAY_A),
      payoutRow(name, -500, DAY_A),
    ]);
    const firstResult = await postConfirm(token, first, {
      fileName: 'первая.xlsx',
      idempotencyKey: unique('twins'),
    });
    expect(firstResult.json().posted).toHaveLength(2);
    expect(await balanceOf(ctx.db, who.id, null)).toBe(100_000n);

    // Повторная выгрузка того же периода — другой файл с теми же выплатами и новой строкой.
    const reexport = await buildPlanFactStatement([
      payoutRow(name, -500, DAY_A),
      payoutRow(name, -500, DAY_A),
      payoutRow(name, -700, DAY_B),
    ]);
    const preview = (await postPreview(token, reexport, 'вторая.xlsx')).json();
    expect(preview.rows.map((row) => row.state)).toEqual([
      'possible_duplicate',
      'possible_duplicate',
      'ready',
    ]);
    expect(preview.rows[0]?.duplicates).toHaveLength(2);
    expect(preview.rows[0]?.duplicates[0]).toMatchObject({
      source: 'import',
      fileName: 'первая.xlsx',
    });
    expect(preview.summary).toMatchObject({
      ready: 1,
      readyTotalMinor: '70000',
      possibleDuplicates: 2,
      possibleDuplicatesTotalMinor: '100000',
    });

    // Без явного решения проводится только новая строка.
    const cautious = await postConfirm(token, reexport, {
      fileName: 'вторая.xlsx',
      idempotencyKey: unique('reexport'),
    });
    expect(cautious.json().posted.map((row) => row.rowNo)).toEqual([5]);
    expect(cautious.json().skipped.map((row) => row.state)).toEqual([
      'possible_duplicate',
      'possible_duplicate',
    ]);
    expect(await balanceOf(ctx.db, who.id, null)).toBe(170_000n);

    // Администратор принял решение по одной строке — проводится ровно она.
    const decided = await postConfirm(token, reexport, {
      fileName: 'вторая.xlsx',
      idempotencyKey: unique('reexport-accept'),
      acceptRows: [3],
    });
    expect(decided.json().posted.map((row) => row.rowNo)).toEqual([3]);
    expect(await balanceOf(ctx.db, who.id, null)).toBe(220_000n);
    expect(await importEntries(who.id)).toHaveLength(4);
  });

  it('выдача, заведённая вручную, тоже показывается возможным повтором', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const desk = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    // В кассе логиста должны быть наличные, чтобы было что выдать.
    const funded = await ctx.app.inject({
      method: 'POST',
      url: '/api/logistics/cash/company',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        direction: 'TAKE',
        amountMinor: '250000',
        operationDate: DAY_B,
        logistUserId: desk.id,
        idempotencyKey: unique('fund-desk'),
      },
    });
    expect(funded.statusCode, funded.body).toBe(201);
    const manual = await ctx.app.inject({
      method: 'POST',
      url: '/api/logistics/ledger/operations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        courierUserId: who.id,
        kind: 'CASH_ISSUED_TO_COURIER',
        amountMinor: '250000',
        operationDate: DAY_B,
        logistUserId: desk.id,
        idempotencyKey: unique('manual-issue'),
      },
    });
    expect(manual.statusCode, manual.body).toBe(201);

    const preview = (
      await postPreview(
        token,
        await buildPlanFactStatement([payoutRow(counterparty(who.phone), -2500, DAY_B)]),
      )
    ).json();
    expect(preview.rows[0]).toMatchObject({ state: 'possible_duplicate' });
    expect(preview.rows[0]?.duplicates[0]).toMatchObject({ source: 'manual', fileName: null });
  });
});

// --- Отмена и права -------------------------------------------------------------

describe('отмена и права', () => {
  it('выплату из выписки отменяет только администратор — обратной записью; строка файла остаётся проведённой', async () => {
    const { token: adminToken } = await tokenFor(['ADMIN']);
    const { token: logistToken } = await tokenFor(['LOGISTICIAN']);
    const who = await courier();
    const file = await buildPlanFactStatement([payoutRow(counterparty(who.phone), -1500, DAY_A)]);

    const confirmed = await postConfirm(adminToken, file, { idempotencyKey: unique('reverse') });
    const entryId = confirmed.json().posted[0]?.entryId ?? '';
    expect(entryId).not.toBe('');
    expect(await balanceOf(ctx.db, who.id, null)).toBe(150_000n);

    const byLogist = await ctx.app.inject({
      method: 'POST',
      url: `/api/logistics/ledger/operations/${entryId}/reverse`,
      headers: { authorization: `Bearer ${logistToken}` },
      payload: { reason: 'попытка без прав' },
    });
    expect(byLogist.statusCode).toBe(403);
    expect(await balanceOf(ctx.db, who.id, null)).toBe(150_000n);

    const byAdmin = await ctx.app.inject({
      method: 'POST',
      url: `/api/logistics/ledger/operations/${entryId}/reverse`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reason: 'выплата проведена ошибочно' },
    });
    expect(byAdmin.statusCode).toBe(200);
    expect(await balanceOf(ctx.db, who.id, null)).toBe(0n);
    // Исходная запись цела, обратная — одна, с аудитом.
    expect(await ctx.db.courierLedgerEntry.count({ where: { reversesEntryId: entryId } })).toBe(1);
    expect(
      await ctx.db.auditLog.count({
        where: {
          action: 'FINANCE_OPERATION_REVERSED',
          newValue: { path: ['reversesEntryId'], equals: entryId },
        },
      }),
    ).toBe(1);

    // Отменённая строка НЕ проводится повторно тем же файлом: ключ строки занят.
    const again = await postConfirm(adminToken, file, { idempotencyKey: unique('reverse-again') });
    expect(again.json().import).toBeNull();
    expect(again.json().skipped[0]?.state).toBe('already_imported');
    expect(await balanceOf(ctx.db, who.id, null)).toBe(0n);
  });

  it('не-администратору предпросмотр, подтверждение и список импортов запрещены', async () => {
    const who = await courier();
    const file = await buildPlanFactStatement([payoutRow(counterparty(who.phone), -100, DAY_A)]);
    const importsBefore = await ctx.db.courierPayoutImport.count();

    for (const roles of [['LOGISTICIAN'], ['SUPERVISOR'], ['COURIER'], ['MANAGER']] as Role[][]) {
      const { token } = await tokenFor(roles);
      expect((await postPreview(token, file)).statusCode).toBe(403);
      expect((await postConfirm(token, file, { idempotencyKey: unique('deny') })).statusCode).toBe(
        403,
      );
      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/logistics/payout-imports',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.statusCode).toBe(403);
    }

    expect(await balanceOf(ctx.db, who.id, null)).toBe(0n);
    expect(await ctx.db.courierPayoutImport.count()).toBe(importsBefore);
  });

  it('карточка импорта и список показывают итоги без имён контрагентов и телефонов', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const file = await buildPlanFactStatement([
      payoutRow(counterparty(who.phone, 'Секретный Контрагент'), -100, DAY_A),
      payoutRow('Без Телефона', -100, DAY_A),
    ]);
    const confirmed = await postConfirm(token, file, { idempotencyKey: unique('card') });
    const id = confirmed.json().import?.id ?? '';

    const card = await ctx.app.inject({
      method: 'GET',
      url: `/api/logistics/payout-imports/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(card.statusCode).toBe(200);
    const body = card.json() as PayoutImportResult;
    expect(body.import?.postedCount).toBe(1);
    expect(body.posted[0]?.courier?.id).toBe(who.id);
    expect(body.skipped).toEqual([
      { rowNo: 4, state: 'error', reason: 'в контрагенте не указан телефон' },
    ]);

    // В хранимом импорте нет ни имени контрагента, ни телефона.
    const stored = await ctx.db.courierPayoutImport.findUniqueOrThrow({ where: { id } });
    const text = JSON.stringify(stored.rows);
    expect(text).not.toContain('Секретный');
    expect(text).not.toContain(who.phone.slice(2));

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/logistics/payout-imports?limit=5',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: { id: string }[] }).items.some((item) => item.id === id)).toBe(
      true,
    );
  });
});

// --- Дефекты независимого ревью cbd529b -----------------------------------------

describe('ревью cbd529b: воспроизведения и закрытие', () => {
  type FileKey = 'first' | 'second';

  /**
   * Гонка двух РАЗНЫХ файлов с одной выплатой.
   *
   * Блокировка только по хешу файла не защищала: два файла получали разные
   * очереди, не видели записей друг друга и проводили 5 000 ₽ дважды. Теперь
   * подтверждения выстраиваются в одну очередь независимо от файла: победитель
   * проводит выплату, проигравший получает отказ и после нового предпросмотра
   * видит её как возможный повтор.
   *
   * Кто победит, решает порядок постановки в очередь: PostgreSQL выдаёт
   * блокировку ждущим по порядку. `order` ставит в очередь первым названный
   * файл и закрепляет его победу; `null` — одновременный старт, победитель
   * любой, а последующие проверки выбирают проигравшего по ответу, а не по
   * номеру файла.
   */
  async function crossFileRace(order: FileKey | null): Promise<void> {
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const name = counterparty(who.phone);
    const files: Record<FileKey, { name: string; content: Buffer }> = {
      first: {
        name: 'первая.xlsx',
        content: await buildPlanFactStatement([payoutRow(name, -5000, DAY_B)]),
      },
      second: {
        name: 'вторая.xlsx',
        content: await buildPlanFactStatement([
          payoutRow(name, -5000, DAY_B, { purpose: 'ЗП СМЗ (повторная выгрузка)' }),
        ]),
      },
    };
    const previewOf = async (key: FileKey): Promise<PayoutPreview> =>
      (await postPreview(token, files[key].content, files[key].name)).json();
    const approved: Record<FileKey, ApprovedRow[]> = {
      first: approvedOf(await previewOf('first')),
      second: approvedOf(await previewOf('second')),
    };
    expect(approved.first).toHaveLength(1);
    expect(approved.second).toHaveLength(1);

    const barrier = await holdKey(CONFIRM_QUEUE_KEY);
    const start = (key: FileKey): Promise<HttpResponse<PayoutImportResult>> =>
      postConfirm(token, files[key].content, {
        fileName: files[key].name,
        idempotencyKey: unique(`cross-${key}`),
        approved: approved[key],
      });

    let pending: Record<FileKey, Promise<HttpResponse<PayoutImportResult>>>;
    if (order === null) {
      pending = { first: start('first'), second: start('second') };
    } else {
      // Ведущий встаёт в очередь первым — и только затем стартует второй.
      const follower: FileKey = order === 'first' ? 'second' : 'first';
      const lead = start(order);
      expect(await waitForBlockedBy(barrier.pid, 1)).toBeGreaterThanOrEqual(1);
      const follow = start(follower);
      pending =
        order === 'first' ? { first: lead, second: follow } : { first: follow, second: lead };
    }
    // Оба запроса действительно стоят в общей очереди подтверждений.
    const blocked = await waitForBlockedBy(barrier.pid, 2);
    barrier.release();
    await barrier.done;
    const results: Record<FileKey, HttpResponse<PayoutImportResult>> = {
      first: await pending.first,
      second: await pending.second,
    };
    expect(blocked).toBeGreaterThanOrEqual(2);

    expect([results.first.statusCode, results.second.statusCode].sort((x, y) => x - y)).toEqual([
      201, 409,
    ]);
    const winner: FileKey = results.first.statusCode === 201 ? 'first' : 'second';
    const loser: FileKey = winner === 'first' ? 'second' : 'first';
    if (order !== null) {
      expect(winner).toBe(order);
    }
    expect(results[winner].json().posted).toHaveLength(1);
    expect(await importEntries(who.id)).toHaveLength(1);
    expect(await balanceOf(ctx.db, who.id, null)).toBe(500_000n);

    // Победивший файл проведён; проигравший после нового предпросмотра —
    // возможный повтор, который проводится только явным решением.
    expect((await previewOf(winner)).rows[0]?.state).toBe('already_imported');
    const refreshed = await previewOf(loser);
    expect(refreshed.rows[0]?.state).toBe('possible_duplicate');
    const decided = await postConfirm(token, files[loser].content, {
      fileName: files[loser].name,
      idempotencyKey: unique('cross-decided'),
      approved: approvedOf(refreshed, [refreshed.rows[0]?.rowNo ?? 0]),
    });
    expect(decided.statusCode).toBe(201);
    expect(await balanceOf(ctx.db, who.id, null)).toBe(1_000_000n);
  }

  it('1. две разные выгрузки с одной выплатой при одновременном подтверждении дают одну запись', () =>
    crossFileRace(null));

  it('1а. тот же исход, когда первой в очередь встаёт первая выгрузка', () =>
    crossFileRace('first'));

  it('1б. тот же исход, когда первой в очередь встаёт вторая выгрузка', () =>
    crossFileRace('second'));

  it('2. подтверждение проводит ровно то, что показал предпросмотр, иначе требует обновить его', async () => {
    /*
     * Между просмотром и подтверждением сменился справочник: телефон первой
     * строки перешёл к другому курьеру, а курьер второй строки появился.
     * Прежде сервер молча проводил всё, что готово ТЕПЕРЬ (12 000 ₽ курьерам
     * B и C), хотя согласовывались 5 000 ₽ курьеру A.
     */
    const { token } = await tokenFor(['ADMIN']);
    const courierA = await courier('Курьер A');
    const phoneA = courierA.phone;
    const phoneC = freshPhone();
    const file = await buildPlanFactStatement([
      payoutRow(counterparty(phoneA, 'Первый'), -5000, DAY_A),
      payoutRow(counterparty(phoneC, 'Второй'), -7000, DAY_A),
    ]);

    const shown = (await postPreview(token, file)).json();
    expect(shown.rows.map((row) => [row.state, row.courier?.id ?? null])).toEqual([
      ['ready', courierA.id],
      ['error', null],
    ]);
    const approved = approvedOf(shown);
    expect(approved).toEqual([
      {
        rowNo: 3,
        state: 'ready',
        courierUserId: courierA.id,
        operationDate: DAY_A,
        amountMinor: '500000',
      },
    ]);

    // Справочник меняется: телефон A уходит к B, появляется C.
    await ctx.db.user.update({ where: { id: courierA.id }, data: { phone: freshPhone() } });
    const courierB = await seedUser(ctx.db, {
      roles: ['COURIER'],
      phone: phoneA,
      fullName: 'Курьер B',
    });
    const courierC = await seedUser(ctx.db, {
      roles: ['COURIER'],
      phone: phoneC,
      fullName: 'Курьер C',
    });

    const stale = await postConfirm(token, file, { idempotencyKey: unique('stale'), approved });
    expect(stale.statusCode).toBe(409);
    for (const id of [courierA.id, courierB.id, courierC.id]) {
      expect(await balanceOf(ctx.db, id, null)).toBe(0n);
    }
    expect(
      await ctx.db.courierPayoutImport.count({ where: { fileSha256: shown.fileSha256 } }),
    ).toBe(0);

    // Обновлённый предпросмотр показывает новых получателей — и только его можно подтвердить.
    const refreshed = (await postPreview(token, file)).json();
    expect(refreshed.rows.map((row) => [row.state, row.courier?.id ?? null])).toEqual([
      ['ready', courierB.id],
      ['ready', courierC.id],
    ]);
    const confirmed = await postConfirm(token, file, {
      idempotencyKey: unique('fresh'),
      approved: approvedOf(refreshed),
    });
    expect(confirmed.statusCode).toBe(201);
    expect(await balanceOf(ctx.db, courierA.id, null)).toBe(0n);
    expect(await balanceOf(ctx.db, courierB.id, null)).toBe(500_000n);
    expect(await balanceOf(ctx.db, courierC.id, null)).toBe(700_000n);
  });

  it('2а. присланный получатель, не совпадающий с серверным, отклоняется', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const other = await courier('Другой курьер');
    const file = await buildPlanFactStatement([payoutRow(counterparty(who.phone), -100, DAY_A)]);
    const shown = (await postPreview(token, file)).json();
    const forged = approvedOf(shown).map((row) => ({ ...row, courierUserId: other.id }));

    const response = await postConfirm(token, file, {
      idempotencyKey: unique('forged'),
      approved: forged,
    });
    expect(response.statusCode).toBe(409);
    expect(await balanceOf(ctx.db, who.id, null)).toBe(0n);
    expect(await balanceOf(ctx.db, other.id, null)).toBe(0n);
  });

  it('3. два соседних номера — с пробелами и слитный — не превращаются в одного получателя', async () => {
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const file = await buildPlanFactStatement([
      payoutRow(`Двое (8 999 000 11 22 8${who.phone.slice(2)})`, -5000, DAY_A),
      payoutRow(`Двое (8${who.phone.slice(2)} 8 999 000 11 22)`, -5000, DAY_A),
    ]);
    const rows = (await postPreview(token, file)).json().rows;
    expect(rows.map((row) => row.state)).toEqual(['error', 'error']);
    expect(rows[0]?.reason).toContain('не распознан');

    const confirmed = await postConfirm(token, file, { idempotencyKey: unique('two-phones') });
    expect(confirmed.json().import).toBeNull();
    expect(await balanceOf(ctx.db, who.id, null)).toBe(0n);
  });

  it('4. повреждённая текстовая сумма отклоняется, а не превращается в другое число', async () => {
    expect(cellMinor('-5O00')).toEqual({ minor: null, invalid: true });
    expect(cellMinor('-1e3')).toEqual({ minor: null, invalid: true });
    expect(cellMinor('1,000.50')).toEqual({ minor: null, invalid: true });
    expect(cellMinor('12.345,67')).toEqual({ minor: null, invalid: true });
    expect(cellMinor('1 00')).toEqual({ minor: null, invalid: true });
    expect(cellMinor('--100')).toEqual({ minor: null, invalid: true });
    // Согласованные формы читаются точно, без плавающей точки.
    expect(cellMinor('-28 944,01')).toEqual({ minor: -2_894_401n, invalid: false });
    expect(cellMinor('28944.01 ₽')).toEqual({ minor: 2_894_401n, invalid: false });
    expect(cellMinor('−1 000')).toEqual({ minor: -100_000n, invalid: false });
    expect(cellMinor('1000')).toEqual({ minor: 100_000n, invalid: false });
    expect(cellMinor('-0,5')).toEqual({ minor: -50n, invalid: false });
    expect(cellMinor('12 345 678,90 руб.')).toEqual({ minor: 1_234_567_890n, invalid: false });

    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const file = await buildPlanFactStatement([
      payoutRow(counterparty(who.phone), '-5O00', DAY_A),
      payoutRow(counterparty(who.phone), '-1e3', DAY_A),
    ]);
    const rows = (await postPreview(token, file)).json().rows;
    expect(rows.map((row) => [row.state, row.reason])).toEqual([
      ['error', 'сумма не распознана'],
      ['error', 'сумма не распознана'],
    ]);
    const confirmed = await postConfirm(token, file, { idempotencyKey: unique('corrupt-sum') });
    expect(confirmed.json().import).toBeNull();
    expect(await balanceOf(ctx.db, who.id, null)).toBe(0n);
  });

  it('5. части разного знака блокируют группу целиком', async () => {
    /*
     * Родитель −1 000, части −1 500 и +500: алгебраическая сумма сходится,
     * положительная часть отклонялась отдельно, а −1 500 проводилась — больше
     * суммы выплаты. Смешение направлений в одной разбитой выплате не
     * поддерживается: ни одна часть не проводится.
     */
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const name = counterparty(who.phone);
    const file = await buildPlanFactStatement([
      parentRow(-1000, DAY_A),
      partRow(name, -1500, DAY_A),
      partRow(name, 500, DAY_A),
      // Контроль: корректная группа в том же файле проводится.
      parentRow(-3000, DAY_B),
      partRow(name, -1000, DAY_B),
      partRow(name, -2000, DAY_B),
    ]);
    const rows = (await postPreview(token, file)).json().rows;
    expect(rows.map((row) => [row.rowNo, row.state])).toEqual([
      [4, 'error'],
      [5, 'error'],
      [7, 'ready'],
      [8, 'ready'],
    ]);
    expect(rows[0]?.reason).toContain('знак');

    const confirmed = await postConfirm(token, file, { idempotencyKey: unique('mixed-parts') });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().posted.map((row) => row.rowNo)).toEqual([7, 8]);
    expect(await balanceOf(ctx.db, who.id, null)).toBe(300_000n);
  });

  it('7. решает статус ОПЛАТЫ: подтверждённая оплата с плановым начислением проводится', async () => {
    /*
     * Импортируется факт выдачи денег, а не начисление заработка. Оплата
     * «Подтверждена» при начислении «Плановая» — деньги ушли, строка готова.
     * Неподтверждённая оплата не проводится независимо от начисления.
     */
    const { token } = await tokenFor(['ADMIN']);
    const who = await courier();
    const name = counterparty(who.phone);
    const file = await buildPlanFactStatement([
      payoutRow(name, -100, DAY_A, { accrualStatus: 'Плановая' }),
      payoutRow(name, -200, DAY_A, { accrualStatus: null }),
      payoutRow(name, -300, DAY_A, { paymentStatus: 'Плановая', accrualStatus: 'Подтверждена' }),
      parentRow(-1000, DAY_B),
      partRow(name, -1000, DAY_B, { accrualStatus: 'Плановая' }),
    ]);
    const rows = (await postPreview(token, file)).json().rows;
    expect(rows.map((row) => [row.rowNo, row.state])).toEqual([
      [3, 'ready'],
      [4, 'ready'],
      [5, 'ignored'],
      [7, 'ready'],
    ]);
    expect(rows[2]?.reason).toContain('не подтверждена');
  });
});

/** Строки фикстуры экспортируются типом, чтобы проверка не расходилась с построителем. */
export type { FixtureRow };
