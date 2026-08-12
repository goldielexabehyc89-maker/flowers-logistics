/**
 * Смена флориста.
 *
 * Смена — не украшение интерфейса, а условие работы: без активной смены нельзя
 * взять новый заказ, и по активным сменам администратор понимает, кто вообще
 * сегодня собирает. Поэтому «одна активная смена на человека» держит база
 * (уникальный `activeKey`), а не проверка перед вставкой: два одновременных
 * запроса «начать смену» прошли бы обе проверки и создали две смены.
 *
 * ПРИНУДИТЕЛЬНОЕ ЗАВЕРШЕНИЕ НЕ ТЕРЯЕТ РАБОТУ.
 *
 * Закрытие чужой смены не снимает назначения: заказ, который человек уже
 * наполовину собрал, не должен молча вернуться в общую очередь и быть взят
 * вторым флористом. Назначения остаются, но становятся ВИДИМЫМИ как требующие
 * решения администратора — исполнителя без активной смены видно отдельным
 * списком, и админ либо переназначает заказ, либо возвращает его в очередь.
 */

import type { Role } from '@fl/shared';
import { AppError } from '../../platform/errors.js';
import type { Database } from '../../platform/db.js';
import type { TransactionClient } from '../auth/sessions.js';
import { writeAudit, type AuditAction } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';

/** Кто вообще имеет доступ к разделу флориста. */
export const FLORIST_ROLES = ['ADMIN', 'FLORIST'] as const;
/** Административные действия раздела. */
export const FLORIST_ADMIN_ROLES = ['ADMIN'] as const;

/** Кому адресованы общие события производственного процесса. */
export const FULFILLMENT_AUDIENCE = ['ADMIN', 'FLORIST'] as const;

/** Максимальная длина причины администратора: она попадает в аудит и в базу. */
export const MAX_REASON_LENGTH = 500;
export const MIN_REASON_LENGTH = 3;

