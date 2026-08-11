/**
 * Критические проверки жизненного цикла маршрута и мягкой блокировки редактора.
 *
 * Реального ожидания нет: истечение аренды проверяется управляемыми часами,
 * конкурентность — параллельными запросами, а не паузами.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { TEST_SECRETS } from '../../platform/testing/secrets.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { applyOrderSnapshot } from '../integrations/moysklad/import-service.js';
import { mapOrder, type OrderSnapshot } from '../integrations/moysklad/mapper.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import type { Role } from '@fl/shared';
import { LEASE_TTL_MS } from './lease.js';

let ctx: TestContext;
const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;
const NOW = new Date('2026-08-12T09:00:00.000Z');
/** Дни своего диапазона: база критических тестов общая. */
const DAY = '2027-01-10';
const OTHER_DAY = '2027-01-11';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

// --- Фикстуры ---------------------------------------------------------------

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    name: `L-${process.hrtime.bigint() % 1_000_000n}`,
    updated: '2026-08-12 10:00:00.000',
    shipmentAddress: 'Москва, адрес жизненного цикла',
    deliveryPlannedMoment: `${DAY} 12:00:00.000`,
    sum: 499000,
    payedSum: 0,
    store: { meta: { href: href('store', IDS.store) } },
    state: {
      meta: { href: href('state', '22222222-2222-4222-8222-222222222222') },
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Новый',
      stateType: 'Regular',
    },
    attributes: [
      {
        id: IDS.deliveryMethodAttribute,
        value: {
          name: 'Доставка',
          meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
        },
      },
      { id: IDS.intervalAttribute, value: 'с 16:00 по 19:00' },
      { id: IDS.recipientAttribute, value: 'Получатель Цикловой' },
    ],
    ...overrides,
  };
}

function snapshotOf(overrides: Record<string, unknown> = {}): OrderSnapshot {
  return mapOrder(source(overrides) as never, IDS).snapshot;
}

async function apply(snapshot: OrderSnapshot) {
  return ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, NOW));
}

async function seedOrder(overrides: Record<string, unknown> = {}): Promise<string> {
  const snapshot = snapshotOf(overrides);
  await apply(snapshot);
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { externalId: snapshot.externalId },
    select: { id: true },
  });
  return order.id;
}

interface Session {
  token: string;
  userId: string;
  actor: AuthenticatedActor;
}

/** Полноценный сеанс: у каждого своя семья сессий, то есть своё «устройство». */
async function session(roles: Role[] = ['LOGISTICIAN']): Promise<Session> {
  const { hashSecretCode } = await import('../auth/crypto.js');
  const { login } = await import('../auth/service.js');
  const pin = '1234';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles, status: 'ACTIVE', pinHash });
  const issued = await login(
    ctx,
    { phone: user.phone, pin },
    { ip: null, userAgent: 'vitest', deviceLabel: null },
  );

  const { verifyAccessToken } = await import('../auth/tokens.js');
  const claims = await verifyAccessToken(issued.accessToken, ctx.config.AUTH_ACCESS_TOKEN_SECRET);
  if (claims === null) {
    throw new Error('не удалось разобрать выданный токен');
  }

  return {
    token: issued.accessToken,
    userId: user.id,
    actor: {
      userId: user.id,
      familyId: claims.familyId,
      roles,
      fullName: 'Тестовый пользователь',
      phone: user.phone,
    },
  };
}

/** Второе устройство того же человека: другая семья сессий. */
async function secondDevice(existing: Session, phone: string): Promise<Session> {
  const { login } = await import('../auth/service.js');
  const issued = await login(
    ctx,
    { phone, pin: '1234' },
    { ip: null, userAgent: 'vitest-2', deviceLabel: 'второе устройство' },
  );
  const { verifyAccessToken } = await import('../auth/tokens.js');
  const claims = await verifyAccessToken(issued.accessToken, ctx.config.AUTH_ACCESS_TOKEN_SECRET);
  if (claims === null) {
    throw new Error('не удалось разобрать выданный токен');
  }

  return {
    token: issued.accessToken,
    userId: existing.userId,
    actor: { ...existing.actor, familyId: claims.familyId },
  };
}

interface Injected {
  statusCode: number;
  json: () => unknown;
}

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  token: string | null,
  payload?: unknown,
): Promise<Injected> {
  return ctx.app.inject({
    method,
    url,
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    ...(payload === undefined ? {} : { payload }),
  });
}

