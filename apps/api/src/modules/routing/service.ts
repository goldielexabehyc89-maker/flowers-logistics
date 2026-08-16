/**
 * Ручные маршруты-черновики.
 *
 * Ветка 4.1: маршрут создаётся только человеком, только как черновик и только
 * на одну календарную дату. Подтверждение, отмена и возврат в черновик появятся
 * в 4.2 — здесь любая мутация требует состояния `DRAFT`, даже если перечисление
 * уже содержит будущие значения.
 *
 * ПОРЯДОК БЛОКИРОВОК (пользовательские операции):
 *   DeliveryRoute (FOR UPDATE, все затронутые, ORDER BY id)
 *   → RouteEditLease (FOR UPDATE, по routeId в том же порядке)
 *   → DeliveryOrder (FOR UPDATE, ORDER BY id)
 *   → активные RouteOrder
 *   → RouteOrderConflict
 *   → RouteStateTransition
 *   → AuditLog
 *   → RealtimeEvent
 *
 * Сортировка по UUID обязательна: два встречных перемещения между одними и теми же
 * маршрутами при произвольном порядке дают взаимную блокировку. Синхронизация
 * МоегоСклада использует другой поток — она начинает с `DeliveryOrder` и НЕ берёт
 * блокировку маршрута, чтобы не появился обратный порядок (см. `import-service.ts`).
 *
 * Внешних запросов внутри транзакции нет.
 */