export interface ShiftActor {
  userId: string;
  roles: readonly Role[];
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface ShiftView {
  id: string;
  userId: string;
  userFullName: string;
  startedAt: string;
  closedAt: string | null;
  closeKind: 'SELF' | 'ADMIN_FORCED' | null;
  closeReason: string | null;
  /** Сколько незавершённых заказов было взято в этой смене. */
  openAssignments: number;
}

interface ShiftRow {
  id: string;
  userId: string;
  startedAt: Date;
  closedAt: Date | null;
  closeKind: 'SELF' | 'ADMIN_FORCED' | null;
  closeReason: string | null;
  user: { fullName: string };
}

function toView(shift: ShiftRow, openAssignments: number): ShiftView {
  return {
    id: shift.id,
    userId: shift.userId,
    userFullName: shift.user.fullName,
    startedAt: shift.startedAt.toISOString(),
    closedAt: shift.closedAt === null ? null : shift.closedAt.toISOString(),
    closeKind: shift.closeKind,
    closeReason: shift.closeReason,
    openAssignments,
  };
}

/** Состояния, в которых заказ считается незавершённым для флориста. */
export const OPEN_PROCESS_STATES = ['IN_ASSEMBLY'] as const;

/**
 * ЕДИНЫЙ ПОРЯДОК БЛОКИРОВОК ПРОИЗВОДСТВЕННОГО КОНТУРА.
 *
 *   FloristShift → DeliveryOrder → OrderPrintForm/OrderPrintJob
 *
 * Порядок зафиксирован здесь, а не подразумевается: смена и заказ блокируются
 * в разных операциях (захват, отказ, «Собран», закрытие смены, повтор печати),
 * и стоит одной из них взять их в обратном порядке — появляется взаимная
 * блокировка, которая воспроизводится раз в неделю и выглядит как «зависло».
 */

/**
 * Активная смена пользователя ПОД БЛОКИРОВКОЙ строки.
 *
 * Обычного чтения здесь недостаточно. Между «смена активна» и записью
 * назначения администратор успевает закрыть смену, и заказ оказался бы
 * закреплён за уже закрытой сменой — то есть за человеком, который ушёл домой.
 * Блокировка строки делает исход однозначным: либо закрытие ждёт завершения
 * действия, либо действие видит закрытую смену и честно отказывает.
 *
 * Вызывается ПЕРВОЙ в транзакции: `FloristShift` стоит в порядке блокировок
 * раньше `DeliveryOrder`.
 */
export async function lockActiveShift(
  tx: TransactionClient,
  userId: string,
): Promise<{ id: string } | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "FloristShift"
    WHERE "activeKey" = ${userId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** Отказ действия, требующего активной смены. */
export function shiftRequired(): AppError {
  return new AppError('CONFLICT', {
    message: 'active shift required',
    publicMessage: 'Действие требует активной смены. Начните смену и повторите.',
    conflict: { kind: 'FLORIST_SHIFT_REQUIRED' },
  });
}

/**
 * Текущая активная смена пользователя.
 *
 * Читается по `activeKey`, а не по «последней незакрытой»: ключ и есть
 * инвариант, и выборка по нему не может однажды вернуть вторую смену.
 */
export async function findActiveShift(
  db: Database | TransactionClient,
  userId: string,
): Promise<ShiftRow | null> {
  return db.floristShift.findUnique({
    where: { activeKey: userId },
    select: {
      id: true,
      userId: true,
      startedAt: true,
      closedAt: true,
      closeKind: true,
      closeReason: true,
      user: { select: { fullName: true } },
    },
  });
}

async function openAssignmentsOf(
  db: Database | TransactionClient,
  userId: string,
): Promise<number> {
  return db.deliveryOrder.count({
    where: {
      fulfillmentAssigneeId: userId,
      fulfillmentProcessState: { in: [...OPEN_PROCESS_STATES] },
    },
  });
}

/** Собственная смена вместе с числом незавершённых назначений. */
export async function ownShift(db: Database, userId: string): Promise<ShiftView | null> {
  const shift = await findActiveShift(db, userId);
  if (shift === null) {
    return null;
  }
  return toView(shift, await openAssignmentsOf(db, userId));
}

/**
 * Начало смены.
 *
 * Идемпотентно: повторное нажатие возвращает уже открытую смену, а не отказ.
 * Отказ здесь был бы вредным — флорист, у которого дрогнула связь, увидел бы
 * ошибку при полностью исправном состоянии. Гонку двух одновременных запросов
 * разрешает уникальный индекс базы, и проигравший получает ту же самую смену.
 */
export async function startShift(
  db: Database,
  actor: ShiftActor,
  context: RequestContext,
): Promise<{ shift: ShiftView; created: boolean }> {
  const existing = await findActiveShift(db, actor.userId);
  if (existing !== null) {
    return { shift: toView(existing, await openAssignmentsOf(db, actor.userId)), created: false };
  }

  try {
    const shift = await db.$transaction(async (tx) => {
      const created = await tx.floristShift.create({
        data: { userId: actor.userId, activeKey: actor.userId },
        select: {
          id: true,
          userId: true,
          startedAt: true,
          closedAt: true,
          closeKind: true,
          closeReason: true,
          user: { select: { fullName: true } },
        },
      });

      await writeShiftAudit(tx, 'FLORIST_SHIFT_STARTED', created.id, actor, context, {
        userId: actor.userId,
      });
      await publishShiftEvent(tx, created.id, actor.userId, 'STARTED');
      return created;
    });

    return { shift: toView(shift, 0), created: true };
  } catch (error) {
    // Проигравший гонку получает не ошибку, а ту же смену: инвариант базы
    // сработал именно так, как задумано, и рассказывать об этом человеку нечего.
    const again = await findActiveShift(db, actor.userId);
    if (again !== null) {
      return { shift: toView(again, await openAssignmentsOf(db, actor.userId)), created: false };
    }
    throw error;
  }
}

/**
 * Завершение собственной смены.
 *
 * Незавершённые назначения не снимаются и здесь: флорист закрывает смену,
 * а не отказывается от заказов. Их число возвращается ответом, чтобы интерфейс
 * мог честно сказать, сколько работы осталось за человеком.
 */
export async function closeOwnShift(
  db: Database,
  actor: ShiftActor,
  context: RequestContext,
): Promise<ShiftView> {
  const active = await findActiveShift(db, actor.userId);
  if (active === null) {
    throw new AppError('NOT_FOUND', {
      message: 'no active shift',
      publicMessage: 'Активной смены нет.',
    });
  }

  const openAssignments = await openAssignmentsOf(db, actor.userId);

  const closed = await db.$transaction(async (tx) => {
    // Условие `activeKey` — не украшение: между чтением и записью смену мог
    // закрыть администратор, и вторая запись затёрла бы его причину.
    const updated = await tx.floristShift.updateMany({
      where: { id: active.id, activeKey: actor.userId },
      data: {
        closedAt: new Date(),
        activeKey: null,
        closeKind: 'SELF',
        closedById: actor.userId,
      },
    });

    if (updated.count === 0) {
      throw new AppError('CONFLICT', {
        message: 'shift already closed',
        publicMessage: 'Смена уже закрыта.',
        conflict: { kind: 'STALE_VERSION' },
      });
    }

    await writeShiftAudit(tx, 'FLORIST_SHIFT_CLOSED', active.id, actor, context, {
      userId: actor.userId,
      openAssignments,
    });
    await publishShiftEvent(tx, active.id, actor.userId, 'CLOSED');

    return tx.floristShift.findUniqueOrThrow({
      where: { id: active.id },
      select: {
        id: true,
        userId: true,
        startedAt: true,
        closedAt: true,
        closeKind: true,
        closeReason: true,
        user: { select: { fullName: true } },
      },
    });
  });

  return toView(closed, openAssignments);
}

/**
 * Принудительное завершение смены администратором.
 *
 * Причина обязательна и хранится: закрытая за человека смена без объяснения —
 * это распоряжение без автора. То же требует и CHECK базы, поэтому нарушить
 * правило нельзя и запросом мимо API.
 */
export async function forceCloseShift(
  db: Database,
  actor: ShiftActor,
  input: { shiftId: string; reason: string },
  context: RequestContext,
): Promise<{ shift: ShiftView; orphanedOrderIds: string[] }> {
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'reason required',
      publicMessage: 'Укажите причину завершения смены.',
    });
  }

  const shift = await db.floristShift.findUnique({
    where: { id: input.shiftId },
    select: { id: true, userId: true, closedAt: true },
  });
  if (shift === null) {
    throw new AppError('NOT_FOUND', { message: 'shift not found' });
  }
  if (shift.closedAt !== null) {
    throw new AppError('CONFLICT', {
      message: 'shift already closed',
      publicMessage: 'Смена уже закрыта.',
      conflict: { kind: 'STALE_VERSION' },
    });
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.floristShift.updateMany({
      where: { id: shift.id, activeKey: shift.userId },
      data: {
        closedAt: new Date(),
        activeKey: null,
        closeKind: 'ADMIN_FORCED',
        closedById: actor.userId,
        closeReason: reason,
      },
    });

    if (updated.count === 0) {
      throw new AppError('CONFLICT', {
        message: 'shift already closed',
        publicMessage: 'Смена уже закрыта.',
        conflict: { kind: 'STALE_VERSION' },
      });
    }

    // Назначения НЕ снимаются: наполовину собранный заказ не должен вернуться
    // в общую очередь и уйти второму флористу. Они перечисляются явно, и
    // администратор решает их судьбу отдельным действием.
    const orphaned = await tx.deliveryOrder.findMany({
      where: {
        fulfillmentAssigneeId: shift.userId,
        fulfillmentProcessState: { in: [...OPEN_PROCESS_STATES] },
      },
      select: { id: true },
      orderBy: { externalName: 'asc' },
    });
    const orphanedOrderIds = orphaned.map((order) => order.id);

    await writeShiftAudit(tx, 'FLORIST_SHIFT_FORCE_CLOSED', shift.id, actor, context, {
      userId: shift.userId,
      reason,
      orphanedOrders: orphanedOrderIds.length,
    });

    // Общее событие видит администратор, личное — тот, чью смену закрыли:
    // он обязан узнать об этом, не перезагружая страницу.
    await publishShiftEvent(tx, shift.id, shift.userId, 'FORCE_CLOSED');
    await publishRealtimeEvent(tx, {
      topic: 'florist.shift_changed',
      payload: { shiftId: shift.id, kind: 'FORCE_CLOSED', orphanedOrders: orphanedOrderIds.length },
      audienceUserId: shift.userId,
    });

    const row = await tx.floristShift.findUniqueOrThrow({
      where: { id: shift.id },
      select: {
        id: true,
        userId: true,
        startedAt: true,
        closedAt: true,
        closeKind: true,
        closeReason: true,
        user: { select: { fullName: true } },
      },
    });

    return { shift: toView(row, orphanedOrderIds.length), orphanedOrderIds };
  });
}

