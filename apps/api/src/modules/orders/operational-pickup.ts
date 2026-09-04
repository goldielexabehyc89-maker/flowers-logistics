/**
 * Единый предикат ОПЕРАЦИОННОГО самовывоза.
 *
 * Заказ обрабатывается внутри ERP как самовывоз, если:
 *  · его способ получения — точный UUID «Самовывоз», ИЛИ
 *  · его канал продаж — Flowwow (`MOYSKLAD_FLOWWOW_SALES_CHANNEL_ID`).
 *
 * Канал Flowwow приходит из МоегоСклада способом получения «Доставка», но по
 * договорённости владельца обслуживается как самовывоз. Исходный
 * `deliveryMethodId` НЕ переписывается — значение источника сохраняется для
 * истории и повторной синхронизации; операционный самовывоз выводится ЗДЕСЬ и
 * только здесь, чтобы проверки не расползались по экранам. Канал опознаётся
 * ТОЛЬКО по идентификатору (не по названию/регистру/частичному совпадению).
 *
 * Flowwow опознаётся отдельной переменной, НЕ связанной с
 * `DEALS_EXCLUDED_SALES_CHANNEL_ID`: из «Сделок» в будущем могут исключаться и
 * другие каналы, а семантику самовывоза несёт именно Flowwow.
 */

import { Prisma } from '../../generated/prisma/client.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';

const PICKUP_METHOD_ID = MOYSKLAD_IDS.deliveryMethodPickup;

/** Проверка в памяти: заказ — операционный самовывоз. */
export function isOperationalPickup(
  order: { deliveryMethodId: string | null; salesChannelId: string | null },
  flowwowChannelId: string | undefined,
): boolean {
  if (order.deliveryMethodId === PICKUP_METHOD_ID) {
    return true;
  }
  return flowwowChannelId !== undefined && order.salesChannelId === flowwowChannelId;
}

/**
 * Raw-SQL фрагмент «строка `o` — операционный самовывоз».
 *
 * Требует алиас таблицы `o`. Без Flowwow-переменной сводится к сравнению
 * способа получения — поведение прежнее.
 */
export function operationalPickupSql(flowwowChannelId: string | undefined): Prisma.Sql {
  if (flowwowChannelId === undefined) {
    return Prisma.sql`(o."deliveryMethodId" = ${PICKUP_METHOD_ID}::uuid)`;
  }
  return Prisma.sql`(o."deliveryMethodId" = ${PICKUP_METHOD_ID}::uuid OR o."salesChannelId" = ${flowwowChannelId}::uuid)`;
}

/**
 * OR-условия Prisma для where-объектов (не raw): заказ — операционный самовывоз.
 *
 * Возвращает массив альтернатив для `OR`: способ-самовывоз ИЛИ канал Flowwow.
 */
export function operationalPickupOr(
  flowwowChannelId: string | undefined,
): Prisma.DeliveryOrderWhereInput[] {
  const clauses: Prisma.DeliveryOrderWhereInput[] = [{ deliveryMethodId: PICKUP_METHOD_ID }];
  if (flowwowChannelId !== undefined) {
    clauses.push({ salesChannelId: flowwowChannelId });
  }
  return clauses;
}

/**
 * Raw-SQL исключение Flowwow из «Сделок»/маршрутизации.
 *
 * Именно Flowwow, а НЕ весь операционный самовывоз: обычный самовывоз из
 * «Сделок» этим не трогается (его поведение сохраняется). `IS DISTINCT FROM`
 * оставляет заказы с неизвестным (NULL) каналом. Без переменной — `TRUE`.
 */
export function notFlowwowSql(flowwowChannelId: string | undefined): Prisma.Sql {
  return flowwowChannelId === undefined
    ? Prisma.sql`TRUE`
    : Prisma.sql`o."salesChannelId" IS DISTINCT FROM ${flowwowChannelId}::uuid`;
}
