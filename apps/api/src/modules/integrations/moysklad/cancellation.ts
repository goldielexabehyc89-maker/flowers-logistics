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
 * Отменён ли заказ в источнике по этому снимку.
 *
 * Идентификатор статуса приходит ЗНАЧЕНИЕМ из настройки окружения и в коде
 * не хранится: он принадлежит конкретному аккаунту МоегоСклада. Пустое
 * значение означает «распознавание отмен выключено» — и тогда отменённым
 * не считается ни один заказ, а не «считаются все».
 */
export function isCancelledInSource(
  snapshot: { externalStateId: string | null },
  cancelledStateId: string | null,
): boolean {
  if (cancelledStateId === null || snapshot.externalStateId === null) {
    return false;
  }
  return snapshot.externalStateId === cancelledStateId;
}

/**
 * Прочие статусы «неуспеха».
 *
 * Не отмена, но и не обычная работа: их состав нужно увидеть глазами, прежде
 * чем решать, как с ними обращаться. Функция отвечает на вопрос «это тот
 * случай, о котором стоит доложить», и ничего не меняет.
 */
export function isOtherUnsuccessful(
  snapshot: {
    externalStateId: string | null;
    externalStateType: string | null;
  },
  cancelledStateId: string | null,
): boolean {
  return (
    snapshot.externalStateType === 'Unsuccessful' &&
    !isCancelledInSource(snapshot, cancelledStateId)
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

  if (input.cancelled) {
    await markRouteCellPlacement(tx, input.orderId);
    await openCorrectionTaskIfDelivered(tx, input.orderId);
  } else {
    await returnToUnassigned(tx, input.orderId);
  }

  await writeAudit(tx, {
    action: input.cancelled ? 'ORDER_CANCELLED_IN_SOURCE' : 'ORDER_CANCELLATION_WITHDRAWN',
    entityType: 'DeliveryOrder',
    entityId: input.orderId,
    actorUserId: null,
    actorRoles: [],
    source: 'worker',
    // Идентификатор статуса в аудит не пишется: он одинаков для всех записей
    // и принадлежит настройке окружения, а не событию.
    newValue: { cancelledInSource: input.cancelled },
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

/**
 * Отменённый заказ, лежащий в МАРШРУТНОЙ ячейке, помечается к перемещению.
 *
 * Сам он никуда не едет: товар двигают руками. Но маршрутная ячейка означает
 * «готово к выдаче курьеру», и отменённый заказ обязан быть виден кладовщику
 * как требующий перемещения, а не стоять там молча до момента выдачи.
 */
async function markRouteCellPlacement(tx: TransactionClient, orderId: string): Promise<void> {
  const placement = await tx.orderPlacement.findFirst({
    where: { orderId, releasedAt: null, cell: { kind: 'ROUTE' } },
    select: { id: true, requiresRelocation: true },
  });
  if (placement === null || placement.requiresRelocation) {
    return;
  }
  await tx.orderPlacement.update({
    where: { id: placement.id },
    data: { requiresRelocation: true },
  });
}

/**
 * Отмена, пришедшая ПОСЛЕ доставки, задачей заканчивается, а не изменением.
 *
 * Букет у клиента, деньги, возможно, получены. Любое автоматическое действие
 * здесь было бы вымыслом: система не знает, вернули ли товар и что решили
 * с оплатой. Поэтому появляется задача логисту и администратору.
 */
async function openCorrectionTaskIfDelivered(
  tx: TransactionClient,
  orderId: string,
): Promise<void> {
  const delivered = await tx.deliveryAttempt.findFirst({
    where: { orderId, outcome: 'DELIVERED', activeKey: { not: null } },
    select: { id: true, routeOrderId: true, occurredAt: true },
  });
  if (delivered === null) {
    return;
  }

  // У заказа уже есть открытая задача — второй такой же не нужно.
  const active = await tx.orderResolution.findUnique({
    where: { activeKey: orderId },
    select: { id: true },
  });
  const sameAttempt = await tx.orderResolution.findUnique({
    where: { attemptId: delivered.id },
    select: { id: true },
  });
  if (active !== null || sameAttempt !== null) {
    return;
  }

  await tx.orderResolution.create({
    data: {
      orderId,
      routeOrderId: delivered.routeOrderId,
      attemptId: delivered.id,
      kind: 'CANCELLED_AFTER_DELIVERY',
      reasonNameSnapshot: 'Отменён в МоемСкладе после доставки',
      activeKey: orderId,
    },
  });

  await publishRealtimeEvent(tx, {
    topic: 'order.resolution_changed',
    payload: { orderId },
    audienceRoles: ['ADMIN', 'LOGISTICIAN'],
  });
}

/**
 * Снятие отмены возвращает заказ в БЕЗОПАСНОЕ нераспределённое состояние.
 *
 * Прежние маршрут, курьер, флорист и ячейка не восстанавливаются намеренно:
 * пока заказ был отменён, день ушёл вперёд — курьер уехал, лист закрылся,
 * ячейка занята другим. Участие в незакрытом маршруте закрывается, и заказ
 * снова появляется в «Сделках» как нераспределённый. Маршруты, где заказ уже
 * получил результат, не трогаются: их история неприкосновенна.
 */
async function returnToUnassigned(tx: TransactionClient, orderId: string): Promise<void> {
  const participations = await tx.routeOrder.findMany({
    where: {
      orderId,
      removedAt: null,
      route: { state: { in: ['DRAFT', 'CONFIRMED', 'ACTIVE'] } },
      attempts: { none: { activeKey: { not: null } } },
    },
    select: { id: true },
  });

  for (const participation of participations) {
    await tx.routeOrder.update({
      where: { id: participation.id },
      data: {
        removedAt: new Date(),
        removalReason: 'SOURCE_CANCELLATION_WITHDRAWN',
      },
    });
  }

  /*
   * Незавершённая сборка тоже отпускается.
   *
   * Флорист, за которым заказ числился до отмены, за это время занялся
   * другим: вернуть ему заказ молча значило бы записать работу на человека,
   * который о ней не знает. Заказ возвращается в общую очередь, и его берут
   * заново.
   *
   * Уже СОБРАННЫЙ заказ не трогается: букет физически существует, и делать
   * вид, что сборки не было, нельзя.
   */
  await tx.deliveryOrder.updateMany({
    where: { id: orderId, fulfillmentProcessState: 'IN_ASSEMBLY' },
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
    payload: { orderId },
    audienceRoles: ['ADMIN', 'FLORIST', 'LOGISTICIAN', 'WAREHOUSE'],
  });
}