/** Активные смены: кто сейчас работает и сколько заказов у каждого в сборке. */
export async function listActiveShifts(db: Database): Promise<ShiftView[]> {
  const shifts = await db.floristShift.findMany({
    where: { closedAt: null },
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      userId: true,
      startedAt: true,
      closedAt: true,
      closeKind: true,
      closeReason: true,
      user: { select: { fullName: true } },
    },
  });

  const counts = await Promise.all(shifts.map((shift) => openAssignmentsOf(db, shift.userId)));
  return shifts.map((shift, index) => toView(shift, counts[index] ?? 0));
}

/**
 * Флористы, которым можно назначить заказ.
 *
 * Только активная смена: назначить заказ человеку, который сегодня не работает,
 * значит потерять заказ до конца дня (`FUL-002` §2.3).
 */
export async function listAssignableFlorists(
  db: Database,
): Promise<{ userId: string; fullName: string; openAssignments: number }[]> {
  const shifts = await db.floristShift.findMany({
    where: { closedAt: null },
    orderBy: { startedAt: 'asc' },
    select: { userId: true, user: { select: { fullName: true, status: true } } },
  });

  const active = shifts.filter((shift) => shift.user.status === 'ACTIVE');
  const counts = await Promise.all(active.map((shift) => openAssignmentsOf(db, shift.userId)));

  return active.map((shift, index) => ({
    userId: shift.userId,
    fullName: shift.user.fullName,
    openAssignments: counts[index] ?? 0,
  }));
}

async function writeShiftAudit(
  tx: TransactionClient,
  action: AuditAction,
  shiftId: string,
  actor: ShiftActor,
  context: RequestContext,
  newValue: Record<string, unknown>,
): Promise<void> {
  await writeAudit(tx, {
    action,
    entityType: 'FloristShift',
    entityId: shiftId,
    actorUserId: actor.userId,
    actorRoles: actor.roles,
    newValue,
    ip: context.ip,
    userAgent: context.userAgent,
  });
}

/**
 * Событие смены.
 *
 * Ни имени, ни телефона: администратору достаточно узнать, что список смен
 * изменился, и перезапросить его.
 */
async function publishShiftEvent(
  tx: TransactionClient,
  shiftId: string,
  userId: string,
  kind: 'STARTED' | 'CLOSED' | 'FORCE_CLOSED',
): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic: 'florist.shift_changed',
    payload: { shiftId, floristId: userId, kind },
    audienceRoles: [...FULFILLMENT_AUDIENCE],
  });
}
