/**
 * Поиск заказа для раздела «История заказов».
 *
 * Отдельный вход нужен потому, что все существующие списки ограничены днём:
 * «Сделки» показывают выбранную дату, очередь флориста — сегодня и завтра,
 * маршрутные листы — свой день. История же нужна ровно тогда, когда заказ
 * давно закрыт: доставлен месяц назад, отменён, списан или уехал на повторную
 * доставку. Искать его в дневных списках нечем.
 *
 * ЧТО ЭТО НЕ ТАКОЕ. Это не второй источник истории: сама лента по-прежнему
 * одна (`timeline.ts`). Здесь только отбор заказов и краткое состояние строки,
 * чтобы человек нашёл нужный заказ и открыл его историю.
 *
 * ПОИСК ИДЁТ ПО БАЗЕ, А НЕ ПО ЗАГРУЖЕННОЙ СТРАНИЦЕ. Отбор и срез выполняет
 * сервер: клиентский фильтр по полусотне строк молчаливо «не находил» бы
 * заказ, лежащий на второй странице.
 *
 * НОМЕР ВОЗВРАТА ТОЖЕ НАХОДИТ ЗАКАЗ. Человеку показывают номер возврата
 * (`OrderReturn.displayNumber`), и искать его он будет именно так. Открывается
 * при этом история ИСХОДНОГО заказа по его постоянному идентификатору:
 * возврат — это событие заказа, а не отдельная сущность истории.
 *
 * ПЕРСОНАЛЬНЫХ ДАННЫХ В ОТВЕТЕ НЕТ. Ни получателя, ни телефона, ни
 * комментария, ни состава: строка отвечает на вопрос «тот ли это заказ»,
 * а подробности живут в самой истории.
 */

import type { Database } from '../../platform/db.js';
import { fromDateColumn } from '../integrations/moysklad/delivery-date.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';

/** Наибольшая страница поиска. Больше — это уже выгрузка, а её здесь нет. */
export const HISTORY_SEARCH_LIMIT_MAX = 50;
export const HISTORY_SEARCH_LIMIT_DEFAULT = 20;

/** Длиннее номера заказа не бывает: остальное — способ занять базу впустую. */
export const HISTORY_SEARCH_QUERY_MAX = 64;

export interface HistorySearchRow {
  orderId: string;
  number: string;
  /** Стадия производства: по ней видно, дошёл ли заказ до сборки. */
  processState: string;
  externalState: string | null;
  pickup: boolean;
  deliveryDate: string | null;
  interval: { startMinute: number | null; endMinute: number | null; manual: boolean };
  florist: { id: string; fullName: string } | null;
  route: { id: string; number: string; state: string } | null;
  courier: { id: string; fullName: string } | null;
  cell: { code: string; kind: string } | null;
  delivery: { outcome: string; occurredAt: string; reason: string | null } | null;
  returnObligation: { displayNumber: string; state: string } | null;
  cancellation: { source: boolean; logist: boolean } | null;
  /** Момент последнего события заказа. `null` — событий пока нет вовсе. */
  lastEventAt: string | null;
}

