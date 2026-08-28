/**
 * Самовывоз: выдача заказа покупателю — этап 6.7.
 *
 * Отдельный модуль, а не ветка складского движения. Причина не в удобстве
 * файлов: у выдачи покупателю другой исполнитель (`MANAGER`), другой предмет
 * (человек пришёл сам, маршрута нет) и другое право. Кладовщик кладёт коробку
 * на полку, менеджер отдаёт её из-за прилавка — и разрешать одному делать
 * работу другого только потому, что обе операции трогают `OrderPlacement`,
 * значило бы выдавать заказы тому, кто не отвечает за выдачу.
 *
 * Что здесь общее со складом: `OrderPlacement` — единственный источник правды
 * о том, где лежит заказ. Выдача закрывает активное размещение отдельной
 * причиной и оставляет всю историю ячейки нетронутой.
 *
 * Чего здесь нет намеренно: скана ячейки и проверки личности получателя
 * (`FUL-003` п.8) — владелец решил, что номера заказа достаточно; маршрута
 * и маршрутной ячейки — самовывоз по ним не ездит; записи в МойСклад —
 * это отдельный этап 6.8.
 *
 * Порядок блокировок: `DeliveryOrder → OrderPlacement`. Тот же, что у приёмки,
 * и встречного `Route → Order` здесь не бывает вовсе.
 */

import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { resolveOrderByNumber } from '../warehouse/order-lookup.js';
import { readWarehouseManualEntry } from '../settings/service.js';

/** Выдачу самовывоза выполняет менеджер; администратор — тоже. */
export const PICKUP_ROLES = ['ADMIN', 'MANAGER', 'SUPERVISOR'] as const;

/** Кому адресованы события раздела. Кладовщика здесь нет: выдача не его работа. */
export const PICKUP_AUDIENCE = ['ADMIN', 'MANAGER'] as const;

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface PickupDeps {
  db: Database;
}

/**
 * Самовывоз ли это.
 *
 * Опознаётся ТОЛЬКО точным UUID значения справочника. Вывод «не доставка,
 * но в производственной области» неверен: у части заказов способ получения
 * не указан вовсе либо указан третьим значением, и все они попали бы в раздел
 * выдачи покупателю (`FUL-005`).
 */
export function isPickupOrder(order: {
  deliveryMethodId: string | null;
  fulfillmentInScope: boolean;
}): boolean {
  return order.deliveryMethodId === MOYSKLAD_IDS.deliveryMethodPickup && order.fulfillmentInScope;
}

/**
 * Каким действием менеджер отдал коробку.
 *
 * Различие не косметическое: ручная выдача разрешена только при включённой
 * общей настройке, и сервер обязан проверить это сам, а не полагаться на
 * спрятанную кнопку.
 */
export type PickupIssueSource = 'SCAN' | 'MANUAL';

export interface PickupIssueInput {
  orderNumber: string;
  source: PickupIssueSource;
}

export interface PickupIssueResult {
  orderId: string;
  orderNumber: string;
  issueId: string;
  cellId: string;
  cellCode: string;
  issuedAt: string;
}

interface LockedOrder {
  id: string;
  number: string;
  deliveryMethodId: string | null;
  fulfillmentInScope: boolean;
  sourceArchived: boolean;
  sourceMissing: boolean;
  cancelledInSource: boolean;
  cancelledByLogistAt: Date | null;
}

/**
 * Блокирует строку заказа на всю транзакцию.
 *
 * Между проверкой «размещение активно» и его закрытием не должен вклиниться
 * ни второй менеджер, ни кладовщик с перемещением: иначе выдача закрыла бы
 * запись, которой уже нет, либо два человека отдали бы одну коробку.
 */
async function lockOrder(tx: TransactionClient, orderId: string): Promise<LockedOrder> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      externalName: string;
      deliveryMethodId: string | null;
      fulfillmentInScope: boolean;
      sourceArchived: boolean;
      sourceMissing: boolean;
      cancelledInSource: boolean;
      cancelledByLogistAt: Date | null;
    }[]
  >`
    SELECT "id", "externalName", "deliveryMethodId", "fulfillmentInScope",
           "sourceArchived", "sourceMissing", "cancelledInSource", "cancelledByLogistAt"
    FROM "DeliveryOrder"
    WHERE "id" = ${orderId}::uuid
    FOR UPDATE
  `;

  const row = rows[0];
  if (row === undefined) {
    throw new AppError('NOT_FOUND', { message: 'order not found' });
  }
  return {
    id: row.id,
    number: row.externalName,
    deliveryMethodId: row.deliveryMethodId,
    fulfillmentInScope: row.fulfillmentInScope,
    sourceArchived: row.sourceArchived,
    sourceMissing: row.sourceMissing,
    cancelledInSource: row.cancelledInSource,
    cancelledByLogistAt: row.cancelledByLogistAt,
  };
}

