/**
 * Чтение раздела «Самовывоз».
 *
 * Менеджеру нужно ровно три вещи: найти заказ по номеру, увидеть, готов ли он
 * и где лежит, и подтвердить выдачу. Поэтому карточка называет состояние
 * сборки и печати, но не показывает ни состава букета, ни адреса, ни телефона:
 * человек уже стоит перед менеджером, и его данные для выдачи не нужны.
 *
 * Московский день считает сервер: браузер кассы стоит в произвольном поясе,
 * и «сегодня» по его часам однажды разошлось бы с рабочим днём склада.
 */

import type { Database } from '../../platform/db.js';
import type { $Enums } from '../../generated/prisma/client.js';
import { AppError } from '../../platform/errors.js';
import { fromDateColumn, toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { resolveOrderByNumber } from '../warehouse/order-lookup.js';
import { isPickupOrder } from './service.js';

/** Точный UUID способа получения «Самовывоз»: название ключом не является. */
const PICKUP_METHOD_ID = MOYSKLAD_IDS.deliveryMethodPickup;

/**
 * Предел списка дня.
 *
 * Прилавок самовывоза — это десятки заказов, а не тысячи. Ограничение стоит
 * не ради красоты: без него один испорченный день выгрузил бы весь склад
 * в браузер кассы.
 */
const LIST_LIMIT = 200;

/** Почему заказ нельзя выдать прямо сейчас. */
export type PickupBlocker =
  /** Способ получения — доставка либо иной: раздел не про него. */
  | 'NOT_PICKUP'
  /** Источник архивирован или пропал из МоегоСклада. */
  | 'ORDER_BLOCKED'
  /** Заказ ещё не принят на склад: фактической ячейки нет. */
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
  fulfillmentProcessState: true,
  fulfillmentAssembledAt: true,
  placements: {
    where: { releasedAt: null },
    select: { cell: { select: { id: true, code: true } } },
  },
  printJobs: { select: { state: true } },
  pickupIssue: { select: { issuedAt: true, issuedById: true } },
} as const;

type OrderRow = {
  id: string;
  externalName: string;
  deliveryDate: Date | null;
  deliveryMethodId: string | null;
  fulfillmentInScope: boolean;
  sourceArchived: boolean;
  sourceMissing: boolean;
  fulfillmentProcessState: $Enums.OrderFulfillmentProcessState;
  fulfillmentAssembledAt: Date | null;
  placements: { cell: { id: string; code: string } }[];
  printJobs: { state: $Enums.PrintJobState }[];
  pickupIssue: { issuedAt: Date; issuedById: string } | null;
};

function toCard(order: OrderRow): PickupCard {
  const pickup = isPickupOrder(order);
  const placement = order.placements[0] ?? null;

  const blockers: PickupBlocker[] = [];
  if (!pickup) {
    blockers.push('NOT_PICKUP');
  }
  if (order.sourceArchived || order.sourceMissing) {
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
    isPickup: pickup,
    // Состояние сборки показывается как контекст: склад и выдача от него
    // не зависят (`FUL-001`), но менеджеру полезно видеть, собран ли букет.
    assemblyState: order.fulfillmentInScope ? order.fulfillmentProcessState : null,
    assembledAt: order.fulfillmentAssembledAt?.toISOString() ?? null,
    printJobs: order.printJobs.length,
    printedJobs: order.printJobs.filter((job) => job.state === 'PRINTED').length,
    cellId: placement?.cell.id ?? null,
    cellCode: placement?.cell.code ?? null,
    issuedAt: order.pickupIssue?.issuedAt.toISOString() ?? null,
    issuedById: order.pickupIssue?.issuedById ?? null,
    blockers,
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

/**
 * Самовывозы выбранного московского дня: готовые к выдаче и уже выданные.
 *
 * Один запрос на день, а не «все размещения склада»: менеджеру нужен его
 * прилавок сегодня, а не история всего здания.
 */
export async function listPickupsOfDay(
  db: Database,
  day: string,
): Promise<{ deliveryDate: string; waiting: PickupCard[]; issued: PickupCard[] }> {
  const orders = await db.deliveryOrder.findMany({
    where: {
      deliveryDate: toDateColumn(day),
      fulfillmentInScope: true,
      deliveryMethodId: PICKUP_METHOD_ID,
    },
    orderBy: [{ externalName: 'asc' }],
    select: ORDER_SELECT,
    take: LIST_LIMIT,
  });

  const cards = orders.map(toCard);

  return {
    deliveryDate: day,
    // «Ждут выдачи» — те, у кого есть фактическая ячейка и нет факта выдачи.
    waiting: cards.filter((card) => card.issuedAt === null && card.cellId !== null),
    issued: cards.filter((card) => card.issuedAt !== null),
  };
}
