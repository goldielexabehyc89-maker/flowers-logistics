/**
 * Импорт выплат курьерам из выписки ПланФакта.
 *
 * Выплата по банковской выписке ложится в журнал курьера тем же видом, что и
 * выдача наличных логистом — `CASH_ISSUED_TO_COURIER`: для расчёта с курьером
 * это одно и то же — деньги, которые он получил, и долг перед компанией растёт
 * на ту же сумму. Но кассы у выплаты НЕТ: деньги ушли с расчётного счёта, а не
 * из наличных логиста, поэтому `LogistCashEntry` не создаётся и ничья касса —
 * ни загрузившего, ни логиста — не меняется. Источник записи виден по ссылке
 * на импорт, а не угадывается по тексту пояснения.
 *
 * ДВА ШАГА, ОДНА ОЦЕНКА. Предпросмотр и подтверждение считают строки ОДНОЙ
 * функцией: предпросмотр ничего не пишет, а подтверждение заново разбирает
 * файл, заново сопоставляет курьеров и заново проверяет повторы уже внутри
 * транзакции под блокировкой файла. Поэтому решение принимается по состоянию
 * базы в момент записи, а не по картинке, которую человек видел минуту назад.
 *
 * ПОВТОРЫ. У выплаты в выписке нет своего идентификатора, поэтому
 * «тот же курьер, день и сумма» повтором НЕ считается: две одинаковые выплаты
 * за день бывают. Повтор доказывается только содержимым файла: ключ записи —
 * хеш файла и номер строки, и тот же файл под любым именем узнаётся по нему.
 * Совпадение по курьеру, дню и сумме с уже проведённой записью показывается
 * ОТДЕЛЬНО как возможный повтор и не проводится без явного решения
 * администратора по конкретной строке.
 */

import { createHash } from 'node:crypto';
import { tryNormalizePhone, type Role } from '@fl/shared';
import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import { writeAudit } from '../audit/service.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { appendLedgerEntry } from './ledger.js';
import {
  parsePlanFactStatement,
  type ParsedStatement,
  type StatementPayout,
} from './planfact-statement.js';

/** Что читает оценка: и клиент базы, и транзакция. */
type Reader = TransactionClient;

export type PayoutRowState =
  'ready' | 'error' | 'already_imported' | 'possible_duplicate' | 'ignored';

export interface PayoutDuplicate {
  entryId: string;
  operationDate: string;
  amountMinor: string;
  /** Откуда взялась похожая запись: из другой выписки или заведена вручную. */
  source: 'import' | 'manual';
  fileName: string | null;
}

export interface PayoutPreviewRow {
  rowNo: number;
  parentRowNo: number | null;
  /** Контрагент так, как он написан в файле. Только для показа: в базу не пишется. */
  counterparty: string | null;
  /** Распознанный телефон в нормальном виде `+7XXXXXXXXXX`. */
  phone: string | null;
  courier: { id: string; fullName: string } | null;
  operationDate: string | null;
  /** Сумма к проведению — положительные копейки. */
  amountMinor: string | null;
  state: PayoutRowState;
  reason: string | null;
  /** Уже проведённая запись этой самой строки файла. */
  existingEntryId: string | null;
  duplicates: PayoutDuplicate[];
}

export interface PayoutSummary {
  total: number;
  ready: number;
  readyTotalMinor: string;
  possibleDuplicates: number;
  possibleDuplicatesTotalMinor: string;
  alreadyImported: number;
  errors: number;
  ignored: number;
}

export interface PayoutPreview {
  fileName: string;
  fileSha256: string;
  sheetName: string;
  lineCount: number;
  /** Родительские строки, разбитые на части: сами не проводятся. */
  containers: number[];
  rows: PayoutPreviewRow[];
  summary: PayoutSummary;
}

export interface PayoutImportSummary {
  id: string;
  fileName: string;
  fileSha256: string;
  createdAt: string;
  rowCount: number;
  postedCount: number;
  skippedCount: number;
  postedTotalMinor: string;
  uploadedBy: { id: string; fullName: string } | null;
}

export interface PostedRow {
  rowNo: number;
  courier: { id: string; fullName: string } | null;
  operationDate: string;
  amountMinor: string;
  entryId: string;
}

export interface SkippedRow {
  rowNo: number;
  state: PayoutRowState;
  reason: string | null;
}