import { Prisma, type $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { isPlainCourier, type Role } from '@fl/shared';
import { readRoleAssignment } from '../../platform/role-assignments.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit, type AuditAction } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { isCalendarDate, toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { calendarDate, ineligibleReason, INELIGIBLE_MESSAGES } from './eligibility.js';
import { nextRouteNumber } from './numbering.js';
import { grantLease, requireLease } from './lease.js';
import { assertIssueNotStarted } from '../warehouse/issue-guard.js';
import { confirmWithinTransaction } from './lifecycle.js';

/** Кому адресованы события маршрутов. Курьеру глобальная картина не нужна. */
const ROUTE_AUDIENCE: readonly Role[] = ['ADMIN', 'LOGISTICIAN'];

/**
 * Временное смещение позиций при перестановке.
 *
 * Частичный уникальный индекс проверяется построчно, поэтому поменять две позиции
 * местами одним запросом невозможно. Сначала все активные позиции маршрута уходят
 * за пределы рабочего диапазона, затем записываются целевые значения.
 */
const POSITION_SHIFT = 1_000_000;

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

/** Часы вынесены в зависимости: проверки истечения аренды не должны ждать реального времени. */
export interface RoutingDeps {
  db: Database;
  now?: () => Date;
}

const clockOf = (deps: RoutingDeps): (() => Date) => deps.now ?? (() => new Date());

interface LockedRoute {
  id: string;
  number: string;
  deliveryDate: Date;
  state: $Enums.RouteState;
  version: number;
  courierUserId: string | null;
}

interface LockedOrder {
  id: string;
  deliveryDate: Date | null;
  inScope: boolean;
  sourceArchived: boolean;
  sourceMissing: boolean;
}

interface ActiveParticipation {
  id: string;
  routeId: string;
  orderId: string;
  position: number;
}

// --- Блокировки -------------------------------------------------------------

/** Блокирует маршруты в порядке возрастания UUID. */
async function lockRoutes(tx: TransactionClient, ids: readonly string[]): Promise<LockedRoute[]> {
  if (ids.length === 0) {
    return [];
  }
  const list = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
  return tx.$queryRaw<LockedRoute[]>`
    SELECT "id", "number", "deliveryDate", "state", "version", "courierUserId"
    FROM "DeliveryRoute"
    WHERE "id" IN (${list})
    ORDER BY "id"
    FOR UPDATE
  `;
}

/** Блокирует заказы в порядке возрастания UUID. */
async function lockOrders(tx: TransactionClient, ids: readonly string[]): Promise<LockedOrder[]> {
  if (ids.length === 0) {
    return [];
  }
  const list = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
  return tx.$queryRaw<LockedOrder[]>`
    SELECT "id", "deliveryDate", "inScope", "sourceArchived", "sourceMissing"
    FROM "DeliveryOrder"
    WHERE "id" IN (${list})
    ORDER BY "id"
    FOR UPDATE
  `;
}

// --- Общие проверки ---------------------------------------------------------

function requireRoute(routes: readonly LockedRoute[], id: string): LockedRoute {
  const route = routes.find((candidate) => candidate.id === id);
  if (route === undefined) {
    throw new AppError('NOT_FOUND', { message: 'route not found' });
  }
  return route;
}

/** Мутации допустимы только для черновика. */
function requireDraft(route: LockedRoute): void {
  if (route.state !== 'DRAFT') {
    throw new AppError('CONFLICT', {
      message: 'route is not a draft',
      publicMessage: 'Маршрут больше не черновик: изменения недоступны.',
      conflict: { kind: 'ROUTE_NOT_DRAFT' },
    });
  }
}

function requireVersion(route: LockedRoute, expected: number): void {
  if (route.version !== expected) {
    throw new AppError('CONFLICT', {
      message: 'stale route version',
      publicMessage: 'Маршрут изменён другим пользователем. Обновите страницу и повторите.',
      conflict: { kind: 'STALE_VERSION' },
    });
  }
}

/** Увеличивает версию маршрута ровно один раз за логическую операцию. */
async function bumpVersion(
  tx: TransactionClient,
  routeId: string,
  expected: number,
): Promise<void> {
  const updated = await tx.deliveryRoute.updateMany({
    where: { id: routeId, version: expected },
    data: { version: { increment: 1 } },
  });
  if (updated.count === 0) {
    throw new AppError('CONFLICT', {
      message: 'stale route version',
      publicMessage: 'Маршрут изменён другим пользователем. Обновите страницу и повторите.',
      conflict: { kind: 'STALE_VERSION' },
    });
  }
}

/** Активные участия маршрута в текущем порядке. */
async function activeParticipations(
  tx: TransactionClient,
  routeId: string,
): Promise<ActiveParticipation[]> {
  return tx.routeOrder.findMany({
    where: { routeId, removedAt: null },
    // Порядок доопределён идентификатором: одинаковых позиций быть не может,
    // но устойчивость важна и при чтении.
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: { id: true, routeId: true, orderId: true, position: true },
  });
}

/**
 * Записывает позиции 1..N в указанном порядке.
 *
 * Два прохода: сначала сдвиг за рабочий диапазон, затем целевые значения.
 * Иначе построчная проверка уникального индекса отвергнет любую перестановку.
 */
async function renumber(
  tx: TransactionClient,
  routeId: string,
  orderedIds: readonly string[],
): Promise<void> {
  if (orderedIds.length === 0) {
    return;
  }

  await tx.routeOrder.updateMany({
    where: { routeId, removedAt: null },
    data: { position: { increment: POSITION_SHIFT } },
  });

  for (const [index, id] of orderedIds.entries()) {
    await tx.routeOrder.update({ where: { id }, data: { position: index + 1 } });
  }
}

/** Определяет, не занят ли какой-то из заказов другим активным маршрутом. */
async function assertOrdersAreFree(
  tx: TransactionClient,
  orderIds: readonly string[],
): Promise<void> {
  const taken = await tx.routeOrder.findFirst({
    where: { orderId: { in: [...orderIds] }, removedAt: null },
    select: { orderId: true, route: { select: { number: true } } },
  });

  if (taken !== null) {
    throw new AppError('CONFLICT', {
      message: 'order already assigned',
      publicMessage: `Заказ уже находится в маршруте ${taken.route.number}.`,
      conflict: {
        kind: 'ORDER_ALREADY_IN_ROUTE',
        routeNumber: taken.route.number,
        orderIds: [taken.orderId],
      },
    });
  }
}

/** Проверяет пригодность заказов для маршрута указанной даты. */
function assertEligible(orders: readonly LockedOrder[], routeDate: string): void {
  const rejected: { orderId: string; reason: string }[] = [];

  for (const order of orders) {
    const reason = ineligibleReason(order, routeDate);
    if (reason !== null) {
      rejected.push({ orderId: order.id, reason: INELIGIBLE_MESSAGES[reason] });
    }
  }

  if (rejected.length > 0) {
    throw new AppError('CONFLICT', {
      message: 'order is not eligible',
      publicMessage: `Заказ нельзя добавить в маршрут: ${rejected[0]?.reason ?? ''}.`,
      conflict: {
        kind: 'ORDER_NOT_ELIGIBLE',
        orderIds: rejected.map((item) => item.orderId),
      },
    });
  }
}

/** Все запрошенные заказы обязаны существовать. */
function assertAllFound(orders: readonly LockedOrder[], requested: readonly string[]): void {
  if (orders.length !== requested.length) {
    throw new AppError('NOT_FOUND', { message: 'order not found' });
  }
}

/**
 * Ошибка уникальности активного участия.
 *
 * Возникает, когда два запроса одновременно прошли проверку и оба дошли до вставки:
 * выигрывает один, второй получает нарушение частичного уникального индекса.
 * Транзакция к этому моменту уже прервана, поэтому номер победителя читается
 * отдельным запросом после её отката.
 */
function isActiveParticipationConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    JSON.stringify(error.meta ?? {}).includes('RouteOrder_active_order_unique')
  );
}

