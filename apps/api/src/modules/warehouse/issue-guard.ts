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

  const issued = await tx.orderPlacement.findMany({
    where: { releaseReason: 'ISSUED_TO_COURIER', issueSession: { routeId } },
    select: { orderId: true },
    distinct: ['orderId'],
  });

  return { hasOpenSession: open > 0, issuedOrders: issued.length };
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