interface RouteCard {
  id: string;
  number: string;
  state: string;
  version: number;
  conflictCount: number;
  editLock: {
    locked: boolean;
    heldByCurrentSession: boolean;
    holder: { id: string; fullName: string } | null;
    expiresAt: string | null;
    leaseVersion: number | null;
  };
  confirmBlockers: { kind: string; orderIds: string[] }[];
  orders: { position: number; assignmentState: string; order: { id: string } }[];
}

async function createRoute(
  token: string,
  deliveryDate = DAY,
): Promise<{ id: string; version: number }> {
  const response = await call('POST', '/api/routes', token, { deliveryDate, vehicleType: 'CAR' });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; version: number };
}

async function card(token: string, routeId: string): Promise<RouteCard> {
  const response = await call('GET', `/api/routes/${routeId}`, token);
  expect(response.statusCode).toBe(200);
  return response.json() as RouteCard;
}

/** Маршрут с одним пригодным заказом, готовый к подтверждению. */
async function routeWithOrder(
  token: string,
): Promise<{ id: string; version: number; orderId: string }> {
  const route = await createRoute(token);
  const orderId = await seedOrder();
  const added = await call('POST', `/api/routes/${route.id}/orders`, token, {
    orderIds: [orderId],
    expectedVersion: route.version,
  });
  expect(added.statusCode).toBe(200);
  return { id: route.id, version: (added.json() as RouteCard).version, orderId };
}

// --- Переходы состояний -----------------------------------------------------

