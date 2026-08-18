/**
 * Работа курьера: результат доставки и автоматическое завершение маршрута.
 *
 * ЧТО КУРЬЕР МОЖЕТ. Ровно две операции: «Доставлен» и «Не доставлен». Кнопок
 * «в пути», «принял маршрут» и «начал маршрут» продукт не вводит: маршрут
 * становится активным в момент физической выдачи на складе, а не от нажатия.
 *
 * ПОЧЕМУ РЕЗУЛЬТАТ — ОТДЕЛЬНАЯ ЗАПИСЬ. Поле «результат» у заказа пришлось бы
 * перезаписывать при исправлении, и прежняя правда исчезла бы вместе с тем,
 * кто и когда её сообщил. Здесь каждая попытка остаётся навсегда, а исправление
 * оформляется отменой — тоже отдельной записью.
 *
 * ПОЧЕМУ ВРЕМЯ СТАВИТ СЕРВЕР. Часы устройства курьера доказательством не служат:
 * их можно перевести, а результат доставки — операционный факт.
 *
 * ДВЕ ПРАВДЫ ОДНОВРЕМЕННО НЕВОЗМОЖНЫ ФИЗИЧЕСКИ. Уникальный индекс по
 * `activeKey` не даёт появиться второй действующей попытке у одного участия.
 * Проверка «нет ли уже результата» в коде оставляла бы окно между чтением
 * и записью — ровно то, во что попадают два устройства одного курьера и повтор
 * потерянного ответа.
 *
 * ПОРЯДОК БЛОКИРОВОК. `DeliveryRoute` → `RouteOrder` → `DeliveryAttempt`, тот же,
 * что у складского комплектования. Встречный порядок дал бы взаимную блокировку.
 */

