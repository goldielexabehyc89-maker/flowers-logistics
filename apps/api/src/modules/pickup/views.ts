/**
 * Чтение раздела «Самовывоз».
 *
 * Менеджеру нужно ровно три вещи: видеть очередь ожидающих выдачи заказов,
 * найти нужный по номеру и отдать его. Поэтому карточка называет состояние
 * сборки и печати, но не показывает ни состава букета, ни адреса, ни телефона:
 * человек уже стоит перед менеджером, и его данные для выдачи не нужны.
 *
 * ОЧЕРЕДЬ НЕ ПРИВЯЗАНА К ДНЮ. Покупатель приходит когда придёт: вчерашний,
 * сегодняшний и завтрашний заказы стоят на одной полке и в одном списке.
 * День — справочная подпись и порядок, а не фильтр: заказ, потерявшийся
 * из-за смены календарной даты, означает букет, который никто не отдаст.
 *
 * Из очереди заказ уходит ровно двумя способами: его выдали покупателю или
 * его отменили. Всё остальное — архив источника, пропажа, снятая с полки
 * коробка — остаётся видимым и объясняет, почему выдавать нельзя.
 */

import { moscowDayRange } from '@fl/shared';

import type { Database } from '../../platform/db.js';
import { Prisma, type $Enums } from '../../generated/prisma/client.js';
import { AppError } from '../../platform/errors.js';
import { fromDateColumn } from '../integrations/moysklad/delivery-date.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { resolveOrderByNumber } from '../warehouse/order-lookup.js';
import { OPERATIONS_START_DATE } from '../orders/operations-window.js';

/** Точный UUID способа получения «Самовывоз»: название ключом не является. */
const PICKUP_METHOD_ID = MOYSKLAD_IDS.deliveryMethodPickup;

/**
 * Размер страницы очереди.
 *
 * Очередь листается продолжением, а не обрезается: прилавок обычно короткий,
 * но «первые двести и молча всё» однажды спрячет коробку, за которой пришли.
 */
export const QUEUE_PAGE_SIZE = 50;
export const MAX_QUEUE_PAGE_SIZE = 200;

/** Почему заказ нельзя выдать прямо сейчас. */
export type PickupBlocker =
  /** Способ получения — доставка либо иной: раздел не про него. */
  | 'NOT_PICKUP'
  /** Заказ отменён: выдавать нечего. */
  | 'ORDER_CANCELLED'
  /** Источник архивирован, пропал или вышел из производственной области. */
  | 'ORDER_BLOCKED'
  /** Коробки сейчас нет ни в одной ячейке. */
  | 'NOT_PLACED'
  /** Заказ уже выдан покупателю. */
  | 'ALREADY_ISSUED';

export interface PickupCard {
  orderId: string;
  orderNumber: string;
  deliveryDate: string | null;
  isPickup: boolean;
  /** Состояние сборки флориста. `null`, если заказ вне производственной области. */
  assemblyState: $Enums.OrderFulfillmentProcessState | null;
  assembledAt: string | null;
  /** Печать бланка: было ли задание и завершено ли последнее. */
  printJobs: number;
  printedJobs: number;
  cellId: string | null;
  cellCode: string | null;
  issuedAt: string | null;
  issuedById: string | null;
  /**
   * Время доставки: тип, минуты и исходная строка.
   *
   * Второго парсера времени здесь нет — значения разобраны единым импортом
   * и хранятся в заказе. Клиент показывает их общим форматтером.
   */
  deliveryInterval: {
    kind: $Enums.DeliveryIntervalKind;
    startMinute: number | null;
    endMinute: number | null;
    raw: string | null;
  };
  /** Пусто — заказ можно выдавать. */
  blockers: PickupBlocker[];
}

const ORDER_SELECT = {
  id: true,
  externalName: true,
  deliveryDate: true,
  deliveryMethodId: true,
  fulfillmentInScope: true,
  sourceArchived: true,
  sourceMissing: true,
  cancelledInSource: true,
  cancelledByLogistAt: true,
  fulfillmentProcessState: true,
  fulfillmentAssembledAt: true,
  intervalRaw: true,
  intervalKind: true,
  intervalStartMinute: true,
  intervalEndMinute: true,
  manualIntervalStartMinute: true,
  manualIntervalEndMinute: true,
  placements: {
    where: { releasedAt: null },
    select: { cell: { select: { id: true, code: true } } },
  },
  printJobs: { select: { state: true } },
  pickupIssue: {
    select: { issuedAt: true, issuedById: true, cell: { select: { id: true, code: true } } },
  },
} as const;

