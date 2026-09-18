/**
 * Передача наличных между курьером и логистом.
 *
 * Здесь живёт единственное место, где деньги переходят из рук в руки: обе
 * стороны — долг курьера и касса логиста — записываются ОДНОЙ транзакцией
 * с общим идентификатором передачи. Разнести это по двум вызовам значило бы
 * однажды получить принятые деньги, которых нет ни в чьей кассе.
 *
 * Кассой владеет логист. Администратор может провести операцию от имени
 * выбранной кассы, но автором в записях остаётся он сам: у владельца системы
 * собственной кассы не существует.
 */

import type { AuthenticatedActor } from '../auth/guards.js';
import type { TransactionClient } from '../auth/sessions.js';
import { AppError } from '../../platform/errors.js';
import { appendLedgerEntry, reversalKey } from './ledger.js';
import { appendCash, newTransferId, reverseCash } from './cash.js';
import type { CashEntryView } from './cash.js';
import type { LedgerEntryView } from './ledger.js';

/** Что именно передают: курьер сдал логисту или логист выдал курьеру. */
export type TransferKind = 'HANDED_BY_COURIER' | 'ISSUED_TO_COURIER';

export interface TransferInput {
  kind: TransferKind;
  courierUserId: string;
  /** Чья касса участвует. Логист может указать только свою. */
  logistUserId: string;
  amountMinor: bigint;
  operationDate: string;
  idempotencyKey: string;
}

export interface TransferResult {
  courierEntry: LedgerEntryView;
  cashEntry: CashEntryView;
  transferId: string;
  /**
   * Создала ли ЭТА транзакция запись долга курьера.
   *
   * Повтор с тем же ключом отдаёт прежнюю передачу, и аудит с событием
   * тогда писать нельзя: одна операция — одна строка истории.
   */
  created: boolean;
}

/**
 * Владелец кассы для этой операции.
 *
 * Логист работает только со своей кассой — не потому, что чужая недоступна
 * технически, а потому что наличные лежат у конкретного человека, и запись
 * в чужую кассу означала бы деньги, которых у него нет.
 */
export function resolveDeskOwner(actor: AuthenticatedActor, requested: string | undefined): string {
  const isAdmin = actor.roles.includes('ADMIN');
  const isLogist = actor.roles.includes('LOGISTICIAN');

  if (isLogist && !isAdmin) {
    if (requested !== undefined && requested !== actor.userId) {
      throw new AppError('FORBIDDEN', {
        message: 'foreign cash desk',
        publicMessage: 'Логист работает только со своей кассой.',
      });
    }
    return actor.userId;
  }

  if (isAdmin) {
    if (requested === undefined) {
      throw new AppError('VALIDATION_FAILED', {
        publicMessage: 'Выберите логиста, от имени кассы которого выполняется операция.',
      });
    }
    return requested;
  }

  /*
   * Причина называется словами, как и у чужой кассы выше.
   *
   * Без `publicMessage` человек получал безымянный отказ и не понимал, что
   * дело не в правах «вообще», а в отсутствии у его роли собственной кассы.
   */
  throw new AppError('FORBIDDEN', {
    message: 'cash desk is not available for this role',
    publicMessage:
      'Операции с наличными ведут логист и администратор: своей кассы у этой роли нет.',
  });
}

/**
 * Проведение передачи.
 *
 * Ключ идемпотентности общий на обе стороны: повтор запроса возвращает те же
 * записи и не создаёт ни второй строки долга, ни второго движения кассы.
 */
