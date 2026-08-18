/**
 * Отмена заказа в МоемСкладе.
 *
 * Признак берётся по ТОЧНОМУ идентификатору статуса, а не по типу
 * `Unsuccessful`. Тип объединяет разные события — отказ клиента, возврат,
 * брак, ошибку оформления, — и обращаться с ними одинаково значит обещать
 * поведение, которого никто не описывал. Первая версия распознаёт ровно
 * один статус «Отменен»; остальные статусы того же типа попадают в отчёт
 * отдельной строкой и молча к отмене не приравниваются.
 */

import type { TransactionClient } from '../../auth/sessions.js';
import { writeAudit } from '../../audit/service.js';
import { publishRealtimeEvent } from '../../realtime/events.js';

/**
 * Статус «Отменен» в МоемСкладе.
 *
 * Значение выдано владельцем и проверяется по идентификатору: название
 * администратор может переименовать в любой момент, а идентификатор — нет.
 */
export const CANCELLED_STATE_ID = '45533b00-2ea3-11ed-0a80-09c5000d6027';

/** Отменён ли заказ в источнике по этому снимку. */
export function isCancelledInSource(snapshot: { externalStateId: string | null }): boolean {
  return snapshot.externalStateId === CANCELLED_STATE_ID;
}

/**
 * Прочие статусы «неуспеха».
 *
 * Не отмена, но и не обычная работа: их состав нужно увидеть глазами, прежде
 * чем решать, как с ними обращаться. Функция отвечает на вопрос «это тот
 * случай, о котором стоит доложить», и ничего не меняет.
 */
export function isOtherUnsuccessful(snapshot: {
  externalStateId: string | null;
  externalStateType: string | null;
}): boolean {
  return (
    snapshot.externalStateType === 'Unsuccessful' && snapshot.externalStateId !== CANCELLED_STATE_ID
  );
}

/**
 * Отмечает заказ отменённым или снимает отметку.
 *
 * Ничего не двигает физически: заказ остаётся там, где лежит, а решение о
 * букете принимают люди. Снятие отмены возвращает заказ в работу
 * нераспределённым — прежние маршрут, курьер и флорист не восстанавливаются:
 * за время отмены день успел измениться.
 */
export async function applyCancellation(
  tx: TransactionClient,
  input: {
    orderId: string;
    cancelled: boolean;
    now: Date;
    previous: boolean;
  },
): Promise<boolean> {
  if (input.cancelled === input.previous) {
    return false;
  }

  await tx.deliveryOrder.update({
    where: { id: input.orderId },
    data: {
      cancelledInSource: input.cancelled,
      cancelledInSourceAt: input.cancelled ? input.now : null,
    },
  });

  await writeAudit(tx, {
    action: input.cancelled ? 'ORDER_CANCELLED_IN_SOURCE' : 'ORDER_CANCELLATION_WITHDRAWN',
    entityType: 'DeliveryOrder',
    entityId: input.orderId,
    actorUserId: null,
    actorRoles: [],
    source: 'worker',
    newValue: { cancelledInSource: input.cancelled, stateId: CANCELLED_STATE_ID },
  });

  /*
   * Событие видят все, кто показывает заказ.
   *
   * Отменённый заказ обязан покраснеть у флориста, склада и логиста без
   * перезагрузки: собирать и везти его больше нельзя.
   */
  await publishRealtimeEvent(tx, {
    topic: 'order.cancellation_changed',
    payload: { orderId: input.orderId, cancelled: input.cancelled },
    audienceRoles: ['ADMIN', 'LOGISTICIAN', 'FLORIST', 'WAREHOUSE', 'COURIER'],
  });

  return true;
}
