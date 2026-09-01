/**
 * Сервис вкладки «Уведомления» логистов.
 *
 * Список и счётчик, персональные отметки прочтения и глобальное идемпотентное
 * решение «На пересборку». Само уведомление создаётся импортом (см.
 * `change-notify.ts`); здесь только чтение, персональная отметка и решение.
 *
 * Текущее состояние заказа вычисляется НА МОМЕНТ запроса по актуальным данным
 * (размещения, маршруты, курьер), а не берётся из устаревшего снимка.
 */

import type { Database } from '../../platform/db.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { AppError } from '../../platform/errors.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { assignReassemblyTx } from '../fulfillment/assembly.js';
import { listAssignableFlorists } from '../fulfillment/shifts.js';
import { NOTIFICATION_AUDIENCE } from './change-notify.js';

type Db = Database | TransactionClient;

/** Роли, которым доступна вкладка и её API. */
export const NOTIFICATION_ROLES = ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'] as const;

/**
 * Текущее физическое/процессное состояние заказа — вычисляется вживую.
 *
 * `kind` — самое конкретное состояние; сопутствующие поля уточняют его (номер
 * ячейки, номер и состояние листа, курьер). Минимум, который гарантируется:
 * всегда ясно, в маршрутном ли листе заказ и в каком именно.
 */
export interface OrderStateView {
  kind:
    | 'UNASSIGNED'
    | 'WITH_FLORIST'
    | 'AWAITING_INTAKE'
    | 'IN_STORAGE_CELL'
    | 'IN_ROUTE_CELL'
    | 'IN_ROUTE'
    | 'WITH_COURIER'
    | 'DELIVERED'
    | 'CANCELLED'
    | 'WRITTEN_OFF';
  cellCode?: string;
  routeNumber?: string;
  routeState?: string;
  courierName?: string;
}

export async function computeOrderState(db: Db, orderId: string): Promise<OrderStateView> {
  const order = await db.deliveryOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      fulfillmentProcessState: true,
      cancelledInSource: true,
      cancelledByLogistAt: true,
    },
  });

  if (order.cancelledInSource || order.cancelledByLogistAt !== null) {
    return { kind: 'CANCELLED' };
  }

  const placement = await db.orderPlacement.findFirst({
    where: { orderId, releasedAt: null },
    select: { cell: { select: { code: true, kind: true } } },
  });
  const writeOff = await db.orderPlacement.findFirst({
    where: { orderId, withdrawReason: 'WRITE_OFF' },
    select: { id: true },
  });
  if (placement === null && writeOff !== null) {
    return { kind: 'WRITTEN_OFF' };
  }

  const routeOrder = await db.routeOrder.findFirst({
    where: { orderId, removedAt: null },
    select: {
      route: { select: { number: true, state: true, courier: { select: { fullName: true } } } },
    },
    orderBy: { addedAt: 'desc' },
  });
  const route = routeOrder?.route ?? null;

  // Заказ стоит в маршрутной ячейке — самое конкретное «в листе».
  if (placement !== null && placement.cell.kind === 'ROUTE') {
    return {
      kind: 'IN_ROUTE_CELL',
      cellCode: placement.cell.code,
      ...(route === null ? {} : { routeNumber: route.number, routeState: route.state }),
    };
  }

  if (route !== null) {
    if (route.state === 'ACTIVE') {
      return {
        kind: 'WITH_COURIER',
        routeNumber: route.number,
        ...(route.courier === null ? {} : { courierName: route.courier.fullName }),
      };
    }
    if (route.state === 'COMPLETED') {
      return { kind: 'DELIVERED', routeNumber: route.number };
    }
    return { kind: 'IN_ROUTE', routeNumber: route.number, routeState: route.state };
  }

  if (placement !== null) {
    return { kind: 'IN_STORAGE_CELL', cellCode: placement.cell.code };
  }

  if (order.fulfillmentProcessState === 'ASSEMBLED') {
    return { kind: 'AWAITING_INTAKE' };
  }
  if (
    order.fulfillmentProcessState === 'IN_ASSEMBLY' ||
    order.fulfillmentProcessState === 'NEEDS_REVIEW'
  ) {
    return { kind: 'WITH_FLORIST' };
  }
  return { kind: 'UNASSIGNED' };
}

export interface NotificationView {
  id: string;
  orderId: string;
  orderNumber: string;
  occurredAt: string;
  source: string;
  categories: string[];
  kind: string;
  payload: unknown;
  read: boolean;
  currentState: OrderStateView;
  decision: {
    assignedFloristId: string;
    assignedFloristName: string;
    decidedByName: string;
    assemblyRound: number;
    decidedAt: string;
  } | null;
}