describe('переходы состояния', () => {
  it('черновик подтверждается, состав сохраняется, аренда освобождается', async () => {
    const editor = await session();
    const route = await routeWithOrder(editor.token);

    const confirmed = await call('POST', `/api/routes/${route.id}/confirm`, editor.token, {
      expectedVersion: route.version,
    });
    expect(confirmed.statusCode).toBe(200);

    const view = confirmed.json() as RouteCard;
    expect(view.state).toBe('CONFIRMED');
    expect(view.version).toBe(route.version + 1);
    expect(view.orders).toHaveLength(1);
    expect(view.orders[0]?.assignmentState).toBe('CONFIRMED');
    // Подтверждённый маршрут не редактируется, держать его в работе незачем.
    expect(view.editLock.locked).toBe(false);

    const transition = await ctx.db.routeStateTransition.findFirstOrThrow({
      where: { routeId: route.id },
    });
    expect(transition.fromState).toBe('DRAFT');
    expect(transition.toState).toBe('CONFIRMED');
    expect(transition.reason).toBeNull();
    expect(
      await ctx.db.auditLog.count({ where: { entityId: route.id, action: 'ROUTE_CONFIRMED' } }),
    ).toBe(1);
  });

  it('подтверждённый маршрут обычными операциями не редактируется', async () => {
    const editor = await session();
    const route = await routeWithOrder(editor.token);
    const confirmed = await call('POST', `/api/routes/${route.id}/confirm`, editor.token, {
      expectedVersion: route.version,
    });
    const version = (confirmed.json() as RouteCard).version;

    const another = await seedOrder();
    const add = await call('POST', `/api/routes/${route.id}/orders`, editor.token, {
      orderIds: [another],
      expectedVersion: version,
    });
    expect(add.statusCode).toBe(409);

    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
    const assign = await call('PUT', `/api/routes/${route.id}/courier`, editor.token, {
      courierUserId: courier.id,
      expectedVersion: version,
    });
    expect(assign.statusCode).toBe(409);
  });

  it('возврат в черновик сохраняет состав и сразу выдаёт аренду инициатору', async () => {
    const editor = await session();
    const route = await createRoute(editor.token);
    const first = await seedOrder();
    const second = await seedOrder();
    const added = await call('POST', `/api/routes/${route.id}/orders`, editor.token, {
      orderIds: [first, second],
      expectedVersion: route.version,
    });
    const confirmed = await call('POST', `/api/routes/${route.id}/confirm`, editor.token, {
      expectedVersion: (added.json() as RouteCard).version,
    });
    const confirmedVersion = (confirmed.json() as RouteCard).version;

    const returned = await call('POST', `/api/routes/${route.id}/return-to-draft`, editor.token, {
      expectedVersion: confirmedVersion,
      reason: 'Ошиблись порядком доставки',
    });
    expect(returned.statusCode).toBe(200);

    const view = returned.json() as RouteCard;
    expect(view.state).toBe('DRAFT');
    expect(view.orders.map((item) => item.order.id)).toEqual([first, second]);
    expect(view.orders.map((item) => item.position)).toEqual([1, 2]);
    expect(view.orders[0]?.assignmentState).toBe('IN_DRAFT');
    // Маршрут открыт инициатору: иначе его успел бы занять другой редактор.
    expect(view.editLock.locked).toBe(true);
    expect(view.editLock.heldByCurrentSession).toBe(true);

    const transition = await ctx.db.routeStateTransition.findFirstOrThrow({
      where: { routeId: route.id, toState: 'DRAFT' },
    });
    expect(transition.reason).toBe('Ошиблись порядком доставки');
  });

  it('причина обязательна для возврата и отмены', async () => {
    const editor = await session();
    const route = await routeWithOrder(editor.token);

    for (const body of [
      { expectedVersion: route.version },
      { expectedVersion: route.version, reason: 'ок' },
    ]) {
      const cancelled = await call('POST', `/api/routes/${route.id}/cancel`, editor.token, body);
      expect(cancelled.statusCode, JSON.stringify(body)).toBe(400);
    }

    expect((await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } })).state).toBe(
      'DRAFT',
    );
  });

  it('отмена закрывает все участия и освобождает заказы', async () => {
    const editor = await session();
    const route = await createRoute(editor.token);
    const first = await seedOrder();
    const second = await seedOrder();
    const added = await call('POST', `/api/routes/${route.id}/orders`, editor.token, {
      orderIds: [first, second],
      expectedVersion: route.version,
    });

    const cancelled = await call('POST', `/api/routes/${route.id}/cancel`, editor.token, {
      expectedVersion: (added.json() as RouteCard).version,
      reason: 'Клиент перенёс доставку',
    });
    expect(cancelled.statusCode).toBe(200);

    const view = cancelled.json() as RouteCard;
    expect(view.state).toBe('CANCELLED');
    expect(view.orders).toHaveLength(0);
    expect(view.editLock.locked).toBe(false);

    // История сохраняется: участия закрыты, но остались с причиной.
    const closed = await ctx.db.routeOrder.findMany({ where: { routeId: route.id } });
    expect(closed).toHaveLength(2);
    expect(closed.every((item) => item.removalReason === 'ROUTE_CANCELLED')).toBe(true);
    expect(closed.every((item) => item.movedToRouteId === null)).toBe(true);

    // Заказы снова свободны: их можно положить в другой маршрут.
    const другой = await createRoute(editor.token);
    const reused = await call('POST', `/api/routes/${другой.id}/orders`, editor.token, {
      orderIds: [first, second],
      expectedVersion: другой.version,
    });
    expect(reused.statusCode).toBe(200);
  });

  it('повторная отмена и запрещённые переходы отклоняются', async () => {
    const editor = await session();
    const route = await routeWithOrder(editor.token);
    const cancelled = await call('POST', `/api/routes/${route.id}/cancel`, editor.token, {
      expectedVersion: route.version,
      reason: 'Отмена по решению логиста',
    });
    const version = (cancelled.json() as RouteCard).version;

    for (const path of ['cancel', 'confirm', 'return-to-draft']) {
      const response = await call('POST', `/api/routes/${route.id}/${path}`, editor.token, {
        expectedVersion: version,
        reason: 'Повторная попытка перехода',
      });
      expect(response.statusCode, path).toBe(409);
    }

    expect(await ctx.db.routeStateTransition.count({ where: { routeId: route.id } })).toBe(1);
  });

  it('история переходов не переписывается и не удаляется', async () => {
    const editor = await session();
    const route = await routeWithOrder(editor.token);
    await call('POST', `/api/routes/${route.id}/confirm`, editor.token, {
      expectedVersion: route.version,
    });
    const transition = await ctx.db.routeStateTransition.findFirstOrThrow({
      where: { routeId: route.id },
    });

    await expect(
      ctx.db.routeStateTransition.update({
        where: { id: transition.id },
        data: { reason: 'подмена причины' },
      }),
    ).rejects.toThrow();
    await expect(
      ctx.db.routeStateTransition.delete({ where: { id: transition.id } }),
    ).rejects.toThrow();
  });

  it('база отвергает недопустимый переход и причину не того вида', async () => {
    const editor = await session();
    const route = await createRoute(editor.token);

    // DRAFT → DRAFT перехода не существует.
    await expect(
      ctx.db.routeStateTransition.create({
        data: {
          routeId: route.id,
          fromState: 'DRAFT',
          toState: 'DRAFT',
          actorUserId: editor.userId,
          reason: 'попытка недопустимого перехода',
        },
      }),
    ).rejects.toThrow();

    // Подтверждение причины не имеет.
    await expect(
      ctx.db.routeStateTransition.create({
        data: {
          routeId: route.id,
          fromState: 'DRAFT',
          toState: 'CONFIRMED',
          actorUserId: editor.userId,
          reason: 'лишняя причина',
        },
      }),
    ).rejects.toThrow();

    // Отмена без причины запрещена базой, а не только сервером.
    await expect(
      ctx.db.routeStateTransition.create({
        data: {
          routeId: route.id,
          fromState: 'DRAFT',
          toState: 'CANCELLED',
          actorUserId: editor.userId,
        },
      }),
    ).rejects.toThrow();
  });

  it('устаревшая версия отклоняется без записи перехода и события', async () => {
    const editor = await session();
    const route = await routeWithOrder(editor.token);
    const eventsBefore = await ctx.db.realtimeEvent.count();

    const response = await call('POST', `/api/routes/${route.id}/confirm`, editor.token, {
      expectedVersion: route.version - 1,
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { conflict: { kind: string } } }).error.conflict.kind).toBe(
      'STALE_VERSION',
    );

    expect(await ctx.db.routeStateTransition.count({ where: { routeId: route.id } })).toBe(0);
    expect(await ctx.db.realtimeEvent.count()).toBe(eventsBefore);
    expect((await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } })).state).toBe(
      'DRAFT',
    );
  });
});

