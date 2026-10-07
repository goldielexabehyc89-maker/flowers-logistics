/**
 * Признак «к заказу приложена открытка» для рабочих списков.
 *
 * Источник ровно один — подтверждённый производственный атрибут «Текст
 * открытки» (`DeliveryOrder.fulfillmentCardText`). Тот же самый признак уже
 * решает, печатается ли раздел «ТЕКСТ ОТКРЫТКИ» в бланке флориста (`pdf.ts`),
 * и его же показывает карточка сборки. Пометка в списке обязана говорить
 * ровно то, что лежит на бумаге рядом с букетом, — поэтому второго правила
 * здесь нет, а есть ссылка на первое.
 *
 * Слово «открытка» в свободных комментариях признаком НЕ является: его пишут
 * люди, и «без открытки» или «открытку не класть» содержат то же слово.
 *
 * Пустое и пробельное значение в колонку не попадает: импорт нормализует
 * атрибут (`mapper.text`) и записывает `null`. Поэтому «есть открытка» —
 * это ровно «значение не `null`».
 *
 * Ожидающий текст (`fulfillmentPendingCardText`) признаком не считается: это
 * версия заказа, состав которой ещё не подтверждён, и ни карточка флориста,
 * ни бланк её не показывают. Подтверждение переписывает колонку и публикует
 * `order.fulfillment_changed` — по нему списки и перечитываются.
 *
 * Сам текст в списки не отдаётся: им нужен только факт.
 */

import type { TransactionClient } from '../auth/sessions.js';
import { publishRealtimeEvent } from '../realtime/events.js';

/** Поле заказа, из которого считается признак. Подмешивается в `select`. */
export const POSTCARD_SELECT = { fulfillmentCardText: true } as const;

export function hasPostcard(order: { fulfillmentCardText: string | null }): boolean {
  return order.fulfillmentCardText !== null;
}

/**
 * Листы, курьеру которых сообщается о смене пометки.
 *
 * `ACTIVE` — лист уже у курьера и стоит в его «Активных».
 *
 * `CONFIRMED` — закрывает гонку с ручной отгрузкой. Она блокирует только сам
 * лист, а не строки заказов, поэтому подтверждение снимка может прочитать лист
 * ещё неотгруженным, а зафиксироваться уже после того, как курьер перечитал
 * «Активные» по событию отгрузки. Брать здесь блокировку листа нельзя: снимок
 * уже держит строку заказа, а маршрутные операции берут сначала лист, потом
 * заказы, — обратный порядок дал бы взаимную блокировку. Личное событие
 * курьеру неотгруженного листа безопасно: это его собственный лист, а сервер
 * отдаст ему в «Активных» только то, что уже отгружено.
 */
const NOTIFIED_ROUTE_STATES = ['CONFIRMED', 'ACTIVE'] as const;

/**
 * Личное событие курьеру: у заказа в его листе появилась или пропала открытка.
 *
 * Производственные события курьеру не адресуются, и это правило не меняется:
 * курьер узнаёт только о собственном листе, а не обо всех заказах. Тема — то
 * же личное `route.updated`, которым курьера уже уведомляет снятие заказа
 * с отгруженного листа; по нему его «Активные» перечитываются сами.
 * В событии только идентификаторы листа и заказа — ни текста, ни номера.
 *
 * Вызывается в транзакции подтверждения снимка, под блокировкой строки заказа.
 */
export async function notifyCouriersOfPostcardChange(
  tx: TransactionClient,
  orderId: string,
): Promise<void> {
  const participations = await tx.routeOrder.findMany({
    where: {
      orderId,
      removedAt: null,
      route: { state: { in: [...NOTIFIED_ROUTE_STATES] }, courierUserId: { not: null } },
    },
    select: { routeId: true, route: { select: { courierUserId: true } } },
  });

  for (const participation of participations) {
    const courierUserId = participation.route.courierUserId;
    if (courierUserId === null) {
      continue;
    }
    await publishRealtimeEvent(tx, {
      topic: 'route.updated',
      payload: { routeId: participation.routeId, orderIds: [orderId] },
      audienceUserId: courierUserId,
    });
  }
}
