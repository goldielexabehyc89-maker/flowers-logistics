/**
 * Очередь флориста: что читать из базы и в каком порядке показывать.
 *
 * Сам порядок считает чистая функция `sortQueue` (`queue.ts`) — здесь только
 * выборка и сборка входа для неё. Разделение не косметическое: правило
 * приоритета групповое, покрыто проверками без базы, и смешивать его с SQL
 * значило бы доказывать его каждый раз заново на живых данных.
 *
 * ОБЛАСТЬ ВЫБОРКИ (`FUL-002` §2.1 и §2.2 задания).
 *
 * Берутся только заказы производственной области (`fulfillmentInScope`), не
 * пропавшие и не архивированные в источнике, с ПОДТВЕРЖДЁННЫМ составом
 * (`READY`). Последнее принципиально: при `PENDING` пустой состав не означает
 * «в заказе ничего нет», и показать такой заказ флористу значило бы предложить
 * собрать букет по неизвестному составу.
 *
 * ДЕНЬ. «Сегодня» и «Завтра» — два раздельных представления, и заказы двух дней
 * никогда не смешиваются. Календарный день считает сервер общими московскими
 * функциями: браузер к вычислению дня не допускается вовсе.
 */

import { moscowToday, shiftCalendarDate } from '@fl/shared';
import type { Database } from '../../platform/db.js';
import type { OrderFulfillmentProcessState } from '../../generated/prisma/enums.js';
import { fromDateColumn, toDateColumn } from '../integrations/moysklad/delivery-date.js';
import {
  effectiveMinutes,
  isOverdue,
  moscowMinuteOfDay,
  routeFirstStopMinute,
  sortQueue,
  type QueueOrder,
  type QueueRoute,
} from './queue.js';

/** Какой из двух дней показывает флорист. */
export type QueueDay = 'today' | 'tomorrow';

/** Общая очередь или собственные заказы. */
export type QueueScope = 'general' | 'mine';

/**
 * Состояния, которые считаются незавершённой работой.
 *
 * `ASSEMBLED` сюда не входит: собранный заказ из очереди сборки уходит —
 * он живёт в «Моих заказах» и во вкладке «Печать». `NEEDS_REVIEW` входит:
 * заказ изменился после сборки, и им обязан кто-то заняться.
 */
const UNFINISHED_STATES = ['NEW', 'IN_ASSEMBLY', 'NEEDS_REVIEW'] as const;

/** Состояния «Моих заказов»: всё, что закреплено за флористом прямо сейчас. */
const MINE_STATES = ['IN_ASSEMBLY', 'ASSEMBLED', 'NEEDS_REVIEW'] as const;

export interface QueueItem {
  id: string;
  number: string;
  deliveryDate: string | null;
  startMinute: number | null;
  endMinute: number | null;
  overdue: boolean;
  processState: string;
  assignee: { id: string; fullName: string } | null;
  route: { id: string; number: string; position: number | null } | null;
  /** Есть ли уже собранный бланк: карточка показывает действия печати. */
  hasPrintForm: boolean;
  /** Производственные данные изменились после того, как заказ взяли в работу. */
  changedSinceClaim: boolean;
}

export interface QueueResult {
  day: QueueDay;
  /** Календарная дата Москвы, к которой относится представление. */
  deliveryDate: string;
  scope: QueueScope;
  includeAssigned: boolean;
  items: QueueItem[];
}

export interface QueueQuery {
  day: QueueDay;
  scope: QueueScope;
  /** Галочка «Все»: добавить к общей очереди уже назначенные заказы. */
  includeAssigned: boolean;
}

/** Календарная дата выбранного представления. Считается только сервером. */
export function resolveQueueDate(day: QueueDay, now: Date): string {
  const today = moscowToday(now);
  return day === 'today' ? today : shiftCalendarDate(today, 1);
}

function orderSelect(date: string) {
  return {
    id: true,
    externalName: true,
    deliveryDate: true,
    intervalKind: true,
    intervalStartMinute: true,
    intervalEndMinute: true,
    manualIntervalStartMinute: true,
    manualIntervalEndMinute: true,
    fulfillmentProcessState: true,
    fulfillmentAssignedAt: true,
    fulfillmentAssignee: { select: { id: true, fullName: true } },
    printForms: { select: { id: true }, take: 1 },
    // Последняя производственная ревизия: по ней видно, менялся ли заказ после
    // того, как его взяли в работу. Отдельной колонки для этого не заводится —
    // ревизии неизменяемы, и их отметка времени достовернее любого флага.
    fulfillmentRevisions: {
      select: { receivedAt: true },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }] as {
        receivedAt?: 'desc';
        id?: 'desc';
      }[],
      take: 1,
    },
    /**
     * Активное участие в ПОДТВЕРЖДЁННОМ маршруте выбранного дня.
     *
     * Черновик приоритета не даёт: он ещё меняется, и собирать под него нечего.
     * Отменённый — тем более.
     */
    routeOrders: {
      where: {
        removedAt: null,
        route: { state: 'CONFIRMED' as const, deliveryDate: toDateColumn(date) },
      },
      select: { position: true, route: { select: { id: true, number: true } } },
    },
  };
}

/**
 * Очередь одного представления.
 *
 * Строк здесь сотни, а не миллионы: день ограничен физической пропускной
 * способностью мастерской. Поэтому порядок считается в памяти общей функцией,
 * а не подзапросами, которые пришлось бы доказывать заново на каждом плане.
 */