export async function recordTransfer(
  tx: TransactionClient,
  actor: AuthenticatedActor,
  input: TransferInput,
): Promise<TransferResult> {
  const transferId = newTransferId();

  if (input.kind === 'HANDED_BY_COURIER') {
    /*
     * Курьер сдал наличные.
     *
     * Сначала касса: у неё есть проверка остатка и блокировка владельца,
     * и если она откажет, долг курьера остаться изменённым не должен.
     */
    const cashEntry = await appendCash(tx, {
      logistUserId: input.logistUserId,
      kind: 'RECEIVED_FROM_COURIER',
      amountMinor: input.amountMinor,
      operationDate: input.operationDate,
      actorUserId: actor.userId,
      courierUserId: input.courierUserId,
      transferId,
      idempotencyKey: `cash:${input.idempotencyKey}`,
    });

    const { entry: courierEntry, created } = await appendLedgerEntry(tx, {
      courierUserId: input.courierUserId,
      kind: 'CASH_HANDED_TO_LOGIST',
      amountMinor: input.amountMinor,
      operationDate: input.operationDate,
      actorUserId: actor.userId,
      transferId: cashEntry.transferId,
      idempotencyKey: input.idempotencyKey,
    });

    return { courierEntry, cashEntry, transferId: cashEntry.transferId ?? transferId, created };
  }

  // Логист выдал деньги курьеру: касса уменьшается, долг курьера растёт.
  const cashEntry = await appendCash(tx, {
    logistUserId: input.logistUserId,
    kind: 'ISSUED_TO_COURIER',
    amountMinor: input.amountMinor,
    operationDate: input.operationDate,
    actorUserId: actor.userId,
    courierUserId: input.courierUserId,
    transferId,
    idempotencyKey: `cash:${input.idempotencyKey}`,
  });

  const { entry: courierEntry, created } = await appendLedgerEntry(tx, {
    courierUserId: input.courierUserId,
    kind: 'CASH_ISSUED_TO_COURIER',
    amountMinor: input.amountMinor,
    operationDate: input.operationDate,
    actorUserId: actor.userId,
    transferId: cashEntry.transferId,
    idempotencyKey: input.idempotencyKey,
  });

  return { courierEntry, cashEntry, transferId: cashEntry.transferId ?? transferId, created };
}

/**
 * Отмена передачи целиком.
 *
 * Обратные записи создаются на ОБЕИХ сторонах в одной транзакции: отменённая
 * наполовину передача оставила бы деньги в кассе, которых у логиста нет,
 * или долг у курьера, которого он не делал.
 */
export async function reverseTransfer(
  tx: TransactionClient,
  input: {
    transferId: string;
    actorUserId: string;
    reason: string;
    operationDate: string;
  },
): Promise<boolean> {
  const cashEntries = await tx.logistCashEntry.findMany({
    where: { transferId: input.transferId, kind: { not: 'ADJUSTMENT' } },
    select: { id: true, reversedBy: { select: { id: true } } },
  });
  const courierEntries = await tx.courierLedgerEntry.findMany({
    where: { transferId: input.transferId, kind: { not: 'ADJUSTMENT' } },
    select: { id: true, courierUserId: true, amountMinor: true, routeId: true, orderId: true },
  });

  /*
   * Сделала ли ЭТА транзакция хоть одну отмену.
   *
   * Пропуск уже отменённых сторон сделал повтор успешным — и заодно снял
   * единственную преграду перед вторым аудитом: маршрут кассы писал историю
   * и событие безусловно. Вторую строку получал тот, кто ничего не сделал.
   */
  let reversed = false;

  for (const entry of cashEntries) {
    /*
     * Уже отменённая сторона пропускается — как и сторона курьера ниже.
     *
     * Иначе повтор отмены одной передачи отвечал по-разному в зависимости от
     * того, с какого экрана нажали: из журнала приходил прежний результат,
     * а из кассы — отказ. Одно и то же действие обязано отвечать одинаково.
     */
    if (entry.reversedBy !== null) {
      continue;
    }

    await reverseCash(tx, {
      entryId: entry.id,
      actorUserId: input.actorUserId,
      reason: input.reason,
      operationDate: input.operationDate,
    });
    reversed = true;
  }

  for (const entry of courierEntries) {
    const existing = await tx.courierLedgerEntry.findUnique({
      where: { idempotencyKey: reversalKey(entry.id) },
      select: { id: true },
    });
    if (existing !== null) {
      continue;
    }

    await tx.courierLedgerEntry.create({
      data: {
        courierUserId: entry.courierUserId,
        kind: 'ADJUSTMENT',
        amountMinor: -entry.amountMinor,
        operationDate: new Date(`${input.operationDate}T00:00:00.000Z`),
        actorUserId: input.actorUserId,
        reason: input.reason,
        routeId: entry.routeId,
        orderId: entry.orderId,
        transferId: input.transferId,
        reversesEntryId: entry.id,
        idempotencyKey: reversalKey(entry.id),
      },
    });
    reversed = true;
  }

  return reversed;
}
