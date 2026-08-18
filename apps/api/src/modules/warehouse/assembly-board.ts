/**
 * Доска сборки: маршрутные листы, которым нужна складская работа.
 *
 * Отдельный файл, и это не оформление. Физические операции склада —
 * приёмка, комплектование, выдача — обязаны оставаться независимыми от
 * производственного контура: коробку принимают потому, что она стоит перед
 * кладовщиком, а не потому, что чей-то программный статус это разрешил.
 * Это правило закреплено проверкой по исходникам `placement.ts`,
 * `route-flow.ts`, `order-lookup.ts` и `views.ts`.
 *
 * Здесь же не операция, а ЭКРАН. Кладовщику нужно знать, почему коробки
 * ещё нет на полке: её не собрали или собрали и не донесли. Ответ на этот
 * вопрос живёт в состоянии сборки, поэтому доска его читает — но ничего
 * им не запрещает и ни одной физической операции на нём не строит.
 *
 * Порядок и разделение на группы считает СЕРВЕР по полному набору листов.
 * Сортировка на клиенте упорядочила бы только загруженную страницу, и лист
 * с самым ранним временем оказался бы внизу второй страницы.
 */

import type { $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { fromDateColumn } from '../integrations/moysklad/delivery-date.js';

/**
 * Складская стадия одного заказа листа.
 *
 * «Готов» ставится ТОЛЬКО за действующее размещение в маршрутной ячейке
 * этого листа. Коробка в чужой маршрутной ячейке готовностью не считается:
 * она стоит на полке другого курьера и уедет вместе с ним.
 */
export type RouteOrderStage = 'NOT_ASSEMBLED' | 'AWAITING_INTAKE' | 'IN_STORAGE' | 'READY';

export interface AssemblyOrderView {
  orderId: string;
  orderNumber: string;
  position: number;
  /** Минуты от полуночи Москвы. `null` — интервал не распознан. */
  startMinute: number | null;
  endMinute: number | null;
  cellCode: string | null;
  cellKind: $Enums.StorageCellKind | null;
  stage: RouteOrderStage;
  /** Маршрут менялся после комплектования: коробку надо переставить. */
  requiresRelocation: boolean;
  /** Заказ отменён — везти его нельзя ни при какой готовности. */
  cancelled: boolean;
}

export interface AssemblyRouteView {
  routeId: string;
  routeNumber: string;
  deliveryDate: string;
  /** Раннее распознанное начало интервала среди действующих заказов. */
  earliestMinute: number | null;
  courier: { id: string; fullName: string } | null;
  cells: { id: string; code: string }[];
  total: number;
  ready: number;
  orders: AssemblyOrderView[];
}

export interface AssemblyBoard {
  /** Листы, которым ещё нужна складская работа. */
  active: AssemblyRouteView[];
  /** Полностью собранные листы: все действующие заказы в ячейках листа. */
  assembled: AssemblyRouteView[];
}

/**
 * Все подтверждённые неотгруженные листы.
 *
 * День не ограничивается намеренно. Незавершённый лист вчерашнего дня
 * не перестаёт требовать работы оттого, что наступило завтра: коробки
 * стоят на полках, и спрятать лист значит потерять их.
 */
export async function readAssemblyBoard(db: Database): Promise<AssemblyBoard> {
  const routes = await db.deliveryRoute.findMany({
    where: { state: 'CONFIRMED' },
    select: {
      id: true,
      number: true,
      deliveryDate: true,
      courier: { select: { id: true, fullName: true } },
      cellBindings: {
        where: { releasedAt: null },
        orderBy: { boundAt: 'asc' },
        select: { cell: { select: { id: true, code: true } } },
      },
      orders: {
        where: { removedAt: null },
        orderBy: { position: 'asc' },
        select: {
          position: true,
          order: {
            select: {
              id: true,
              externalName: true,
              intervalStartMinute: true,
              intervalEndMinute: true,
              manualIntervalStartMinute: true,
              manualIntervalEndMinute: true,
              cancelledInSource: true,
              cancelledByLogistAt: true,
              fulfillmentProcessState: true,
              placements: {
                where: { releasedAt: null },
                select: {
                  requiresRelocation: true,
                  cell: { select: { id: true, code: true, kind: true } },
                },
                take: 1,
              },
            },
          },
        },
      },
    },
  });

  const views = routes.map((route) => {
    const cells = route.cellBindings.map((binding) => binding.cell);
    const cellIds = new Set(cells.map((cell) => cell.id));

    const orders: AssemblyOrderView[] = route.orders.map((participation) => {
      const order = participation.order;
      const placement = order.placements[0] ?? null;
      const startMinute = order.manualIntervalStartMinute ?? order.intervalStartMinute;

      return {
        orderId: order.id,
        orderNumber: order.externalName,
        position: participation.position,
        startMinute,
        endMinute: order.manualIntervalEndMinute ?? order.intervalEndMinute,
        cellCode: placement?.cell.code ?? null,
        cellKind: placement?.cell.kind ?? null,
        stage: stageOf(order, placement, cellIds),
        requiresRelocation: placement?.requiresRelocation ?? false,
        cancelled: order.cancelledInSource || order.cancelledByLogistAt !== null,
      };
    });

    const ready = orders.filter((order) => order.stage === 'READY').length;
    const minutes = orders
      .map((order) => order.startMinute)
      .filter((minute): minute is number => minute !== null);

    return {
      routeId: route.id,
      routeNumber: route.number,
      deliveryDate: fromDateColumn(route.deliveryDate),
      earliestMinute: minutes.length === 0 ? null : Math.min(...minutes),
      courier: route.courier,
      cells,
      total: orders.length,
      ready,
      orders,
    };
  });

  const sorted = [...views].sort(compareRoutes);

  return {
    active: sorted.filter((route) => !isAssembled(route)),
    assembled: sorted.filter(isAssembled),
  };
}

/**
 * Полностью ли собран лист.
 *
 * Источник истины — состав листа и действующие размещения, а не отдельный
 * флаг. Флаг пришлось бы гасить при каждом исключении заказа, отмене
 * и перестановке коробки, и однажды он остался бы включённым.
 *
 * Пустой лист собранным не считается: собирать в нём нечего, и показывать
 * его среди готовых значит обещать курьеру пустую машину.
 */
export function isAssembled(route: {
  total: number;
  orders: readonly { stage: RouteOrderStage; requiresRelocation: boolean; cancelled: boolean }[];
}): boolean {
  if (route.total === 0) {
    return false;
  }
  return route.orders.every(
    (order) => order.stage === 'READY' && !order.requiresRelocation && !order.cancelled,
  );
}

/**
 * Порядок листов на доске.
 *
 * Сначала день доставки, потом раннее время внутри дня, потом номер.
 * Лист без распознанного времени идёт после листов со временем того же
 * дня: время у него неизвестно, и ставить его вперёд значило бы выдать
 * догадку за расписание.
 */
export function compareRoutes(
  left: { deliveryDate: string; earliestMinute: number | null; routeNumber: string },
  right: { deliveryDate: string; earliestMinute: number | null; routeNumber: string },
): number {
  if (left.deliveryDate !== right.deliveryDate) {
    return left.deliveryDate < right.deliveryDate ? -1 : 1;
  }
  if (left.earliestMinute !== right.earliestMinute) {
    if (left.earliestMinute === null) return 1;
    if (right.earliestMinute === null) return -1;
    return left.earliestMinute - right.earliestMinute;
  }
  return left.routeNumber.localeCompare(right.routeNumber, 'ru');
}

function stageOf(
  order: { fulfillmentProcessState: string },
  placement: { cell: { id: string } } | null,
  routeCellIds: ReadonlySet<string>,
): RouteOrderStage {
  if (placement !== null) {
    return routeCellIds.has(placement.cell.id) ? 'READY' : 'IN_STORAGE';
  }
  /*
   * Размещения нет — коробки на складе нет вовсе.
   *
   * Различаются два случая, и кладовщику важен именно этот выбор: идти
   * к флористу за букетом или ждать, пока его донесут.
   */
  return order.fulfillmentProcessState === 'ASSEMBLED' ? 'AWAITING_INTAKE' : 'NOT_ASSEMBLED';
}