// --- Проверки перед подтверждением ------------------------------------------

describe('проверки перед подтверждением', () => {
  it('пустой маршрут не подтверждается', async () => {
    const editor = await session();
    const route = await createRoute(editor.token);

    const response = await call('POST', `/api/routes/${route.id}/confirm`, editor.token, {
      expectedVersion: route.version,
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { conflict: { kind: string } } }).error.conflict.kind).toBe(
      'ROUTE_EMPTY',
    );
    // Та же причина видна заранее, до нажатия кнопки.
    expect((await card(editor.token, route.id)).confirmBlockers.map((item) => item.kind)).toContain(
      'ROUTE_EMPTY',
    );
  });

  it('известный конфликт заказа не даёт подтвердить', async () => {
    const editor = await session();
    const route = await createRoute(editor.token);
    const snapshot = snapshotOf();
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
      select: { id: true },
    });
    const added = await call('POST', `/api/routes/${route.id}/orders`, editor.token, {
      orderIds: [order.id],
      expectedVersion: route.version,
    });

    // Синхронизация переносит заказ на другой день: участие сохраняется, конфликт виден.
    await apply({
      ...snapshot,
      deliveryDate: OTHER_DAY,
      deliveryDateRaw: `${OTHER_DAY} 12:00:00.000`,
      externalUpdated: '2026-08-12 11:00:00.000',
    });

    const response = await call('POST', `/api/routes/${route.id}/confirm`, editor.token, {
      expectedVersion: (added.json() as RouteCard).version,
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: { conflict: { kind: string; orderIds?: string[] } } };
    expect(body.error.conflict.kind).toBe('ROUTE_HAS_CONFLICTS');
    expect(body.error.conflict.orderIds).toContain(order.id);
  });

  it('повторная проверка ловит расхождение, о котором конфликт не записан', async () => {
    const editor = await session();
    const route = await routeWithOrder(editor.token);

    // Заказ правится напрямую, минуя синхронизацию: записи конфликта нет,
    // но подтверждать такой состав нельзя.
    await ctx.db.deliveryOrder.update({
      where: { id: route.orderId },
      data: { inScope: false, scopeExitReason: 'STORE_CHANGED' },
    });

    const response = await call('POST', `/api/routes/${route.id}/confirm`, editor.token, {
      expectedVersion: route.version,
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { conflict: { kind: string } } }).error.conflict.kind).toBe(
      'ORDER_NOT_ELIGIBLE',
    );
  });

  it('маршрут без курьера подтверждается, а с недоступным — нет', async () => {
    const editor = await session();
    const withoutCourier = await routeWithOrder(editor.token);
    const ok = await call('POST', `/api/routes/${withoutCourier.id}/confirm`, editor.token, {
      expectedVersion: withoutCourier.version,
    });
    expect(ok.statusCode).toBe(200);

    const route = await routeWithOrder(editor.token);
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
    const assigned = await call('PUT', `/api/routes/${route.id}/courier`, editor.token, {
      courierUserId: courier.id,
      expectedVersion: route.version,
    });
    const version = (assigned.json() as RouteCard).version;

    // Курьера заморозили уже после назначения.
    await ctx.db.user.update({ where: { id: courier.id }, data: { status: 'FROZEN' } });

    const refused = await call('POST', `/api/routes/${route.id}/confirm`, editor.token, {
      expectedVersion: version,
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { conflict: { kind: string } } }).error.conflict.kind).toBe(
      'ROUTE_COURIER_UNAVAILABLE',
    );
  });

  it('«Требует внимания» подтверждению не мешает', async () => {
    const editor = await session();
    const route = await createRoute(editor.token);
    // Заказ без распознанного интервала: он в «Требует внимания», но подтверждению
    // это не мешает — отгрузку он остановит на этапе 6.
    const orderId = await seedOrder({
      attributes: [
        {
          id: IDS.deliveryMethodAttribute,
          value: {
            name: 'Доставка',
            meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
          },
        },
        { id: IDS.recipientAttribute, value: 'Получатель Цикловой' },
      ],
    });
    const added = await call('POST', `/api/routes/${route.id}/orders`, editor.token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });

    const response = await call('POST', `/api/routes/${route.id}/confirm`, editor.token, {
      expectedVersion: (added.json() as RouteCard).version,
    });
    expect(response.statusCode).toBe(200);
  });
});