import type { $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { moscowCalendarDate } from '@fl/shared';
import { accrueDeliveryResult, reverseDeliveryAccruals } from '../finance/accrual.js';
import { closeAfterCancelledResult, openAfterFailedDelivery } from '../returns/service.js';
// Рабочий адрес считается в одном месте на весь продукт, а не переписывается здесь.
import { effectiveAddress } from '../orders/address.js';
import { fromMicro } from '../orders/geo.js';
import { readLedgerActivation } from '../finance/tariffs.js';

/** Кто работает с доставкой. Курьер сообщает результат, остальные — наблюдают и правят. */
export const DELIVERY_ROLES = ['ADMIN', 'LOGISTICIAN', 'COURIER'] as const;
/** Исправление чужого результата и справочник причин. */
export const DELIVERY_MANAGER_ROLES = ['ADMIN', 'LOGISTICIAN'] as const;
/** Кому уходят события доставки. Курьер получает своё персональным адресатом. */
export const DELIVERY_AUDIENCE = ['ADMIN', 'LOGISTICIAN'] as const;

/**
 * Сколько курьер может отменять собственный результат.
 *
 * Пять минут — из продуктового контракта. Позже исправляет логист или
 * администратор, и уже с обязательной причиной: чем дальше от события,
 * тем меньше шансов, что человек помнит, что именно произошло.
 */
export const DELIVERY_CANCEL_WINDOW_MS = 5 * 60 * 1000;

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface DeliveryDeps {
  db: Database;
  /** Часы сервера. Подменяются только проверками. */
  clock?: () => Date;
}

const clockOf = (deps: DeliveryDeps): (() => Date) => deps.clock ?? (() => new Date());

function isManager(actor: AuthenticatedActor): boolean {
  return actor.roles.some((role) => role === 'ADMIN' || role === 'LOGISTICIAN');
}

// --- Справочник причин -------------------------------------------------------

export interface FailureReasonView {
  id: string;
  code: string;
  name: string;
  ordinal: number;
  requiresComment: boolean;
  isActive: boolean;
  version: number;
}

const REASON_SELECT = {
  id: true,
  code: true,
  name: true,
  ordinal: true,
  requiresComment: true,
  isActive: true,
  version: true,
} as const;

export async function listFailureReasons(
  db: Database,
  options: { includeInactive?: boolean } = {},
): Promise<FailureReasonView[]> {
  return db.deliveryFailureReason.findMany({
    where: options.includeInactive === true ? {} : { isActive: true },
    orderBy: [{ ordinal: 'asc' }, { code: 'asc' }],
    select: REASON_SELECT,
  });
}

export interface UpdateReasonInput {
  name?: string | undefined;
  isActive?: boolean | undefined;
  expectedVersion: number;
}

/**
 * Меняет название и активность причины.
 *
 * Код не редактируется: он машинный ключ, и его смена оторвала бы историю
 * от справочника. Название меняется свободно — уже сообщённые результаты
 * хранят снимок и переименованием не переписываются.
 */
export async function updateFailureReason(
  deps: DeliveryDeps,
  actor: AuthenticatedActor,
  id: string,
  input: UpdateReasonInput,
  context: RequestContext,
): Promise<FailureReasonView> {
  return deps.db.$transaction(async (tx) => {
    const current = await tx.deliveryFailureReason.findUnique({
      where: { id },
      select: { ...REASON_SELECT },
    });
    if (current === null) {
      throw new AppError('NOT_FOUND', { publicMessage: 'Причина не найдена.' });
    }
    if (current.version !== input.expectedVersion) {
      throw new AppError('CONFLICT', {
        message: 'stale reason version',
        publicMessage: 'Справочник изменён другим пользователем. Обновите экран и повторите.',
        conflict: { kind: 'STALE_VERSION' },
      });
    }

    const name = input.name === undefined ? current.name : input.name.trim();
    if (name === '') {
      throw new AppError('VALIDATION_FAILED', {
        publicMessage: 'Название причины не может быть пустым.',
      });
    }

    const updated = await tx.deliveryFailureReason.update({
      where: { id },
      data: {
        name,
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        changedById: actor.userId,
        version: { increment: 1 },
      },
      select: REASON_SELECT,
    });

    await writeAudit(tx, {
      action: 'DELIVERY_REASON_UPDATED',
      entityType: 'DeliveryFailureReason',
      entityId: id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      oldValue: { name: current.name, isActive: current.isActive, version: current.version },
      newValue: { name: updated.name, isActive: updated.isActive, version: updated.version },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return updated;
  });
}

/**
 * Подтверждённая точка заказа.
 *
 * Только `RESOLVED`: у заказа в ожидании или с отказом геокодера координаты
 * либо отсутствуют, либо не подтверждены, и выдавать их за место доставки
 * нельзя. Отсутствие точки — честное `null`, а не центр Москвы.
 */
function confirmedPoint(order: {
  geoState: $Enums.OrderGeoState;
  geoLatMicro: number | null;
  geoLonMicro: number | null;
}): { lat: string; lon: string } | null {
  if (order.geoState !== 'RESOLVED' || order.geoLatMicro === null || order.geoLonMicro === null) {
    return null;
  }
  return { lat: fromMicro(order.geoLatMicro), lon: fromMicro(order.geoLonMicro) };
}

// --- Активные доставки -------------------------------------------------------

export interface ActiveDeliveryOrder {
  routeOrderId: string;
  orderId: string;
  position: number;
  number: string;
  /**
   * Рабочий адрес: правка логиста сильнее исходного значения источника.
   *
   * Курьер едет именно по нему. Показывать здесь исходный адрес значило бы
   * отправить человека туда, откуда его уже увели правкой.
   */
  address: string | null;
  /**
   * Подтверждённая точка заказа. `null` — точки нет.
   *
   * Отдаётся только для подтверждённой геопозиции: догаданная координата
   * увела бы курьера не туда с уверенным видом.
   */
  point: { lat: string; lon: string } | null;
  recipient: string | null;
  comment: string | null;
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
  cashToCollectMinor: string;
  cashCollectable: boolean;
  /** Действующий результат, если он уже есть. */
  result: AttemptView | null;
}

/** Обязательство вернуть букет: живёт дольше маршрута. */
export interface CourierReturnView {
  returnId: string;
  orderId: string;
  orderNumber: string;
  routeNumber: string;
  reasonName: string;
  state: $Enums.OrderReturnState;
  failedAt: Date;
}

export interface ActiveDeliveryRoute {
  routeId: string;
  number: string;
  deliveryDate: string;
  state: $Enums.RouteState;
  vehicleType: $Enums.VehicleType;
  courier: { id: string; fullName: string } | null;
  orders: ActiveDeliveryOrder[];
}

export interface AttemptView {
  id: string;
  outcome: $Enums.DeliveryOutcome;
  reasonId: string | null;
  reasonName: string | null;
  comment: string | null;
  occurredAt: Date;
  courier: { id: string; fullName: string };
  /** Может ли ЭТОТ актор отменить результат прямо сейчас. */
  cancellable: boolean;
}

const ATTEMPT_SELECT = {
  id: true,
  outcome: true,
  reasonId: true,
  reasonNameSnapshot: true,
  comment: true,
  occurredAt: true,
  courierUserId: true,
  courier: { select: { id: true, fullName: true } },
} as const;

type AttemptRow = {
  id: string;
  outcome: $Enums.DeliveryOutcome;
  reasonId: string | null;
  reasonNameSnapshot: string | null;
  comment: string | null;
  occurredAt: Date;
  courierUserId: string;
  courier: { id: string; fullName: string };
};

function toAttemptView(row: AttemptRow, actor: AuthenticatedActor, now: Date): AttemptView {
  return {
    id: row.id,
    outcome: row.outcome,
    reasonId: row.reasonId,
    reasonName: row.reasonNameSnapshot,
    comment: row.comment,
    occurredAt: row.occurredAt,
    courier: row.courier,
    cancellable:
      isManager(actor) ||
      (row.courierUserId === actor.userId &&
        now.getTime() - row.occurredAt.getTime() <= DELIVERY_CANCEL_WINDOW_MS),
  };
}

export interface ActiveQuery {
  /** Фильтр одного маршрута. Список курьера объединённый, но сузить его можно. */
  routeId?: string | undefined;
  /** Чей список смотрит менеджер. Курьеру параметр недоступен. */
  courierUserId?: string | undefined;
}

/**
 * Активные доставки.
 *
 * Курьер видит ТОЛЬКО свои `ACTIVE`-маршруты. Это проверяется здесь, на сервере,
 * а не скрытием раздела: скрытая кнопка данных не защищает.
 */
/**
 * Возвраты, которые числятся за курьером.
 *
 * Отдельно от маршрутов намеренно: маршрут может быть уже завершён, а букет
 * всё ещё лежит в машине. Обязательство снимает только приёмка складом.
 */
export async function listCourierReturns(
  deps: DeliveryDeps,
  actor: AuthenticatedActor,
): Promise<CourierReturnView[]> {
  const manager = isManager(actor);
  const rows = await deps.db.orderReturn.findMany({
    where: {
      activeKey: { not: null },
      ...(manager ? {} : { courierUserId: actor.userId }),
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      orderId: true,
      state: true,
      order: { select: { externalName: true } },
      attempt: { select: { reasonNameSnapshot: true, occurredAt: true } },
      routeOrder: { select: { route: { select: { number: true } } } },
    },
  });

  return rows.map((row) => ({
    returnId: row.id,
    orderId: row.orderId,
    orderNumber: row.order.externalName,
    routeNumber: row.routeOrder.route.number,
    reasonName: row.attempt.reasonNameSnapshot ?? 'Причина не указана',
    state: row.state,
    failedAt: row.attempt.occurredAt,
  }));
}

export async function listActiveDeliveries(
  deps: DeliveryDeps,
  actor: AuthenticatedActor,
  query: ActiveQuery = {},
): Promise<{ routes: ActiveDeliveryRoute[] }> {
  const manager = isManager(actor);
  const courierFilter = manager ? query.courierUserId : actor.userId;
  const now = clockOf(deps)();

  const routes = await deps.db.deliveryRoute.findMany({
    where: {
      state: 'ACTIVE',
      ...(query.routeId === undefined ? {} : { id: query.routeId }),
      ...(courierFilter === undefined ? {} : { courierUserId: courierFilter }),
    },
    orderBy: [{ deliveryDate: 'asc' }, { number: 'asc' }],
    select: {
      id: true,
      number: true,
      deliveryDate: true,
      state: true,
      vehicleType: true,
      courier: { select: { id: true, fullName: true } },
      orders: {
        where: { removedAt: null },
        orderBy: { position: 'asc' },
        select: {
          id: true,
          position: true,
          order: {
            select: {
              id: true,
              externalName: true,
              address: true,
              localAddress: true,
              geoState: true,
              geoLatMicro: true,
              geoLonMicro: true,
              recipient: true,
              comment: true,
              intervalStartMinute: true,
              intervalEndMinute: true,
              manualIntervalStartMinute: true,
              manualIntervalEndMinute: true,
              cashToCollectMinor: true,
              cashCollectable: true,
            },
          },
          attempts: {
            where: { activeKey: { not: null } },
            select: ATTEMPT_SELECT,
          },
        },
      },
    },
  });

  return {
    routes: routes.map((route) => ({
      routeId: route.id,
      number: route.number,
      deliveryDate: moscowCalendarDate(route.deliveryDate),
      state: route.state,
      vehicleType: route.vehicleType,
      courier: route.courier,
      orders: route.orders.map((participation) => {
        const attempt = participation.attempts[0];
        return {
          routeOrderId: participation.id,
          orderId: participation.order.id,
          position: participation.position,
          number: participation.order.externalName,
          address: effectiveAddress(participation.order),
          point: confirmedPoint(participation.order),
          recipient: participation.order.recipient,
          comment: participation.order.comment,
          intervalStartMinute:
            participation.order.manualIntervalStartMinute ??
            participation.order.intervalStartMinute,
          intervalEndMinute:
            participation.order.manualIntervalEndMinute ?? participation.order.intervalEndMinute,
          cashToCollectMinor: participation.order.cashToCollectMinor.toString(),
          cashCollectable: participation.order.cashCollectable,
          result: attempt === undefined ? null : toAttemptView(attempt, actor, now),
        };
      }),
    })),
  };
}

// --- Результат доставки ------------------------------------------------------

export interface RecordResultInput {
  outcome: $Enums.DeliveryOutcome;
  reasonId?: string | undefined;
  comment?: string | undefined;
}

export interface RecordResultView {
  attempt: AttemptView;
  /** Повтор того же результата: новой записи не появилось. */
  unchanged: boolean;
  routeCompleted: boolean;
  remaining: number;
}

/** Сколько активных участий маршрута ещё без действующего результата. */
async function remainingOrders(tx: TransactionClient, routeId: string): Promise<number> {
  return tx.routeOrder.count({
    where: { routeId, removedAt: null, attempts: { none: { activeKey: { not: null } } } },
  });
}

export async function recordDeliveryResult(
  deps: DeliveryDeps,
  actor: AuthenticatedActor,
  routeOrderId: string,
  input: RecordResultInput,
  context: RequestContext,
): Promise<RecordResultView> {
  const now = clockOf(deps)();

  return deps.db.$transaction(async (tx) => {
    const participation = await tx.routeOrder.findUnique({
      where: { id: routeOrderId },
      select: {
        id: true,
        routeId: true,
        orderId: true,
        removedAt: true,
        order: { select: { externalName: true } },
      },
    });
    if (participation === null) {
      throw new AppError('NOT_FOUND', { publicMessage: 'Заказ маршрута не найден.' });
    }

    // Порядок блокировок: маршрут первым.
    await tx.$executeRaw`SELECT id FROM "DeliveryRoute" WHERE id = ${participation.routeId}::uuid FOR UPDATE`;

    const route = await tx.deliveryRoute.findUnique({
      where: { id: participation.routeId },
      select: { id: true, number: true, state: true, version: true, courierUserId: true },
    });
    if (route === null) {
      throw new AppError('NOT_FOUND', { publicMessage: 'Маршрут не найден.' });
    }

    // Кто вообще вправе трогать этот заказ. Проверяется первым: остальные
    // ответы не должны рассказывать чужому человеку о состоянии маршрута.
    if (route.courierUserId !== actor.userId) {
      // Результат сообщает тот, кто вёз. Логист и администратор исправляют
      // чужой результат отдельной операцией, а не подменяют собой курьера.
      throw new AppError('FORBIDDEN', {
        message: 'not the assigned courier',
        publicMessage: 'Результат доставки сообщает назначенный курьер.',
      });
    }

    const existing = await tx.deliveryAttempt.findFirst({
      where: { routeOrderId, activeKey: { not: null } },
      select: ATTEMPT_SELECT,
    });

    const reason = await resolveReason(tx, input);
    const comment = normalizeComment(input.comment);
    assertCommentPresent(reason, comment);

    if (existing !== null) {
      // Повтор потерянного ответа разбирается ДО проверки состояния маршрута.
      //
      // Иначе последний заказ ломал бы идемпотентность: его результат сам
      // переводит маршрут в `COMPLETED`, и честный повтор того же запроса
      // получал бы «маршрут уже завершён» вместо своего же результата.
      const same =
        existing.outcome === input.outcome &&
        existing.reasonId === (reason?.id ?? null) &&
        (existing.comment ?? null) === comment &&
        existing.courierUserId === actor.userId;

      if (same) {
        return {
          attempt: toAttemptView(existing, actor, now),
          unchanged: true,
          routeCompleted: false,
          remaining: await remainingOrders(tx, route.id),
        };
      }

      throw new AppError('CONFLICT', {
        message: 'result already recorded',
        publicMessage: 'У заказа уже есть результат. Обновите экран.',
        conflict: { kind: 'RESULT_ALREADY_RECORDED', routeNumber: route.number },
      });
    }

    // Новый результат: дальше маршрут и участие обязаны быть рабочими.
    if (route.state !== 'ACTIVE') {
      throw new AppError('CONFLICT', {
        message: 'route is not active',
        publicMessage:
          route.state === 'COMPLETED'
            ? 'Маршрут уже завершён.'
            : 'Маршрут ещё не выдан курьеру или отменён.',
        conflict: { kind: 'ROUTE_NOT_ACTIVE', routeNumber: route.number },
      });
    }
    if (participation.removedAt !== null) {
      throw new AppError('CONFLICT', {
        message: 'participation removed',
        publicMessage: 'Заказ больше не входит в этот маршрут.',
        conflict: { kind: 'ORDER_NOT_IN_ROUTE', routeNumber: route.number },
      });
    }

    const created = await tx.deliveryAttempt.create({
      data: {
        routeOrderId,
        orderId: participation.orderId,
        routeId: route.id,
        outcome: input.outcome,
        reasonId: reason?.id ?? null,
        reasonNameSnapshot: reason?.name ?? null,
        comment,
        courierUserId: actor.userId,
        occurredAt: now,
        // Ключ действующей правды. Уникальный индекс по нему — то, что физически
        // не даёт появиться второму результату у этого участия.
        activeKey: routeOrderId,
      },
      select: ATTEMPT_SELECT,
    });

    await writeAudit(tx, {
      action: 'DELIVERY_RESULT_RECORDED',
      entityType: 'DeliveryAttempt',
      entityId: created.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      // Ни адреса, ни получателя, ни комментария, ни текста причины:
      // в аудит уходят идентификаторы и вид результата.
      newValue: {
        routeId: route.id,
        routeOrderId,
        outcome: created.outcome,
        reasonId: created.reasonId,
        hasComment: comment !== null,
      },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishRealtimeEvent(tx, {
      topic: 'delivery.result_recorded',
      payload: { routeId: route.id, routeOrderId, outcome: created.outcome },
      audienceRoles: [...DELIVERY_AUDIENCE],
    });

    /*
     * Денежный факт и начисления.
     *
     * Здесь же, в той самой транзакции, что и результат: иначе между записью
     * доставки и начислением остаётся окно, в котором сумма заказа успевает
     * измениться синхронизацией, и в учёт попадёт не то, что получил курьер.
     */
    await accrueDeliveryResult(tx, await readLedgerActivation(tx as unknown as Database), {
      attemptId: created.id,
      routeOrderId,
      routeId: route.id,
      orderId: participation.orderId,
      courierUserId: actor.userId,
      actorUserId: actor.userId,
      outcome: created.outcome,
    });

    /*
     * Недоставленный заказ не растворяется вместе с маршрутом.
     *
     * В той же транзакции появляются два обязательства: задача решения
     * логиста и физический возврат букета. Иначе завершение маршрута
     * выглядело бы концом истории, хотя товар остаётся в машине курьера
     * и решать его судьбу ещё некому.
     */
    if (created.outcome === 'NOT_DELIVERED') {
      await openAfterFailedDelivery(tx, {
        attemptId: created.id,
        orderId: participation.orderId,
        routeOrderId,
        courierUserId: actor.userId,
        reasonNameSnapshot: created.reasonNameSnapshot ?? 'Причина не указана',
        now,
      });
    }

    const remaining = await remainingOrders(tx, route.id);
    const completed = remaining === 0;

    if (completed) {
      await completeRoute(tx, { route, actor, context, now });
    }

    return {
      attempt: toAttemptView(created, actor, now),
      unchanged: false,
      routeCompleted: completed,
      remaining,
    };
  });
}

/** Причина обязательна ровно при «Не доставлен» и обязана быть активной. */
async function resolveReason(
  tx: TransactionClient,
  input: RecordResultInput,
): Promise<{ id: string; name: string; requiresComment: boolean } | null> {
  if (input.outcome === 'DELIVERED') {
    if (input.reasonId !== undefined) {
      throw new AppError('VALIDATION_FAILED', {
        publicMessage: 'У доставленного заказа причины не бывает.',
      });
    }
    return null;
  }

  if (input.reasonId === undefined) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: 'Для недоставки нужно выбрать причину.',
    });
  }

  const reason = await tx.deliveryFailureReason.findUnique({
    where: { id: input.reasonId },
    select: { id: true, name: true, requiresComment: true, isActive: true },
  });
  if (reason === null || !reason.isActive) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: 'Причина недоступна. Обновите список причин.',
    });
  }

  return { id: reason.id, name: reason.name, requiresComment: reason.requiresComment };
}

