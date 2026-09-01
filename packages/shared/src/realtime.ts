/**
 * Модель адресации realtime-событий.
 *
 * Событие пишется в таблицу `RealtimeEvent` в одной транзакции с бизнес-изменением.
 * `LISTEN/NOTIFY` служит только ускорителем доставки; источник истины — таблица,
 * поэтому после перезапуска приложения пропущенные события восстанавливаются по `Last-Event-ID`.
 *
 * Правило видимости намеренно вынесено в чистую функцию: SSE-канал обязан фильтровать
 * события по конкретному пользователю и его ролям, а не рассылать всё всем подряд.
 */

import type { Role } from './roles.js';

export const REALTIME_TOPICS = [
  'user.created',
  'user.updated',
  'user.frozen',
  'user.unfrozen',
  'user.roles_changed',
  'session.revoked',
  // Заказы. Адресуются только ADMIN и LOGISTICIAN: курьер глобальные события
  // заказов не получает — ему видны лишь его собственные доставки.
  'order.created',
  'order.updated',
  'order.scope_changed',
  // Геоданные: payload несёт идентификатор и состояние, но не координаты.
  'order.geo_changed',
  // Недоставленный заказ: задача решения логиста и физический возврат букета.
  'order.resolution_changed',
  'order.return_changed',
  // Заказ отменён в МоемСкладе или отмену сняли.
  'order.cancellation_changed',
  // Локальный адрес: payload несёт идентификатор и вид изменения, но не адрес.
  'order.address_changed',
  // Маршруты. Тоже только ADMIN и LOGISTICIAN. В payload — идентификаторы и вид
  // события: ни номера маршрута, ни адресов, ни денег там быть не должно.
  'route.created',
  'route.updated',
  'route.conflict_detected',
  'route.confirmed',
  'route.returned_to_draft',
  'route.cancelled',
  // Блокировка редактора. Payload несёт только идентификаторы: ни семьи сессий,
  // ни причины перехвата, ни номера маршрута там нет.
  'route.edit_lock_changed',
  'route.edit_lock_taken_over',
  // Планирование маршрутов и склады (этап 5.4). Тоже только ADMIN и LOGISTICIAN.
  // В payload — идентификатор запуска и его состояние: ни маршрутов, ни заказов,
  // ни координат там нет, клиент перезапрашивает карточку сам.
  'route_plan.updated',
  'depot.changed',
  // Производственный состав заказа (этап 6.2). Адресуется ADMIN и FLORIST:
  // логисту состав не нужен, а лишняя подписка означала бы лишний перезапрос.
  // В payload — идентификатор заказа и перечень изменившихся частей снимка:
  // ни названий позиций, ни количеств, ни текста комментария и открытки.
  'order.fulfillment_changed',
  // Производственный процесс флориста (этап 6.3): захват, отказ, переназначение,
  // «Собран» и возврат в работу. Адресуется ADMIN и FLORIST — это общая очередь.
  // Событие, затрагивающее конкретного флориста (у него забрали заказ, его смену
  // закрыли), дополнительно адресуется лично ему.
  //
  // В payload — идентификатор заказа и состояние процесса. Ни номера заказа,
  // ни состава, ни текстов, ни имени флориста: клиент перезапрашивает список сам.
  'order.fulfillment_process_changed',
  // Смена флориста. Личное событие — владельцу смены, общее — ADMIN.
  'florist.shift_changed',
  // Печать бланка: первоначальное задание, повтор и ручная отметка.
  // Ни PDF, ни номера заказа в payload нет.
  'print_job.changed',
  // Справочник складских ячеек (этап 6.4). Адресуется ADMIN и WAREHOUSE.
  // В payload только идентификатор ячейки: код полки в событие не уходит,
  // клиент перезапрашивает справочник сам.
  'storage_cell.changed',
  // Точка печати: подключилась, отвалилась, сообщила об ошибке.
  'print_point.changed',
  // Фактическое движение заказов по складу (этап 6.5). Адресуется ADMIN
  // и WAREHOUSE. В payload — только идентификаторы и вид действия: ни номера
  // заказа, ни кода ячейки, ни адреса там нет.
  'warehouse.placement_changed',
  'warehouse.route_flow_changed',
  // Работа курьера (этап 6.6). Адресуется ADMIN и LOGISTICIAN. В payload —
  // только идентификаторы, вид результата и вид отмены: ни номера заказа,
  // ни адреса, ни причины открытым текстом там нет.
  'delivery.result_recorded',
  'delivery.result_cancelled',
  'route.completed',
  // Выдача самовывоза (этап 6.7). Адресуется ADMIN и MANAGER. В payload
  // только идентификатор заказа: номер, ячейка и получатель туда не уходят.
  'pickup.issued',
  // Локальная отмена самовывоза: карточка ушла из очереди без F5. Адресуется
  // ADMIN и MANAGER. В payload только идентификатор заказа.
  'pickup.cancelled_locally',
  // Общая настройка ручного ввода. Адресуется тем, чью работу она меняет:
  // ADMIN, WAREHOUSE и MANAGER. В payload только признак включения — ни автора,
  // ни номера заказа, ни версии настройки там нет.
  'settings.manual_entry_changed',
  // Финансовый учёт (этап 7). Адресуется ADMIN и LOGISTICIAN. В payload —
  // ТОЛЬКО операционный день: ни сумм, ни курьера, ни вида операции. Экрану
  // достаточно узнать, что учёт изменился, и перечитать отчёт своим запросом.
  'finance.ledger_changed',
  'integration.status_changed',
  'outbox.message_failed',
  // Уведомления логистов об изменении заказа (этап 6). Адресуется ADMIN,
  // LOGISTICIAN и SUPERVISOR ролевым событием; персональная отметка прочтения —
  // адресным событием пользователю. В payload только идентификаторы заказа и
  // уведомления и вид уведомления: ни адреса, ни состава, ни ФИО там нет.
  'notification.created',
  // Решение «На пересборку» принято: список обновляется у всех логистов, чтобы
  // видеть назначенного флориста. Адресуется той же тройке ролей.
  'notification.decided',
  // Персональная отметка прочтения изменилась: счётчик обновляется у самого
  // пользователя. Адресное событие, в payload только идентификатор уведомления.
  'notification.read',
  // Автораспределение заказов флористам (этап 6). Смена режима распределения —
  // ролевое событие ADMIN/LOGISTICIAN/SUPERVISOR/FLORIST: экраны перечитывают
  // режим. В payload только признак авто.
  'settings.florist_dispatch_mode_changed',
  // Состояние готовности/назначения флориста изменилось: его экран и списки
  // руководителей перечитывают статус. Адресуется персонально флористу и ролям
  // управления; в payload только идентификаторы.
  'florist.dispatch_changed',
] as const;