async function conflictForOrders(db: Database, orderIds: readonly string[]): Promise<never> {
  const taken = await db.routeOrder.findFirst({
    where: { orderId: { in: [...orderIds] }, removedAt: null },
    select: { orderId: true, route: { select: { number: true } } },
  });

  throw new AppError('CONFLICT', {
    message: 'order already assigned',
    publicMessage:
      taken === null
        ? 'Заказ уже распределён другим пользователем. Обновите страницу.'
        : `Заказ уже находится в маршруте ${taken.route.number}.`,
    conflict: {
      kind: 'ORDER_ALREADY_IN_ROUTE',
      ...(taken === null ? {} : { routeNumber: taken.route.number, orderIds: [taken.orderId] }),
    },
  });
}

// --- Аудит и события --------------------------------------------------------

async function auditRoute(
  tx: TransactionClient,
  action: AuditAction,
  routeId: string,
  actor: AuthenticatedActor,
  context: RequestContext,
  value: Record<string, unknown>,
): Promise<void> {
  await writeAudit(tx, {
    action,
    entityType: 'DeliveryRoute',
    entityId: routeId,
    actorUserId: actor.userId,
    actorRoles: actor.roles,
    source: 'api',
    // Только идентификаторы, позиции, транспорт и состояния: адресов, получателей,
    // комментариев и денег в аудите маршрута нет.
    newValue: value,
    ip: context.ip,
    userAgent: context.userAgent,
  });
}

async function publishRoute(
  tx: TransactionClient,
  topic: 'route.created' | 'route.updated',
  routeId: string,
  orderIds: readonly string[],
): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic,
    // Номера маршрута в событии нет намеренно: клиент перезапрашивает данные,
    // а широковещательный канал остаётся без бизнес-содержимого.
    payload: { routeId, ...(orderIds.length === 0 ? {} : { orderIds: [...orderIds] }) },
    audienceRoles: [...ROUTE_AUDIENCE],
  });
}

// --- Операции ---------------------------------------------------------------

export interface CreateDraftInput {
  deliveryDate: string;
  vehicleType: $Enums.VehicleType;
}

export async function createDraft(
  deps: RoutingDeps,
  actor: AuthenticatedActor,
  input: CreateDraftInput,
  context: RequestContext,
): Promise<{ id: string; number: string; version: number }> {
  // Проверка повторяется на сервисном слое намеренно: корректность даты не должна
  // зависеть только от HTTP-схемы. Отказ происходит ДО транзакции, поэтому
  // ни маршрут, ни счётчик номеров, ни аудит, ни событие не создаются.
  if (!isCalendarDate(input.deliveryDate)) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'invalid calendar date',
      publicMessage: 'Указана несуществующая дата доставки.',
    });
  }

  return deps.db.$transaction(async (tx) => {
    const number = await nextRouteNumber(tx, input.deliveryDate);

    const route = await tx.deliveryRoute.create({
      data: {
        number,
        deliveryDate: toDateColumn(input.deliveryDate),
        vehicleType: input.vehicleType,
        createdById: actor.userId,
      },
      select: { id: true, number: true, version: true },
    });

    // Создатель сразу получает маршрут в работу: иначе между созданием и первым
    // добавлением заказа его успел бы занять другой редактор.
    await grantLease(tx, route.id, actor, clockOf(deps)());

    await auditRoute(tx, 'ROUTE_CREATED', route.id, actor, context, {
      number: route.number,
      deliveryDate: input.deliveryDate,
      vehicleType: input.vehicleType,
      state: 'DRAFT',
    });
    await publishRoute(tx, 'route.created', route.id, []);

    return route;
  });
}

export interface OrdersInput {
  orderIds: string[];
  expectedVersion: number;
}

