/**
 * Финансовый учёт курьера.
 *
 * Одно правило знака на весь модуль: ПЛЮС увеличивает долг курьера компании,
 * МИНУС уменьшает. Наличные, полученные курьером, и деньги, выданные ему,
 * идут в плюс; оплата работы, километры, расходы и сдача логисту — в минус.
 * Баланс накопительный: это просто сумма всех записей курьера.
 *
 * Записи неизменяемы. Ошибка исправляется обратной записью, которая ссылается
 * на исходную; исходную запись можно отменить только один раз — это закрыто
 * уникальным индексом, а не проверкой в коде.
 *
 * Повторный запрос не создаёт вторую запись: у каждой операции есть ключ
 * идемпотентности. При гонке двух одинаковых запросов выживает первый, второй
 * получает ту же запись в ответ.
 */

import type { LedgerReversalCause, CourierLedgerKind } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';

/** Виды, увеличивающие долг курьера компании. */
const POSITIVE_KINDS: readonly CourierLedgerKind[] = [
  'CASH_RECEIVED',
  'CASH_ISSUED_TO_COURIER',
  // Долг до перехода на ERP — это долг курьера компании, поэтому плюс. Он не
  // наличные и не оплата работы: в денежные и расходные итоги отчёта не входит.
  'OPENING_DEBT',
];

/** Расходы: отдельный список нужен и отчёту, и проверке прав. */
export const EXPENSE_KINDS: readonly CourierLedgerKind[] = [
  'EXPENSE_PARKING',
  'EXPENSE_TOLL',
  'EXPENSE_TRANSIT',
  'EXPENSE_REPAIR',
  'EXPENSE_LOADING',
  'EXPENSE_OTHER',
];

/** Операции, которые заводит человек, а не система. */
export const MANUAL_KINDS: readonly CourierLedgerKind[] = [
  'CASH_HANDED_TO_LOGIST',
  'CASH_ISSUED_TO_COURIER',
  'BONUS',
  'ATTEMPT_FEE',
  ...EXPENSE_KINDS,
];

export interface LedgerEntryInput {
  courierUserId: string;
  kind: CourierLedgerKind;
  /** Всегда положительная величина операции: знак ставит сам модуль. */
  amountMinor: bigint;
  operationDate: string;
  actorUserId: string;
  reason?: string | null;
  comment?: string | null;
  routeId?: string | null;
  orderId?: string | null;
  attemptId?: string | null;
  /** Километры, по которым начислена оплата за МКАД. Только у `DISTANCE_FEE`. */
  distanceKmTenths?: number | null;
  /** Общая передача: та же операция на стороне кассы логиста. */
  transferId?: string | null;
  idempotencyKey: string;
}

export interface LedgerEntryView {
  id: string;
  courierUserId: string;
  kind: CourierLedgerKind;
  amountMinor: string;
  operationDate: string;
  occurredAt: string;
  actorUserId: string;
  /** Имя автора для журнала: логист должен видеть, кто провёл операцию. */
  actorName: string | null;
  reason: string | null;
  comment: string | null;
  routeId: string | null;
  orderId: string | null;
  attemptId: string | null;
  /** Километры, по которым начислена оплата за МКАД. `null` у прежних записей. */
  distanceKmTenths: number | null;
  /** Километры ОТМЕНЯЕМОЙ записи — у обратной. Нужны, чтобы отмена вычитала их. */
  reversesDistanceKmTenths: number | null;
  reversesEntryId: string | null;
  /**
   * Вид отменяемой записи: по нему журнал называет обратную операцию своими
   * словами («Отмена начального долга»), а не общей «корректировкой».
   */
  reversesKind: CourierLedgerKind | null;
  /** Та же передача на стороне кассы логиста. */
  transferId: string | null;
  reversed: boolean;
}

/**
 * Знак операции по её виду.
 *
 * Вызывающий код передаёт величину, а не знак: иначе один и тот же расход
 * в разных местах однажды оказался бы с разным знаком, и баланс перестал бы
 * что-либо значить.
 */
export function signedAmount(kind: CourierLedgerKind, amountMinor: bigint): bigint {
  const value = amountMinor < 0n ? -amountMinor : amountMinor;
  return POSITIVE_KINDS.includes(kind) ? value : -value;
}

/** Ключ идемпотентности автоматического начисления: одна попытка — одна запись. */
export function accrualKey(attemptId: string, kind: CourierLedgerKind): string {
  return `attempt:${attemptId}:${kind}`;
}

/** Ключ обратной записи: отмена одной записи возможна ровно один раз. */
export function reversalKey(entryId: string): string {
  return `reversal:${entryId}`;
}

