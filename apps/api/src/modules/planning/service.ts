/**
 * Планирование маршрутов: постановка, расчёт и превью.
 *
 * ДВЕ ФАЗЫ. Расчёт не создаёт ни одного черновика — он создаёт неизменяемое
 * ПРЕВЬЮ: маршруты и неразмещённые заказы, которые логист видит целиком.
 * Черновики появляются только после отдельного явного подтверждения
 * (см. `apply.ts`). План, сразу ставший данными, лишил бы человека
 * возможности сказать «нет».
 *
 * ПОРЯДОК РАБОТЫ:
 *   транзакция  → создать запуск, слоты и снимок входа
 *   вне транзакции → матрицы и решатель
 *   транзакция  → записать снимок результата и перейти в PREVIEW
 *
 * Транзакция НЕ удерживается на время матрицы и решателя: расчёт длится
 * секунды, и открытая всё это время транзакция держала бы и соединение,
 * и строку запуска.
 *
 * АРЕНДА по СЕРВЕРНОМУ времени с сердцебиением. Перехват допускается только
 * после истечения `lockedUntil`. Восстановлений после падения процесса
 * не больше трёх; обычная ошибка матрицы или решателя автоматически
 * НЕ повторяется — она означает, что повтор даст тот же результат.
 *
 * ОДИН ДЕНЬ — ОДИН НЕЗАВЕРШЁННЫЙ ЗАПУСК. Обеспечивается уникальным индексом
 * по `activeDateKey`, а не проверкой «сначала посмотреть, потом создать»:
 * параллельные транзакции не видят незафиксированных вставок друг друга.
 */

