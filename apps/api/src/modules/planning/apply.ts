/**
 * Применение превью: превращение плана в черновики.
 *
 * Вторая фаза планирования и единственное место, где план становится данными.
 * До неё в системе нет ни одного маршрута — есть только неизменяемое
 * предложение.
 *
 * ПОРЯДОК БЛОКИРОВОК:
 *   RoutePlanRun (FOR UPDATE)          ← первым: он определяет саму операцию
 *   → DeliveryOrder (FOR UPDATE, ORDER BY id)
 *   → Depot (FOR UPDATE, ORDER BY id)
 *   → RouteNumberCounter (через nextRouteNumber)
 *   → DeliveryRoute, RouteOrder (вставка)
 *   → AuditLog → RealtimeEvent
 *
 * Сортировка по UUID обязательна: без неё два применения, задевающие одни
 * и те же заказы, взяли бы их в разном порядке и встали бы намертво.
 *
 * ПОВТОРНАЯ ПРОВЕРКА ВХОДА. Между расчётом и применением проходит время:
 * заказ мог поменять адрес, попасть в ручной маршрут, потерять точку; склад
 * мог переехать; смена — измениться; курьера могли заморозить. Любое
 * расхождение со снимком означает, что применяется план, посчитанный
 * для другой действительности.
 *
 * В этом случае превью помечается истёкшим ОТДЕЛЬНЫМ УСПЕШНЫМ завершением
 * транзакции, и только затем возвращается 409. Исключение внутри транзакции
 * откатило бы и сам переход в EXPIRED — превью осталось бы «готовым»,
 * и следующая попытка применения повторила бы ту же проверку с тем же итогом.
 *
 * ИДЕМПОТЕНТНОСТЬ. Повторное применение уже применённого запуска возвращает
 * созданные им черновики, а не создаёт вторые. Гарантия держится не только
 * состоянием: `DeliveryRoute.planVehicleSlotId` уникален, поэтому второй
 * маршрут из того же слота физически невозможен.
 */