export async function addOrders(
  deps: RoutingDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: OrdersInput,
  context: RequestContext,
): Promise<{ version: number; positions: { orderId: string; position: number }[] }> {
  const orderIds = unique(input.orderIds);

  try {
    return await deps.db.$transaction(async (tx) => {
      const route = requireRoute(await lockRoutes(tx, [routeId]), routeId);
      requireDraft(route);
      requireVersion(route, input.expectedVersion);
      await requireLease(tx, routeId, actor, clockOf(deps)());

      const orders = await lockOrders(tx, orderIds);
      assertAllFound(orders, orderIds);
      assertEligible(orders, calendarDate(route.deliveryDate));
      await assertOrdersAreFree(tx, orderIds);

      const existing = await activeParticipations(tx, routeId);
      let position = existing.length;
      for (const orderId of orderIds) {
        position += 1;
        await tx.routeOrder.create({
          data: { routeId, orderId, position, addedById: actor.userId },
        });
      }

      const ordered = await activeParticipations(tx, routeId);
      await renumber(
        tx,
        routeId,
        ordered.map((item) => item.id),
      );
      await bumpVersion(tx, routeId, input.expectedVersion);

      await auditRoute(tx, 'ROUTE_ORDERS_ADDED', routeId, actor, context, {
        orderIds,
        totalOrders: ordered.length,
      });
      await publishRoute(tx, 'route.updated', routeId, orderIds);

      return {
        version: input.expectedVersion + 1,
        positions: (await activeParticipations(tx, routeId)).map((item) => ({
          orderId: item.orderId,
          position: item.position,
        })),
      };
    });
  } catch (error) {
    if (isActiveParticipationConflict(error)) {
      return conflictForOrders(deps.db, orderIds);
    }
    throw error;
  }
}

export async function returnOrders(
  deps: RoutingDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: OrdersInput,
  context: RequestContext,
): Promise<{ version: number }> {
  const orderIds = unique(input.orderIds);

  return deps.db.$transaction(async (tx) => {
    const route = requireRoute(await lockRoutes(tx, [routeId]), routeId);
    requireDraft(route);
    requireVersion(route, input.expectedVersion);
    await requireLease(tx, routeId, actor, clockOf(deps)());

    await lockOrders(tx, orderIds);
    const participations = await activeParticipations(tx, routeId);
    const target = participations.filter((item) => orderIds.includes(item.orderId));

    if (target.length !== orderIds.length) {
      throw new AppError('CONFLICT', {
        message: 'order is not in this route',
        publicMessage: 'Заказ уже не состоит в этом маршруте. Обновите страницу.',
        conflict: { kind: 'ROUTE_ORDER_SET_MISMATCH', orderIds },
      });
    }

    const now = clockOf(deps)();
    for (const item of target) {
      await tx.routeOrder.update({
        where: { id: item.id },
        data: {
          removedAt: now,
          removedById: actor.userId,
          removalReason: 'RETURNED_TO_UNASSIGNED',
        },
      });
    }

    const remaining = participations.filter((item) => !orderIds.includes(item.orderId));
    await renumber(
      tx,
      routeId,
      remaining.map((item) => item.id),
    );
    await bumpVersion(tx, routeId, input.expectedVersion);

    await auditRoute(tx, 'ROUTE_ORDERS_RETURNED', routeId, actor, context, {
      orderIds,
      totalOrders: remaining.length,
    });
    await publishRoute(tx, 'route.updated', routeId, orderIds);

    return { version: input.expectedVersion + 1 };
  });
}

export interface MoveInput {
  fromRouteId: string;
  toRouteId: string;
  orderIds: string[];
  expectedSourceVersion: number;
  expectedTargetVersion: number;
}

