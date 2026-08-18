/**
 * Жизнь привязки маршрутной ячейки к листу.
 *
 * Привязка — это заявление «полка занята вот этим листом». Она обязана
 * прекращаться ровно тогда, когда полка перестала быть занята, и НЕ раньше:
 *
 *  * отгрузка курьеру освобождает все ячейки листа — коробок на них больше нет;
 *  * отмена листа, возврат в черновик и исключение заказа привязку НЕ трогают:
 *    коробки физически продолжают стоять на полке, и «свободная» полка в
 *    интерфейсе означала бы, что туда можно положить чужой лист;
 *  * когда с полки уходит последняя коробка, привязка закрывается сама:
 *    держать за листом пустую полку не за что.
 *
 * Ручной кнопки освобождения нет намеренно. Кладовщику нечего решать: полка
 * либо занята коробками, либо нет, и это видно по самим коробкам.
 */

import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';

/**
 * Взять строку привязки полки под замок и перечитать её.
 *
 * Общая точка ожидания для двух работ, которые иначе не пересекаются:
 * кладовщик уносит с полки последнюю коробку, а второй в тот же миг ставит
 * на неё новую. Без общего замка первый видел бы полку пустой, второй —
 * занятой, и полка осталась бы с коробкой, но без листа.
 *
 * Замок берётся ПОСЛЕ заказа и размещения — в обеих дорожках одинаково,
 * поэтому встречного порядка ожидания не возникает.
 */
export async function lockRouteCellBinding(
  tx: TransactionClient,
  cellId: string,
): Promise<{ id: string; routeId: string } | null> {
  const rows = await tx.$queryRaw<{ id: string; routeId: string }[]>`
    SELECT "id", "routeId" FROM "RouteCellBinding"
    WHERE "cellId" = ${cellId}::uuid AND "releasedAt" IS NULL
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Закрыть привязку, если на полке не осталось действующих размещений.
 *
 * Вызывается ТОЛЬКО после того, как заказ ушёл с полки. Поэтому только что
 * назначенная и ещё не наполненная ячейка не закрывается: за ней просто не
 * происходило ухода.
 */
export async function releaseEmptyRouteBinding(
  tx: TransactionClient,
  actor: AuthenticatedActor,
  cellId: string,
  now: Date,
): Promise<boolean> {
  const binding = await lockRouteCellBinding(tx, cellId);
  if (binding === null) {
    return false;
  }

  const remaining = await tx.orderPlacement.count({
    where: { cellId, releasedAt: null },
  });
  if (remaining > 0) {
    return false;
  }

  await tx.routeCellBinding.update({
    where: { id: binding.id },
    data: { releasedAt: now, releasedById: actor.userId },
  });
  return true;
}