type OrderRow = {
  id: string;
  externalName: string;
  deliveryDate: Date | null;
  deliveryMethodId: string | null;
  fulfillmentInScope: boolean;
  sourceArchived: boolean;
  sourceMissing: boolean;
  cancelledInSource: boolean;
  cancelledByLogistAt: Date | null;
  fulfillmentProcessState: $Enums.OrderFulfillmentProcessState;
  fulfillmentAssembledAt: Date | null;
  intervalRaw: string | null;
  intervalKind: $Enums.DeliveryIntervalKind;
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
  manualIntervalStartMinute: number | null;
  manualIntervalEndMinute: number | null;
  placements: { cell: { id: string; code: string } }[];
  printJobs: { state: $Enums.PrintJobState }[];
  pickupIssue: {
    issuedAt: Date;
    issuedById: string;
    cell: { id: string; code: string } | null;
  } | null;
};

/**
 * Самовывоз ли это ПО СПОСОБУ ПОЛУЧЕНИЯ.
 *
 * Только точный UUID справочника. Производственная область сюда не входит
 * намеренно: архивный заказ перестаёт быть «в производстве», но самовывозом
 * быть не перестаёт — и обязан остаться на глазах у менеджера, а не исчезнуть
 * с полки вместе с коробкой.
 */
export function isPickupMethod(order: { deliveryMethodId: string | null }): boolean {
  return order.deliveryMethodId === PICKUP_METHOD_ID;
}

/** Отменён ли заказ. Признак нормализованный: импорт и логист пишут в него оба. */
export function isCancelled(order: {
  cancelledInSource: boolean;
  cancelledByLogistAt: Date | null;
}): boolean {
  return order.cancelledInSource || order.cancelledByLogistAt !== null;
}

function toCard(order: OrderRow): PickupCard {
  const placement = order.placements[0] ?? null;

  const blockers: PickupBlocker[] = [];
  if (!isPickupMethod(order)) {
    blockers.push('NOT_PICKUP');
  }
  if (isCancelled(order)) {
    blockers.push('ORDER_CANCELLED');
  }
  if (order.sourceArchived || order.sourceMissing || !order.fulfillmentInScope) {
    blockers.push('ORDER_BLOCKED');
  }
  if (order.pickupIssue !== null) {
    blockers.push('ALREADY_ISSUED');
  } else if (placement === null) {
    blockers.push('NOT_PLACED');
  }

  return {
    orderId: order.id,
    orderNumber: order.externalName,
    deliveryDate: order.deliveryDate === null ? null : fromDateColumn(order.deliveryDate),
    isPickup: isPickupMethod(order),
    // Состояние сборки показывается как контекст: склад и выдача от него
    // не зависят (`FUL-001`), но менеджеру полезно видеть, собран ли букет.
    assemblyState: order.fulfillmentInScope ? order.fulfillmentProcessState : null,
    assembledAt: order.fulfillmentAssembledAt?.toISOString() ?? null,
    printJobs: order.printJobs.length,
    printedJobs: order.printJobs.filter((job) => job.state === 'PRINTED').length,
    /*
     * Выданный заказ показывает ячейку, ИЗ КОТОРОЙ его забрали.
     *
     * Действующего размещения у него уже нет, и «нет ячейки» в справке
     * о выдаче отвечало бы не на тот вопрос: спрашивают «откуда отдали».
     */
    cellId: placement?.cell.id ?? order.pickupIssue?.cell?.id ?? null,
    cellCode: placement?.cell.code ?? order.pickupIssue?.cell?.code ?? null,
    issuedAt: order.pickupIssue?.issuedAt.toISOString() ?? null,
    issuedById: order.pickupIssue?.issuedById ?? null,
    deliveryInterval: effectivePickupInterval(order),
    blockers,
  };
}

/**
 * Фактический интервал доставки заказа.
 *
 * Ручное исправление логиста сильнее текста источника — то же правило, что
 * в «Сделках». Второго парсера здесь нет: тип, минуты и исходная строка уже
 * разобраны единым импортом и просто читаются из заказа.
 */
function effectivePickupInterval(order: OrderRow): PickupCard['deliveryInterval'] {
  if (order.manualIntervalStartMinute !== null && order.manualIntervalEndMinute !== null) {
    const exact = order.manualIntervalStartMinute === order.manualIntervalEndMinute;
    return {
      kind: exact ? 'EXACT' : 'RANGE',
      startMinute: order.manualIntervalStartMinute,
      endMinute: exact ? null : order.manualIntervalEndMinute,
      raw: order.intervalRaw,
    };
  }
  return {
    kind: order.intervalKind,
    startMinute: order.intervalStartMinute,
    endMinute: order.intervalEndMinute,
    raw: order.intervalRaw,
  };
}

/** Карточка по отсканированному или введённому номеру. */
export async function findPickupByNumber(db: Database, scanned: string): Promise<PickupCard> {
  const resolved = await resolveOrderByNumber(db, scanned);

  const order = await db.deliveryOrder.findUnique({
    where: { id: resolved.id },
    select: ORDER_SELECT,
  });
  if (order === null) {
    throw new AppError('NOT_FOUND', { message: 'order not found' });
  }

  return toCard(order);
}