export interface PayoutImportResult {
  /** `null`, когда проводить было нечего: импорт без записей не создаётся. */
  import: PayoutImportSummary | null;
  posted: PostedRow[];
  skipped: SkippedRow[];
}

/** Исход строки, как он хранится в импорте. Без имён и телефонов. */
interface StoredOutcome {
  rowNo: number;
  parentRowNo: number | null;
  state: PayoutRowState;
  reason: string | null;
  courierUserId: string | null;
  operationDate: string | null;
  amountMinor: string | null;
  entryId: string | null;
}

const SALARY_ARTICLE = 'заработная плата курьеров';
const PAYOUT_TYPE = 'выплата';
const RUBLE_CODES = new Set(['rub', 'rur', 'руб', 'руб.', '₽', 'р.', 'р']);

/** Основание записи в журнале — одно на все выплаты из выписок. */
export const PAYOUT_IMPORT_REASON = 'Выплата по выписке ПланФакт';

export function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Ключ идемпотентности строки: тот же файл под другим именем даёт тот же ключ. */
export function payoutRowKey(fileSha256: string, rowNo: number): string {
  return `payout-import:${fileSha256}:${rowNo}`;
}

/*
 * Кандидат в телефон: цифры с допустимыми разделителями, не короче десяти
 * знаков. Скобки, дефисы, точки и пробелы внутри разрешены — так люди и пишут
 * номера в названии контрагента.
 */
const PHONE_CANDIDATE = /\+?\d[\d\s()\-.]{8,}\d/g;

/**
 * Телефон курьера из названия контрагента.
 *
 * Берётся ТОЛЬКО из этого поля: ни по имени, ни по назначению платежа курьер
 * не угадывается. Все формы — `89990001122`, `79990001122`,
 * `+7 (999) 000-11-22`, `8 999 000 11 22`, `9990001122` — приводятся общей
 * нормализацией телефона к `+79990001122`, той же, которой пользуется вход.
 *
 * Два РАЗНЫХ распознанных номера — это не выбор, а причина не проводить строку.
 */
export function phoneOfCounterparty(text: string | null): {
  phone: string | null;
  problem: 'missing' | 'invalid' | 'multiple' | null;
} {
  if (text === null) {
    return { phone: null, problem: 'missing' };
  }
  const found = new Set<string>();
  let sawDigits = false;
  for (const candidate of text.match(PHONE_CANDIDATE) ?? []) {
    sawDigits = true;
    const whole = tryNormalizePhone(candidate);
    if (whole !== null) {
      found.add(whole);
      continue;
    }
    /*
     * Соседний числовой реквизит (ИНН, счёт) склеивается с телефоном пробелом
     * в одного кандидата. Тогда номер ищется по отдельным словам.
     */
    for (const token of candidate.split(/\s+/)) {
      const single = tryNormalizePhone(token);
      if (single !== null) {
        found.add(single);
      }
    }
  }
  if (found.size === 0) {
    return { phone: null, problem: sawDigits ? 'invalid' : 'missing' };
  }
  if (found.size > 1) {
    return { phone: null, problem: 'multiple' };
  }
  return { phone: [...found][0] ?? null, problem: null };
}

