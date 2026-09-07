/**
 * Единое исключение статуса «Новый» из рабочих очередей.
 *
 * Заказ в статусе источника «Новый» ещё не готов к операционной работе: он
 * импортируется, хранится и виден администратору, но не должен попадать ни в
 * одну очередь новой работы — ни во «Сделки», ни во флористскую очередь, ни в
 * «Ожидают выдачи»/«Ожидают приёмки». Исключение действует НЕЗАВИСИМО от
 * способа получения, канала продаж, Flowwow, признака операционного самовывоза
 * и статуса оплаты: «Новый» перекрывает любые исключения-послабления.
 *
 * Статус опознаётся ТОЛЬКО по UUID (`MOYSKLAD_NEW_STATE_ID`), а не по
 * отображаемому названию: название в аккаунте переименовывают, UUID стабилен.
 * UUID не зашивается в код — он приходит настройкой окружения. Пока переменная
 * не задана, предикаты пусты и поведение прежнее (без исключения).
 *
 * `IS DISTINCT FROM` / Prisma `not` оставляют заказы с неизвестным (NULL)
 * состоянием: исключается РОВНО заданный статус, а не всё, что не «Новый».
 */

import { Prisma } from '../../generated/prisma/client.js';

/**
 * Raw-SQL предикат «строка `o` — НЕ в статусе «Новый»».
 *
 * Требует алиас таблицы `o`. Без переменной — `TRUE` (прежнее поведение).
 * Применяется как `AND ${excludeNewStateSql(id)}`, как и соседние предикаты.
 */
export function excludeNewStateSql(newStateId: string | null | undefined): Prisma.Sql {
  return newStateId === null || newStateId === undefined || newStateId === ''
    ? Prisma.sql`TRUE`
    : Prisma.sql`o."externalStateId" IS DISTINCT FROM ${newStateId}::uuid`;
}

/**
 * Условие Prisma `where` «заказ НЕ в статусе «Новый»».
 *
 * Пустой объект без переменной — прежнее поведение. Prisma `not` оставляет
 * строки с NULL-состоянием, исключая ровно заданный статус.
 */
export function excludeNewStateWhere(
  newStateId: string | null | undefined,
): Prisma.DeliveryOrderWhereInput {
  if (newStateId === null || newStateId === undefined || newStateId === '') {
    return {};
  }
  return { externalStateId: { not: newStateId } };
}

/** Проверка в памяти: заказ находится в статусе «Новый». */
export function isNewState(
  order: { externalStateId: string | null },
  newStateId: string | null | undefined,
): boolean {
  if (newStateId === null || newStateId === undefined || newStateId === '') {
    return false;
  }
  return order.externalStateId === newStateId;
}