export interface PickupQueuePage {
  total: number;
  items: PickupCard[];
  /** Продолжение списка. `null` — страница последняя. */
  nextCursor: string | null;
}

/**
 * Ключ продолжения.
 *
 * Смещением листать нельзя: между страницами заказ выдают, отменяют и
 * принимают на склад, и «следующие пятьдесят» показали бы одни строки дважды,
 * а другие не показали бы вовсе. Ключ повторяет порядок сортировки целиком.
 */
interface QueueCursor {
  day: string;
  number: string;
  id: string;
}

function encodeCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): QueueCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as QueueCursor;
    if (
      typeof parsed.day !== 'string' ||
      typeof parsed.number !== 'string' ||
      typeof parsed.id !== 'string'
    ) {
      throw new Error('bad shape');
    }
    return parsed;
  } catch {
    throw new AppError('VALIDATION_FAILED', {
      message: 'bad pickup cursor',
      publicMessage: 'Продолжение списка устарело. Обновите страницу.',
    });
  }
}

/**
 * Очередь ожидающих выдачи.
 *
 * Состав: самовывоз по точному UUID, который УЖЕ побывал на складе (есть хоть
 * одно размещение), ещё не выдан и не отменён. Отсутствие коробки в ячейке
 * прямо сейчас из очереди не убирает — оно называется отдельной причиной.
 *
 * Порядок: сначала самая ранняя дата, потом номер. Заказы без даты идут
 * последними: у них не «сегодня», у них ничего, и ставить их вперёд датированных
 * значило бы обещать срочность, которой никто не объявлял.
 */
