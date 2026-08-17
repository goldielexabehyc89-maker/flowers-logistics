/**
 * Комплектование маршрутного листа и выдача курьеру — этап 6.5.
 *
 * Дорожка блокировок здесь пользовательская, как у маршрутов:
 * `DeliveryRoute → RouteCellBinding / RouteIssueSession → DeliveryOrder →
 * OrderPlacement`. Она НЕ смешивается с дорожкой приёмки, которая начинает
 * с заказа: встречный порядок — это взаимная блокировка, а не редкая неудача.
 *
 * Как и приёмка, ни одна операция не смотрит на состояние FLORIST.
 */

import { Prisma, type $Enums } from '../../generated/prisma/client.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { normalizeCellCode } from './cell-code.js';
import { blockingFlags, resolveOrderByNumber } from './order-lookup.js';
import { FLOW_AUDIENCE, type FlowDeps, type RequestContext } from './placement.js';
import { assertCourierAssignable } from '../routing/service.js';

/**
 * Смена курьера и состояние листа нужны и складу, а не одной логистике.
 *
 * Сборщик цветов сюда не входит намеренно: кто повезёт маршрут, его работы
 * не меняет, а складской модуль не должен знать о производстве ничего.
 */
const ROUTE_AUDIENCE = ['ADMIN', 'LOGISTICIAN', 'WAREHOUSE'] as const;

interface LockedRoute {
  id: string;
  number: string;
  state: $Enums.RouteState;
  version: number;
  courierUserId: string | null;
}

async function lockRoute(tx: TransactionClient, routeId: string): Promise<LockedRoute> {
  const rows = await tx.$queryRaw<LockedRoute[]>`
    SELECT "id", "number", "state", "version", "courierUserId"
    FROM "DeliveryRoute" WHERE "id" = ${routeId}::uuid FOR UPDATE
  `;
  const route = rows[0];
  if (route === undefined) {
    throw new AppError('NOT_FOUND', { message: 'route not found' });
  }
  return route;
}

function requireConfirmed(route: LockedRoute): void {
  if (route.state !== 'CONFIRMED') {
    throw new AppError('CONFLICT', {
      message: `route is ${route.state}`,
      publicMessage:
        route.state === 'ACTIVE'
          ? 'Маршрут уже передан курьеру.'
          : 'Маршрут не подтверждён: комплектование и выдача недоступны.',
      conflict: { kind: 'ROUTE_NOT_CONFIRMED', routeNumber: route.number },
    });
  }
}

/** Активное участие заказа в маршруте. Удалённое участие не оживает. */
async function activeRouteOrder(
  tx: TransactionClient,
  routeId: string,
  orderId: string,
): Promise<{ id: string; position: number } | null> {
  const row = await tx.routeOrder.findFirst({
    where: { routeId, orderId, removedAt: null },
    select: { id: true, position: true },
  });
  return row;
}

// --- Привязка маршрутной ячейки ---------------------------------------------

export interface BindCellInput {
  cellCode: string;
}

export interface BindCellResult {
  routeId: string;
  cellId: string;
  cellCode: string;
  unchanged: boolean;
}

/**
 * Привязка одной маршрутной ячейки к подтверждённому маршрутному листу.
 *
 * «Одна ячейка — один незавершённый маршрут» и «один маршрут — одна активная
 * ячейка» держат частичные уникальные индексы, а не проверка в коде: две
 * параллельные привязки иначе прошли бы обе.
 */
