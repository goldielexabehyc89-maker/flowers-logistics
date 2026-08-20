/**
 * Доска сборки: маршрутные листы, которым нужна складская работа.
 *
 * Отдельный файл, и это не оформление. Физические операции склада —
 * приёмка, комплектование, выдача — обязаны оставаться независимыми от
 * производственного контура: коробку принимают потому, что она стоит перед
 * кладовщиком, а не потому, что чей-то программный статус это разрешил.
 * Это правило закреплено проверкой по исходникам `placement.ts`,
 * `route-flow.ts`, `order-lookup.ts` и `views.ts`.
 *
 * Здесь же не операция, а ЭКРАН. Кладовщику нужно знать, почему коробки
 * ещё нет на полке: её не собрали или собрали и не донесли. Ответ на этот
 * вопрос живёт в состоянии сборки, поэтому доска его читает — но ничего
 * им не запрещает и ни одной физической операции на нём не строит.
 *
 * Порядок и разделение на группы считает СЕРВЕР по полному набору листов.
 * Сортировка на клиенте упорядочила бы только загруженную страницу, и лист
 * с самым ранним временем оказался бы внизу второй страницы.
 */

import type { $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { fromDateColumn } from '../integrations/moysklad/delivery-date.js';

/**
 * Складская стадия одного заказа листа.
 *
 * «Готов» ставится ТОЛЬКО за действующее размещение в маршрутной ячейке
 * этого листа. Коробка в чужой маршрутной ячейке готовностью не считается:
 * она стоит на полке другого курьера и уедет вместе с ним.
 */
export type RouteOrderStage = 'NOT_ASSEMBLED' | 'AWAITING_INTAKE' | 'IN_STORAGE' | 'READY';

export interface AssemblyOrderView {
  orderId: string;
  orderNumber: string;
  position: number;
  /** Минуты от полуночи Москвы. `null` — интервал не распознан. */
  startMinute: number | null;
  endMinute: number | null;
  cellCode: string | null;
  cellKind: $Enums.StorageCellKind | null;
  stage: RouteOrderStage;
  /** Маршрут менялся после комплектования: коробку надо переставить. */
  requiresRelocation: boolean;
  /** Заказ отменён — везти его нельзя ни при какой готовности. */
  cancelled: boolean;
}

export interface AssemblyRouteView {
  routeId: string;
  routeNumber: string;
  deliveryDate: string;
  /** Раннее распознанное начало интервала среди действующих заказов. */
  earliestMinute: number | null;
  courier: { id: string; fullName: string } | null;
  cells: { id: string; code: string }[];
  total: number;
  ready: number;
  orders: AssemblyOrderView[];
}

export interface AssemblyBoard {
  /** Листы, которым ещё нужна складская работа. */
  active: AssemblyRouteView[];
  /**
   * Листы, у которых собрано всё, но часть коробок ещё в хранении.
   *
   * Это очередь готовой работы: идти нужно не к флористу и не за недостающей
   * коробкой, а к полке хранения — перенести. Отдельная группа существует
   * потому, что раньше такой лист лежал среди тех, где чего-то не хватает,
   * и отличить «нечего нести» от «есть что нести» можно было только раскрыв
   * каждый лист по очереди.
   */
  relocatable: AssemblyRouteView[];
  /** Полностью собранные листы: все действующие заказы в ячейках листа. */
  assembled: AssemblyRouteView[];
}

/**
 * Все подтверждённые неотгруженные листы.
 *
 * День не ограничивается намеренно. Незавершённый лист вчерашнего дня
 * не перестаёт требовать работы оттого, что наступило завтра: коробки
 * стоят на полках, и спрятать лист значит потерять их.
 */
export async function readAssemblyBoard(db: Database): Promise<AssemblyBoard> {
  const routes = await db.deliveryRoute.findMany({
    where: { state: 'CONFIRMED' },
    select: {
      id: true,
      number: true,
      deliveryDate: true,
      courier: { select: { id: true, fullName: true } },
      cellBindings: {
        where: { releasedAt: null },
        orderBy: { boundAt: 'asc' },
        select: { cell: { select: { id: true, code: true } } },
      },
      orders: {
        where: { removedAt: null },
        orderBy: { position: 'asc' },
        select: {
          position: true,
          order: {
            select: {
              id: true,
              externalName: true,
              intervalStartMinute: true,
              intervalEndMinute: true,
              manualIntervalStartMinute: true,
              manualIntervalEndMinute: true,
              cancelledInSource: true,
              cancelledByLogistAt: true,
              fulfillmentProcessState: true,
              placements: {
                where: { releasedAt: null },
                select: {
                  requiresRelocation: true,
                  cell: { select: { id: true, code: true, kind: true } },
                },
                take: 1,
              },
            },
          },
        },
      },
    },
  });

  const views = routes.map((route) => {
    const cells = route.cellBindings.map((binding) => binding.cell);
    const cellIds = new Set(cells.map((cell) => cell.id));

    const orders: AssemblyOrderView[] = route.orders.map((participation) => {
      const order = participation.order;
      const placement = order.placements[0] ?? null;
      const startMinute = order.manualIntervalStartMinute ?? order.intervalStartMinute;

      return {
        orderId: order.id,
        orderNumber: order.externalName,
        position: participation.position,
        startMinute,
        endMinute: order.manualIntervalEndMinute ?? order.intervalEndMinute,
        cellCode: placement?.cell.code ?? null,
        cellKind: placement?.cell.kind ?? null,
        stage: stageOf(order, placement, cellIds),
        requiresRelocation: placement?.requiresRelocation ?? false,
        cancelled: order.cancelledInSource || order.cancelledByLogistAt !== null,
      };
    });

    const ready = orders.filter((order) => order.stage === 'READY').length;
    const minutes = orders
      .map((order) => order.startMinute)
      .filter((minute): minute is number => minute !== null);

    return {
      routeId: route.id,
      routeNumber: route.number,
      deliveryDate: fromDateColumn(route.deliveryDate),
      earliestMinute: minutes.length === 0 ? null : Math.min(...minutes),
      courier: route.courier,
      cells,
      total: orders.length,
      ready,
      orders,
    };
  });

  const sorted = [...views].sort(compareRoutes);

  /*
   * Группы считает сервер и по ПОЛНОМУ набору листов.
   *
   * Три состояния взаимоисключающие по построению: «собран» требует, чтобы
   * в хранении не осталось ни одного заказа, «можно переносить» — чтобы
   * остался хотя бы один. Лист, не попавший ни в одну, остаётся активным.
   */
  const relocatable = sorted.filter(isRelocatable);
  const assembled = sorted.filter(isAssembled);
  const moved = new Set([...relocatable, ...assembled]);

  return {
    active: sorted.filter((route) => !moved.has(route)),
    relocatable,
    assembled,
  };
}

/**
 * Полностью ли собран лист.
 *
 * Источник истины — состав листа и действующие размещения, а не отдельный
 * флаг. Флаг пришлось бы гасить при каждом исключении заказа, отмене
 * и перестановке коробки, и однажды он остался бы включённым.
 *
 * Пустой лист собранным не считается: собирать в нём нечего, и показывать
 * его среди готовых значит обещать курьеру пустую машину.
 */
export function isAssembled(route: {
  total: number;
  orders: readonly { stage: RouteOrderStage; requiresRelocation: boolean; cancelled: boolean }[];
}): boolean {
  if (route.total === 0) {
    return false;
  }
  return route.orders.every(
    (order) => order.stage === 'READY' && !order.requiresRelocation && !order.cancelled,
  );
}

/**
 * Можно ли лист просто перенести на маршрутные полки.
 *
 * Условие ровно одно и физическое: КАЖДАЯ коробка листа уже стоит на складе,
 * и хотя бы одна из них стоит в хранении. Тогда кладовщику нечего ждать —
 * вся работа сводится к переносу.
 *
 * Отменённый заказ выводит лист отсюда: он требует решения логиста, а не
 * переноса, и обещать «можно нести» про лист, который нельзя везти, нельзя.
 *
 * Пометка «требуется перемещение» здесь НЕ помеха: её ставят ровно тогда,
 * когда коробка легла в хранение, а действующий лист её ждёт, — то есть это
 * и есть признак этой группы, а не признак поломки.
 */
export function isRelocatable(route: {
  total: number;
  orders: readonly {
    stage: RouteOrderStage;
    cellKind: $Enums.StorageCellKind | null;
    requiresRelocation: boolean;
    cancelled: boolean;
  }[];
}): boolean {
  if (route.total === 0) {
    return false;
  }
  if (route.orders.some((order) => order.cancelled)) {
    return false;
  }

  /*
   * Годятся ровно два места: ячейка ЭТОГО листа и обычное хранение.
   *
   * Стадия «в хранении» одна на два разных случая — своя полка хранения
   * и чужая маршрутная полка, — поэтому одной её мало. Коробка на полке
   * другого курьера переносом не решается: сначала надо разобраться, как
   * она туда попала, и такой лист остаётся среди активных.
   */
  const movable = route.orders.every(
    (order) =>
      (order.stage === 'READY' && !order.requiresRelocation) ||
      (order.stage === 'IN_STORAGE' && order.cellKind === 'STORAGE'),
  );
  return movable && route.orders.some((order) => order.stage === 'IN_STORAGE');
}

/**
 * Порядок листов на доске.
 *
 * Сначала день доставки, потом раннее время внутри дня, потом номер.
 * Лист без распознанного времени идёт после листов со временем того же
 * дня: время у него неизвестно, и ставить его вперёд значило бы выдать
 * догадку за расписание.
 */
export function compareRoutes(
  left: { deliveryDate: string; earliestMinute: number | null; routeNumber: string },
  right: { deliveryDate: string; earliestMinute: number | null; routeNumber: string },
): number {
  if (left.deliveryDate !== right.deliveryDate) {
    return left.deliveryDate < right.deliveryDate ? -1 : 1;
  }
  if (left.earliestMinute !== right.earliestMinute) {
    if (left.earliestMinute === null) return 1;
    if (right.earliestMinute === null) return -1;
    return left.earliestMinute - right.earliestMinute;
  }
  return left.routeNumber.localeCompare(right.routeNumber, 'ru');
}

function stageOf(
  order: { fulfillmentProcessState: string },
  placement: { cell: { id: string } } | null,
  routeCellIds: ReadonlySet<string>,
): RouteOrderStage {
  if (placement !== null) {
    return routeCellIds.has(placement.cell.id) ? 'READY' : 'IN_STORAGE';
  }
  /*
   * Размещения нет — коробки на складе нет вовсе.
   *
   * Различаются два случая, и кладовщику важен именно этот выбор: идти
   * к флористу за букетом или ждать, пока его донесут.
   */
  return order.fulfillmentProcessState === 'ASSEMBLED' ? 'AWAITING_INTAKE' : 'NOT_ASSEMBLED';
}

// --- Доска выдачи ------------------------------------------------------------

export interface IssueOrderView {
  orderId: string;
  orderNumber: string;
  position: number;
  /**
   * Ячейка, в которой коробка лежит СЕЙЧАС: маршрутная или хранения.
   *
   * Раньше показывалась только маршрутная, а коробка в хранении выглядела
   * как «нет ячейки» и подписывалась «Не готов». Кладовщик шёл искать её
   * наугад, хотя полка известна. `null` остаётся ровно для одного случая —
   * действующего размещения нет вовсе.
   */
  cellCode: string | null;
  /** Тип ячейки считает сервер: восстанавливать его по коду на клиенте нельзя. */
  cellKind: $Enums.StorageCellKind | null;
  ready: boolean;
  /** Коробка стоит в маршрутной ячейке ИМЕННО этого листа. */
  inRouteCell: boolean;
  /** Заказ уже внесён в лист текущей проверкой. */
  checked: boolean;
}

/**
 * Готовность листа к выдаче одним словом.
 *
 * Два положительных состояния различаются не правом отгрузить — оно у них
 * одинаковое, — а тем, где сейчас стоят коробки. Кладовщику это решает,
 * идти ли ему по полкам хранения: «собран» означает, что всё уже на своей
 * маршрутной полке и собирать по складу нечего.
 */
export type IssueReadiness =
  /** Все коробки на своих маршрутных полках. */
  | 'ASSEMBLED'
  /** Все коробки на складе, часть — в хранении. */
  | 'CAN_ISSUE'
  /** Чего-то не хватает: не собран, не размещён, отменён. */
  | 'NOT_READY';

export interface IssueRouteView {
  routeId: string;
  routeNumber: string;
  deliveryDate: string;
  earliestMinute: number | null;
  total: number;
  checked: number;
  /** Открыта ли сессия выдачи: до неё вносить заказы нельзя. */
  sessionOpen: boolean;
  /** Лист готов к отгрузке: каждый заказ на складе и не отменён. */
  shippable: boolean;
  /** Состояние считает СЕРВЕР по полному составу; клиент только показывает. */
  readiness: IssueReadiness;
  orders: IssueOrderView[];
}

export interface IssueCourierView {
  courierUserId: string;
  fullName: string;
  /** Телефон приходит обычным авторизованным ответом и в realtime не уходит. */
  phone: string;
  routes: IssueRouteView[];
}

/**
 * Состояние готовности листа по полному составу заказов.
 *
 * Пустой лист готовым не бывает: везти нечего.
 */
export function issueReadiness(
  orders: readonly { ready: boolean; inRouteCell: boolean }[],
): IssueReadiness {
  if (orders.length === 0 || !orders.every((order) => order.ready)) {
    return 'NOT_READY';
  }
  return orders.every((order) => order.inRouteCell) ? 'ASSEMBLED' : 'CAN_ISSUE';
}

/**
 * Курьеры с листами, ожидающими складской выдачи.
 *
 * Лист без курьера сюда не попадает: выдавать его некому, и он остаётся
 * в «Сборке». Появление курьера у листа приводит его сюда само.
 */
export async function readIssueBoard(db: Database): Promise<IssueCourierView[]> {
  const routes = await db.deliveryRoute.findMany({
    where: { state: 'CONFIRMED', courierUserId: { not: null } },
    select: {
      id: true,
      number: true,
      deliveryDate: true,
      courier: { select: { id: true, fullName: true, phone: true, status: true } },
      cellBindings: { where: { releasedAt: null }, select: { cellId: true } },
      issueSessions: {
        where: { state: 'OPEN' },
        select: {
          id: true,
          checks: { where: { clearedAt: null }, select: { orderId: true } },
        },
      },
      orders: {
        where: { removedAt: null },
        orderBy: { position: 'asc' },
        select: {
          position: true,
          order: {
            select: {
              id: true,
              externalName: true,
              intervalStartMinute: true,
              manualIntervalStartMinute: true,
              cancelledInSource: true,
              cancelledByLogistAt: true,
              placements: {
                where: { releasedAt: null },
                select: {
                  requiresRelocation: true,
                  cell: { select: { id: true, code: true, kind: true } },
                },
                take: 1,
              },
            },
          },
        },
      },
    },
  });

  const byCourier = new Map<string, IssueCourierView>();

  for (const route of routes) {
    const courier = route.courier;
    if (courier === null) {
      continue;
    }

    const cellIds = new Set(route.cellBindings.map((binding) => binding.cellId));
    const session = route.issueSessions[0] ?? null;
    const checkedIds = new Set((session?.checks ?? []).map((check) => check.orderId));

    const orders: IssueOrderView[] = route.orders.map((participation) => {
      const order = participation.order;
      const placement = order.placements[0] ?? null;
      const cancelled = order.cancelledInSource || order.cancelledByLogistAt !== null;
      /*
       * Готовность к выдаче.
       *
       * Коробка годится, если она лежит либо в ячейке ЭТОГО листа, либо
       * в обычном хранении: лист отгружается целиком, и нести его можно
       * и с полки хранения. Чужая маршрутная ячейка по-прежнему готовностью
       * не считается — это полка другого курьера, и коробка уедет с ним.
       */
      const ownCell = placement !== null && cellIds.has(placement.cell.id);
      const storageCell = placement !== null && placement.cell.kind === 'STORAGE';
      /*
       * Пометка «требуется перемещение» на МАРШРУТНОЙ полке означает, что
       * после комплектования что-то изменилось: состав листа или сам заказ.
       * В хранении та же пометка стоит на любой коробке, которую ждёт
       * маршрут, и готовности не мешает — иначе отгрузить из хранения было
       * бы нельзя вовсе.
       */
      const brokenRouteCell = ownCell && placement.requiresRelocation;
      const ready =
        placement !== null && (storageCell || ownCell) && !brokenRouteCell && !cancelled;

      return {
        orderId: order.id,
        orderNumber: order.externalName,
        position: participation.position,
        // Ячейки нет только тогда, когда нет действующего размещения.
        cellCode: placement?.cell.code ?? null,
        cellKind: placement?.cell.kind ?? null,
        ready,
        inRouteCell: ownCell,
        checked: checkedIds.has(order.id),
      };
    });

    const minutes = route.orders
      .map((item) => item.order.manualIntervalStartMinute ?? item.order.intervalStartMinute)
      .filter((minute): minute is number => minute !== null);

    const view: IssueRouteView = {
      routeId: route.id,
      routeNumber: route.number,
      deliveryDate: fromDateColumn(route.deliveryDate),
      earliestMinute: minutes.length === 0 ? null : Math.min(...minutes),
      total: orders.length,
      checked: orders.filter((order) => order.checked).length,
      sessionOpen: session !== null,
      /*
       * Готовность считает СЕРВЕР и пересчитывает каждый раз.
       *
       * Отгрузить можно только лист, у которого каждый действующий заказ
       * стоит на складе — в ячейке этого листа или в хранении — и не отменён.
       * Пустой лист не отгружается: везти нечего.
       */
      shippable: orders.length > 0 && orders.every((order) => order.ready),
      readiness: issueReadiness(orders),
      orders,
    };

    const existing = byCourier.get(courier.id);
    if (existing === undefined) {
      byCourier.set(courier.id, {
        courierUserId: courier.id,
        fullName: courier.fullName,
        phone: courier.phone,
        routes: [view],
      });
    } else {
      existing.routes.push(view);
    }
  }

  const couriers = [...byCourier.values()];
  for (const courier of couriers) {
    courier.routes.sort(compareRoutes);
  }
  // Курьеры по имени: список короткий, и алфавит здесь понятнее любого
  // другого порядка.
  couriers.sort((left, right) => left.fullName.localeCompare(right.fullName, 'ru'));
  return couriers;
}