export interface HistorySearchPage {
  items: HistorySearchRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

const CELL_KINDS: Record<string, string> = { STORAGE: 'Хранение', ROUTE: 'Маршрутная' };

/** Строка поиска или `null`, если искать нечего. */
export function normalizeQuery(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed.slice(0, HISTORY_SEARCH_QUERY_MAX);
}

/**
 * Наибольшее из времён источника.
 *
 * `null` в источнике — это «события не было», а не «было давно»: такие
 * значения просто не участвуют.
 */
function latest(values: readonly (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    if (best === null || value.getTime() > best.getTime()) {
      best = value;
    }
  }
  return best;
}

/**
 * Поиск заказов по номеру заказа или номеру возврата.
 *
 * Дня в условии нет намеренно: ограничение днём и делает существующие списки
 * непригодными для разбора. Отбор идёт по постоянному человеческому ключу —
 * номеру, — а открывается история по внутреннему идентификатору.
 */
export async function searchOrderHistory(
  db: Database,
  input: { query: string | null; limit: number; offset: number },
): Promise<HistorySearchPage> {
  if (input.query === null) {
    return { items: [], total: 0, limit: input.limit, offset: input.offset, hasMore: false };
  }

  /*
   * Номер возврата ведёт к своему заказу.
   *
   * Возвратов у заказа может быть несколько, и все они указывают на один и тот
   * же заказ: список идентификаторов схлопывается в множество.
   */
  const returns = await db.orderReturn.findMany({
    where: { displayNumber: { contains: input.query, mode: 'insensitive' } },
    select: { orderId: true },
    take: HISTORY_SEARCH_LIMIT_MAX,
  });
  const byReturn = [...new Set(returns.map((row) => row.orderId))];

  const where = {
    OR: [
      { externalName: { contains: input.query, mode: 'insensitive' as const } },
      ...(byReturn.length === 0 ? [] : [{ id: { in: byReturn } }]),
    ],
  };

  const [total, rows] = await Promise.all([
    db.deliveryOrder.count({ where }),
    db.deliveryOrder.findMany({
      where,
      /*
       * Порядок устойчив: свежие заказы сверху, при равной дате — по номеру.
       * Без второго ключа две страницы могли бы показать одну строку дважды
       * и пропустить соседнюю.
       */
      orderBy: [{ deliveryDate: 'desc' }, { externalName: 'asc' }],
      skip: input.offset,
      take: input.limit,
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
        fulfillmentProcessState: true,
        fulfillmentAssignee: { select: { id: true, fullName: true } },
        cancelledInSource: true,
        cancelledByLogistAt: true,
        updatedAt: true,
        placements: {
          where: { releasedAt: null },
          orderBy: { placedAt: 'desc' },
          take: 1,
          select: { cell: { select: { code: true, kind: true } } },
        },
        routeOrders: {
          where: { removedAt: null },
          orderBy: { addedAt: 'desc' },
          take: 1,
          select: {
            route: {
              select: {
                id: true,
                number: true,
                state: true,
                courier: { select: { id: true, fullName: true } },
              },
            },
          },
        },
        deliveryAttempts: {
          where: { cancellation: null },
          orderBy: { occurredAt: 'desc' },
          take: 1,
          select: { outcome: true, occurredAt: true, reasonNameSnapshot: true },
        },
        returns: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { displayNumber: true, state: true },
        },
      },
    }),
  ]);

  const ids = rows.map((row) => row.id);
  const lastEvents = ids.length === 0 ? new Map<string, Date>() : await readLastEvents(db, ids);

  return {
    items: rows.map((row) => {
      const manual = row.manualIntervalStartMinute !== null && row.manualIntervalEndMinute !== null;
      const placement = row.placements[0];
      const participation = row.routeOrders[0];
      const attempt = row.deliveryAttempts[0];
      const orderReturn = row.returns[0];
      const cancelled = row.cancelledInSource || row.cancelledByLogistAt !== null;

      return {
        orderId: row.id,
        number: row.externalName,
        processState: row.fulfillmentProcessState,
        externalState: row.externalStateName,
        pickup: row.deliveryMethodId === MOYSKLAD_IDS.deliveryMethodPickup,
        deliveryDate: row.deliveryDate === null ? null : fromDateColumn(row.deliveryDate),
        interval: {
          startMinute: manual ? row.manualIntervalStartMinute : row.intervalStartMinute,
          endMinute: manual ? row.manualIntervalEndMinute : row.intervalEndMinute,
          manual,
        },
        florist: row.fulfillmentAssignee,
        route:
          participation === undefined
            ? null
            : {
                id: participation.route.id,
                number: participation.route.number,
                state: participation.route.state,
              },
        courier: participation?.route.courier ?? null,
        cell:
          placement === undefined
            ? null
            : {
                code: placement.cell.code,
                kind: CELL_KINDS[placement.cell.kind] ?? placement.cell.kind,
              },
        delivery:
          attempt === undefined
            ? null
            : {
                outcome: attempt.outcome,
                occurredAt: attempt.occurredAt.toISOString(),
                reason: attempt.reasonNameSnapshot,
              },
        returnObligation:
          orderReturn === undefined
            ? null
            : { displayNumber: orderReturn.displayNumber, state: orderReturn.state },
        cancellation: cancelled
          ? { source: row.cancelledInSource, logist: row.cancelledByLogistAt !== null }
          : null,
        lastEventAt: lastEvents.get(row.id)?.toISOString() ?? null,
      };
    }),
    total,
    limit: input.limit,
    offset: input.offset,
    hasMore: input.offset + rows.length < total,
  };
}

/**
 * Момент последнего события каждого заказа страницы.
 *
 * Считается по тем же источникам, из которых строится лента: брать `updatedAt`
 * строки заказа было бы неправдой — она меняется и от служебных записей, и не
 * меняется вовсе, когда событие произошло в соседней таблице.
 *
 * Запросы групповые: по одному на источник, а не по одному на заказ.
 */
async function readLastEvents(db: Database, ids: readonly string[]): Promise<Map<string, Date>> {
  const orderIds = [...ids];
  const [revisions, addresses, placements, participations, attempts, returns, audits] =
    await Promise.all([
      db.deliveryOrderRevision.groupBy({
        by: ['orderId'],
        where: { orderId: { in: orderIds } },
        _max: { receivedAt: true },
      }),
      db.orderAddressHistory.groupBy({
        by: ['orderId'],
        where: { orderId: { in: orderIds } },
        _max: { occurredAt: true },
      }),
      db.orderPlacement.groupBy({
        by: ['orderId'],
        where: { orderId: { in: orderIds } },
        _max: { placedAt: true, releasedAt: true },
      }),
      db.routeOrder.groupBy({
        by: ['orderId'],
        where: { orderId: { in: orderIds } },
        _max: { addedAt: true, removedAt: true },
      }),
      db.deliveryAttempt.groupBy({
        by: ['orderId'],
        where: { orderId: { in: orderIds } },
        _max: { occurredAt: true },
      }),
      db.orderReturn.groupBy({
        by: ['orderId'],
        where: { orderId: { in: orderIds } },
        _max: { createdAt: true, acceptedAt: true },
      }),
      db.auditLog.groupBy({
        by: ['entityId'],
        where: { entityType: 'DeliveryOrder', entityId: { in: orderIds } },
        _max: { occurredAt: true },
      }),
    ]);

  const result = new Map<string, Date>();
  const put = (orderId: string | null, value: Date | null): void => {
    if (orderId === null || value === null) {
      return;
    }
    const current = result.get(orderId);
    if (current === undefined || value.getTime() > current.getTime()) {
      result.set(orderId, value);
    }
  };

  for (const row of revisions) put(row.orderId, row._max.receivedAt);
  for (const row of addresses) put(row.orderId, row._max.occurredAt);
  for (const row of placements) put(row.orderId, latest([row._max.placedAt, row._max.releasedAt]));
  for (const row of participations)
    put(row.orderId, latest([row._max.addedAt, row._max.removedAt]));
  for (const row of attempts) put(row.orderId, row._max.occurredAt);
  for (const row of returns) put(row.orderId, latest([row._max.createdAt, row._max.acceptedAt]));
  for (const row of audits) put(row.entityId, row._max.occurredAt);

  return result;
}
