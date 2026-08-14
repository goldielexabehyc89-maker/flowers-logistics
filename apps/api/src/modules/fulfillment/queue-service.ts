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
 *
 * СТРАНИЦА — ПОСЛЕ ПОРЯДКА. Из базы читается вся выборка выбранного дня и
 * области видимости, `sortQueue` упорядочивает её целиком, и только потом
 * `takePage` отдаёт запрошенный кусок. Обратный порядок (обрезать в SQL,
 * упорядочить остаток) разрушил бы групповой приоритет маршрутов — подробный
 * разбор в `paging.ts`.
 *
 * ПОИСК ПО НОМЕРУ сужает ту же выборку, а не открывает новую: день и область
 * видимости остаются условием запроса, поэтому найти чужой день или чужой
 * заказ поиском невозможно.
 *
 * «МОИ ЗАКАЗЫ» — ДВЕ ОБЛАСТИ, А НЕ ОДИН СПИСОК (`FUL-008`).
 *
 * Работа (`IN_ASSEMBLY`, `NEEDS_REVIEW`) и собранные (`ASSEMBLED`) читаются
 * РАЗНЫМИ запросами со своей страницей каждый, а счётчик собранных считается
 * базой. Отфильтровать всё `mine` в браузере было бы неверно вдвойне: страница
 * из пятидесяти строк дала бы счётчик «собранных» по загруженному куску, а не
 * по дню, и заказ за границей страницы просто не существовал бы. Свёрнутая
 * группа не запрашивается вовсе — только её точное число.
 *
 * СЧЁТЧИК АКТИВНЫХ ЗАКАЗОВ — ТРЕТЬЕ ЧИСЛО И САМОЕ НЕЗАВИСИМОЕ.
 *
 * `countActiveAssignments` считает работу, числящуюся за флористом, БЕЗ дня,
 * поиска и страницы: он виден постоянно, в том числе на вкладках «Очередь» и
 * «Печать», где списка «Моих заказов» на экране нет вовсе. Поэтому вывести его
 * из ответа очереди невозможно — он приходит отдельным полем и считается базой.
 */

import { moscowToday, shiftCalendarDate } from '@fl/shared';
import type { Database } from '../../platform/db.js';
import type { OrderFulfillmentProcessState } from '../../generated/prisma/enums.js';
import { fromDateColumn, toDateColumn } from '../integrations/moysklad/delivery-date.js';
import {
  normalizePageRequest,
  pageInfo,
  takePage,
  type PageInfo,
  type PageRequest,
} from './paging.js';
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
 * Область внутри «Моих заказов»: работа или уже собранное.
 *
 * Для общей очереди значение всегда `work`: собранный заказ в неё не попадает
 * ни при какой галочке.
 */
export type QueueGroup = 'work' | 'assembled';

/**
 * Состояния, которые считаются незавершённой работой.
 *
 * `ASSEMBLED` сюда не входит: собранный заказ из очереди сборки уходит —
 * он живёт в «Моих заказах» и во вкладке «Печать». `NEEDS_REVIEW` входит:
 * заказ изменился после сборки, и им обязан кто-то заняться.
 */
const UNFINISHED_STATES = ['NEW', 'IN_ASSEMBLY', 'NEEDS_REVIEW'] as const;

/**
 * Рабочая область «Моих заказов».
 *
 * `NEEDS_REVIEW` здесь, а не среди собранных: изменившийся после сборки заказ
 * не завершён, и спрятать его в свёрнутую группу значило бы скрыть требующую
 * действия работу за один клик от глаз (`FUL-008`).
 */
const MINE_WORK_STATES = ['IN_ASSEMBLY', 'NEEDS_REVIEW'] as const;

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

export interface QueueResult extends PageInfo {
  day: QueueDay;
  /** Календарная дата Москвы, к которой относится представление. */
  deliveryDate: string;
  scope: QueueScope;
  group: QueueGroup;
  includeAssigned: boolean;
  /** Применённый поиск по номеру: клиент показывает его как действующий фильтр. */
  search: string | null;
  /**
   * Сколько собранных заказов у флориста в этом дне (и при этом поиске).
   *
   * Считается базой и приходит в ОБОИХ ответах области `mine`, в том числе
   * когда группа свёрнута и её строки не запрашивались вовсе. Без этого числа
   * заголовок «Собранные» пришлось бы либо считать по загруженной странице,
   * либо не показывать вовсе — и собранный заказ исчезал бы бесследно.
   *
   * `null` для общей очереди: там собранных нет по определению.
   */
  assembledTotal: number | null;
  items: QueueItem[];
}

export interface QueueQuery extends Partial<PageRequest> {
  day: QueueDay;
  scope: QueueScope;
  /** Работа или собранные. Имеет смысл только для области `mine`. */
  group?: QueueGroup;
  /** Галочка «Все»: добавить к общей очереди уже назначенные заказы. */
  includeAssigned: boolean;
  /**
   * Точный или частичный номер заказа.
   *
   * Пустая строка и пробелы поиском не считаются: иначе случайный пробел
   * в поле превратил бы всю очередь в пустой список без видимой причины.
   */
  search?: string | null;
}