export async function bindRouteCell(
  deps: FlowDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: BindCellInput,
  context: RequestContext,
): Promise<BindCellResult> {
  const { normalizedCode } = normalizeCellCode(input.cellCode);

  try {
    return await deps.db.$transaction(async (tx: TransactionClient) => {
      const route = await lockRoute(tx, routeId);
      requireConfirmed(route);

      const cell = await tx.storageCell.findUnique({
        where: { normalizedCode },
        select: { id: true, code: true, kind: true, isActive: true },
      });

      if (cell === null) {
        throw new AppError('NOT_FOUND', {
          message: 'storage cell not found',
          publicMessage: 'Ячейка с таким кодом не найдена.',
        });
      }
      if (cell.kind !== 'ROUTE') {
        throw new AppError('CONFLICT', {
          message: 'cell is not a route cell',
          publicMessage: 'Это ячейка хранения. Для маршрутного листа нужна маршрутная ячейка.',
          conflict: { kind: 'CELL_KIND_MISMATCH' },
        });
      }
      if (!cell.isActive) {
        throw new AppError('CONFLICT', {
          message: 'storage cell is inactive',
          publicMessage: 'Ячейка выключена и в работе не используется.',
          conflict: { kind: 'CELL_INACTIVE' },
        });
      }

      const existing = await tx.routeCellBinding.findFirst({
        where: { routeId, releasedAt: null },
        select: { id: true, cellId: true },
      });

      if (existing !== null) {
        if (existing.cellId === cell.id) {
          return { routeId, cellId: cell.id, cellCode: cell.code, unchanged: true };
        }
        throw new AppError('CONFLICT', {
          message: 'route already bound to another cell',
          publicMessage: 'У маршрутного листа уже есть маршрутная ячейка.',
          conflict: { kind: 'ROUTE_CELL_ALREADY_BOUND', routeNumber: route.number },
        });
      }

      const created = await tx.routeCellBinding.create({
        data: {
          routeId,
          cellId: cell.id,
          cellKind: 'ROUTE',
          boundById: actor.userId,
        },
        select: { id: true },
      });

      await writeAudit(tx, {
        action: 'WAREHOUSE_ROUTE_CELL_BOUND',
        entityType: 'RouteCellBinding',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        source: 'api',
        newValue: { routeId, cellId: cell.id },
        ip: context.ip,
        userAgent: context.userAgent,
      });

      await publishRealtimeEvent(tx, {
        topic: 'warehouse.route_flow_changed',
        payload: { routeId, action: 'CELL_BOUND' },
        audienceRoles: [...FLOW_AUDIENCE],
      });

      return { routeId, cellId: cell.id, cellCode: cell.code, unchanged: false };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError('CONFLICT', {
        message: 'route cell binding race',
        publicMessage: 'Эта ячейка уже занята другим маршрутным листом.',
        conflict: { kind: 'ROUTE_CELL_ALREADY_BOUND' },
      });
    }
    throw error;
  }
}

// --- Перенос заказа в маршрутную ячейку --------------------------------------

export interface PickInput {
  orderNumber: string;
  cellCode: string;
}

export interface PickResult {
  routeId: string;
  orderId: string;
  orderNumber: string;
  cellId: string;
  cellCode: string;
  unchanged: boolean;
  /** Сколько заказов маршрута уже в маршрутной ячейке и сколько всего активных. */
  picked: number;
  total: number;
}

/**
 * Перенос одного заказа в маршрутную ячейку атомарной парой сканов.
 *
 * Прогресс фиксируется после каждого заказа (`FUL-003`): комплектование можно
 * прервать и продолжить, ничего не потеряв. Часть заказов допустимо оставить
 * в обычном хранении — выдать их можно будет прямо оттуда.
 */
export async function pickOrderToRouteCell(
  deps: FlowDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: PickInput,
  context: RequestContext,
): Promise<PickResult> {
  return deps.db.$transaction(async (tx: TransactionClient) => {
    const route = await lockRoute(tx, routeId);
    requireConfirmed(route);

    const binding = await tx.routeCellBinding.findFirst({
      where: { routeId, releasedAt: null },
      select: { cellId: true },
    });
    if (binding === null) {
      throw new AppError('CONFLICT', {
        message: 'route has no bound cell',
        publicMessage: 'Сначала привяжите маршрутную ячейку к этому листу.',
        conflict: { kind: 'ROUTE_CELL_NOT_BOUND', routeNumber: route.number },
      });
    }

    const { normalizedCode } = normalizeCellCode(input.cellCode);
    const cell = await tx.storageCell.findUnique({
      where: { normalizedCode },
      select: { id: true, code: true, isActive: true },
    });
    if (cell === null || cell.id !== binding.cellId) {
      throw new AppError('CONFLICT', {
        message: 'scanned cell is not the bound route cell',
        publicMessage: 'Отсканирована не та ячейка: у этого листа другая маршрутная ячейка.',
        conflict: { kind: 'ROUTE_CELL_MISMATCH', routeNumber: route.number },
      });
    }
    if (!cell.isActive) {
      throw new AppError('CONFLICT', {
        message: 'route cell is inactive',
        publicMessage: 'Маршрутная ячейка выключена.',
        conflict: { kind: 'CELL_INACTIVE' },
      });
    }

    const order = await resolveOrderByNumber(tx, input.orderNumber);
    const blocked = blockingFlags(order);
    if (blocked.length > 0) {
      throw new AppError('CONFLICT', {
        message: `order is blocked: ${blocked.join(',')}`,
        publicMessage: 'Заказ помечен как проблемный: комплектование недоступно.',
        conflict: { kind: 'ORDER_BLOCKED', orderIds: [order.id] },
      });
    }

    const participation = await activeRouteOrder(tx, routeId, order.id);
    if (participation === null) {
      throw new AppError('CONFLICT', {
        message: 'order is not in this route',
        publicMessage: 'Этот заказ не входит в маршрутный лист.',
        conflict: { kind: 'ORDER_NOT_IN_ROUTE', routeNumber: route.number, orderIds: [order.id] },
      });
    }

    await tx.$queryRaw`SELECT "id" FROM "DeliveryOrder" WHERE "id" = ${order.id}::uuid FOR UPDATE`;

    const rows = await tx.$queryRaw<{ id: string; cellId: string }[]>`
      SELECT "id", "cellId" FROM "OrderPlacement"
      WHERE "orderId" = ${order.id}::uuid AND "releasedAt" IS NULL FOR UPDATE
    `;
    const current = rows[0] ?? null;

    if (current === null) {
      throw new AppError('CONFLICT', {
        message: 'order has no placement',
        publicMessage: 'Заказ ещё не принят на склад: сначала положите его в ячейку.',
        conflict: { kind: 'ORDER_NOT_PLACED', orderIds: [order.id] },
      });
    }

    if (current.cellId === cell.id) {
      const progress = await pickProgress(tx, routeId, cell.id);
      return {
        routeId,
        orderId: order.id,
        orderNumber: order.number,
        cellId: cell.id,
        cellCode: cell.code,
        unchanged: true,
        ...progress,
      };
    }

    const now = new Date();
    await tx.orderPlacement.update({
      where: { id: current.id },
      data: {
        releasedAt: now,
        releasedById: actor.userId,
        releaseReason: 'MOVED_TO_ROUTE_CELL',
        movedToCellId: cell.id,
      },
    });

    await tx.orderPlacement.create({
      data: {
        orderId: order.id,
        cellId: cell.id,
        fromCellId: current.cellId,
        source: 'MOVED',
        placedAt: now,
        placedById: actor.userId,
      },
    });

    await writeAudit(tx, {
      action: 'WAREHOUSE_ORDER_PICKED',
      entityType: 'OrderPlacement',
      entityId: order.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      oldValue: { cellId: current.cellId },
      newValue: { routeId, cellId: cell.id },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishRealtimeEvent(tx, {
      topic: 'warehouse.route_flow_changed',
      payload: { routeId, orderId: order.id, action: 'PICKED' },
      audienceRoles: [...FLOW_AUDIENCE],
    });

    const progress = await pickProgress(tx, routeId, cell.id);
    return {
      routeId,
      orderId: order.id,
      orderNumber: order.number,
      cellId: cell.id,
      cellCode: cell.code,
      unchanged: false,
      ...progress,
    };
  });
}

async function pickProgress(
  tx: TransactionClient,
  routeId: string,
  cellId: string,
): Promise<{ picked: number; total: number }> {
  const participations = await tx.routeOrder.findMany({
    where: { routeId, removedAt: null },
    select: { orderId: true },
  });
  const orderIds = participations.map((row) => row.orderId);

  const picked =
    orderIds.length === 0
      ? 0
      : await tx.orderPlacement.count({
          where: { orderId: { in: orderIds }, cellId, releasedAt: null },
        });

  return { picked, total: orderIds.length };
}

// --- Выдача ------------------------------------------------------------------

export interface ConfirmCourierInput {
  courierUserId: string;
}

export interface IssueSessionView {
  sessionId: string;
  routeId: string;
  courierUserId: string;
  state: $Enums.IssueSessionState;
  issued: number;
  total: number;
}

/**
 * Подтверждение назначенного курьера перед началом выдачи.
 *
 * PIN и QR курьера в этом срезе не вводятся (`FUL-003`): кладовщик видит
 * назначенного человека и подтверждает его явно. Подтверждение обязательно —
 * без него нельзя выдать ни одного заказа.
 */
export async function confirmCourier(
  deps: FlowDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: ConfirmCourierInput,
  context: RequestContext,
): Promise<IssueSessionView> {
  return deps.db.$transaction(async (tx: TransactionClient) => {
    const route = await lockRoute(tx, routeId);
    requireConfirmed(route);

    if (route.courierUserId === null) {
      throw new AppError('CONFLICT', {
        message: 'route has no courier',
        publicMessage: 'У маршрутного листа не назначен курьер.',
        conflict: { kind: 'ROUTE_COURIER_UNAVAILABLE', routeNumber: route.number },
      });
    }
    if (route.courierUserId !== input.courierUserId) {
      throw new AppError('CONFLICT', {
        message: 'courier mismatch',
        publicMessage: 'Назначенный курьер изменился. Обновите экран и подтвердите заново.',
        conflict: { kind: 'ROUTE_COURIER_UNAVAILABLE', routeNumber: route.number },
      });
    }

    const courier = await tx.user.findUnique({
      where: { id: route.courierUserId },
      select: { status: true, roles: { select: { role: true } } },
    });
    const isActiveCourier =
      courier !== null &&
      courier.status === 'ACTIVE' &&
      courier.roles.some((row) => row.role === 'COURIER');

    if (!isActiveCourier) {
      throw new AppError('CONFLICT', {
        message: 'courier is not an active COURIER',
        publicMessage: 'Назначенный курьер недоступен: проверьте его роль и статус.',
        conflict: { kind: 'ROUTE_COURIER_UNAVAILABLE', routeNumber: route.number },
      });
    }

    const open = await tx.routeIssueSession.findFirst({
      where: { routeId, state: 'OPEN' },
      select: { id: true, courierUserId: true },
    });

    if (open !== null) {
      // Повторное подтверждение того же курьера — не ошибка: выдача возобновляема.
      if (open.courierUserId !== route.courierUserId) {
        throw new AppError('CONFLICT', {
          message: 'issue session belongs to another courier',
          publicMessage: 'Выдача уже начата другим курьером.',
          conflict: { kind: 'ISSUE_SESSION_OPEN', routeNumber: route.number },
        });
      }
      return sessionView(tx, open.id, routeId, route.courierUserId, 'OPEN');
    }

    const created = await tx.routeIssueSession.create({
      data: {
        routeId,
        courierUserId: route.courierUserId,
        openKey: routeId,
        confirmedById: actor.userId,
      },
      select: { id: true },
    });

    await writeAudit(tx, {
      action: 'WAREHOUSE_COURIER_CONFIRMED',
      entityType: 'RouteIssueSession',
      entityId: created.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      newValue: { routeId, courierUserId: route.courierUserId },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishRealtimeEvent(tx, {
      topic: 'warehouse.route_flow_changed',
      payload: { routeId, action: 'COURIER_CONFIRMED' },
      audienceRoles: [...FLOW_AUDIENCE],
    });

    return sessionView(tx, created.id, routeId, route.courierUserId, 'OPEN');
  });
}

async function sessionView(
  tx: TransactionClient,
  sessionId: string,
  routeId: string,
  courierUserId: string,
  state: $Enums.IssueSessionState,
): Promise<IssueSessionView> {
  // Прогресс показывается по маршруту целиком: кладовщик, продолжающий выдачу
  // после смены курьера, должен видеть, сколько осталось всего, а не сколько
  // выдал текущий курьер.
  const { issued, total } = await routeIssueProgress(tx, routeId);
  return { sessionId, routeId, courierUserId, state, issued, total };
}

export interface IssueInput {
  orderNumber: string;
}

export interface IssueResult {
  routeId: string;
  orderId: string;
  orderNumber: string;
  unchanged: boolean;
  issued: number;
  total: number;
  /** Маршрут переведён в `ACTIVE` этим заказом. */
  routeActivated: boolean;
}

/**
 * Выдача одного заказа курьеру.
 *
 * Каждый заказ фиксируется сразу, выдача возобновляема, повтор скана уже
 * выданного заказа идемпотентен. Последний активный заказ ОДНОЙ транзакцией
 * закрывает размещение, переводит маршрут `CONFIRMED → ACTIVE`, пишет переход,
 * аудит и событие и освобождает привязку маршрутной ячейки (`FUL-003`):
 * физическая передача курьеру и есть начало маршрута.
 */

/**
 * Перевод маршрута в «отгружен» ВНУТРИ уже открытой транзакции.
 *
 * Единственная реализация этого перехода. Складская отгрузка доходит до него,
 * выдав курьеру последний заказ; логист — кнопкой «Отгрузить» без сканирования.
 * Второй экземпляр этой логики неизбежно разошёлся бы с первым, а расходятся
 * такие вещи молча: маршрут уехал бы, а история состояний осталась пустой.
 *
 * `orderId` есть только у складского пути: он говорит, какой именно заказ
 * оказался последним. Ручная отгрузка заказов не выдаёт и передаёт `null`.
 */
export async function activateRouteWithinTransaction(
  tx: TransactionClient,
  route: { id: string; number: string; version: number },
  actor: AuthenticatedActor,
  context: RequestContext,
  now: Date,
  input: { issued: number; orderId: string | null },
): Promise<void> {
  const updated = await tx.deliveryRoute.updateMany({
    where: { id: route.id, version: route.version },
    data: { state: 'ACTIVE', version: { increment: 1 } },
  });
  if (updated.count === 0) {
    throw new AppError('CONFLICT', {
      message: 'stale route version',
      publicMessage: 'Маршрут изменён другим пользователем. Обновите экран и повторите.',
      conflict: { kind: 'STALE_VERSION', routeNumber: route.number },
    });
  }

  await tx.routeStateTransition.create({
    data: {
      routeId: route.id,
      fromState: 'CONFIRMED',
      toState: 'ACTIVE',
      actorUserId: actor.userId,
      occurredAt: now,
      /*
       * Причины нет намеренно, и это правило базы: переход в «отгружен»
       * наступает от факта передачи маршрута курьеру. Чем он вызван —
       * сканированием или решением логиста — говорит аудит, а не история
       * состояний: там живут состояния, а не способы их достижения.
       */
      reason: null,
    },
  });

  // Маршрутная ячейка освобождается: её можно отдать другому листу в тот же день.
  await tx.routeCellBinding.updateMany({
    where: { routeId: route.id, releasedAt: null },
    data: { releasedAt: now, releasedById: actor.userId },
  });

  await writeAudit(tx, {
    action: 'ROUTE_ISSUED_TO_COURIER',
    entityType: 'DeliveryRoute',
    entityId: route.id,
    actorUserId: actor.userId,
    actorRoles: actor.roles,
    source: 'api',
    oldValue: { state: 'CONFIRMED', version: route.version },
    newValue: {
      state: 'ACTIVE',
      version: route.version + 1,
      issued: input.issued,
      manual: input.orderId === null,
    },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  await publishRealtimeEvent(tx, {
    topic: 'warehouse.route_flow_changed',
    payload: { routeId: route.id, orderId: input.orderId, action: 'ROUTE_ACTIVATED' },
    audienceRoles: [...FLOW_AUDIENCE],
  });
  // Логист тоже обязан увидеть, что маршрут уехал.
  await publishRealtimeEvent(tx, {
    topic: 'route.updated',
    payload: { routeId: route.id, state: 'ACTIVE' },
    audienceRoles: [...ROUTE_AUDIENCE],
  });
}

export async function issueOrder(
  deps: FlowDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: IssueInput,
  context: RequestContext,
): Promise<IssueResult> {
  return deps.db.$transaction(async (tx: TransactionClient) => {
    const route = await lockRoute(tx, routeId);
    requireConfirmed(route);

    const session = await tx.routeIssueSession.findFirst({
      where: { routeId, state: 'OPEN' },
      select: { id: true },
    });
    if (session === null) {
      throw new AppError('CONFLICT', {
        message: 'issue session is not open',
        publicMessage: 'Сначала подтвердите назначенного курьера.',
        conflict: { kind: 'ISSUE_SESSION_REQUIRED', routeNumber: route.number },
      });
    }

    const order = await resolveOrderByNumber(tx, input.orderNumber);
    const participation = await activeRouteOrder(tx, routeId, order.id);
    if (participation === null) {
      throw new AppError('CONFLICT', {
        message: 'order is not in this route',
        publicMessage: 'Этот заказ не входит в маршрутный лист.',
        conflict: { kind: 'ORDER_NOT_IN_ROUTE', routeNumber: route.number, orderIds: [order.id] },
      });
    }

    const blocked = blockingFlags(order);
    if (blocked.length > 0) {
      throw new AppError('CONFLICT', {
        message: `order is blocked: ${blocked.join(',')}`,
        publicMessage: 'Заказ помечен как проблемный: выдача недоступна.',
        conflict: { kind: 'ORDER_BLOCKED', orderIds: [order.id] },
      });
    }

    await tx.$queryRaw`SELECT "id" FROM "DeliveryOrder" WHERE "id" = ${order.id}::uuid FOR UPDATE`;

    const rows = await tx.$queryRaw<{ id: string; cellId: string; requiresRelocation: boolean }[]>`
      SELECT "id", "cellId", "requiresRelocation" FROM "OrderPlacement"
      WHERE "orderId" = ${order.id}::uuid AND "releasedAt" IS NULL FOR UPDATE
    `;
    const current = rows[0] ?? null;

    if (current === null) {
      // Повтор скана заказа, выданного по этому маршруту в ЛЮБОЙ его сессии,
      // включая уже отменённую: физическая передача состоялась, и требовать
      // от кладовщика помнить, при каком курьере это было, бессмысленно.
      if (await issuedInRoute(tx, routeId, order.id)) {
        const { issued, total } = await routeIssueProgress(tx, routeId);
        return {
          routeId,
          orderId: order.id,
          orderNumber: order.number,
          unchanged: true,
          routeActivated: false,
          issued,
          total,
        };
      }
      throw new AppError('CONFLICT', {
        message: 'order has no placement',
        publicMessage: 'Заказа нет на складе: выдать его нельзя.',
        conflict: { kind: 'ORDER_NOT_PLACED', orderIds: [order.id] },
      });
    }

    if (current.requiresRelocation) {
      throw new AppError('CONFLICT', {
        message: 'placement requires relocation',
        publicMessage: 'Заказ требует перемещения: маршрут менялся после комплектования.',
        conflict: { kind: 'PLACEMENT_REQUIRES_RELOCATION', orderIds: [order.id] },
      });
    }

    const now = new Date();
    await tx.orderPlacement.update({
      where: { id: current.id },
      data: {
        releasedAt: now,
        releasedById: actor.userId,
        releaseReason: 'ISSUED_TO_COURIER',
        issueSessionId: session.id,
      },
    });

    await writeAudit(tx, {
      action: 'WAREHOUSE_ORDER_ISSUED',
      entityType: 'OrderPlacement',
      entityId: current.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      oldValue: { cellId: current.cellId },
      newValue: { routeId, orderId: order.id, sessionId: session.id },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    const progress = await routeIssueProgress(tx, routeId);
    const last = progress.issued >= progress.total;

    if (!last) {
      await publishRealtimeEvent(tx, {
        topic: 'warehouse.route_flow_changed',
        payload: { routeId, orderId: order.id, action: 'ISSUED' },
        audienceRoles: [...FLOW_AUDIENCE],
      });
      return {
        routeId,
        orderId: order.id,
        orderNumber: order.number,
        unchanged: false,
        routeActivated: false,
        issued: progress.issued,
        total: progress.total,
      };
    }

    // Последний заказ: маршрут уезжает тем же переходом, что и при ручной
    // отгрузке логистом. Реализация одна на оба пути.
    await activateRouteWithinTransaction(tx, route, actor, context, now, {
      issued: progress.issued,
      orderId: order.id,
    });

    /*
     * Сеанс выдачи закрывается здесь, а не в общем переходе: сканирование —
     * складская часть пути. У ручной отгрузки сеанса не бывает вовсе.
     */
    await tx.routeIssueSession.update({
      where: { id: session.id },
      data: { state: 'COMPLETED', openKey: null, completedAt: now, version: { increment: 1 } },
    });

    return {
      routeId,
      orderId: order.id,
      orderNumber: order.number,
      unchanged: false,
      routeActivated: true,
      issued: progress.issued,
      total: progress.total,
    };
  });
}

/**
 * Общий прогресс выдачи МАРШРУТА, а не текущей сессии.
 *
 * Считать выдачу внутри одной сессии нельзя: после административной отмены
 * и передачи остатка другому курьеру новая сессия видела бы только свои заказы,
 * и маршрут никогда не дошёл бы до `ACTIVE`. Физически состоявшаяся передача
 * коробки курьеру не перестаёт быть фактом оттого, что сессию отменили.
 *
 * Поэтому `issued` считается по АКТИВНОМУ составу маршрута и всем фактам
 * выдачи, принадлежащим сессиям этого маршрута. Один заказ учитывается один
 * раз: считаются различные заказы, а не строки размещений.
 *
 * Отдельного счётчика в `DeliveryRoute` нет намеренно — это был бы второй
 * источник истины, который база согласовать не может.
 */
async function routeIssueProgress(
  tx: TransactionClient,
  routeId: string,
): Promise<{ issued: number; total: number; issuedOrderIds: Set<string> }> {
  const participations = await tx.routeOrder.findMany({
    where: { routeId, removedAt: null },
    select: { orderId: true },
  });
  const orderIds = participations.map((row) => row.orderId);

  if (orderIds.length === 0) {
    return { issued: 0, total: 0, issuedOrderIds: new Set() };
  }

  const issued = await tx.orderPlacement.findMany({
    where: {
      orderId: { in: orderIds },
      releaseReason: 'ISSUED_TO_COURIER',
      issueSession: { routeId },
    },
    select: { orderId: true },
    distinct: ['orderId'],
  });

  const issuedOrderIds = new Set(issued.map((row) => row.orderId));
  return { issued: issuedOrderIds.size, total: orderIds.length, issuedOrderIds };
}

/**
 * Был ли заказ уже выдан по ЭТОМУ маршруту в любой из его сессий.
 *
 * Выдача того же заказа в другом маршруте идемпотентным успехом не считается:
 * это другая коробка в другой машине, и молча согласиться означало бы потерять
 * заказ.
 */
async function issuedInRoute(
  tx: TransactionClient,
  routeId: string,
  orderId: string,
): Promise<boolean> {
  const found = await tx.orderPlacement.count({
    where: { orderId, releaseReason: 'ISSUED_TO_COURIER', issueSession: { routeId } },
  });
  return found > 0;
}

export interface CancelIssueInput {
  reason: string;
  /**
   * Курьер, которому передаются оставшиеся заказы.
   *
   * Необязателен: без него назначение маршрута не меняется. Указанный
   * применяется В ТОЙ ЖЕ транзакции — иначе между отменой и назначением
   * существовало бы окно, в котором маршрут с уже выданными заказами стоит
   * без курьера, и кладовщик не понимал бы, кого подтверждать.
   */
  nextCourierUserId?: string;
}

/**
 * Отмена сессии выдачи. Только администратор (`FUL-003`).
 *
 * История уже выданного не переписывается: выданные заказы остаются выданными.
 * Невыданные остаются физически размещёнными там, где лежат, — система не
 * двигает коробки молча.
 */
export async function cancelIssueSession(
  deps: FlowDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: CancelIssueInput,
  context: RequestContext,
): Promise<{
  routeId: string;
  cancelled: boolean;
  issued: number;
  courierUserId: string | null;
}> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'cancel reason is required',
      publicMessage: 'Укажите причину отмены выдачи: от 3 до 500 символов.',
    });
  }

  return deps.db.$transaction(async (tx: TransactionClient) => {
    const route = await lockRoute(tx, routeId);

    const session = await tx.routeIssueSession.findFirst({
      where: { routeId, state: 'OPEN' },
      select: { id: true },
    });
    if (session === null) {
      throw new AppError('CONFLICT', {
        message: 'no open issue session',
        publicMessage: 'Открытой выдачи по этому маршруту нет.',
        conflict: { kind: 'ISSUE_SESSION_REQUIRED', routeNumber: route.number },
      });
    }

    // Прогресс считается по маршруту: уже выданное отменой не отменяется.
    const { issued } = await routeIssueProgress(tx, routeId);

    await tx.routeIssueSession.update({
      where: { id: session.id },
      data: {
        state: 'CANCELLED',
        openKey: null,
        cancelledAt: new Date(),
        cancelledById: actor.userId,
        cancelReason: reason,
        version: { increment: 1 },
      },
    });

    // Смена курьера — часть ТОЙ ЖЕ транзакции. Проверка допустимости общая
    // с обычным назначением: недопустимый кандидат откатывает и отмену тоже,
    // поэтому частично отменённой выдачи без курьера не возникает.
    let courierUserId = route.courierUserId;
    if (input.nextCourierUserId !== undefined) {
      await assertCourierAssignable(tx, actor, input.nextCourierUserId);

      const updated = await tx.deliveryRoute.updateMany({
        where: { id: routeId, version: route.version },
        data: { courierUserId: input.nextCourierUserId, version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new AppError('CONFLICT', {
          message: 'stale route version',
          publicMessage: 'Маршрут изменён другим пользователем. Обновите экран и повторите.',
          conflict: { kind: 'STALE_VERSION', routeNumber: route.number },
        });
      }
      courierUserId = input.nextCourierUserId;

      await publishRealtimeEvent(tx, {
        topic: 'route.updated',
        payload: { routeId, state: route.state },
        audienceRoles: [...ROUTE_AUDIENCE],
      });
    }

    await writeAudit(tx, {
      action: 'WAREHOUSE_ISSUE_CANCELLED',
      entityType: 'RouteIssueSession',
      entityId: session.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      // Причина живёт в защищённой строке сессии; в аудите — только факт,
      // счётчик и признак смены курьера.
      newValue: { routeId, issued, courierChanged: input.nextCourierUserId !== undefined },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishRealtimeEvent(tx, {
      topic: 'warehouse.route_flow_changed',
      payload: { routeId, action: 'ISSUE_CANCELLED' },
      audienceRoles: [...FLOW_AUDIENCE],
    });

    return { routeId, cancelled: true, issued, courierUserId };
  });
}

/**
 * Пометка «требуется перемещение» для заказов маршрута.
 *
 * Вызывается из жизненного цикла маршрута при возврате в черновик и отмене.
 * Система не переносит коробки молча (`FUL-003`): она лишь помечает, что
 * заказ лежит в маршрутной ячейке маршрута, которого больше нет, и блокирует
 * его выдачу до штатного сканирования человеком.
 */
export async function markRoutePlacementsForRelocation(
  tx: TransactionClient,
  routeId: string,
): Promise<number> {
  const binding = await tx.routeCellBinding.findFirst({
    where: { routeId, releasedAt: null },
    select: { cellId: true },
  });
  if (binding === null) {
    return 0;
  }

  const participations = await tx.routeOrder.findMany({
    where: { routeId, removedAt: null },
    select: { orderId: true },
  });
  const orderIds = participations.map((row) => row.orderId);
  if (orderIds.length === 0) {
    return 0;
  }

  const marked = await tx.orderPlacement.updateMany({
    where: { orderId: { in: orderIds }, cellId: binding.cellId, releasedAt: null },
    data: { requiresRelocation: true },
  });

  return marked.count;
}
