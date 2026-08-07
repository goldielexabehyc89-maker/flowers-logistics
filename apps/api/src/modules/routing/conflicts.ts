/**
 * Конфликты уже распределённых заказов.
 *
 * Синхронизация НЕ удаляет заказ из маршрута сама: молчаливое исключение лишило бы
 * логиста возможности заметить проблему, а маршрут внезапно изменился бы без участия
 * человека. Вместо этого участие сохраняется, а расхождение фиксируется отдельной
 * неизменяемой записью, видной через API.
 *
 * ПОРЯДОК БЛОКИРОВОК ДЛЯ ИМПОРТА отличается от пользовательского: импорт уже держит
 * строку `DeliveryOrder` и здесь только читает маршрут и добавляет конфликт. Блокировку
 * `DeliveryRoute` он не берёт намеренно — иначе появился бы обратный порядок
 * «Order → Route» против пользовательского «Route → Order», и встречные операции
 * встали бы намертво.
 *
 * Идемпотентность: пара (участие, вид) уникальна, поэтому повторный overlap-проход
 * не создаёт дубликат. Аудит и realtime отправляются только для НОВЫХ видов конфликта —
 * иначе каждые тридцать секунд логисты получали бы одно и то же уведомление.
 */

import type { $Enums } from '../../generated/prisma/client.js';
import type { TransactionClient } from '../auth/sessions.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import type { Role } from '@fl/shared';
import { calendarDate } from './eligibility.js';

const ROUTE_AUDIENCE: readonly Role[] = ['ADMIN', 'LOGISTICIAN'];

export type ConflictKind = $Enums.RouteOrderConflictKind;

/** Признаки заказа, по которым определяется расхождение с маршрутом. */
export interface ConflictSource {
  deliveryDate: Date | null;
  inScope: boolean;
  sourceArchived: boolean;
  sourceMissing: boolean;
}

/**
 * Какие расхождения есть у заказа прямо сейчас.
 *
 * Видов может быть несколько одновременно: заказ способен и сменить дату,
 * и выйти из области, и оказаться архивированным. Поэтому возвращается набор,
 * а не одно значение.
 */
export function conflictKindsFor(order: ConflictSource, routeDate: string): ConflictKind[] {
  const kinds: ConflictKind[] = [];

  if (order.deliveryDate === null || calendarDate(order.deliveryDate) !== routeDate) {
    kinds.push('DELIVERY_DATE_CHANGED');
  }
  if (!order.inScope) {
    kinds.push('SCOPE_LOST');
  }
  if (order.sourceArchived) {
    kinds.push('SOURCE_ARCHIVED');
  }
  if (order.sourceMissing) {
    kinds.push('SOURCE_MISSING');
  }

  return kinds;
}

/**
 * Фиксирует конфликты активного участия заказа.
 *
 * Вызывается из синхронизации внутри её транзакции. Если заказ не распределён,
 * не делает ничего.
 */
export async function recordOrderConflicts(
  tx: TransactionClient,
  orderId: string,
  order: ConflictSource,
): Promise<ConflictKind[]> {
  const participation = await tx.routeOrder.findFirst({
    where: { orderId, removedAt: null },
    select: {
      id: true,
      routeId: true,
      route: { select: { deliveryDate: true } },
      conflicts: { select: { kind: true } },
    },
  });

  if (participation === null) {
    return [];
  }

  const known = new Set(participation.conflicts.map((conflict) => conflict.kind));
  const kinds = conflictKindsFor(order, calendarDate(participation.route.deliveryDate));
  const fresh = kinds.filter((kind) => !known.has(kind));

  if (fresh.length === 0) {
    return [];
  }

  // skipDuplicates, а не отдельные create: нарушение уникальности прервало бы
  // всю транзакцию синхронизации из-за уже известного конфликта.
  await tx.routeOrderConflict.createMany({
    data: fresh.map((kind) => ({ routeOrderId: participation.id, kind })),
    skipDuplicates: true,
  });

  await writeAudit(tx, {
    action: 'ROUTE_ORDER_CONFLICT_DETECTED',
    entityType: 'DeliveryRoute',
    entityId: participation.routeId,
    actorUserId: null,
    source: 'worker',
    // Только идентификаторы и виды расхождения: адресов, получателей и денег нет.
    newValue: { orderId, routeOrderId: participation.id, kinds: fresh },
  });

  await publishRealtimeEvent(tx, {
    topic: 'route.conflict_detected',
    payload: { routeId: participation.routeId, orderIds: [orderId], kinds: fresh },
    audienceRoles: [...ROUTE_AUDIENCE],
  });

  return fresh;
}
