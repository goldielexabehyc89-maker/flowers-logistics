/**
 * Накопление вперёд для статистики смен флориста.
 *
 * Два показателя нельзя восстановить задним числом: был ли простой «с доступной
 * очередью» или «без очереди», и сколько стоил заказ В МОМЕНТ сборки. Очередь
 * считается «сейчас», а сумма заказа переписывается синхронизацией. Поэтому оба
 * значения фиксируются вперёд неизменяемо: доступность очереди — переходами в
 * {@link recordQueueAvailability}, деньги — в аудите сборки заказа.
 *
 * Восстанавливать выдуманные простои и суммы запрещено: до появления первой
 * записи показатели помечаются неполными, а не заполняются нулями или догадками.
 */

import type { TransactionClient } from '../auth/sessions.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { OPERATIONS_START_DATE } from '../orders/operations-window.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';

/**
 * Признак доступной к взятию строки в ОБЩЕЙ очереди флориста.
 *
 * Те же условия, что и у очереди (`queue-service` → `buildScopeWhere`), плюс
 * состояние `NEW`: доступно ровно то, что флорист мог бы взять прямо сейчас.
 * Граница операционной даты берётся продакшн-значением: пользовательские
 * действия идут именно с ним, а не с ослабленной проверочной границей.
 */
export function queueAvailabilityWhere() {
  return {
    fulfillmentInScope: true,
    sourceArchived: false,
    sourceMissing: false,
    fulfillmentCompositionState: 'READY' as const,
    fulfillmentProcessState: 'NEW' as const,
    AND: [
      {
        OR: [
          { externalStateId: null },
          { externalStateId: { not: MOYSKLAD_IDS.states.acceptedUnpaid } },
        ],
      },
      {
        OR: [
          { deliveryDate: null },
          { deliveryDate: { gte: toDateColumn(OPERATIONS_START_DATE) } },
        ],
      },
    ],
  };
}

/**
 * Фиксирует переход доступности очереди, если булев признак изменился.
 *
 * Вызывается в тех же транзакциях, что и операции, меняющие состав очереди:
 * взятие (строка уходит из NEW), возврат в работу с высвобождением (строка
 * возвращается) и импорт (строки появляются и исчезают). Существование строки
 * проверяется `findFirst` (EXISTS), а не полным подсчётом — это дёшево даже на
 * большой базе. Между переходами доступность считается неизменной.
 */
export async function recordQueueAvailability(tx: TransactionClient): Promise<void> {
  const found = await tx.deliveryOrder.findFirst({
    where: queueAvailabilityWhere(),
    select: { id: true },
  });
  const available = found !== null;

  const last = await tx.floristQueueAvailabilityEvent.findFirst({
    orderBy: { occurredAt: 'desc' },
    select: { available: true },
  });

  if (last === null || last.available !== available) {
    await tx.floristQueueAvailabilityEvent.create({ data: { available } });
  }
}
