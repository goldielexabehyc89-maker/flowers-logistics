/**
 * API ручных маршрутов-черновиков.
 *
 * Доступ только у `ADMIN` и `LOGISTICIAN`: курьеру нужен собственный список доставок,
 * а не глобальная картина распределения, и он появится вместе с отгрузкой.
 * `DELETE`-маршрутов нет и не будет: маршрут отменяется, но не стирается.
 *
 * Наружу не уходят сырые снимки МоегоСклада и денежные поля: для планирования
 * черновика они не нужны, а лишние персональные данные в ответе — это лишний риск.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { ValhallaClient } from '../integrations/valhalla/client.js';
import { createTestRouterFetch } from '../integrations/valhalla/test-router.js';
import { routeGeometry } from './geometry.js';
import { cancelShipment, shipRouteManually } from './lifecycle.js';
import { listSheets } from './sheets.js';
import { AppError } from '../../platform/errors.js';
import { authenticateWithRoles, type AuthenticatedActor } from '../auth/guards.js';
import { fromDateColumn, isCalendarDate } from '../integrations/moysklad/delivery-date.js';
import { toDecimalString } from '../integrations/moysklad/money.js';
import { assignmentStateOf, calendarDate } from './eligibility.js';
// Рабочий адрес считается в одном месте на весь продукт.
import { addressDetailsOf, effectiveAddress, ORDER_ADDRESS_SELECT } from '../orders/address.js';
import {
  addOrders,
  createEmptyDraft,
  createDraftFromSelection,
  MAX_SELECTION_SIZE,
  moveOrders,
  reorder,
  returnOrders,
  setCourier,
  type RequestContext,
} from './service.js';
import {
  acquireLease,
  describeLease,
  heartbeatLease,
  LEASE_HEARTBEAT_MS,
  LEASE_TTL_MS,
  releaseLease,
  takeoverLease,
} from './lease.js';
import { cancelRoute, confirmBlockers, confirmRoute, returnToDraft } from './lifecycle.js';

const ROUTE_ROLES = ['ADMIN', 'LOGISTICIAN'] as const;
const MAX_LIMIT = 100;
/** Разумный потолок массовой операции: он же защищает от случайной отправки всего дня. */
const MAX_ORDERS_PER_OPERATION = 200;

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Некорректный id');

/**
 * Календарная дата с проверкой существования дня.
 *
 * Одной формы `ГГГГ-ММ-ДД` мало: `2026-02-30` прошла бы регулярное выражение,
 * а дальше либо упала бы внутренней ошибкой базы, либо — в фильтре списка —
 * молча превратилась бы в первое марта и вернула маршруты другого дня.
 */
const dateSchema = z
  .string()
  .refine(isCalendarDate, 'Ожидается существующая дата в формате ГГГГ-ММ-ДД');

const idParamSchema = z.object({ id: uuid });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  deliveryDate: dateSchema.optional(),
  courierUserId: uuid.optional(),
  vehicleType: z.enum(['CAR', 'FOOT']).optional(),
  // `ACTIVE` включён: маршрут, переданный курьеру, обязан оставаться видимым
  // логисту, а не исчезать из выборки дня.
  state: z.enum(['DRAFT', 'CONFIRMED', 'CANCELLED', 'ACTIVE']).optional(),
});

/**
 * Пустой черновик: дата и тип машины, заказов нет.
 *
 * Состав сюда не принимается вовсе — маршрут из выбора создаёт
 * `/api/routes/from-selection`, и требование непустого выбора там остаётся.
 */
const createSchema = z.object({
  deliveryDate: dateSchema,
  vehicleType: z.enum(['CAR', 'FOOT']),
  /** Ключ запроса: повтор возвращает уже созданный черновик, а не второй. */
  creationKey: uuid.optional(),
});

/**
 * Черновик ровно из выбора «Сделок».
 *
 * Порядок массива — это порядок остановок: логист расставил номера на карте,
 * и сервер обязан сохранить именно его.
 */