import { randomUUID } from 'node:crypto';
import { Prisma, type $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import type { AppLogger } from '../../platform/logging/logger.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit, type AuditAction } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { isCalendarDate, toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { isPlainCourier, type Role } from '@fl/shared';
import { EMPTY_ASSIGNMENTS, readRoleAssignments } from '../../platform/role-assignments.js';
import { requireDefaultDepot } from '../depots/service.js';
import { readServiceTime, readShift, requireShift, type Shift } from '../settings/service.js';
import { computeMatrix, matrixCacheKey, type MatrixDeps } from '../geo/matrix/service.js';
import { MICRO } from '../orders/geo.js';
import { effectiveAddress } from '../orders/address.js';
import type { VroomClient } from '../integrations/vroom/client.js';
import { VroomError } from '../integrations/vroom/client.js';
import {
  assertPointLimit,
  assertShiftShape,
  buildInputSnapshot,
  canonicalJson,
  orderProblem,
  ORDER_PROBLEM_MESSAGES,
  snapshotHash,
  type PlanInputSnapshot,
  type PlanningOrderRow,
} from './input.js';
import {
  buildSolverRequest,
  parseSolution,
  PlanContractError,
  type PlanResult,
  type SourceMatrix,
} from './solve.js';

const PLAN_AUDIENCE: readonly Role[] = ['ADMIN', 'LOGISTICIAN'];

/** Сколько расчёт может числиться за экземпляром без сердцебиения. */
export const PLAN_LEASE_MS = 120_000;
/** Как часто продлевается аренда во время расчёта: втрое чаще истечения. */
export const PLAN_HEARTBEAT_MS = 40_000;
/** Больше трёх восстановлений подряд означают, что расчёт не завершится никогда. */
export const MAX_RECOVERY_ATTEMPTS = 3;
/** Разумный потолок числа машин в одном запуске. */
export const MAX_SLOTS = 50;

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface PlanningDeps {
  db: Database;
  logger: AppLogger;
  /** Зависимости сервиса матриц. Сетевые вызовы выполняются строго вне транзакции. */
  matrix: MatrixDeps;
  /**
   * Решатель. `configured` читается ДО постановки запуска: без адреса решателя
   * фоновый исполнитель не поднимается вовсе, и принятый запуск остался бы
   * в `QUEUED` навсегда, молча удерживая день уникальным `activeDateKey`.
   */
  vroom: Pick<VroomClient, 'solve' | 'configured'>;
  /** Ворота решателя: подтверждают, что он отвечает и учитывает время обслуживания. */
  verifySolver: () => Promise<void>;
  /** Версия решателя, объявленная конфигурацией. Пишется в снимок результата. */
  solverVersion: string | null;
  /** Владелец аренды. Обязателен и уникален на процесс. */
  workerId: string;
  now?: () => Date;
  leaseMs?: number;
}

const clockOf = (deps: PlanningDeps): Date => (deps.now ?? ((): Date => new Date()))();

/** Идентификатор экземпляра для аренды расчёта. */
export function newPlanningWorkerId(): string {
  return randomUUID();
}

// --- Постановка запуска -----------------------------------------------------

export interface SlotInput {
  courierUserId: string | null;
  vehicleType: $Enums.VehicleType;
  capacityOrders: number;
  /** Переопределение смены. Пусто — берётся общая настройка. */
  shiftStartMinute?: number | undefined;
  shiftEndMinute?: number | undefined;
}

export interface RequestPlanInput {
  deliveryDate: string;
  slots: SlotInput[];
  /**
   * Превью, которое запрос осознанно вытесняет.
   *
   * Без явного указания новое превью старое НЕ вытесняет: молчаливая замена
   * означала бы, что готовый и просмотренный план исчез, пока логист
   * решал, применять ли его.
   */
  replacePreviewId?: string | undefined;
  /**
   * Явно выбранные заказы.
   *
   * Пусто — прежнее поведение: планируется весь пригодный день. Заданный
   * набор замораживается снимком целиком и ровно в этом составе: чужой заказ
   * того же дня не попадёт ни в матрицу, ни в решатель, ни в превью.
   */
  orderIds?: readonly string[] | undefined;
}

export async function requestPlan(
  deps: PlanningDeps,
  actor: AuthenticatedActor,
  input: RequestPlanInput,
  context: RequestContext,
): Promise<{ id: string; state: $Enums.RoutePlanRunState }> {
  if (!isCalendarDate(input.deliveryDate)) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'invalid calendar date',
      publicMessage: 'Указана несуществующая дата доставки.',
    });
  }

  if (input.slots.length === 0 || input.slots.length > MAX_SLOTS) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'invalid slot count',
      publicMessage: `Укажите от одной до ${MAX_SLOTS} машин.`,
    });
  }

  const graphSha256 = deps.matrix.graphSha256;
  if (graphSha256 === null) {
    throw new AppError('SERVICE_UNAVAILABLE', {
      message: 'graph content revision is not configured',
      publicMessage: 'Планирование недоступно: не задано содержимое дорожного графа.',
    });
  }

  // Отказ ДО создания записи, а не после.
  //
  // Фоновый исполнитель поднимается только при заданном адресе решателя
  // (`index.ts`). Без него принятый запуск навсегда остался бы в `QUEUED`
  // и удерживал бы день уникальным `activeDateKey`: следующий расчёт того же
  // дня получал бы «уже идёт расчёт», хотя не считает никто. Снять такой
  // запуск можно было бы только руками.
  //
  // Проверяется настройка, а не живой ответ решателя: сетевое обращение
  // на пути постановки означало бы ожидание и новый режим отказа. Готовность
  // самого решателя проверяет `verifySolver` уже внутри расчёта.
  if (!deps.vroom.configured) {
    throw new AppError('SERVICE_UNAVAILABLE', {
      message: 'solver is not configured',
      publicMessage:
        'Автоматический расчёт недоступен: решатель не настроен. Ручные черновики продолжают работать.',
    });
  }

  // Настройки и склад читаются ДО транзакции: отказ не должен оставлять
  // за собой ни запуска, ни снимка.
  const shiftSetting = await readShift(deps.db);
  const shift = await requireShift(deps.db);
  assertShiftShape(shift);
  const serviceSetting = await readServiceTime(deps.db);
  const depot = await requireDefaultDepot(deps.db);

  const slots = normalizeSlots(input.slots, shift);
  await assertCouriersAssignable(deps.db, actor, slots);

  const orders = await eligibleOrders(deps.db, input.deliveryDate, input.orderIds);
  assertOrdersArePlannable(orders);

  // Выбор проверяется целиком: если хотя бы один заказ успел стать непригодным
  // или уйти в чужой маршрут, расчёт не запускается. Молча посчитать «почти
  // тот же» набор значило бы подменить решение логиста.
  if (input.orderIds !== undefined) {
    const found = new Set(orders.map((order) => order.id));
    const missing = input.orderIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new AppError('CONFLICT', {
        message: 'selected orders are no longer plannable',
        publicMessage:
          'Часть выбранных заказов больше нельзя распределить: обновите список и повторите выбор.',
        conflict: { kind: 'ORDER_NOT_ELIGIBLE', orderIds: missing },
      });
    }
  }

  const snapshot = buildInputSnapshot({
    deliveryDate: input.deliveryDate,
    graphSha256,
    trafficMode: 'STATIC',
    maxPoints: deps.matrix.maxPoints ?? 60,
    shift,
    shiftVersion: shiftSetting.version,
    serviceTime: serviceSetting.value,
    serviceTimeVersion: serviceSetting.version,
    depots: [depot],
    orders,
    slots: slots.map((slot, index) => ({
      slotIndex: index + 1,
      courierUserId: slot.courierUserId,
      vehicleType: slot.vehicleType,
      capacityOrders: slot.capacityOrders,
      shiftStartMinute: slot.shiftStartMinute,
      shiftEndMinute: slot.shiftEndMinute,
      startDepotId: depot.id,
      endDepotId: depot.id,
    })),
    // Идентификаторы слотов ещё не известны: они появятся в транзакции.
    slotIds: slots.map((_, index) => `pending-${index}`),
  });

  assertPointLimit(snapshot);

  const now = clockOf(deps);

  try {
    return await deps.db.$transaction(async (tx) => {
      if (input.replacePreviewId !== undefined) {
        await expirePreviewRow(tx, input.replacePreviewId, actor, context, 'REPLACED', now);
      }

      const run = await tx.routePlanRun.create({
        data: {
          deliveryDate: toDateColumn(input.deliveryDate),
          state: 'QUEUED',
          activeDateKey: toDateColumn(input.deliveryDate),
          requestedById: actor.userId,
        },
        select: { id: true, state: true },
      });

      const slotIds: string[] = [];
      for (const [index, slot] of slots.entries()) {
        const created = await tx.routePlanVehicleSlot.create({
          data: {
            runId: run.id,
            slotIndex: index + 1,
            courierUserId: slot.courierUserId,
            vehicleType: slot.vehicleType,
            capacityOrders: slot.capacityOrders,
            shiftStartMinute: slot.shiftStartMinute,
            shiftEndMinute: slot.shiftEndMinute,
            startDepotId: depot.id,
            endDepotId: depot.id,
          },
          select: { id: true },
        });
        slotIds.push(created.id);
      }

      // Снимок входа получает настоящие идентификаторы слотов и становится
      // неизменяемым. С этого момента расчёт определён полностью: перехват
      // брошенной аренды продолжит его с теми же данными.
      const stored: PlanInputSnapshot = {
        ...snapshot,
        slots: snapshot.slots.map((slot, index) => ({
          ...slot,
          slotId: slotIds[index] ?? slot.slotId,
        })),
      };

      await tx.routePlanInputSnapshot.create({
        data: {
          runId: run.id,
          payload: stored as unknown as Prisma.InputJsonObject,
          payloadHash: snapshotHash(stored),
        },
      });

      await auditRun(tx, 'ROUTE_PLAN_REQUESTED', run.id, actor, context, {
        deliveryDate: input.deliveryDate,
        slots: slots.length,
        orders: snapshot.orders.length,
        points: snapshot.points.length,
        replacedPreviewId: input.replacePreviewId ?? null,
      });
      await publishRun(tx, run.id, 'QUEUED');

      return run;
    });
  } catch (error) {
    if (isActiveRunConflict(error)) {
      throw new AppError('CONFLICT', {
        message: 'day already has an unfinished plan run',
        publicMessage:
          'На эту дату уже есть расчёт или готовое превью. ' +
          'Примените его либо отмените явно, прежде чем считать заново.',
        conflict: { kind: 'PLAN_RUN_IN_PROGRESS' },
      });
    }
    throw error;
  }
}

function isActiveRunConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    JSON.stringify(error.meta ?? {}).includes('activeDateKey')
  );
}

interface NormalizedSlot {
  courierUserId: string | null;
  vehicleType: $Enums.VehicleType;
  capacityOrders: number;
  shiftStartMinute: number;
  shiftEndMinute: number;
}

/** Смена слота: переопределение маршрута либо общая настройка. */
function normalizeSlots(slots: readonly SlotInput[], shift: Shift): NormalizedSlot[] {
  const couriers = new Set<string>();

  return slots.map((slot) => {
    const startMinute = slot.shiftStartMinute ?? shift.startMinute;
    const endMinute = slot.shiftEndMinute ?? shift.endMinute;

    if (endMinute <= startMinute) {
      throw new AppError('VALIDATION_FAILED', {
        message: 'slot shift is empty',
        publicMessage: 'Окончание смены машины должно быть позже её начала.',
      });
    }

    if (slot.courierUserId !== null) {
      if (couriers.has(slot.courierUserId)) {
        // Один человек не может вести две машины одновременно. Проверка
        // повторена уникальным индексом базы: она здесь ради понятного текста.
        throw new AppError('VALIDATION_FAILED', {
          message: 'courier appears in two slots',
          publicMessage: 'Один курьер указан в двух машинах одного расчёта.',
        });
      }
      couriers.add(slot.courierUserId);
    }

    return {
      courierUserId: slot.courierUserId,
      vehicleType: slot.vehicleType,
      capacityOrders: slot.capacityOrders,
      shiftStartMinute: startMinute,
      shiftEndMinute: endMinute,
    };
  });
}

