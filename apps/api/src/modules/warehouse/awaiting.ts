/**
 * «Ожидают приёмки»: собранные флористом заказы, которых ещё нет на полке.
 *
 * Это ЭКРАН склада, а не производственный статус. Он показывает, какие коробки
 * склад должен принять: заказ собран, но действующего размещения в ячейке у
 * него нет. Чтение состояния сборки здесь допустимо (как на доске сборки) —
 * это подсказка «что ждать», а не разрешение на операцию. Сама приёмка идёт
 * прежним физическим путём `receiveOrder` и никакого нового статуса не заводит.
 *
 * Порядок и полный счётчик считает сервер по всему отбору: сортировка на
 * клиенте упорядочила бы лишь загруженную страницу, а счётчик по странице
 * обманывал бы кладовщика.
 */

import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { fromDateColumn } from '../integrations/moysklad/delivery-date.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';

const PICKUP_METHOD_ID = MOYSKLAD_IDS.deliveryMethodPickup;

/** Роли, которым виден раздел и его API. Право проверяет сервер. */
export const AWAITING_INTAKE_ROLES = ['ADMIN', 'WAREHOUSE', 'SUPERVISOR', 'MANAGER'] as const;

/** Верхний предел выдачи: набор «ожидают приёмки» невелик по своей природе. */
const MAX_AWAITING = 500;

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

export interface AwaitingIntakePage {
  /** Число заказов текущего отбора: с учётом поиска, если он задан. */
  total: number;
  /**
   * Полное число ожидающих приёмки — БЕЗ поиска.
   *
   * Это счётчик вкладки: он отвечает на вопрос «сколько всего коробок ждёт
   * приёмки», а не «сколько нашлось по строке поиска». Считается тем же
   * бизнес-условием, что и список, поэтому со списком не расходится.
   */
  fullTotal: number;
  items: AwaitingIntakeCard[];
}

/**
 * Отбор целиком пишется SQL.
 *
 * Условия: заказ собран флористом (`ASSEMBLED`), нет действующего размещения
 * в ячейке, не отменён источником и логистом, не выдан, не отменён локально и
 * не списан. Возврат флористу отсюда уходит сам: у возвращённого состояние
 * сборки уже не `ASSEMBLED`. Повторно собранный (REASSEMBLY) снова становится
 * `ASSEMBLED` без действующего размещения — и снова появляется здесь.
 */
function filterSql(search: string | undefined): Prisma.Sql {
  const term = (search ?? '').trim();
  const searchClause =
    term === ''
      ? Prisma.empty
      : Prisma.sql`AND o."externalName" ILIKE ${`%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}`;

  return Prisma.sql`
    FROM "DeliveryOrder" AS o
    WHERE o."fulfillmentProcessState" = 'ASSEMBLED'
      AND NOT o."cancelledInSource"
      AND o."cancelledByLogistAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "OrderPlacement" p
        WHERE p."orderId" = o."id" AND p."releasedAt" IS NULL
      )
      AND NOT EXISTS (SELECT 1 FROM "OrderPickupIssue" i WHERE i."orderId" = o."id")
      AND NOT EXISTS (SELECT 1 FROM "OrderPickupCancellation" c WHERE c."orderId" = o."id")
      -- Списанные не показываем: у заказа есть изъятие «в списание» и нет
      -- действующего размещения — принимать нечего. Снова принятый на полку
      -- получит активное размещение и уйдёт отсюда как размещённый.
      AND NOT EXISTS (
        SELECT 1 FROM "OrderPlacement" p
        WHERE p."orderId" = o."id" AND p."withdrawReason" = 'WRITE_OFF'
      )
      ${searchClause}
  `;
}

export async function listAwaitingIntake(
  db: Database,
  input: { search?: string | undefined; countOnly?: boolean } = {},
): Promise<AwaitingIntakePage> {
  const term = (input.search ?? '').trim();
  const filter = filterSql(input.search);

  // Полный счётчик считается без поиска тем же условием, что и список: с пустым
  // поиском это тот же запрос, поэтому берём его один раз.
  const fullFilter = term === '' ? filter : filterSql(undefined);

  const counted = await db.$queryRaw<
    {
      total: bigint;
    }[]
  >`SELECT count(*)::bigint AS "total" ${filter}`;
  const total = Number(counted[0]?.total ?? 0n);
  const fullTotal =
    term === ''
      ? total
      : Number(
          (
            await db.$queryRaw<
              { total: bigint }[]
            >`SELECT count(*)::bigint AS "total" ${fullFilter}`
          )[0]?.total ?? 0n,
        );

  // Счётчик вкладки не грузит список: он обновляется на каждое складское
  // событие, и тащить ради числа до пятисот строк — впустую.
  if (input.countOnly === true) {
    return { total, fullTotal, items: [] };
  }

  // Порядок: по дате доставки (без даты — в конец), затем по номеру. Тем же
  // ключом группируется экран, поэтому сортировку держит запрос.
  const ordered = await db.$queryRaw<{ id: string }[]>`
      SELECT o."id"
      ${filter}
      ORDER BY COALESCE(o."deliveryDate", DATE '9999-12-31') ASC, o."externalName" ASC, o."id" ASC
      LIMIT ${MAX_AWAITING}
    `;

  const ids = ordered.map((row) => row.id);
  if (ids.length === 0) {
    return { total, fullTotal, items: [] };
  }

  const orders = await db.deliveryOrder.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      externalName: true,
      deliveryDate: true,
      deliveryMethodId: true,
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
      isPickup: order.deliveryMethodId === PICKUP_METHOD_ID,
      startMinute: order.manualIntervalStartMinute ?? order.intervalStartMinute,
      endMinute: order.manualIntervalEndMinute ?? order.intervalEndMinute,
      intervalKind: order.intervalKind,
      assembledAt: order.fulfillmentAssembledAt?.toISOString() ?? null,
      floristName: order.fulfillmentAssembledBy?.fullName ?? null,
      positionCount: order._count.fulfillmentPositions,
    }));

  return { total, fullTotal, items };
}
