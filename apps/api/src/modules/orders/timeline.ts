/**
 * Сквозная история одного заказа.
 *
 * Экран отвечает на вопрос «что с этим букетом было и кто это сделал», и
 * ответ собирается ТОЛЬКО из уже существующих неизменяемых источников. Новой
 * параллельной истории здесь не заводится: каждая строка ниже названа вместе
 * с таблицей, из которой она берётся, и другой таблицей то же событие не
 * читается — иначе одно действие показалось бы дважды.
 *
 * КАРТА ИСТОЧНИКОВ (по одному на бизнес-событие).
 *
 *  * импорт и обновления из источника — `DeliveryOrderRevision`
 *    (`receivedAt`, `reason`, `changedFields`); автор — МойСклад;
 *  * вход и выход из области — те же ревизии с причинами `SCOPE_*`;
 *  * рабочий адрес — `OrderAddressHistory` (старое и новое значение, источник,
 *    автор). В аудите адресов нет намеренно, и восстанавливать их оттуда
 *    нечем;
 *  * интервал — `AuditLog.ORDER_INTERVAL_SET`: значения интервала не PII,
 *    и отдельной исторической таблицы у них нет;
 *  * появление в очереди флориста — первая `OrderFulfillmentRevision`:
 *    состав подтверждён, и заказ стал видимым флористу;
 *  * работа флориста (взял, отпустил, переназначил, собрал, вернул
 *    в пересборку, требует проверки) — `AuditLog.ORDER_FULFILLMENT_*`:
 *    там же снимок ролей автора;
 *  * бланк и печать — `OrderPrintForm` и `OrderPrintJob` (`attempt` отличает
 *    первую печать от повторной, `completedBy` — кто её подтвердил);
 *  * склад — `OrderPlacement`: приёмка, назначение полки, перенос,
 *    освобождение, выдача курьеру и списание — это поля одной строки
 *    размещения, а не разные журналы;
 *  * комплектование — `RouteIssueCheck` (внесён и снят по заказу);
 *  * выдача покупателю — `OrderPickupIssue`;
 *  * состав листа — `RouteOrder` (добавлен, удалён, перенесён) и
 *    `AuditLog.ROUTE_ORDERS_REORDERED` для смены позиции;
 *  * жизнь листа — `RouteStateTransition` и `AuditLog.ROUTE_COURIER_*`,
 *    отобранные по окну участия ЭТОГО заказа в листе;
 *  * доставка — `DeliveryAttempt` и `DeliveryAttemptCancellation`;
 *  * решение логиста — `OrderResolution`;
 *  * возврат — `OrderReturn` и `OrderReturnTransition`;
 *  * отмена из источника, снятие отмены и отмена логистом —
 *    `AuditLog.ORDER_CANCELLED_IN_SOURCE`, `ORDER_CANCELLATION_WITHDRAWN`,
 *    `ORDER_CANCELLED_BY_LOGIST`.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Сырых снимков ревизий, адресов из аудита, получателя,
 * телефона и комментария в событиях. История показывает факты и ссылки,
 * а не содержимое заказа: содержимое живёт в карточке.
 *
 * ПОРЯДОК УСТОЙЧИВ. Строки сортируются по моменту, а при равном моменте — по
 * ключу события: два разряда порядка источника и его идентификатор. Разряды
 * расставлены по ходу дела (импорт → флорист → склад → лист → доставка →
 * возврат), поэтому одновременные строки читаются в понятной
 * последовательности, а не в случайной.
 * Одинаковые миллисекунды реальны (одна транзакция пишет несколько строк),
 * и без второго ключа соседние строки менялись бы местами между запросами.
 */

import { moscowCalendarDate } from '@fl/shared';
import type { Role } from '@fl/shared';
import type { Database } from '../../platform/db.js';
import { fromDateColumn } from '../integrations/moysklad/delivery-date.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { addressDetailsOf, effectiveAddress, ORDER_ADDRESS_SELECT } from './address.js';

/** Этап жизни заказа: им экран красит строку и группирует смысл. */
export type TimelineGroup =
  'IMPORT' | 'FLORIST' | 'WAREHOUSE' | 'LOGISTICS' | 'DELIVERY' | 'RETURN';

/**
 * Кто совершил действие.
 *
 * `roles` заполняется только там, где источник сохранил СНИМОК ролей на момент
 * действия (журнал аудита). Текущие роли пользователя подставлять нельзя: за
 * месяцы они меняются, и строка обещала бы, что кладовщик был логистом.
 */
export interface TimelineActor {
  kind: 'USER' | 'SYSTEM' | 'SOURCE';
  userId: string | null;
  fullName: string | null;
  roles: Role[];
}

/** Существенная подробность строки: подпись и значение, без вложенности. */
export interface TimelineDetail {
  label: string;
  value: string;
}

export interface TimelineEvent {
  /** Устойчивый ключ: источник и его идентификатор. Второй ключ сортировки. */
  key: string;
  occurredAt: string;
  /** Московская календарная дата события. Считает СЕРВЕР. */
  moscowDate: string;
  group: TimelineGroup;
  /** Машинное имя события: по нему проверки и значки, а не по подписи. */
  kind: string;
  title: string;
  actor: TimelineActor;
  details: TimelineDetail[];
  /**
   * Действие было отменено или исправлено позже.
   *
   * Строка при этом остаётся: история не переписывается задним числом,
   * а получает пометку.
   */
  reverted: boolean;
  route: { id: string; number: string } | null;
}

const SYSTEM_ACTOR: TimelineActor = { kind: 'SYSTEM', userId: null, fullName: null, roles: [] };
const SOURCE_ACTOR: TimelineActor = { kind: 'SOURCE', userId: null, fullName: null, roles: [] };