/**
 * Проверка курьеров слотов.
 *
 * Те же правила, что при назначении курьера вручную: только активный
 * пользователь с ролью `COURIER`, а логисту доступен лишь обычный курьер.
 */
async function assertCouriersAssignable(
  db: Database,
  actor: AuthenticatedActor,
  slots: readonly NormalizedSlot[],
): Promise<void> {
  const ids = slots.map((slot) => slot.courierUserId).filter((id): id is string => id !== null);

  if (ids.length === 0) {
    return;
  }

  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true },
  });

  if (users.length !== new Set(ids).size) {
    throw new AppError('NOT_FOUND', { message: 'courier not found' });
  }

  // Роли читаются текстом одним запросом на всех кандидатов.
  const assignments = await readRoleAssignments(
    db,
    users.map((user) => user.id),
  );

  for (const user of users) {
    const assignment = assignments.get(user.id) ?? EMPTY_ASSIGNMENTS;
    const roles = assignment.known;

    if (user.status !== 'ACTIVE' || !roles.includes('COURIER')) {
      throw new AppError('VALIDATION_FAILED', {
        message: 'user is not an active courier',
        publicMessage: 'В расчёт можно поставить только активного курьера.',
      });
    }

    if (
      !actor.roles.includes('ADMIN') &&
      (assignment.hasUnsupportedRoles || !isPlainCourier(roles))
    ) {
      throw new AppError('FORBIDDEN', {
        message: 'logistician cannot assign privileged courier',
        publicMessage: 'Этого курьера может поставить в расчёт только администратор.',
      });
    }
  }
}

/**
 * Заказы дня, подлежащие планированию.
 *
 * Берутся ВСЕ нераспределённые заказы даты: планирование строит день целиком,
 * а выборочный набор дал бы план, который выглядит полным и таковым не является.
 */
export async function eligibleOrders(
  client: Database | TransactionClient,
  deliveryDate: string,
  orderIds?: readonly string[] | undefined,
): Promise<PlanningOrderRow[]> {
  return client.deliveryOrder.findMany({
    where: {
      // Явный выбор логиста сужает набор до ровно перечисленных заказов.
      // Прочие условия остаются в силе: выбранный, но ставший непригодным
      // заказ обязан отсеяться здесь, а не тихо попасть в расчёт.
      ...(orderIds === undefined ? {} : { id: { in: [...orderIds] } }),
      deliveryDate: toDateColumn(deliveryDate),
      inScope: true,
      sourceArchived: false,
      sourceMissing: false,
      // Заказ, уже лежащий в активном маршруте, планированием не трогается:
      // ручное решение логиста автоматика не отменяет.
      routeOrders: { none: { removedAt: null } },
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      version: true,
      geoGeneration: true,
      geoState: true,
      geoLatMicro: true,
      geoLonMicro: true,
      intervalKind: true,
      intervalStartMinute: true,
      intervalEndMinute: true,
      manualIntervalStartMinute: true,
      manualIntervalEndMinute: true,
    },
  });
}

/**
 * Fail closed — но только там, где данных НЕТ.
 *
 * Отсутствие подтверждённой точки и неразобранное время доставки означают, что
 * неизвестно, куда и когда везти: считать нечего, и отказ называет конкретные
 * заказы, чтобы логист чинил именно их.
 *
 * Невыполнимое ограничение сюда НЕ относится. Точное время, в которое нельзя
 * успеть, и окно вне смены — это вывод расчёта, а не порок данных: такой заказ
 * уходит решателю и возвращается неразмещённым. Требовать ручной правки там,
 * где ответ даёт расчёт, значит заставлять человека угадывать.
 */
