/**
 * «Ожидают приёмки»: собранные флористом заказы, ТЕКУЩИЙ круг сборки которых
 * склад ещё ни разу не принимал в ячейку.
 *
 * Это ЭКРАН склада, а не производственный статус. Он показывает, какие коробки
 * склад должен принять. Сама приёмка идёт прежним путём `receiveOrder` и нового
 * статуса не заводит.
 *
 * ПОЧЕМУ «ТЕКУЩИЙ КРУГ», А НЕ «НЕТ АКТИВНОГО РАЗМЕЩЕНИЯ».
 *
 * Прежнее условие проверяло лишь отсутствие ДЕЙСТВУЮЩЕГО размещения. Но после
 * выдачи курьеру (или любого освобождения) размещение освобождается, а заказ
 * остаётся `ASSEMBLED` — и уже принятый, уехавший заказ снова попадал в список.
 * Так набралось 612 строк вместо реальных ожидающих.
 *
 * Правильное условие: текущий КРУГ сборки ещё ни разу не был в ячейке. Круг
 * несут и заказ, и размещение (`assemblyRound` есть у обоих). Заказ показывается,
 * только если нет НИ ОДНОГО размещения его текущего круга — ни активного, ни
 * освобождённого. Историческое размещение прошлого круга приёмке новой
 * пересборки не мешает: у него другой круг. Backfill не нужен — колонка
 * `OrderPlacement.assemblyRound` уже существует и заполняется при размещении.
 */

import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { fromDateColumn } from '../integrations/moysklad/delivery-date.js';
import { normalizePageRequest, pageInfo, type PageInfo } from '../fulfillment/paging.js';
import { isOperationalPickup, operationalPickupSql } from '../orders/operational-pickup.js';

/** Роли, которым виден раздел и его API. Право проверяет сервер. */
export const AWAITING_INTAKE_ROLES = ['ADMIN', 'WAREHOUSE', 'SUPERVISOR', 'MANAGER'] as const;

/** Тип получения для фильтра-чипа. `undefined` — весь набор. */
export type AwaitingMethod = 'delivery' | 'pickup';

export interface AwaitingIntakeCard {
  orderId: string;
  orderNumber: string;
  /** Московская календарная дата `YYYY-MM-DD` или `null` — без даты. */
  deliveryDate: string | null;
  isPickup: boolean;
  /** Эффективный интервал: минуты от полуночи Москвы. `null` — не распознан. */
  startMinute: number | null;
  endMinute: number | null;
  intervalKind: string;
  /** Время сборки (ISO). Есть всегда: заказ уже собран. */
  assembledAt: string | null;
  /** Имя собравшего флориста; `null` — сборщик неизвестен. */
  floristName: string | null;
  /** Число позиций состава: подсказка «что в коробке». */
  positionCount: number;
}

/** Счётчики чипов «Все / Доставка / Самовывоз» — считает сервер по условию. */
export interface AwaitingTypeCounts {
  all: number;
  delivery: number;
  pickup: number;
}

export interface AwaitingIntakeResult {
  /**
   * Счётчики чипов: учитывают поиск, но НЕ тип. Считаются сервером по тому же
   * бизнес-условию, что и список, поэтому чипы, вкладка и список не расходятся
   * и не упираются в молчаливый предел.
   */
  counts: AwaitingTypeCounts;
  /** Полное число ожидающих БЕЗ поиска — счётчик вкладки. */
  fullTotal: number;
  /** Страница текущего отбора (поиск + тип): total/limit/offset/hasMore. */
  page: PageInfo;
  items: AwaitingIntakeCard[];
}

