/**
 * Автоматический расчёт расстояния за МКАД.
 *
 * Расчёт ходит во внешний маршрутизатор (Valhalla) и не имеет права держать
 * подтверждение или активацию маршрута, а тем более отметку курьера «Доставлен».
 * Поэтому это durable-задание: событие ставит сообщение в транзакционный outbox
 * той же транзакцией, что и бизнес-изменение, а считает уже фоновый обработчик.
 *
 * Граница включения — московская календарная дата ДОСТАВКИ заказа: строго
 * раньше `MKAD_DISTANCE_AUTO_CALC_FROM` автоматика не трогает ничего. Отсутствие
 * переменной полностью выключает обработчик. Старые расстояния не переписываются:
 * снимок сохраняется штатным механизмом версий, прежняя запись остаётся в истории.
 *
 * Гонка с результатом доставки: основная оплата `DELIVERY_FEE` начисляется сразу
 * при «Доставлен». Если расстояние уже есть — там же начисляется `DISTANCE_FEE`.
 * Если Valhalla ответила позднее — обработчик, сохранив расстояние, добавляет
 * только отсутствующий `DISTANCE_FEE`; уникальный ключ не даёт начислить дважды.
 */

import type { Database } from '../../platform/db.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AppLogger } from '../../platform/logging/logger.js';
import { moscowCalendarDate } from '@fl/shared';
import { enqueueOutbox } from '../outbox/producer.js';
import type { OutboxHandler } from '../outbox/worker.js';
import { fromDateColumn } from '../integrations/moysklad/delivery-date.js';
import { ValhallaClient } from '../integrations/valhalla/client.js';
import { activeRing } from './mkad-bundle.js';
import { computeBeyondMkad, saveDistanceSnapshotTx, type DistanceRouter } from './mkad.js';
import { accrueDistanceFee } from './accrual.js';

export const MKAD_DISTANCE_TOPIC = 'mkad.distance' as const;

/** Ключ идемпотентности: одни координаты заказа — одно задание. */
function distanceKey(routeOrderId: string, latMicro: number, lonMicro: number): string {
  return `${MKAD_DISTANCE_TOPIC}:${routeOrderId}:${latMicro}:${lonMicro}`;
}

interface RouteOrderCoords {
  id: string;
  geoState: string;
  geoLatMicro: number | null;
  geoLonMicro: number | null;
}

const ROUTE_ORDER_SELECT = {
  id: true,
  order: { select: { geoState: true, geoLatMicro: true, geoLonMicro: true } },
} as const;

function toCoords(ro: {
  id: string;
  order: { geoState: string; geoLatMicro: number | null; geoLonMicro: number | null };
}): RouteOrderCoords {
  return {
    id: ro.id,
    geoState: ro.order.geoState,
    geoLatMicro: ro.order.geoLatMicro,
    geoLonMicro: ro.order.geoLonMicro,
  };
}

/**
 * Поставить задание для одного участия в маршруте.
 *
 * Постановка не зависит от даты доставки здесь: отсечку по границе включения и
 * по переменной держит обработчик — как у `florist.dispatch`, где границу
 * операций проверяет обработчик, а не продюсер. Без подтверждённых координат
 * считать нечего, поэтому задание не ставится.
 */
async function enqueueForCoords(tx: TransactionClient, ro: RouteOrderCoords): Promise<void> {
  const lat = ro.geoLatMicro;
  const lon = ro.geoLonMicro;
  if (lat === null || lon === null || ro.geoState !== 'RESOLVED') {
    return;
  }
  await enqueueOutbox(tx, {
    topic: MKAD_DISTANCE_TOPIC,
    idempotencyKey: distanceKey(ro.id, lat, lon),
    payload: { routeOrderId: ro.id },
  });
}

/**
 * Поставить задание для всех заказов маршрута.
 *
 * Вызывается при подтверждении и перед активацией маршрута. Постановка не ждёт
 * Valhalla; границу включения по дате доставки проверяет обработчик.
 */
export async function enqueueMkadDistanceForRoute(
  tx: TransactionClient,
  routeId: string,
): Promise<void> {
  const orders = await tx.routeOrder.findMany({
    where: { routeId, removedAt: null },
    select: ROUTE_ORDER_SELECT,
  });
  for (const ro of orders) {
    await enqueueForCoords(tx, toCoords(ro));
  }
}

/**
 * Поставить задание для одного участия в маршруте (результат «Доставлен»).
 *
 * Изменённые координаты дают новый ключ — значит новую версию снимка; прежние
 * координаты — тот же ключ, без повторной постановки.
 */
