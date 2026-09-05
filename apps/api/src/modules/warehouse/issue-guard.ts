/**
 * Признак начавшейся выдачи маршрута.
 *
 * Вынесен в отдельный модуль намеренно: его нужен и складской поток, и модули
 * маршрутов (`lifecycle`, `service`), а сам складской поток пользуется общей
 * проверкой допустимости курьера из модуля маршрутов. Держать охранник рядом
 * с потоком означало бы замкнуть импорты в цикл и лечить его динамическими
 * импортами в горячем пути.
 *
 * Здесь нет ничего, кроме чтения фактов о выдаче.
 */

import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';

/**
 * Началась ли по маршруту физическая выдача курьеру.
 *
 * Открытая сессия и уже состоявшийся факт выдачи — разные вещи, но для
 * жизненного цикла маршрута обе означают одно: коробки поехали или вот-вот
 * поедут, и превращать это в редактирование маршрута нельзя.
 *
 * Возвращается конкретная причина, чтобы отказ объяснял, что именно произошло,
 * а не просто «нельзя».
 */
export async function issueStateOf(
  tx: TransactionClient,
  routeId: string,
): Promise<{ hasOpenSession: boolean; issuedOrders: number }> {
  const open = await tx.routeIssueSession.count({ where: { routeId, state: 'OPEN' } });

  const issued = await issuedOrderIdsForRoute(tx, routeId);

  return { hasOpenSession: open > 0, issuedOrders: issued.size };
}

/**
 * Заказы маршрута, выдача которых состоялась как неизменяемый факт.
 *
 * Факт выдачи имеет два равноправных источника, и заказ без размещения — не
 * исключение из правила, а второй его случай:
 *   1) закрытое `ISSUED_TO_COURIER` размещение — коробка стояла в ячейке и
 *      ушла с полки;
 *   2) действующая отметка в ЗАВЕРШЁННОЙ сессии — коробки в ячейке не было,
 *      но заказ отсканировали и лист отгрузили целиком.
 *
 * Оба доказывают одно: заказ физически передан курьеру. Завершённую сессию
 * не переоткрывают, её отметки не сбрасывают (сброс живёт только на открытой),
 * поэтому второй источник так же неизменяем, как первый. Отменённая сессия
 * (`CANCELLED`) фактом выдачи не считается — её отметки сюда не попадают.
 */
export async function issuedOrderIdsForRoute(
  tx: TransactionClient,
  routeId: string,
): Promise<Set<string>> {
  const placed = await tx.orderPlacement.findMany({
    where: { releaseReason: 'ISSUED_TO_COURIER', issueSession: { routeId } },
    select: { orderId: true },
    distinct: ['orderId'],
  });

  const checkedInCompleted = await tx.routeIssueCheck.findMany({
    where: { clearedAt: null, session: { routeId, state: 'COMPLETED' } },
    select: { orderId: true },
    distinct: ['orderId'],
  });

  const ids = new Set<string>();
  for (const row of placed) {
    ids.add(row.orderId);
  }
  for (const row of checkedInCompleted) {
    ids.add(row.orderId);
  }
  return ids;
}

/**
 * Запрещает обычные операции над маршрутом, если выдача открыта или состоялась.
 *
 * Без этого обычные «вернуть в черновик» и «отменить маршрут» обходили бы
 * правило «только администратор отменяет текущую выдачу с обязательной
 * причиной» (`FUL-003`): маршрут можно было бы просто вернуть в черновик,
 * и физически переданные курьеру заказы оказались бы снова редактируемыми.
 */
export async function assertIssueNotStarted(
  tx: TransactionClient,
  routeId: string,
  routeNumber: string,
): Promise<void> {
  const state = await issueStateOf(tx, routeId);

  if (state.hasOpenSession) {
    throw new AppError('CONFLICT', {
      message: 'issue session is open',
      publicMessage:
        'По маршруту идёт выдача курьеру. Сначала администратор должен отменить её с причиной.',
      conflict: { kind: 'ISSUE_SESSION_OPEN', routeNumber },
    });
  }

  if (state.issuedOrders > 0) {
    throw new AppError('CONFLICT', {
      message: `route already issued ${state.issuedOrders} orders`,
      publicMessage:
        'Часть заказов уже физически передана курьеру. Такой маршрут не редактируется и не отменяется обычным путём.',
      conflict: { kind: 'ROUTE_ALREADY_ISSUED', routeNumber },
    });
  }
}