export async function readQueue(
  db: Database,
  viewer: { userId: string },
  query: QueueQuery,
  now: Date = new Date(),
): Promise<QueueResult> {
  const date = resolveQueueDate(query.day, now);
  const todayMoscow = moscowToday(now);

  const states: OrderFulfillmentProcessState[] =
    query.scope === 'mine'
      ? [...MINE_STATES]
      : query.includeAssigned
        ? [...UNFINISHED_STATES]
        : ['NEW'];

  const rows = await db.deliveryOrder.findMany({
    where: {
      fulfillmentInScope: true,
      sourceArchived: false,
      sourceMissing: false,
      // Пустой состав при `PENDING` неотличим от настоящего пустого состава,
      // поэтому в очередь попадает только подтверждённый.
      fulfillmentCompositionState: 'READY',
      deliveryDate: toDateColumn(date),
      fulfillmentProcessState: { in: states },
      ...(query.scope === 'mine' ? { fulfillmentAssigneeId: viewer.userId } : {}),
    },
    select: orderSelect(date),
  });

  const routes = await readRoutes(db, rows);

  const queueOrders: QueueOrder[] = rows.map((row) => {
    const minutes = effectiveMinutes(row);
    const participation = row.routeOrders[0];
    return {
      id: row.id,
      externalName: row.externalName,
      startMinute: minutes.startMinute,
      endMinute: minutes.endMinute,
      route: participation === undefined ? null : (routes.get(participation.route.id) ?? null),
      routePosition: participation?.position ?? null,
    };
  });

  const context = {
    viewDate: date,
    todayMoscow,
    nowMinuteMoscow: moscowMinuteOfDay(now),
  };

  const byId = new Map(rows.map((row) => [row.id, row]));
  const sorted = sortQueue(queueOrders, context);

  return {
    day: query.day,
    deliveryDate: date,
    scope: query.scope,
    includeAssigned: query.includeAssigned,
    items: sorted.map((entry) => {
      const row = byId.get(entry.id);
      const participation = row?.routeOrders[0];
      return {
        id: entry.id,
        number: entry.externalName,
        deliveryDate:
          row?.deliveryDate === undefined || row.deliveryDate === null
            ? null
            : fromDateColumn(row.deliveryDate),
        startMinute: entry.startMinute,
        endMinute: entry.endMinute,
        overdue: isOverdue(entry, context),
        processState: row?.fulfillmentProcessState ?? 'NEW',
        // Имя показывается только там, где оно нужно для решения: занятый заказ
        // должен объяснять, кем именно он занят.
        assignee:
          row === undefined || row.fulfillmentAssignee === null
            ? null
            : { id: row.fulfillmentAssignee.id, fullName: row.fulfillmentAssignee.fullName },
        route:
          participation === undefined
            ? null
            : {
                id: participation.route.id,
                number: participation.route.number,
                position: participation.position,
              },
        hasPrintForm: (row?.printForms.length ?? 0) > 0,
        changedSinceClaim: row === undefined ? false : hasChangedSinceClaim(row),
      };
    }),
  };
}

/**
 * «Заказ изменён» без отдельной колонки.
 *
 * Флаг не хранится намеренно: хранимый признак пришлось бы согласовывать
 * с импортом, а рассогласование давало бы либо ложную тревогу, либо молчание
 * там, где состав действительно поменяли. Ревизии неизменяемы и датированы —
 * сравнение их отметки с моментом захвата даёт тот же ответ и не может
 * разойтись с фактом.
 */
function hasChangedSinceClaim(row: {
  fulfillmentAssignedAt: Date | null;
  fulfillmentProcessState: string;
  fulfillmentRevisions: { receivedAt: Date }[];
}): boolean {
  if (row.fulfillmentProcessState !== 'IN_ASSEMBLY' || row.fulfillmentAssignedAt === null) {
    return false;
  }
  const last = row.fulfillmentRevisions[0];
  return last !== undefined && last.receivedAt.getTime() > row.fulfillmentAssignedAt.getTime();
}

/**
 * Время первой доставки каждого подтверждённого маршрута.
 *
 * Считается по ВСЕМ активным остановкам маршрута, а не только по заказам,
 * попавшим в выборку: половина маршрута уже может быть собрана, и «самый
 * ранний лист» не должен меняться по мере сборки — иначе очередь
 * переупорядочивалась бы сама собой в течение дня.
 */
async function readRoutes(
  db: Database,
  rows: readonly { routeOrders: readonly { route: { id: string } }[] }[],
): Promise<Map<string, QueueRoute>> {
  const routeIds = [
    ...new Set(
      rows.flatMap((row) => row.routeOrders.map((participation) => participation.route.id)),
    ),
  ];
  if (routeIds.length === 0) {
    return new Map();
  }

  const stops = await db.routeOrder.findMany({
    where: { routeId: { in: routeIds }, removedAt: null },
    select: {
      routeId: true,
      route: { select: { number: true } },
      order: {
        select: {
          intervalKind: true,
          intervalStartMinute: true,
          intervalEndMinute: true,
          manualIntervalStartMinute: true,
          manualIntervalEndMinute: true,
        },
      },
    },
  });

  const grouped = new Map<string, { number: string; minutes: { startMinute: number | null }[] }>();
  for (const stop of stops) {
    const entry = grouped.get(stop.routeId) ?? { number: stop.route.number, minutes: [] };
    entry.minutes.push({ startMinute: effectiveMinutes(stop.order).startMinute });
    grouped.set(stop.routeId, entry);
  }

  const result = new Map<string, QueueRoute>();
  for (const [id, entry] of grouped) {
    result.set(id, {
      id,
      number: entry.number,
      firstStopMinute: routeFirstStopMinute(entry.minutes),
    });
  }
  return result;
}