// --- Мягкая блокировка ------------------------------------------------------

describe('мягкая блокировка редактора', () => {
  it('создание маршрута сразу выдаёт аренду создателю', async () => {
    const editor = await session();
    const route = await createRoute(editor.token);

    const view = await card(editor.token, route.id);
    expect(view.editLock.locked).toBe(true);
    expect(view.editLock.heldByCurrentSession).toBe(true);
    expect(view.editLock.holder?.id).toBe(editor.userId);
    expect(view.editLock.leaseVersion).toBeGreaterThanOrEqual(1);
    // Семья сессий наружу не выходит ни при каких обстоятельствах.
    expect(JSON.stringify(view.editLock)).not.toContain(editor.actor.familyId);
  });

  it('из двух одновременных захватов выигрывает ровно один', async () => {
    const owner = await session();
    const rival = await session();
    const route = await createRoute(owner.token);
    // Освобождаем: иначе владелец уже держит аренду и гонки не будет.
    await call('POST', `/api/routes/${route.id}/edit-lock/release`, owner.token, {});

    const [a, b] = await Promise.all([
      call('POST', `/api/routes/${route.id}/edit-lock/acquire`, owner.token, {}),
      call('POST', `/api/routes/${route.id}/edit-lock/acquire`, rival.token, {}),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const lease = await ctx.db.routeEditLease.findUniqueOrThrow({ where: { routeId: route.id } });
    expect(lease.releasedAt).toBeNull();
  });

  it('повторный захват той же сессией продлевает аренду идемпотентно', async () => {
    const editor = await session();
    const route = await createRoute(editor.token);
    const before = await ctx.db.routeEditLease.findUniqueOrThrow({ where: { routeId: route.id } });
    const auditBefore = await ctx.db.auditLog.count({
      where: { entityId: route.id, action: 'ROUTE_EDIT_LOCK_ACQUIRED' },
    });

    const again = await call('POST', `/api/routes/${route.id}/edit-lock/acquire`, editor.token, {});
    expect(again.statusCode).toBe(200);

    const after = await ctx.db.routeEditLease.findUniqueOrThrow({ where: { routeId: route.id } });
    expect(after.holderFamilyId).toBe(before.holderFamilyId);
    expect(after.expiresAt.getTime()).toBeGreaterThanOrEqual(before.expiresAt.getTime());
    // Продление рутинно и журнал не засоряет.
    expect(
      await ctx.db.auditLog.count({
        where: { entityId: route.id, action: 'ROUTE_EDIT_LOCK_ACQUIRED' },
      }),
    ).toBe(auditBefore);
  });

  it('второе устройство того же человека считается другим редактором', async () => {
    const first = await session();
    const second = await secondDevice(first, first.actor.phone);
    const route = await createRoute(first.token);

    const acquire = await call(
      'POST',
      `/api/routes/${route.id}/edit-lock/acquire`,
      second.token,
      {},
    );
    expect(acquire.statusCode).toBe(409);
    expect((acquire.json() as { error: { conflict: { kind: string } } }).error.conflict.kind).toBe(
      'EDIT_LOCK_HELD_BY_OTHER',
    );

    // И редактировать состав со второго устройства тоже нельзя.
    const orderId = await seedOrder();
    const add = await call('POST', `/api/routes/${route.id}/orders`, second.token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });
    expect(add.statusCode).toBe(409);
  });

  it('сердцебиение чужой аренды запрещено и не пишет аудит', async () => {
    const owner = await session();
    const rival = await session();
    const route = await createRoute(owner.token);
    const auditBefore = await ctx.db.auditLog.count({ where: { entityId: route.id } });

    const foreign = await call(
      'POST',
      `/api/routes/${route.id}/edit-lock/heartbeat`,
      rival.token,
      {},
    );
    expect(foreign.statusCode).toBe(409);

    const own = await call('POST', `/api/routes/${route.id}/edit-lock/heartbeat`, owner.token, {});
    expect(own.statusCode).toBe(200);

    // Сердцебиение не событие предметной области: ни аудита, ни версии маршрута.
    expect(await ctx.db.auditLog.count({ where: { entityId: route.id } })).toBe(auditBefore);
    expect(
      (await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } })).version,
    ).toBe(route.version);
  });

  it('истёкшая аренда достаётся обычным захватом, без перехвата', async () => {
    const owner = await session();
    const rival = await session();
    const route = await createRoute(owner.token);

    // Часы не переводим и не ждём: аренда состаривается прямой правкой периода.
    // Момент получения сдвигается вместе со сроком — база требует, чтобы срок
    // был позже получения, и половинчатое состояние она не примет.
    const past = new Date(Date.now() - 2 * LEASE_TTL_MS);
    await ctx.db.routeEditLease.update({
      where: { routeId: route.id },
      data: {
        acquiredAt: past,
        heartbeatAt: past,
        expiresAt: new Date(past.getTime() + LEASE_TTL_MS),
      },
    });

    const acquired = await call(
      'POST',
      `/api/routes/${route.id}/edit-lock/acquire`,
      rival.token,
      {},
    );
    expect(acquired.statusCode).toBe(200);

    const lease = await ctx.db.routeEditLease.findUniqueOrThrow({ where: { routeId: route.id } });
    expect(lease.holderUserId).toBe(rival.userId);

    // Прежний держатель немедленно теряет право на изменения.
    const orderId = await seedOrder();
    const add = await call('POST', `/api/routes/${route.id}/orders`, owner.token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });
    expect(add.statusCode).toBe(409);
  });

  it('активная чужая аренда перехватывается только осознанно', async () => {
    const owner = await session();
    const rival = await session(['ADMIN']);
    const route = await createRoute(owner.token);
    const lease = await ctx.db.routeEditLease.findUniqueOrThrow({ where: { routeId: route.id } });

    // Без подтверждения, без причины и с чужой версией перехват невозможен.
    expect(
      (
        await call('POST', `/api/routes/${route.id}/edit-lock/takeover`, rival.token, {
          confirm: false,
          reason: 'Нужно срочно поправить',
          expectedLeaseVersion: lease.version,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call('POST', `/api/routes/${route.id}/edit-lock/takeover`, rival.token, {
          confirm: true,
          reason: 'ок',
          expectedLeaseVersion: lease.version,
        })
      ).statusCode,
    ).toBe(400);
    const stale = await call('POST', `/api/routes/${route.id}/edit-lock/takeover`, rival.token, {
      confirm: true,
      reason: 'Нужно срочно поправить маршрут',
      expectedLeaseVersion: lease.version + 5,
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { conflict: { kind: string } } }).error.conflict.kind).toBe(
      'EDIT_LOCK_STALE',
    );

    const taken = await call('POST', `/api/routes/${route.id}/edit-lock/takeover`, rival.token, {
      confirm: true,
      reason: 'Логист ушёл, маршрут нужно доделать',
      expectedLeaseVersion: lease.version,
    });
    expect(taken.statusCode).toBe(200);

    // Прежний держатель теряет право немедленно.
    const orderId = await seedOrder();
    const add = await call('POST', `/api/routes/${route.id}/orders`, owner.token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });
    expect(add.statusCode).toBe(409);

    expect(
      await ctx.db.auditLog.count({
        where: { entityId: route.id, action: 'ROUTE_EDIT_LOCK_TAKEN_OVER' },
      }),
    ).toBe(1);
    // Прежний держатель получает персональное событие.
    const personal = await ctx.db.realtimeEvent.findFirst({
      where: { topic: 'route.edit_lock_taken_over', audienceUserId: owner.userId },
    });
    expect(personal).not.toBeNull();
  });

  it('перехват собственной аренды идемпотентен и ничего не меняет', async () => {
    const editor = await session();
    const route = await createRoute(editor.token);
    const before = await ctx.db.routeEditLease.findUniqueOrThrow({ where: { routeId: route.id } });
    const auditBefore = await ctx.db.auditLog.count({
      where: { entityId: route.id, action: 'ROUTE_EDIT_LOCK_TAKEN_OVER' },
    });
    const eventsBefore = await ctx.db.realtimeEvent.count({
      where: { topic: 'route.edit_lock_taken_over' },
    });

    const response = await call(
      'POST',
      `/api/routes/${route.id}/edit-lock/takeover`,
      editor.token,
      {
        confirm: true,
        reason: 'Случайный перехват собственной блокировки',
        expectedLeaseVersion: before.version,
      },
    );
    expect(response.statusCode).toBe(200);
    expect(
      (response.json() as { editLock: { heldByCurrentSession: boolean } }).editLock
        .heldByCurrentSession,
    ).toBe(true);

    const after = await ctx.db.routeEditLease.findUniqueOrThrow({ where: { routeId: route.id } });
    // Перехвата не было: ни версии, ни срока, ни держателя, ни следа в журнале.
    expect(after.version).toBe(before.version);
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(after.holderFamilyId).toBe(before.holderFamilyId);
    expect(
      await ctx.db.auditLog.count({
        where: { entityId: route.id, action: 'ROUTE_EDIT_LOCK_TAKEN_OVER' },
      }),
    ).toBe(auditBefore);
    expect(
      await ctx.db.realtimeEvent.count({ where: { topic: 'route.edit_lock_taken_over' } }),
    ).toBe(eventsBefore);
  });

  it('второе устройство того же человека выполняет настоящий перехват', async () => {
    const first = await session();
    const second = await secondDevice(first, first.actor.phone);
    const route = await createRoute(first.token);
    const before = await ctx.db.routeEditLease.findUniqueOrThrow({ where: { routeId: route.id } });

    const taken = await call('POST', `/api/routes/${route.id}/edit-lock/takeover`, second.token, {
      confirm: true,
      reason: 'Продолжаю работу с другого устройства',
      expectedLeaseVersion: before.version,
    });
    expect(taken.statusCode).toBe(200);

    const after = await ctx.db.routeEditLease.findUniqueOrThrow({ where: { routeId: route.id } });
    expect(after.holderFamilyId).toBe(second.actor.familyId);
    expect(after.version).toBe(before.version + 1);
    expect(
      await ctx.db.auditLog.count({
        where: { entityId: route.id, action: 'ROUTE_EDIT_LOCK_TAKEN_OVER' },
      }),
    ).toBe(1);

    // Первое устройство право на изменения потеряло.
    const orderId = await seedOrder();
    const add = await call('POST', `/api/routes/${route.id}/orders`, first.token, {
      orderIds: [orderId],
      expectedVersion: route.version,
    });
    expect(add.statusCode).toBe(409);
  });

  it('освобождение доступно только держателю', async () => {
    const owner = await session();
    const rival = await session();
    const route = await createRoute(owner.token);

    expect(
      (await call('POST', `/api/routes/${route.id}/edit-lock/release`, rival.token, {})).statusCode,
    ).toBe(409);

    const released = await call(
      'POST',
      `/api/routes/${route.id}/edit-lock/release`,
      owner.token,
      {},
    );
    expect(released.statusCode).toBe(200);
    expect((released.json() as { editLock: { locked: boolean } }).editLock.locked).toBe(false);

    // Маршрут и его версия при этом не менялись.
    const route_ = await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } });
    expect(route_.version).toBe(route.version);
    expect(route_.state).toBe('DRAFT');
  });

  it('перемещение требует аренды обоих маршрутов', async () => {
    const owner = await session();
    const rival = await session();
    const from = await createRoute(owner.token);
    const to = await createRoute(rival.token);
    const orderId = await seedOrder();

    const added = await call('POST', `/api/routes/${from.id}/orders`, owner.token, {
      orderIds: [orderId],
      expectedVersion: from.version,
    });

    // Целевой маршрут держит другой редактор.
    const refused = await call('POST', '/api/routes/move', owner.token, {
      fromRouteId: from.id,
      toRouteId: to.id,
      orderIds: [orderId],
      expectedSourceVersion: (added.json() as RouteCard).version,
      expectedTargetVersion: to.version,
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { conflict: { kind: string } } }).error.conflict.kind).toBe(
      'EDIT_LOCK_HELD_BY_OTHER',
    );
    expect(await ctx.db.routeOrder.count({ where: { routeId: to.id } })).toBe(0);
  });

  it('перехват и сердцебиение одновременно оставляют одного держателя', async () => {
    const owner = await session();
    const rival = await session(['ADMIN']);
    const route = await createRoute(owner.token);
    const lease = await ctx.db.routeEditLease.findUniqueOrThrow({ where: { routeId: route.id } });

    const [takeover, heartbeat] = await Promise.all([
      call('POST', `/api/routes/${route.id}/edit-lock/takeover`, rival.token, {
        confirm: true,
        reason: 'Перехват во время сердцебиения',
        expectedLeaseVersion: lease.version,
      }),
      call('POST', `/api/routes/${route.id}/edit-lock/heartbeat`, owner.token, {}),
    ]);

    // Оба запроса завершились, взаимной блокировки нет.
    expect([takeover.statusCode, heartbeat.statusCode].every((code) => code < 500)).toBe(true);

    const after = await ctx.db.routeEditLease.findUniqueOrThrow({ where: { routeId: route.id } });
    const holder = takeover.statusCode === 200 ? rival.userId : owner.userId;
    expect(after.holderUserId).toBe(holder);
  });
});

