/**
 * Канонический отбор «Сделок».
 *
 * Список, карта и «выбрать все» обязаны видеть ОДНО множество. Поэтому условие
 * живёт здесь единственным SQL-выражением, а три эндпоинта отличаются только
 * тем, что делают с уже отобранными идентификаторами: страница, точки или
 * полный набор для выбора. Три независимых `where` разошлись бы в первый же
 * день — и логист отправил бы в расчёт не то, что видел на экране.
 *
 * Почему сырой SQL, а не Prisma `where`: отбор идёт по ЭФФЕКТИВНОМУ интервалу
 * (`COALESCE(ручной, исходный)`) и по эффективному адресу, а выразить
 * `COALESCE` в `where` нельзя. Дублировать же правило на клиенте нельзя тем
 * более.
 */

import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { OPERATIONS_START_DATE } from './operations-window.js';

/** Что показывать: рабочие сделки, требующие внимания либо всё сразу. */
export type DealsGroup = 'ROUTABLE' | 'ATTENTION' | 'ALL';

export interface DealsScope {
  /** Московская календарная дата `YYYY-MM-DD`. Обязательна: день выбирает человек. */
  deliveryDate: string;
  /** Поиск внутри выбранного дня. Пустая строка ищет всё. */
  search?: string | null;
  /** Границы эффективного интервала в минутах от полуночи Москвы. */
  fromMinute?: number | null;
  toMinute?: number | null;
  /** Показывать ли заказы, уже включённые в черновики. Они только для чтения. */
  includeDrafts?: boolean;
  group?: DealsGroup;
  /**
   * Эффективная граница начала операционной работы. Маршрут передаёт значение
   * из конфигурации; без него берётся продакшн-день {@link OPERATIONS_START_DATE}.
   */
  operationsStartDate?: string;
  /**
   * UUID канала продаж, заказы которого исключаются из «Сделок» (например,
   * Flowwow). Значение приходит из конфигурации. Не задано — исключения нет.
   */
  excludedSalesChannelId?: string | null;
}

/**
 * Состояния маршрутов, участие в которых выводит заказ из рабочих сделок.
 *
 * Черновик сюда не входит намеренно: заказ черновика логист может увидеть
 * отдельным переключателем, но выбрать во второй маршрут — нет.
 */
const CLOSED_ROUTE_STATES = ['CONFIRMED', 'ACTIVE', 'COMPLETED'] as const;

function searchCondition(search: string | null | undefined): Prisma.Sql {
  const value = (search ?? '').trim();
  if (value === '') {
    return Prisma.sql`TRUE`;
  }
  const pattern = `%${value}%`;
  // Ищем по номеру, обоим адресам, получателю и комментарию доставки.
  // Эффективный адрес — это локальный либо исходный, поэтому проверяются оба:
  // иначе заказ, найденный глазами в карточке, не находился бы поиском.
  return Prisma.sql`(
    "externalName" ILIKE ${pattern}
    OR "address" ILIKE ${pattern}
    OR "localAddress" ILIKE ${pattern}
    OR "recipient" ILIKE ${pattern}
    OR ("comment" IS NOT NULL AND "comment" <> '' AND "comment" ILIKE ${pattern})
  )`;
}

function intervalCondition(
  from: number | null | undefined,
  to: number | null | undefined,
): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  // Фильтр действует по ЭФФЕКТИВНОМУ интервалу: ручной сильнее исходного.
  // Заказ без интервала фильтр времени не отбрасывает — он и так требует
  // внимания, и прятать его от логиста нельзя.
  if (from !== null && from !== undefined) {
    conditions.push(
      Prisma.sql`COALESCE("manualIntervalEndMinute", "intervalEndMinute") IS NULL
        OR COALESCE("manualIntervalEndMinute", "intervalEndMinute") >= ${from}`,
    );
  }
  if (to !== null && to !== undefined) {
    conditions.push(
      Prisma.sql`COALESCE("manualIntervalStartMinute", "intervalStartMinute") IS NULL
        OR COALESCE("manualIntervalStartMinute", "intervalStartMinute") <= ${to}`,
    );
  }
  if (conditions.length === 0) {
    return Prisma.sql`TRUE`;
  }
  return Prisma.sql`(${Prisma.join(
    conditions.map((condition) => Prisma.sql`(${condition})`),
    ' AND ',
  )})`;
}

function groupCondition(group: DealsGroup): Prisma.Sql {
  if (group === 'ATTENTION') {
    return Prisma.sql`"needsAttention" = true`;
  }
  if (group === 'ROUTABLE') {
    /*
     * Пригодным считается заказ без блокирующего внимания, с подтверждённой
     * точкой и с датой доставки.
     *
     * Дата проверяется отдельно, потому что «Требует внимания» её больше
     * не включает: заказ без даты не блокирует логиста как задача, но и
     * положить его в маршрут конкретного дня нельзя — сервер откажет
     * проверкой пригодности, и предлагать его к выбору было бы обманом.
     */
    return Prisma.sql`"needsAttention" = false AND "geoState" = 'RESOLVED' AND "deliveryDate" IS NOT NULL`;
  }
  return Prisma.sql`TRUE`;
}

/**
 * Условие отбора целиком.
 *
 * Подтверждённые, активные и завершённые маршруты, архивные и пропавшие заказы
 * в рабочую область не входят: их состав уже решён, и показывать их рядом
 * с нераспределёнными значит приглашать к ошибке.
 */