export function toLedgerView(row: {
  id: string;
  courierUserId: string;
  kind: CourierLedgerKind;
  amountMinor: bigint;
  operationDate: Date;
  occurredAt: Date;
  actorUserId: string;
  reason: string | null;
  comment: string | null;
  routeId: string | null;
  orderId: string | null;
  attemptId: string | null;
  distanceKmTenths?: number | null;
  reversesEntryId: string | null;
  reversesEntry?: { kind: CourierLedgerKind; distanceKmTenths?: number | null } | null;
  transferId?: string | null;
  reversedBy?: { id: string } | null;
  actor?: { fullName: string } | null;
}): LedgerEntryView {
  return {
    id: row.id,
    courierUserId: row.courierUserId,
    kind: row.kind,
    amountMinor: row.amountMinor.toString(),
    operationDate: row.operationDate.toISOString().slice(0, 10),
    occurredAt: row.occurredAt.toISOString(),
    actorUserId: row.actorUserId,
    actorName: row.actor?.fullName ?? null,
    reason: row.reason,
    comment: row.comment,
    routeId: row.routeId,
    orderId: row.orderId,
    attemptId: row.attemptId,
    distanceKmTenths: row.distanceKmTenths ?? null,
    reversesEntryId: row.reversesEntryId,
    reversesKind: row.reversesEntry?.kind ?? null,
    reversesDistanceKmTenths: row.reversesEntry?.distanceKmTenths ?? null,
    transferId: row.transferId ?? null,
    reversed: (row.reversedBy ?? null) !== null,
  };
}

/**
 * Что подтягивается к записи журнала в ЛЮБОМ ответе.
 *
 * Один набор на все пути — создание, повтор и чтение победителя гонки. Иначе
 * контракт ответа зависел бы от того, первый это вызов или второй: у свежей
 * отмены не было вида отменяемой операции, а имя автора отсутствовало везде,
 * кроме списка.
 */
const REVERSAL_VIEW = {
  reversedBy: { select: { id: true } },
  reversesEntry: { select: { kind: true, distanceKmTenths: true } },
  actor: { select: { fullName: true } },
} as const;

/**
 * Добавление записи.
 *
 * Идемпотентность обеспечивается уникальным ключом на уровне базы: параллельный
 * повтор получает отказ уникальности, и мы возвращаем уже существующую запись,
 * а не создаём вторую.
 */
/**
 * Результат записи: САМА запись и признак, создала ли её эта транзакция.
 *
 * Без признака повтор неотличим от создания: вызывающий код писал бы аудит и
 * realtime-событие на чужую запись, а запрос с другими данными получал бы
 * «сохранено» о том, что не сохранялось. Предварительным SELECT это не
 * лечится — победитель может зафиксироваться между проверкой и вставкой.
 */
export interface AppendedEntry {
  entry: LedgerEntryView;
  created: boolean;
}

export async function appendLedgerEntry(
  tx: TransactionClient,
  input: LedgerEntryInput,
): Promise<AppendedEntry> {
  if (input.amountMinor === 0n) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: 'Сумма операции не может быть нулевой.',
    });
  }

  const existing = await tx.courierLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: REVERSAL_VIEW,
  });
  if (existing !== null) {
    return { entry: toLedgerView(existing), created: false };
  }

  /*
   * Гонку здесь НЕ разбирают, и это осознанно.
   *
   * Нарушение уникальности переводит транзакцию PostgreSQL в аварийное
   * состояние: любой следующий запрос в ней тоже упадёт, и «дочитать
   * победителя» прямо тут невозможно — прежняя попытка лишь подменяла понятную
   * ошибку уникальности невнятной «transaction aborted». Победитель читается
   * ВЫЗЫВАЮЩИМ кодом после отката, отдельным запросом.
   */
  const created = await tx.courierLedgerEntry.create({
    data: {
      courierUserId: input.courierUserId,
      kind: input.kind,
      amountMinor: signedAmount(input.kind, input.amountMinor),
      operationDate: toDateColumn(input.operationDate),
      actorUserId: input.actorUserId,
      reason: input.reason ?? null,
      comment: input.comment ?? null,
      routeId: input.routeId ?? null,
      orderId: input.orderId ?? null,
      attemptId: input.attemptId ?? null,
      distanceKmTenths: input.distanceKmTenths ?? null,
      transferId: input.transferId ?? null,
      idempotencyKey: input.idempotencyKey,
    },
    include: REVERSAL_VIEW,
  });
  return { entry: toLedgerView(created), created: true };
}

/** Прежний контракт для вызывающих, которым признак создания не нужен. */
export async function appendEntry(
  tx: TransactionClient,
  input: LedgerEntryInput,
): Promise<LedgerEntryView> {
  return (await appendLedgerEntry(tx, input)).entry;
}

/**
 * Обратная корректировка.
 *
 * Не удаляет и не правит исходную запись: создаёт связанную запись с обратной
 * суммой и обязательной причиной. Повторная отмена невозможна — уникальность
 * ссылки закрыта индексом.
 */