import { Prisma, type $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { nextRouteNumber } from '../routing/numbering.js';
import { lockDepotRows } from '../depots/service.js';
import { readServiceTime, readShift } from '../settings/service.js';
import type { Role } from '@fl/shared';
import type { PlanInputSnapshot } from './input.js';
import type { PlanResult } from './solve.js';
import { publishRun, type RequestContext } from './service.js';

const PLAN_AUDIENCE: readonly Role[] = ['ADMIN', 'LOGISTICIAN'];

/** Почему вход устарел. Только коды: ни адресов, ни координат. */
export type StaleReason =
  | 'SHIFT_SETTING_CHANGED'
  | 'SERVICE_TIME_SETTING_CHANGED'
  | 'DEPOT_CHANGED'
  | 'DEPOT_INACTIVE'
  | 'ORDER_MISSING'
  | 'ORDER_VERSION_CHANGED'
  | 'ORDER_GEO_CHANGED'
  | 'ORDER_OUT_OF_SCOPE'
  | 'ORDER_DATE_CHANGED'
  | 'ORDER_ALREADY_IN_ROUTE'
  | 'SLOT_MISSING'
  | 'COURIER_UNAVAILABLE';

export interface ApplyInput {
  expectedVersion: number;
  /**
   * Согласие применить план, в котором есть неразмещённые заказы.
   *
   * Отдельное подтверждение, а не флаг по умолчанию: неразмещённый заказ —
   * это заказ, который никто не повезёт, и узнать об этом логист должен
   * до применения, а не вечером.
   */
  allowUnassigned: boolean;
}

export interface ApplyResult {
  runId: string;
  routeIds: string[];
  version: number;
  /** Повторное применение того же запуска: черновики уже существовали. */
  alreadyApplied: boolean;
  unassignedOrderIds: string[];
}

interface LockedRun {
  id: string;
  deliveryDate: Date;
  state: $Enums.RoutePlanRunState;
  version: number;
}

interface LockedOrder {
  id: string;
  version: number;
  geoGeneration: number;
  geoState: $Enums.OrderGeoState;
  geoLatMicro: number | null;
  geoLonMicro: number | null;
  deliveryDate: Date | null;
  inScope: boolean;
  sourceArchived: boolean;
  sourceMissing: boolean;
}

type Outcome =
  | { kind: 'APPLIED'; routeIds: string[]; version: number; unassignedOrderIds: string[] }
  | { kind: 'ALREADY_APPLIED'; routeIds: string[]; version: number }
  | { kind: 'STALE'; reasons: StaleReason[] };

export interface ApplyDeps {
  db: Database;
  now?: () => Date;
}

export async function applyPlan(
  deps: ApplyDeps,
  actor: AuthenticatedActor,
  runId: string,
  input: ApplyInput,
  context: RequestContext,
): Promise<ApplyResult> {
  const now = (deps.now ?? ((): Date => new Date()))();

  const outcome = await deps.db.$transaction(async (tx) => {
    const run = await lockRun(tx, runId);

    if (run.state === 'APPLIED') {
      // Идемпотентность: возвращаем то, что уже создано. Версию при этом
      // не проверяем — повторный запрос по определению видел прежнюю.
      const routes = await tx.deliveryRoute.findMany({
        where: { planRunId: runId },
        orderBy: { number: 'asc' },
        select: { id: true },
      });
      return {
        kind: 'ALREADY_APPLIED' as const,
        routeIds: routes.map((route) => route.id),
        version: run.version,
      };
    }

    if (run.state !== 'PREVIEW') {
      throw new AppError('CONFLICT', {
        message: 'run is not a preview',
        publicMessage: 'Применять можно только готовое превью.',
        conflict: { kind: 'PLAN_NOT_PREVIEW' },
      });
    }

    if (run.version !== input.expectedVersion) {
      throw new AppError('CONFLICT', {
        message: 'stale plan run version',
        publicMessage: 'Расчёт изменён другим пользователем. Обновите страницу и повторите.',
        conflict: { kind: 'STALE_VERSION' },
      });
    }

    const { snapshot, plan } = await readSnapshots(tx, runId);

    if (plan.unassignedOrderIds.length > 0 && !input.allowUnassigned) {
      // Отказ, а не устаревание: превью остаётся готовым, логист может
      // подтвердить частичное применение отдельной командой.
      throw new AppError('CONFLICT', {
        message: 'plan has unassigned orders',
        publicMessage:
          `План оставляет ${plan.unassignedOrderIds.length} заказ(ов) нераспределёнными. ` +
          'Подтвердите частичное применение отдельно.',
        conflict: { kind: 'PLAN_HAS_UNASSIGNED', orderIds: plan.unassignedOrderIds },
      });
    }

    const reasons = await verifyInput(tx, snapshot, plan);

    if (reasons.length > 0) {
      // Отдельное УСПЕШНОЕ завершение транзакции: превью снимается
      // с рассмотрения, и ни одного черновика не создаётся.
      await tx.routePlanRun.update({
        where: { id: runId },
        data: {
          state: 'EXPIRED',
          activeDateKey: null,
          lockedUntil: null,
          lockedBy: null,
          failureCode: 'INPUT_STALE',
          version: { increment: 1 },
        },
      });

      await writeAudit(tx, {
        action: 'ROUTE_PLAN_EXPIRED',
        entityType: 'RoutePlanRun',
        entityId: runId,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        source: 'api',
        newValue: { reason: 'INPUT_STALE', causes: [...new Set(reasons)] },
        ip: context.ip,
        userAgent: context.userAgent,
      });
      await publishRun(tx, runId, 'EXPIRED');

      return { kind: 'STALE' as const, reasons: [...new Set(reasons)] };
    }

    const routeIds = await createDrafts(tx, {
      runId,
      actor,
      snapshot,
      plan,
      deliveryDate: run.deliveryDate,
    });

    await tx.routePlanRun.update({
      where: { id: runId },
      data: {
        state: 'APPLIED',
        activeDateKey: null,
        appliedAt: now,
        appliedById: actor.userId,
        version: { increment: 1 },
      },
    });

    await writeAudit(tx, {
      action: 'ROUTE_PLAN_APPLIED',
      entityType: 'RoutePlanRun',
      entityId: runId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      newValue: {
        routes: routeIds.length,
        assigned: plan.routes.reduce((total, route) => total + route.stops.length, 0),
        unassigned: plan.unassignedOrderIds.length,
        allowUnassigned: input.allowUnassigned,
      },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    await publishRun(tx, runId, 'APPLIED');

    for (const routeId of routeIds) {
      await publishRealtimeEvent(tx, {
        topic: 'route.created',
        payload: { routeId },
        audienceRoles: [...PLAN_AUDIENCE],
      });
    }

    return {
      kind: 'APPLIED' as const,
      routeIds,
      version: run.version + 1,
      unassignedOrderIds: plan.unassignedOrderIds,
    };
  });

  return finish(runId, outcome);
}

/** 409 бросается ПОСЛЕ фиксации перехода в EXPIRED, а не вместо него. */
function finish(runId: string, outcome: Outcome): ApplyResult {
  if (outcome.kind === 'STALE') {
    throw new AppError('CONFLICT', {
      message: 'plan input is stale',
      publicMessage:
        'Данные изменились с момента расчёта: план снят с рассмотрения, ' +
        'черновики не созданы. Запустите расчёт заново.',
      conflict: { kind: 'PLAN_INPUT_STALE' },
      details: { reasons: outcome.reasons },
    });
  }

  if (outcome.kind === 'ALREADY_APPLIED') {
    return {
      runId,
      routeIds: outcome.routeIds,
      version: outcome.version,
      alreadyApplied: true,
      unassignedOrderIds: [],
    };
  }

  return {
    runId,
    routeIds: outcome.routeIds,
    version: outcome.version,
    alreadyApplied: false,
    unassignedOrderIds: outcome.unassignedOrderIds,
  };
}

async function lockRun(tx: TransactionClient, runId: string): Promise<LockedRun> {
  const rows = await tx.$queryRaw<LockedRun[]>`
    SELECT "id", "deliveryDate", "state", "version"
    FROM "RoutePlanRun"
    WHERE "id" = ${runId}::uuid
    FOR UPDATE
  `;

  const run = rows[0];
  if (run === undefined) {
    throw new AppError('NOT_FOUND', { message: 'plan run not found' });
  }
  return run;
}

async function readSnapshots(
  tx: TransactionClient,
  runId: string,
): Promise<{ snapshot: PlanInputSnapshot; plan: PlanResult }> {
  const [input, result] = await Promise.all([
    tx.routePlanInputSnapshot.findUnique({ where: { runId }, select: { payload: true } }),
    tx.routePlanResultSnapshot.findUnique({ where: { runId }, select: { plan: true } }),
  ]);

  if (input === null || result === null) {
    throw new AppError('INTERNAL_ERROR', { message: 'plan snapshots are missing' });
  }

  return {
    snapshot: input.payload as unknown as PlanInputSnapshot,
    plan: result.plan as unknown as PlanResult,
  };
}

/**
 * Повторная проверка входа под блокировкой.
 *
 * Возвращает список причин расхождения. Пустой список означает, что план
 * посчитан ровно для той действительности, которая существует сейчас.
 */
async function verifyInput(
  tx: TransactionClient,
  snapshot: PlanInputSnapshot,
  plan: PlanResult,
): Promise<StaleReason[]> {
  const reasons: StaleReason[] = [];

  // Настройки. Изменение смены или времени обслуживания меняет сам смысл
  // расчёта: окна и длительности были посчитаны по прежним значениям.
  //
  // Сверяются ЗНАЧЕНИЯ, а не номера версий. Вопрос, на который отвечает
  // проверка, — «действуют ли ещё те условия, для которых посчитан план».
  // Номер версии на него отвечает лишь приблизительно: пересохранение тех же
  // значений его меняет, хотя условия остались прежними, — и логист получал бы
  // отказ там, где ничего не изменилось.
  const shift = await readShift(tx);
  if (
    shift.value === null ||
    shift.value.startMinute !== snapshot.shift.startMinute ||
    shift.value.endMinute !== snapshot.shift.endMinute
  ) {
    reasons.push('SHIFT_SETTING_CHANGED');
  }

  const serviceTime = await readServiceTime(tx);
  if (
    serviceTime.value.carMinutes !== snapshot.serviceTime.carMinutes ||
    serviceTime.value.footMinutes !== snapshot.serviceTime.footMinutes
  ) {
    reasons.push('SERVICE_TIME_SETTING_CHANGED');
  }

  // Заказы блокируются раньше складов: порядок един для всех операций модуля.
  const orderIds = snapshot.orders.map((order) => order.orderId);
  const locked = await lockOrders(tx, orderIds);
  const lockedById = new Map(locked.map((order) => [order.id, order]));

  for (const expected of snapshot.orders) {
    const actual = lockedById.get(expected.orderId);

    if (actual === undefined) {
      reasons.push('ORDER_MISSING');
      continue;
    }
    if (actual.version !== expected.version) {
      reasons.push('ORDER_VERSION_CHANGED');
    }
    if (
      actual.geoGeneration !== expected.geoGeneration ||
      actual.geoState !== 'RESOLVED' ||
      actual.geoLatMicro !== expected.latMicro ||
      actual.geoLonMicro !== expected.lonMicro
    ) {
      reasons.push('ORDER_GEO_CHANGED');
    }
    if (!actual.inScope || actual.sourceArchived || actual.sourceMissing) {
      reasons.push('ORDER_OUT_OF_SCOPE');
    }
    if (
      actual.deliveryDate === null ||
      actual.deliveryDate.toISOString().slice(0, 10) !== snapshot.deliveryDate
    ) {
      reasons.push('ORDER_DATE_CHANGED');
    }
  }

  // Заказ, попавший в маршрут вручную между расчётом и применением.
  const taken = await tx.routeOrder.findFirst({
    where: { orderId: { in: orderIds }, removedAt: null },
    select: { orderId: true },
  });
  if (taken !== null) {
    reasons.push('ORDER_ALREADY_IN_ROUTE');
  }

  // Склады. Переезд склада меняет каждую строку матрицы.
  const depotIds = snapshot.depots.map((depot) => depot.depotId);
  const depots = await lockDepotRows(tx, depotIds);
  const depotById = new Map(depots.map((depot) => [depot.id, depot]));

  for (const expected of snapshot.depots) {
    const actual = depotById.get(expected.depotId);
    if (
      actual === undefined ||
      actual.version !== expected.version ||
      actual.latMicro !== expected.latMicro ||
      actual.lonMicro !== expected.lonMicro
    ) {
      reasons.push('DEPOT_CHANGED');
      continue;
    }
    if (!actual.isActive) {
      reasons.push('DEPOT_INACTIVE');
    }
  }

  // Слоты. Строки неизменяемы триггером, но курьер мог быть заморожен
  // или лишиться роли — маршрут достался бы человеку, который его не выполнит.
  const slotIds = plan.routes.map((route) => route.slotId);
  const slots = await tx.routePlanVehicleSlot.findMany({
    where: { id: { in: slotIds } },
    select: { id: true, courierUserId: true },
  });

  if (slots.length !== new Set(slotIds).size) {
    reasons.push('SLOT_MISSING');
  }

  const courierIds = slots
    .map((slot) => slot.courierUserId)
    .filter((id): id is string => id !== null);

  if (courierIds.length > 0) {
    const couriers = await tx.user.findMany({
      where: { id: { in: courierIds } },
      select: { id: true, status: true, roles: { select: { role: true } } },
    });

    const usable = new Set(
      couriers
        .filter(
          (user) =>
            user.status === 'ACTIVE' &&
            user.roles.some((assignment) => assignment.role === 'COURIER'),
        )
        .map((user) => user.id),
    );

    if (courierIds.some((id) => !usable.has(id))) {
      reasons.push('COURIER_UNAVAILABLE');
    }
  }

  return reasons;
}

async function lockOrders(tx: TransactionClient, ids: readonly string[]): Promise<LockedOrder[]> {
  if (ids.length === 0) {
    return [];
  }
  const list = Prisma.join([...new Set(ids)].map((id) => Prisma.sql`${id}::uuid`));
  return tx.$queryRaw<LockedOrder[]>`
    SELECT "id", "version", "geoGeneration", "geoState", "geoLatMicro", "geoLonMicro",
           "deliveryDate", "inScope", "sourceArchived", "sourceMissing"
    FROM "DeliveryOrder"
    WHERE "id" IN (${list})
    ORDER BY "id"
    FOR UPDATE
  `;
}

/**
 * Создаёт черновики.
 *
 * Пустые маршруты не создаются: слот, которому решатель не дал ни одного
 * заказа, — это машина, которая никуда не едет, и отдельный пустой черновик
 * только засорял бы список.
 */
async function createDrafts(
  tx: TransactionClient,
  input: {
    runId: string;
    actor: AuthenticatedActor;
    snapshot: PlanInputSnapshot;
    plan: PlanResult;
    deliveryDate: Date;
  },
): Promise<string[]> {
  const deliveryDate = input.snapshot.deliveryDate;
  const routeIds: string[] = [];

  for (const planned of input.plan.routes) {
    if (planned.stops.length === 0) {
      continue;
    }

    const number = await nextRouteNumber(tx, deliveryDate);

    const route = await tx.deliveryRoute.create({
      data: {
        number,
        deliveryDate: input.deliveryDate,
        state: 'DRAFT',
        vehicleType: planned.vehicleType,
        courierUserId: planned.courierUserId,
        createdById: input.actor.userId,
        startDepotId: planned.startDepotId,
        endDepotId: planned.endDepotId,
        planRunId: input.runId,
        // Уникален: второй маршрут из того же слота физически невозможен.
        planVehicleSlotId: planned.slotId,
      },
      select: { id: true },
    });

    for (const stop of planned.stops) {
      await tx.routeOrder.create({
        data: {
          routeId: route.id,
          orderId: stop.orderId,
          position: stop.position,
          addedById: input.actor.userId,
        },
      });
    }

    routeIds.push(route.id);
  }

  return routeIds;
}
