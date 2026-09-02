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
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import type { Database } from '../../platform/db.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { OrderFulfillmentProcessState } from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { fromDateColumn, toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { OPERATIONS_START_DATE } from '../orders/operations-window.js';
import {
  normalizePageRequest,
  pageInfo,
  takePage,
  type PageInfo,
  type PageRequest,
} from './paging.js';
import { isPickupMethod } from '../pickup/views.js';
import { readFloristDispatchMode } from '../settings/service.js';
import {
  effectiveMinutes,
  isOverdue,
  isPickupSoon,
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
  /** Пересборка: новый круг сборки (assemblyRound > 1). Показывается «Пересборка». */
  reassembly: boolean;
  /** Заказ отменён: собирать его нельзя, и это видно прямо в очереди. */
  cancelled: boolean;
  /**
   * Ближайший самовывоз: до начала интервала меньше часа.
   *
   * Признак считает СЕРВЕР по полному набору очереди. Клиент им только
   * группирует строки и не выводит его заново из подписей: подпись — текст,
   * а принадлежность к приоритету — состояние.
   */
  pickupSoon: boolean;
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
  /**
   * Собранные заказы флориста, разложенные по ДАТЕ ДОСТАВКИ.
   *
   * Каждый счётчик считается базой по ПОЛНОМУ серверному набору (день, область
   * видимости и поиск учтены) — не по загруженной странице. Клиент рисует по
   * ним заголовки дневных групп «Сегодня/Завтра/ДД.ММ.ГГГГ», а бездатные ведёт
   * отдельной группой (`date === null`). Пустых записей здесь нет: группа без
   * заказов в набор не попадает. `null` — как и у `assembledTotal`, для общей
   * очереди.
   */
  assembledByDate: AssembledDateCount[] | null;
  items: QueueItem[];
}