/** Наибольшая страница истории. Больше — это уже выгрузка, а её здесь нет. */
export const TIMELINE_PAGE_MAX = 200;
export const TIMELINE_PAGE_DEFAULT = 100;

const REVISION_TITLES: Record<string, string> = {
  INITIAL_IMPORT: 'Заказ импортирован из МоегоСклада',
  EXTERNAL_UPDATE: 'Заказ обновлён в МоёмСкладе',
  SCOPE_ENTERED: 'Заказ вошёл в нашу область',
  SCOPE_EXITED: 'Заказ вышел из нашей области',
  SOURCE_MISSING: 'Заказ пропал из источника',
  SOURCE_RESTORED: 'Заказ вернулся в источник',
};

const ADDRESS_TITLES: Record<string, string> = {
  LOCAL_ADDRESS_SET: 'Рабочий адрес исправлен вручную',
  LOCAL_ADDRESS_CLEARED: 'Ручной адрес снят, работает адрес источника',
  SOURCE_CONFLICT_DETECTED: 'Источник изменил адрес: расхождение с ручным',
  CONFLICT_RESOLVED_KEEP_LOCAL: 'Расхождение адреса закрыто: оставлен ручной',
  CONFLICT_RESOLVED_USE_SOURCE: 'Расхождение адреса закрыто: принят адрес источника',
};

/**
 * Изменения адреса, пришедшие из источника у заказа версии 2.
 *
 * Адрес и детали — разные строки: по первому курьер едет, второе он читает
 * у двери. Слитое «адрес изменился» заставляло бы каждый раз выяснять,
 * надо ли перепроверять маршрут.
 */
const STRUCTURED_ADDRESS_TITLES: Record<string, string> = {
  ADDRESS: 'Источник изменил адрес доставки',
  DETAILS: 'Источник изменил детали адреса',
};

const FULFILLMENT_TITLES: Record<string, string> = {
  ORDER_FULFILLMENT_CLAIMED: 'Флорист взял заказ в работу',
  ORDER_FULFILLMENT_RELEASED: 'Заказ возвращён в общую очередь',
  ORDER_FULFILLMENT_REASSIGNED: 'Заказ переназначен другому флористу',
  ORDER_FULFILLMENT_ASSEMBLED: 'Букет собран',
  ORDER_FULFILLMENT_REOPENED: 'Готовность снята: заказ вернулся в сборку',
  ORDER_FULFILLMENT_REVIEW_REQUIRED: 'Состав изменился после сборки: нужна проверка',
};

const CANCEL_TITLES: Record<string, string> = {
  ORDER_CANCELLED_IN_SOURCE: 'Заказ отменён в МоёмСкладе',
  ORDER_CANCELLATION_WITHDRAWN: 'Отмена в МоёмСкладе снята',
  ORDER_CANCELLED_BY_LOGIST: 'Логист закрыл заказ как отменённый',
};

const PLACEMENT_SOURCE_TITLES: Record<string, string> = {
  RECEIVED: 'Коробка принята на склад',
  MOVED: 'Коробка переставлена на другую полку',
  COURIER_RETURN: 'Коробка принята обратно от курьера',
};

const RELEASE_TITLES: Record<string, string> = {
  MOVED_TO_ROUTE_CELL: 'Полка освобождена: коробка ушла на маршрутную полку',
  MOVED_TO_STORAGE: 'Полка освобождена: коробка ушла в хранение',
  ISSUED_TO_COURIER: 'Коробка выдана курьеру',
  WITHDRAWN: 'Коробка снята с хранения',
  ISSUED_TO_CUSTOMER: 'Коробка выдана покупателю',
};

const WITHDRAW_REASONS: Record<string, string> = {
  REASSEMBLY: 'на пересборку',
  WRITE_OFF: 'в списание',
};

const REMOVAL_TITLES: Record<string, string> = {
  RETURNED_TO_UNASSIGNED: 'Заказ убран из листа в нераспределённые',
  MOVED_TO_ANOTHER_ROUTE: 'Заказ перенесён в другой лист',
  ROUTE_CANCELLED: 'Заказ вышел из листа: лист отменён',
  SOURCE_CANCELLATION_WITHDRAWN: 'Заказ убран из листа: снята отмена источника',
};

const ROUTE_STATE_TITLES: Record<string, string> = {
  CONFIRMED: 'Маршрутный лист подтверждён',
  CANCELLED: 'Маршрутный лист отменён',
  ACTIVE: 'Маршрутный лист отгружен курьеру',
  COMPLETED: 'Маршрутный лист завершён',
  DRAFT: 'Маршрутный лист возвращён в черновик',
};

const RETURN_STATE_TITLES: Record<string, string> = {
  WITH_COURIER: 'Букет остался у курьера: нужно вернуть на склад',
  RETURNING: 'Курьер везёт букет обратно',
  ACCEPTED: 'Возврат принят складом',
  CANCELLED: 'Возврат закрыт: обязанности вернуть больше нет',
};

const DECISION_TITLES: Record<string, string> = {
  CANCELLED: 'Решение логиста: заказ отменён',
  REDELIVER: 'Решение логиста: повторная доставка',
  REDELIVER_SAME_BOUQUET: 'Решение логиста: везём тот же букет',
  REDELIVER_REASSEMBLE: 'Решение логиста: передать на пересборку',
  ACKNOWLEDGED: 'Логист принял недоставку к сведению',
};

const CELL_KINDS: Record<string, string> = { STORAGE: 'Хранение', ROUTE: 'Маршрутная' };

