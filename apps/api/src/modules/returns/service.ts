/**
 * Недоставленный заказ: решение логиста и физический возврат букета.
 *
 * Два разных вопроса, поэтому две разные записи.
 *
 *  * ЧТО ДЕЛАТЬ с заказом — решает логист: отменить или везти снова.
 *    Это `OrderResolution`.
 *  * ГДЕ СЕЙЧАС БУКЕТ — отвечает физический мир: он у курьера, пока склад
 *    не принял его в ячейку. Это `OrderReturn`.
 *
 * Разделение не формальность. Логист может решить «везти снова» через минуту
 * после отказа, но букет всё это время лежит в машине, и заказ нельзя ставить
 * в новый маршрут, пока его не приняли. Раньше недоставленный заказ исчезал
 * из работы вместе с завершением маршрута — за букет не отвечал никто.
 *
 * Обе записи неизменяемы по сути: решение фиксируется один раз, переходы
 * возврата только добавляются. Активная задача и активный возврат уникальны
 * на заказ — это закрыто индексами базы, а не проверками в коде.
 */

import type { $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { effectiveAddress } from '../orders/address.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';

/**
 * Кому адресованы события возврата.
 *
 * Все трое участвуют в одном движении: курьер везёт, склад принимает, логист
 * решает. Событие не несёт ни адреса, ни получателя — только повод перечитать
 * собственный список.
 */
const RETURN_AUDIENCE = ['ADMIN', 'LOGISTICIAN', 'WAREHOUSE', 'COURIER'] as const;

export interface ReturnDeps {
  db: Database;
  now?: () => Date;
}

function clockOf(deps: ReturnDeps): () => Date {
  return deps.now ?? (() => new Date());
}

/**
 * Открывает задачу решения и возврат после недоставки.
 *
 * Вызывается ВНУТРИ транзакции результата доставки: иначе между записью
 * результата и появлением обязательства остаётся окно, в котором заказ
 * не принадлежит никому.
 *
 * Повтор того же результата сюда не доходит — идемпотентность разбирается
 * выше, — но `attemptId` всё равно уникален: одна попытка порождает ровно
 * одну задачу и ровно один возврат.
 */
export async function openAfterFailedDelivery(
  tx: TransactionClient,
  input: {
    attemptId: string;
    orderId: string;
    routeOrderId: string;
    courierUserId: string;
    reasonNameSnapshot: string;
    now: Date;
  },
): Promise<{ resolutionId: string; returnId: string }> {
  const resolution = await tx.orderResolution.create({
    data: {
      orderId: input.orderId,
      routeOrderId: input.routeOrderId,
      attemptId: input.attemptId,
      reasonNameSnapshot: input.reasonNameSnapshot,
      createdAt: input.now,
      // Активная задача помечается идентификатором заказа: второй такой
      // строки база не примет.
      activeKey: input.orderId,
    },
    select: { id: true },
  });

  const created = await tx.orderReturn.create({
    data: {
      orderId: input.orderId,
      routeOrderId: input.routeOrderId,
      attemptId: input.attemptId,
      courierUserId: input.courierUserId,
      state: 'WITH_COURIER',
      createdAt: input.now,
      activeKey: input.orderId,
    },
    select: { id: true },
  });

  await tx.orderReturnTransition.create({
    data: {
      returnId: created.id,
      fromState: 'WITH_COURIER',
      toState: 'WITH_COURIER',
      occurredAt: input.now,
      actorUserId: input.courierUserId,
      reason: 'Заказ не доставлен: букет остаётся у курьера',
    },
  });

  await publishReturnEvent(tx, 'order.return_changed', input.orderId);

  return { resolutionId: resolution.id, returnId: created.id };
}

/**
 * Закрывает задачу и возврат при отмене ошибочного результата.
 *
 * Отмена результата в течение пяти минут — это «курьер ошибся кнопкой»,
 * а не возврат: букет никуда не ехал. Записи не удаляются, а закрываются
 * связанной операцией — история недоставки остаётся видимой.
 */
export async function closeAfterCancelledResult(
  tx: TransactionClient,
  input: { attemptId: string; actorUserId: string; now: Date },
): Promise<void> {
  const resolution = await tx.orderResolution.findUnique({
    where: { attemptId: input.attemptId },
    select: { id: true, orderId: true, activeKey: true },
  });

  if (resolution !== null && resolution.activeKey !== null) {
    await tx.orderResolution.update({
      where: { id: resolution.id },
      data: {
        activeKey: null,
        closedAt: input.now,
        closedReason: 'Результат доставки отменён',
      },
    });
  }

  const existing = await tx.orderReturn.findUnique({
    where: { attemptId: input.attemptId },
    select: { id: true, orderId: true, state: true },
  });

  if (existing === null) {
    return;
  }

  if (existing.state === 'ACCEPTED') {
    /*
     * Склад уже принял букет.
     *
     * Отмена результата доставки физическое место не меняет: заказ лежит
     * в ячейке, и «развернуть» приёмку задним числом значило бы соврать
     * о местонахождении товара.
     */
    throw new AppError('CONFLICT', {
      message: 'return already accepted',
      publicMessage: 'Склад уже принял возврат: результат доставки отменить нельзя.',
      conflict: { kind: 'RETURN_ALREADY_ACCEPTED' },
    });
  }

  if (existing.state === 'CANCELLED') {
    return;
  }

  await tx.orderReturn.update({
    where: { id: existing.id },
    data: { state: 'CANCELLED', activeKey: null },
  });
  await tx.orderReturnTransition.create({
    data: {
      returnId: existing.id,
      fromState: existing.state,
      toState: 'CANCELLED',
      occurredAt: input.now,
      actorUserId: input.actorUserId,
      reason: 'Результат доставки отменён',
    },
  });

  await publishReturnEvent(tx, 'order.return_changed', existing.orderId);
}

/** Событие без персональных данных: клиент перечитывает свой список сам. */
async function publishReturnEvent(
  tx: TransactionClient,
  topic: 'order.return_changed' | 'order.resolution_changed',
  orderId: string,
): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic,
    payload: { orderId },
    audienceRoles: [...RETURN_AUDIENCE],
  });
}