export type RealtimeTopic = (typeof REALTIME_TOPICS)[number];

export interface RealtimeAudience {
  /**
   * Персональный адресат. Если задан — событие видит только этот пользователь.
   * Используется для «ваши сессии отозваны», «ваши роли изменены» и т. п.
   */
  audienceUserId: string | null;
  /**
   * Роли-адресаты. Событие видят пользователи, имеющие хотя бы одну из перечисленных ролей.
   * Пустой список означает «по ролям событие никому не адресовано».
   */
  audienceRoles: readonly Role[];
}

export interface RealtimeEventEnvelope extends RealtimeAudience {
  id: string;
  topic: RealtimeTopic;
  occurredAt: string;
  payload: unknown;
}

export interface RealtimeViewer {
  userId: string;
  roles: readonly Role[];
}

/**
 * Единственное место, где решается, доставлять ли событие пользователю.
 *
 * Событие видно, если оно адресовано лично пользователю ИЛИ хотя бы одной из его ролей.
 * Событие без адресата не видно никому: это защищает от случайной широковещательной рассылки
 * административных данных курьерам.
 */
export function isEventVisibleTo(event: RealtimeAudience, viewer: RealtimeViewer): boolean {
  if (event.audienceUserId !== null) {
    return event.audienceUserId === viewer.userId;
  }
  if (event.audienceRoles.length === 0) {
    return false;
  }
  return event.audienceRoles.some((role) => viewer.roles.includes(role));
}

/** Событие, адресованное лично пользователю. */
export function personalAudience(userId: string): RealtimeAudience {
  return { audienceUserId: userId, audienceRoles: [] };
}

/** Событие, адресованное набору ролей. */
export function roleAudience(...roles: Role[]): RealtimeAudience {
  return { audienceUserId: null, audienceRoles: roles };
}