const selectionDraftSchema = z.object({
  deliveryDate: dateSchema,
  vehicleType: z.enum(['CAR', 'FOOT']),
  orderIds: z.array(uuid).min(1).max(MAX_SELECTION_SIZE),
  /** Курьер выбирается заранее и необязателен: назначить его можно позже. */
  courierUserId: uuid.nullable().optional(),
  /** `SHEET` — сразу маршрутный лист одной транзакцией, `DRAFT` — черновик. */
  mode: z.enum(['DRAFT', 'SHEET']).optional(),
});

/**
 * Отмена отгрузки.
 *
 * Причина обязательна только для `ALL`: это исправление уже состоявшегося
 * факта доставки, и без объяснения оно в истории бессмысленно.
 */
const sheetsQuerySchema = z.object({
  section: z.enum(['UNSHIPPED', 'SHIPPED', 'DELIVERED']),
  deliveryDate: dateSchema.optional(),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const cancelShipmentSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    mode: z.enum(['UNFINISHED', 'ALL']),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .refine((value) => value.mode !== 'ALL' || value.reason !== undefined, {
    message: 'Возврат доставленных заказов требует причины',
    path: ['reason'],
  });

const ordersSchema = z.object({
  orderIds: z.array(uuid).min(1).max(MAX_ORDERS_PER_OPERATION),
  expectedVersion: z.number().int().min(0),
});

const moveSchema = z.object({
  fromRouteId: uuid,
  toRouteId: uuid,
  orderIds: z.array(uuid).min(1).max(MAX_ORDERS_PER_OPERATION),
  expectedSourceVersion: z.number().int().min(0),
  expectedTargetVersion: z.number().int().min(0),
});

const courierSchema = z.object({
  courierUserId: uuid.nullable(),
  expectedVersion: z.number().int().min(0),
});

const versionSchema = z.object({ expectedVersion: z.number().int().min(0) });

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Причина решения: слишком короткая ничего не объясняет, слишком длинная не читается. */
const reasonSchema = z.object({
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().min(3).max(500),
});

const takeoverSchema = z.object({
  confirm: z.literal(true),
  reason: z.string().trim().min(3).max(500),
  expectedLeaseVersion: z.number().int().min(1),
});

interface RoutingDeps {
  db: Database;
  config: AppConfig;
  /** Часы вынесены наружу: тесты аренды не должны ждать реального времени. */
  now?: () => Date;
}

interface IncomingRequest {
  ip: string;
  headers: { authorization?: string | undefined; 'user-agent'?: string | undefined };
}

function contextOf(request: IncomingRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
  };
}

/** Курьер в ответе — только идентификатор и имя: телефон здесь не нужен. */
const courierSelect = { id: true, fullName: true } as const;

export async function registerRoutingRoutes(app: AppServer, deps: RoutingDeps): Promise<void> {
  /*
   * Маршрутизатор для линии пути.
   *
   * Клиент создаётся один раз на регистрацию: он не держит состояния, а его
   * адрес известен только серверу. Незаданный адрес — не отказ: контракт
   * геометрии честно скажет, что линия не строится, а ручная работа
   * продолжится (`ROUTE-003`).
   */
  /*
   * На локальном стенде дорожного графа нет, и линия не строилась бы вовсе.
   * Подменяется ТОЛЬКО транспорт: клиент, разбор ответа и контракт остаются
   * настоящими, а сама подмена запрещена конфигурацией вне `APP_ENV=local`.
   */
  const router = deps.config.VALHALLA_TEST_ROUTE
    ? new ValhallaClient({
        baseUrl: deps.config.VALHALLA_URL ?? 'http://valhalla.local.test',
        fetch: createTestRouterFetch(),
      })
    : new ValhallaClient({ baseUrl: deps.config.VALHALLA_URL ?? null });

  /**
   * Маршрутные листы одного раздела: днями, страницами, с фильтром и поиском.
   *
   * Отбор считает сервер: лист, не попавший на первую страницу, обязан
   * находиться поиском, а не исчезать из него.
   */
  app.get('/api/route-sheets', async (request) => {
    await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const query = sheetsQuerySchema.parse(request.query);
    return listSheets(deps.db, query);
  });

  /** Фактическая геометрия маршрута: склад, остановки по порядку и линия. */
  app.get('/api/routes/:id/geometry', async (request) => {
    await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return routeGeometry(deps.db, router, id);
  });

  app.get('/api/routes', async (request) => {
    await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const query = listQuerySchema.parse(request.query);

    const where: Record<string, unknown> = {};
    if (query.deliveryDate !== undefined) {
      where['deliveryDate'] = new Date(`${query.deliveryDate}T00:00:00.000Z`);
    }
    if (query.courierUserId !== undefined) {
      where['courierUserId'] = query.courierUserId;
    }
    if (query.vehicleType !== undefined) {
      where['vehicleType'] = query.vehicleType;
    }
    where['state'] = query.state ?? 'DRAFT';

    const [rows, total] = await Promise.all([
      deps.db.deliveryRoute.findMany({
        where,
        orderBy: [{ deliveryDate: 'asc' }, { number: 'asc' }],
        take: query.limit,
        skip: query.offset,
        select: {
          id: true,
          number: true,
          deliveryDate: true,
          state: true,
          vehicleType: true,
          version: true,
          createdAt: true,
          courier: { select: courierSelect },
          orders: {
            where: { removedAt: null },
            select: { id: true, conflicts: { select: { kind: true } } },
          },
        },
      }),
      deps.db.deliveryRoute.count({ where }),
    ]);

    return {
      items: rows.map((route) => ({
        id: route.id,
        number: route.number,
        deliveryDate: fromDateColumn(route.deliveryDate),
        state: route.state,
        vehicleType: route.vehicleType,
        version: route.version,
        createdAt: route.createdAt.toISOString(),
        courier: route.courier,
        orderCount: route.orders.length,
        conflictCount: route.orders.filter((item) => item.conflicts.length > 0).length,
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  });

  /**
   * Пустой черновик дня.
   *
   * Логист заводит его заранее и наполняет нераспределёнными заказами.
   * Повтор запроса с тем же ключом возвращает прежний маршрут и код 200:
   * 201 означал бы, что создан ещё один.
   */
  app.post('/api/routes/empty', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const body = createSchema.parse(request.body);

    const created = await createEmptyDraft(deps, actor, body, contextOf(request));
    return reply.code(created.repeated ? 200 : 201).send(created);
  });

  /**
   * Один маршрут ровно из выбранных заказов.
   *
   * По умолчанию — черновик. `mode: 'SHEET'` доводит его до маршрутного листа
   * той же доменной операцией подтверждения и в той же транзакции.
   */
  app.post('/api/routes/from-selection', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const body = selectionDraftSchema.parse(request.body);

    const created = await createDraftFromSelection(deps, actor, body, contextOf(request));
    // Повтор потерянного ответа возвращает прежний маршрут и код 200:
    // 201 означал бы, что создан ещё один.
    return reply.code(created.repeated ? 200 : 201).send(created);
  });

  app.get('/api/routes/:id', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return routeCard(deps.db, id, actor);
  });

  app.post('/api/routes/:id/orders', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = ordersSchema.parse(request.body);

    await addOrders(deps, actor, id, body, contextOf(request));
    return routeCard(deps.db, id, actor);
  });

  app.post('/api/routes/:id/orders/return', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = ordersSchema.parse(request.body);

    await returnOrders(deps, actor, id, body, contextOf(request));
    return routeCard(deps.db, id, actor);
  });

  /** Полный список активных заказов в нужном порядке. Частичная перестановка отклоняется. */
  app.put('/api/routes/:id/orders/reorder', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = ordersSchema.parse(request.body);

    await reorder(deps, actor, id, body, contextOf(request));
    return routeCard(deps.db, id, actor);
  });

  app.post('/api/routes/move', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const body = moveSchema.parse(request.body);

    const result = await moveOrders(deps, actor, body, contextOf(request));
    return {
      source: await routeCard(deps.db, body.fromRouteId, actor),
      target: await routeCard(deps.db, body.toRouteId, actor),
      versions: result,
    };
  });

  app.put('/api/routes/:id/courier', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = courierSchema.parse(request.body);

    await setCourier(deps, actor, id, body, contextOf(request));
    return routeCard(deps.db, id, actor);
  });

  // --- Жизненный цикл ------------------------------------------------------

  /**
   * Ручная отгрузка маршрутного листа без сканирования.
   *
   * Тот же доменный переход, что и складская выдача: параллельного изменения
   * статуса здесь нет. Доступна логисту и администратору при включённой
   * глобальной настройке, менять которую может только администратор.
   */
  app.post('/api/routes/:id/ship', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = versionSchema.parse(request.body);

    await shipRouteManually(deps, actor, id, body, contextOf(request));
    return routeCard(deps.db, id, actor);
  });

  /**
   * Отмена отгрузки маршрутного листа.
   *
   * `UNFINISHED` делит лист: доставленные остаются в исходном, незавершённые
   * переезжают в новый неотгруженный. Его номер возвращается ответом — клиент
   * не вычисляет его сам и показывает только после успешной операции.
   *
   * `ALL` возвращает в работу и доставленные заказы: требует причины и
   * оформляется административной коррекцией с сохранением прежнего факта.
   */
  app.post('/api/routes/:id/cancel-shipment', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = cancelShipmentSchema.parse(request.body);

    const result = await cancelShipment(deps, actor, id, body, contextOf(request));
    return {
      route: await routeCard(deps.db, id, actor),
      // Номер нового листа приходит с сервера: браузеру его вычислять неоткуда.
      createdSheet: result.createdSheet,
      restoredOrders: result.restoredOrders,
      unchanged: result.unchanged,
    };
  });

  app.post('/api/routes/:id/confirm', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = versionSchema.parse(request.body);

    await confirmRoute(deps, actor, id, body, contextOf(request));
    return routeCard(deps.db, id, actor);
  });

  app.post('/api/routes/:id/return-to-draft', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = reasonSchema.parse(request.body);

    await returnToDraft(deps, actor, id, body, contextOf(request));
    return routeCard(deps.db, id, actor);
  });

  app.post('/api/routes/:id/cancel', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = reasonSchema.parse(request.body);

    await cancelRoute(deps, actor, id, body, contextOf(request));
    return routeCard(deps.db, id, actor);
  });

  // --- Мягкая блокировка редактора -----------------------------------------

  app.get('/api/routes/:id/edit-lock', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return {
      editLock: await leaseView(deps, id, actor),
      ttlMs: LEASE_TTL_MS,
      heartbeatMs: LEASE_HEARTBEAT_MS,
    };
  });

  app.post('/api/routes/:id/edit-lock/acquire', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);

    // `granted` отличает выданную аренду от продления собственной. Клиенту это
    // нужно, чтобы после разовой операции освободить ровно то, что он занял,
    // и не отнять маршрут у своей же открытой карточки.
    const result = await acquireLease(deps, actor, id, contextOf(request));
    return {
      editLock: await leaseView(deps, id, actor),
      granted: result.granted,
      ttlMs: LEASE_TTL_MS,
      heartbeatMs: LEASE_HEARTBEAT_MS,
    };
  });

  app.post('/api/routes/:id/edit-lock/heartbeat', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);

    await heartbeatLease(deps, actor, id);
    return { editLock: await leaseView(deps, id, actor) };
  });

  app.post('/api/routes/:id/edit-lock/release', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);

    await releaseLease(deps, actor, id, contextOf(request));
    return { editLock: await leaseView(deps, id, actor) };
  });

  app.post('/api/routes/:id/edit-lock/takeover', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = takeoverSchema.parse(request.body);

    await takeoverLease(deps, actor, id, body, contextOf(request));
    return { editLock: await leaseView(deps, id, actor) };
  });

  app.get('/api/routes/:id/history', async (request) => {
    await authenticateWithRoles(request, deps, ROUTE_ROLES);
    const { id } = idParamSchema.parse(request.params);

    const route = await deps.db.deliveryRoute.findUnique({ where: { id }, select: { id: true } });
    if (route === null) {
      throw new AppError('NOT_FOUND', { message: 'route not found' });
    }

    const query = historyQuerySchema.parse(request.query);

    const [entries, total, transitions, transitionTotal] = await Promise.all([
      deps.db.auditLog.findMany({
        where: { entityType: 'DeliveryRoute', entityId: id },
        // Порядок доопределён идентификатором: у операции перемещения две записи
        // с одинаковым временем, и без этого они менялись бы местами между запросами.
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        skip: query.offset,
        select: {
          occurredAt: true,
          action: true,
          actorUserId: true,
          actorRoles: true,
          newValue: true,
          source: true,
        },
      }),
      deps.db.auditLog.count({ where: { entityType: 'DeliveryRoute', entityId: id } }),
      // Переходы состояния показываются отдельно: причина решения хранится только
      // здесь, в защищённой истории, и в realtime не уходит.
      deps.db.routeStateTransition.findMany({
        where: { routeId: id },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        // Пагинация та же, что у аудита: без пропуска вторая страница повторяла бы
        // переходы первой, и история выглядела бы длиннее, чем она есть.
        take: query.limit,
        skip: query.offset,
        select: {
          occurredAt: true,
          fromState: true,
          toState: true,
          actorUserId: true,
          reason: true,
        },
      }),
      // Счётчики раздельные: у аудита и у переходов разное количество записей,
      // и общий total не позволил бы клиенту понять, где заканчивается каждый список.
      deps.db.routeStateTransition.count({ where: { routeId: id } }),
    ]);

    return {
      items: entries.map((entry) => ({
        occurredAt: entry.occurredAt.toISOString(),
        action: entry.action,
        actorUserId: entry.actorUserId,
        actorRoles: entry.actorRoles,
        source: entry.source,
        value: entry.newValue,
      })),
      transitions: transitions.map((entry) => ({
        occurredAt: entry.occurredAt.toISOString(),
        fromState: entry.fromState,
        toState: entry.toState,
        actorUserId: entry.actorUserId,
        reason: entry.reason,
      })),
      total,
      transitionTotal,
      limit: query.limit,
      offset: query.offset,
    };
  });
}