export interface ListAwaitingInput {
  search?: string | undefined;
  method?: AwaitingMethod | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  /** Только счётчики: список не грузится. Для бейджа вкладки и чипов. */
  countOnly?: boolean | undefined;
  /**
   * Узкая граница очереди (`PICKUP_WAREHOUSE_QUEUE_DATE_FROM`): заказы с датой
   * доставки строго раньше неё в «Ожидают приёмки» не показываются. Заказы без
   * даты этой границей НЕ скрываются. Без значения — прежнее поведение.
   */
  queueDateFrom?: string | undefined;
  /** UUID канала Flowwow: его заказы считаются операционным самовывозом. */
  flowwowChannelId?: string | undefined;
}

/**
 * Базовое условие отбора (без поиска и без типа).
 *
 * Собран; в производственной области; источник не архивирован и не пропал; не
 * отменён источником и логистом; не выдан на самовывозе; не отменён локально;
 * не списан; и ТЕКУЩИЙ круг сборки ещё не размещался (нет размещения этого
 * круга — ни активного, ни освобождённого).
 */
function baseFilter(queueDateFrom?: string | undefined): Prisma.Sql {
  // Узкая граница очереди: старые хвосты не показываем. Заказ без даты остаётся
  // видимым — его нужно разобрать вручную. Без переменной — Prisma.empty.
  const cutoffClause =
    queueDateFrom === undefined
      ? Prisma.empty
      : Prisma.sql`AND (o."deliveryDate" IS NULL OR o."deliveryDate" >= ${queueDateFrom}::date)`;
  return Prisma.sql`
    FROM "DeliveryOrder" AS o
    WHERE o."fulfillmentProcessState" = 'ASSEMBLED'
      AND o."fulfillmentInScope"
      AND NOT o."sourceArchived"
      AND NOT o."sourceMissing"
      AND NOT o."cancelledInSource"
      AND o."cancelledByLogistAt" IS NULL
      ${cutoffClause}
      AND NOT EXISTS (SELECT 1 FROM "OrderPickupIssue" i WHERE i."orderId" = o."id")
      AND NOT EXISTS (SELECT 1 FROM "OrderPickupCancellation" c WHERE c."orderId" = o."id")
      -- Текущий круг сборки УЖЕ был в ячейке: есть его размещение — активное
      -- (стоит на полке) или освобождённое (выдан курьеру, перенос, списание).
      -- Круг несёт и заказ, и размещение (assemblyRound), поэтому историческое
      -- размещение прошлого круга приёмке новой пересборки не мешает: у него
      -- другой круг. Списание тоже сюда попадает: у списанного круг размещался.
      AND NOT EXISTS (
        SELECT 1 FROM "OrderPlacement" p
        WHERE p."orderId" = o."id" AND p."assemblyRound" = o."assemblyRound"
      )
  `;
}

function searchClause(search: string): Prisma.Sql {
  if (search === '') {
    return Prisma.empty;
  }
  const escaped = search.replace(/[\\%_]/g, (m) => `\\${m}`);
  return Prisma.sql`AND o."externalName" ILIKE ${`%${escaped}%`}`;
}

function methodClause(
  method: AwaitingMethod | undefined,
  flowwowChannelId: string | undefined,
): Prisma.Sql {
  if (method === 'pickup') {
    return Prisma.sql`AND ${operationalPickupSql(flowwowChannelId)}`;
  }
  if (method === 'delivery') {
    return Prisma.sql`AND NOT ${operationalPickupSql(flowwowChannelId)}`;
  }
  return Prisma.empty;
}