export async function moveOrders(
  deps: RoutingDeps,
  actor: AuthenticatedActor,
  input: MoveInput,
  context: RequestContext,
): Promise<{ sourceVersion: number; targetVersion: number }> {
  const orderIds = unique(input.orderIds);

  if (input.fromRouteId === input.toRouteId) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'source and target routes are equal',
      publicMessage: 'Исходный и целевой маршруты совпадают.',
    });
  }

  try {
    return await deps.db.$transaction(async (tx) => {
      // Оба маршрута блокируются одним запросом с сортировкой по UUID: встречное
      // перемещение иначе взяло бы их в обратном порядке и встало бы намертво.
      const routes = await lockRoutes(tx, [input.fromRouteId, input.toRouteId]);
      const source = requireRoute(routes, input.fromRouteId);
      const target = requireRoute(routes, input.toRouteId);

      requireDraft(source);
      requireDraft(target);
      requireVersion(source, input.expectedSourceVersion);
      requireVersion(target, input.expectedTargetVersion);

      // Перемещение меняет оба маршрута, поэтому оба должны быть у пользователя
      // в работе. Аренды берутся в том же порядке, что и сами маршруты.
      const now = clockOf(deps)();
      for (const id of [input.fromRouteId, input.toRouteId].sort()) {
        await requireLease(tx, id, actor, now);
      }

      const orders = await lockOrders(tx, orderIds);
      assertAllFound(orders, orderIds);
      assertEligible(orders, calendarDate(target.deliveryDate));

      const sourceParticipations = await activeParticipations(tx, input.fromRouteId);
      const moving = sourceParticipations.filter((item) => orderIds.includes(item.orderId));
      if (moving.length !== orderIds.length) {
        throw new AppError('CONFLICT', {
          message: 'order is not in source route',
          publicMessage: 'Заказ уже не состоит в исходном маршруте. Обновите страницу.',
          conflict: { kind: 'ROUTE_ORDER_SET_MISMATCH', orderIds },
        });
      }

      for (const item of moving) {
        await tx.routeOrder.update({
          where: { id: item.id },
          data: {
            removedAt: now,
            removedById: actor.userId,
            removalReason: 'MOVED_TO_ANOTHER_ROUTE',
            movedToRouteId: input.toRouteId,
          },
        });
      }

      let position = (await activeParticipations(tx, input.toRouteId)).length;
      for (const orderId of orderIds) {
        position += 1;
        await tx.routeOrder.create({
          data: { routeId: input.toRouteId, orderId, position, addedById: actor.userId },
        });
      }

      const remaining = sourceParticipations.filter((item) => !orderIds.includes(item.orderId));
      await renumber(
        tx,
        input.fromRouteId,
        remaining.map((item) => item.id),
      );
      const targetOrdered = await activeParticipations(tx, input.toRouteId);
      await renumber(
        tx,
        input.toRouteId,
        targetOrdered.map((item) => item.id),
      );

      await bumpVersion(tx, input.fromRouteId, input.expectedSourceVersion);
      await bumpVersion(tx, input.toRouteId, input.expectedTargetVersion);

      // Две записи аудита: перемещение обязано быть видно в истории обоих маршрутов,
      // иначе из одного из них операция просто исчезнет.
      await auditRoute(tx, 'ROUTE_ORDERS_MOVED', input.fromRouteId, actor, context, {
        direction: 'OUT',
        orderIds,
        counterpartRouteId: input.toRouteId,
        totalOrders: remaining.length,
      });
      await auditRoute(tx, 'ROUTE_ORDERS_MOVED', input.toRouteId, actor, context, {
        direction: 'IN',
        orderIds,
        counterpartRouteId: input.fromRouteId,
        totalOrders: targetOrdered.length,
      });

      await publishRoute(tx, 'route.updated', input.fromRouteId, orderIds);
      await publishRoute(tx, 'route.updated', input.toRouteId, orderIds);

      return {
        sourceVersion: input.expectedSourceVersion + 1,
        targetVersion: input.expectedTargetVersion + 1,
      };
    });
  } catch (error) {
    if (isActiveParticipationConflict(error)) {
      return conflictForOrders(deps.db, orderIds);
    }
    throw error;
  }
}

export async function reorder(
  deps: RoutingDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: OrdersInput,
  context: RequestContext,
): Promise<{ version: number }> {
  return deps.db.$transaction(async (tx) => {
    const route = requireRoute(await lockRoutes(tx, [routeId]), routeId);
    requireDraft(route);
    requireVersion(route, input.expectedVersion);
    await requireLease(tx, routeId, actor, clockOf(deps)());

    const participations = await activeParticipations(tx, routeId);
    const current = participations.map((item) => item.orderId);
    const requested = input.orderIds;

    // Полный список без пропусков, лишних и повторов. Частичная перестановка
    // недопустима: она молча изменила бы порядок доставки не так, как ожидал логист.
    const sameSet =
      requested.length === current.length &&
      new Set(requested).size === requested.length &&
      requested.every((id) => current.includes(id));

    if (!sameSet) {
      throw new AppError('CONFLICT', {
        message: 'reorder set mismatch',
        publicMessage: 'Состав маршрута изменился. Обновите страницу и повторите.',
        conflict: { kind: 'ROUTE_ORDER_SET_MISMATCH' },
      });
    }

    const byOrderId = new Map(participations.map((item) => [item.orderId, item.id]));
    await renumber(
      tx,
      routeId,
      requested.map((orderId) => byOrderId.get(orderId) ?? ''),
    );
    await bumpVersion(tx, routeId, input.expectedVersion);

    await auditRoute(tx, 'ROUTE_ORDERS_REORDERED', routeId, actor, context, {
      orderIds: requested,
      totalOrders: requested.length,
    });
    await publishRoute(tx, 'route.updated', routeId, []);

    return { version: input.expectedVersion + 1 };
  });
}

