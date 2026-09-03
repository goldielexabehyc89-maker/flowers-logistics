/**
 * Карантин «Нет цветов» для авто-раздачи.
 *
 * Когда в режиме AUTO флорист отказывается с причиной «Нет цветов»
 * (`INSUFFICIENT_GOODS`), заказ СРАЗУ снимается с него — решения руководителя не
 * ждём — и помещается в серверный карантин. Пока карантин открыт
 * (`activeKey != null`), заказ исключён из очереди, поиска, счётчиков, приоритета
 * самовывоза, ручного взятия и авто-раздачи (единая точка — `offerableConstraints`).
 * Менеджер выдачи (или ADMIN/SUPERVISOR) во вкладке «Решения» возвращает заказ в
 * очередь — В КОНЕЦ, чтобы не выхватить сразу следующего флориста. Дата, способ,
 * состав и статус заказа при этом не меняются.
 */

import type { Database } from '../../platform/db.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import type { Role } from '@fl/shared';
import { AppError } from '../../platform/errors.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { enqueueDispatch } from './dispatch-trigger.js';

export const NO_FLOWERS_KIND = 'NO_FLOWERS_QUARANTINE';

/** Кто видит окно и вкладку «Решения» и может вернуть заказ в очередь. */
export const NO_FLOWERS_ROLES: readonly Role[] = ['MANAGER', 'ADMIN', 'SUPERVISOR'];

interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