export function dealsWhere(scope: DealsScope): Prisma.Sql {
  const group = scope.group ?? 'ALL';
  const draftsClause =
    (scope.includeDrafts ?? false)
      ? Prisma.sql`TRUE`
      : Prisma.sql`NOT EXISTS (
        SELECT 1 FROM "RouteOrder" ro
        WHERE ro."orderId" = o."id" AND ro."removedAt" IS NULL
      )`;

  // Исключение канала продаж (например, Flowwow). Гейт по наличию настройки:
  // без неё условие пустое и поведение прежнее. IS DISTINCT FROM оставляет
  // заказы с неизвестным (NULL) каналом — исключается ровно заданный канал.
  const channel = scope.excludedSalesChannelId;
  const channelClause =
    channel === undefined || channel === null || channel === ''
      ? Prisma.sql`TRUE`
      : Prisma.sql`o."salesChannelId" IS DISTINCT FROM ${channel}::uuid`;

  return Prisma.sql`
    o."inScope" = true
    AND o."sourceArchived" = false
    AND o."sourceMissing" = false
    -- «Принят, Не оплачен» хранится и обновляется, но в «Сделках» не показывается,
    -- пока статус в источнике не станет допустимым. Сравнение по UUID состояния,
    -- не по строке. IS DISTINCT FROM оставляет заказы с неизвестным состоянием.
    AND o."externalStateId" IS DISTINCT FROM ${MOYSKLAD_IDS.states.acceptedUnpaid}
    -- Начало операционной работы: заказы более ранних дней в «Сделки» не идут,
    -- даже если выбрать такой день. Дата определяется по Москве.
    AND o."deliveryDate" >= ${scope.operationsStartDate ?? OPERATIONS_START_DATE}::date
    AND o."deliveryDate" = ${scope.deliveryDate}::date
    AND NOT EXISTS (
      SELECT 1 FROM "RouteOrder" ro
      JOIN "DeliveryRoute" r ON r."id" = ro."routeId"
      WHERE ro."orderId" = o."id"
        AND ro."removedAt" IS NULL
        AND r."state"::text IN (${Prisma.join(
          CLOSED_ROUTE_STATES.map((state) => Prisma.sql`${state}`),
          ', ',
        )})
    )
    AND ${draftsClause}
    AND ${channelClause}
    AND ${searchCondition(scope.search)}
    AND ${intervalCondition(scope.fromMinute, scope.toMinute)}
    AND ${groupCondition(group)}
  `;
}

/**
 * Идентификаторы отобранных заказов в устойчивом порядке.
 *
 * Порядок один для всех потребителей: по эффективному началу интервала, затем
 * по номеру. Без второго ключа страницы «плавали» бы между запросами, и заказ
 * мог бы не попасть ни на одну страницу.
 */
/**
 * Три группы дня: разобрать, везти, не везти.
 *
 * Сверху заказы, требующие внимания: логист начинает день с их разбора.
 * Снизу отменённые: они уже никуда не поедут, и место наверху занимали бы
 * зря — но и убирать их нельзя, иначе пропал бы след букета, который,
 * возможно, уже собран и лежит в ячейке.
 *
 * Сортировка живёт в запросе, а не в браузере: иначе «сверху» оказывались бы
 * только те проблемные заказы, что попали на уже загруженную страницу, а
 * остальные ждали бы своей очереди где-то на пятой — и точно так же вниз
 * уезжали бы не все отменённые, а только загруженные.
 *
 * Условия совпадают с тем, что показывает карточка: для внимания — серверный
 * признак плюс отсутствие подтверждённой точки, для отмены — отмена
 * в источнике либо отмена логистом. Отменённый заказ уходит вниз, даже если
 * он же требует внимания: разбирать нечего, везти его всё равно не будут.
 *
 * Внутри каждой группы порядок дня не меняется: время, затем номер.
 */
const GROUP_ORDER = Prisma.sql`
  CASE
    WHEN o."cancelledInSource" OR o."cancelledByLogistAt" IS NOT NULL THEN 2
    WHEN o."needsAttention" OR o."geoState" <> 'RESOLVED' THEN 0
    ELSE 1
  END
`;

export async function dealsIds(
  db: Database,
  scope: DealsScope,
  page?: { limit: number; offset: number },
): Promise<string[]> {
  const limitClause =
    page === undefined ? Prisma.sql`` : Prisma.sql`LIMIT ${page.limit} OFFSET ${page.offset}`;

  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT o."id"
    FROM "DeliveryOrder" o
    WHERE ${dealsWhere(scope)}
    ORDER BY ${GROUP_ORDER},
             COALESCE(o."manualIntervalStartMinute", o."intervalStartMinute") NULLS FIRST,
             o."externalName" ASC
    ${limitClause}
  `;
  return rows.map((row) => row.id);
}

/** Сколько заказов в отборе. Считается тем же условием, что и список. */
export async function dealsCount(db: Database, scope: DealsScope): Promise<number> {
  const rows = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM "DeliveryOrder" o
    WHERE ${dealsWhere(scope)}
  `;
  return Number(rows[0]?.count ?? 0n);
}

/**
 * Сколько заказов отбора не имеют пригодной точки.
 *
 * Считается по всему дню, а не по загруженной странице: счётчик над списком
 * обязан называть настоящее число, иначе он объяснял бы разрыв между списком
 * и картой неверно. Условие то же, что и у списка, плюс отсутствие
 * подтверждённых координат.
 */
export async function dealsWithoutPointCount(db: Database, scope: DealsScope): Promise<number> {
  const rows = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM "DeliveryOrder" o
    WHERE ${dealsWhere(scope)}
      AND (o."geoState" <> 'RESOLVED' OR o."geoLatMicro" IS NULL OR o."geoLonMicro" IS NULL)
  `;
  return Number(rows[0]?.count ?? 0n);
}