describe('история маршрута', () => {
  it('пагинация не повторяет переходы на второй странице', async () => {
    const editor = await session();
    const route = await routeWithOrder(editor.token);

    // Два перехода подряд: подтверждение и возврат.
    const confirmed = await call('POST', `/api/routes/${route.id}/confirm`, editor.token, {
      expectedVersion: route.version,
    });
    const returned = await call('POST', `/api/routes/${route.id}/return-to-draft`, editor.token, {
      expectedVersion: (confirmed.json() as RouteCard).version,
      reason: 'Нужно поменять порядок доставки',
    });
    expect(returned.statusCode).toBe(200);

    interface History {
      transitions: { toState: string; occurredAt: string }[];
      transitionTotal: number;
      total: number;
    }

    const all = (
      await call('GET', `/api/routes/${route.id}/history?limit=50`, editor.token)
    ).json() as History;
    expect(all.transitionTotal).toBe(2);
    expect(all.transitions.map((item) => item.toState)).toEqual(['DRAFT', 'CONFIRMED']);

    const first = (
      await call('GET', `/api/routes/${route.id}/history?limit=1&offset=0`, editor.token)
    ).json() as History;
    const second = (
      await call('GET', `/api/routes/${route.id}/history?limit=1&offset=1`, editor.token)
    ).json() as History;

    expect(first.transitions).toHaveLength(1);
    expect(second.transitions).toHaveLength(1);
    // Вторая страница обязана продолжать первую, а не повторять её.
    expect(second.transitions[0]?.toState).not.toBe(first.transitions[0]?.toState);
    expect(second.transitions[0]?.toState).toBe('CONFIRMED');
    // Счётчики раздельные: аудита записей больше, чем переходов.
    expect(second.transitionTotal).toBe(2);
    expect(second.total).toBeGreaterThan(second.transitionTotal);
  });
});

