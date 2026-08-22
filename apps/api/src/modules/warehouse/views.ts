/**
 * Чтение для трёх складских вкладок.
 *
 * Состав ответа узкий намеренно: складу нужны номер заказа, фактическая ячейка
 * и маршрутный контекст. Ни адреса, ни телефона, ни получателя, ни состава,
 * ни денег здесь нет и быть не может — сервер их не отдаёт.
 */

import type { $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { fromDateColumn, toDateColumn } from '../integrations/moysklad/delivery-date.js';

export interface PlacedOrderView {
  orderId: string;
  orderNumber: string;
  deliveryDate: string | null;
  cellId: string | null;
  cellCode: string | null;
  cellKind: $Enums.StorageCellKind | null;
  requiresRelocation: boolean;
  /** Признаки, блокирующие обычное комплектование и выдачу. */
  blockedBy: string[];
  /** Номер маршрутного листа, если заказ в активном подтверждённом составе. */
  routeNumber: string | null;
  routeId: string | null;
}

function flagsOf(order: {
  inScope: boolean;
  sourceArchived: boolean;
  sourceMissing: boolean;
  cancelledInSource: boolean;
  cancelledByLogistAt: Date | null;
}): string[] {
  const flags: string[] = [];
  if (!order.inScope) flags.push('OUT_OF_SCOPE');
  if (order.sourceArchived) flags.push('SOURCE_ARCHIVED');
  if (order.sourceMissing) flags.push('SOURCE_MISSING');
  // Отменённый заказ нельзя ни комплектовать, ни выдавать. Из ячейки он при
  // этом автоматически не уезжает: товар двигают руками и осознанно.
  if (order.cancelledInSource || order.cancelledByLogistAt !== null) flags.push('CANCELLED');
  return flags;
}

/**
 * Полные размеры групп складского списка.
 *
 * Считаются по тому же признаку действующего размещения, что и сам список,
 * и не зависят от того, сколько страниц человек уже дочитал.
 */
export interface PlacementGroupTotals {
  /** Требуется перемещение. */
  relocation: number;
  /** Отменённые, которые всё ещё физически стоят на полке. */
  cancelled: number;
  /** Спокойно лежат в ячейке хранения. */
  storage: number;
  /** Стоят в маршрутной ячейке. */
  route: number;
}

/**
 * Что сейчас лежит на складе.
 *
 * Список строится от РАЗМЕЩЕНИЙ, а не от заказов: склад отвечает за коробки,
 * которые физически стоят на полках, и заказ без размещения его не касается.
 */
export async function listPlacedOrders(
  db: Database,
  input: { cellId: string | null; limit: number; offset: number },
): Promise<{
  items: PlacedOrderView[];
  total: number;
  limit: number;
  offset: number;
  groupTotals: PlacementGroupTotals;
}> {
  const where = { releasedAt: null, ...(input.cellId === null ? {} : { cellId: input.cellId }) };

  /*
   * Отменённым считается размещение, у заказа которого отмена пришла из
   * источника ИЛИ проставлена логистом. Тот же предикат разбирает строки на
   * группы в интерфейсе: расходись они — счётчик показывал бы одно, а список
   * под ним другое.
   *
   * Перемещение старше отмены: коробка, которую надо переставить, мешает
   * работе прямо сейчас, даже если заказ отменён.
   */
  const cancelledOrder = {
    OR: [{ cancelledInSource: true }, { cancelledByLogistAt: { not: null } }],
  };

  const [rows, total, relocationTotal, cancelledTotal, routeTotal] = await Promise.all([
    db.orderPlacement.findMany({
      where,
      orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
      skip: input.offset,
      select: {
        requiresRelocation: true,
        cell: { select: { id: true, code: true, kind: true } },
        order: {
          select: {
            id: true,
            externalName: true,
            deliveryDate: true,
            inScope: true,
            sourceArchived: true,
            cancelledInSource: true,
            cancelledByLogistAt: true,
            sourceMissing: true,
            routeOrders: {
              where: { removedAt: null },
              select: { route: { select: { id: true, number: true, state: true } } },
            },
          },
        },
      },
    }),
    db.orderPlacement.count({ where }),
    db.orderPlacement.count({ where: { ...where, requiresRelocation: true } }),
    db.orderPlacement.count({
      where: { ...where, requiresRelocation: false, order: cancelledOrder },
    }),
    db.orderPlacement.count({
      where: {
        ...where,
        requiresRelocation: false,
        NOT: { order: cancelledOrder },
        cell: { kind: 'ROUTE' },
      },
    }),
  ]);

  const items = rows.map((row) => {
    const active = row.order.routeOrders[0]?.route ?? null;
    return {
      orderId: row.order.id,
      orderNumber: row.order.externalName,
      deliveryDate: row.order.deliveryDate === null ? null : fromDateColumn(row.order.deliveryDate),
      cellId: row.cell.id,
      cellCode: row.cell.code,
      cellKind: row.cell.kind,
      requiresRelocation: row.requiresRelocation,
      blockedBy: flagsOf(row.order),
      routeNumber: active?.number ?? null,
      routeId: active?.id ?? null,
    };
  });

  /*
   * Счётчики считаются по ВСЕМУ складу, а не по загруженной странице.
   * Иначе «Отменённые · 100» означало бы всего лишь «столько попало в первую
   * сотню», и кладовщик читал бы это как полное число коробок.
   */
  const groupTotals: PlacementGroupTotals = {
    relocation: relocationTotal,
    cancelled: cancelledTotal,
    route: routeTotal,
    // Остаток — обычное хранение: считать его отдельным запросом незачем,
    // четыре группы покрывают весь набор без пересечений.
    storage: total - relocationTotal - cancelledTotal - routeTotal,
  };

  return { items, total, limit: input.limit, offset: input.offset, groupTotals };
}

export interface RouteFlowOrderView extends PlacedOrderView {
  /** Позиция остановки в подтверждённом маршруте. */
  position: number;
  /** Заказ уже выдан курьеру в текущей сессии. */
  issued: boolean;
  /** Заказ лежит именно в маршрутной ячейке ЭТОГО листа. */
  inRouteCell: boolean;
}

export interface RouteFlowView {
  routeId: string;
  routeNumber: string;
  state: $Enums.RouteState;
  version: number;
  deliveryDate: string;
  courier: { id: string; fullName: string } | null;
  /**
   * Маршрутные ячейки листа. Их может быть несколько.
   *
   * Поле множественное намеренно: одна полка не вмещает полтора десятка
   * коробок, а «первая из списка» скрывала бы остальные от кладовщика.
   */
  routeCells: { id: string; code: string }[];
  issueSession: {
    id: string;
    courierUserId: string;
    state: $Enums.IssueSessionState;
  } | null;
  orders: RouteFlowOrderView[];
}

/** Карточка маршрутного листа для вкладок «Сборка» и «Выдача». */
export async function getRouteFlow(db: Database, routeId: string): Promise<RouteFlowView | null> {
  const route = await db.deliveryRoute.findUnique({
    where: { id: routeId },
    select: {
      id: true,
      number: true,
      state: true,
      version: true,
      deliveryDate: true,
      courier: { select: { id: true, fullName: true } },
      orders: {
        where: { removedAt: null },
        orderBy: { position: 'asc' },
        select: {
          position: true,
          order: {
            select: {
              id: true,
              externalName: true,
              deliveryDate: true,
              inScope: true,
              sourceArchived: true,
              cancelledInSource: true,
              cancelledByLogistAt: true,
              sourceMissing: true,
              placements: {
                where: { releasedAt: null },
                select: {
                  requiresRelocation: true,
                  cell: { select: { id: true, code: true, kind: true } },
                },
              },
            },
          },
        },
      },
      cellBindings: {
        where: { releasedAt: null },
        select: { cell: { select: { id: true, code: true } } },
      },
      issueSessions: {
        where: { state: 'OPEN' },
        select: { id: true, courierUserId: true, state: true },
      },
    },
  });

  if (route === null) {
    return null;
  }

  const routeCells = route.cellBindings.map((binding) => binding.cell);
  const routeCellIds = new Set(routeCells.map((cell) => cell.id));
  const session = route.issueSessions[0] ?? null;

  // Выданность считается по маршруту, а не по открытой сессии: коробка не
  // возвращается на склад оттого, что сессию отменили, а после перехода в
  // ACTIVE открытой сессии уже нет. Определение то же, что у прогресса в
  // route-flow.ts, иначе экран и ответ на скан разошлись бы.
  const issuedIds = new Set<string>();
  const issued = await db.orderPlacement.findMany({
    where: {
      releaseReason: 'ISSUED_TO_COURIER',
      issueSession: { routeId: route.id },
      order: { routeOrders: { some: { routeId: route.id, removedAt: null } } },
    },
    select: { orderId: true },
    distinct: ['orderId'],
  });
  for (const row of issued) {
    issuedIds.add(row.orderId);
  }

  const orders: RouteFlowOrderView[] = route.orders.map((participation) => {
    const order = participation.order;
    const placement = order.placements[0] ?? null;
    return {
      orderId: order.id,
      orderNumber: order.externalName,
      deliveryDate: order.deliveryDate === null ? null : fromDateColumn(order.deliveryDate),
      cellId: placement?.cell.id ?? null,
      cellCode: placement?.cell.code ?? null,
      cellKind: placement?.cell.kind ?? null,
      requiresRelocation: placement?.requiresRelocation ?? false,
      blockedBy: flagsOf(order),
      routeNumber: route.number,
      routeId: route.id,
      position: participation.position,
      issued: issuedIds.has(order.id),
      inRouteCell: placement !== null && routeCellIds.has(placement.cell.id),
    };
  });

  return {
    routeId: route.id,
    routeNumber: route.number,
    state: route.state,
    version: route.version,
    deliveryDate: fromDateColumn(route.deliveryDate),
    courier: route.courier,
    routeCells,
    issueSession: session,
    orders,
  };
}

export interface RouteSummary {
  routeId: string;
  routeNumber: string;
  state: $Enums.RouteState;
  deliveryDate: string;
  courier: { id: string; fullName: string } | null;
  total: number;
  inRouteCell: number;
  issued: number;
  hasIssueSession: boolean;
}

/**
 * Подтверждённые маршрутные листы выбранного московского дня.
 *
 * Календарная дата приходит строкой `YYYY-MM-DD` и сравнивается с колонкой
 * типа `DATE`: сравнение моментов времени внесло бы часовой пояс туда, где
 * его нет, и маршрут уехал бы в соседний день.
 */
export async function listConfirmedRoutes(
  db: Database,
  deliveryDate: string,
): Promise<RouteSummary[]> {
  const routes = await db.deliveryRoute.findMany({
    where: { deliveryDate: toDateColumn(deliveryDate), state: { in: ['CONFIRMED', 'ACTIVE'] } },
    orderBy: { number: 'asc' },
    select: {
      id: true,
      number: true,
      state: true,
      deliveryDate: true,
      courier: { select: { id: true, fullName: true } },
      orders: { where: { removedAt: null }, select: { orderId: true } },
      cellBindings: { where: { releasedAt: null }, select: { cellId: true } },
      issueSessions: { where: { state: 'OPEN' }, select: { id: true } },
    },
  });

  return Promise.all(
    routes.map(async (route) => {
      const orderIds = route.orders.map((row) => row.orderId);
      const cellId = route.cellBindings[0]?.cellId ?? null;
      const sessionId = route.issueSessions[0]?.id ?? null;

      const inRouteCell =
        cellId === null || orderIds.length === 0
          ? 0
          : await db.orderPlacement.count({
              where: { orderId: { in: orderIds }, cellId, releasedAt: null },
            });

      const issued =
        sessionId === null
          ? 0
          : await db.orderPlacement.count({
              where: { issueSessionId: sessionId, releaseReason: 'ISSUED_TO_COURIER' },
            });

      return {
        routeId: route.id,
        routeNumber: route.number,
        state: route.state,
        deliveryDate: fromDateColumn(route.deliveryDate),
        courier: route.courier,
        total: orderIds.length,
        inRouteCell,
        issued,
        hasIssueSession: sessionId !== null,
      };
    }),
  );
}