// --- Решения логиста ---------------------------------------------------------

export interface ResolutionView {
  id: string;
  orderId: string;
  orderNumber: string;
  /** Рабочий адрес: тот же, что видел курьер. */
  address: string | null;
  routeNumber: string | null;
  courier: { id: string; fullName: string } | null;
  reasonName: string;
  failedAt: string;
  returnState: $Enums.OrderReturnState | null;
  decision: $Enums.OrderResolutionDecision | null;
  decidedAt: string | null;
  decidedBy: string | null;
}

/** Сколько заказов ждут решения логиста. Считает база, а не страница. */
export async function countUnresolved(db: Database): Promise<number> {
  return db.orderResolution.count({ where: { activeKey: { not: null } } });
}

export async function listResolutions(
  db: Database,
  query: { limit: number; offset: number; includeDecided?: boolean | undefined },
): Promise<{ items: ResolutionView[]; total: number; unresolved: number }> {
  const where = query.includeDecided === true ? {} : { activeKey: { not: null } };

  const [rows, total, unresolved] = await Promise.all([
    db.orderResolution.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      take: query.limit,
      skip: query.offset,
      select: {
        id: true,
        orderId: true,
        reasonNameSnapshot: true,
        createdAt: true,
        decision: true,
        decidedAt: true,
        decidedBy: { select: { fullName: true } },
        order: {
          select: {
            externalName: true,
            address: true,
            localAddress: true,
            returns: { select: { state: true, createdAt: true } },
          },
        },
        routeOrder: {
          select: {
            route: { select: { number: true, courier: { select: { id: true, fullName: true } } } },
          },
        },
        attempt: { select: { occurredAt: true } },
      },
    }),
    db.orderResolution.count({ where }),
    countUnresolved(db),
  ]);

  return {
    items: rows.map((row) => {
      // Состояние возврата берётся у самого свежего: прошлые попытки того же
      // заказа остаются историей и текущим обязательством не являются.
      const latest = [...row.order.returns].sort(
        (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
      )[0];

      return {
        id: row.id,
        orderId: row.orderId,
        orderNumber: row.order.externalName,
        address: effectiveAddress(row.order),
        routeNumber: row.routeOrder.route.number,
        courier: row.routeOrder.route.courier,
        reasonName: row.reasonNameSnapshot,
        failedAt: row.attempt.occurredAt.toISOString(),
        returnState: latest?.state ?? null,
        decision: row.decision,
        decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
        decidedBy: row.decidedBy?.fullName ?? null,
      };
    }),
    total,
    unresolved,
  };
}