export async function enqueueMkadDistanceForRouteOrder(
  tx: TransactionClient,
  routeOrderId: string,
): Promise<void> {
  const ro = await tx.routeOrder.findUnique({
    where: { id: routeOrderId },
    select: { ...ROUTE_ORDER_SELECT, removedAt: true },
  });
  if (ro === null || ro.removedAt !== null) {
    return;
  }
  await enqueueForCoords(tx, toCoords(ro));
}

/**
 * Поставить задание по всем участиям заказа в подтверждённых/активных маршрутах.
 *
 * Вызывается при появлении/изменении подтверждённой точки заказа. Черновики
 * пропускаются: их заказы получат задание при подтверждении маршрута.
 */
export async function enqueueMkadDistanceForOrder(
  tx: TransactionClient,
  orderId: string,
): Promise<void> {
  const routeOrders = await tx.routeOrder.findMany({
    where: {
      orderId,
      removedAt: null,
      route: { state: { in: ['CONFIRMED', 'ACTIVE', 'COMPLETED'] } },
    },
    select: ROUTE_ORDER_SELECT,
  });
  for (const ro of routeOrders) {
    await enqueueForCoords(tx, toCoords(ro));
  }
}

/** Поставить задание по заказу маршрута доставленного заказа. */
export async function enqueueMkadDistanceOnDelivered(
  tx: TransactionClient,
  routeOrderId: string,
): Promise<void> {
  await enqueueMkadDistanceForRouteOrder(tx, routeOrderId);
}

export interface MkadDistanceHandlerDeps {
  db: Database;
  logger: AppLogger;
  /** Дата включения `MKAD_DISTANCE_AUTO_CALC_FROM` или `undefined`, если выключено. */
  calcFrom: string | undefined;
  /** Базовый URL Valhalla (`config.VALHALLA_URL`) или `null`. */
  valhallaUrl: string | null;
  /** Маршрутизатор для подмены в проверках; по умолчанию — Valhalla по URL. */
  router?: DistanceRouter;
}

/**
 * Обработчик outbox `mkad.distance`.
 *
 * Сетевой вызов Valhalla выполняется в транзакции воркера — как у синхронизации
 * состояния МоегоСклада. Недоступность Valhalla бросает ошибку: сообщение
 * остаётся ожидать повторной обработки с ограниченным backoff, ложный ноль не
 * сохраняется. Внутри МКАД `computeBeyondMkad` возвращает честный ноль без
 * обращения к маршрутизатору — такой снимок сохраняется даже при недоступной
 * Valhalla.
 */
export function createMkadDistanceHandler(deps: MkadDistanceHandlerDeps): OutboxHandler {
  const valhalla = new ValhallaClient({ baseUrl: deps.valhallaUrl });
  const router: DistanceRouter = deps.router ?? {
    configured: valhalla.configured,
    route: (points, costing) => valhalla.route(points, costing),
  };

  return async (message, tx) => {
    if (tx === undefined) {
      return;
    }
    // Переменная не задана — автоматика полностью выключена.
    if (deps.calcFrom === undefined) {
      return;
    }

    const payload = (message.payload ?? {}) as { routeOrderId?: unknown };
    if (typeof payload.routeOrderId !== 'string') {
      return;
    }
    const routeOrderId = payload.routeOrderId;

    const ro = await tx.routeOrder.findUnique({
      where: { id: routeOrderId },
      select: {
        id: true,
        removedAt: true,
        route: { select: { id: true, deliveryDate: true } },
        order: {
          select: {
            id: true,
            deliveryDate: true,
            geoState: true,
            geoLatMicro: true,
            geoLonMicro: true,
          },
        },
      },
    });
    // Участие снято/архивировано — считать и начислять нечего.
    if (ro === null || ro.removedAt !== null) {
      return;
    }

    // Отсечка по московской дате доставки: строго раньше границы — не трогаем.
    const deliveryDate = ro.order.deliveryDate ?? ro.route.deliveryDate;
    if (deliveryDate === null) {
      return;
    }
    if (moscowCalendarDate(deliveryDate) < deps.calcFrom) {
      return;
    }

    const lat = ro.order.geoLatMicro;
    const lon = ro.order.geoLonMicro;
    if (lat === null || lon === null || ro.order.geoState !== 'RESOLVED') {
      return;
    }

    const active = await tx.routeOrderDistance.findFirst({
      where: { routeOrderId, activeKey: { not: null } },
      select: { source: true, targetLatMicro: true, targetLonMicro: true },
    });
    // Подходящий действующий снимок уже есть — расчёт не повторяем:
    //  · ручную правку логиста не перетираем;
    //  · снимок без координат (старый или из ручного пересчёта) не трогаем;
    //  · координаты совпадают — версия та же.
    const suitable =
      active !== null &&
      (active.source === 'MANUAL' ||
        active.targetLatMicro === null ||
        (active.targetLatMicro === lat && active.targetLonMicro === lon));

    if (!suitable) {
      const ring = await activeRing(deps.db);
      if (ring === null) {
        // Кольцо не загружено: считать не от чего. Оставляем на повтор.
        throw new Error('Геометрия МКАД не загружена');
      }

      const result = await computeBeyondMkad({ id: ring.id, points: ring.points }, router, {
        routeOrderId,
        target: { lat: lat / 1_000_000, lon: lon / 1_000_000 },
        graphSha256: null,
      });
      // `null` — маршрутизатор не построил путь (в т.ч. Valhalla недоступна).
      // Ноль вместо расстояния — ложь; оставляем задачу ожидать повтора.
      if (result === null) {
        throw new Error('Расстояние за МКАД недоступно: Valhalla не ответила');
      }

      // Снимок COMPUTED обязан быть без actorUserId и без reason (инвариант
      // базы: причину имеет только ручная правка логиста).
      await saveDistanceSnapshotTx(tx, {
        routeOrderId,
        ringVersionId: ring.id,
        graphSha256: null,
        meters: result.meters,
        insideMkad: result.insideMkad,
        source: 'COMPUTED',
        targetLatMicro: lat,
        targetLonMicro: lon,
      });
    }

    // Догоняющее начисление километров, если заказ уже доставлен (расстояние
    // пришло после результата). Ключ `attempt:<id>:DISTANCE_FEE` идемпотентен:
    // повторный проход и уже начисленный при доставке случай второй записи не создают.
    const attempt = await tx.deliveryAttempt.findFirst({
      where: { routeOrderId, activeKey: { not: null }, outcome: 'DELIVERED' },
      select: { id: true, courierUserId: true },
    });
    if (attempt !== null) {
      const snapshot = await tx.routeTariffSnapshot.findUnique({
        where: { routeId: ro.route.id },
        select: { perKmMinor: true },
      });
      if (snapshot !== null) {
        await accrueDistanceFee(tx, {
          attemptId: attempt.id,
          routeOrderId,
          routeId: ro.route.id,
          orderId: ro.order.id,
          courierUserId: attempt.courierUserId,
          actorUserId: attempt.courierUserId,
          operationDate: fromDateColumn(ro.route.deliveryDate),
          perKmMinor: snapshot.perKmMinor,
        });
      }
    }
  };
}