export async function listAwaitingIntake(
  db: Database,
  input: ListAwaitingInput = {},
): Promise<AwaitingIntakeResult> {
  const search = (input.search ?? '').trim();
  const base = baseFilter(input.queueDateFrom);
  const sClause = searchClause(search);

  // Счётчики по типу, с учётом поиска: одним группированным запросом.
  //
  // `IS TRUE` схлопывает NULL к «не самовывоз»: заказ без способа получения —
  // доставка. Без этого NULL образовал бы ТРЕТЬЮ группу, и сумма самовывоза и
  // доставки не сошлась бы с полным числом. Тот же смысл, что у чипа «Доставка»
  // (`IS DISTINCT FROM pickup` тоже включает NULL) и у признака карточки.
  const grouped = await db.$queryRaw<{ is_pickup: boolean; n: bigint }[]>`
    SELECT ((${operationalPickupSql(input.flowwowChannelId)}) IS TRUE) AS is_pickup,
           count(*)::bigint AS n
    ${base} ${sClause}
    GROUP BY 1
  `;
  let pickup = 0;
  let delivery = 0;
  for (const row of grouped) {
    if (row.is_pickup) {
      pickup = Number(row.n);
    } else {
      delivery = Number(row.n);
    }
  }
  const counts: AwaitingTypeCounts = { all: pickup + delivery, delivery, pickup };

  // Бейдж вкладки — без поиска. При пустом поиске это уже посчитано.
  const fullTotal =
    search === ''
      ? counts.all
      : Number(
          (await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS "n" ${base}`)[0]?.n ?? 0n,
        );

  const request = normalizePageRequest({
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.offset === undefined ? {} : { offset: input.offset }),
  });

  if (input.countOnly === true) {
    return { counts, fullTotal, page: pageInfo(request, counts.all, 0), items: [] };
  }

  // Итог текущего отбора (поиск + тип) выводится из уже посчитанных счётчиков.
  const total =
    input.method === 'pickup'
      ? counts.pickup
      : input.method === 'delivery'
        ? counts.delivery
        : counts.all;

  const mClause = methodClause(input.method, input.flowwowChannelId);
  // Порядок целиком выражается SQL, поэтому LIMIT/OFFSET над ним даёт ту же
  // страницу, что и срез в памяти. Новые даты выше старых; без даты — в конец;
  // внутри даты позднее собранное выше; далее устойчиво по номеру и id.
  const ordered = await db.$queryRaw<{ id: string }[]>`
    SELECT o."id"
    ${base} ${sClause} ${mClause}
    ORDER BY (o."deliveryDate" IS NULL) ASC,
             o."deliveryDate" DESC,
             o."fulfillmentAssembledAt" DESC NULLS LAST,
             o."externalName" ASC,
             o."id" ASC
    LIMIT ${request.limit} OFFSET ${request.offset}
  `;

  const ids = ordered.map((row) => row.id);
  if (ids.length === 0) {
    return { counts, fullTotal, page: pageInfo(request, total, 0), items: [] };
  }

  const orders = await db.deliveryOrder.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      externalName: true,
      deliveryDate: true,
      deliveryMethodId: true,
      salesChannelId: true,
      intervalKind: true,
      intervalStartMinute: true,
      intervalEndMinute: true,
      manualIntervalStartMinute: true,
      manualIntervalEndMinute: true,
      fulfillmentAssembledAt: true,
      fulfillmentAssembledBy: { select: { fullName: true } },
      _count: { select: { fulfillmentPositions: true } },
    },
  });
  const byId = new Map(orders.map((order) => [order.id, order]));

  // Порядок задаёт SQL: повторная сортировка в памяти разошлась бы с ним.
  const items: AwaitingIntakeCard[] = ids
    .map((id) => byId.get(id))
    .filter((order): order is NonNullable<typeof order> => order !== undefined)
    .map((order) => ({
      orderId: order.id,
      orderNumber: order.externalName,
      deliveryDate: order.deliveryDate === null ? null : fromDateColumn(order.deliveryDate),
      isPickup: isOperationalPickup(order, input.flowwowChannelId),
      startMinute: order.manualIntervalStartMinute ?? order.intervalStartMinute,
      endMinute: order.manualIntervalEndMinute ?? order.intervalEndMinute,
      intervalKind: order.intervalKind,
      assembledAt: order.fulfillmentAssembledAt?.toISOString() ?? null,
      floristName: order.fulfillmentAssembledBy?.fullName ?? null,
      positionCount: order._count.fulfillmentPositions,
    }));

  return { counts, fullTotal, page: pageInfo(request, total, items.length), items };
}