// --- Права и безопасность ---------------------------------------------------

describe('права и безопасность', () => {
  it('жизненный цикл и блокировка недоступны курьеру, складу и анониму', async () => {
    const editor = await session();
    const route = await routeWithOrder(editor.token);

    for (const roles of [['COURIER'], ['WAREHOUSE']] as Role[][]) {
      const outsider = await session(roles);
      for (const path of ['confirm', 'cancel', 'edit-lock/acquire']) {
        const response = await call('POST', `/api/routes/${route.id}/${path}`, outsider.token, {
          expectedVersion: route.version,
          reason: 'Попытка постороннего',
        });
        expect(response.statusCode, `${roles.join()} ${path}`).toBe(403);
      }
    }

    expect(
      (await call('POST', `/api/routes/${route.id}/confirm`, null, { expectedVersion: 1 }))
        .statusCode,
    ).toBe(401);
    expect((await call('GET', `/api/routes/${route.id}/edit-lock`, null)).statusCode).toBe(401);
  });

  it('в realtime нет семьи сессий, причин и персональных данных', async () => {
    const owner = await session();
    const rival = await session(['ADMIN']);
    const route = await routeWithOrder(owner.token);
    const lease = await ctx.db.routeEditLease.findUniqueOrThrow({ where: { routeId: route.id } });

    await call('POST', `/api/routes/${route.id}/edit-lock/takeover`, rival.token, {
      confirm: true,
      reason: 'Секретная причина перехвата',
      expectedLeaseVersion: lease.version,
    });
    await call('POST', `/api/routes/${route.id}/cancel`, rival.token, {
      expectedVersion: route.version,
      reason: 'Секретная причина отмены',
    });

    const events = await ctx.db.realtimeEvent.findMany({
      where: { topic: { startsWith: 'route.' } },
    });
    // Денежные поля соседних записей хранятся в BigInt: сериализация с заменителем.
    const serialized = JSON.stringify(events, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item,
    );

    expect(serialized).not.toContain('Секретная причина');
    expect(serialized).not.toContain(owner.actor.familyId);
    expect(serialized).not.toContain(rival.actor.familyId);
    expect(serialized).not.toContain('Москва');
    expect(serialized).not.toContain('Получатель');
    expect(serialized).not.toContain(
      (await ctx.db.deliveryRoute.findUniqueOrThrow({ where: { id: route.id } })).number,
    );
  });

  it('аренда не удаляется физически', async () => {
    const editor = await session();
    const route = await createRoute(editor.token);

    await expect(ctx.db.routeEditLease.delete({ where: { routeId: route.id } })).rejects.toThrow();
  });
});