/**
 * Карточка маршрута.
 *
 * Возвращается после каждой мутации: клиенту нужны и новая версия, и актуальный
 * состав — иначе интерфейсу пришлось бы делать второй запрос и он успел бы
 * показать устаревший порядок.
 */
async function leaseView(deps: RoutingDeps, routeId: string, actor: AuthenticatedActor) {
  const lease = await deps.db.routeEditLease.findUnique({
    where: { routeId },
    include: { holder: { select: { id: true, fullName: true } } },
  });
  return describeLease(lease, actor, deps.now?.() ?? new Date());
}

async function routeCard(db: Database, id: string, actor: AuthenticatedActor) {
  const route = await db.deliveryRoute.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      deliveryDate: true,
      state: true,
      vehicleType: true,
      version: true,
      createdAt: true,
      updatedAt: true,
      courier: { select: courierSelect },
      orders: {
        where: { removedAt: null },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          position: true,
          addedAt: true,
          conflicts: { select: { kind: true, detectedAt: true } },
          order: {
            select: {
              id: true,
              externalName: true,
              deliveryDate: true,
              intervalRaw: true,
              intervalKind: true,
              intervalStartMinute: true,
              intervalEndMinute: true,
              manualIntervalStartMinute: true,
              manualIntervalEndMinute: true,
              ...ORDER_ADDRESS_SELECT,
              recipient: true,
              comment: true,
              needsAttention: true,
              attentionReasons: true,
              inScope: true,
              sourceMissing: true,
              sourceArchived: true,
              cancelledInSource: true,
              cancelledByLogistAt: true,
              // Единственное денежное поле маршрутного листа: курьеру нужно знать,
              // сколько взять. Суммы заказа, оплаты и признаки аномалии здесь лишние.
              cashCollectable: true,
              cashToCollectMinor: true,
            },
          },
        },
      },
    },
  });

  if (route === null) {
    throw new AppError('NOT_FOUND', { message: 'route not found' });
  }

  const routeDate = calendarDate(route.deliveryDate);
  const lease = await db.routeEditLease.findUnique({
    where: { routeId: id },
    include: { holder: { select: { id: true, fullName: true } } },
  });
  // Блокировки подтверждения показываются заранее: логист должен видеть причину
  // до нажатия кнопки, а не узнавать о ней из отказа.
  const blockers = route.state === 'DRAFT' ? await confirmBlockers(db, id) : [];

  return {
    id: route.id,
    number: route.number,
    deliveryDate: fromDateColumn(route.deliveryDate),
    state: route.state,
    vehicleType: route.vehicleType,
    version: route.version,
    createdAt: route.createdAt.toISOString(),
    updatedAt: route.updatedAt.toISOString(),
    courier: route.courier,
    conflictCount: route.orders.filter((item) => item.conflicts.length > 0).length,
    editLock: describeLease(lease, actor, new Date()),
    confirmBlockers: blockers,
    orders: route.orders.map((item) => ({
      routeOrderId: item.id,
      position: item.position,
      addedAt: item.addedAt.toISOString(),
      // Состояние вычисляется из участия и состояния маршрута: отдельного
      // хранимого поля нет, поэтому расхождение источников истины невозможно.
      assignmentState: assignmentStateOf(route.state),
      conflicts: item.conflicts.map((conflict) => ({
        kind: conflict.kind,
        detectedAt: conflict.detectedAt.toISOString(),
      })),
      order: {
        id: item.order.id,
        number: item.order.externalName,
        deliveryDate:
          item.order.deliveryDate === null ? null : fromDateColumn(item.order.deliveryDate),
        // Явный признак того, что текущая дата заказа больше не соответствует
        // неизменной дате маршрута: правило одной даты не нарушается молча.
        deliveryDateMatchesRoute:
          item.order.deliveryDate !== null && calendarDate(item.order.deliveryDate) === routeDate,
        interval: {
          raw: item.order.intervalRaw,
          kind: item.order.intervalKind,
          startMinute: item.order.intervalStartMinute,
          endMinute: item.order.intervalEndMinute,
          manualStartMinute: item.order.manualIntervalStartMinute,
          manualEndMinute: item.order.manualIntervalEndMinute,
        },
        // Рабочий адрес: по нему поедет курьер, он же печатается в листе.
        address: effectiveAddress(item.order),
        // Курьеру нужны оба значения: по адресу он едет, по деталям находит
        // дверь. В печатной форме они стоят рядом по той же причине.
        addressDetails: addressDetailsOf(item.order),
        recipient: item.order.recipient,
        comment: item.order.comment,
        needsAttention: item.order.needsAttention,
        attentionReasons: item.order.attentionReasons,
        // Десятичной строкой: bigint не сериализуется, а number теряет точность.
        cashToCollect: item.order.cashCollectable
          ? toDecimalString(item.order.cashToCollectMinor)
          : null,
        scope: {
          inScope: item.order.inScope,
          sourceMissing: item.order.sourceMissing,
          sourceArchived: item.order.sourceArchived,
        },
        /*
         * Отменённый заказ остаётся в составе и помечается.
         *
         * Автоматически из маршрута он не исчезает: букет может быть уже
         * собран, лежать в маршрутной ячейке или ехать в машине. Логист
         * обязан увидеть отмену и решить сам, а выдачу склад уже не пропустит.
         */
        cancelled: item.order.cancelledInSource || item.order.cancelledByLogistAt !== null,
      },
    })),
  };
}

/** Экспортируется для тестов прав: список ролей должен быть один на весь модуль. */
export const ROUTING_ROLES = ROUTE_ROLES;

export type RoutingActor = AuthenticatedActor;