/** Заказ снят с флориста и убран в карантин. Вызывается ВНУТРИ транзакции отказа. */
export async function quarantineNoFlowers(
  tx: TransactionClient,
  actor: AuthenticatedActor,
  order: { id: string; externalName: string; assemblyRound: number },
  comment: string | null,
  context: RequestContext,
): Promise<{ id: string; created: boolean }> {
  // Идемпотентность: открытый карантин уже есть — возвращаем его, второго не создаём.
  const existing = await tx.orderNoFlowersQuarantine.findFirst({
    where: { orderId: order.id, activeKey: { not: null } },
    select: { id: true },
  });
  if (existing !== null) {
    return { id: existing.id, created: false };
  }

  // Снимаем заказ с флориста СРАЗУ. В свободную очередь он не возвращается —
  // из неё карантин его исключает (offerableConstraints). Круг сборки, способ,
  // дату и состав не трогаем.
  await tx.deliveryOrder.updateMany({
    where: {
      id: order.id,
      fulfillmentAssigneeId: actor.userId,
      fulfillmentProcessState: { in: ['IN_ASSEMBLY', 'NEEDS_REVIEW'] },
    },
    data: {
      fulfillmentProcessState: 'NEW',
      fulfillmentAssigneeId: null,
      fulfillmentAssignedAt: null,
      fulfillmentShiftId: null,
      fulfillmentProcessVersion: { increment: 1 },
    },
  });

  const actorRow = await tx.user.findUnique({
    where: { id: actor.userId },
    select: { fullName: true },
  });

  // Уведомление ответственным — через общую систему «Уведомления» (для окна).
  const notification = await tx.orderChangeNotification.create({
    data: {
      orderId: order.id,
      source: 'FLORIST',
      categories: [],
      kind: NO_FLOWERS_KIND,
      payload: {
        floristId: actor.userId,
        floristName: actorRow?.fullName ?? '—',
        reason: 'INSUFFICIENT_GOODS',
        comment,
      } as unknown as object,
    },
    select: { id: true },
  });

  const quarantine = await tx.orderNoFlowersQuarantine.create({
    data: {
      orderId: order.id,
      floristId: actor.userId,
      assemblyRound: order.assemblyRound,
      reason: 'INSUFFICIENT_GOODS',
      comment,
      activeKey: order.id,
      notificationId: notification.id,
    },
    select: { id: true },
  });

  await writeAudit(tx, {
    action: 'ORDER_NO_FLOWERS_QUARANTINED',
    entityType: 'DeliveryOrder',
    entityId: order.id,
    actorUserId: actor.userId,
    actorRoles: actor.roles,
    newValue: { quarantineId: quarantine.id, reason: 'INSUFFICIENT_GOODS' },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  // Окно у ответственных.
  await publishRealtimeEvent(tx, {
    topic: 'notification.created',
    audienceRoles: [...NO_FLOWERS_ROLES],
    payload: { notificationId: notification.id, orderId: order.id, kind: NO_FLOWERS_KIND },
  });
  // Вкладка «Решения» и её счётчик.
  await publishRealtimeEvent(tx, {
    topic: 'order.no_flowers_changed',
    audienceRoles: [...NO_FLOWERS_ROLES],
    payload: { orderId: order.id },
  });
  // Флорист свободен: «Мои заказы» и статус раздачи обновляются, можно раздать
  // следующий заказ.
  await publishRealtimeEvent(tx, {
    topic: 'order.fulfillment_process_changed',
    audienceRoles: ['ADMIN', 'FLORIST', 'LOGISTICIAN', 'WAREHOUSE'],
    payload: { orderId: order.id },
  });
  await publishRealtimeEvent(tx, {
    topic: 'florist.dispatch_changed',
    audienceUserId: actor.userId,
    payload: { released: true },
  });

  // Освободившемуся флористу и другим — следующий подходящий заказ.
  await enqueueDispatch(tx);

  return { id: quarantine.id, created: true };
}

export interface NoFlowersQuarantineView {
  id: string;
  orderId: string;
  orderNumber: string;
  deliveryMethod: 'PICKUP' | 'DELIVERY' | null;
  deliveryDate: string | null;
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
  floristName: string;
  refusedAt: string;
  reason: string;
  comment: string | null;
  orderState: string;
}

function methodOf(deliveryMethodId: string | null): 'PICKUP' | 'DELIVERY' | null {
  if (deliveryMethodId === MOYSKLAD_IDS.deliveryMethodPickup) return 'PICKUP';
  if (deliveryMethodId === MOYSKLAD_IDS.deliveryMethodDelivery) return 'DELIVERY';
  return null;
}

const QUARANTINE_SELECT = {
  id: true,
  orderId: true,
  reason: true,
  comment: true,
  createdAt: true,
  florist: { select: { fullName: true } },
  order: {
    select: {
      externalName: true,
      deliveryMethodId: true,
      deliveryDate: true,
      intervalStartMinute: true,
      intervalEndMinute: true,
      manualIntervalStartMinute: true,
      manualIntervalEndMinute: true,
      fulfillmentProcessState: true,
    },
  },
} as const;

type QuarantineRow = {
  id: string;
  orderId: string;
  reason: string;
  comment: string | null;
  createdAt: Date;
  florist: { fullName: string };
  order: {
    externalName: string;
    deliveryMethodId: string | null;
    deliveryDate: Date | null;
    intervalStartMinute: number | null;
    intervalEndMinute: number | null;
    manualIntervalStartMinute: number | null;
    manualIntervalEndMinute: number | null;
    fulfillmentProcessState: string;
  };
};

function toView(row: QuarantineRow): NoFlowersQuarantineView {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.order.externalName,
    deliveryMethod: methodOf(row.order.deliveryMethodId),
    deliveryDate: row.order.deliveryDate === null ? null : row.order.deliveryDate.toISOString(),
    intervalStartMinute: row.order.manualIntervalStartMinute ?? row.order.intervalStartMinute,
    intervalEndMinute: row.order.manualIntervalEndMinute ?? row.order.intervalEndMinute,
    floristName: row.florist.fullName,
    refusedAt: row.createdAt.toISOString(),
    reason: row.reason,
    comment: row.comment,
    orderState: row.order.fulfillmentProcessState,
  };
}

/** Постоянный список открытых карантинов для вкладки «Решения». */
export async function listNoFlowersQuarantines(
  db: Database,
): Promise<{ items: NoFlowersQuarantineView[]; total: number }> {
  const rows = await db.orderNoFlowersQuarantine.findMany({
    where: { activeKey: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: QUARANTINE_SELECT,
  });
  const items = rows.map(toView);
  return { items, total: items.length };
}

/** Карантин по идентификатору его уведомления — для всплывающего окна. */
export async function getNoFlowersByNotificationId(
  db: Database,
  notificationId: string,
): Promise<NoFlowersQuarantineView | null> {
  const row = await db.orderNoFlowersQuarantine.findUnique({
    where: { notificationId },
    select: QUARANTINE_SELECT,
  });
  return row === null ? null : toView(row);
}

/** Счётчик вкладки «Решения». */
export function countOpenNoFlowersQuarantines(db: Database): Promise<number> {
  return db.orderNoFlowersQuarantine.count({ where: { activeKey: { not: null } } });
}

/** Идентификаторы уведомлений открытых карантинов, не прочитанных этим пользователем. */
export async function listPendingNoFlowersNotificationIds(
  db: Database,
  userId: string,
): Promise<string[]> {
  const rows = await db.orderChangeNotification.findMany({
    where: {
      kind: NO_FLOWERS_KIND,
      reads: { none: { userId } },
      noFlowersQuarantine: { activeKey: { not: null } },
    },
    orderBy: { occurredAt: 'asc' },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export interface ReturnResult {
  returned: boolean;
  alreadyClosed: boolean;
  closedUnfit: boolean;
}

/**
 * Возврат заказа из карантина в очередь (в КОНЕЦ).
 *
 * Идемпотентно: повторный вызов на уже закрытом карантине ничего не создаёт и
 * не двигает. Если заказ во время карантина стал непригоден к сборке (отменён,
 * архивирован, пропал из источника, вышел из области или уже не `NEW`), задача
 * закрывается штатно БЕЗ возврата в очередь.
 */
export async function returnFromQuarantine(
  db: Database,
  actor: AuthenticatedActor,
  quarantineId: string,
  context: RequestContext,
): Promise<ReturnResult> {
  return db.$transaction(async (tx) => {
    const q = await tx.orderNoFlowersQuarantine.findUnique({
      where: { id: quarantineId },
      select: { id: true, orderId: true, activeKey: true },
    });
    if (q === null) {
      throw new AppError('NOT_FOUND', {
        message: 'quarantine not found',
        publicMessage: 'Задача не найдена.',
      });
    }
    if (q.activeKey === null) {
      return { returned: false, alreadyClosed: true, closedUnfit: false };
    }

    const order = await tx.deliveryOrder.findUnique({
      where: { id: q.orderId },
      select: {
        cancelledInSource: true,
        cancelledByLogistAt: true,
        sourceArchived: true,
        sourceMissing: true,
        fulfillmentInScope: true,
        fulfillmentProcessState: true,
      },
    });
    const unfit =
      order === null ||
      order.cancelledInSource ||
      order.cancelledByLogistAt !== null ||
      order.sourceArchived ||
      order.sourceMissing ||
      !order.fulfillmentInScope ||
      // Пока карантин открыт, заказ обязан оставаться NEW: собрать его нельзя.
      // Иной статус — знак, что заказ ушёл другим допустимым процессом.
      order.fulfillmentProcessState !== 'NEW';

    const now = new Date();
    // Атомарное закрытие: только если ещё активен (гонка двух возвратов).
    const closed = await tx.orderNoFlowersQuarantine.updateMany({
      where: { id: q.id, activeKey: { not: null } },
      data: unfit
        ? { activeKey: null, closedAt: now, closedReason: 'ORDER_NOT_FULFILLABLE' }
        : { activeKey: null, returnedAt: now, returnedById: actor.userId },
    });
    if (closed.count === 0) {
      // Кто-то успел закрыть раньше — идемпотентно ничего не делаем.
      return { returned: false, alreadyClosed: true, closedUnfit: false };
    }

    if (!unfit) {
      // В КОНЕЦ очереди: метку читают и отображение очереди, и авто-раздача.
      await tx.deliveryOrder.update({
        where: { id: q.orderId },
        data: { dispatchRequeuedAt: now },
      });
    }

    await writeAudit(tx, {
      action: unfit ? 'ORDER_NO_FLOWERS_CLOSED' : 'ORDER_NO_FLOWERS_RETURNED',
      entityType: 'DeliveryOrder',
      entityId: q.orderId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: unfit
        ? { quarantineId: q.id, closedReason: 'ORDER_NOT_FULFILLABLE' }
        : { quarantineId: q.id },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishRealtimeEvent(tx, {
      topic: 'order.no_flowers_changed',
      audienceRoles: [...NO_FLOWERS_ROLES],
      payload: { orderId: q.orderId },
    });
    if (!unfit) {
      await publishRealtimeEvent(tx, {
        topic: 'order.fulfillment_process_changed',
        audienceRoles: ['ADMIN', 'FLORIST', 'LOGISTICIAN', 'WAREHOUSE'],
        payload: { orderId: q.orderId },
      });
      await enqueueDispatch(tx);
    }

    return { returned: !unfit, alreadyClosed: false, closedUnfit: unfit };
  });
}