/** Число собранных заказов флориста на одну дату доставки (`null` — без даты). */
export interface AssembledDateCount {
  date: string | null;
  count: number;
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
  /**
   * Эффективная граница начала операционной работы. Маршрут передаёт значение
   * из конфигурации; без него берётся продакшн-день {@link OPERATIONS_START_DATE}.
   */
  operationsStartDate?: string;
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

/**
 * Поля заказа для очереди.
 *
 * Участие в листе ищется без оглядки на день: очередь показывает вчерашние
 * невыполненные заказы, и лист под ними тоже вчерашний. Порядок между листами
 * разных дней задаёт сортировка, а не отбор.
 */
function orderSelect() {
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
    // Способ получения нужен приоритету самовывоза: он определяется точным
    // справочником МоегоСклада, а не текстом названия.
    deliveryMethodId: true,
    cancelledInSource: true,
    cancelledByLogistAt: true,
    fulfillmentAssignee: { select: { id: true, fullName: true } },
    assemblyRound: true,
    /*
     * Бланк ТЕКУЩЕГО круга сборки.
     *
     * После пересборки прежняя печать остаётся в истории, но закрытой новую
     * сборку не делает: флорист обязан напечатать бланк заново, иначе на
     * коробке окажется состав прошлого букета.
     */
    printForms: { select: { id: true, assemblyRound: true } },
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
     * Активное участие в ПОДТВЕРЖДЁННОМ маршруте.
     *
     * Черновик приоритета не даёт: он ещё меняется, и собирать под него нечего.
     * Отменённый — тем более.
     *
     * День маршрута не проверяется. Очередь и так показывает вчерашние
     * невыполненные заказы, а лист под ними тоже вчерашний: с проверкой дня
     * такой заказ терял пометку и уезжал в общую кучу — при том что машина
     * по нему ждёт со вчера.
     */
    routeOrders: {
      where: {
        removedAt: null,
        route: { state: 'CONFIRMED' as const },
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
/**
 * Состояния незакрытой работы прошлых дней.
 *
 * Собранный прошлый заказ в «Сегодня» не нужен: работа по нему закончена.
 * Незавершённый — нужен обязательно, иначе вчерашний недособранный букет
 * исчезает с экрана вместе с датой. `NEEDS_REVIEW` сюда не входит: заказ
 * СОБРАН, а изменившийся состав — отдельный разговор своей вкладки.
 */
const PAST_UNFINISHED_STATES = ['NEW', 'IN_ASSEMBLY'] as const;
/** Активная работа: заказ уже у исполнителя, а не в свободной очереди. */
const ACTIVE_WORK_STATES = ['IN_ASSEMBLY', 'NEEDS_REVIEW'] as const;

/**
 * Условия «пригодности к выдаче» свободного заказа.
 *
 * Отвечают на вопрос «можно ли ПРЕДЛОЖИТЬ этот заказ флористу как свободную
 * работу»: он в производственной области, не архивный, не исчез из источника,
 * состав подтверждён, статус источника допустим и он не раньше начала
 * операционной работы. К уже назначенной работе эти условия не применяются:
 * заказ, ушедший из источника ПОСЛЕ назначения, остаётся у исполнителя.
 */
export function offerableConstraints(
  operationsStartDate?: string | undefined,
): Prisma.DeliveryOrderWhereInput {
  return {
    fulfillmentInScope: true,
    sourceArchived: false,
    sourceMissing: false,
    fulfillmentCompositionState: 'READY' as const,
    AND: [
      {
        OR: [
          { externalStateId: null },
          { externalStateId: { not: MOYSKLAD_IDS.states.acceptedUnpaid } },
        ],
      },
      {
        OR: [
          { deliveryDate: null },
          { deliveryDate: { gte: toDateColumn(operationsStartDate ?? OPERATIONS_START_DATE) } },
        ],
      },
    ],
  };
}

function buildScopeWhere(input: {
  /** `null` — все дни сразу: так считается счётчик активных заказов. */
  date: string | null;
  /**
   * Тянуть ли в выборку прошлые несобранные заказы.
   *
   * Только для «Сегодня». Будущие заказы не добавляются никогда: они
   * относятся к другому дню и своей очереди дождутся сами.
   */
  includePast?: boolean;
  assigneeId: string | null;
  search: string | null;
  /**
   * Эффективная граница начала операционной работы. Маршрут передаёт значение
   * из конфигурации; без него берётся продакшн-день {@link OPERATIONS_START_DATE}.
   */
  operationsStartDate?: string | undefined;
}) {
  return {
    // Пригодность к выдаче («Принят, Не оплачен» не собирается; пустой состав
    // при PENDING в очередь не идёт; заказы раньше начала операций — тоже).
    ...offerableConstraints(input.operationsStartDate),
    ...dateCondition(input.date, input.includePast === true),
    ...(input.assigneeId === null ? {} : { fulfillmentAssigneeId: input.assigneeId }),
    // Поиск сужает уже ограниченную выборку и не заменяет ни одного её
    // условия: день, область видимости и состояния остаются в силе.
    // Регистр не учитывается — номер вводят как придётся.
    ...(input.search === null
      ? {}
      : { externalName: { contains: input.search, mode: 'insensitive' as const } }),
  };
}

/**
 * Условие «Моих заказов»: всё, что числится за исполнителем.
 *
 * Область/источник тут НЕ фильтруются намеренно. Заказ, который после
 * назначения исчез из МоегоСклада или вышел из области, физически остаётся у
 * флориста — и обязан быть виден ему в «Моей работе», иначе человек держит
 * заказ, которого «нет». Состояние сужается отдельно (`MINE_WORK_STATES`
 * или `ASSEMBLED`).
 */
function buildMineWhere(input: {
  userId: string;
  search: string | null;
}): Prisma.DeliveryOrderWhereInput {
  return {
    fulfillmentAssigneeId: input.userId,
    ...(input.search === null
      ? {}
      : { externalName: { contains: input.search, mode: 'insensitive' as const } }),
  };
}

/**
 * Условие поиска руководителя во вкладке флориста.
 *
 * По номеру ADMIN/SUPERVISOR обязан найти и свободные пригодные заказы, и уже
 * назначенные в активной работе — в том числе те, что вышли из области после
 * назначения (иначе застрявший заказ невозможно ни найти, ни разобрать). День
 * не ограничивается: ищут конкретный номер, а не сегодняшнюю очередь.
 */
function buildSupervisorSearchWhere(input: {
  search: string;
  operationsStartDate?: string | undefined;
}): Prisma.DeliveryOrderWhereInput {
  return {
    externalName: { contains: input.search, mode: 'insensitive' as const },
    OR: [
      {
        fulfillmentProcessState: 'NEW' as const,
        ...offerableConstraints(input.operationsStartDate),
      },
      { fulfillmentProcessState: { in: [...ACTIVE_WORK_STATES] } },
    ],
  };
}

/**
 * Условие дня.
 *
 * «Сегодня» — это сегодняшние заказы ПЛЮС всё несобранное из прошлого:
 * вчерашний букет, который никто не доделал, обязан остаться на глазах,
 * а не пропасть вместе с датой.
 */
function dateCondition(date: string | null, includePast: boolean) {
  if (date === null) {
    return {};
  }
  const column = toDateColumn(date);
  if (!includePast) {
    return { deliveryDate: column };
  }
  return {
    OR: [
      { deliveryDate: column },
      {
        deliveryDate: { lt: column },
        fulfillmentProcessState: { in: [...PAST_UNFINISHED_STATES] },
      },
      /*
       * Самовывозы следующего дня — только ради приоритета «меньше часа».
       *
       * Заказ на 00:30 наступает через двадцать девять минут после 23:31, но
       * лежит уже в завтрашнем дне: без этой ветки он появился бы на экране
       * только в полночь, когда собирать его поздно. Лишние строки отсекаются
       * в памяти сразу после расчёта признака — в списке остаются только те,
       * что действительно попали в ближайший час.
       */
      {
        deliveryDate: toDateColumn(shiftCalendarDate(date, 1)),
        deliveryMethodId: MOYSKLAD_IDS.deliveryMethodPickup,
      },
    ],
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
export async function countActiveAssignments(
  db: Database,
  userId: string,
  operationsStartDate: string = OPERATIONS_START_DATE,
): Promise<number> {
  return db.deliveryOrder.count({
    where: {
      ...buildScopeWhere({ date: null, assigneeId: userId, search: null, operationsStartDate }),
      fulfillmentProcessState: { in: [...MINE_WORK_STATES] },
    },
  });
}

/**
 * Заказы, доступные автоматическому распределению, в ТОМ ЖЕ порядке, что и
 * свободная очередь: сегодня и просроченные, свободные (`NEW`) и пригодные по
 * действующим правилам. Возвращает идентификаторы сверху вниз — верхний
 * назначается первым. Отдельной клиентской сортировки нет: используется
 * `sortQueue`, как и в очереди флориста.
 */
export async function listDispatchableOrderIds(
  db: Database | TransactionClient,
  now: Date = new Date(),
  operationsStartDate?: string | undefined,
): Promise<string[]> {
  const { sorted } = await orderedFreeQueue(db, { operationsStartDate }, now);
  return sorted.map((entry) => entry.id);
}

/**
 * ЕДИНЫЙ источник свободной очереди «на сегодня».
 *
 * И свободная очередь флориста/руководителя, и кандидаты автоматической
 * раздачи строятся ОДНОЙ этой функцией: один и тот же запрос (`buildScopeWhere`
 * с той же границей операций) и одна и та же сортировка (`sortQueue`). Иначе
 * флорист получал бы автоназначением заказ, которого руководитель не видит
 * первым в очереди, — ровно тот дефект, из-за которого списки расходились.
 *
 * `operationsStartDate` обязателен для совпадения: маршрут и воркер раздачи
 * передают одно значение `config.OPERATIONS_START_DATE`.
 */
async function orderedFreeQueue(
  db: Database | TransactionClient,
  input: { operationsStartDate?: string | undefined },
  now: Date = new Date(),
): Promise<{ sorted: ReturnType<typeof sortQueue>; byId: Map<string, QueueRow> }> {
  const date = resolveQueueDate('today', now);
  const context = {
    viewDate: date,
    todayMoscow: moscowToday(now),
    nowMinuteMoscow: moscowMinuteOfDay(now),
  };
  const scopeWhere = buildScopeWhere({
    date,
    includePast: true,
    assigneeId: null,
    search: null,
    operationsStartDate: input.operationsStartDate,
  });

  const rows = await fetchQueueRows(db, { ...scopeWhere, fulfillmentProcessState: 'NEW' });
  const routes = await readRoutes(db, rows);
  const queueOrders = buildQueueOrders(rows, routes, { date, trimFutureNonPickup: true }, now);
  return {
    sorted: sortQueue(queueOrders, context),
    byId: new Map(rows.map((row) => [row.id, row])),
  };
}

/** Заказы очереди с общим набором полей. Один select на все пути очереди. */
function fetchQueueRows(db: Database | TransactionClient, where: Prisma.DeliveryOrderWhereInput) {
  return db.deliveryOrder.findMany({ where, select: orderSelect() });
}
type QueueRow = Awaited<ReturnType<typeof fetchQueueRows>>[number];

/**
 * Строки заказов → элементы сортировки. Признак ближайшего самовывоза считается
 * здесь, по полному набору, до сортировки и до страницы. `trimFutureNonPickup`
 * убирает завтрашние заказы, попавшие в выборку только ради порога «меньше часа».
 */
function buildQueueOrders(
  rows: readonly QueueRow[],
  routes: Map<string, QueueRoute>,
  opts: { date: string; trimFutureNonPickup: boolean },
  now: Date,
): QueueOrder[] {
  const queueOrders: QueueOrder[] = [];
  for (const row of rows) {
    const minutes = effectiveMinutes(row);
    const deliveryDate = row.deliveryDate === null ? null : fromDateColumn(row.deliveryDate);
    const pickupSoon = isPickupSoon(
      {
        pickup: isPickupMethod(row),
        cancelled: row.cancelledInSource || row.cancelledByLogistAt !== null,
        deliveryDate,
        startMinute: minutes.startMinute,
      },
      now,
    );
    if (
      opts.trimFutureNonPickup &&
      !pickupSoon &&
      deliveryDate !== null &&
      deliveryDate > opts.date
    ) {
      continue;
    }
    const participation = row.routeOrders[0];
    queueOrders.push({
      id: row.id,
      externalName: row.externalName,
      deliveryDate,
      startMinute: minutes.startMinute,
      endMinute: minutes.endMinute,
      route: participation === undefined ? null : (routes.get(participation.route.id) ?? null),
      routePosition: participation?.position ?? null,
      pickupSoon,
    });
  }
  return queueOrders;
}

export async function readQueue(
  db: Database,
  viewer: { userId: string; roles?: readonly string[] },
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

  /*
   * «Мои заказы» не ограничены днём.
   *
   * За флористом числится работа, а не день: заказ, взятый вчера и не
   * собранный, обязан оставаться перед глазами, а взятый на завтра — не
   * прятаться до полуночи. Именно из-за границы дня счётчик вкладки расходился
   * со списком: считался он всегда по всем дням, а показывался один день.
   *
   * «Очередь» день сохраняет: там выбирают, что брать в работу сегодня.
   */
  const roles = viewer.roles ?? [];
  const supervises = roles.includes('ADMIN') || roles.includes('SUPERVISOR');
  /*
   * Поиск руководителя во вкладке флориста ищет по всему операционному контуру:
   * и свободные пригодные заказы, и уже назначенные в активной работе — включая
   * вышедшие из области ПОСЛЕ назначения. Без этого застрявший заказ невозможно
   * ни найти, ни увидеть его исполнителя. Обычный список (без поиска) остаётся
   * свободной очередью.
   */
  const supervisorSearch = !mine && supervises && search !== null;

  const scopeWhere = mine
    ? buildMineWhere({ userId: viewer.userId, search })
    : supervisorSearch
      ? buildSupervisorSearchWhere({
          search: search as string,
          operationsStartDate: query.operationsStartDate,
        })
      : buildScopeWhere({
          date,
          // Прошлое подтягивается только в «Сегодня»: «Завтра» — это ровно завтра.
          includePast: query.day === 'today',
          assigneeId: null,
          search,
          operationsStartDate: query.operationsStartDate,
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

  // Собранные по датам доставки одним агрегатом по ПОЛНОМУ набору (с учётом
  // поиска) — так дневные счётчики точны и не зависят от загруженной страницы.
  const assembledByDate = mine
    ? (
        await db.deliveryOrder.groupBy({
          by: ['deliveryDate'],
          where: { ...scopeWhere, fulfillmentProcessState: 'ASSEMBLED' },
          _count: { _all: true },
        })
      ).map((group_) => ({
        date: group_.deliveryDate === null ? null : fromDateColumn(group_.deliveryDate),
        count: group_._count._all,
      }))
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
      byDate: assembledByDate ?? [],
    });
  }

  /*
   * Автоматический режим прячет свободную очередь от флориста НА СЕРВЕРЕ.
   *
   * В AUTO система назначает заказы сама, поэтому флорист не должен получать
   * карточки свободной очереди даже запросом API — только своё назначение
   * («Мои заказы»). Руководители (ADMIN/SUPERVISOR) видят очередь всегда.
   * Скрытие вкладки на клиенте — лишь удобство, защита здесь.
   */
  if (!mine) {
    if (!supervises) {
      const mode = await readFloristDispatchMode(db);
      if (mode.value.auto) {
        return {
          day: query.day,
          deliveryDate: date,
          scope: query.scope,
          group,
          includeAssigned: query.includeAssigned,
          search,
          assembledTotal,
          assembledByDate,
          items: [],
          total: 0,
          limit: page.limit,
          offset: page.offset,
          hasMore: false,
        };
      }
    }
  }

  const states: OrderFulfillmentProcessState[] = mine
    ? [...MINE_WORK_STATES]
    : query.includeAssigned
      ? [...UNFINISHED_STATES]
      : ['NEW'];

  const rows = await fetchQueueRows(
    db,
    // Поиск руководителя уже несёт состояния в своём `OR`; остальным путям
    // состояние добавляется здесь. Без границы дня участие в листе ищется по
    // дню самого заказа — иначе вчерашний заказ терял бы маршрут.
    supervisorSearch ? scopeWhere : { ...scopeWhere, fulfillmentProcessState: { in: states } },
  );

  const routes = await readRoutes(db, rows);

  /*
   * Признак ближайшего самовывоза считается по ПОЛНОМУ набору очереди, до
   * сортировки и страницы. Завтрашние самовывозы подтягиваются только в
   * «Сегодня» свободной очереди; в «Моих» и в поиске руководителя дня нет,
   * и обрезать будущее там нельзя — иначе поиск не нашёл бы заказ другого дня.
   */
  const trimFutureNonPickup = !mine && !supervisorSearch && query.day === 'today';
  const queueOrders = buildQueueOrders(rows, routes, { date, trimFutureNonPickup }, now);

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
    assembledByDate,
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
        entry.pickupSoon,
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
    byDate: AssembledDateCount[];
  },
): Promise<QueueResult> {
  const rows = await db.deliveryOrder.findMany({
    where: { ...input.scopeWhere, fulfillmentProcessState: 'ASSEMBLED' },
    select: orderSelect(),
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
    assembledByDate: input.byDate,
    ...pageInfo(input.page, input.total, rows.length),
    // Собранный заказ в приоритетную группу не входит: работа по нему
    // закончена, и поднимать его наверх незачем.
    items: rows.map((row) => toQueueItem(row, effectiveMinutes(row), input.context, false)),
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
    assemblyRound: number;
    printForms: { id: string; assemblyRound: number }[];
    fulfillmentRevisions: { receivedAt: Date }[];
    routeOrders: { position: number | null; route: { id: string; number: string } }[];
    cancelledInSource: boolean;
    cancelledByLogistAt: Date | null;
  },
  minutes: { startMinute: number | null; endMinute: number | null },
  context: { viewDate: string; todayMoscow: string; nowMinuteMoscow: number },
  pickupSoon: boolean,
): QueueItem {
  const participation = row.routeOrders[0];
  return {
    id: row.id,
    number: row.externalName,
    deliveryDate: row.deliveryDate === null ? null : fromDateColumn(row.deliveryDate),
    startMinute: minutes.startMinute,
    endMinute: minutes.endMinute,
    overdue: isOverdue(
      {
        ...minutes,
        deliveryDate: row.deliveryDate === null ? null : fromDateColumn(row.deliveryDate),
      },
      context,
    ),
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
    hasPrintForm: row.printForms.some((form) => form.assemblyRound === row.assemblyRound),
    changedSinceClaim: hasChangedSinceClaim(row),
    // Пересборка — второй и последующие круги сборки того же заказа.
    reassembly: row.assemblyRound > 1,
    // Отменённый заказ остаётся в списке, но собирать его нельзя: исчезнувший
    // из очереди заказ выглядит как потерянный, а не как отменённый.
    cancelled: row.cancelledInSource || row.cancelledByLogistAt !== null,
    pickupSoon,
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
  db: Database | TransactionClient,
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
      route: { select: { number: true, deliveryDate: true } },
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

  const grouped = new Map<
    string,
    { number: string; deliveryDate: string; minutes: { startMinute: number | null }[] }
  >();
  for (const stop of stops) {
    const entry = grouped.get(stop.routeId) ?? {
      number: stop.route.number,
      deliveryDate: fromDateColumn(stop.route.deliveryDate),
      minutes: [],
    };
    entry.minutes.push({ startMinute: effectiveMinutes(stop.order).startMinute });
    grouped.set(stop.routeId, entry);
  }

  const result = new Map<string, QueueRoute>();
  for (const [id, entry] of grouped) {
    result.set(id, {
      id,
      number: entry.number,
      deliveryDate: entry.deliveryDate,
      firstStopMinute: routeFirstStopMinute(entry.minutes),
    });
  }
  return result;
}