export function assertOrdersArePlannable(orders: readonly PlanningOrderRow[]): void {
  if (orders.length === 0) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'no orders to plan',
      publicMessage: 'На эту дату нет нераспределённых заказов.',
    });
  }

  const problems = orders
    .map((order) => ({ orderId: order.id, problem: orderProblem(order) }))
    .filter(
      (item): item is { orderId: string; problem: NonNullable<typeof item.problem> } =>
        item.problem !== null,
    );

  if (problems.length > 0) {
    const first = problems[0];
    throw new AppError('VALIDATION_FAILED', {
      message: 'order is not plannable',
      publicMessage:
        `Планирование невозможно: ${problems.length} заказ(ов) не готовы. ` +
        `Например, ${ORDER_PROBLEM_MESSAGES[first?.problem ?? 'NO_CONFIRMED_POINT']}.`,
      details: { orderIds: problems.map((item) => item.orderId) },
    });
  }
}

// --- Аренда расчёта ---------------------------------------------------------

interface ClaimedRun {
  id: string;
  deliveryDate: Date;
}

/**
 * Занимает запуск для расчёта.
 *
 * Сначала свежая очередь, затем брошенные аренды. `FOR UPDATE SKIP LOCKED`
 * обязателен: без него два экземпляра выстроились бы в очередь за одной
 * строкой вместо того, чтобы взять разные.
 */
export async function claimRun(deps: PlanningDeps): Promise<ClaimedRun | null> {
  const now = clockOf(deps);
  const until = new Date(now.getTime() + (deps.leaseMs ?? PLAN_LEASE_MS));

  const queued = await deps.db.$queryRaw<ClaimedRun[]>`
    UPDATE "RoutePlanRun" SET
      "state" = 'COMPUTING',
      "lockedUntil" = ${until},
      "lockedBy" = ${deps.workerId},
      "heartbeatAt" = ${now},
      "updatedAt" = ${now}
    WHERE "id" = (
      SELECT "id" FROM "RoutePlanRun"
      WHERE "state" = 'QUEUED'
      ORDER BY "createdAt"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "deliveryDate"
  `;

  const first = queued[0];
  if (first !== undefined) {
    return first;
  }

  // Брошенная аренда. Перехват допускается ТОЛЬКО после истечения срока:
  // живой расчёт чужого процесса перехватывать нельзя.
  const recovered = await deps.db.$queryRaw<ClaimedRun[]>`
    UPDATE "RoutePlanRun" SET
      "lockedUntil" = ${until},
      "lockedBy" = ${deps.workerId},
      "heartbeatAt" = ${now},
      "recoveryAttempts" = "recoveryAttempts" + 1,
      "updatedAt" = ${now}
    WHERE "id" = (
      SELECT "id" FROM "RoutePlanRun"
      WHERE "state" = 'COMPUTING'
        AND "lockedUntil" < ${now}
        AND "recoveryAttempts" < ${MAX_RECOVERY_ATTEMPTS}
      ORDER BY "lockedUntil"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "deliveryDate"
  `;

  return recovered[0] ?? null;
}

/**
 * Закрывает запуски, исчерпавшие восстановления.
 *
 * Без этого брошенный расчёт навсегда удерживал бы день: перехватывать его
 * уже нельзя, а завершиться сам он не может.
 */
export async function failExhaustedRuns(deps: PlanningDeps): Promise<number> {
  const now = clockOf(deps);

  const exhausted = await deps.db.routePlanRun.findMany({
    where: {
      state: 'COMPUTING',
      lockedUntil: { lt: now },
      recoveryAttempts: { gte: MAX_RECOVERY_ATTEMPTS },
    },
    select: { id: true },
  });

  for (const run of exhausted) {
    await deps.db.$transaction(async (tx) => {
      await finishRun(tx, run.id, {
        state: 'FAILED',
        failureCode: 'RECOVERY_EXHAUSTED',
        now,
      });
      await publishRun(tx, run.id, 'FAILED');
    });
  }

  return exhausted.length;
}

/** Продлевает аренду, пока расчёт идёт. Чужую аренду не трогает. */
export async function heartbeatRun(deps: PlanningDeps, runId: string): Promise<boolean> {
  const now = clockOf(deps);
  const until = new Date(now.getTime() + (deps.leaseMs ?? PLAN_LEASE_MS));

  const updated = await deps.db.routePlanRun.updateMany({
    where: { id: runId, state: 'COMPUTING', lockedBy: deps.workerId },
    data: { lockedUntil: until, heartbeatAt: now },
  });

  return updated.count === 1;
}

