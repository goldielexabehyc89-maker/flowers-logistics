/**
 * Касса логиста: фактические наличные у конкретного человека.
 *
 * Одна фактическая передача денег существует на ДВУХ сторонах — долг курьера
 * и касса логиста — и записывается одной транзакцией с общим идентификатором
 * передачи. Иначе деньги однажды окажутся посчитанными дважды или потеряются
 * между двумя половинами операции.
 *
 * Отрицательный остаток запрещён. Это правило о последовательности записей,
 * а не об одной строке, поэтому проверяется под блокировкой владельца кассы:
 * две одновременные выдачи не смогут вместе превысить остаток.
 *
 * Дополнительные расходы курьера кассы НЕ трогают: они уменьшают сумму,
 * которую курьер должен сдать, но наличные при этом никуда не двигаются.
 */

import { randomUUID } from 'node:crypto';
import type { LogistCashKind, Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import { fromDateColumn, toDateColumn } from '../integrations/moysklad/delivery-date.js';

/** Виды, увеличивающие наличные в кассе логиста. */
const INCOMING: readonly LogistCashKind[] = ['RECEIVED_FROM_COURIER', 'TAKEN_FROM_COMPANY'];

export interface CashEntryView {
  id: string;
  logistUserId: string;
  kind: LogistCashKind;
  amountMinor: string;
  operationDate: string;
  occurredAt: string;
  actorUserId: string;
  actorName: string | null;
  courierUserId: string | null;
  courierName: string | null;
  transferId: string | null;
  reason: string | null;
  reversesEntryId: string | null;
  reversed: boolean;
}

/**
 * Знак движения по виду операции.
 *
 * Вызывающий код передаёт величину, а не знак: одна и та же выдача не имеет
 * права оказаться то приходом, то расходом.
 */
export function signedCash(kind: LogistCashKind, amountMinor: bigint): bigint {
  const value = amountMinor < 0n ? -amountMinor : amountMinor;
  return INCOMING.includes(kind) ? value : -value;
}

const SELECT = {
  id: true,
  logistUserId: true,
  kind: true,
  amountMinor: true,
  operationDate: true,
  occurredAt: true,
  actorUserId: true,
  courierUserId: true,
  transferId: true,
  reason: true,
  reversesEntryId: true,
  actor: { select: { fullName: true } },
  courier: { select: { fullName: true } },
  reversedBy: { select: { id: true } },
} as const;

type CashRow = {
  id: string;
  logistUserId: string;
  kind: LogistCashKind;
  amountMinor: bigint;
  operationDate: Date;
  occurredAt: Date;
  actorUserId: string;
  courierUserId: string | null;
  transferId: string | null;
  reason: string | null;
  reversesEntryId: string | null;
  actor: { fullName: string } | null;
  courier: { fullName: string } | null;
  reversedBy: { id: string } | null;
};

export function toCashView(row: CashRow): CashEntryView {
  return {
    id: row.id,
    logistUserId: row.logistUserId,
    kind: row.kind,
    amountMinor: row.amountMinor.toString(),
    operationDate: fromDateColumn(row.operationDate),
    occurredAt: row.occurredAt.toISOString(),
    actorUserId: row.actorUserId,
    actorName: row.actor?.fullName ?? null,
    courierUserId: row.courierUserId,
    courierName: row.courier?.fullName ?? null,
    transferId: row.transferId,
    reason: row.reason,
    reversesEntryId: row.reversesEntryId,
    reversed: row.reversedBy !== null,
  };
}

/** Остаток кассы на конец дня включительно. `null` — по всем записям. */
export async function cashBalanceOf(
  db: Database | TransactionClient,
  logistUserId: string,
  toDate: string | null,
): Promise<bigint> {
  const result = await db.logistCashEntry.aggregate({
    where: {
      logistUserId,
      ...(toDate === null ? {} : { operationDate: { lte: toDateColumn(toDate) } }),
    },
    _sum: { amountMinor: true },
  });
  return result._sum.amountMinor ?? 0n;
}

/**
 * Блокировка владельца кассы на время операции.
 *
 * Без неё две параллельные выдачи прочитали бы один и тот же остаток и обе
 * прошли бы проверку, оставив кассу в минусе.
 */
async function lockDesk(tx: TransactionClient, logistUserId: string): Promise<void> {
  await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${logistUserId}::uuid FOR UPDATE`;
}

export interface CashEntryInput {
  logistUserId: string;
  kind: LogistCashKind;
  /** Положительная величина: знак ставит сам модуль. */
  amountMinor: bigint;
  operationDate: string;
  actorUserId: string;
  courierUserId?: string | null;
  transferId?: string | null;
  reason?: string | null;
  idempotencyKey: string;
}

/**
 * Добавление движения кассы.
 *
 * Повтор с тем же ключом возвращает уже созданную запись: повторное нажатие
 * не удваивает деньги. Расход проверяется по остатку под блокировкой.
 */
export async function appendCash(
  tx: TransactionClient,
  input: CashEntryInput,
): Promise<CashEntryView> {
  const existing = await tx.logistCashEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: SELECT,
  });
  if (existing !== null) {
    return toCashView(existing);
  }

  await lockDesk(tx, input.logistUserId);

  const amount = signedCash(input.kind, input.amountMinor);
  if (amount < 0n) {
    const balance = await cashBalanceOf(tx, input.logistUserId, null);
    if (balance + amount < 0n) {
      throw new AppError('CONFLICT', {
        message: 'cash desk would go negative',
        publicMessage:
          'В кассе недостаточно наличных. Сначала возьмите деньги из компании, потом выдавайте.',
        conflict: { kind: 'CASH_DESK_INSUFFICIENT' },
      });
    }
  }

  try {
    const created = await tx.logistCashEntry.create({
      data: {
        logistUserId: input.logistUserId,
        kind: input.kind,
        amountMinor: amount,
        operationDate: toDateColumn(input.operationDate),
        actorUserId: input.actorUserId,
        courierUserId: input.courierUserId ?? null,
        transferId: input.transferId ?? null,
        reason: input.reason ?? null,
        idempotencyKey: input.idempotencyKey,
      },
      select: SELECT,
    });
    return toCashView(created);
  } catch (error) {
    // Гонка одинаковых запросов: победил другой — отдаём его запись.
    if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
      const row = await tx.logistCashEntry.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: SELECT,
      });
      if (row !== null) {
        return toCashView(row);
      }
    }
    throw error;
  }
}

/**
 * Обратная операция кассы.
 *
 * Исходная запись остаётся: создаётся связанная запись с обратной суммой
 * и обязательной причиной. Отменить одну запись можно только один раз —
 * это закрыто уникальным индексом, а не проверкой в коде.
 */
export async function reverseCash(
  tx: TransactionClient,
  input: { entryId: string; actorUserId: string; reason: string; operationDate: string },
): Promise<CashEntryView> {
  const source = await tx.logistCashEntry.findUnique({
    where: { id: input.entryId },
    select: SELECT,
  });
  if (source === null) {
    throw new AppError('NOT_FOUND', { publicMessage: 'Операция кассы не найдена.' });
  }
  if (source.kind === 'ADJUSTMENT') {
    throw new AppError('CONFLICT', {
      publicMessage: 'Корректировку нельзя отменить: заведите новую операцию с причиной.',
    });
  }
  if (source.reversedBy !== null) {
    throw new AppError('CONFLICT', { publicMessage: 'Эта операция кассы уже отменена.' });
  }

  await lockDesk(tx, source.logistUserId);

  // Отмена прихода уносит деньги из кассы: она тоже не имеет права увести её в минус.
  if (source.amountMinor > 0n) {
    const balance = await cashBalanceOf(tx, source.logistUserId, null);
    if (balance - source.amountMinor < 0n) {
      throw new AppError('CONFLICT', {
        message: 'cash desk would go negative',
        publicMessage: 'Этих денег в кассе уже нет: отмена увела бы остаток в минус.',
        conflict: { kind: 'CASH_DESK_INSUFFICIENT' },
      });
    }
  }

  const created = await tx.logistCashEntry.create({
    data: {
      logistUserId: source.logistUserId,
      kind: 'ADJUSTMENT',
      amountMinor: -source.amountMinor,
      operationDate: toDateColumn(input.operationDate),
      actorUserId: input.actorUserId,
      courierUserId: source.courierUserId,
      transferId: source.transferId,
      reason: input.reason,
      reversesEntryId: source.id,
      idempotencyKey: `cash-reversal:${source.id}`,
    },
    select: SELECT,
  });

  return toCashView(created);
}

/** Новый идентификатор передачи: одна передача — одно значение на две стороны. */
export function newTransferId(): string {
  return randomUUID();
}