function assertIssuable(order: LockedOrder): void {
  /*
   * Способ получения проверяется ПЕРВЫМ и отдельно от области.
   *
   * Архивный самовывоз выходит из производственной области, но самовывозом
   * быть не перестаёт: сказать про него «это не самовывоз» значило бы
   * отправить менеджера искать курьера, которого нет.
   */
  if (order.deliveryMethodId !== MOYSKLAD_IDS.deliveryMethodPickup) {
    throw new AppError('CONFLICT', {
      message: 'order is not a pickup order',
      publicMessage: 'Это не самовывозный заказ: его везёт курьер.',
      conflict: { kind: 'ORDER_NOT_PICKUP' },
    });
  }

  /*
   * Отмена сильнее всего остального.
   *
   * Признак нормализованный: его пишут и импорт, и решение логиста. Сравнивать
   * названия статусов нельзя — они меняются в справочнике, а коробка уезжает
   * покупателю навсегда.
   */
  if (order.cancelledInSource || order.cancelledByLogistAt !== null) {
    throw new AppError('CONFLICT', {
      message: 'order is cancelled',
      publicMessage: 'Заказ отменён — выдавать нельзя.',
      conflict: { kind: 'ORDER_CANCELLED' },
    });
  }

  // Пропавший, архивный и выпавший из производства — повод остановиться
  // и разобраться: такой заказ мог быть отменён, и отдавать его нельзя.
  if (order.sourceArchived || order.sourceMissing || !order.fulfillmentInScope) {
    throw new AppError('CONFLICT', {
      message: 'order source is archived or missing',
      publicMessage: 'Заказ помечен проблемным. Обратитесь к администратору.',
      conflict: { kind: 'ORDER_BLOCKED' },
    });
  }
}

/**
 * «Выдан покупателю».
 *
 * Одна транзакция: неизменяемый факт выдачи, закрытие активного размещения
 * отдельной причиной, аудит и событие. Частичного результата не бывает —
 * иначе коробка ушла бы с полки, не оставив следа, кто её отдал.
 */
export async function issueToCustomer(
  deps: PickupDeps,
  actor: AuthenticatedActor,
  input: PickupIssueInput,
  context: RequestContext,
): Promise<PickupIssueResult> {
  try {
    return await deps.db.$transaction(async (tx: TransactionClient) => {
      /*
       * Ручная выдача разрешается общей настройкой, и проверяется она ЗДЕСЬ.
       *
       * Спрятанная кнопка защитой не является: прямой запрос обошёл бы её
       * за секунду. Сканирование от настройки не зависит — оно и есть
       * обычный способ работы.
       */
      if (input.source === 'MANUAL') {
        const manual = await readWarehouseManualEntry(tx);
        if (!manual.value.enabled) {
          throw new AppError('CONFLICT', {
            message: 'manual pickup issue is disabled',
            publicMessage: 'Ручная выдача выключена. Отсканируйте QR-код заказа.',
            conflict: { kind: 'MANUAL_ENTRY_DISABLED' },
          });
        }
      }

      const resolved = await resolveOrderByNumber(tx, input.orderNumber);
      const order = await lockOrder(tx, resolved.id);
      assertIssuable(order);

      const already = await tx.orderPickupIssue.findUnique({
        where: { orderId: order.id },
        select: { id: true, issuedAt: true },
      });
      if (already !== null) {
        throw new AppError('CONFLICT', {
          message: 'pickup order already issued',
          publicMessage: 'Заказ уже выдан покупателю.',
          conflict: { kind: 'PICKUP_ALREADY_ISSUED' },
        });
      }

      const placement = await tx.orderPlacement.findFirst({
        where: { orderId: order.id, releasedAt: null },
        select: { id: true, cell: { select: { id: true, code: true } } },
      });
      if (placement === null) {
        throw new AppError('CONFLICT', {
          message: 'order has no active placement',
          publicMessage: 'Заказ не находится в ячейке: коробки на полке нет.',
          conflict: { kind: 'ORDER_NOT_PLACED' },
        });
      }

      const now = new Date();

      await tx.orderPlacement.update({
        where: { id: placement.id },
        data: {
          releasedAt: now,
          releasedById: actor.userId,
          releaseReason: 'ISSUED_TO_CUSTOMER',
        },
      });

      const issue = await tx.orderPickupIssue.create({
        data: {
          orderId: order.id,
          placementId: placement.id,
          cellId: placement.cell.id,
          issuedAt: now,
          issuedById: actor.userId,
        },
        select: { id: true, issuedAt: true },
      });

      await writeAudit(tx, {
        action: 'PICKUP_ORDER_ISSUED',
        entityType: 'OrderPickupIssue',
        entityId: issue.id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        source: 'api',
        oldValue: null,
        // Ни номера заказа, ни кода полки, ни получателя: только идентификаторы
        // и способ действия.
        newValue: {
          orderId: order.id,
          placementId: placement.id,
          cellId: placement.cell.id,
          source: input.source,
        },
        ip: context.ip,
        userAgent: context.userAgent,
      });

      await publishRealtimeEvent(tx, {
        topic: 'pickup.issued',
        audienceRoles: [...PICKUP_AUDIENCE],
        payload: { orderId: order.id },
      });

      return {
        orderId: order.id,
        orderNumber: order.number,
        issueId: issue.id,
        cellId: placement.cell.id,
        cellCode: placement.cell.code,
        issuedAt: issue.issuedAt.toISOString(),
      };
    });
  } catch (error) {
    // Гонку двух одновременных выдач ловит уникальный индекс базы, а не
    // предварительная проверка: параллельные транзакции не видят
    // незафиксированных вставок друг друга. Проигравший получает тот же
    // штатный конфликт, что и обычный повтор.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError('CONFLICT', {
        message: 'pickup order already issued',
        publicMessage: 'Заказ уже выдан покупателю.',
        conflict: { kind: 'PICKUP_ALREADY_ISSUED' },
      });
    }
    throw error;
  }
}
