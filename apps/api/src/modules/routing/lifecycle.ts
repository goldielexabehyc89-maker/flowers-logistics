/**
 * Жизненный цикл маршрута: подтверждение, возврат в черновик и отмена.
 *
 * Этап 4 знал три состояния и четыре перехода; этап 6.5 добавил пятый —
 * `CONFIRMED → ACTIVE`. Полный список переходов:
 *
 *   DRAFT ──подтверждение──▶ CONFIRMED
 *     ▲                          │
 *     └────возврат с причиной────┘
 *
 *   DRAFT ─────отмена с причиной─────▶ CANCELLED
 *   CONFIRMED ─отмена с причиной─────▶ CANCELLED
 *
 * `ACTIVE` наступает от факта выдачи последнего заказа курьеру и причины
 * не требует; его записывает складской модуль. `COMPLETED` появится вместе
 * с работой курьера. Отменённый маршрут
 * не открывается заново: он остаётся историей, а работа продолжается новым черновиком.
 *
 * Подтверждение — не формальность, а повторная проверка. Между добавлением заказа
 * и подтверждением проходят минуты, за которые синхронизация могла сменить дату,
 * вывести заказ из области или пометить его пропавшим. Поэтому состав проверяется
 * заново по текущим полям заказов, а не по тому, что было при добавлении.
 *
 * ПОРЯДОК БЛОКИРОВОК: DeliveryRoute → RouteEditLease → DeliveryOrder (по UUID)
 * → активные RouteOrder → RouteOrderConflict → RouteStateTransition → AuditLog
 * → RealtimeEvent. Тот же порядок соблюдают операции редактирования состава.
 */

