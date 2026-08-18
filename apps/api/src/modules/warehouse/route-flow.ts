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
import { assemblyRoundOf, FLOW_AUDIENCE, type FlowDeps, type RequestContext } from './placement.js';
import { assertCourierAssignable } from '../routing/service.js';
import { releaseEmptyRouteBinding } from './route-cells.js';

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
/**
 * Привязка маршрутной ячейки ВНУТРИ уже открытой транзакции.
 *
 * Вынесено отдельно, потому что назначение ячейки бывает не самостоятельным
 * действием, а первой половиной одного шага: кладовщик сканирует свободную
 * полку и тут же кладёт в неё коробку. Две транзакции подряд оставили бы
 * промежуток, в котором лист уже занял полку, а заказ туда ещё не попал.
 */
export async function bindRouteCellWithin(
  tx: TransactionClient,
  actor: AuthenticatedActor,
  route: { id: string; number: string },
  cellCode: string,
  context: RequestContext,
): Promise<{ cellId: string; cellCode: string; unchanged: boolean }> {
  const { normalizedCode } = normalizeCellCode(cellCode);

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

  /*
   * Вторая ячейка листа — это норма, а не ошибка.
   *
   * Полтора десятка коробок на одну полку не помещаются. Запрещено другое:
   * отдать ту же полку второму листу — на ней встретились бы коробки двух
   * курьеров. Это держит частичный уникальный индекс по ячейке.
   *
   * Повтор той же ячейки идемпотентен: кладовщик мог отсканировать её
   * дважды, и вторая привязка означала бы, что освобождать полку придётся
   * столько же раз.
   */
  const existing = await tx.routeCellBinding.findFirst({
    where: { routeId: route.id, cellId: cell.id, releasedAt: null },
    select: { id: true },
  });
  if (existing !== null) {
    return { cellId: cell.id, cellCode: cell.code, unchanged: true };
  }

  const foreign = await tx.routeCellBinding.findFirst({
    where: { cellId: cell.id, releasedAt: null },
    select: { route: { select: { number: true } } },
  });
  if (foreign !== null) {
    // Ту же причину поймал бы уникальный индекс, но названная заранее
    // она объясняет кладовщику, куда делась полка.
    throw new AppError('CONFLICT', {
      message: 'cell belongs to another route',
      publicMessage: `Ячейка занята маршрутным листом ${foreign.route.number}.`,
      conflict: { kind: 'ROUTE_CELL_ALREADY_BOUND', routeNumber: foreign.route.number },
    });
  }

  const created = await tx.routeCellBinding.create({
    data: {
      routeId: route.id,
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
    newValue: { routeId: route.id, cellId: cell.id },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  await publishRealtimeEvent(tx, {
    topic: 'warehouse.route_flow_changed',
    payload: { routeId: route.id, cellId: cell.id, action: 'CELL_BOUND' },
    audienceRoles: [...FLOW_AUDIENCE],
  });

  return { cellId: cell.id, cellCode: cell.code, unchanged: false };
}

export async function bindRouteCell(
  deps: FlowDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: BindCellInput,
  context: RequestContext,
): Promise<BindCellResult> {
  try {
    return await deps.db.$transaction(async (tx: TransactionClient) => {
      const route = await lockRoute(tx, routeId);
      requireConfirmed(route);

      const bound = await bindRouteCellWithin(tx, actor, route, input.cellCode, context);
      return { routeId, ...bound };
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
  /**
   * Разрешить назначить отсканированную свободную полку этому листу.
   *
   * Нужно там, где кладовщик собирает лист по факту: он сканирует коробку
   * и свободную полку, а не ходит сначала в настройки листа. Назначение
   * и размещение происходят одной транзакцией — иначе остаётся промежуток,
   * в котором полка уже занята листом, а коробка ещё нет.
   */
  bindIfFree?: boolean | undefined;
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

    /*
     * Годится ЛЮБАЯ действующая ячейка этого листа.
     *
     * Ячеек у листа может быть несколько, и требовать одну конкретную
     * значило бы заставлять кладовщика помнить, какую полку он занял первой.
     * Чужая ячейка при этом по-прежнему не принимается.
     */
    const bindings = await tx.routeCellBinding.findMany({
      where: { routeId, releasedAt: null },
      select: { cellId: true, cell: { select: { code: true } } },
    });
    if (bindings.length === 0 && input.bindIfFree !== true) {
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
    const bound = cell === null ? undefined : bindings.find((item) => item.cellId === cell.id);
    if (bound === undefined) {
      if (input.bindIfFree === true) {
        // Свободная маршрутная полка становится ещё одной ячейкой листа
        // прямо здесь: следом, в этой же транзакции, в неё ляжет коробка.
        await bindRouteCellWithin(tx, actor, route, input.cellCode, context);
      } else {
        const expected = bindings.map((item) => item.cell.code).join(', ');
        throw new AppError('CONFLICT', {
          message: 'scanned cell is not a route cell of this route',
          publicMessage: `Отсканирована не та ячейка. У этого листа: ${expected}.`,
          conflict: { kind: 'ROUTE_CELL_MISMATCH', routeNumber: route.number },
        });
      }
    }
    if (cell === null) {
      throw new AppError('NOT_FOUND', {
        message: 'storage cell not found',
        publicMessage: 'Ячейка с таким кодом не найдена.',
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
        publicMessage: blocked.includes('CANCELLED')
          ? 'Заказ отменён — не выдавать. Комплектование недоступно.'
          : 'Заказ помечен как проблемный: комплектование недоступно.',
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

    const rows = await tx.$queryRaw<{ id: string; cellId: string; assemblyRound: number }[]>`
      SELECT "id", "cellId", "assemblyRound" FROM "OrderPlacement"
      WHERE "orderId" = ${order.id}::uuid AND "releasedAt" IS NULL FOR UPDATE
    `;
    const current = rows[0] ?? null;

    /*
     * Коробки на складе ещё нет — и это законный случай.
     *
     * Кладовщик держит её в руках прямо сейчас: заказ приехал от флориста
     * и сразу отправляется на полку своего листа. Требовать промежуточной
     * приёмки в хранение значило бы заставить человека положить коробку
     * на случайную полку только затем, чтобы через секунду её оттуда взять.
     *
     * История при этом честная: такое размещение записывается как приёмка
     * (`RECEIVED`), а не как перемещение из ниоткуда.
     */
    if (current === null) {
      const round = await assemblyRoundOf(tx, order.id);
      await tx.orderPlacement.create({
        data: {
          orderId: order.id,
          cellId: cell.id,
          source: 'RECEIVED',
          placedAt: new Date(),
          placedById: actor.userId,
          assemblyRound: round,
        },
      });

      await writeAudit(tx, {
        action: 'WAREHOUSE_ORDER_PICKED',
        entityType: 'OrderPlacement',
        entityId: order.id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        source: 'api',
        oldValue: null,
        newValue: { routeId, cellId: cell.id, received: true },
        ip: context.ip,
        userAgent: context.userAgent,
      });

      await publishRealtimeEvent(tx, {
        topic: 'warehouse.route_flow_changed',
        payload: { routeId, orderId: order.id, action: 'PICKED' },
        audienceRoles: [...FLOW_AUDIENCE],
      });
      // Приёмка видна и тем, кто смотрит складской список, а не лист.
      await publishRealtimeEvent(tx, {
        topic: 'warehouse.placement_changed',
        payload: { orderId: order.id, cellId: cell.id, action: 'RECEIVED' },
        audienceRoles: [...FLOW_AUDIENCE],
      });

      const progress = await pickProgress(tx, routeId);
      return {
        routeId,
        orderId: order.id,
        orderNumber: order.number,
        cellId: cell.id,
        cellCode: cell.code,
        unchanged: false,
        ...progress,
      };
    }

    if (current.cellId === cell.id) {
      const progress = await pickProgress(tx, routeId);
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
        // Перемещение не меняет круг: это тот же самый букет.
        assemblyRound: current.assemblyRound,
      },
    });

    // Полка, с которой унесли коробку, могла опустеть. Если это была
    // маршрутная ячейка, лист её отпускает — иначе она осталась бы занятой
    // листом, у которого на ней ничего нет.
    await releaseEmptyRouteBinding(tx, actor, current.cellId, now);

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

    const progress = await pickProgress(tx, routeId);
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

/**
 * Сколько заказов листа уже стоит в ЕГО маршрутных ячейках.
 *
 * Считается по всем действующим ячейкам листа сразу: коробки одного листа
 * могут лежать на двух полках, и прогресс «по одной полке» показывал бы
 * половину собранного как несобранное.
 */
async function pickProgress(
  tx: TransactionClient,
  routeId: string,
): Promise<{ picked: number; total: number }> {
  const participations = await tx.routeOrder.findMany({
    where: { routeId, removedAt: null },
    select: { orderId: true },
  });
  const orderIds = participations.map((row) => row.orderId);

  const bindings = await tx.routeCellBinding.findMany({
    where: { routeId, releasedAt: null },
    select: { cellId: true },
  });
  const cellIds = bindings.map((row) => row.cellId);

  const picked =
    orderIds.length === 0 || cellIds.length === 0
      ? 0
      : await tx.orderPlacement.count({
          where: { orderId: { in: orderIds }, cellId: { in: cellIds }, releasedAt: null },
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
  /*
   * Логист и КУРЬЕР обязаны увидеть, что маршрут уехал.
   *
   * Курьер здесь — не вежливость: до отгрузки листа у него в «Доставках»
   * пусто, и без события он открывал бы приложение заново, уже сидя в машине.
   * В полезной нагрузке только идентификатор и состояние — ни адресов,
   * ни получателей, ни телефонов.
   */
  await publishRealtimeEvent(tx, {
    topic: 'route.updated',
    payload: { routeId: route.id, state: 'ACTIVE' },
    audienceRoles: [...ROUTE_AUDIENCE, 'COURIER'],
  });
}

/**
 * Передача одной коробки курьеру ВНУТРИ уже открытой транзакции.
 *
 * Вынесено отдельно ровно затем, чтобы поштучная выдача и общая отгрузка
 * листа выполняли одно и то же действие. Второй реализацией они разошлись бы
 * в мелочах — и «выдано» на экране означало бы разное в зависимости от того,
 * каким путём коробка уехала.
 */
async function releasePlacementToCourier(
  tx: TransactionClient,
  actor: AuthenticatedActor,
  context: RequestContext,
  input: {
    placement: { id: string; cellId: string };
    routeId: string;
    orderId: string;
    sessionId: string;
    now: Date;
  },
): Promise<void> {
  await tx.orderPlacement.update({
    where: { id: input.placement.id },
    data: {
      releasedAt: input.now,
      releasedById: actor.userId,
      releaseReason: 'ISSUED_TO_COURIER',
      issueSessionId: input.sessionId,
    },
  });

  await writeAudit(tx, {
    action: 'WAREHOUSE_ORDER_ISSUED',
    entityType: 'OrderPlacement',
    entityId: input.placement.id,
    actorUserId: actor.userId,
    actorRoles: actor.roles,
    source: 'api',
    oldValue: { cellId: input.placement.cellId },
    newValue: { routeId: input.routeId, orderId: input.orderId, sessionId: input.sessionId },
    ip: context.ip,
    userAgent: context.userAgent,
  });
}

/*
 * Поштучной выдачи как ОПЕРАЦИИ больше нет.
 *
 * Пока она существовала, лист можно было отдать курьеру по частям, обойдя
 * повторную проверку состава: половина коробок уезжала, половина оставалась
 * на полке, и лист при этом считался отгруженным. Физическая передача
 * происходит только целиком — `shipRoute`, — а её внутренний шаг
 * `releasePlacementToCourier` остаётся переиспользуемым и наружу не выходит.
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
  const bindings = await tx.routeCellBinding.findMany({
    where: { routeId, releasedAt: null },
    select: { cellId: true },
  });
  if (bindings.length === 0) {
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

  // Пометку получают коробки во ВСЕХ маршрутных ячейках листа: полок может
  // быть несколько, и оставленная без пометки вторая полка уехала бы
  // с курьером как собранная.
  const marked = await tx.orderPlacement.updateMany({
    where: {
      orderId: { in: orderIds },
      cellId: { in: bindings.map((row) => row.cellId) },
      releasedAt: null,
    },
    data: { requiresRelocation: true },
  });

  return marked.count;
}

// --- Проверка перед отгрузкой ------------------------------------------------

export interface IssueCheckResult {
  routeId: string;
  orderId: string;
  orderNumber: string;
  /** Отметка уже стояла: повторный или конкурентный скан. */
  unchanged: boolean;
  checked: number;
  total: number;
}

/**
 * Прогресс проверки перед отгрузкой.
 *
 * Считается по ДЕЙСТВУЮЩИМ отметкам открытой сессии и действующему составу
 * листа: заказ, выведенный из маршрута после проверки, перестаёт считаться
 * внесённым, а не остаётся числом в счётчике.
 */
export async function issueCheckProgress(
  tx: TransactionClient,
  routeId: string,
  sessionId: string | null,
): Promise<{ checked: number; total: number; checkedOrderIds: Set<string> }> {
  const participations = await tx.routeOrder.findMany({
    where: { routeId, removedAt: null },
    select: { orderId: true },
  });
  const orderIds = participations.map((row) => row.orderId);

  if (sessionId === null || orderIds.length === 0) {
    return { checked: 0, total: orderIds.length, checkedOrderIds: new Set() };
  }

  const marks = await tx.routeIssueCheck.findMany({
    where: { sessionId, clearedAt: null, orderId: { in: orderIds } },
    select: { orderId: true },
  });
  const checkedOrderIds = new Set(marks.map((row) => row.orderId));

  return { checked: checkedOrderIds.size, total: orderIds.length, checkedOrderIds };
}

/**
 * Внесение одного заказа в лист перед отгрузкой.
 *
 * Скан НИЧЕГО не выдаёт: размещение остаётся действующим, коробка стоит
 * в ячейке. Это и есть смысл проверки — кладовщик собирает лист целиком
 * и только после последней коробки происходит одна общая выдача. До неё
 * можно уйти, сбросить проверку или обнаружить изменившийся состав,
 * не выдав ни одного заказа.
 */
export async function checkOrderForIssue(
  deps: FlowDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: { orderNumber: string },
  context: RequestContext,
): Promise<IssueCheckResult> {
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
        publicMessage: blocked.includes('CANCELLED')
          ? 'Заказ отменён — не выдавать.'
          : 'Заказ помечен как проблемный: выдача недоступна.',
        conflict: { kind: 'ORDER_BLOCKED', orderIds: [order.id] },
      });
    }

    await assertReadyForIssue(tx, routeId, order.id, route.number);

    /*
     * Отметка вставляется с пропуском дубликата.
     *
     * Два кладовщика могут отсканировать одну коробку одновременно, и
     * «сначала найти, потом вставить» такую гонку не ловит: параллельные
     * транзакции не видят чужих незафиксированных вставок. Уникальный
     * индекс ловит, и повтор становится обычным «уже внесено».
     */
    const inserted = await tx.routeIssueCheck.createMany({
      data: [{ sessionId: session.id, orderId: order.id, checkedById: actor.userId }],
      skipDuplicates: true,
    });
    const unchanged = inserted.count === 0;

    const progress = await issueCheckProgress(tx, routeId, session.id);

    if (!unchanged) {
      await writeAudit(tx, {
        action: 'WAREHOUSE_ISSUE_CHECKED',
        entityType: 'RouteIssueSession',
        entityId: session.id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        source: 'api',
        newValue: { routeId, orderId: order.id, checked: progress.checked },
        ip: context.ip,
        userAgent: context.userAgent,
      });

      await publishRealtimeEvent(tx, {
        topic: 'warehouse.route_flow_changed',
        payload: { routeId, orderId: order.id, action: 'ISSUE_CHECKED' },
        audienceRoles: [...FLOW_AUDIENCE],
      });
    }

    return {
      routeId,
      orderId: order.id,
      orderNumber: order.number,
      unchanged,
      checked: progress.checked,
      total: progress.total,
    };
  });
}

/**
 * Сброс проверки.
 *
 * Очищается ТОЛЬКО прогресс: маршрут, размещения и соседние листы остаются
 * как были. Отметки при этом не исчезают — они закрываются, и что именно
 * вносили до сброса, видно и потом.
 */
export async function resetIssueChecks(
  deps: FlowDeps,
  actor: AuthenticatedActor,
  routeId: string,
  context: RequestContext,
): Promise<{ routeId: string; cleared: number; checked: number; total: number }> {
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

    const now = new Date();
    const cleared = await tx.routeIssueCheck.updateMany({
      where: { sessionId: session.id, clearedAt: null },
      data: { clearedAt: now, clearedById: actor.userId },
    });

    if (cleared.count > 0) {
      await writeAudit(tx, {
        action: 'WAREHOUSE_ISSUE_CHECKS_RESET',
        entityType: 'RouteIssueSession',
        entityId: session.id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        source: 'api',
        newValue: { routeId, cleared: cleared.count },
        ip: context.ip,
        userAgent: context.userAgent,
      });

      await publishRealtimeEvent(tx, {
        topic: 'warehouse.route_flow_changed',
        payload: { routeId, action: 'ISSUE_CHECKS_RESET' },
        audienceRoles: [...FLOW_AUDIENCE],
      });
    }

    const progress = await issueCheckProgress(tx, routeId, session.id);
    return { routeId, cleared: cleared.count, checked: progress.checked, total: progress.total };
  });
}

export interface ShipRouteResult {
  routeId: string;
  routeNumber: string;
  issued: number;
  /** Лист уже был отгружен: повтор финального запроса ничего не выдал. */
  unchanged: boolean;
}

/**
 * Отгрузка ОДНОГО листа целиком одной транзакцией.
 *
 * Проверки повторяются здесь заново и под блокировкой строки маршрута.
 * Между первым сканом и нажатием кнопки состав листа мог измениться, заказ
 * мог быть отменён, курьер — заменён, а коробка — переставлена. Доверять
 * накопленному прогрессу как разрешению нельзя: он говорит, что кладовщик
 * видел коробки, а не что маршрут по-прежнему годен.
 *
 * Или выдаётся всё, или не выдаётся ничего: частично отгруженный лист
 * означает коробки, разъехавшиеся по двум машинам.
 */
export async function shipRoute(
  deps: FlowDeps,
  actor: AuthenticatedActor,
  routeId: string,
  context: RequestContext,
): Promise<ShipRouteResult> {
  return deps.db.$transaction(async (tx: TransactionClient) => {
    const route = await lockRoute(tx, routeId);

    if (route.state === 'ACTIVE') {
      /*
       * Повтор финального запроса.
       *
       * Кнопка могла быть нажата дважды или ответ потерян по дороге. Лист
       * уже уехал — это успех, а не ошибка, и второй выдачи не происходит.
       */
      const issued = await routeIssueProgress(tx, routeId);
      return {
        routeId,
        routeNumber: route.number,
        issued: issued.issued,
        unchanged: true,
      };
    }

    requireConfirmed(route);

    const session = await tx.routeIssueSession.findFirst({
      where: { routeId, state: 'OPEN' },
      select: { id: true, courierUserId: true },
    });
    if (session === null) {
      throw new AppError('CONFLICT', {
        message: 'issue session is not open',
        publicMessage: 'Сначала подтвердите назначенного курьера.',
        conflict: { kind: 'ISSUE_SESSION_REQUIRED', routeNumber: route.number },
      });
    }

    // Курьер листа мог смениться после подтверждения: коробки уехали бы
    // не тому человеку.
    const courier = await tx.deliveryRoute.findUniqueOrThrow({
      where: { id: routeId },
      select: { courierUserId: true },
    });
    if (courier.courierUserId === null || courier.courierUserId !== session.courierUserId) {
      throw new AppError('CONFLICT', {
        message: 'issue session courier differs from route courier',
        publicMessage: 'Курьер маршрута изменился. Подтвердите курьера заново.',
        conflict: { kind: 'ISSUE_SESSION_REQUIRED', routeNumber: route.number },
      });
    }
    /*
     * Курьер обязан быть действующим и сейчас.
     *
     * Между подтверждением и отгрузкой его могли заморозить: коробки
     * уехали бы человеку, которому вход в систему уже закрыт.
     */
    await assertCourierAssignable(tx, actor, courier.courierUserId);

    const participations = await tx.routeOrder.findMany({
      where: { routeId, removedAt: null },
      select: { orderId: true, order: { select: { externalName: true } } },
      orderBy: { position: 'asc' },
    });
    if (participations.length === 0) {
      throw new AppError('CONFLICT', {
        message: 'route has no active orders',
        publicMessage: 'В маршрутном листе нет заказов.',
        conflict: { kind: 'ROUTE_EMPTY', routeNumber: route.number },
      });
    }

    const progress = await issueCheckProgress(tx, routeId, session.id);
    const now = new Date();

    for (const participation of participations) {
      if (!progress.checkedOrderIds.has(participation.orderId)) {
        throw new AppError('CONFLICT', {
          message: 'order is not checked',
          publicMessage: `Заказ ${participation.order.externalName} ещё не внесён в лист.`,
          conflict: { kind: 'ORDER_NOT_CHECKED', orderIds: [participation.orderId] },
        });
      }

      const order = await tx.deliveryOrder.findUniqueOrThrow({
        where: { id: participation.orderId },
        select: {
          id: true,
          externalName: true,
          inScope: true,
          sourceArchived: true,
          sourceMissing: true,
          needsAttention: true,
          cancelledInSource: true,
          cancelledByLogistAt: true,
        },
      });
      const blocked = blockingFlags({ ...order, number: order.externalName, deliveryDate: null });
      if (blocked.length > 0) {
        throw new AppError('CONFLICT', {
          message: `order is blocked: ${blocked.join(',')}`,
          publicMessage: blocked.includes('CANCELLED')
            ? `Заказ ${order.externalName} отменён — не выдавать.`
            : `Заказ ${order.externalName} помечен как проблемный: выдача недоступна.`,
          conflict: { kind: 'ORDER_BLOCKED', orderIds: [order.id] },
        });
      }

      const placement = await assertReadyForIssue(tx, routeId, order.id, route.number);

      await releasePlacementToCourier(tx, actor, context, {
        placement,
        routeId,
        orderId: order.id,
        sessionId: session.id,
        now,
      });
    }

    await activateRouteWithinTransaction(tx, route, actor, context, now, {
      issued: participations.length,
      orderId: null,
    });

    await tx.routeIssueSession.update({
      where: { id: session.id },
      data: { state: 'COMPLETED', openKey: null, completedAt: now, version: { increment: 1 } },
    });

    return {
      routeId,
      routeNumber: route.number,
      issued: participations.length,
      unchanged: false,
    };
  });
}

/**
 * Заказ готов к передаче курьеру: коробка стоит в ячейке ЭТОГО листа.
 *
 * Размещение берётся `FOR UPDATE`: между проверкой и выдачей его не должны
 * переставить. Чужая маршрутная ячейка готовностью не считается — это полка
 * другого курьера.
 */
async function assertReadyForIssue(
  tx: TransactionClient,
  routeId: string,
  orderId: string,
  routeNumber: string,
): Promise<{ id: string; cellId: string }> {
  await tx.$queryRaw`SELECT "id" FROM "DeliveryOrder" WHERE "id" = ${orderId}::uuid FOR UPDATE`;

  const rows = await tx.$queryRaw<{ id: string; cellId: string; requiresRelocation: boolean }[]>`
    SELECT "id", "cellId", "requiresRelocation" FROM "OrderPlacement"
    WHERE "orderId" = ${orderId}::uuid AND "releasedAt" IS NULL FOR UPDATE
  `;
  const placement = rows[0] ?? null;

  if (placement === null) {
    throw new AppError('CONFLICT', {
      message: 'order has no placement',
      publicMessage: 'Заказа нет на складе: выдать его нельзя.',
      conflict: { kind: 'ORDER_NOT_PLACED', orderIds: [orderId] },
    });
  }
  if (placement.requiresRelocation) {
    throw new AppError('CONFLICT', {
      message: 'placement requires relocation',
      publicMessage: 'Заказ требует перемещения: маршрут менялся после комплектования.',
      conflict: { kind: 'PLACEMENT_REQUIRES_RELOCATION', orderIds: [orderId] },
    });
  }

  const binding = await tx.routeCellBinding.findFirst({
    where: { routeId, cellId: placement.cellId, releasedAt: null },
    select: { id: true },
  });
  if (binding === null) {
    throw new AppError('CONFLICT', {
      message: 'order is not in a route cell of this route',
      publicMessage: 'Заказ не стоит в маршрутной ячейке этого листа.',
      conflict: { kind: 'PLACEMENT_REQUIRES_RELOCATION', routeNumber, orderIds: [orderId] },
    });
  }

  return { id: placement.id, cellId: placement.cellId };
}
