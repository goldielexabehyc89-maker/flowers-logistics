/**
 * Исходящая отметка об отмене заказа в МоемСкладе.
 *
 * Здесь проходит граница между НАШИМ решением и ЧУЖОЙ системой. Логист
 * отменяет заказ у нас — это действует немедленно и ни от какой сети
 * не зависит. Сообщить об этом МоемуСкладу — отдельная операция, у которой
 * своя судьба, и она обязана быть видимой:
 *
 * - запись наружу может быть запрещена настройкой контура (сегодня она
 *   запрещена везде: серверный клиент принимает только GET и HEAD);
 * - отправка может не дойти и потребовать повторов;
 * - повторная доставка того же сообщения не должна отменять заказ дважды.
 *
 * Поэтому сообщение кладётся в транзакционный outbox в ОДНОЙ транзакции
 * с решением логиста: откатилось решение — не осталось и сообщения. А то,
 * что случилось с отправкой, записывается в сам заказ и показывается
 * человеку без прикрас.
 */

import type { Database } from '../../../platform/db.js';
import type { TransactionClient } from '../../auth/sessions.js';
import type { AppLogger } from '../../../platform/logging/logger.js';
import type { OutboxHandler, OutboxMessageView } from '../../outbox/worker.js';
import { enqueueOutbox } from '../../outbox/producer.js';
import { writeAudit } from '../../audit/service.js';

/** Тема очереди. Значение живёт в `OUTBOX_TOPICS` и проверяется реестром. */
export const ORDER_CANCEL_TOPIC = 'moysklad.order_cancel';

/**
 * Транспорт отправки.
 *
 * Функция, а не клиент: настоящий сетевой вызов появится вместе с разрешением
 * писать наружу, а до тех пор подставляется либо `null` (запись запрещена),
 * либо поддельный транспорт в проверках. Ни один путь этого модуля не
 * обращается к сети сам.
 */
export type CancelTransport = (input: {
  externalId: string;
  orderId: string;
}) => Promise<{ alreadyCancelled: boolean }>;

/**
 * Ставит отметку в очередь.
 *
 * Ключ идемпотентности — сам заказ: сколько бы раз логист ни нажал «Отменить»,
 * наружу уйдёт одно сообщение. Полезная нагрузка содержит только
 * идентификаторы: ни адреса, ни получателя, ни телефона.
 */
export async function enqueueOrderCancel(
  tx: TransactionClient,
  input: { orderId: string; externalId: string; now: Date },
): Promise<{ created: boolean }> {
  const result = await enqueueOutbox(tx, {
    topic: ORDER_CANCEL_TOPIC,
    idempotencyKey: `moysklad-cancel:${input.orderId}`,
    payload: { orderId: input.orderId, externalId: input.externalId },
  });

  await tx.deliveryOrder.update({
    where: { id: input.orderId },
    data: { sourceCancelState: 'QUEUED', sourceCancelRequestedAt: input.now },
  });

  return result;
}

export interface CancelHandlerDeps {
  db: Database;
  logger: AppLogger;
  /** `null` означает «запись наружу запрещена»: это состояние, а не ошибка. */
  transport: CancelTransport | null;
  now?: () => Date;
}

/**
 * Обработчик очереди.
 *
 * Запрещённая запись НЕ считается сбоем: повторять её бессмысленно, и
 * складывать такие сообщения в DEAD значило бы объявлять поломкой обычную
 * настройку контура. Заказ получает состояние «наружу не ушло», сообщение
 * закрывается, и человек видит правду вместо ложного «отменён в МоемСкладе».
 */
export function createOrderCancelHandler(deps: CancelHandlerDeps): OutboxHandler {
  const clock = deps.now ?? ((): Date => new Date());

  return async (message: OutboxMessageView): Promise<void> => {
    const payload = (message.payload ?? {}) as { orderId?: unknown; externalId?: unknown };
    const orderId = typeof payload.orderId === 'string' ? payload.orderId : null;
    const externalId = typeof payload.externalId === 'string' ? payload.externalId : null;

    if (orderId === null || externalId === null) {
      throw new Error('сообщение об отмене не содержит идентификаторов заказа');
    }

    const now = clock();

    if (deps.transport === null) {
      await deps.db.$transaction(async (tx) => {
        await tx.deliveryOrder.update({
          where: { id: orderId },
          data: {
            sourceCancelState: 'BLOCKED',
            sourceCancelError: 'Запись в МойСклад запрещена настройкой контура',
          },
        });
        await writeAudit(tx, {
          action: 'ORDER_CANCEL_NOT_SENT',
          entityType: 'DeliveryOrder',
          entityId: orderId,
          actorUserId: null,
          actorRoles: [],
          source: 'worker',
          newValue: { sourceCancelState: 'BLOCKED' },
        });
      });
      deps.logger.info(
        { outbox: { id: message.id, topic: message.topic } },
        'отмена наружу не отправлена: запись запрещена настройкой',
      );
      return;
    }

    try {
      const result = await deps.transport({ externalId, orderId });
      await deps.db.$transaction(async (tx) => {
        await tx.deliveryOrder.update({
          where: { id: orderId },
          data: {
            sourceCancelState: 'SENT',
            sourceCancelSentAt: now,
            sourceCancelError: null,
          },
        });
        await writeAudit(tx, {
          action: 'ORDER_CANCEL_SENT',
          entityType: 'DeliveryOrder',
          entityId: orderId,
          actorUserId: null,
          actorRoles: [],
          source: 'worker',
          // Повтор доставки того же сообщения — обычное дело, и он виден.
          newValue: { alreadyCancelled: result.alreadyCancelled },
        });
      });
    } catch (error) {
      /*
       * Ошибка фиксируется В ЗАКАЗЕ и перебрасывается дальше.
       *
       * Первое нужно человеку: он видит, что отметка не ушла и почему.
       * Второе нужно очереди: без исключения сообщение считалось бы
       * обработанным, и повторов не было бы вовсе.
       */
      const text = error instanceof Error ? error.message : String(error);
      await deps.db.deliveryOrder.update({
        where: { id: orderId },
        data: { sourceCancelState: 'FAILED', sourceCancelError: text.slice(0, 500) },
      });
      throw error;
    }
  };
}