export async function reverseLedgerEntry(
  tx: TransactionClient,
  input: {
    entryId: string;
    actorUserId: string;
    reason: string;
    operationDate: string;
    /**
     * ПОЧЕМУ отменяем. Обязателен: повод решает, как запись читают потом.
     *
     * Снятие финансового результата отменённого заказа внешне неотличимо от
     * обычной правки — у обоих все начисления попытки погашены. Пока повод
     * приходилось угадывать по журналу, правка километров новой доставки
     * молча блокировалась отменой, случившейся когда-то по тому же заказу.
     */
    cause: LedgerReversalCause;
  },
): Promise<AppendedEntry> {
  const source = await tx.courierLedgerEntry.findUnique({
    where: { id: input.entryId },
    include: { reversedBy: { select: { id: true } } },
  });
  if (source === null) {
    throw new AppError('NOT_FOUND', { publicMessage: 'Операция не найдена.' });
  }
  if (source.kind === 'ADJUSTMENT') {
    throw new AppError('CONFLICT', {
      publicMessage: 'Корректировку нельзя отменить: заведите новую операцию с причиной.',
    });
  }
  if (source.reversedBy !== null) {
    const existing = await tx.courierLedgerEntry.findUnique({
      where: { idempotencyKey: reversalKey(input.entryId) },
      include: REVERSAL_VIEW,
    });
    if (existing !== null) {
      // Отмена уже есть: её и возвращаем, но НЕ выдаём за новую.
      return { entry: toLedgerView(existing), created: false };
    }
    throw new AppError('CONFLICT', { publicMessage: 'Эта операция уже отменена.' });
  }

  /*
   * Гонка двух отмен одной записи.
   *
   * Обе увидели `reversedBy === null`, уникальность пропускает ровно одну.
   * Победившую запись здесь не читают по той же причине, что и в `appendEntry`:
   * транзакция уже аварийная. Проигравший разбирается после отката — там же,
   * где маршрут решает, каким ответом это считать.
   */
  const created = await tx.courierLedgerEntry.create({
    data: {
      courierUserId: source.courierUserId,
      kind: 'ADJUSTMENT',
      // Обратная сумма: знак уже стоит в исходной записи, поэтому здесь
      // достаточно её отрицания и никакого правила вида не применяется.
      amountMinor: -source.amountMinor,
      operationDate: toDateColumn(input.operationDate),
      actorUserId: input.actorUserId,
      reason: input.reason,
      routeId: source.routeId,
      orderId: source.orderId,
      attemptId: source.attemptId,
      transferId: source.transferId,
      reversesEntryId: source.id,
      reversalCause: input.cause,
      idempotencyKey: reversalKey(source.id),
    },
    include: REVERSAL_VIEW,
  });

  return { entry: toLedgerView(created), created: true };
}

/** Прежний контракт для вызывающих, которым признак создания не нужен. */
export async function reverseEntry(
  tx: TransactionClient,
  input: {
    entryId: string;
    actorUserId: string;
    reason: string;
    operationDate: string;
    cause: LedgerReversalCause;
  },
): Promise<LedgerEntryView> {
  return (await reverseLedgerEntry(tx, input)).entry;
}

/** Баланс курьера на конец дня включительно. `null` — по всем записям. */
export async function balanceOf(
  db: Database,
  courierUserId: string,
  toDate: string | null,
): Promise<bigint> {
  const result = await db.courierLedgerEntry.aggregate({
    where: {
      courierUserId,
      ...(toDate === null ? {} : { operationDate: { lte: toDateColumn(toDate) } }),
    },
    _sum: { amountMinor: true },
  });
  return result._sum.amountMinor ?? 0n;
}

/**
 * Запись по ключу идемпотентности.
 *
 * Нужна ПОСЛЕ отката транзакции: нарушение уникальности переводит транзакцию
 * PostgreSQL в аварийное состояние, и дочитать в ней победившую запись уже
 * нельзя — читать приходится отдельным запросом.
 */
export async function entryByIdempotencyKey(
  db: Database,
  idempotencyKey: string,
): Promise<LedgerEntryView | null> {
  const row = await db.courierLedgerEntry.findUnique({
    where: { idempotencyKey },
    include: REVERSAL_VIEW,
  });
  return row === null ? null : toLedgerView(row);
}

/**
 * Все записи начального долга курьера, включая отменённые.
 *
 * Нужны форме внесения: администратор должен видеть, что долг уже заводили,
 * прежде чем завести его второй раз.
 */
export async function openingDebtsOf(
  db: Database,
  courierUserId: string,
): Promise<LedgerEntryView[]> {
  const rows = await db.courierLedgerEntry.findMany({
    where: { courierUserId, kind: 'OPENING_DEBT' },
    orderBy: [{ operationDate: 'asc' }, { occurredAt: 'asc' }],
    include: {
      reversedBy: { select: { id: true } },
      reversesEntry: { select: { kind: true, distanceKmTenths: true } },
      actor: { select: { fullName: true } },
    },
  });
  return rows.map(toLedgerView);
}

/** Записи периода одного курьера в порядке появления. */
export async function entriesOf(
  db: Database,
  input: { courierUserId?: string | undefined; from: string; to: string },
): Promise<LedgerEntryView[]> {
  const rows = await db.courierLedgerEntry.findMany({
    where: {
      ...(input.courierUserId === undefined ? {} : { courierUserId: input.courierUserId }),
      operationDate: { gte: toDateColumn(input.from), lte: toDateColumn(input.to) },
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    include: {
      reversedBy: { select: { id: true } },
      reversesEntry: { select: { kind: true, distanceKmTenths: true } },
      actor: { select: { fullName: true } },
    },
  });
  return rows.map(toLedgerView);
}