import { Prisma, type $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { readRoleAssignment } from '../../platform/role-assignments.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit, type AuditAction } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import type { ConflictKind, Role } from '@fl/shared';
import { calendarDate, ineligibleReason } from './eligibility.js';
import { nextRouteNumber } from './numbering.js';
import { assertReason, grantLease, releaseLeaseRow, requireLease } from './lease.js';
import {
  activateRouteWithinTransaction,
  markRoutePlacementsForRelocation,
} from '../warehouse/route-flow.js';
import { readManualIssue } from '../settings/service.js';
import { assertIssueNotStarted } from '../warehouse/issue-guard.js';

const ROUTE_AUDIENCE: readonly Role[] = ['ADMIN', 'LOGISTICIAN'];

export interface LifecycleDeps {
  db: Database;
  now?: () => Date;
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

const clockOf = (deps: LifecycleDeps): (() => Date) => deps.now ?? (() => new Date());

interface LockedRoute {
  id: string;
  number: string;
  deliveryDate: Date;
  state: $Enums.RouteState;
  version: number;
  courierUserId: string | null;
  vehicleType: $Enums.VehicleType;
}

/** Причина, по которой маршрут нельзя подтвердить. PII не содержит. */
export interface ConfirmBlocker {
  kind: ConflictKind;
  orderIds: string[];
}

async function lockRoute(tx: TransactionClient, routeId: string): Promise<LockedRoute> {
  const rows = await tx.$queryRaw<LockedRoute[]>`
    SELECT "id", "number", "deliveryDate", "state", "version", "courierUserId", "vehicleType"
    FROM "DeliveryRoute"
    WHERE "id" = ${routeId}::uuid
    FOR UPDATE
  `;
  const route = rows[0];
  if (route === undefined) {
    throw new AppError('NOT_FOUND', { message: 'route not found' });
  }
  return route;
}

function requireState(route: LockedRoute, expected: $Enums.RouteState): void {
  if (route.state !== expected) {
    throw new AppError('CONFLICT', {
      message: `route is not ${expected}`,
      publicMessage:
        expected === 'DRAFT'
          ? 'Операция допустима только для черновика.'
          : 'Операция допустима только для подтверждённого маршрута.',
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

/** Переводит состояние и пишет неизменяемый переход одной транзакцией. */
async function applyTransition(
  tx: TransactionClient,
  route: LockedRoute,
  toState: $Enums.RouteState,
  actor: AuthenticatedActor,
  now: Date,
  reason: string | null,
): Promise<void> {
  const updated = await tx.deliveryRoute.updateMany({
    where: { id: route.id, version: route.version },
    data: { state: toState, version: { increment: 1 } },
  });

  if (updated.count === 0) {
    throw new AppError('CONFLICT', {
      message: 'stale route version',
      publicMessage: 'Маршрут изменён другим пользователем. Обновите страницу и повторите.',
      conflict: { kind: 'STALE_VERSION' },
    });
  }

  await tx.routeStateTransition.create({
    data: {
      routeId: route.id,
      fromState: route.state,
      toState,
      actorUserId: actor.userId,
      occurredAt: now,
      reason,
    },
  });
}

/** Запись аудита маршрута с произвольным содержимым. */
async function auditRouteValue(
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
    // Только идентификаторы, номера и счётчики: ни адресов, ни телефонов.
    oldValue: null,
    newValue: value,
    ip: context.ip,
    userAgent: context.userAgent,
  });
}

/** Событие маршрута без персональных данных: клиент перезапрашивает сам. */
async function publishRouteEvent(
  tx: TransactionClient,
  topic: 'route.created' | 'route.updated',
  routeId: string,
): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic,
    payload: { routeId },
    audienceRoles: ['ADMIN', 'LOGISTICIAN'],
  });
}

async function auditAndPublish(
  tx: TransactionClient,
  action: AuditAction,
  topic: 'route.confirmed' | 'route.returned_to_draft' | 'route.cancelled',
  route: LockedRoute,
  toState: $Enums.RouteState,
  actor: AuthenticatedActor,
  context: RequestContext,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeAudit(tx, {
    action,
    entityType: 'DeliveryRoute',
    entityId: route.id,
    actorUserId: actor.userId,
    actorRoles: actor.roles,
    source: 'api',
    // Только состояния и счётчики. Причина живёт в защищённой истории переходов.
    oldValue: { state: route.state, version: route.version },
    newValue: { state: toState, version: route.version + 1, ...extra },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  await publishRealtimeEvent(tx, {
    topic,
    // Ни номера маршрута, ни причины, ни данных заказов: клиент перезапрашивает карточку.
    payload: { routeId: route.id, state: toState },
    audienceRoles: [...ROUTE_AUDIENCE],
  });
}

/**
 * Повторная проверка состава перед подтверждением.
 *
 * Возвращает список причин отказа, а не бросает исключение: тот же расчёт нужен
 * карточке маршрута, чтобы показать блокировки заранее, до нажатия кнопки.
 */
export async function confirmBlockers(
  tx: TransactionClient | Database,
  routeId: string,
): Promise<ConfirmBlocker[]> {
  const route = await tx.deliveryRoute.findUnique({
    where: { id: routeId },
    select: {
      id: true,
      deliveryDate: true,
      courierUserId: true,
      courier: { select: { id: true, status: true } },
      orders: {
        where: { removedAt: null },
        select: {
          orderId: true,
          conflicts: { select: { kind: true } },
          order: {
            select: {
              id: true,
              deliveryDate: true,
              inScope: true,
              sourceArchived: true,
              sourceMissing: true,
            },
          },
        },
      },
    },
  });

  if (route === null) {
    throw new AppError('NOT_FOUND', { message: 'route not found' });
  }

  const blockers: ConfirmBlocker[] = [];

  if (route.orders.length === 0) {
    blockers.push({ kind: 'ROUTE_EMPTY', orderIds: [] });
  }

  const conflicted = route.orders
    .filter((item) => item.conflicts.length > 0)
    .map((item) => item.orderId);
  if (conflicted.length > 0) {
    blockers.push({ kind: 'ROUTE_HAS_CONFLICTS', orderIds: conflicted });
  }

  // Заказ проверяется по ТЕКУЩИМ полям: между добавлением и подтверждением
  // синхронизация могла сменить дату или вывести заказ из нашей области.
  // «Требует внимания», отсутствующий интервал и адрес подтверждение не блокируют:
  // подтверждённый маршрут может содержать ещё не готовые заказы, а отгрузку
  // они остановят на этапе 6.
  const routeDate = calendarDate(route.deliveryDate);
  const ineligible = route.orders
    .filter((item) => ineligibleReason(item.order, routeDate) !== null)
    .map((item) => item.orderId);
  if (ineligible.length > 0) {
    blockers.push({ kind: 'ORDER_NOT_ELIGIBLE', orderIds: ineligible });
  }

  if (route.courierUserId !== null) {
    // Роли читаются текстом: подтверждение маршрута не должно падать из-за
    // роли курьера, которой эта версия приложения не знает.
    const roles = (await readRoleAssignment(tx, route.courierUserId)).known;
    if (route.courier?.status !== 'ACTIVE' || !roles.includes('COURIER')) {
      blockers.push({ kind: 'ROUTE_COURIER_UNAVAILABLE', orderIds: [] });
    }
  }

  return blockers;
}

export interface ConfirmInput {
  expectedVersion: number;
}

/**
 * Подтверждение маршрута ВНУТРИ уже открытой транзакции.
 *
 * Вынесено отдельно, чтобы у перехода «черновик → маршрутный лист» была ровно
 * одна реализация. Создание маршрутного листа сразу из выбора в «Сделках»
 * обязано быть атомарным: черновик и его подтверждение случаются либо вместе,
 * либо никак. Второй экземпляр этой логики неизбежно разошёлся бы с первым —
 * а расходятся такие вещи молча.
 *
 * `expectedVersion` равен `null` только там, где маршрут создан этой же
 * транзакцией: сверять версию с самим собой нечего, а чужого редактора
 * у секундного черновика быть не может.
 */
export async function confirmWithinTransaction(
  tx: TransactionClient,
  actor: AuthenticatedActor,
  routeId: string,
  expectedVersion: number | null,
  context: RequestContext,
  now: Date,
): Promise<{ state: $Enums.RouteState; version: number }> {
  const route = await lockRoute(tx, routeId);
  requireState(route, 'DRAFT');
  if (expectedVersion !== null) {
    requireVersion(route, expectedVersion);
    // Подтверждает тот, кто держит маршрут в работе: иначе один человек
    // подтвердил бы состав, который прямо сейчас меняет другой.
    await requireLease(tx, routeId, actor, now);
  }

  const blockers = await confirmBlockers(tx, routeId);
  if (blockers.length > 0) {
    const first = blockers[0];
    throw new AppError('CONFLICT', {
      message: 'route cannot be confirmed',
      publicMessage: describeBlocker(first?.kind),
      conflict: {
        kind: first?.kind ?? 'ROUTE_EMPTY',
        ...(first !== undefined && first.orderIds.length > 0 ? { orderIds: first.orderIds } : {}),
      },
    });
  }

  await applyTransition(tx, route, 'CONFIRMED', actor, now, null);
  // Подтверждённый маршрут не редактируется, поэтому держать его в работе незачем.
  await releaseLeaseRow(tx, routeId, now);

  await auditAndPublish(
    tx,
    'ROUTE_CONFIRMED',
    'route.confirmed',
    route,
    'CONFIRMED',
    actor,
    context,
  );

  return { state: 'CONFIRMED', version: route.version + 1 };
}

export async function confirmRoute(
  deps: LifecycleDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: ConfirmInput,
  context: RequestContext,
): Promise<{ state: $Enums.RouteState; version: number }> {
  const now = clockOf(deps)();

  return deps.db.$transaction((tx) =>
    confirmWithinTransaction(tx, actor, routeId, input.expectedVersion, context, now),
  );
}

function describeBlocker(kind: ConflictKind | undefined): string {
  switch (kind) {
    case 'ROUTE_EMPTY':
      return 'Пустой маршрут подтвердить нельзя.';
    case 'ROUTE_HAS_CONFLICTS':
      return 'У заказов маршрута есть расхождения с МоимСкладом. Разберите их и повторите.';
    case 'ROUTE_COURIER_UNAVAILABLE':
      return 'Назначенный курьер больше не может выполнять маршрут.';
    case 'ORDER_NOT_ELIGIBLE':
      return 'Состав маршрута изменился: часть заказов больше не подходит.';
    default:
      return 'Маршрут нельзя подтвердить.';
  }
}

export interface ManualIssueInput {
  expectedVersion: number;
}

/**
 * Ручная отгрузка маршрутного листа логистом.
 *
 * Тот же доменный переход, что и складская отгрузка: реализация одна
 * (`activateRouteWithinTransaction`), отличие ровно одно — заказы не сканируются.
 * Параллельного изменения статуса здесь нет и быть не может.
 *
 * Три отказа, каждый из которых защищает факт, а не форму:
 *
 * 1. Выключенная глобальная настройка. Её меняет только администратор.
 * 2. Не назначен курьер: маршрут «уехал» бы неизвестно с кем.
 * 3. По маршруту уже идёт складская выдача. Тогда отгружает склад — иначе
 *    часть заказов физически у курьера, часть на полке, а лист считается
 *    отгруженным целиком.
 *
 * Повтор идемпотентен: уже отгруженный лист возвращает то же состояние
 * и второй записи в истории не создаёт.
 */
export async function shipRouteManually(
  deps: LifecycleDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: ManualIssueInput,
  context: RequestContext,
): Promise<{ state: $Enums.RouteState; version: number; unchanged: boolean }> {
  const now = clockOf(deps)();

  const setting = await readManualIssue(deps.db);
  if (!setting.value.enabled) {
    throw new AppError('CONFLICT', {
      message: 'manual issue disabled',
      publicMessage:
        'Ручная отгрузка выключена. Включить её может только администратор в настройках.',
      conflict: { kind: 'MANUAL_ISSUE_DISABLED' },
    });
  }

  return deps.db.$transaction(async (tx) => {
    const route = await lockRoute(tx, routeId);

    // Повтор потерянной команды не создаёт второй переход.
    if (route.state === 'ACTIVE') {
      return { state: route.state, version: route.version, unchanged: true };
    }

    requireState(route, 'CONFIRMED');
    requireVersion(route, input.expectedVersion);

    if (route.courierUserId === null) {
      throw new AppError('CONFLICT', {
        message: 'courier is not assigned',
        publicMessage: 'Сначала назначьте курьера: без него маршрут отгрузить нельзя.',
        conflict: { kind: 'ROUTE_COURIER_REQUIRED', routeNumber: route.number },
      });
    }

    await assertIssueNotStarted(tx, routeId, route.number);

    /*
     * Признак ручной отгрузки уходит в аудит (`manual: true`), а не в историю
     * состояний: там живут состояния, а не способы их достижения, и правило
     * базы запрещает причину у перехода в «отгружен».
     */
    await activateRouteWithinTransaction(tx, route, actor, context, now, {
      issued: 0,
      orderId: null,
    });

    return { state: 'ACTIVE', version: route.version + 1, unchanged: false };
  });
}

/**
 * Отмена отгрузки маршрутного листа.
 *
 * Два разных действия под одним именем, и разница между ними — судьба уже
 * доставленных заказов.
 *
 * `UNFINISHED` — доставленные остаются доставленными. Лист АТОМАРНО делится:
 * исходный сохраняет свой номер, оставляет у себя доставленные заказы
 * и уходит в «Доставленные»; незавершённые переезжают в НОВЫЙ неотгруженный
 * лист с новым номером, сохраняя относительный порядок и курьера.
 *
 * Разделение выражено существующими средствами переноса: участие в исходном
 * листе закрывается причиной `MOVED_TO_ANOTHER_ROUTE` со ссылкой
 * `movedToRouteId`, а в аудит обоих листов пишется встречный номер. Новое
 * значение перечисления не понадобилось: заказ действительно переехал
 * в другой маршрут, и это ровно та причина, которая уже есть.
 *
 * `ALL` — административная коррекция. Доставленные заказы снова становятся
 * неотгруженными, но прежний факт доставки НЕ удаляется: он остаётся в истории
 * отменённым с причиной, автором и временем. Разделения не происходит.
 *
 * Если доставленных заказов нет, оба режима делают одно и то же: лист целиком
 * возвращается в неотгруженное состояние.
 */

/**
 * Возврат доставленных заказов в работу.
 *
 * Прежний факт доставки НЕ удаляется: снимается только технический ключ,
 * а рядом появляется запись коррекции с видом `MANAGER_CORRECTION`, автором,
 * временем и причиной. Именно так это уже делает исправление одного результата
 * — здесь тот же механизм применяется ко всем результатам листа сразу.
 */
async function restoreDeliveredOrders(
  tx: TransactionClient,
  delivered: readonly { id: string }[],
  actor: AuthenticatedActor,
  reason: string,
  now: Date,
): Promise<number> {
  for (const attempt of delivered) {
    await tx.deliveryAttemptCancellation.create({
      data: {
        attemptId: attempt.id,
        kind: 'MANAGER_CORRECTION',
        reason: reason.trim(),
        actorUserId: actor.userId,
        occurredAt: now,
      },
    });
    // Снимается только технический ключ: содержимое попытки остаётся прежним.
    await tx.deliveryAttempt.update({ where: { id: attempt.id }, data: { activeKey: null } });
  }
  return delivered.length;
}

/**
 * Разделение отгруженного листа на доставленную и незавершённую части.
 *
 * Исходный лист сохраняет свой номер и доставленные заказы и уходит
 * в «Доставленные». Незавершённые переезжают в новый неотгруженный лист:
 * тем же способом, что и обычный перенос между маршрутами, — участие
 * закрывается причиной `MOVED_TO_ANOTHER_ROUTE` со ссылкой на новый лист.
 * Относительный порядок сохраняется, курьер переносится и остаётся сменяемым.
 *
 * Либо появляются оба корректных состояния, либо не меняется ничего:
 * всё происходит в одной транзакции.
 */
async function splitShippedRoute(
  tx: TransactionClient,
  route: LockedRoute,
  delivered: readonly { routeOrderId: string }[],
  actor: AuthenticatedActor,
  context: RequestContext,
  now: Date,
): Promise<CancelShipmentResult> {
  const deliveredIds = new Set(delivered.map((item) => item.routeOrderId));

  const participations = await tx.routeOrder.findMany({
    where: { routeId: route.id, removedAt: null },
    orderBy: { position: 'asc' },
    select: { id: true, orderId: true },
  });
  const unfinished = participations.filter((item) => !deliveredIds.has(item.id));

  if (unfinished.length === 0) {
    // Делить нечего: доставлено всё. Лист просто числится доставленным.
    throw new AppError('CONFLICT', {
      message: 'nothing to split',
      publicMessage: 'В листе нет незавершённых заказов: отменять нечего.',
      conflict: { kind: 'ROUTE_EMPTY', routeNumber: route.number },
    });
  }

  const number = await nextRouteNumber(tx, calendarDate(route.deliveryDate));
  const created = await tx.deliveryRoute.create({
    data: {
      number,
      deliveryDate: route.deliveryDate,
      vehicleType: route.vehicleType,
      createdById: actor.userId,
      // Курьер переносится, но остаётся сменяемым до повторной отгрузки.
      ...(route.courierUserId === null ? {} : { courierUserId: route.courierUserId }),
    },
    select: { id: true, number: true },
  });

  let position = 0;
  for (const item of unfinished) {
    position += 1;
    await tx.routeOrder.update({
      where: { id: item.id },
      data: {
        removedAt: now,
        removedById: actor.userId,
        removalReason: 'MOVED_TO_ANOTHER_ROUTE',
        movedToRouteId: created.id,
      },
    });
    await tx.routeOrder.create({
      data: {
        routeId: created.id,
        orderId: item.orderId,
        position,
        addedById: actor.userId,
      },
    });
  }

  // Новый лист сразу неотгружен: это тот же переход «черновик → лист».
  await confirmWithinTransaction(tx, actor, created.id, null, context, now);

  // Исходный лист остался с доставленными заказами и потому доставлен.
  await applyTransition(tx, route, 'COMPLETED', actor, now, null);

  // Прослеживаемая связь: в истории обоих листов виден встречный номер.
  await auditRouteValue(tx, 'ROUTE_SPLIT_FROM_SHIPMENT', route.id, actor, context, {
    direction: 'OUT',
    counterpartRouteId: created.id,
    counterpartRouteNumber: created.number,
    movedOrders: unfinished.length,
    deliveredOrders: delivered.length,
    previousState: route.state,
  });
  await auditRouteValue(tx, 'ROUTE_SPLIT_FROM_SHIPMENT', created.id, actor, context, {
    direction: 'IN',
    counterpartRouteId: route.id,
    counterpartRouteNumber: route.number,
    movedOrders: unfinished.length,
  });

  // Оба раздела экрана обязаны обновиться без перезагрузки.
  await publishRouteEvent(tx, 'route.updated', route.id);
  await publishRouteEvent(tx, 'route.created', created.id);

  return {
    state: 'COMPLETED',
    version: route.version + 1,
    unchanged: false,
    createdSheet: { id: created.id, number: created.number },
    restoredOrders: 0,
  };
}

export type CancelShipmentMode = 'UNFINISHED' | 'ALL';

export interface CancelShipmentInput {
  expectedVersion: number;
  mode: CancelShipmentMode;
  /** Обязательна для `ALL`: это исправление уже состоявшегося факта. */
  reason?: string | undefined;
}

export interface CancelShipmentResult {
  state: $Enums.RouteState;
  version: number;
  unchanged: boolean;
  /** Созданный неотгруженный лист. `null` — разделения не потребовалось. */
  createdSheet: { id: string; number: string } | null;
  /** Сколько доставленных заказов вернулось в работу (`ALL`). */
  restoredOrders: number;
}

export async function cancelShipment(
  deps: LifecycleDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: CancelShipmentInput,
  context: RequestContext,
): Promise<CancelShipmentResult> {
  const now = clockOf(deps)();
  if (input.mode === 'ALL') {
    assertReason(input.reason ?? '');
  }

  return deps.db.$transaction(async (tx) => {
    const route = await lockRoute(tx, routeId);

    // Повтор потерянной команды ничего не создаёт заново.
    if (route.state === 'CONFIRMED') {
      return {
        state: route.state,
        version: route.version,
        unchanged: true,
        createdSheet: null,
        restoredOrders: 0,
      };
    }
    if (route.state !== 'ACTIVE' && route.state !== 'COMPLETED') {
      throw new AppError('CONFLICT', {
        message: 'route is not shipped',
        publicMessage: 'Отменять нечего: маршрутный лист не отгружен.',
        conflict: { kind: 'ROUTE_NOT_ACTIVE', routeNumber: route.number },
      });
    }
    requireVersion(route, input.expectedVersion);

    // Доставленные заказы листа: только действующие результаты.
    const delivered = await tx.deliveryAttempt.findMany({
      where: { routeId, activeKey: { not: null }, outcome: 'DELIVERED' },
      select: { id: true, routeOrderId: true },
    });

    if (delivered.length === 0) {
      await applyTransition(tx, route, 'CONFIRMED', actor, now, null);
      await auditRouteValue(tx, 'ROUTE_SHIPMENT_CANCELLED', route.id, actor, context, {
        mode: input.mode,
        previousState: route.state,
        state: 'CONFIRMED',
        deliveredOrders: 0,
      });
      await publishRouteEvent(tx, 'route.updated', route.id);
      return {
        state: 'CONFIRMED',
        version: route.version + 1,
        unchanged: false,
        createdSheet: null,
        restoredOrders: 0,
      };
    }

    if (input.mode === 'ALL') {
      const restored = await restoreDeliveredOrders(tx, delivered, actor, input.reason ?? '', now);
      await applyTransition(tx, route, 'CONFIRMED', actor, now, null);
      await auditRouteValue(tx, 'ROUTE_SHIPMENT_CANCELLED', routeId, actor, context, {
        mode: 'ALL',
        reason: (input.reason ?? '').trim(),
        restoredOrders: restored,
        previousState: route.state,
      });
      await publishRouteEvent(tx, 'route.updated', routeId);
      return {
        state: 'CONFIRMED',
        version: route.version + 1,
        unchanged: false,
        createdSheet: null,
        restoredOrders: restored,
      };
    }

    return splitShippedRoute(tx, route, delivered, actor, context, now);
  });
}

export interface ReasonInput {
  expectedVersion: number;
  reason: string;
}

export async function returnToDraft(
  deps: LifecycleDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: ReasonInput,
  context: RequestContext,
): Promise<{ state: $Enums.RouteState; version: number }> {
  const now = clockOf(deps)();
  assertReason(input.reason);

  return deps.db.$transaction(async (tx) => {
    const route = await lockRoute(tx, routeId);
    requireState(route, 'CONFIRMED');
    requireVersion(route, input.expectedVersion);

    // Выдача уже идёт или состоялась: превращать переданные курьеру коробки
    // обратно в редактируемый черновик нельзя. Отменяет выдачу администратор
    // отдельной операцией с обязательной причиной.
    await assertIssueNotStarted(tx, routeId, route.number);

    // Блокировка заранее не нужна: подтверждённый маршрут никто не редактирует.
    await applyTransition(tx, route, 'DRAFT', actor, now, input.reason.trim());

    // Заказы, уже лежащие в маршрутной ячейке, физически никуда не переезжают:
    // система лишь помечает, что их нужно вернуть в хранение штатным
    // сканированием, и до этого блокирует выдачу (`FUL-003`).
    await markRoutePlacementsForRelocation(tx, routeId);
    // Состав и порядок сохраняются полностью: возврат — это возможность править,
    // а не пересборка маршрута заново.
    // Маршрут сразу открывается инициатору, иначе между возвратом и захватом
    // блокировки его успел бы занять другой редактор.
    await grantLease(tx, routeId, actor, now);

    await auditAndPublish(
      tx,
      'ROUTE_RETURNED_TO_DRAFT',
      'route.returned_to_draft',
      route,
      'DRAFT',
      actor,
      context,
    );

    return { state: 'DRAFT', version: route.version + 1 };
  });
}

export async function cancelRoute(
  deps: LifecycleDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: ReasonInput,
  context: RequestContext,
): Promise<{ state: $Enums.RouteState; version: number; releasedOrders: number }> {
  const now = clockOf(deps)();
  assertReason(input.reason);

  return deps.db.$transaction(async (tx) => {
    const route = await lockRoute(tx, routeId);

    if (route.state !== 'DRAFT' && route.state !== 'CONFIRMED') {
      throw new AppError('CONFLICT', {
        message: 'route cannot be cancelled',
        // Отменённый и уехавший маршруты одинаково нельзя отменить, но по
        // разным причинам. Сказать логисту «уже отменён» про лист, который
        // сейчас у курьера, — это соврать о том, где находятся коробки.
        publicMessage:
          route.state === 'ACTIVE'
            ? 'Заказы переданы курьеру: маршрут больше не отменяется.'
            : 'Маршрут уже отменён.',
        conflict: { kind: 'ROUTE_NOT_DRAFT' },
      });
    }
    requireVersion(route, input.expectedVersion);

    // Тот же запрет, что и при возврате в черновик: отменить маршрут, часть
    // которого уже уехала с курьером, обычным путём нельзя.
    if (route.state === 'CONFIRMED') {
      await assertIssueNotStarted(tx, routeId, route.number);
    }

    // Черновик отменяет тот, кто держит его в работе; подтверждённый маршрут
    // никто не редактирует, поэтому блокировка для него не требуется.
    if (route.state === 'DRAFT') {
      await requireLease(tx, routeId, actor, now);
    }

    const participations = await tx.routeOrder.findMany({
      where: { routeId, removedAt: null },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, orderId: true },
    });

    // Блокируем заказы в порядке UUID: тот же порядок у операций состава.
    if (participations.length > 0) {
      const ids = [...participations].map((item) => item.orderId).sort();
      const list = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
      await tx.$queryRaw`SELECT "id" FROM "DeliveryOrder" WHERE "id" IN (${list}) ORDER BY "id" FOR UPDATE`;
    }

    // Пометка ставится ДО закрытия участий: после него активного состава
    // маршрута уже нет, и найти лежащие в маршрутной ячейке заказы было бы нечем.
    await markRoutePlacementsForRelocation(tx, routeId);

    for (const item of participations) {
      await tx.routeOrder.update({
        where: { id: item.id },
        data: {
          removedAt: now,
          removedById: actor.userId,
          removalReason: 'ROUTE_CANCELLED',
        },
      });
    }

    await applyTransition(tx, route, 'CANCELLED', actor, now, input.reason.trim());
    await releaseLeaseRow(tx, routeId, now);

    await auditAndPublish(
      tx,
      'ROUTE_CANCELLED',
      'route.cancelled',
      route,
      'CANCELLED',
      actor,
      context,
      { releasedOrders: participations.length },
    );

    return {
      state: 'CANCELLED',
      version: route.version + 1,
      releasedOrders: participations.length,
    };
  });
}
