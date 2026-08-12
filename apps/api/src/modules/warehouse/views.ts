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
}): string[] {
  const flags: string[] = [];
  if (!order.inScope) flags.push('OUT_OF_SCOPE');
  if (order.sourceArchived) flags.push('SOURCE_ARCHIVED');
  if (order.sourceMissing) flags.push('SOURCE_MISSING');
  return flags;
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
): Promise<{ items: PlacedOrderView[]; total: number; limit: number; offset: number }> {
  const where = { releasedAt: null, ...(input.cellId === null ? {} : { cellId: input.cellId }) };

  const [rows, total] = await Promise.all([
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

  return { items, total, limit: input.limit, offset: input.offset };
}

export interface RouteFlowOrderView extends PlacedOrderView {
  /** Позиция остановки в подтверждённом маршруте. */
  position: number;
  /** Заказ уже выдан курьеру в текущей сессии. */
  issued: boolean;
  /** Заказ лежит именно в маршрутной ячейке этого листа. */
  inRouteCell: boolean;
}

export interface RouteFlowView {
  routeId: string;
  routeNumber: string;
  state: $Enums.RouteState;
  version: number;
  deliveryDate: string;
  courier: { id: string; fullName: string } | null;
  routeCell: { id: string; code: string } | null;
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

  const routeCell = route.cellBindings[0]?.cell ?? null;
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
      inRouteCell: routeCell !== null && placement?.cell.id === routeCell.id,
    };
  });

  return {
    routeId: route.id,
    routeNumber: route.number,
    state: route.state,
    version: route.version,
    deliveryDate: fromDateColumn(route.deliveryDate),
    courier: route.courier,
    routeCell,
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