/** `600` → `10:00`. Минуты внутри суток пояса не имеют. */
function minutes(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function intervalText(start: number | null, end: number | null): string {
  if (start === null && end === null) {
    return 'не задан';
  }
  return `${minutes(start)}–${minutes(end)}`;
}

/** Строка события: московская дата считается здесь и только здесь. */
function event(
  input: Omit<TimelineEvent, 'moscowDate' | 'occurredAt'> & { at: Date },
): TimelineEvent {
  const { at, ...rest } = input;
  return { ...rest, occurredAt: at.toISOString(), moscowDate: moscowCalendarDate(at) };
}

export interface TimelineHeader {
  orderId: string;
  number: string;
  processState: string;
  externalState: string | null;
  pickup: boolean;
  deliveryDate: string | null;
  interval: { startMinute: number | null; endMinute: number | null; manual: boolean };
  address: string | null;
  /** Детали адреса. У заказа прежнего контракта их не существует. */
  addressDetails: string | null;
  florist: { id: string; fullName: string } | null;
  route: { id: string; number: string; state: string } | null;
  courier: { id: string; fullName: string } | null;
  cell: { code: string; kind: string } | null;
  delivery: { outcome: string; occurredAt: string; reason: string | null } | null;
  returnObligation: { displayNumber: string; state: string } | null;
  cancellation: { source: boolean; logist: boolean; occurredAt: string | null } | null;
}

export interface TimelinePage {
  header: TimelineHeader;
  events: TimelineEvent[];
  /** Продолжение: `null` — история дочитана до конца. */
  nextCursor: string | null;
  total: number;
}

/** Курсор — это позиция в устойчивом порядке, а не смещение в базе. */
function encodeCursor(entry: TimelineEvent): string {
  return Buffer.from(`${entry.occurredAt}|${entry.key}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { occurredAt: string; key: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const at = raw.indexOf('|');
    if (at <= 0) {
      return null;
    }
    return { occurredAt: raw.slice(0, at), key: raw.slice(at + 1) };
  } catch {
    return null;
  }
}

/** Идентификаторы пользователей, чьи имена понадобятся строкам. */
function collectUserIds(events: readonly TimelineEvent[]): string[] {
  return [
    ...new Set(
      events
        .map((entry) => entry.actor.userId)
        .filter((value): value is string => value !== null && value !== undefined),
    ),
  ];
}

function userActor(userId: string | null, roles: Role[] = []): TimelineActor {
  return userId === null
    ? SYSTEM_ACTOR
    : { kind: 'USER', userId, fullName: null, roles: [...roles] };
}

export class OrderNotFoundError extends Error {
  constructor() {
    super('order not found');
    this.name = 'OrderNotFoundError';
  }
}

/**
 * История заказа одной страницей.
 *
 * Агрегация выполняется по ПОЛНОМУ набору источников и только потом режется
 * курсором: страница — это способ показать, а не способ отобрать. Историю
 * одного заказа считают сотнями строк, и держать её в памяти дешевле, чем
 * доказывать корректность объединения десяти таблиц в SQL.
 */
export async function readOrderTimeline(
  db: Database,
  input: { orderId: string; limit: number; cursor: string | null },
): Promise<TimelinePage> {
  const order = await db.deliveryOrder.findUnique({
    where: { id: input.orderId },
    select: {
      id: true,
      externalName: true,
      externalStateName: true,
      deliveryMethodId: true,
      deliveryDate: true,
      intervalStartMinute: true,
      intervalEndMinute: true,
      manualIntervalStartMinute: true,
      manualIntervalEndMinute: true,
      ...ORDER_ADDRESS_SELECT,
      fulfillmentProcessState: true,
      fulfillmentAssignee: { select: { id: true, fullName: true } },
      cancelledInSource: true,
      cancelledInSourceAt: true,
      cancelledByLogistAt: true,
    },
  });
  if (order === null) {
    throw new OrderNotFoundError();
  }

  const events: TimelineEvent[] = [];

  // 1. Импорт и обновления источника.
  const revisions = await db.deliveryOrderRevision.findMany({
    where: { orderId: order.id },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, receivedAt: true, reason: true, changedFields: true },
  });
  for (const revision of revisions) {
    // Обновление без изменений отслеживаемых полей строкой не становится:
    // синхронизация ходит часто, и такой список читать невозможно.
    if (revision.reason === 'EXTERNAL_UPDATE' && revision.changedFields.length === 0) {
      continue;
    }
    events.push(
      event({
        key: `10:revision:${revision.id}`,
        at: revision.receivedAt,
        group: 'IMPORT',
        kind: `ORDER_${revision.reason}`,
        title: REVISION_TITLES[revision.reason] ?? 'Обновление из МоегоСклада',
        actor: SOURCE_ACTOR,
        details:
          revision.changedFields.length === 0
            ? []
            : [{ label: 'Изменились поля', value: revision.changedFields.join(', ') }],
        reverted: false,
        route: null,
      }),
    );
  }

  // 2. Появление в очереди флориста: состав подтверждён.
  const fulfillmentRevisions = await db.orderFulfillmentRevision.findMany({
    where: { orderId: order.id },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, receivedAt: true, reason: true, changedFields: true },
  });
  const firstComposition = fulfillmentRevisions[0];
  if (firstComposition !== undefined) {
    events.push(
      event({
        key: `12:composition:${firstComposition.id}`,
        at: firstComposition.receivedAt,
        group: 'FLORIST',
        kind: 'ORDER_QUEUED_FOR_FLORIST',
        title: 'Состав подтверждён: заказ появился в очереди флориста',
        actor: SOURCE_ACTOR,
        details: [],
        reverted: false,
        route: null,
      }),
    );
  }
  for (const revision of fulfillmentRevisions.slice(1)) {
    if (revision.changedFields.length === 0) {
      continue;
    }
    events.push(
      event({
        key: `12:composition:${revision.id}`,
        at: revision.receivedAt,
        group: 'FLORIST',
        kind: 'ORDER_COMPOSITION_CHANGED',
        title: 'Состав заказа изменился в МоёмСкладе',
        actor: SOURCE_ACTOR,
        details: [{ label: 'Изменились поля', value: revision.changedFields.join(', ') }],
        reverted: false,
        route: null,
      }),
    );
  }

  // 3. Рабочий адрес.
  const addressHistory = await db.orderAddressHistory.findMany({
    where: { orderId: order.id },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      action: true,
      occurredAt: true,
      oldAddress: true,
      newAddress: true,
      sourceAddress: true,
      actorUserId: true,
    },
  });
  for (const entry of addressHistory) {
    const details: TimelineDetail[] = [];
    if (entry.oldAddress !== null) {
      details.push({ label: 'Было', value: entry.oldAddress });
    }
    if (entry.newAddress !== null) {
      details.push({ label: 'Стало', value: entry.newAddress });
    }
    if (entry.sourceAddress !== null) {
      details.push({ label: 'В источнике', value: entry.sourceAddress });
    }
    events.push(
      event({
        key: `14:address:${entry.id}`,
        at: entry.occurredAt,
        group: 'IMPORT',
        kind: `ADDRESS_${entry.action}`,
        title: ADDRESS_TITLES[entry.action] ?? 'Изменение адреса',
        actor: entry.actorUserId === null ? SOURCE_ACTOR : userActor(entry.actorUserId),
        details,
        reverted: false,
        route: null,
      }),
    );
  }

  /*
   * 3а. Изменения адреса источником у заказа версии 2.
   *
   * Отдельная append-only таблица, а не новое значение в перечислении истории
   * адреса: перечисление читается прежним клиентом Prisma, и строка
   * с неизвестным ему значением сделала бы откат невозможным.
   */
  const structuredAddressEvents = await db.orderStructuredAddressEvent.findMany({
    where: { orderId: order.id },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      kind: true,
      occurredAt: true,
      oldValue: true,
      newValue: true,
      actorUserId: true,
    },
  });
  for (const entry of structuredAddressEvents) {
    const details: TimelineDetail[] = [];
    if (entry.oldValue !== null) {
      details.push({ label: 'Было', value: entry.oldValue });
    }
    if (entry.newValue !== null) {
      details.push({ label: 'Стало', value: entry.newValue });
    }
    events.push(
      event({
        key: `15:structured:${entry.id}`,
        at: entry.occurredAt,
        group: 'IMPORT',
        // Вид берётся из колонки, а не угадывается по содержимому строки.
        kind: `STRUCTURED_ADDRESS_${entry.kind}`,
        title: STRUCTURED_ADDRESS_TITLES[entry.kind] ?? 'Изменение адреса',
        actor: entry.actorUserId === null ? SOURCE_ACTOR : userActor(entry.actorUserId),
        details,
        reverted: false,
        route: null,
      }),
    );
  }

  // 4. Журнал заказа: интервал, работа флориста, отмены.
  const orderAudit = await db.auditLog.findMany({
    where: {
      entityType: 'DeliveryOrder',
      entityId: order.id,
      action: {
        in: [
          'ORDER_INTERVAL_SET',
          'ORDER_FULFILLMENT_CLAIMED',
          'ORDER_FULFILLMENT_RELEASED',
          'ORDER_FULFILLMENT_REASSIGNED',
          'ORDER_FULFILLMENT_ASSEMBLED',
          'ORDER_FULFILLMENT_REOPENED',
          'ORDER_FULFILLMENT_REVIEW_REQUIRED',
          'ORDER_CANCELLED_IN_SOURCE',
          'ORDER_CANCELLATION_WITHDRAWN',
          'ORDER_CANCELLED_BY_LOGIST',
        ],
      },
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      action: true,
      occurredAt: true,
      actorUserId: true,
      actorRoles: true,
      oldValue: true,
      newValue: true,
    },
  });
  for (const entry of orderAudit) {
    const key = `16:audit:${String(entry.id)}`;
    const actor =
      entry.actorUserId === null ? SYSTEM_ACTOR : userActor(entry.actorUserId, entry.actorRoles);

    if (entry.action === 'ORDER_INTERVAL_SET') {
      const before = (entry.oldValue ?? {}) as {
        startMinute?: number | null;
        endMinute?: number | null;
      };
      const after = (entry.newValue ?? {}) as {
        startMinute?: number | null;
        endMinute?: number | null;
      };
      events.push(
        event({
          key,
          at: entry.occurredAt,
          group: 'IMPORT',
          kind: 'ORDER_INTERVAL_SET',
          title: 'Интервал доставки задан вручную',
          actor,
          details: [
            {
              label: 'Было',
              value: intervalText(before.startMinute ?? null, before.endMinute ?? null),
            },
            {
              label: 'Стало',
              value: intervalText(after.startMinute ?? null, after.endMinute ?? null),
            },
          ],
          reverted: false,
          route: null,
        }),
      );
      continue;
    }

    const fulfillmentTitle = FULFILLMENT_TITLES[entry.action];
    if (fulfillmentTitle !== undefined) {
      events.push(
        event({
          key,
          at: entry.occurredAt,
          group: 'FLORIST',
          kind: entry.action,
          title: fulfillmentTitle,
          actor,
          details: [],
          reverted: false,
          route: null,
        }),
      );
      continue;
    }

    const cancelTitle = CANCEL_TITLES[entry.action];
    if (cancelTitle !== undefined) {
      events.push(
        event({
          key,
          at: entry.occurredAt,
          group: 'DELIVERY',
          kind: entry.action,
          title: cancelTitle,
          actor,
          details: [],
          // Снятая отмена не стирает строку об отмене: обе видны рядом.
          reverted: entry.action === 'ORDER_CANCELLED_IN_SOURCE' && !order.cancelledInSource,
          route: null,
        }),
      );
    }
  }

  // 5. Бланк и печать.
  const printForms = await db.orderPrintForm.findMany({
    where: { orderId: order.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, createdAt: true, assemblyRound: true },
  });
  for (const form of printForms) {
    events.push(
      event({
        key: `20:print-form:${form.id}`,
        at: form.createdAt,
        group: 'FLORIST',
        kind: 'ORDER_PRINT_FORM_CREATED',
        title: 'Бланк сборки составлен',
        actor: SYSTEM_ACTOR,
        details: [{ label: 'Круг сборки', value: String(form.assemblyRound) }],
        reverted: false,
        route: null,
      }),
    );
  }

  const printJobs = await db.orderPrintJob.findMany({
    where: { orderId: order.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      attempt: true,
      state: true,
      createdAt: true,
      completedAt: true,
      completedById: true,
      printForm: { select: { id: true, assemblyRound: true } },
    },
  });
  /*
   * «Первая печать» считается по БЛАНКУ, а не по счётчику заказа.
   *
   * Попытки нумеруются сквозь весь заказ, и после пересборки первая печать
   * нового бланка получала номер три. На экране это читалось как «опять
   * перепечатали», хотя печатали новый букет первый раз.
   */
  const printedForms = new Set<string>();
  for (const job of printJobs) {
    if (job.completedAt === null) {
      continue;
    }
    const first = !printedForms.has(job.printForm.id);
    printedForms.add(job.printForm.id);
    events.push(
      event({
        key: `21:print-job:${job.id}`,
        at: job.completedAt,
        group: 'FLORIST',
        kind: first ? 'ORDER_PRINTED' : 'ORDER_REPRINTED',
        title: first ? 'Бланк напечатан' : 'Бланк напечатан повторно',
        actor: userActor(job.completedById),
        details: [
          { label: 'Круг сборки', value: String(job.printForm.assemblyRound) },
          { label: 'Попытка печати', value: String(job.attempt) },
        ],
        reverted: false,
        route: null,
      }),
    );
  }

  // 6. Склад: одна строка размещения — до четырёх событий её жизни.
  const placements = await db.orderPlacement.findMany({
    where: { orderId: order.id },
    orderBy: [{ placedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      source: true,
      placedAt: true,
      placedById: true,
      releasedAt: true,
      releasedById: true,
      releaseReason: true,
      withdrawReason: true,
      assemblyRound: true,
      cell: { select: { code: true, kind: true } },
      fromCell: { select: { code: true } },
      movedToCell: { select: { code: true } },
    },
  });
  for (const placement of placements) {
    const cellDetails: TimelineDetail[] = [
      { label: 'Ячейка', value: placement.cell.code },
      { label: 'Вид полки', value: CELL_KINDS[placement.cell.kind] ?? placement.cell.kind },
    ];
    if (placement.fromCell !== null) {
      cellDetails.push({ label: 'Откуда', value: placement.fromCell.code });
    }
    events.push(
      event({
        key: `30:placement:${placement.id}`,
        at: placement.placedAt,
        group: 'WAREHOUSE',
        kind: `PLACEMENT_${placement.source}`,
        title: PLACEMENT_SOURCE_TITLES[placement.source] ?? 'Коробка размещена',
        actor: userActor(placement.placedById),
        details: cellDetails,
        // Освобождённое размещение остаётся в истории и получает пометку.
        reverted: false,
        route: null,
      }),
    );

    if (placement.releasedAt !== null) {
      const reason = placement.releaseReason ?? 'WITHDRAWN';
      const details: TimelineDetail[] = [{ label: 'Ячейка', value: placement.cell.code }];
      if (placement.movedToCell !== null) {
        details.push({ label: 'Куда', value: placement.movedToCell.code });
      }
      if (placement.withdrawReason !== null) {
        details.push({
          label: 'Причина снятия',
          value: WITHDRAW_REASONS[placement.withdrawReason] ?? placement.withdrawReason,
        });
      }
      events.push(
        event({
          key: `31:placement-release:${placement.id}`,
          at: placement.releasedAt,
          group: 'WAREHOUSE',
          kind: `PLACEMENT_RELEASED_${reason}`,
          title: RELEASE_TITLES[reason] ?? 'Полка освобождена',
          actor: userActor(placement.releasedById),
          details,
          reverted: false,
          route: null,
        }),
      );
    }
  }

  // 7. Комплектование листа: заказ внесён кладовщиком.
  const checks = await db.routeIssueCheck.findMany({
    where: { orderId: order.id },
    orderBy: [{ checkedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      checkedAt: true,
      checkedById: true,
      clearedAt: true,
      clearedById: true,
      session: { select: { route: { select: { id: true, number: true } } } },
    },
  });
  for (const check of checks) {
    events.push(
      event({
        key: `34:issue-check:${check.id}`,
        at: check.checkedAt,
        group: 'WAREHOUSE',
        kind: 'ROUTE_ISSUE_CHECKED',
        title: 'Заказ внесён при комплектовании листа',
        actor: userActor(check.checkedById),
        details: [],
        reverted: check.clearedAt !== null,
        route: check.session.route,
      }),
    );
    if (check.clearedAt !== null) {
      events.push(
        event({
          key: `35:issue-uncheck:${check.id}`,
          at: check.clearedAt,
          group: 'WAREHOUSE',
          kind: 'ROUTE_ISSUE_CHECK_CLEARED',
          title: 'Отметка комплектования снята',
          actor: userActor(check.clearedById),
          details: [],
          reverted: false,
          route: check.session.route,
        }),
      );
    }
  }

  // 8. Выдача покупателю (самовывоз).
  const pickup = await db.orderPickupIssue.findUnique({
    where: { orderId: order.id },
    select: { id: true, issuedAt: true, issuedById: true, cell: { select: { code: true } } },
  });
  if (pickup !== null) {
    events.push(
      event({
        key: `38:pickup:${pickup.id}`,
        at: pickup.issuedAt,
        group: 'DELIVERY',
        kind: 'PICKUP_ISSUED',
        title: 'Заказ выдан покупателю',
        actor: userActor(pickup.issuedById),
        // Ячейки могло не быть: выдача без ячейки — штатный исход.
        details: pickup.cell === null ? [] : [{ label: 'Ячейка', value: pickup.cell.code }],
        reverted: false,
        route: null,
      }),
    );
  }

  // 8b. Локальная отмена самовывоза.
  //
  // Явно отделена от глобальной отмены заказа: заказ не отменён в источнике
  // и статус его не менялся — карточку просто убрали из очереди самовывоза.
  const pickupCancel = await db.orderPickupCancellation.findUnique({
    where: { orderId: order.id },
    select: { id: true, cancelledAt: true, cancelledById: true },
  });
  if (pickupCancel !== null) {
    events.push(
      event({
        key: `39:pickup-cancel:${pickupCancel.id}`,
        at: pickupCancel.cancelledAt,
        group: 'DELIVERY',
        kind: 'PICKUP_CANCELLED_LOCALLY',
        title: 'Самовывоз отменён локально',
        actor: userActor(pickupCancel.cancelledById),
        details: [],
        reverted: false,
        route: null,
      }),
    );
  }

  // 9. Участие в маршрутных листах.
  const participations = await db.routeOrder.findMany({
    where: { orderId: order.id },
    orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      position: true,
      addedAt: true,
      addedById: true,
      removedAt: true,
      removedById: true,
      removalReason: true,
      route: {
        select: {
          id: true,
          number: true,
          state: true,
          courier: { select: { id: true, fullName: true } },
        },
      },
      movedToRoute: { select: { number: true } },
    },
  });
  for (const participation of participations) {
    events.push(
      event({
        key: `40:route-order:${participation.id}`,
        at: participation.addedAt,
        group: 'LOGISTICS',
        kind: 'ROUTE_ORDER_ADDED',
        title: 'Заказ добавлен в маршрутный лист',
        actor: userActor(participation.addedById),
        details: [{ label: 'Позиция', value: String(participation.position) }],
        /*
         * Выход из листа пометкой «отменено» не считается.
         *
         * Заказ уходит из листа и в обычном ходе дела — после доставки или
         * решения о повторной, — и у выхода есть своя строка. Пометка нужна
         * там, где действие именно ОТМЕНИЛИ: отменённый лист или снятая
         * отмена источника.
         */
        reverted:
          participation.removalReason === 'ROUTE_CANCELLED' ||
          participation.removalReason === 'SOURCE_CANCELLATION_WITHDRAWN',
        route: { id: participation.route.id, number: participation.route.number },
      }),
    );
    if (participation.removedAt !== null) {
      const reason = participation.removalReason ?? 'RETURNED_TO_UNASSIGNED';
      const details: TimelineDetail[] = [];
      if (participation.movedToRoute !== null) {
        details.push({ label: 'Новый лист', value: participation.movedToRoute.number });
      }
      events.push(
        event({
          key: `44:route-order-removed:${participation.id}`,
          at: participation.removedAt,
          group: 'LOGISTICS',
          kind: `ROUTE_ORDER_REMOVED_${reason}`,
          title: REMOVAL_TITLES[reason] ?? 'Заказ убран из листа',
          actor: userActor(participation.removedById),
          details,
          reverted: false,
          route: { id: participation.route.id, number: participation.route.number },
        }),
      );
    }
  }

  // 10. Жизнь листов, пока заказ в них состоял.
  const routeWindows = participations.map((participation) => ({
    routeId: participation.route.id,
    number: participation.route.number,
    from: participation.addedAt,
    to: participation.removedAt,
  }));
  if (routeWindows.length > 0) {
    const routeIds = [...new Set(routeWindows.map((window) => window.routeId))];
    const inWindow = (routeId: string, at: Date): boolean =>
      routeWindows.some(
        (window) =>
          window.routeId === routeId &&
          at.getTime() >= window.from.getTime() &&
          (window.to === null || at.getTime() <= window.to.getTime()),
      );
    const numberOf = (routeId: string): string =>
      routeWindows.find((window) => window.routeId === routeId)?.number ?? '';

    const transitions = await db.routeStateTransition.findMany({
      where: { routeId: { in: routeIds } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: { id: true, routeId: true, toState: true, occurredAt: true, actorUserId: true },
    });
    for (const transition of transitions) {
      if (!inWindow(transition.routeId, transition.occurredAt)) {
        continue;
      }
      events.push(
        event({
          key: `42:route-state:${transition.id}`,
          at: transition.occurredAt,
          group: 'LOGISTICS',
          kind: `ROUTE_${transition.toState}`,
          title: ROUTE_STATE_TITLES[transition.toState] ?? 'Состояние листа изменилось',
          actor: userActor(transition.actorUserId),
          details: [],
          reverted: false,
          route: { id: transition.routeId, number: numberOf(transition.routeId) },
        }),
      );
    }

    const routeAudit = await db.auditLog.findMany({
      where: {
        entityType: 'DeliveryRoute',
        entityId: { in: routeIds },
        action: {
          in: ['ROUTE_COURIER_ASSIGNED', 'ROUTE_COURIER_UNASSIGNED', 'ROUTE_ORDERS_REORDERED'],
        },
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        action: true,
        entityId: true,
        occurredAt: true,
        actorUserId: true,
        actorRoles: true,
        newValue: true,
      },
    });
    for (const entry of routeAudit) {
      const routeId = entry.entityId ?? '';
      if (!inWindow(routeId, entry.occurredAt)) {
        continue;
      }
      const payload = (entry.newValue ?? {}) as {
        courierUserId?: string | null;
        previousCourierUserId?: string | null;
        orderIds?: string[];
      };
      const route = { id: routeId, number: numberOf(routeId) };
      const actor = userActor(entry.actorUserId, entry.actorRoles);

      if (entry.action === 'ROUTE_ORDERS_REORDERED') {
        // Порядок листа меняется целиком; наш заказ упоминается позицией.
        const index = (payload.orderIds ?? []).indexOf(order.id);
        if (index < 0) {
          continue;
        }
        events.push(
          event({
            key: `43:audit:${String(entry.id)}`,
            at: entry.occurredAt,
            group: 'LOGISTICS',
            kind: 'ROUTE_ORDER_REORDERED',
            title: 'Порядок заказов в листе изменён',
            actor,
            details: [{ label: 'Новая позиция', value: String(index + 1) }],
            reverted: false,
            route,
          }),
        );
        continue;
      }

      events.push(
        event({
          key: `41:audit:${String(entry.id)}`,
          at: entry.occurredAt,
          group: 'LOGISTICS',
          kind: entry.action,
          title:
            entry.action === 'ROUTE_COURIER_ASSIGNED'
              ? payload.previousCourierUserId === null ||
                payload.previousCourierUserId === undefined
                ? 'Курьер назначен на лист'
                : 'Курьер листа заменён'
              : 'Курьер снят с листа',
          actor,
          details: [],
          reverted: false,
          route,
        }),
      );
    }
  }

  // 11. Доставка и её отмена.
  const attempts = await db.deliveryAttempt.findMany({
    where: { orderId: order.id },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      outcome: true,
      reasonNameSnapshot: true,
      occurredAt: true,
      courierUserId: true,
      route: { select: { id: true, number: true } },
      cancellation: {
        select: { id: true, kind: true, reason: true, occurredAt: true, actorUserId: true },
      },
    },
  });
  for (const attempt of attempts) {
    const details: TimelineDetail[] = [];
    if (attempt.reasonNameSnapshot !== null) {
      details.push({ label: 'Причина', value: attempt.reasonNameSnapshot });
    }
    events.push(
      event({
        key: `50:attempt:${attempt.id}`,
        at: attempt.occurredAt,
        group: 'DELIVERY',
        kind: attempt.outcome === 'DELIVERED' ? 'DELIVERY_DELIVERED' : 'DELIVERY_FAILED',
        title: attempt.outcome === 'DELIVERED' ? 'Заказ доставлен' : 'Заказ не доставлен',
        actor: userActor(attempt.courierUserId),
        details,
        // Отменённый результат остаётся строкой и получает пометку.
        reverted: attempt.cancellation !== null,
        route: attempt.route,
      }),
    );
    if (attempt.cancellation !== null) {
      const cancellation = attempt.cancellation;
      const details2: TimelineDetail[] = [];
      if (cancellation.reason !== null) {
        details2.push({ label: 'Причина', value: cancellation.reason });
      }
      events.push(
        event({
          key: `51:attempt-cancel:${cancellation.id}`,
          at: cancellation.occurredAt,
          group: 'DELIVERY',
          kind: `DELIVERY_RESULT_CANCELLED_${cancellation.kind}`,
          title:
            cancellation.kind === 'COURIER_SELF'
              ? 'Курьер отменил свой результат'
              : 'Результат доставки исправлен логистом',
          actor: userActor(cancellation.actorUserId),
          details: details2,
          reverted: false,
          route: attempt.route,
        }),
      );
    }
  }

  // 12. Решения логиста по недоставке.
  const resolutions = await db.orderResolution.findMany({
    where: { orderId: order.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      kind: true,
      reasonNameSnapshot: true,
      createdAt: true,
      decision: true,
      decidedAt: true,
      decidedById: true,
    },
  });
  for (const resolution of resolutions) {
    events.push(
      event({
        key: `60:resolution:${resolution.id}`,
        at: resolution.createdAt,
        group: 'RETURN',
        kind: 'ORDER_RESOLUTION_OPENED',
        title: 'Открыта задача решения по заказу',
        actor: SYSTEM_ACTOR,
        details: [{ label: 'Причина', value: resolution.reasonNameSnapshot }],
        reverted: false,
        route: null,
      }),
    );
    if (resolution.decision !== null && resolution.decidedAt !== null) {
      events.push(
        event({
          key: `61:resolution-decision:${resolution.id}`,
          at: resolution.decidedAt,
          group: 'RETURN',
          kind: `ORDER_RESOLUTION_${resolution.decision}`,
          title: DECISION_TITLES[resolution.decision] ?? 'Решение логиста принято',
          actor: userActor(resolution.decidedById),
          details: [],
          reverted: false,
          route: null,
        }),
      );
    }
  }

  // 13. Возвраты и их движение.
  const returns = await db.orderReturn.findMany({
    where: { orderId: order.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      displayNumber: true,
      sequence: true,
      createdAt: true,
      transitions: {
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: { id: true, toState: true, occurredAt: true, actorUserId: true, reason: true },
      },
      placement: { select: { cell: { select: { code: true } } } },
    },
  });
  for (const orderReturn of returns) {
    events.push(
      event({
        key: `70:return:${orderReturn.id}`,
        at: orderReturn.createdAt,
        group: 'RETURN',
        kind: 'ORDER_RETURN_OPENED',
        title: 'Возникло обязательство вернуть букет на склад',
        actor: SYSTEM_ACTOR,
        details: [
          { label: 'Возврат', value: orderReturn.displayNumber },
          { label: 'Круг', value: String(orderReturn.sequence) },
        ],
        reverted: false,
        route: null,
      }),
    );
    for (const transition of orderReturn.transitions) {
      const details: TimelineDetail[] = [{ label: 'Возврат', value: orderReturn.displayNumber }];
      if (transition.toState === 'ACCEPTED' && orderReturn.placement !== null) {
        details.push({ label: 'Ячейка возврата', value: orderReturn.placement.cell.code });
      }
      if (transition.reason !== null) {
        details.push({ label: 'Причина', value: transition.reason });
      }
      events.push(
        event({
          key: `71:return-transition:${transition.id}`,
          at: transition.occurredAt,
          group: 'RETURN',
          kind: `ORDER_RETURN_${transition.toState}`,
          title: RETURN_STATE_TITLES[transition.toState] ?? 'Состояние возврата изменилось',
          actor: userActor(transition.actorUserId),
          details,
          reverted: false,
          route: null,
        }),
      );
    }
  }

  // Имена авторов — одним запросом на всю страницу.
  const userIds = collectUserIds(events);
  const users =
    userIds.length === 0
      ? []
      : await db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, fullName: true },
        });
  const nameOf = new Map(users.map((user) => [user.id, user.fullName]));
  for (const entry of events) {
    if (entry.actor.userId !== null) {
      entry.actor.fullName = nameOf.get(entry.actor.userId) ?? null;
    }
  }

  /*
   * Устойчивый порядок.
   *
   * Одна транзакция пишет несколько строк с одинаковым временем, и без второго
   * ключа соседние события менялись бы местами между запросами — курсор
   * страницы после этого показывал бы то пропуск, то повтор.
   */
  events.sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) {
      return a.occurredAt < b.occurredAt ? -1 : 1;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const cursor = input.cursor === null ? null : decodeCursor(input.cursor);
  const startIndex =
    cursor === null
      ? 0
      : events.findIndex(
          (entry) =>
            entry.occurredAt > cursor.occurredAt ||
            (entry.occurredAt === cursor.occurredAt && entry.key > cursor.key),
        );
  const from = startIndex < 0 ? events.length : startIndex;
  const page = events.slice(from, from + input.limit);
  const last = page[page.length - 1];
  const hasMore = from + page.length < events.length;

  return {
    header: buildHeader(order, {
      participations,
      placements,
      attempts,
      returns,
    }),
    events: page,
    nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
    total: events.length,
  };
}

/**
 * Шапка: текущее состояние заказа одним взглядом.
 *
 * Здесь нет ни одного вычисленного «наверное»: каждое поле берётся из строки
 * заказа или из последней строки соответствующего источника, а отсутствующее
 * остаётся пустым.
 */
function buildHeader(
  order: {
    id: string;
    externalName: string;
    externalStateName: string | null;
    deliveryMethodId: string | null;
    deliveryDate: Date | null;
    intervalStartMinute: number | null;
    intervalEndMinute: number | null;
    manualIntervalStartMinute: number | null;
    manualIntervalEndMinute: number | null;
    localAddress: string | null;
    address: string | null;
    structuredAddress: string | null;
    addressDetails: string | null;
    addressContractVersion: number | null;
    fulfillmentProcessState: string;
    fulfillmentAssignee: { id: string; fullName: string } | null;
    cancelledInSource: boolean;
    cancelledInSourceAt: Date | null;
    cancelledByLogistAt: Date | null;
  },
  sources: {
    participations: {
      removedAt: Date | null;
      position: number;
      route: {
        id: string;
        number: string;
        state: string;
        courier: { id: string; fullName: string } | null;
      };
    }[];
    placements: {
      releasedAt: Date | null;
      cell: { code: string; kind: string };
    }[];
    attempts: {
      outcome: string;
      occurredAt: Date;
      reasonNameSnapshot: string | null;
      cancellation: { id: string } | null;
    }[];
    returns: { displayNumber: string; transitions: { toState: string }[] }[];
  },
): TimelineHeader {
  const activeParticipation = sources.participations
    .filter((item) => item.removedAt === null)
    .pop();
  const activePlacement = sources.placements.filter((item) => item.releasedAt === null).pop();
  const lastAttempt = sources.attempts.filter((item) => item.cancellation === null).pop();
  const lastReturn = sources.returns[sources.returns.length - 1];
  const manual = order.manualIntervalStartMinute !== null && order.manualIntervalEndMinute !== null;

  return {
    orderId: order.id,
    number: order.externalName,
    processState: order.fulfillmentProcessState,
    externalState: order.externalStateName,
    // Самовывоз опознаётся точным справочником, а не текстом названия.
    pickup: order.deliveryMethodId === MOYSKLAD_IDS.deliveryMethodPickup,
    deliveryDate: order.deliveryDate === null ? null : fromDateColumn(order.deliveryDate),
    interval: {
      startMinute: manual ? order.manualIntervalStartMinute : order.intervalStartMinute,
      endMinute: manual ? order.manualIntervalEndMinute : order.intervalEndMinute,
      manual,
    },
    address: effectiveAddress(order),
    addressDetails: addressDetailsOf(order),
    florist: order.fulfillmentAssignee,
    route:
      activeParticipation === undefined
        ? null
        : {
            id: activeParticipation.route.id,
            number: activeParticipation.route.number,
            state: activeParticipation.route.state,
          },
    courier: activeParticipation?.route.courier ?? null,
    cell:
      activePlacement === undefined
        ? null
        : {
            code: activePlacement.cell.code,
            kind: CELL_KINDS[activePlacement.cell.kind] ?? activePlacement.cell.kind,
          },
    delivery:
      lastAttempt === undefined
        ? null
        : {
            outcome: lastAttempt.outcome,
            occurredAt: lastAttempt.occurredAt.toISOString(),
            reason: lastAttempt.reasonNameSnapshot,
          },
    returnObligation:
      lastReturn === undefined
        ? null
        : {
            displayNumber: lastReturn.displayNumber,
            state:
              lastReturn.transitions[lastReturn.transitions.length - 1]?.toState ?? 'WITH_COURIER',
          },
    cancellation:
      order.cancelledInSource || order.cancelledByLogistAt !== null
        ? {
            source: order.cancelledInSource,
            logist: order.cancelledByLogistAt !== null,
            occurredAt:
              (order.cancelledInSourceAt ?? order.cancelledByLogistAt)?.toISOString() ?? null,
          }
        : null,
  };
}