export interface CourierInput {
  courierUserId: string | null;
  expectedVersion: number;
}

export async function setCourier(
  deps: RoutingDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: CourierInput,
  context: RequestContext,
): Promise<{ version: number; courierUserId: string | null }> {
  return deps.db.$transaction(async (tx) => {
    const route = requireRoute(await lockRoutes(tx, [routeId]), routeId);

    /*
     * Курьера меняют, пока лист не уехал.
     *
     * Черновик — как раньше, под арендой редактора: его состав прямо сейчас
     * правит человек. Неотгруженный лист арендой не защищён и не редактируется
     * по составу, но именно там курьера чаще всего и назначают: лист без
     * курьера стоит первым в разделе и ждёт решения. Отгруженный, доставленный
     * и отменённый не меняются вовсе — там курьер уже факт, а не намерение.
     */
    if (route.state !== 'DRAFT' && route.state !== 'CONFIRMED') {
      throw new AppError('CONFLICT', {
        message: 'route is not editable',
        publicMessage: 'Маршрут уже отгружен: курьера в нём не меняют.',
        conflict: { kind: 'ROUTE_NOT_DRAFT', routeNumber: route.number },
      });
    }
    requireVersion(route, input.expectedVersion);
    if (route.state === 'DRAFT') {
      await requireLease(tx, routeId, actor, clockOf(deps)());
    }

    /*
     * Начатая складская выдача запрещает смену курьера в любом состоянии:
     * часть заказов уже физически у человека, и подменять его записью
     * в базе значило бы потерять след того, кто их увёз.
     */
    await assertIssueNotStarted(tx, routeId, route.number);

    if (input.courierUserId !== null) {
      await assertCourierAssignable(tx, actor, input.courierUserId);
    }

    await tx.deliveryRoute.update({
      where: { id: routeId },
      data: { courierUserId: input.courierUserId },
    });
    await bumpVersion(tx, routeId, input.expectedVersion);

    await auditRoute(
      tx,
      input.courierUserId === null ? 'ROUTE_COURIER_UNASSIGNED' : 'ROUTE_COURIER_ASSIGNED',
      routeId,
      actor,
      context,
      { previousCourierUserId: route.courierUserId, courierUserId: input.courierUserId },
    );
    await publishRoute(tx, 'route.updated', routeId, []);

    return { version: input.expectedVersion + 1, courierUserId: input.courierUserId };
  });
}

/**
 * Проверка кандидата в курьеры.
 *
 * Назначить можно только активного незамороженного пользователя с ролью `COURIER`.
 * Логисту доступен лишь обычный курьер: курьер, которому дополнительно выдали
 * ADMIN или LOGISTICIAN, ему недоступен — иначе через «своего курьера» логист
 * получил бы влияние на привилегированную учётную запись. Администратор такого
 * курьера назначить может.
 */
/**
 * Экспортируется ради направленной проверки совместимости: кандидат с ролью,
 * которой эта версия не знает, обязан быть отвергнут, а не разобран.
 */