/** Переводит запуск в завершённое состояние, снимая аренду и ключ дня. */
async function finishRun(
  tx: TransactionClient,
  runId: string,
  input: {
    state: 'FAILED' | 'EXPIRED';
    failureCode?: string;
    now: Date;
  },
): Promise<void> {
  await tx.routePlanRun.update({
    where: { id: runId },
    data: {
      state: input.state,
      // Ключ дня снимается вместе с завершением: иначе день остался бы
      // заблокированным навсегда.
      activeDateKey: null,
      lockedUntil: null,
      lockedBy: null,
      failureCode: input.failureCode ?? null,
      version: { increment: 1 },
    },
  });
}

// --- Расчёт -----------------------------------------------------------------

export interface ComputeResult {
  state: $Enums.RoutePlanRunState;
  failureCode: string | null;
}

/**
 * Считает занятый запуск.
 *
 * Сетевые обращения выполняются ВНЕ транзакции. Результат записывается только
 * если аренда всё ещё наша: расчёт мог затянуться, аренду перехватить, и тогда
 * наш ответ относится к чужой работе.
 */
export async function computeRun(deps: PlanningDeps, runId: string): Promise<ComputeResult> {
  const stored = await deps.db.routePlanInputSnapshot.findUnique({
    where: { runId },
    select: { payload: true },
  });

  if (stored === null) {
    return failRun(deps, runId, 'INPUT_SNAPSHOT_MISSING');
  }

  const snapshot = stored.payload as unknown as PlanInputSnapshot;

  let heartbeat: NodeJS.Timeout | null = null;
  try {
    // Ворота решателя: он обязан отвечать И учитывать время обслуживания
    // по типу машины. Проверка выполняется до любой тяжёлой работы.
    await deps.verifySolver();

    heartbeat = setInterval(() => {
      void heartbeatRun(deps, runId).catch(() => undefined);
    }, PLAN_HEARTBEAT_MS);
    heartbeat.unref();

    const points = snapshot.points.map((point) => ({
      lat: point.latMicro / MICRO,
      lon: point.lonMicro / MICRO,
    }));

    const usedTypes = [...new Set(snapshot.slots.map((slot) => slot.vehicleType))];
    const matrices: Partial<Record<$Enums.VehicleType, SourceMatrix>> = {};
    const matrixKeys: Record<string, string> = {};

    for (const vehicleType of usedTypes) {
      const result = await computeMatrix(deps.matrix, { points, profile: vehicleType });
      matrices[vehicleType] = {
        durationsSec: result.durationsSec,
        distancesM: result.distancesM,
      };
      matrixKeys[vehicleType] = matrixCacheKey({
        graphSha256: snapshot.graphSha256,
        profile: vehicleType,
        trafficMode: snapshot.trafficMode,
        points,
      });
    }

    const request = buildSolverRequest({ snapshot, matrices });
    const solution = await deps.vroom.solve(request);
    const plan = parseSolution(snapshot, solution);

    const written = await deps.db.$transaction(async (tx) => {
      // Аренда проверяется в самом условии обновления: чтение и запись
      // разошлись бы во времени, и перехваченный расчёт успел бы записать
      // результат поверх чужого.
      const claimed = await tx.routePlanRun.updateMany({
        where: { id: runId, state: 'COMPUTING', lockedBy: deps.workerId },
        data: {
          state: 'PREVIEW',
          lockedUntil: null,
          lockedBy: null,
          failureCode: null,
          version: { increment: 1 },
        },
      });

      if (claimed.count !== 1) {
        return false;
      }

      await tx.routePlanResultSnapshot.create({
        data: {
          runId,
          graphSha256: snapshot.graphSha256,
          matrixKeys: matrixKeys as unknown as Prisma.InputJsonObject,
          solverVersion: deps.solverVersion ?? 'unknown',
          request: request as unknown as Prisma.InputJsonObject,
          response: solution as unknown as Prisma.InputJsonObject,
          plan: plan as unknown as Prisma.InputJsonObject,
        },
      });

      await writeAudit(tx, {
        action: 'ROUTE_PLAN_COMPUTED',
        entityType: 'RoutePlanRun',
        entityId: runId,
        source: 'worker',
        newValue: {
          routes: plan.routes.length,
          assigned: plan.routes.reduce((total, route) => total + route.stops.length, 0),
          unassigned: plan.unassignedOrderIds.length,
          points: snapshot.points.length,
        },
      });
      await publishRun(tx, runId, 'PREVIEW');

      return true;
    });

    if (!written) {
      deps.logger.warn({ plan: { runId } }, 'аренда расчёта потеряна, результат не записан');
      return { state: 'COMPUTING', failureCode: null };
    }

    return { state: 'PREVIEW', failureCode: null };
  } catch (error) {
    // Обычная ошибка не повторяется автоматически: повтор дал бы тот же
    // результат, а день остался бы занятым.
    return failRun(deps, runId, failureCodeOf(error));
  } finally {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
    }
  }
}

