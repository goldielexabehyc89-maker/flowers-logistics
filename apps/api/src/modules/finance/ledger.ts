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

import type { CourierLedgerKind, Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';

/** Виды, увеличивающие долг курьера компании. */
const POSITIVE_KINDS: readonly CourierLedgerKind[] = ['CASH_RECEIVED', 'CASH_ISSUED_TO_COURIER'];

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
  reversesEntryId: string | null;
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

function toView(row: {
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
  reversesEntryId: string | null;
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
    reversesEntryId: row.reversesEntryId,
    transferId: row.transferId ?? null,
    reversed: (row.reversedBy ?? null) !== null,
  };
}

/**
 * Добавление записи.
 *
 * Идемпотентность обеспечивается уникальным ключом на уровне базы: параллельный
 * повтор получает отказ уникальности, и мы возвращаем уже существующую запись,
 * а не создаём вторую.
 */
export async function appendEntry(
  tx: TransactionClient,
  input: LedgerEntryInput,
): Promise<LedgerEntryView> {
  if (input.amountMinor === 0n) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: 'Сумма операции не может быть нулевой.',
    });
  }

  const existing = await tx.courierLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { reversedBy: { select: { id: true } } },
  });
  if (existing !== null) {
    return toView(existing);
  }

  try {
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
        transferId: input.transferId ?? null,
        idempotencyKey: input.idempotencyKey,
      },
      include: { reversedBy: { select: { id: true } }, actor: { select: { fullName: true } } },
    });
    return toView(created);
  } catch (error) {
    // Гонка двух одинаковых запросов: победил другой — отдаём его запись.
    if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
      const row = await tx.courierLedgerEntry.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: { reversedBy: { select: { id: true } } },
      });
      if (row !== null) {
        return toView(row);
      }
    }
    throw error;
  }
}

/**
 * Обратная корректировка.
 *
 * Не удаляет и не правит исходную запись: создаёт связанную запись с обратной
 * суммой и обязательной причиной. Повторная отмена невозможна — уникальность
 * ссылки закрыта индексом.
 */
export async function reverseEntry(
  tx: TransactionClient,
  input: { entryId: string; actorUserId: string; reason: string; operationDate: string },
): Promise<LedgerEntryView> {
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
      include: { reversedBy: { select: { id: true } } },
    });
    if (existing !== null) {
      return toView(existing);
    }
    throw new AppError('CONFLICT', { publicMessage: 'Эта операция уже отменена.' });
  }

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
      idempotencyKey: reversalKey(source.id),
    },
    include: { reversedBy: { select: { id: true } } },
  });

  return toView(created);
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
      actor: { select: { fullName: true } },
    },
  });
  return rows.map(toView);
}