export async function listPickupQueue(
  db: Database,
  input: {
    limit?: number | undefined;
    cursor?: string | undefined;
    search?: string | undefined;
    /**
     * Эффективная граница начала операционной работы. Маршрут передаёт значение
     * из конфигурации; без него берётся продакшн-день {@link OPERATIONS_START_DATE}.
     */
    operationsStartDate?: string | undefined;
    /**
     * Узкая граница ДВУХ очередей (`PICKUP_WAREHOUSE_QUEUE_DATE_FROM`): заказы с
     * датой доставки строго раньше неё в «Ожидают выдачи» не показываются.
     * Отдельная от {@link operationsStartDate} и её не заменяет; без значения —
     * прежнее поведение. Заказы без даты этой границей НЕ скрываются.
     */
    queueDateFrom?: string | undefined;
  } = {},
): Promise<PickupQueuePage> {
  const limit = Math.min(Math.max(input.limit ?? QUEUE_PAGE_SIZE, 1), MAX_QUEUE_PAGE_SIZE);
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);

  // Поиск по номеру: полное и частичное совпадение, без учёта регистра, пробелы
  // по краям игнорируются. Ищем по ВСЕЙ очереди (условием SQL), а не по
  // показанному фрагменту; пустой поиск возвращает полный список. Спецсимволы
  // ILIKE экранируются, чтобы «%» в номере искался буквально.
  const term = (input.search ?? '').trim();
  const searchClause =
    term === ''
      ? Prisma.empty
      : Prisma.sql`AND o."externalName" ILIKE ${`%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}`;

  // Начало операционной работы: заказы более ранних дней в очередь не попадают.
  const windowClause = Prisma.sql`AND (o."deliveryDate" IS NULL OR o."deliveryDate" >= ${input.operationsStartDate ?? OPERATIONS_START_DATE}::date)`;

  // Узкая граница очереди: старые хвосты не показываем. Заказ без даты
  // остаётся видимым — его нужно разобрать вручную. Без переменной — Prisma.empty.
  const cutoffClause =
    input.queueDateFrom === undefined
      ? Prisma.empty
      : Prisma.sql`AND (o."deliveryDate" IS NULL OR o."deliveryDate" >= ${input.queueDateFrom}::date)`;

  /*
   * Отбор и порядок пишутся SQL целиком.
   *
   * Сравнение тройкой «(день, номер, id) больше ключа» — единственный способ
   * пролистать без пропусков и повторов; условиями Prisma это не выражается,
   * а собирать страницу в памяти означало бы выгружать весь склад.
   *
   * Заказ без даты получает служебное «9999-12-31»: он обязан оказаться
   * после датированных и в порядке, и в ключе продолжения.
   */
  const waiting = Prisma.sql`
    FROM "DeliveryOrder" AS o
    WHERE o."deliveryMethodId" = ${PICKUP_METHOD_ID}
      AND NOT o."cancelledInSource"
      AND o."cancelledByLogistAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "OrderPickupIssue" i WHERE i."orderId" = o."id")
      -- Локально отменённый самовывоз убран из очереди навсегда: строка живёт
      -- в базе и переживает перезапуск и повторные синхронизации.
      AND NOT EXISTS (SELECT 1 FROM "OrderPickupCancellation" c WHERE c."orderId" = o."id")
      -- Наличие ячейки больше НЕ условие показа: самовывоз виден сразу после
      -- импорта. До приёмки складом у него не будет активного размещения —
      -- карточка назовёт это причиной «нет ячейки», но заказ не спрячется.
      --
      -- Списанные из очереди убираются: у заказа есть изъятие «в списание»
      -- и нет действующего размещения — отдавать нечего. Если его после
      -- списания снова приняли на полку (появилось активное размещение),
      -- он возвращается в очередь.
      AND NOT (
        NOT EXISTS (
          SELECT 1 FROM "OrderPlacement" p
          WHERE p."orderId" = o."id" AND p."releasedAt" IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM "OrderPlacement" p
          WHERE p."orderId" = o."id" AND p."withdrawReason" = 'WRITE_OFF'
        )
      )
      ${windowClause}
      ${cutoffClause}
      ${searchClause}
  `;

  const keyset =
    cursor === null
      ? Prisma.empty
      : Prisma.sql`
          AND (
            COALESCE(o."deliveryDate", DATE '9999-12-31'),
            o."externalName",
            o."id"
          ) > (${cursor.day}::date, ${cursor.number}, ${cursor.id}::uuid)
        `;

  const [counted, page] = await Promise.all([
    db.$queryRaw<{ total: bigint }[]>`SELECT count(*)::bigint AS "total" ${waiting}`,
    db.$queryRaw<{ id: string; day: Date; number: string }[]>`
      SELECT o."id",
             COALESCE(o."deliveryDate", DATE '9999-12-31') AS "day",
             o."externalName" AS "number"
      ${waiting}
      ${keyset}
      ORDER BY COALESCE(o."deliveryDate", DATE '9999-12-31') ASC, o."externalName" ASC, o."id" ASC
      LIMIT ${limit + 1}
    `,
  ]);

  // Счётчик считается по ВСЕМУ отбору, а не по странице: «ожидают выдачи 3»
  // при пятидесяти коробках на полке — это неверная работа, а не мелочь.
  const total = Number(counted[0]?.total ?? 0n);

  const hasMore = page.length > limit;
  const visible = hasMore ? page.slice(0, limit) : page;
  const last = visible.at(-1) ?? null;

  const orders = await db.deliveryOrder.findMany({
    where: { id: { in: visible.map((row) => row.id) } },
    select: ORDER_SELECT,
  });
  const byId = new Map(orders.map((order) => [order.id, order]));

  return {
    total,
    // Порядок задаёт SQL: повторная сортировка в памяти разошлась бы с ключом
    // продолжения на первом же заказе без даты.
    items: visible
      .map((row) => byId.get(row.id))
      .filter((order): order is OrderRow => order !== undefined)
      .map(toCard),
    nextCursor:
      hasMore && last !== null
        ? encodeCursor({
            day: fromDateColumn(last.day),
            number: last.number,
            id: last.id,
          })
        : null,
  };
}

/**
 * Выданные за московский день: справочный список, а не рабочая очередь.
 *
 * Живёт отдельным запросом намеренно: состав активной очереди он не меняет
 * и меняться от него не должен.
 *
 * День считается по ФАКТУ выдачи (`OrderPickupIssue.issuedAt`), а не по
 * плановой дате доставки. Разница видна каждый день: заказ вчерашнего дня,
 * за которым пришли сегодня, выдан сегодня — и в сегодняшнем списке он обязан
 * быть; заказ, оформленный на послезавтра и отданный сегодня из рук в руки,
 * тоже. Плановая дата на попадание в список не влияет вовсе.
 *
 * Границы — полуинтервал московского дня: от полуночи включительно до полуночи
 * следующего дня исключительно, поэтому выдача в 00:00:00 попадает в новый
 * день, а в 23:59:59.999 — ещё в прежний. Часовой пояс браузера и сервера
 * в расчёте не участвует.
 */
export async function listIssuedOfDay(
  db: Database,
  day: string,
): Promise<{ deliveryDate: string; issued: PickupCard[] }> {
  const { from, to } = moscowDayRange(day);
  const orders = await db.deliveryOrder.findMany({
    where: {
      deliveryMethodId: PICKUP_METHOD_ID,
      pickupIssue: { is: { issuedAt: { gte: from, lt: to } } },
    },
    orderBy: [{ externalName: 'asc' }],
    select: ORDER_SELECT,
    take: MAX_QUEUE_PAGE_SIZE,
  });

  return { deliveryDate: day, issued: orders.map(toCard) };
}
