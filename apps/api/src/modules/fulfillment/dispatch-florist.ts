/**
 * Рабочее место флориста в автоматическом режиме: готовность, «закончить после
 * текущего» и запрос отказа. Никакой отдельной сущности смены — состояние
 * готовности живёт в активной смене под её же блокировкой.
 *
 * Флорист сам заказ не возвращает: он запрашивает отказ с причиной, а решение
 * принимает руководитель через «Логистика → Уведомления».
 */

import type { Database } from '../../platform/db.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { AppError } from '../../platform/errors.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { readFloristDispatchMode } from '../settings/service.js';
import { NOTIFICATION_AUDIENCE } from '../notifications/change-notify.js';
import { lockActiveShift, shiftRequired } from './shifts.js';
import { listDispatchableOrderIds } from './queue-service.js';
import { enqueueDispatch } from './dispatch-trigger.js';

export type RefusalReason =
  'INSUFFICIENT_GOODS' | 'CANNOT_ASSEMBLE' | 'PHYSICALLY_IMPOSSIBLE' | 'WRONG_ASSIGNMENT' | 'OTHER';

interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface FloristDispatchStatus {
  mode: 'MANUAL' | 'AUTO';
  hasActiveShift: boolean;
  ready: boolean;
  readyAt: string | null;
  finishAfterCurrent: boolean;
  /** Сколько заказов ждёт распределения (в авторежиме). */
  waitingCount: number;
  activeOrder: { id: string; number: string; reassembly: boolean } | null;
  pendingRefusal: boolean;
}

/** Состояние распределения для экрана флориста. */
export async function floristDispatchStatus(
  db: Database,
  actor: AuthenticatedActor,
  now: Date = new Date(),
  operationsStartDate?: string | undefined,
): Promise<FloristDispatchStatus> {
  const mode = await readFloristDispatchMode(db);
  const shift = await db.floristShift.findFirst({
    where: { activeKey: actor.userId },
    select: { id: true, dispatchReadyAt: true, dispatchFinishAfterCurrent: true },
  });
  const active = await db.deliveryOrder.findFirst({
    where: {
      fulfillmentAssigneeId: actor.userId,
      fulfillmentProcessState: { in: ['IN_ASSEMBLY', 'NEEDS_REVIEW'] },
    },
    select: { id: true, externalName: true, assemblyRound: true },
  });
  const pendingRefusal =
    active === null
      ? false
      : (await db.orderRefusalRequest.count({
          where: { orderId: active.id, floristId: actor.userId, state: 'PENDING' },
        })) > 0;

  return {
    mode: mode.value.auto ? 'AUTO' : 'MANUAL',
    hasActiveShift: shift !== null,
    ready: Boolean(shift?.dispatchReadyAt),
    readyAt: shift?.dispatchReadyAt?.toISOString() ?? null,
    finishAfterCurrent: shift?.dispatchFinishAfterCurrent ?? false,
    // Число ожидающих показываем и до готовности: флорист видит нагрузку.
    waitingCount: mode.value.auto
      ? (await listDispatchableOrderIds(db, now, operationsStartDate)).length
      : 0,
    activeOrder:
      active === null
        ? null
        : { id: active.id, number: active.externalName, reassembly: active.assemblyRound > 1 },
    pendingRefusal,
  };
}

/** «Готов к заказам» / выход из готовности. Требует активной смены. */
export async function setDispatchReady(
  db: Database,
  actor: AuthenticatedActor,
  ready: boolean,
  context: RequestContext,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const shift = await lockActiveShift(tx, actor.userId);
    if (shift === null) {
      throw shiftRequired();
    }
    await tx.floristShift.update({
      where: { id: shift.id },
      data: { dispatchReadyAt: ready ? new Date() : null },
    });
    await writeAudit(tx, {
      action: 'FLORIST_DISPATCH_READY_CHANGED',
      entityType: 'FloristShift',
      entityId: shift.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { ready },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    // Экран флориста и списки руководителей — без перезагрузки.
    await publishRealtimeEvent(tx, {
      topic: 'florist.dispatch_changed',
      audienceUserId: actor.userId,
      payload: { ready },
    });
    await publishRealtimeEvent(tx, {
      topic: 'florist.dispatch_changed',
      audienceRoles: ['ADMIN', 'SUPERVISOR'],
      payload: { userId: actor.userId },
    });
    // Стал готов — раздаём (движок сам проверит, есть ли что и кому).
    if (ready) {
      await enqueueDispatch(tx);
    }
  });
}