/**
 * Блокирует задачу и проверяет, что она ещё не решена.
 *
 * Два логиста могут открыть список одновременно. Побеждает первый; второй
 * получает названный конфликт, а не молчаливую перезапись чужого решения.
 */
async function lockPending(
  tx: TransactionClient,
  resolutionId: string,
): Promise<{ id: string; orderId: string; routeOrderId: string }> {
  await tx.$executeRaw`SELECT "id" FROM "OrderResolution" WHERE "id" = ${resolutionId}::uuid FOR UPDATE`;

  const row = await tx.orderResolution.findUnique({
    where: { id: resolutionId },
    select: { id: true, orderId: true, routeOrderId: true, activeKey: true, decision: true },
  });

  if (row === null) {
    throw new AppError('NOT_FOUND', { publicMessage: 'Задача не найдена.' });
  }
  if (row.activeKey === null || row.decision !== null) {
    throw new AppError('CONFLICT', {
      message: 'resolution already decided',
      publicMessage: 'Решение по этому заказу уже принято. Обновите список.',
      conflict: { kind: 'RESOLUTION_ALREADY_DECIDED' },
    });
  }

  return { id: row.id, orderId: row.orderId, routeOrderId: row.routeOrderId };
}

export interface DecisionResult {
  orderId: string;
  decision: $Enums.OrderResolutionDecision;
}

/**
 * «Отменить заказ».
 *
 * Заказ помечается отменённым у нас и ставится в очередь на смену статуса
 * в МоемСкладе. Физическое место букета при этом не меняется: он либо ещё
 * у курьера, либо уже в ячейке — и остаётся там до действий склада.
 */