function failureCodeOf(error: unknown): string {
  if (error instanceof PlanContractError) {
    return error.code;
  }
  if (error instanceof VroomError) {
    return `SOLVER_${error.code}`;
  }
  if (error instanceof AppError) {
    return `APP_${error.code}`;
  }
  return 'INTERNAL_ERROR';
}

async function failRun(
  deps: PlanningDeps,
  runId: string,
  failureCode: string,
): Promise<ComputeResult> {
  await deps.db.$transaction(async (tx) => {
    const owned = await tx.routePlanRun.updateMany({
      where: { id: runId, state: 'COMPUTING', lockedBy: deps.workerId },
      data: {
        state: 'FAILED',
        activeDateKey: null,
        lockedUntil: null,
        lockedBy: null,
        failureCode,
        version: { increment: 1 },
      },
    });

    if (owned.count !== 1) {
      return;
    }

    await writeAudit(tx, {
      action: 'ROUTE_PLAN_FAILED',
      entityType: 'RoutePlanRun',
      entityId: runId,
      source: 'worker',
      // Только безопасный код: ни тел ответов, ни координат, ни адресов.
      newValue: { failureCode },
    });
    await publishRun(tx, runId, 'FAILED');
  });

  deps.logger.warn({ plan: { runId, failureCode } }, 'расчёт плана не удался');
  return { state: 'FAILED', failureCode };
}

// --- Явное истечение превью -------------------------------------------------

export async function expirePreview(
  deps: PlanningDeps,
  actor: AuthenticatedActor,
  runId: string,
  input: { expectedVersion: number },
  context: RequestContext,
): Promise<void> {
  const now = clockOf(deps);

  await deps.db.$transaction(async (tx) => {
    await expirePreviewRow(
      tx,
      runId,
      actor,
      context,
      'EXPIRED_BY_USER',
      now,
      input.expectedVersion,
    );
  });
}

/**
 * Снимает превью с рассмотрения.
 *
 * Используется и отдельной командой, и осознанной заменой при новом расчёте.
 * Без явного действия превью не исчезает: логист мог как раз его изучать.
 */
async function expirePreviewRow(
  tx: TransactionClient,
  runId: string,
  actor: AuthenticatedActor,
  context: RequestContext,
  reason: 'EXPIRED_BY_USER' | 'REPLACED',
  now: Date,
  expectedVersion?: number,
): Promise<void> {
  const run = await tx.routePlanRun.findUnique({
    where: { id: runId },
    select: { id: true, state: true, version: true },
  });

  if (run === null) {
    throw new AppError('NOT_FOUND', { message: 'plan run not found' });
  }

  if (run.state !== 'PREVIEW') {
    throw new AppError('CONFLICT', {
      message: 'run is not a preview',
      publicMessage: 'Это не готовое превью: снимать с рассмотрения нечего.',
      conflict: { kind: 'PLAN_NOT_PREVIEW' },
    });
  }

  if (expectedVersion !== undefined && run.version !== expectedVersion) {
    throw new AppError('CONFLICT', {
      message: 'stale plan run version',
      publicMessage: 'Расчёт изменён другим пользователем. Обновите страницу и повторите.',
      conflict: { kind: 'STALE_VERSION' },
    });
  }

  await finishRun(tx, runId, { state: 'EXPIRED', failureCode: reason, now });

  await writeAudit(tx, {
    action: 'ROUTE_PLAN_EXPIRED',
    entityType: 'RoutePlanRun',
    entityId: runId,
    actorUserId: actor.userId,
    actorRoles: actor.roles,
    source: 'api',
    newValue: { reason },
    ip: context.ip,
    userAgent: context.userAgent,
  });
  await publishRun(tx, runId, 'EXPIRED');
}