function normalizeComment(comment: string | undefined): string | null {
  if (comment === undefined) return null;
  const trimmed = comment.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Комментарий при недоставке.
 *
 * Обязателен только там, где причина сама этого требует (`requiresComment` —
 * сейчас это «Другое»). Курьер сообщает результат у двери, и лишнее поле там
 * стоит времени: причина из справочника отвечает на вопрос «что случилось»
 * точнее свободного текста и позволяет считать статистику.
 *
 * Правило «комментарий обязателен при любой причине» существовало 17.08.2026
 * несколько часов и отменено владельцем вместе с самим полем комментария.
 * Проверка остаётся: причина, требующая пояснения, без него не принимается,
 * даже если такой запрос придёт мимо интерфейса.
 */
function assertCommentPresent(
  reason: { requiresComment: boolean } | null,
  comment: string | null,
): void {
  if (reason !== null && reason.requiresComment && comment === null) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: 'Для этой причины нужен комментарий.',
    });
  }
}

/** Переводит маршрут `ACTIVE → COMPLETED` вместе с переходом, аудитом и событием. */
async function completeRoute(
  tx: TransactionClient,
  params: {
    route: { id: string; number: string; version: number };
    actor: AuthenticatedActor;
    context: RequestContext;
    now: Date;
  },
): Promise<void> {
  const { route, actor, context, now } = params;

  const updated = await tx.deliveryRoute.updateMany({
    where: { id: route.id, version: route.version, state: 'ACTIVE' },
    data: { state: 'COMPLETED', version: { increment: 1 } },
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
      fromState: 'ACTIVE',
      toState: 'COMPLETED',
      actorUserId: actor.userId,
      occurredAt: now,
      // Причины нет намеренно: завершение наступает от факта последнего
      // результата, а не от решения человека.
      reason: null,
    },
  });

  await writeAudit(tx, {
    action: 'ROUTE_COMPLETED',
    entityType: 'DeliveryRoute',
    entityId: route.id,
    actorUserId: actor.userId,
    actorRoles: actor.roles,
    source: 'api',
    oldValue: { state: 'ACTIVE', version: route.version },
    newValue: { state: 'COMPLETED', version: route.version + 1 },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  await publishRealtimeEvent(tx, {
    topic: 'route.completed',
    payload: { routeId: route.id, state: 'COMPLETED' },
    audienceRoles: [...DELIVERY_AUDIENCE],
  });
}

// --- Отмена результата -------------------------------------------------------

export interface CancelResultInput {
  reason?: string | undefined;
}

export interface CancelResultView {
  attemptId: string;
  kind: $Enums.DeliveryAttemptCancelKind;
  routeReopened: boolean;
  remaining: number;
}

/**
 * Отменяет действующий результат.
 *
 * Курьер — только собственный и только в пятиминутном окне. Логист
 * и администратор — любой, но обязательно с причиной. Сама попытка при этом
 * не переписывается: снимается лишь технический ключ действующей правды,
 * а отмена появляется отдельной связанной записью.
 */
export async function cancelDeliveryResult(
  deps: DeliveryDeps,
  actor: AuthenticatedActor,
  attemptId: string,
  input: CancelResultInput,
  context: RequestContext,
): Promise<CancelResultView> {
  const now = clockOf(deps)();

  return deps.db.$transaction(async (tx) => {
    const attempt = await tx.deliveryAttempt.findUnique({
      where: { id: attemptId },
      select: {
        id: true,
        routeId: true,
        routeOrderId: true,
        courierUserId: true,
        occurredAt: true,
        activeKey: true,
        outcome: true,
      },
    });
    if (attempt === null) {
      throw new AppError('NOT_FOUND', { publicMessage: 'Результат не найден.' });
    }

    await tx.$executeRaw`SELECT id FROM "DeliveryRoute" WHERE id = ${attempt.routeId}::uuid FOR UPDATE`;

    if (attempt.activeKey === null) {
      throw new AppError('CONFLICT', {
        message: 'attempt already cancelled',
        publicMessage: 'Этот результат уже отменён.',
        conflict: { kind: 'RESULT_ALREADY_CANCELLED' },
      });
    }

    const manager = isManager(actor);
    const own = attempt.courierUserId === actor.userId;
    const inWindow = now.getTime() - attempt.occurredAt.getTime() <= DELIVERY_CANCEL_WINDOW_MS;

    let kind: $Enums.DeliveryAttemptCancelKind;
    let reason: string | null = null;

    if (manager) {
      kind = 'MANAGER_CORRECTION';
      reason = normalizeComment(input.reason);
      if (reason === null) {
        throw new AppError('VALIDATION_FAILED', {
          publicMessage: 'Исправление чужого результата требует причины.',
        });
      }
    } else if (own && inWindow) {
      kind = 'COURIER_SELF';
    } else if (own) {
      throw new AppError('CONFLICT', {
        message: 'cancel window expired',
        publicMessage: 'Прошло больше пяти минут. Исправление выполняет логист.',
        conflict: { kind: 'CANCEL_WINDOW_EXPIRED' },
      });
    } else {
      throw new AppError('FORBIDDEN', {
        message: 'not own result',
        publicMessage: 'Чужой результат курьер отменить не может.',
      });
    }

    await tx.deliveryAttemptCancellation.create({
      data: { attemptId, kind, reason, actorUserId: actor.userId, occurredAt: now },
    });

    // Снимается только технический ключ: содержимое попытки остаётся прежним,
    // и триггер базы это подтверждает.
    await tx.deliveryAttempt.update({ where: { id: attemptId }, data: { activeKey: null } });

    /*
     * Деньги отменённой доставки.
     *
     * Начисления не удаляются: у каждого появляется связанная обратная запись
     * с причиной. По учёту видно и то, что деньги начислялись, и то, почему
     * их сняли — это и есть требование неизменяемости.
     */
    /*
     * Отмена результата закрывает и обязательства.
     *
     * Ошибка кнопкой возвратом не является: букет никуда не ехал. Записи
     * не удаляются — закрываются связанной операцией, и история недоставки
     * остаётся видимой.
     */
    await closeAfterCancelledResult(tx, {
      attemptId,
      actorUserId: actor.userId,
      now,
    });

    await reverseDeliveryAccruals(tx, {
      attemptId,
      actorUserId: actor.userId,
      reason: reason ?? 'Отмена результата доставки',
      operationDate: moscowCalendarDate(now),
    });

    const route = await tx.deliveryRoute.findUnique({
      where: { id: attempt.routeId },
      select: { id: true, number: true, state: true, version: true },
    });

    let reopened = false;
    if (route !== null && route.state === 'COMPLETED') {
      // Заказ снова открыт — значит маршрут завершённым больше не является.
      const updated = await tx.deliveryRoute.updateMany({
        where: { id: route.id, version: route.version, state: 'COMPLETED' },
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
          fromState: 'COMPLETED',
          toState: 'ACTIVE',
          actorUserId: actor.userId,
          occurredAt: now,
          // Причина живёт в связанной записи отмены: второй источник правды
          // рано или поздно разошёлся бы с первым.
          reason: null,
        },
      });
      reopened = true;
    }

    await writeAudit(tx, {
      action: kind === 'COURIER_SELF' ? 'DELIVERY_RESULT_CANCELLED' : 'DELIVERY_RESULT_CORRECTED',
      entityType: 'DeliveryAttempt',
      entityId: attemptId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      oldValue: { outcome: attempt.outcome, active: true },
      // Текст причины исправления в аудит не уходит: там может оказаться что
      // угодно, включая данные клиента.
      newValue: { active: false, kind, routeReopened: reopened, hasReason: reason !== null },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishRealtimeEvent(tx, {
      topic: 'delivery.result_cancelled',
      payload: { routeId: attempt.routeId, routeOrderId: attempt.routeOrderId, kind },
      audienceRoles: [...DELIVERY_AUDIENCE],
    });

    return {
      attemptId,
      kind,
      routeReopened: reopened,
      remaining: await remainingOrders(tx, attempt.routeId),
    };
  });
}

// --- История -----------------------------------------------------------------

export interface HistoryItem {
  attemptId: string;
  orderNumber: string;
  routeNumber: string;
  outcome: $Enums.DeliveryOutcome;
  reasonName: string | null;
  occurredAt: Date;
  cancelled: boolean;
  /** Скрыты ли персональные поля: со следующего московского дня — да. */
  masked: boolean;
  address: string | null;
  recipient: string | null;
  comment: string | null;
}

export interface HistoryQuery {
  /** Календарный день Москвы. По умолчанию — сегодняшний. */
  date?: string | undefined;
  courierUserId?: string | undefined;
}

/**
 * История результатов.
 *
 * Курьер видит только собственные. Со СЛЕДУЮЩЕГО московского дня персональные
 * поля скрываются: доставка завершена, и адрес с получателем в кармане курьера
 * больше не нужны. Граница считается по московскому календарю, а не по часовому
 * поясу устройства или сервера, — иначе один и тот же результат маскировался бы
 * по-разному у разных людей.
 */
export async function listDeliveryHistory(
  deps: DeliveryDeps,
  actor: AuthenticatedActor,
  query: HistoryQuery = {},
): Promise<{ items: HistoryItem[]; date: string; today: string }> {
  const now = clockOf(deps)();
  const today = moscowCalendarDate(now);
  const date = query.date ?? today;
  const manager = isManager(actor);
  const courierFilter = manager ? query.courierUserId : actor.userId;

  const rows = await deps.db.deliveryAttempt.findMany({
    where: {
      ...(courierFilter === undefined ? {} : { courierUserId: courierFilter }),
      route: { deliveryDate: new Date(`${date}T00:00:00.000Z`) },
    },
    orderBy: [{ occurredAt: 'desc' }],
    select: {
      id: true,
      outcome: true,
      reasonNameSnapshot: true,
      comment: true,
      occurredAt: true,
      cancellation: { select: { id: true } },
      route: { select: { number: true } },
      order: {
        select: { externalName: true, address: true, localAddress: true, recipient: true },
      },
    },
  });

  // Маскирование считается один раз для всего дня: результат не должен
  // зависеть от того, в какую секунду читается строка.
  const masked = !manager && date !== today;

  return {
    date,
    today,
    items: rows.map((row) => ({
      attemptId: row.id,
      orderNumber: row.order.externalName,
      routeNumber: row.route.number,
      outcome: row.outcome,
      reasonName: row.reasonNameSnapshot,
      occurredAt: row.occurredAt,
      cancelled: row.cancellation !== null,
      masked,
      // Тот же рабочий адрес, что видел курьер в «Активных».
      address: masked ? null : effectiveAddress(row.order),
      recipient: masked ? null : row.order.recipient,
      comment: masked ? null : row.comment,
    })),
  };
}
