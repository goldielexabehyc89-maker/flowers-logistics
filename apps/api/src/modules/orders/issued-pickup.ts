/**
 * Единый серверный признак «заказ уже выдан покупателю».
 *
 * Основа — существование `OrderPickupIssue`: он фиксирует факт передачи заказа
 * покупателю НАВСЕГДА, независимо от способа выдачи (SCAN/CARD/MANUAL), наличия
 * ячейки, текущего внутреннего состояния и круга сборки, последующих изменений
 * состава/статуса и способа получения в источнике (в т.ч. Flowwow, выданный как
 * операционный самовывоз). Название статуса МоегоСклада основанием НЕ является.
 *
 * Выданный заказ не может снова стать производственной работой флориста. Правило
 * одно на все связанные операции; фронт отдельного фильтра не заводит.
 */

import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';

/**
 * Условие Prisma «заказ ещё НЕ выдан покупателю» (нет ни одной записи выдачи).
 *
 * Встраивается в where свободной очереди/поиска/счётчиков/автораздачи/захвата
 * рядом с прочими ограничениями допуска — как единое правило.
 */
export const NOT_ISSUED_WHERE: Prisma.DeliveryOrderWhereInput = {
  // `OrderPickupIssue.orderId` уникален: у заказа не более одной выдачи, и
  // связь со стороны заказа — одиночная необязательная `pickupIssue`.
  // `null` означает «записи выдачи нет» — заказ ещё не выдан покупателю.
  pickupIssue: null,
};

/**
 * Выдан ли заказ. Строка заказа берётся `FOR UPDATE`, чтобы проверка не
 * разошлась с одновременной выдачей: конкурентная выдача либо уже видна здесь,
 * либо ждёт снятия блокировки и увидит наше действие.
 */
export async function isIssuedLocked(tx: TransactionClient, orderId: string): Promise<boolean> {
  await tx.$queryRaw`SELECT "id" FROM "DeliveryOrder" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
  const issued = await tx.orderPickupIssue.count({ where: { orderId } });
  return issued > 0;
}

/**
 * Отклоняет производственное действие над уже выданным заказом.
 *
 * Вызывается под блокировкой строки заказа в той же транзакции, что и само
 * действие (возврат в работу, пересборка, «Нет товара»). Сообщение и код едины,
 * чтобы устаревшая кнопка или прямой запрос получали один и тот же понятный
 * отказ.
 */
export async function assertNotIssued(tx: TransactionClient, orderId: string): Promise<void> {
  if (await isIssuedLocked(tx, orderId)) {
    throw new AppError('CONFLICT', {
      message: 'order already issued to customer',
      publicMessage: 'Заказ уже выдан покупателю.',
      conflict: { kind: 'ORDER_ALREADY_ISSUED', orderIds: [orderId] },
    });
  }
}