export async function decideCancel(
  deps: ReturnDeps,
  actor: AuthenticatedActor,
  resolutionId: string,
  context: { ip: string | null; userAgent: string | null },
): Promise<DecisionResult> {
  const now = clockOf(deps)();

  return deps.db.$transaction(async (tx) => {
    const task = await lockPending(tx, resolutionId);

    await tx.orderResolution.update({
      where: { id: task.id },
      data: {
        decision: 'CANCELLED',
        decidedAt: now,
        decidedById: actor.userId,
        activeKey: null,
        closedAt: now,
      },
    });

    await tx.deliveryOrder.update({
      where: { id: task.orderId },
      data: { cancelledByLogistAt: now, cancelledByLogistById: actor.userId },
    });

    await writeAudit(tx, {
      action: 'ORDER_CANCELLED_BY_LOGIST',
      entityType: 'DeliveryOrder',
      entityId: task.orderId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      newValue: { resolutionId: task.id, decision: 'CANCELLED' },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishReturnEvent(tx, 'order.resolution_changed', task.orderId);

    return { orderId: task.orderId, decision: 'CANCELLED' as const };
  });
}

/**
 * «Повторно доставить».
 *
 * Заказ возвращается в «Сделки», но выбрать его нельзя, пока склад не принял
 * букет: маршрут из товара, лежащего в чужой машине, — это обещание, которое
 * некому выполнить. Прежние курьер, флорист и маршрут не восстанавливаются:
 * их выбирают заново.
 */
export async function decideRedeliver(
  deps: ReturnDeps,
  actor: AuthenticatedActor,
  resolutionId: string,
  context: { ip: string | null; userAgent: string | null },
): Promise<DecisionResult> {
  const now = clockOf(deps)();

  return deps.db.$transaction(async (tx) => {
    const task = await lockPending(tx, resolutionId);

    await tx.orderResolution.update({
      where: { id: task.id },
      data: {
        decision: 'REDELIVER',
        decidedAt: now,
        decidedById: actor.userId,
        activeKey: null,
        closedAt: now,
      },
    });

    await writeAudit(tx, {
      action: 'ORDER_REDELIVERY_REQUESTED',
      entityType: 'DeliveryOrder',
      entityId: task.orderId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      newValue: { resolutionId: task.id, decision: 'REDELIVER' },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishReturnEvent(tx, 'order.resolution_changed', task.orderId);

    return { orderId: task.orderId, decision: 'REDELIVER' as const };
  });
}

// --- Возврат -----------------------------------------------------------------

/** Курьер объявил, что везёт заказ на склад. Повтор ничего не меняет. */
export async function markReturning(
  deps: ReturnDeps,
  actor: AuthenticatedActor,
  orderId: string,
): Promise<{ state: $Enums.OrderReturnState }> {
  const now = clockOf(deps)();

  return deps.db.$transaction(async (tx) => {
    const existing = await tx.orderReturn.findUnique({
      where: { activeKey: orderId },
      select: { id: true, state: true, courierUserId: true },
    });

    if (existing === null) {
      throw new AppError('NOT_FOUND', { publicMessage: 'Активного возврата у этого заказа нет.' });
    }
    if (existing.courierUserId !== actor.userId && !actor.roles.includes('ADMIN')) {
      throw new AppError('FORBIDDEN', {
        message: 'foreign return',
        publicMessage: 'Этот возврат числится за другим курьером.',
      });
    }
    // Повтор запроса — то же состояние, а не вторая запись.
    if (existing.state === 'RETURNING') {
      return { state: existing.state };
    }

    await tx.orderReturn.update({ where: { id: existing.id }, data: { state: 'RETURNING' } });
    await tx.orderReturnTransition.create({
      data: {
        returnId: existing.id,
        fromState: existing.state,
        toState: 'RETURNING',
        occurredAt: now,
        actorUserId: actor.userId,
      },
    });

    await publishReturnEvent(tx, 'order.return_changed', orderId);
    return { state: 'RETURNING' as const };
  });
}

// --- Приёмка возврата складом ------------------------------------------------

export interface AcceptReturnInput {
  /** Номер заказа со скана. */
  orderNumber: string;
  /** Код обычной ячейки хранения со скана. */
  cellCode: string;
}

export interface AcceptReturnResult {
  orderId: string;
  orderNumber: string;
  cellCode: string;
  placementId: string;
  /** Что решил логист к моменту приёмки: от этого зависит судьба букета. */
  decision: $Enums.OrderResolutionDecision | null;
  cancelled: boolean;
  unchanged: boolean;
}

/**
 * Склад принял возврат и положил букет в ячейку.
 *
 * Одна атомарная запись: приёмка без размещения означала бы товар, который
 * «как бы вернули», но найти его нельзя. Именно это действие — и только оно —
 * снимает обязательство с курьера: ни решение логиста, ни завершение маршрута,
 * ни отмена в МоемСкладе физическое место букета не меняют.
 */
export async function acceptReturn(
  deps: ReturnDeps,
  actor: AuthenticatedActor,
  input: AcceptReturnInput,
  context: { ip: string | null; userAgent: string | null },
): Promise<AcceptReturnResult> {
  const now = clockOf(deps)();
  const number = input.orderNumber.trim();
  const code = input.cellCode.trim().toUpperCase();

  return deps.db.$transaction(async (tx) => {
    const order = await tx.deliveryOrder.findFirst({
      where: { externalName: number },
      select: {
        id: true,
        externalName: true,
        cancelledInSource: true,
        cancelledByLogistAt: true,
      },
    });
    if (order === null) {
      throw new AppError('NOT_FOUND', { publicMessage: 'Заказ с таким номером не найден.' });
    }

    await tx.$executeRaw`SELECT "id" FROM "DeliveryOrder" WHERE "id" = ${order.id}::uuid FOR UPDATE`;

    const active = await tx.orderReturn.findUnique({
      where: { activeKey: order.id },
      select: { id: true, state: true, courierUserId: true, routeOrderId: true },
    });
    if (active === null) {
      /*
       * Возврата нет — принимать нечего.
       *
       * Это не придирка к порядку действий: заказ без активного возврата
       * либо никогда не уезжал, либо уже принят, и «принять» его второй раз
       * значит записать движение товара, которого не было.
       */
      const accepted = await tx.orderReturn.findFirst({
        where: { orderId: order.id, state: 'ACCEPTED' },
        orderBy: { acceptedAt: 'desc' },
        select: { placementId: true },
      });
      if (accepted?.placementId !== undefined && accepted.placementId !== null) {
        const placement = await tx.orderPlacement.findUnique({
          where: { id: accepted.placementId },
          select: { id: true, cell: { select: { code: true } } },
        });
        // Повтор того же скана: отвечаем прежней приёмкой, а не отказом.
        if (placement !== null && placement.cell.code === code) {
          return {
            orderId: order.id,
            orderNumber: order.externalName,
            cellCode: placement.cell.code,
            placementId: placement.id,
            decision: null,
            cancelled: order.cancelledInSource || order.cancelledByLogistAt !== null,
            unchanged: true,
          };
        }
        /*
         * Тот же заказ, но другая ячейка: букет уже принят и лежит на месте.
         *
         * Кладовщику важно услышать не «возврата нет», а где товар сейчас:
         * иначе он будет искать причину отказа вместо того, чтобы забрать
         * заказ из названной ячейки.
         */
        if (placement !== null) {
          throw new AppError('CONFLICT', {
            message: 'return already accepted into another cell',
            publicMessage: `Возврат уже принят в ячейку ${placement.cell.code}.`,
            conflict: { kind: 'ORDER_ALREADY_PLACED' },
          });
        }
      }

      throw new AppError('CONFLICT', {
        message: 'no active return',
        publicMessage: 'У этого заказа нет активного возврата от курьера.',
        conflict: { kind: 'RETURN_NOT_FOUND' },
      });
    }

    const cell = await tx.storageCell.findFirst({
      where: { normalizedCode: code },
      select: { id: true, code: true, kind: true, isActive: true },
    });
    if (cell === null) {
      throw new AppError('NOT_FOUND', { publicMessage: 'Ячейка с таким кодом не найдена.' });
    }
    if (!cell.isActive) {
      throw new AppError('CONFLICT', {
        message: 'cell is not active',
        publicMessage: 'Ячейка выведена из работы. Возьмите другую.',
        conflict: { kind: 'CELL_INACTIVE' },
      });
    }
    if (cell.kind !== 'STORAGE') {
      /*
       * Возврат кладётся в обычное хранение, а не в маршрутную ячейку.
       *
       * Маршрутная ячейка означает «готово к выдаче курьеру», и вернувшийся
       * букет там выглядел бы как собранный к отправке заказ.
       */
      throw new AppError('CONFLICT', {
        message: 'return requires storage cell',
        publicMessage: 'Возврат кладётся в обычную ячейку хранения, а не в маршрутную.',
        conflict: { kind: 'CELL_KIND_MISMATCH' },
      });
    }

    const occupied = await tx.orderPlacement.findFirst({
      where: { orderId: order.id, releasedAt: null },
      select: { id: true },
    });
    if (occupied !== null) {
      throw new AppError('CONFLICT', {
        message: 'order already placed',
        publicMessage: 'Заказ уже числится в ячейке. Сначала разберитесь с прежним размещением.',
        conflict: { kind: 'ORDER_ALREADY_PLACED' },
      });
    }

    const placement = await tx.orderPlacement.create({
      data: {
        orderId: order.id,
        cellId: cell.id,
        source: 'COURIER_RETURN',
        placedAt: now,
        placedById: actor.userId,
      },
      select: { id: true },
    });

    await tx.orderReturn.update({
      where: { id: active.id },
      data: {
        state: 'ACCEPTED',
        acceptedAt: now,
        acceptedById: actor.userId,
        placementId: placement.id,
        activeKey: null,
      },
    });
    await tx.orderReturnTransition.create({
      data: {
        returnId: active.id,
        fromState: active.state,
        toState: 'ACCEPTED',
        occurredAt: now,
        actorUserId: actor.userId,
      },
    });

    const resolution = await tx.orderResolution.findFirst({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
      select: { decision: true },
    });

    await writeAudit(tx, {
      action: 'ORDER_RETURN_ACCEPTED',
      entityType: 'OrderReturn',
      entityId: active.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      newValue: { orderId: order.id, cellId: cell.id, placementId: placement.id },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishReturnEvent(tx, 'order.return_changed', order.id);

    return {
      orderId: order.id,
      orderNumber: order.externalName,
      cellCode: cell.code,
      placementId: placement.id,
      decision: resolution?.decision ?? null,
      cancelled: order.cancelledInSource || order.cancelledByLogistAt !== null,
      unchanged: false,
    };
  });
}

/** Возвраты, которые склад ещё не принял. Компактная очередь режима «Возвраты». */
export interface WarehouseReturnView {
  orderId: string;
  orderNumber: string;
  state: $Enums.OrderReturnState;
  courier: string | null;
  reasonName: string;
  decision: $Enums.OrderResolutionDecision | null;
  /** Отменённый заказ выдавать нельзя — склад обязан это видеть. */
  cancelled: boolean;
  /** Куда принят. У ожидающих пусто. */
  cellCode: string | null;
  acceptedAt: string | null;
}

const WAREHOUSE_RETURN_SELECT = {
  orderId: true,
  state: true,
  acceptedAt: true,
  courier: { select: { fullName: true } },
  attempt: { select: { reasonNameSnapshot: true } },
  placement: { select: { cell: { select: { code: true } } } },
  order: {
    select: {
      externalName: true,
      cancelledInSource: true,
      cancelledByLogistAt: true,
      resolutions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { decision: true },
      },
    },
  },
} as const;

interface WarehouseReturnRow {
  orderId: string;
  state: $Enums.OrderReturnState;
  acceptedAt: Date | null;
  courier: { fullName: string } | null;
  attempt: { reasonNameSnapshot: string | null };
  placement: { cell: { code: string } } | null;
  order: {
    externalName: string;
    cancelledInSource: boolean;
    cancelledByLogistAt: Date | null;
    resolutions: { decision: $Enums.OrderResolutionDecision | null }[];
  };
}

function warehouseReturnView(row: WarehouseReturnRow): WarehouseReturnView {
  return {
    orderId: row.orderId,
    orderNumber: row.order.externalName,
    state: row.state,
    courier: row.courier?.fullName ?? null,
    reasonName: row.attempt.reasonNameSnapshot ?? 'Причина не указана',
    decision: row.order.resolutions[0]?.decision ?? null,
    cancelled: row.order.cancelledInSource || row.order.cancelledByLogistAt !== null,
    cellCode: row.placement?.cell.code ?? null,
    acceptedAt: row.acceptedAt === null ? null : row.acceptedAt.toISOString(),
  };
}

/** Возвраты, которых склад ещё ждёт. */
export async function listPendingReturns(db: Database): Promise<WarehouseReturnView[]> {
  const rows = await db.orderReturn.findMany({
    where: { activeKey: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: WAREHOUSE_RETURN_SELECT,
  });
  return rows.map(warehouseReturnView);
}

/**
 * Недавно принятые возвраты.
 *
 * Кладовщику нужен не только список ожидаемого, но и подтверждение того, что
 * он уже принял: иначе после скана заказ исчезает с экрана и остаётся
 * непонятным, записалась приёмка или нет.
 */
export async function listAcceptedReturns(
  db: Database,
  limit = 30,
): Promise<WarehouseReturnView[]> {
  const rows = await db.orderReturn.findMany({
    where: { state: 'ACCEPTED' },
    orderBy: { acceptedAt: 'desc' },
    take: limit,
    select: WAREHOUSE_RETURN_SELECT,
  });
  return rows.map(warehouseReturnView);
}

/** Активный возврат заказа: нужен «Активным» курьера и «Сделкам» логиста. */
export async function activeReturnsOf(
  db: Database,
  orderIds: readonly string[],
): Promise<Map<string, $Enums.OrderReturnState>> {
  if (orderIds.length === 0) {
    return new Map();
  }
  const rows = await db.orderReturn.findMany({
    where: { orderId: { in: [...orderIds] }, activeKey: { not: null } },
    select: { orderId: true, state: true },
  });
  return new Map(rows.map((row) => [row.orderId, row.state]));
}