// --- Аудит и события --------------------------------------------------------

async function auditRun(
  tx: TransactionClient,
  action: AuditAction,
  runId: string,
  actor: AuthenticatedActor,
  context: RequestContext,
  value: Record<string, unknown>,
): Promise<void> {
  await writeAudit(tx, {
    action,
    entityType: 'RoutePlanRun',
    entityId: runId,
    actorUserId: actor.userId,
    actorRoles: actor.roles,
    source: 'api',
    newValue: value,
    ip: context.ip,
    userAgent: context.userAgent,
  });
}

export async function publishRun(
  tx: TransactionClient,
  runId: string,
  state: $Enums.RoutePlanRunState,
): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic: 'route_plan.updated',
    // Ни маршрутов, ни заказов, ни координат: клиент перезапрашивает карточку.
    payload: { runId, state },
    audienceRoles: [...PLAN_AUDIENCE],
  });
}

// --- Чтение -----------------------------------------------------------------

export interface RunView {
  id: string;
  deliveryDate: string;
  state: $Enums.RoutePlanRunState;
  version: number;
  failureCode: string | null;
  createdAt: string;
  appliedAt: string | null;
  slots: {
    id: string;
    slotIndex: number;
    courierUserId: string | null;
    vehicleType: $Enums.VehicleType;
    capacityOrders: number;
    shiftStartMinute: number;
    shiftEndMinute: number;
  }[];
  preview: PlanResult | null;
  /**
   * Заказы превью по-человечески.
   *
   * Превью без номера и адреса проверить нельзя: обрезанный идентификатор
   * ничего не говорит логисту, а применение необратимо создаёт черновики.
   * Снимок при этом остаётся неизменяемым — это отдельное чтение, а не правка.
   */
  orders: {
    id: string;
    number: string;
    address: string | null;
    intervalStartMinute: number | null;
    intervalEndMinute: number | null;
  }[];
  routeIds: string[];
}

export async function readRun(db: Database, runId: string): Promise<RunView> {
  const run = await db.routePlanRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      deliveryDate: true,
      state: true,
      version: true,
      failureCode: true,
      createdAt: true,
      appliedAt: true,
      slots: {
        orderBy: { slotIndex: 'asc' },
        select: {
          id: true,
          slotIndex: true,
          courierUserId: true,
          vehicleType: true,
          capacityOrders: true,
          shiftStartMinute: true,
          shiftEndMinute: true,
        },
      },
      result: { select: { plan: true } },
      routes: { select: { id: true }, orderBy: { number: 'asc' } },
    },
  });

  if (run === null) {
    throw new AppError('NOT_FOUND', { message: 'plan run not found' });
  }

  const preview = run.result === null ? null : (run.result.plan as unknown as PlanResult);

  // Заказы читаются по идентификаторам плана: и остановки, и неразмещённые.
  const orderIds =
    preview === null
      ? []
      : [
          ...preview.routes.flatMap((route) => route.stops.map((stop) => stop.orderId)),
          ...preview.unassignedOrderIds,
        ];

  const orders =
    orderIds.length === 0
      ? []
      : await db.deliveryOrder.findMany({
          where: { id: { in: orderIds } },
          select: {
            id: true,
            externalName: true,
            address: true,
            localAddress: true,
            intervalStartMinute: true,
            intervalEndMinute: true,
            manualIntervalStartMinute: true,
            manualIntervalEndMinute: true,
          },
        });

  return {
    id: run.id,
    deliveryDate: run.deliveryDate.toISOString().slice(0, 10),
    state: run.state,
    version: run.version,
    failureCode: run.failureCode,
    createdAt: run.createdAt.toISOString(),
    appliedAt: run.appliedAt?.toISOString() ?? null,
    slots: run.slots,
    preview,
    orders: orders.map((order) => ({
      id: order.id,
      number: order.externalName,
      // Правка логиста сильнее исходного адреса: курьер поедет по ней.
      address: effectiveAddress(order),
      // Ручной интервал тоже сильнее импортированного.
      intervalStartMinute: order.manualIntervalStartMinute ?? order.intervalStartMinute,
      intervalEndMinute: order.manualIntervalEndMinute ?? order.intervalEndMinute,
    })),
    routeIds: run.routes.map((route) => route.id),
  };
}

/** Экспортируется для проверки канонической сериализации снимка. */
export { canonicalJson };