export interface RecoverySweepResult {
  revived: number;
  enqueued: number;
}

/**
 * Ограниченный восстановительный проход.
 *
 * Две задачи, обе с жёстким лимитом:
 *  1. Оживить мёртвые (исчерпавшие попытки) задания `mkad.distance` — после
 *     долгой недоступности Valhalla они возвращаются в очередь.
 *  2. Найти заказы с датой доставки не раньше границы, у которых нет действующего
 *     расстояния, и поставить задание. Общего пересчёта прошлого нет: выборка
 *     ограничена датой включения.
 *
 * Только для `deliveryDate >= MKAD_DISTANCE_AUTO_CALC_FROM`. Без переменной проход
 * ничего не делает.
 */
export async function runMkadDistanceRecoverySweep(
  db: Database,
  opts: { calcFrom: string | undefined; limit?: number; now?: Date },
): Promise<RecoverySweepResult> {
  if (opts.calcFrom === undefined) {
    return { revived: 0, enqueued: 0 };
  }
  const limit = opts.limit ?? 200;
  const now = opts.now ?? new Date();
  const from = new Date(`${opts.calcFrom}T00:00:00.000Z`);

  // 1. Оживление мёртвых заданий: причина смерти — временная (только повторяемые
  // ошибки), поэтому возврат в очередь безопасен, а backoff не даёт частого цикла.
  const dead = await db.outboxMessage.findMany({
    where: { topic: MKAD_DISTANCE_TOPIC, status: 'DEAD' },
    select: { id: true },
    take: limit,
  });
  let revived = 0;
  if (dead.length > 0) {
    const result = await db.outboxMessage.updateMany({
      where: { id: { in: dead.map((m) => m.id) }, status: 'DEAD' },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: now },
    });
    revived = result.count;
  }

  // 2. Заказы без действующего расстояния в активном/подтверждённом маршруте.
  const orders = await db.routeOrder.findMany({
    where: {
      removedAt: null,
      route: { state: { in: ['CONFIRMED', 'ACTIVE', 'COMPLETED'] } },
      order: {
        deliveryDate: { gte: from },
        geoState: 'RESOLVED',
        geoLatMicro: { not: null },
        geoLonMicro: { not: null },
      },
      distances: { none: { activeKey: { not: null } } },
    },
    select: ROUTE_ORDER_SELECT,
    take: limit,
  });

  let enqueued = 0;
  for (const ro of orders) {
    await db.$transaction((tx) => enqueueForCoords(tx, toCoords(ro)));
    enqueued += 1;
  }

  return { revived, enqueued };
}