/**
 * Наибольшая длина строки поиска.
 *
 * Номер заказа короткий; всё, что длиннее, — не номер, а способ заставить базу
 * просматривать таблицу впустую.
 */
export const MAX_SEARCH_LENGTH = 64;

/** Строка поиска или `null`, если искать нечего. */
export function normalizeSearch(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed.slice(0, MAX_SEARCH_LENGTH);
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
 *
 * Читается вся выборка дня, упорядочивается целиком и только затем режется на
 * страницы. Ответ содержит `total` и `hasMore`, поэтому клиенту не приходится
 * угадывать, есть ли продолжение, по числу полученных строк.
 */
/**
 * Общая часть условия обеих областей: день, производственная область и поиск.
 *
 * Одно место намеренно: рабочий список, страница собранных и счётчик собранных
 * обязаны отбирать заказы по одинаковым правилам. Разойдись они хоть в одном
 * условии — счётчик показал бы одно число, а раскрытая группа другое.
 */
function buildScopeWhere(input: {
  /** `null` — все дни сразу: так считается счётчик активных заказов. */
  date: string | null;
  assigneeId: string | null;
  search: string | null;
}) {
  return {
    fulfillmentInScope: true,
    sourceArchived: false,
    sourceMissing: false,
    // Пустой состав при `PENDING` неотличим от настоящего пустого состава,
    // поэтому в очередь попадает только подтверждённый.
    fulfillmentCompositionState: 'READY' as const,
    ...(input.date === null ? {} : { deliveryDate: toDateColumn(input.date) }),
    ...(input.assigneeId === null ? {} : { fulfillmentAssigneeId: input.assigneeId }),
    // Поиск сужает уже ограниченную выборку и не заменяет ни одного её
    // условия: день, область видимости и состояния остаются в силе.
    // Регистр не учитывается — номер вводят как придётся.
    ...(input.search === null
      ? {}
      : { externalName: { contains: input.search, mode: 'insensitive' as const } }),
  };
}

type ScopeWhere = ReturnType<typeof buildScopeWhere>;

/**
 * Сколько заказов сейчас числится за флористом. Считает БАЗА.
 *
 * КОНТРАКТ ЧИСЛА.
 *
 *  * состояния — `IN_ASSEMBLY` и `NEEDS_REVIEW`, те же, что образуют рабочую
 *    область «Моих заказов». `ASSEMBLED` не входит: собранный заказ работой
 *    не является и живёт в свёрнутой группе «Собранные» со своим счётчиком;
 *  * день, поиск и страница в условие НЕ входят. Счётчик отвечает на вопрос
 *    «сколько работы за мной», а не «сколько её видно в текущем фильтре»:
 *    заказ на завтра, взятый утром, не должен исчезать из числа от того, что
 *    человек переключил день на «Сегодня», а поиск по номеру не должен
 *    превращать двойку в единицу;
 *  * остальные условия те же, что у списка (`buildScopeWhere`), — иначе
 *    счётчик обещал бы работу, которой в «Моих заказах» не найти.
 *
 * Считать это число в браузере нельзя ни при каком удобстве: страница из
 * пятидесяти строк, вкладка «Печать» без списка вовсе и вкладка «Очередь»
 * с чужими заказами дали бы три разных ответа на один вопрос.
 */
export async function countActiveAssignments(db: Database, userId: string): Promise<number> {
  return db.deliveryOrder.count({
    where: {
      ...buildScopeWhere({ date: null, assigneeId: userId, search: null }),
      fulfillmentProcessState: { in: [...MINE_WORK_STATES] },
    },
  });
}

export async function readQueue(
  db: Database,
  viewer: { userId: string },
  query: QueueQuery,
  now: Date = new Date(),
): Promise<QueueResult> {
  const date = resolveQueueDate(query.day, now);
  const todayMoscow = moscowToday(now);
  const page = normalizePageRequest(query);
  const search = normalizeSearch(query.search);
  const mine = query.scope === 'mine';
  // Область собранных существует только у «Моих заказов»: в общей очереди
  // собранного заказа нет ни при какой галочке.
  const group: QueueGroup = mine && query.group === 'assembled' ? 'assembled' : 'work';

  const context = {
    viewDate: date,
    todayMoscow,
    nowMinuteMoscow: moscowMinuteOfDay(now),
  };

  const scopeWhere = buildScopeWhere({
    date,
    assigneeId: mine ? viewer.userId : null,
    search,
  });

  /**
   * Точное число собранных считает БАЗА.
   *
   * Именно оно стоит в заголовке свёрнутой группы, поэтому считать его по
   * загруженной странице нельзя: у флориста с шестьюдесятью собранными
   * заголовок показал бы пятьдесят. Поиск входит в условие — во время поиска
   * счётчик обязан говорить о найденном, а не обо всём дне.
   */
  const assembledTotal = mine
    ? await db.deliveryOrder.count({
        where: { ...scopeWhere, fulfillmentProcessState: 'ASSEMBLED' },
      })
    : null;

  if (group === 'assembled') {
    return readAssembledPage(db, {
      day: query.day,
      date,
      scope: query.scope,
      includeAssigned: query.includeAssigned,
      search,
      page,
      context,
      scopeWhere,
      total: assembledTotal ?? 0,
    });
  }

  const states: OrderFulfillmentProcessState[] = mine
    ? [...MINE_WORK_STATES]
    : query.includeAssigned
      ? [...UNFINISHED_STATES]
      : ['NEW'];

  const rows = await db.deliveryOrder.findMany({
    where: { ...scopeWhere, fulfillmentProcessState: { in: states } },
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

  const byId = new Map(rows.map((row) => [row.id, row]));
  // Порядок считается по ПОЛНОЙ выборке, и только потом берётся страница:
  // групповой приоритет маршрутов существует лишь у целого списка.
  const sorted = sortQueue(queueOrders, context);
  const { items: pageItems, ...pageMeta } = takePage(sorted, page);

  return {
    day: query.day,
    deliveryDate: date,
    scope: query.scope,
    group,
    includeAssigned: query.includeAssigned,
    search,
    assembledTotal,
    ...pageMeta,
    items: pageItems.map((entry) => {
      const row = byId.get(entry.id);
      if (row === undefined) {
        throw new Error(`queue row disappeared between sort and page: ${entry.id}`);
      }
      return toQueueItem(
        row,
        { startMinute: entry.startMinute, endMinute: entry.endMinute },
        context,
      );
    }),
  };
}

/**
 * Страница собранных заказов дня.
 *
 * Здесь срез делает САМА БАЗА, и это не противоречие `paging.ts`: группового
 * правила у собранных нет вовсе. Порядок полный и выражается SQL — последний
 * собранный сверху, при равном времени устойчивый добор по номеру, — поэтому
 * `skip`/`take` над ним дают ровно ту же страницу, что и срез в памяти, и не
 * заставляют читать весь накопленный день ради пятидесяти строк.
 *
 * Смысл сортировки именно такой: флорист ищет среди собранных то, что собрал
 * только что, — чтобы перепечатать бланк или проверить состав.
 */
async function readAssembledPage(
  db: Database,
  input: {
    day: QueueDay;
    date: string;
    scope: QueueScope;
    includeAssigned: boolean;
    search: string | null;
    page: PageRequest;
    context: { viewDate: string; todayMoscow: string; nowMinuteMoscow: number };
    scopeWhere: ScopeWhere;
    total: number;
  },
): Promise<QueueResult> {
  const rows = await db.deliveryOrder.findMany({
    where: { ...input.scopeWhere, fulfillmentProcessState: 'ASSEMBLED' },
    select: orderSelect(input.date),
    orderBy: [{ fulfillmentAssembledAt: 'desc' }, { externalName: 'asc' }],
    skip: input.page.offset,
    take: input.page.limit,
  });

  return {
    day: input.day,
    deliveryDate: input.date,
    scope: input.scope,
    group: 'assembled',
    includeAssigned: input.includeAssigned,
    search: input.search,
    assembledTotal: input.total,
    ...pageInfo(input.page, input.total, rows.length),
    items: rows.map((row) => toQueueItem(row, effectiveMinutes(row), input.context)),
  };
}

/** Строка списка из прочитанной строки заказа. Общая для обеих областей. */
function toQueueItem(
  row: {
    id: string;
    externalName: string;
    deliveryDate: Date | null;
    fulfillmentProcessState: string;
    fulfillmentAssignedAt: Date | null;
    fulfillmentAssignee: { id: string; fullName: string } | null;
    printForms: { id: string }[];
    fulfillmentRevisions: { receivedAt: Date }[];
    routeOrders: { position: number | null; route: { id: string; number: string } }[];
  },
  minutes: { startMinute: number | null; endMinute: number | null },
  context: { viewDate: string; todayMoscow: string; nowMinuteMoscow: number },
): QueueItem {
  const participation = row.routeOrders[0];
  return {
    id: row.id,
    number: row.externalName,
    deliveryDate: row.deliveryDate === null ? null : fromDateColumn(row.deliveryDate),
    startMinute: minutes.startMinute,
    endMinute: minutes.endMinute,
    overdue: isOverdue(minutes, context),
    processState: row.fulfillmentProcessState,
    // Имя показывается только там, где оно нужно для решения: занятый заказ
    // должен объяснять, кем именно он занят.
    assignee:
      row.fulfillmentAssignee === null
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
    hasPrintForm: row.printForms.length > 0,
    changedSinceClaim: hasChangedSinceClaim(row),
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