const LIST_LIMIT = 100;

export async function listNotifications(
  db: Database,
  input: { userId: string; limit?: number; offset?: number },
): Promise<{ items: NotificationView[]; total: number; unread: number }> {
  const limit = Math.min(input.limit ?? LIST_LIMIT, LIST_LIMIT);
  const offset = input.offset ?? 0;

  const [total, unread, rows] = await Promise.all([
    db.orderChangeNotification.count(),
    countUnread(db, input.userId),
    db.orderChangeNotification.findMany({
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: offset,
      select: {
        id: true,
        orderId: true,
        occurredAt: true,
        source: true,
        categories: true,
        kind: true,
        payload: true,
        order: { select: { externalName: true } },
        reads: { where: { userId: input.userId }, select: { id: true } },
        decision: {
          select: {
            assignedFloristId: true,
            assemblyRound: true,
            decidedAt: true,
            assignedFlorist: { select: { fullName: true } },
            decidedBy: { select: { fullName: true } },
          },
        },
      },
    }),
  ]);

  const items = await Promise.all(
    rows.map(async (row): Promise<NotificationView> => {
      const currentState = await computeOrderState(db, row.orderId);
      return {
        id: row.id,
        orderId: row.orderId,
        orderNumber: row.order.externalName,
        occurredAt: row.occurredAt.toISOString(),
        source: row.source,
        categories: row.categories,
        kind: row.kind,
        payload: row.payload,
        read: row.reads.length > 0,
        currentState,
        decision:
          row.decision === null
            ? null
            : {
                assignedFloristId: row.decision.assignedFloristId,
                assignedFloristName: row.decision.assignedFlorist.fullName,
                decidedByName: row.decision.decidedBy.fullName,
                assemblyRound: row.decision.assemblyRound,
                decidedAt: row.decision.decidedAt.toISOString(),
              },
      };
    }),
  );

  return { items, total, unread };
}

/** Одно уведомление с живым состоянием заказа — для всплывающего окна. */
export async function getNotification(
  db: Database,
  input: { userId: string; id: string },
): Promise<NotificationView | null> {
  const row = await db.orderChangeNotification.findUnique({
    where: { id: input.id },
    select: {
      id: true,
      orderId: true,
      occurredAt: true,
      source: true,
      categories: true,
      kind: true,
      payload: true,
      order: { select: { externalName: true } },
      reads: { where: { userId: input.userId }, select: { id: true } },
      decision: {
        select: {
          assignedFloristId: true,
          assemblyRound: true,
          decidedAt: true,
          assignedFlorist: { select: { fullName: true } },
          decidedBy: { select: { fullName: true } },
        },
      },
    },
  });
  if (row === null) {
    return null;
  }
  const currentState = await computeOrderState(db, row.orderId);
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.order.externalName,
    occurredAt: row.occurredAt.toISOString(),
    source: row.source,
    categories: row.categories,
    kind: row.kind,
    payload: row.payload,
    read: row.reads.length > 0,
    currentState,
    decision:
      row.decision === null
        ? null
        : {
            assignedFloristId: row.decision.assignedFloristId,
            assignedFloristName: row.decision.assignedFlorist.fullName,
            decidedByName: row.decision.decidedBy.fullName,
            assemblyRound: row.decision.assemblyRound,
            decidedAt: row.decision.decidedAt.toISOString(),
          },
  };
}

/** Непрочитанные для пользователя: нет строки прочтения именно у него. */
export async function countUnread(db: Db, userId: string): Promise<number> {
  return db.orderChangeNotification.count({
    where: { reads: { none: { userId } } },
  });
}

/** Персональная отметка прочтения. Идемпотентна; чужие отметки не трогает. */
export async function markRead(
  db: Database,
  actor: AuthenticatedActor,
  notificationId: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const existing = await tx.orderChangeNotificationRead.findUnique({
      where: { notificationId_userId: { notificationId, userId: actor.userId } },
      select: { id: true },
    });
    if (existing !== null) {
      return;
    }
    // Ссылочная целостность: уведомление должно существовать.
    const notification = await tx.orderChangeNotification.findUnique({
      where: { id: notificationId },
      select: { id: true },
    });
    if (notification === null) {
      throw new AppError('NOT_FOUND', { message: 'notification not found' });
    }
    await tx.orderChangeNotificationRead.create({
      data: { notificationId, userId: actor.userId },
    });
    // Счётчик обновляется у самого пользователя без F5.
    await publishRealtimeEvent(tx, {
      topic: 'notification.read',
      audienceUserId: actor.userId,
      payload: { notificationId },
    });
  });
}