/** «Закончить после текущего»: блокирует новое автоназначение. */
export async function setFinishAfterCurrent(
  db: Database,
  actor: AuthenticatedActor,
  value: boolean,
  context: RequestContext,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const shift = await lockActiveShift(tx, actor.userId);
    if (shift === null) {
      throw shiftRequired();
    }
    await tx.floristShift.update({
      where: { id: shift.id },
      data: { dispatchFinishAfterCurrent: value },
    });
    await writeAudit(tx, {
      action: 'FLORIST_DISPATCH_FINISH_AFTER_CURRENT',
      entityType: 'FloristShift',
      entityId: shift.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { finishAfterCurrent: value },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    await publishRealtimeEvent(tx, {
      topic: 'florist.dispatch_changed',
      audienceUserId: actor.userId,
      payload: { finishAfterCurrent: value },
    });
    // Снял «закончить» — снова доступен, можно раздать следующий.
    if (!value) {
      await enqueueDispatch(tx);
    }
  });
}

/**
 * Запрос отказа от назначенного заказа с обязательной причиной.
 *
 * Заказ остаётся у флориста; создаётся уведомление руководителям. Один открытый
 * запрос на заказ (частичный уникальный индекс) — повтор возвращает прежний.
 */
export async function requestRefusal(
  db: Database,
  actor: AuthenticatedActor,
  input: { orderId: string; reason: RefusalReason; comment: string | null },
  context: RequestContext,
): Promise<{ id: string; created: boolean }> {
  if (input.reason === 'OTHER' && (input.comment === null || input.comment.trim() === '')) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'comment required for OTHER',
      publicMessage: 'Для причины «Другое» обязателен комментарий.',
    });
  }

  return db.$transaction(async (tx) => {
    // Заказ обязан быть назначен именно этому флористу и быть в работе.
    const order = await tx.deliveryOrder.findFirst({
      where: {
        id: input.orderId,
        fulfillmentAssigneeId: actor.userId,
        fulfillmentProcessState: { in: ['IN_ASSEMBLY', 'NEEDS_REVIEW'] },
      },
      select: { id: true, externalName: true },
    });
    if (order === null) {
      throw new AppError('NOT_FOUND', {
        message: 'order not assigned to florist',
        publicMessage: 'Этот заказ вам не назначен.',
      });
    }

    // Повтор не создаёт дубль: открытый запрос уже есть — возвращаем его.
    const existing = await tx.orderRefusalRequest.findFirst({
      where: { orderId: order.id, state: 'PENDING' },
      select: { id: true },
    });
    if (existing !== null) {
      return { id: existing.id, created: false };
    }

    const actorRow = await tx.user.findUnique({
      where: { id: actor.userId },
      select: { fullName: true },
    });

    // Уведомление руководителям — через общую систему «Уведомления».
    const notification = await tx.orderChangeNotification.create({
      data: {
        orderId: order.id,
        source: 'FLORIST',
        categories: [],
        kind: 'REFUSAL_REQUEST',
        payload: {
          floristId: actor.userId,
          floristName: actorRow?.fullName ?? '—',
          reason: input.reason,
          comment: input.comment,
        } as unknown as object,
      },
      select: { id: true },
    });

    const refusal = await tx.orderRefusalRequest.create({
      data: {
        orderId: order.id,
        floristId: actor.userId,
        reason: input.reason,
        comment: input.comment,
        notificationId: notification.id,
      },
      select: { id: true },
    });

    await writeAudit(tx, {
      action: 'ORDER_REFUSAL_REQUESTED',
      entityType: 'DeliveryOrder',
      entityId: order.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { reason: input.reason, refusalId: refusal.id },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    // Всплывающее окно у руководителей + счётчик вкладки.
    await publishRealtimeEvent(tx, {
      topic: 'notification.created',
      audienceRoles: [...NOTIFICATION_AUDIENCE],
      payload: { notificationId: notification.id, orderId: order.id, kind: 'REFUSAL_REQUEST' },
    });
    // Флорист видит статус «Ожидает решения».
    await publishRealtimeEvent(tx, {
      topic: 'florist.dispatch_changed',
      audienceUserId: actor.userId,
      payload: { refusalRequested: true },
    });

    return { id: refusal.id, created: true };
  });
}

export type RefusalAction = 'REJECT' | 'APPROVE' | 'TRANSFER';

export interface RefusalDecisionResult {
  state: 'REJECTED' | 'APPROVED' | 'TRANSFERRED';
  alreadyDecided: boolean;
}

/**
 * Решение руководителя по запросу отказа. Глобальное и идемпотентное: переход
 * состояния запроса `PENDING → …` сериализует гонку двух руководителей.
 *
 *  * «Отклонить» — заказ остаётся у флориста;
 *  * «Подтвердить отказ» — заказ возвращается в очередь и в этой попытке тому же
 *    флористу не выдаётся (движок проверяет одобренный отказ);
 *  * «Передать другому» — заказ атомарно назначается выбранному флористу.
 */
export async function decideRefusal(
  db: Database,
  actor: AuthenticatedActor,
  input: { notificationId: string; action: RefusalAction; floristId?: string | null },
  context: RequestContext,
): Promise<RefusalDecisionResult> {
  return db.$transaction(async (tx) => {
    const refusal = await tx.orderRefusalRequest.findFirst({
      where: { notificationId: input.notificationId },
      select: { id: true, orderId: true, floristId: true, state: true },
    });
    if (refusal === null) {
      throw new AppError('NOT_FOUND', { message: 'refusal request not found' });
    }
    if (refusal.state !== 'PENDING') {
      return {
        state: refusal.state as RefusalDecisionResult['state'],
        alreadyDecided: true,
      };
    }

    const newState: RefusalDecisionResult['state'] =
      input.action === 'REJECT'
        ? 'REJECTED'
        : input.action === 'APPROVE'
          ? 'APPROVED'
          : 'TRANSFERRED';

    // «Передать»: цель и её смена проверяются и блокируются ДО заказа (порядок
    // блокировок FloristShift → DeliveryOrder).
    let newShiftId: string | null = null;
    let transferTargetId: string | null = null;
    if (input.action === 'TRANSFER') {
      if (input.floristId === undefined || input.floristId === null) {
        throw new AppError('VALIDATION_FAILED', {
          message: 'floristId required for transfer',
          publicMessage: 'Выберите флориста для передачи.',
        });
      }
      const target = await tx.user.findUnique({
        where: { id: input.floristId },
        select: { status: true, roles: { select: { role: true } } },
      });
      if (
        target === null ||
        target.status !== 'ACTIVE' ||
        !target.roles.some((r) => r.role === 'FLORIST' || r.role === 'ADMIN')
      ) {
        throw new AppError('NOT_FOUND', {
          message: 'target florist invalid',
          publicMessage: 'Сотрудник не найден или не флорист.',
        });
      }
      const shift = await lockActiveShift(tx, input.floristId);
      if (shift === null) {
        throw new AppError('CONFLICT', {
          message: 'target florist has no active shift',
          publicMessage: 'У выбранного флориста нет активной смены.',
          conflict: { kind: 'FLORIST_NOT_ON_SHIFT' },
        });
      }
      newShiftId = shift.id;
      transferTargetId = input.floristId;
    }

    // Захват решения: проигравший в гонке получит 0 строк.
    const claimed = await tx.orderRefusalRequest.updateMany({
      where: { id: refusal.id, state: 'PENDING' },
      data: { state: newState, decidedById: actor.userId, decidedAt: new Date() },
    });
    if (claimed.count === 0) {
      const current = await tx.orderRefusalRequest.findUnique({
        where: { id: refusal.id },
        select: { state: true },
      });
      return {
        state: (current?.state ?? 'REJECTED') as RefusalDecisionResult['state'],
        alreadyDecided: true,
      };
    }

    if (input.action === 'APPROVE') {
      // Заказ возвращается в свободную очередь; заявитель освобождается.
      await tx.deliveryOrder.updateMany({
        where: {
          id: refusal.orderId,
          fulfillmentAssigneeId: refusal.floristId,
          fulfillmentProcessState: 'IN_ASSEMBLY',
        },
        data: {
          fulfillmentProcessState: 'NEW',
          fulfillmentAssigneeId: null,
          fulfillmentAssignedAt: null,
          fulfillmentShiftId: null,
          fulfillmentProcessVersion: { increment: 1 },
        },
      });
      await publishRealtimeEvent(tx, {
        topic: 'order.fulfillment_process_changed',
        audienceUserId: refusal.floristId,
        payload: { orderId: refusal.orderId },
      });
    } else if (input.action === 'TRANSFER') {
      await tx.deliveryOrder.updateMany({
        where: {
          id: refusal.orderId,
          fulfillmentAssigneeId: refusal.floristId,
          fulfillmentProcessState: 'IN_ASSEMBLY',
        },
        data: {
          fulfillmentAssigneeId: transferTargetId,
          fulfillmentShiftId: newShiftId,
          fulfillmentAssignedAt: new Date(),
          fulfillmentProcessVersion: { increment: 1 },
        },
      });
      await publishRealtimeEvent(tx, {
        topic: 'order.fulfillment_process_changed',
        audienceUserId: refusal.floristId,
        payload: { orderId: refusal.orderId },
      });
      await publishRealtimeEvent(tx, {
        topic: 'order.fulfillment_process_changed',
        audienceUserId: input.floristId ?? '',
        payload: { orderId: refusal.orderId },
      });
    }
    // «Отклонить» заказ не трогает.

    await writeAudit(tx, {
      action: 'ORDER_REFUSAL_DECIDED',
      entityType: 'DeliveryOrder',
      entityId: refusal.orderId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: {
        action: input.action,
        floristId: refusal.floristId,
        ...(input.floristId ? { toFloristId: input.floristId } : {}),
      },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    // Список руководителей и статус флориста обновляются без перезагрузки.
    await publishRealtimeEvent(tx, {
      topic: 'notification.decided',
      audienceRoles: [...NOTIFICATION_AUDIENCE],
      payload: { notificationId: input.notificationId, orderId: refusal.orderId },
    });
    await publishRealtimeEvent(tx, {
      topic: 'florist.dispatch_changed',
      audienceUserId: refusal.floristId,
      payload: { refusalDecided: newState },
    });

    // Освобождённый заказ/флорист — раздаём заново (кроме «Отклонить»).
    if (input.action !== 'REJECT') {
      await enqueueDispatch(tx);
    }

    return { state: newState, alreadyDecided: false };
  });
}

/**
 * Идентификаторы уведомлений НЕрешённых запросов отказа.
 *
 * Догоняющий список для всплывающих окон руководителя: живое событие
 * `notification.created` видит только тот, кто был онлайн в момент отказа.
 * Кто вошёл позже, обязан увидеть отказ, ждущий решения, — поэтому при входе
 * фронт запрашивает открытые (`PENDING`) отказы и показывает их окнами.
 * Решённые сюда не попадают: они не всплывают повторно.
 */
export async function listPendingRefusalNotificationIds(db: Database): Promise<string[]> {
  const rows = await db.orderRefusalRequest.findMany({
    where: { state: 'PENDING', notificationId: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { notificationId: true },
  });
  return rows.flatMap((row) => (row.notificationId === null ? [] : [row.notificationId]));
}
