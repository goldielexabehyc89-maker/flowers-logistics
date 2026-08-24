/**
 * Логистическая история: только просмотр прошлого.
 *
 * Экран отвечает на вопросы «что произошло с маршрутом или заказом, кто это
 * сделал, когда и почему». Рабочих действий здесь нет вовсе — это отдельная
 * вкладка, а не второй список маршрутных листов.
 *
 * Лента строится по МАРШРУТАМ: у логиста в голове день состоит из маршрутов,
 * а не из отдельных записей аудита. Раскрытие одного маршрута отдаёт его состав
 * и хронологию событий, собранную из трёх неизменяемых источников: аудита,
 * переходов состояния и попыток доставки с их отменами.
 *
 * Завершённые и отменённые записи не исчезают, даже если заказ ушёл из области
 * МоегоСклада или был там архивирован: история — про прошлое, а не про то,
 * что видно в источнике сегодня.
 */

import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { fromDateColumn, toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { addressDetailsOf, effectiveAddress, ORDER_ADDRESS_SELECT } from '../orders/address.js';

/** Действия аудита, которые показывает логистическая история. */
export const HISTORY_ACTIONS = [
  'ROUTE_CREATED',
  'ROUTE_CONFIRMED',
  'ROUTE_RETURNED_TO_DRAFT',
  'ROUTE_CANCELLED',
  'ROUTE_COMPLETED',
  'ROUTE_COURIER_ASSIGNED',
  'ROUTE_COURIER_UNASSIGNED',
  'ROUTE_ORDERS_ADDED',
  'ROUTE_ORDERS_MOVED',
  'ROUTE_ORDERS_RETURNED',
  'ROUTE_ORDERS_REORDERED',
  'ROUTE_ISSUED_TO_COURIER',
  'ROUTE_SHIPMENT_CANCELLED',
  'ROUTE_SPLIT_FROM_SHIPMENT',
  'ROUTE_PLAN_APPLIED',
] as const;

/** Человеческие названия событий. Технические коды на экран не выносятся. */
export const EVENT_LABELS: Record<string, string> = {
  ROUTE_CREATED: 'Черновик создан',
  ROUTE_CONFIRMED: 'Маршрутный лист подтверждён',
  ROUTE_RETURNED_TO_DRAFT: 'Возвращён в черновик',
  ROUTE_CANCELLED: 'Маршрут отменён',
  ROUTE_COMPLETED: 'Маршрут завершён',
  ROUTE_COURIER_ASSIGNED: 'Курьер назначен',
  ROUTE_COURIER_UNASSIGNED: 'Курьер снят',
  ROUTE_ORDERS_ADDED: 'Заказы добавлены',
  ROUTE_ORDERS_MOVED: 'Заказы перенесены',
  ROUTE_ORDERS_RETURNED: 'Заказы возвращены в «Сделки»',
  ROUTE_ORDERS_REORDERED: 'Порядок остановок изменён',
  ROUTE_ISSUED_TO_COURIER: 'Отгружен курьеру',
  ROUTE_SHIPMENT_CANCELLED: 'Отгрузка отменена',
  ROUTE_SPLIT_FROM_SHIPMENT: 'Незавершённые вынесены в новый лист',
  ROUTE_PLAN_APPLIED: 'Создан автоматическим расчётом',
  DELIVERY_RESULT_RECORDED: 'Результат доставки',
  DELIVERY_RESULT_CANCELLED: 'Результат отменён',
  DELIVERY_RESULT_CORRECTED: 'Результат исправлен логистом',
};

export interface HistoryFilters {
  from: string;
  to: string;
  courierUserId?: string | undefined;
  actorUserId?: string | undefined;
  state?: string | undefined;
  search?: string | undefined;
  limit: number;
  offset: number;
}

export interface HistoryRouteRow {
  id: string;
  number: string;
  deliveryDate: string;
  state: string;
  vehicleType: string;
  courier: { id: string; fullName: string } | null;
  orderCount: number;
  deliveredCount: number;
  failedCount: number;
  /** Время ключевого результата: последний окончательный факт по маршруту. */
  lastResultAt: string | null;
}

/** Денежная операция в истории: без разбора по заказам, только факт. */
export interface HistoryPayment {
  id: string;
  occurredAt: string;
  kind: string;
  amountMinor: string;
  courierName: string;
  actorName: string | null;
  reason: string | null;
  reversed: boolean;
}

export interface HistoryPage {
  days: { date: string; routes: HistoryRouteRow[]; payments: HistoryPayment[] }[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Поиск переводится в множества идентификаторов ДО выборки маршрутов.
 *
 * Иначе фильтровать пришлось бы уже загруженную страницу, и маршрут со второй
 * страницы исчезал бы из поиска вовсе — это не поиск, а иллюзия поиска.
 */
async function routeIdsBySearch(db: Database, search: string): Promise<string[] | null> {
  const value = search.trim();
  if (value === '') {
    return null;
  }

  const [byOrder, byCourier] = await Promise.all([
    db.routeOrder.findMany({
      where: { order: { externalName: { contains: value, mode: 'insensitive' } } },
      select: { routeId: true },
      take: 500,
    }),
    db.user.findMany({
      where: {
        OR: [
          { fullName: { contains: value, mode: 'insensitive' } },
          { phone: { contains: value } },
        ],
      },
      select: { id: true },
      take: 100,
    }),
  ]);

  const courierIds = byCourier.map((row) => row.id);
  const byRouteNumber = await db.deliveryRoute.findMany({
    where: {
      OR: [
        { number: { contains: value, mode: 'insensitive' } },
        ...(courierIds.length > 0 ? [{ courierUserId: { in: courierIds } }] : []),
      ],
    },
    select: { id: true },
    take: 500,
  });

  return [
    ...new Set([...byOrder.map((row) => row.routeId), ...byRouteNumber.map((row) => row.id)]),
  ];
}

export async function listHistory(db: Database, filters: HistoryFilters): Promise<HistoryPage> {
  const searchIds =
    filters.search === undefined ? null : await routeIdsBySearch(db, filters.search);

  const where = {
    deliveryDate: { gte: toDateColumn(filters.from), lte: toDateColumn(filters.to) },
    ...(filters.courierUserId === undefined ? {} : { courierUserId: filters.courierUserId }),
    ...(filters.state === undefined ? {} : { state: filters.state as 'DRAFT' }),
    ...(searchIds === null ? {} : { id: { in: searchIds } }),
    ...(filters.actorUserId === undefined ? {} : { createdById: filters.actorUserId }),
  };

  const [rows, total] = await Promise.all([
    db.deliveryRoute.findMany({
      where,
      orderBy: [{ deliveryDate: 'desc' }, { number: 'desc' }],
      take: filters.limit,
      skip: filters.offset,
      select: {
        id: true,
        number: true,
        deliveryDate: true,
        state: true,
        vehicleType: true,
        courier: { select: { id: true, fullName: true } },
        orders: { where: { removedAt: null }, select: { id: true } },
        attempts: {
          where: { activeKey: { not: null } },
          select: { outcome: true, occurredAt: true },
        },
      },
    }),
    db.deliveryRoute.count({ where }),
  ]);

  /*
   * Денежные операции периода.
   *
   * История обязана отвечать и на вопрос «кто и когда провёл платёж»: сдача
   * наличных и выдача денег — такие же события прошлого, как отгрузка.
   */
  const payments = await db.courierLedgerEntry.findMany({
    where: {
      operationDate: { gte: toDateColumn(filters.from), lte: toDateColumn(filters.to) },
      attemptId: null,
      ...(filters.courierUserId === undefined ? {} : { courierUserId: filters.courierUserId }),
    },
    orderBy: [{ occurredAt: 'desc' }],
    take: 500,
    select: {
      id: true,
      occurredAt: true,
      operationDate: true,
      kind: true,
      amountMinor: true,
      reason: true,
      courier: { select: { fullName: true } },
      actor: { select: { fullName: true } },
      reversedBy: { select: { id: true } },
    },
  });

  const cashMoves = await db.logistCashEntry.findMany({
    where: { operationDate: { gte: toDateColumn(filters.from), lte: toDateColumn(filters.to) } },
    orderBy: [{ occurredAt: 'desc' }],
    take: 500,
    select: {
      id: true,
      occurredAt: true,
      operationDate: true,
      kind: true,
      amountMinor: true,
      reason: true,
      logist: { select: { fullName: true } },
      courier: { select: { fullName: true } },
      actor: { select: { fullName: true } },
      reversedBy: { select: { id: true } },
    },
  });

  const paymentsByDay = new Map<string, HistoryPayment[]>();

  /*
   * Движения кассы логиста — тоже история денег.
   *
   * Владелец кассы называется прямо: без него «сдано в компанию» не отвечает
   * на вопрос, из чьей кассы ушли деньги.
   */
  for (const move of cashMoves) {
    const date = fromDateColumn(move.operationDate);
    paymentsByDay.set(date, [
      ...(paymentsByDay.get(date) ?? []),
      {
        id: move.id,
        occurredAt: move.occurredAt.toISOString(),
        // Префикс отличает движение кассы от одноимённой записи у курьера.
        kind: `DESK_${move.kind}`,
        amountMinor: move.amountMinor.toString(),
        courierName: move.courier?.fullName ?? move.logist.fullName,
        actorName: move.actor.fullName,
        reason: move.reason,
        reversed: move.reversedBy !== null,
      },
    ]);
  }
  for (const payment of payments) {
    const date = fromDateColumn(payment.operationDate);
    paymentsByDay.set(date, [
      ...(paymentsByDay.get(date) ?? []),
      {
        id: payment.id,
        occurredAt: payment.occurredAt.toISOString(),
        kind: payment.kind,
        amountMinor: payment.amountMinor.toString(),
        courierName: payment.courier.fullName,
        actorName: payment.actor.fullName,
        reason: payment.reason,
        reversed: payment.reversedBy !== null,
      },
    ]);
  }

  const byDay = new Map<string, HistoryRouteRow[]>();
  for (const row of rows) {
    const date = fromDateColumn(row.deliveryDate);
    const delivered = row.attempts.filter((item) => item.outcome === 'DELIVERED').length;
    const failed = row.attempts.filter((item) => item.outcome === 'NOT_DELIVERED').length;
    const last = row.attempts.reduce<Date | null>(
      (latest, item) => (latest === null || item.occurredAt > latest ? item.occurredAt : latest),
      null,
    );

    byDay.set(date, [
      ...(byDay.get(date) ?? []),
      {
        id: row.id,
        number: row.number,
        deliveryDate: date,
        state: row.state,
        vehicleType: row.vehicleType,
        courier: row.courier,
        orderCount: row.orders.length,
        deliveredCount: delivered,
        failedCount: failed,
        lastResultAt: last === null ? null : last.toISOString(),
      },
    ]);
  }

  // День показывается, даже если в нём были только платежи и ни одного маршрута.
  const dates = [...new Set([...byDay.keys(), ...paymentsByDay.keys()])];

  return {
    days: dates
      .sort((left, right) => right.localeCompare(left))
      .map((date) => ({
        date,
        routes: byDay.get(date) ?? [],
        payments: paymentsByDay.get(date) ?? [],
      })),
    total,
    limit: filters.limit,
    offset: filters.offset,
    hasMore: filters.offset + rows.length < total,
  };
}

export interface HistoryEvent {
  occurredAt: string;
  action: string;
  label: string;
  actor: { id: string; fullName: string } | null;
  /** Безопасные подробности: идентификаторы, состояния и числа. */
  details: Record<string, string | number | boolean | null>;
  reason: string | null;
}

export interface HistoryRouteDetails {
  route: HistoryRouteRow;
  orders: {
    routeOrderId: string;
    position: number;
    number: string;
    address: string | null;
    recipient: string | null;
    interval: string | null;
    outcome: string | null;
    outcomeAt: string | null;
    failureReason: string | null;
    removedAt: string | null;
  }[];
  events: HistoryEvent[];
}

/** Подробности одного маршрута: состав и хронология. */
export async function routeHistory(db: Database, routeId: string): Promise<HistoryRouteDetails> {
  const route = await db.deliveryRoute.findUnique({
    where: { id: routeId },
    select: {
      id: true,
      number: true,
      deliveryDate: true,
      state: true,
      vehicleType: true,
      courier: { select: { id: true, fullName: true } },
      orders: {
        orderBy: [{ position: 'asc' }],
        select: {
          id: true,
          position: true,
          removedAt: true,
          order: {
            select: {
              externalName: true,
              ...ORDER_ADDRESS_SELECT,
              recipient: true,
              intervalRaw: true,
            },
          },
          attempts: {
            where: { activeKey: { not: null } },
            select: { outcome: true, occurredAt: true, reasonNameSnapshot: true },
          },
        },
      },
    },
  });

  if (route === null) {
    throw new AppError('NOT_FOUND', { publicMessage: 'Маршрут не найден.' });
  }

  const [audit, transitions, attempts] = await Promise.all([
    db.auditLog.findMany({
      where: { entityType: 'DeliveryRoute', entityId: routeId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: {
        occurredAt: true,
        action: true,
        newValue: true,
        actor: { select: { id: true, fullName: true } },
      },
    }),
    db.routeStateTransition.findMany({
      where: { routeId },
      orderBy: [{ occurredAt: 'desc' }],
      take: 200,
      select: {
        occurredAt: true,
        fromState: true,
        toState: true,
        reason: true,
        actor: { select: { id: true, fullName: true } },
      },
    }),
    db.deliveryAttempt.findMany({
      where: { routeId },
      orderBy: [{ occurredAt: 'desc' }],
      take: 200,
      select: {
        id: true,
        outcome: true,
        occurredAt: true,
        reasonNameSnapshot: true,
        courier: { select: { id: true, fullName: true } },
        order: { select: { externalName: true } },
        cancellation: {
          select: {
            kind: true,
            reason: true,
            occurredAt: true,
            actor: { select: { id: true, fullName: true } },
          },
        },
      },
    }),
  ]);

  const events: HistoryEvent[] = [];

  for (const entry of audit) {
    const value = (entry.newValue ?? {}) as Record<string, unknown>;
    events.push({
      occurredAt: entry.occurredAt.toISOString(),
      action: entry.action,
      label: EVENT_LABELS[entry.action] ?? entry.action,
      actor: entry.actor,
      details: {
        orders:
          typeof value['orderIds'] === 'object' && Array.isArray(value['orderIds'])
            ? (value['orderIds'] as unknown[]).length
            : null,
        movedToRouteId:
          typeof value['movedToRouteId'] === 'string' ? value['movedToRouteId'] : null,
        createdRouteId:
          typeof value['createdRouteId'] === 'string' ? value['createdRouteId'] : null,
      },
      reason: null,
    });
  }

  for (const transition of transitions) {
    events.push({
      occurredAt: transition.occurredAt.toISOString(),
      action: `STATE_${transition.toState}`,
      label: `Состояние: ${transition.fromState} → ${transition.toState}`,
      actor: transition.actor,
      details: { fromState: transition.fromState, toState: transition.toState },
      reason: transition.reason,
    });
  }

  for (const attempt of attempts) {
    events.push({
      occurredAt: attempt.occurredAt.toISOString(),
      action: 'DELIVERY_RESULT_RECORDED',
      label:
        attempt.outcome === 'DELIVERED'
          ? `Доставлен ${attempt.order.externalName}`
          : `Не доставлен ${attempt.order.externalName}`,
      actor: attempt.courier,
      details: { outcome: attempt.outcome, orderNumber: attempt.order.externalName },
      reason: attempt.reasonNameSnapshot,
    });

    if (attempt.cancellation !== null) {
      events.push({
        occurredAt: attempt.cancellation.occurredAt.toISOString(),
        action:
          attempt.cancellation.kind === 'MANAGER_CORRECTION'
            ? 'DELIVERY_RESULT_CORRECTED'
            : 'DELIVERY_RESULT_CANCELLED',
        label:
          attempt.cancellation.kind === 'MANAGER_CORRECTION'
            ? `Результат исправлен логистом: ${attempt.order.externalName}`
            : `Результат отменён курьером: ${attempt.order.externalName}`,
        actor: attempt.cancellation.actor,
        details: { orderNumber: attempt.order.externalName },
        reason: attempt.cancellation.reason,
      });
    }
  }

  events.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));

  const active = route.orders.filter((item) => item.removedAt === null);
  const delivered = active.filter((item) => item.attempts[0]?.outcome === 'DELIVERED').length;
  const failed = active.filter((item) => item.attempts[0]?.outcome === 'NOT_DELIVERED').length;
  const lastResult = active
    .flatMap((item) => item.attempts)
    .reduce<Date | null>(
      (latest, item) => (latest === null || item.occurredAt > latest ? item.occurredAt : latest),
      null,
    );

  return {
    route: {
      id: route.id,
      number: route.number,
      deliveryDate: fromDateColumn(route.deliveryDate),
      state: route.state,
      vehicleType: route.vehicleType,
      courier: route.courier,
      orderCount: active.length,
      deliveredCount: delivered,
      failedCount: failed,
      lastResultAt: lastResult === null ? null : lastResult.toISOString(),
    },
    orders: route.orders.map((item) => {
      const attempt = item.attempts[0] ?? null;
      return {
        routeOrderId: item.id,
        position: item.position,
        number: item.order.externalName,
        // Рабочий адрес: исправленный, если он есть. Курьер ехал именно по нему.
        address: effectiveAddress(item.order),
        addressDetails: addressDetailsOf(item.order),
        recipient: item.order.recipient,
        interval: item.order.intervalRaw,
        outcome: attempt?.outcome ?? null,
        outcomeAt: attempt === null ? null : attempt.occurredAt.toISOString(),
        failureReason: attempt?.reasonNameSnapshot ?? null,
        removedAt: item.removedAt === null ? null : item.removedAt.toISOString(),
      };
    }),
    events,
  };
}