function lower(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function isRubles(currency: string | null): boolean {
  return RUBLE_CODES.has(lower(currency));
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Строка предпросмотра до сопоставления с базой. */
interface Draft {
  payout: StatementPayout;
  row: PayoutPreviewRow;
  /** Что проверять в базе: заполняется только у строк, прошедших разбор файла. */
  candidate: { phone: string; minor: bigint; date: string } | null;
}

function baseRow(payout: StatementPayout): PayoutPreviewRow {
  return {
    rowNo: payout.rowNo,
    parentRowNo: payout.parentRowNo,
    counterparty: payout.counterparty,
    phone: null,
    courier: null,
    operationDate: payout.paymentDate,
    amountMinor: null,
    state: 'ready',
    reason: null,
    existingEntryId: null,
    duplicates: [],
  };
}

function settle(row: PayoutPreviewRow, state: PayoutRowState, reason: string): PayoutPreviewRow {
  return { ...row, state, reason };
}

/**
 * Разбор строки без обращения к базе: что это за операция и сколько в ней.
 *
 * ПОРЯДОК ПРОВЕРОК НЕ СЛУЧАЕН. Сначала — «это вообще выплата зарплаты
 * курьеру?»: чужая статья, поступление, другая валюта и неподтверждённый
 * статус не ошибки файла, а строки, которых импорт не касается; они
 * показываются как пропущенные. И только у настоящей выплаты проверяются
 * структура группы, сумма, дата и телефон — это уже ошибки, которые человек
 * должен увидеть и исправить в источнике.
 */
function draftOf(payout: StatementPayout): Draft {
  const row = baseRow(payout);

  /*
   * Часть без родительской строки — сломанная структура файла, а не «не
   * выплата»: у неё нет ни даты, ни статуса, и чем она была, неизвестно.
   * Человек должен это увидеть, поэтому — ошибка, а не пропуск.
   */
  if (payout.groupError !== null && payout.parentRowNo === null) {
    return { payout, row: settle(row, 'error', payout.groupError), candidate: null };
  }

  if (lower(payout.type) !== PAYOUT_TYPE) {
    return {
      payout,
      row: settle(row, 'ignored', `тип «${payout.type ?? '—'}» — не выплата`),
      candidate: null,
    };
  }
  if (lower(payout.article) !== SALARY_ARTICLE) {
    return {
      payout,
      row: settle(
        row,
        'ignored',
        `статья «${payout.article ?? '—'}» — не «Заработная плата курьеров»`,
      ),
      candidate: null,
    };
  }
  if (!isRubles(payout.currency)) {
    return {
      payout,
      row: settle(row, 'ignored', `валюта «${payout.currency ?? '—'}» — не рубли`),
      candidate: null,
    };
  }
  if (!payout.confirmed) {
    return {
      payout,
      row: settle(
        row,
        'ignored',
        `статус «${payout.unconfirmedStatus ?? '—'}» — выплата не подтверждена`,
      ),
      candidate: null,
    };
  }

  if (payout.groupError !== null) {
    return { payout, row: settle(row, 'error', payout.groupError), candidate: null };
  }
  if (payout.amountInvalid || payout.amountMinor === null) {
    return { payout, row: settle(row, 'error', 'сумма не распознана'), candidate: null };
  }
  if (payout.amountMinor === 0n) {
    return { payout, row: settle(row, 'error', 'нулевая сумма'), candidate: null };
  }
  /*
   * Выплата в выписке — расход, то есть минус. Плюс у «выплаты» — это возврат
   * или ошибка учёта, и выдачей курьеру он не становится: модуль здесь не
   * берётся, знак разбирается явно.
   */
  if (payout.amountMinor > 0n) {
    return {
      payout,
      row: settle(row, 'error', 'сумма выплаты положительная — выдачей курьеру не считается'),
      candidate: null,
    };
  }
  const minor = -payout.amountMinor;
  const withAmount = { ...row, amountMinor: minor.toString() };

  if (payout.paymentDateInvalid) {
    return {
      payout,
      row: settle(withAmount, 'error', 'дата оплаты не распознана'),
      candidate: null,
    };
  }
  if (payout.paymentDate === null) {
    return { payout, row: settle(withAmount, 'error', 'нет даты оплаты'), candidate: null };
  }

  const phone = phoneOfCounterparty(payout.counterparty);
  if (phone.phone === null) {
    const reason =
      phone.problem === 'missing'
        ? 'в контрагенте не указан телефон'
        : phone.problem === 'multiple'
          ? 'в контрагенте несколько разных телефонов'
          : 'телефон в контрагенте не распознан как российский номер';
    return { payout, row: settle(withAmount, 'error', reason), candidate: null };
  }

  return {
    payout,
    row: { ...withAmount, phone: phone.phone },
    candidate: { phone: phone.phone, minor, date: payout.paymentDate },
  };
}

/**
 * Оценка строк выписки по текущему состоянию базы.
 *
 * Одна и та же функция для предпросмотра и подтверждения: у подтверждения
 * она вызывается внутри транзакции под блокировкой файла, и её ответ — это
 * то, что будет записано, а не то, что показывали.
 */
export async function assessStatement(
  reader: Reader,
  parsed: ParsedStatement,
  fileName: string,
  fileSha256: string,
): Promise<PayoutPreview> {
  const drafts = parsed.payouts.map(draftOf);
  const candidates = drafts.filter((draft) => draft.candidate !== null);

  /*
   * Курьеры сопоставляются по телефону, нормализованному ТЕМ ЖЕ правилом, что
   * и телефон из файла. Карточки при этом не меняются: нормализация живёт в
   * памяти сравнения.
   */
  const couriers = await reader.user.findMany({
    where: { roles: { some: { role: 'COURIER' } } },
    select: { id: true, fullName: true, phone: true },
  });
  const couriersByPhone = new Map<string, { id: string; fullName: string }[]>();
  for (const courier of couriers) {
    const phone = tryNormalizePhone(courier.phone);
    if (phone === null) {
      continue;
    }
    couriersByPhone.set(phone, [
      ...(couriersByPhone.get(phone) ?? []),
      { id: courier.id, fullName: courier.fullName },
    ]);
  }

  const phones = [...new Set(candidates.map((draft) => draft.candidate?.phone ?? ''))].filter(
    (phone) => phone !== '',
  );
  const anyUsers = new Set(
    (
      await reader.user.findMany({
        where: { phone: { in: phones } },
        select: { phone: true },
      })
    ).map((user) => user.phone),
  );

  // Своя же строка файла, уже проведённая раньше.
  const keys = candidates.map((draft) => payoutRowKey(fileSha256, draft.row.rowNo));
  const existingByKey = new Map(
    (
      await reader.courierLedgerEntry.findMany({
        where: { idempotencyKey: { in: keys } },
        select: { id: true, idempotencyKey: true },
      })
    ).map((entry) => [entry.idempotencyKey, entry.id]),
  );

  const matched: {
    draft: Draft;
    courier: { id: string; fullName: string };
    minor: bigint;
    date: string;
  }[] = [];
  const rows: PayoutPreviewRow[] = [];

  for (const draft of drafts) {
    if (draft.candidate === null) {
      rows.push(draft.row);
      continue;
    }
    const found = couriersByPhone.get(draft.candidate.phone) ?? [];
    if (found.length === 0) {
      rows.push(
        settle(
          draft.row,
          'error',
          anyUsers.has(draft.candidate.phone)
            ? 'пользователь с этим телефоном есть, но он не курьер'
            : 'курьер с таким телефоном не найден',
        ),
      );
      continue;
    }
    if (found.length > 1) {
      rows.push(settle(draft.row, 'error', 'этому телефону соответствует несколько курьеров'));
      continue;
    }
    const courier = found[0] as { id: string; fullName: string };
    const withCourier = { ...draft.row, courier };

    const existing = existingByKey.get(payoutRowKey(fileSha256, draft.row.rowNo));
    if (existing !== undefined) {
      rows.push({
        ...settle(withCourier, 'already_imported', 'эта строка файла уже проведена'),
        existingEntryId: existing,
      });
      continue;
    }

    rows.push(withCourier);
    matched.push({
      draft: { ...draft, row: withCourier },
      courier,
      minor: draft.candidate.minor,
      date: draft.candidate.date,
    });
  }

  /*
   * Возможные повторы: действующая выдача тому же курьеру в тот же день на ту
   * же сумму. Любая — из другой выписки или заведённая вручную: логист мог
   * записать ту же банковскую выплату руками до появления импорта.
   */
  if (matched.length > 0) {
    const similar = await reader.courierLedgerEntry.findMany({
      where: {
        kind: 'CASH_ISSUED_TO_COURIER',
        courierUserId: { in: [...new Set(matched.map((item) => item.courier.id))] },
        operationDate: { in: [...new Set(matched.map((item) => item.date))].map(toDateColumn) },
        reversedBy: { is: null },
      },
      select: {
        id: true,
        courierUserId: true,
        operationDate: true,
        amountMinor: true,
        idempotencyKey: true,
        payoutImportId: true,
        payoutImport: { select: { fileName: true } },
      },
    });
    const ownKeys = new Set(matched.map((item) => payoutRowKey(fileSha256, item.draft.row.rowNo)));

    for (const item of matched) {
      const duplicates: PayoutDuplicate[] = similar
        .filter(
          (entry) =>
            entry.courierUserId === item.courier.id &&
            dayOf(entry.operationDate) === item.date &&
            entry.amountMinor === item.minor &&
            !ownKeys.has(entry.idempotencyKey),
        )
        .map((entry) => ({
          entryId: entry.id,
          operationDate: dayOf(entry.operationDate),
          amountMinor: entry.amountMinor.toString(),
          source: entry.payoutImportId === null ? 'manual' : 'import',
          fileName: entry.payoutImport?.fileName ?? null,
        }));
      if (duplicates.length === 0) {
        continue;
      }
      const index = rows.findIndex((row) => row.rowNo === item.draft.row.rowNo);
      const row = rows[index];
      if (row !== undefined) {
        rows[index] = {
          ...settle(
            row,
            'possible_duplicate',
            duplicates.some((duplicate) => duplicate.source === 'import')
              ? 'такая же выплата уже проведена из другой выписки'
              : 'такая же выдача уже заведена вручную',
          ),
          duplicates,
        };
      }
    }
  }

  rows.sort((left, right) => left.rowNo - right.rowNo);

  const sumOf = (state: PayoutRowState): bigint =>
    rows
      .filter((row) => row.state === state)
      .reduce((total, row) => total + BigInt(row.amountMinor ?? '0'), 0n);
  const countOf = (state: PayoutRowState): number =>
    rows.filter((row) => row.state === state).length;

  return {
    fileName,
    fileSha256,
    sheetName: parsed.sheetName,
    lineCount: parsed.lineCount,
    containers: parsed.containers.map((container) => container.rowNo),
    rows,
    summary: {
      total: rows.length,
      ready: countOf('ready'),
      readyTotalMinor: sumOf('ready').toString(),
      possibleDuplicates: countOf('possible_duplicate'),
      possibleDuplicatesTotalMinor: sumOf('possible_duplicate').toString(),
      alreadyImported: countOf('already_imported'),
      errors: countOf('error'),
      ignored: countOf('ignored'),
    },
  };
}

/** Предпросмотр: разбор и оценка без единой записи в базу. */
export async function previewPayoutImport(
  db: Database,
  input: { fileName: string; content: Buffer },
): Promise<PayoutPreview> {
  const parsed = await parsePlanFactStatement(input.content);
  return assessStatement(db, parsed, input.fileName, sha256Of(input.content));
}

export interface ConfirmPayoutImportInput {
  actor: { userId: string; roles: readonly Role[] };
  fileName: string;
  content: Buffer;
  idempotencyKey: string;
  /** Строки-возможные повторы, которые администратор решил провести. */
  acceptRows: readonly number[];
  context: { ip: string | null; userAgent: string | null };
}

const summaryOf = (
  batch: {
    id: string;
    fileName: string;
    fileSha256: string;
    createdAt: Date;
    rowCount: number;
    postedCount: number;
    skippedCount: number;
    postedTotalMinor: bigint;
    uploadedBy?: { id: string; fullName: string } | null;
  },
  uploadedBy: { id: string; fullName: string } | null,
): PayoutImportSummary => ({
  id: batch.id,
  fileName: batch.fileName,
  fileSha256: batch.fileSha256,
  createdAt: batch.createdAt.toISOString(),
  rowCount: batch.rowCount,
  postedCount: batch.postedCount,
  skippedCount: batch.skippedCount,
  postedTotalMinor: batch.postedTotalMinor.toString(),
  uploadedBy,
});

/** Результат уже сохранённого импорта — для повтора запроса и для карточки импорта. */
async function resultOfStored(
  reader: Reader,
  batch: {
    id: string;
    fileName: string;
    fileSha256: string;
    createdAt: Date;
    rowCount: number;
    postedCount: number;
    skippedCount: number;
    postedTotalMinor: bigint;
    rows: unknown;
    uploadedBy: { id: string; fullName: string } | null;
  },
): Promise<PayoutImportResult> {
  const outcomes = Array.isArray(batch.rows) ? (batch.rows as StoredOutcome[]) : [];
  const courierIds = [
    ...new Set(outcomes.map((outcome) => outcome.courierUserId).filter((id) => id !== null)),
  ] as string[];
  const names = new Map(
    (
      await reader.user.findMany({
        where: { id: { in: courierIds } },
        select: { id: true, fullName: true },
      })
    ).map((user) => [user.id, user.fullName]),
  );

  return {
    import: summaryOf(batch, batch.uploadedBy),
    posted: outcomes
      .filter((outcome) => outcome.entryId !== null)
      .map((outcome) => ({
        rowNo: outcome.rowNo,
        courier:
          outcome.courierUserId === null
            ? null
            : { id: outcome.courierUserId, fullName: names.get(outcome.courierUserId) ?? '—' },
        operationDate: outcome.operationDate ?? '',
        amountMinor: outcome.amountMinor ?? '0',
        entryId: outcome.entryId ?? '',
      })),
    skipped: outcomes
      .filter((outcome) => outcome.entryId === null)
      .map((outcome) => ({ rowNo: outcome.rowNo, state: outcome.state, reason: outcome.reason })),
  };
}

const BATCH_INCLUDE = { uploadedBy: { select: { id: true, fullName: true } } } as const;

/**
 * Подтверждение импорта: единственное место, где выписка становится записями.
 *
 * Внутри одной транзакции под блокировкой по хешу файла: файл разбирается и
 * оценивается заново, проводятся только строки «готово» и явно принятые
 * администратором «возможные повторы», каждая — своим ключом строки. Повтор
 * запроса с тем же ключом подтверждения возвращает тот же импорт; тот же файл
 * с другим ключом ничего не добавляет — строки уже проведены и распознаются
 * по своим ключам.
 */
export async function confirmPayoutImport(
  db: Database,
  input: ConfirmPayoutImportInput,
): Promise<PayoutImportResult> {
  const fileSha256 = sha256Of(input.content);
  const parsed = await parsePlanFactStatement(input.content);

  const conflict = (): never => {
    throw new AppError('CONFLICT', {
      publicMessage: 'Этот ключ подтверждения уже использован для другого файла.',
    });
  };

  // Быстрый путь повтора — без транзакции и блокировки.
  const known = await db.courierPayoutImport.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: BATCH_INCLUDE,
  });
  if (known !== null) {
    return known.fileSha256 === fileSha256 ? resultOfStored(db, known) : conflict();
  }

  try {
    return await db.$transaction(
      async (tx) => {
        /*
         * Один файл — одна очередь. Два подтверждения одной выписки (двойное
         * нажатие, повтор сети, две вкладки) выполняются строго по очереди:
         * второе видит записи первого и не проводит ничего.
         */
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout-import:${fileSha256}`})::bigint)`;

        const replay = await tx.courierPayoutImport.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          include: BATCH_INCLUDE,
        });
        if (replay !== null) {
          return replay.fileSha256 === fileSha256 ? resultOfStored(tx, replay) : conflict();
        }

        const preview = await assessStatement(tx, parsed, input.fileName, fileSha256);
        const accepted = new Set(input.acceptRows);

        const toPost = preview.rows.filter(
          (row) =>
            row.courier !== null &&
            row.amountMinor !== null &&
            row.operationDate !== null &&
            (row.state === 'ready' ||
              (row.state === 'possible_duplicate' && accepted.has(row.rowNo))),
        );
        const skipped: SkippedRow[] = preview.rows
          .filter((row) => !toPost.includes(row))
          .map((row) => ({
            rowNo: row.rowNo,
            state: row.state,
            reason:
              row.state === 'possible_duplicate'
                ? `${row.reason ?? 'возможный повтор'}; строка не принята явно`
                : row.reason,
          }));

        if (toPost.length === 0) {
          return { import: null, posted: [], skipped };
        }

        const postedTotal = toPost.reduce(
          (total, row) => total + BigInt(row.amountMinor ?? '0'),
          0n,
        );
        const outcomes: StoredOutcome[] = preview.rows.map((row) => ({
          rowNo: row.rowNo,
          parentRowNo: row.parentRowNo,
          state: row.state,
          reason: toPost.includes(row)
            ? null
            : (skipped.find((item) => item.rowNo === row.rowNo)?.reason ?? row.reason),
          courierUserId: row.courier?.id ?? null,
          operationDate: row.operationDate,
          amountMinor: row.amountMinor,
          entryId: null,
        }));

        const batch = await tx.courierPayoutImport.create({
          data: {
            fileName: input.fileName,
            fileSha256,
            uploadedById: input.actor.userId,
            idempotencyKey: input.idempotencyKey,
            rowCount: preview.rows.length,
            postedCount: toPost.length,
            skippedCount: preview.rows.length - toPost.length,
            postedTotalMinor: postedTotal,
            // Исходы дописываются ниже, когда известны идентификаторы записей.
            rows: [],
          },
          include: BATCH_INCLUDE,
        });

        const posted: PostedRow[] = [];
        for (const row of toPost) {
          const { entry, created } = await appendLedgerEntry(tx, {
            courierUserId: row.courier?.id ?? '',
            kind: 'CASH_ISSUED_TO_COURIER',
            amountMinor: BigInt(row.amountMinor ?? '0'),
            operationDate: row.operationDate ?? '',
            actorUserId: input.actor.userId,
            reason: PAYOUT_IMPORT_REASON,
            comment: `Файл «${input.fileName}», строка ${row.rowNo}`,
            payoutImportId: batch.id,
            idempotencyKey: payoutRowKey(fileSha256, row.rowNo),
          });
          /*
           * Под блокировкой файла чужой записи с ключом этой строки быть не
           * может: оценка только что её не нашла. Если она всё же есть, база
           * изменилась мимо очереди — запись не наша, и импорт откатывается
           * целиком, чтобы не приписать чужую запись этому файлу.
           */
          if (!created) {
            throw new AppError('CONFLICT', {
              message: 'payout row already posted outside the import lock',
              publicMessage: 'Строка выписки уже проведена параллельно. Повторите загрузку.',
            });
          }
          posted.push({
            rowNo: row.rowNo,
            courier: row.courier,
            operationDate: entry.operationDate,
            amountMinor: entry.amountMinor,
            entryId: entry.id,
          });
          const outcome = outcomes.find((item) => item.rowNo === row.rowNo);
          if (outcome !== undefined) {
            outcome.entryId = entry.id;
            outcome.state = row.state;
          }
        }

        await tx.courierPayoutImport.update({
          where: { id: batch.id },
          data: { rows: outcomes as unknown as Prisma.InputJsonValue },
        });

        await writeAudit(tx, {
          action: 'FINANCE_PAYOUT_IMPORTED',
          entityType: 'CourierPayoutImport',
          entityId: batch.id,
          actorUserId: input.actor.userId,
          actorRoles: input.actor.roles,
          // Ни имён контрагентов, ни телефонов: хеш файла, счётчики и идентификаторы.
          newValue: {
            fileSha256,
            rowCount: preview.rows.length,
            postedCount: posted.length,
            skippedCount: skipped.length,
            postedTotalMinor: postedTotal.toString(),
            entryIds: posted.map((row) => row.entryId),
          },
          ip: input.context.ip,
          userAgent: input.context.userAgent,
        });

        const earliest = posted.map((row) => row.operationDate).sort()[0] ?? null;
        await publishRealtimeEvent(tx, {
          topic: 'finance.ledger_changed',
          payload: { operationDate: earliest },
          audienceRoles: ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'],
        });

        return {
          import: summaryOf(
            { ...batch, postedCount: posted.length, skippedCount: skipped.length },
            batch.uploadedBy,
          ),
          posted,
          skipped,
        };
      },
      { timeout: 60_000, maxWait: 15_000 },
    );
  } catch (error) {
    /*
     * Тот же ключ подтверждения пришёл одновременно с ДРУГИМ файлом: очереди у
     * разных файлов разные, и уникальность ключа срабатывает на вставке.
     */
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await db.courierPayoutImport.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: BATCH_INCLUDE,
      });
      if (winner !== null) {
        return winner.fileSha256 === fileSha256 ? resultOfStored(db, winner) : conflict();
      }
    }
    throw error;
  }
}

/** Последние импорты — для истории загрузок на экране. */
export async function listPayoutImports(
  db: Database,
  limit: number,
): Promise<PayoutImportSummary[]> {
  const batches = await db.courierPayoutImport.findMany({
    orderBy: [{ createdAt: 'desc' }],
    take: limit,
    include: BATCH_INCLUDE,
  });
  return batches.map((batch) => summaryOf(batch, batch.uploadedBy));
}

/** Карточка импорта: итоги и исход каждой строки. */
export async function payoutImportById(
  db: Database,
  id: string,
): Promise<PayoutImportResult | null> {
  const batch = await db.courierPayoutImport.findUnique({ where: { id }, include: BATCH_INCLUDE });
  return batch === null ? null : resultOfStored(db, batch);
}