export async function assertCourierAssignable(
  tx: TransactionClient,
  actor: AuthenticatedActor,
  courierUserId: string,
): Promise<void> {
  const user = await tx.user.findUnique({
    where: { id: courierUserId },
    select: { id: true, status: true },
  });

  if (user === null) {
    throw new AppError('NOT_FOUND', { message: 'courier not found' });
  }

  // Роли читаются текстом: кандидат с ролью более новой версии не должен ронять
  // назначение курьера разбором перечисления.
  const assignments = await readRoleAssignment(tx, user.id);
  const roles = assignments.known;

  if (user.status !== 'ACTIVE' || !roles.includes('COURIER')) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'user is not an active courier',
      publicMessage: 'Назначить можно только активного курьера.',
    });
  }

  // Неизвестная роль не превращает кандидата в обычного курьера: логисту он
  // недоступен, назначить его может только администратор.
  if (
    !actor.roles.includes('ADMIN') &&
    (assignments.hasUnsupportedRoles || !isPlainCourier(roles))
  ) {
    throw new AppError('FORBIDDEN', {
      message: 'logistician cannot assign privileged courier',
      publicMessage: 'Этого курьера может назначить только администратор.',
    });
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// --- Черновик ровно из выбора «Сделок» ---------------------------------------

export interface SelectionDraftInput {
  deliveryDate: string;
  vehicleType: $Enums.VehicleType;
  /** Упорядоченный набор заказов: позиция в маршруте равна позиции в массиве. */
  orderIds: string[];
  /**
   * Курьер, выбранный логистом заранее. `null` — назначат позже.
   *
   * Маршрутный лист без курьера — обычное рабочее состояние: он и создаётся,
   * чтобы курьера назначили ближе к отгрузке.
   */
  courierUserId?: string | null | undefined;
  /**
   * `SHEET` — сразу маршрутный лист, `DRAFT` — черновик.
   *
   * Обе ветки идут одной транзакцией: маршрутный лист не может «наполовину
   * создаться» и остаться черновиком, о котором никто не просил.
   */
  mode?: 'DRAFT' | 'SHEET' | undefined;
}

/** Сколько заказов можно отправить в один ручной черновик за раз. */
export const MAX_SELECTION_SIZE = 200;

/**
 * Заказы, пригодные к выбору в «Сделках».
 *
 * Правила строже общих правил добавления в маршрут: заказ с блокирующим
 * вниманием и заказ без подтверждённой точки выбрать нельзя вовсе
 * (`docs/OWNER_DECISIONS.md`, `LOG-001` и решения владельца 2.9). Общий контракт
 * `addOrders` этим не связан: туда заказ попадает уже осознанным действием
 * логиста внутри карточки маршрута.
 */
async function assertSelectable(tx: TransactionClient, orderIds: readonly string[]): Promise<void> {
  const rows = await tx.deliveryOrder.findMany({
    where: { id: { in: [...orderIds] } },
    select: { id: true, needsAttention: true, geoState: true },
  });

  const blocked = rows.filter((row) => row.needsAttention || row.geoState !== 'RESOLVED');
  if (blocked.length > 0) {
    throw new AppError('CONFLICT', {
      message: 'order is not selectable',
      publicMessage:
        'Часть заказов больше нельзя распределить: они требуют внимания либо остались без точки.',
      conflict: {
        kind: 'ORDER_NOT_ELIGIBLE',
        orderIds: blocked.map((row) => row.id),
      },
    });
  }
}

/**
 * Уже созданный черновик с ТЕМ ЖЕ составом и порядком.
 *
 * Ответ на потерянный ответ: повтор того же запроса обязан вернуть прежний
 * маршрут, а не создать второй и не отказать. Совпадением считается точное
 * равенство упорядоченного состава — иначе «похожий» черновик выдавался бы
 * за результат чужого действия.
 */
async function existingDraftFor(
  db: Database,
  orderIds: readonly string[],
): Promise<{ id: string; number: string; version: number } | null> {
  const first = orderIds[0];
  if (first === undefined) {
    return null;
  }
  const participation = await db.routeOrder.findFirst({
    where: { orderId: first, removedAt: null },
    select: { routeId: true },
  });
  if (participation === null) {
    return null;
  }

  const route = await db.deliveryRoute.findUnique({
    where: { id: participation.routeId },
    select: {
      id: true,
      number: true,
      version: true,
      state: true,
      orders: {
        where: { removedAt: null },
        orderBy: { position: 'asc' },
        select: { orderId: true },
      },
    },
  });

  if (route === null || route.state !== 'DRAFT') {
    return null;
  }

  const actual = route.orders.map((item) => item.orderId);
  const same =
    actual.length === orderIds.length && actual.every((id, index) => id === orderIds[index]);
  return same ? { id: route.id, number: route.number, version: route.version } : null;
}

/**
 * Один черновик из выбранных заказов в точном порядке `1..N`.
 *
 * Всё в одной транзакции: маршрут, состав, аудит и событие появляются вместе.
 * Ничего не подтверждается — подтверждение остаётся отдельным действием
 * человека.
 *
 * Гонка двух логистов разрешается базой: уникальный индекс активного участия
 * пропускает одного, второй получает `409` со списком ставших недоступными
 * заказов. Маршрут при этом не остаётся пустым — транзакция откатывается
 * целиком.
 */
export async function createDraftFromSelection(
  deps: RoutingDeps,
  actor: AuthenticatedActor,
  input: SelectionDraftInput,
  context: RequestContext,
): Promise<{
  id: string;
  number: string;
  version: number;
  state: $Enums.RouteState;
  positions: number;
  repeated: boolean;
}> {
  if (!isCalendarDate(input.deliveryDate)) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'invalid calendar date',
      publicMessage: 'Указана несуществующая дата доставки.',
    });
  }

  const orderIds = unique(input.orderIds);
  if (orderIds.length !== input.orderIds.length) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'duplicate order ids',
      publicMessage: 'В выборе есть повторяющиеся заказы.',
    });
  }
  if (orderIds.length === 0) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'empty selection',
      publicMessage: 'Выберите хотя бы один заказ.',
    });
  }
  if (orderIds.length > MAX_SELECTION_SIZE) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'selection too large',
      publicMessage: `За один раз можно распределить не больше ${MAX_SELECTION_SIZE} заказов.`,
    });
  }

  try {
    return await deps.db.$transaction(async (tx) => {
      const orders = await lockOrders(tx, orderIds);
      assertAllFound(orders, orderIds);
      assertEligible(orders, input.deliveryDate);
      await assertSelectable(tx, orderIds);
      await assertOrdersAreFree(tx, orderIds);

      const number = await nextRouteNumber(tx, input.deliveryDate);
      const route = await tx.deliveryRoute.create({
        data: {
          number,
          deliveryDate: toDateColumn(input.deliveryDate),
          vehicleType: input.vehicleType,
          createdById: actor.userId,
        },
        select: { id: true, number: true, version: true },
      });

      // Порядок выбора и есть порядок остановок: логист расставил номера
      // на карте, и менять их «на своё усмотрение» нельзя.
      let position = 0;
      for (const orderId of orderIds) {
        position += 1;
        await tx.routeOrder.create({
          data: { routeId: route.id, orderId, position, addedById: actor.userId },
        });
      }

      const now = clockOf(deps)();
      await grantLease(tx, route.id, actor, now);

      // Курьер назначается тем же правилом, что и в карточке маршрута:
      // существующий пользователь подходящей роли и в рабочем состоянии.
      if (input.courierUserId !== undefined && input.courierUserId !== null) {
        await assertCourierAssignable(tx, actor, input.courierUserId);
        await tx.deliveryRoute.update({
          where: { id: route.id },
          data: { courierUserId: input.courierUserId },
        });
        await auditRoute(tx, 'ROUTE_COURIER_ASSIGNED', route.id, actor, context, {
          previousCourierUserId: null,
          courierUserId: input.courierUserId,
        });
      }

      await auditRoute(tx, 'ROUTE_CREATED', route.id, actor, context, {
        number: route.number,
        deliveryDate: input.deliveryDate,
        vehicleType: input.vehicleType,
        state: 'DRAFT',
        totalOrders: orderIds.length,
      });
      await publishRoute(tx, 'route.created', route.id, orderIds);

      /*
       * Маршрутный лист — тот же самый доменный переход, что и подтверждение
       * черновика в «Маршрутизации», а не второй способ получить `CONFIRMED`.
       * Версию сверять не с чем: маршрут создан этой же транзакцией.
       */
      if (input.mode === 'SHEET') {
        const confirmed = await confirmWithinTransaction(tx, actor, route.id, null, context, now);
        return {
          ...route,
          version: confirmed.version,
          state: confirmed.state,
          positions: orderIds.length,
          repeated: false,
        };
      }

      return {
        ...route,
        state: 'DRAFT' as $Enums.RouteState,
        positions: orderIds.length,
        repeated: false,
      };
    });
  } catch (error) {
    if (isActiveParticipationConflict(error)) {
      // Потерянный ответ: тот же состав уже стал черновиком — возвращаем его.
      const existing = await existingDraftFor(deps.db, orderIds);
      if (existing !== null) {
        return { ...existing, state: 'DRAFT', positions: orderIds.length, repeated: true };
      }
      return conflictForOrders(deps.db, orderIds);
    }
    if (error instanceof AppError && error.conflict?.kind === 'ORDER_ALREADY_IN_ROUTE') {
      const existing = await existingDraftFor(deps.db, orderIds);
      if (existing !== null) {
        return { ...existing, state: 'DRAFT', positions: orderIds.length, repeated: true };
      }
    }
    throw error;
  }
}