export interface DecisionResult {
  created: boolean;
  assignedFloristId: string;
  assignedFloristName: string;
  assemblyRound: number;
}

/**
 * Глобальное идемпотентное решение «На пересборку».
 *
 * Одно решение на уведомление: повторное нажатие и гонка двух логистов не
 * создают две пересборки. Назначение нового круга выбранному флористу и запись
 * решения идут одной транзакцией; проигравший в гонке видит уже назначенного
 * флориста. Физическое состояние заказа при этом не трогается.
 */
export async function decideReassembly(
  db: Database,
  actor: AuthenticatedActor,
  input: { notificationId: string; floristId: string },
  context: { ip: string | null; userAgent: string | null },
): Promise<DecisionResult> {
  const asView = (decision: {
    assignedFloristId: string;
    assemblyRound: number;
    assignedFlorist: { fullName: string };
  }): DecisionResult => ({
    created: false,
    assignedFloristId: decision.assignedFloristId,
    assignedFloristName: decision.assignedFlorist.fullName,
    assemblyRound: decision.assemblyRound,
  });

  const existing = await db.orderReassemblyDecision.findUnique({
    where: { notificationId: input.notificationId },
    select: {
      assignedFloristId: true,
      assemblyRound: true,
      assignedFlorist: { select: { fullName: true } },
    },
  });
  if (existing !== null) {
    return asView(existing);
  }

  const notification = await db.orderChangeNotification.findUnique({
    where: { id: input.notificationId },
    select: { id: true, orderId: true, kind: true, categories: true },
  });
  if (notification === null) {
    throw new AppError('NOT_FOUND', { message: 'notification not found' });
  }
  if (notification.kind !== 'COMPOSITION_AFTER_ASSEMBLY') {
    throw new AppError('VALIDATION_FAILED', {
      message: 'notification does not offer reassembly',
      publicMessage: 'Это уведомление не предлагает пересборку.',
    });
  }

  try {
    return await db.$transaction(async (tx) => {
      const assigned = await assignReassemblyTx(
        tx,
        actor,
        { orderId: notification.orderId, floristId: input.floristId },
        context,
      );
      const decision = await tx.orderReassemblyDecision.create({
        data: {
          notificationId: notification.id,
          orderId: notification.orderId,
          decidedById: actor.userId,
          assignedFloristId: input.floristId,
          assemblyRound: assigned.assemblyRound,
        },
        select: {
          assignedFloristId: true,
          assemblyRound: true,
          assignedFlorist: { select: { fullName: true } },
        },
      });
      // Аудит без ПДн: кто решил, кому назначено, круг и какие категории.
      await writeAudit(tx, {
        action: 'ORDER_REASSEMBLY_DECIDED',
        entityType: 'OrderChangeNotification',
        entityId: notification.id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        source: 'api',
        newValue: {
          orderId: notification.orderId,
          assignedFloristId: input.floristId,
          assemblyRound: assigned.assemblyRound,
          categories: notification.categories,
        },
        ip: context.ip,
        userAgent: context.userAgent,
      });
      // Список обновляется у всех логистов: видно назначенного флориста.
      await publishRealtimeEvent(tx, {
        topic: 'notification.decided',
        audienceRoles: [...NOTIFICATION_AUDIENCE],
        payload: { notificationId: notification.id, orderId: notification.orderId },
      });
      return { ...asView(decision), created: true };
    });
  } catch (error) {
    // Гонка: победитель уже записал решение по этому уведомлению.
    const now = await db.orderReassemblyDecision.findUnique({
      where: { notificationId: input.notificationId },
      select: {
        assignedFloristId: true,
        assemblyRound: true,
        assignedFlorist: { select: { fullName: true } },
      },
    });
    if (now !== null) {
      return asView(now);
    }
    throw error;
  }
}

/** Флористы, доступные для назначения пересборки (на активной смене). */
export async function listReassemblyFlorists(
  db: Database,
): Promise<{ id: string; fullName: string; openAssignments: number }[]> {
  const florists = await listAssignableFlorists(db);
  return florists.map((florist) => ({
    id: florist.userId,
    fullName: florist.fullName,
    openAssignments: florist.openAssignments,
  }));
}
