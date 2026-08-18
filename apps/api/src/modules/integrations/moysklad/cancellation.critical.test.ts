/**
 * Критические проверки отмены заказа.
 *
 * Отмена приходит из чужой системы и застаёт заказ на любой стадии: свободным
 * в «Сделках», у флориста, в ячейке, в маршрутном листе, в машине курьера и
 * даже после доставки. Проверяется не «поставился ли флажок», а то, что
 * на каждой стадии отменённый заказ перестаёт двигаться дальше и при этом
 * не исчезает: физический букет остаётся там, где лежит, и его судьбу решает
 * человек.
 *
 * Отдельно проверяется граница с МоимСкладом: наше решение действует сразу,
 * а исходящая отметка живёт своей жизнью и обязана быть видна честно.
 *
 * День подобран так, чтобы не пересекаться с другими файлами набора.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../../auth/testing/harness.js';
import type { AuthenticatedActor } from '../../auth/guards.js';
import type { Role } from '@fl/shared';
import { toDateColumn } from './delivery-date.js';
import { applyCancellation, isCancelledInSource, isOtherUnsuccessful } from './cancellation.js';
import { claimOrder } from '../../fulfillment/assembly.js';
import { blockingFlags, resolveOrderByNumber } from '../../warehouse/order-lookup.js';
import { recordDeliveryResult } from '../../delivery/service.js';

let ctx: TestContext;
const CONTEXT = { ip: null, userAgent: null };

/** День вне диапазонов остальных файлов набора. */
const DAY = '2027-11-22';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${sequence}`;
}

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return { userId: user.id, roles, familyId: randomUUID() } as AuthenticatedActor;
}

async function seedOrder(
  extra: Record<string, unknown> = {},
): Promise<{ id: string; number: string }> {
  const number = unique('CNL');
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: number,
      externalUpdated: new Date(),
      deliveryDate: toDateColumn(DAY),
      inScope: true,
      address: 'синтетический адрес отмены',
      ...extra,
    },
    select: { id: true },
  });
  return { id: order.id, number };
}

async function cancel(orderId: string, cancelled = true): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    const order = await tx.deliveryOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { cancelledInSource: true },
    });
    await applyCancellation(tx, {
      orderId,
      cancelled,
      previous: order.cancelledInSource,
      now: new Date(),
    });
  });
}

async function seedCell(kind: 'STORAGE' | 'ROUTE'): Promise<{ id: string; code: string }> {
  const code = unique(kind === 'STORAGE' ? 'CS' : 'CR').toUpperCase();
  const author = await actorFor(['WAREHOUSE']);
  return ctx.db.storageCell.create({
    data: { code, normalizedCode: code, kind, createdById: author.userId },
    select: { id: true, code: true },
  });
}

// --- Распознавание ------------------------------------------------------------

describe('распознавание отмены', () => {
  /*
   * Значение синтетическое.
   *
   * Настоящий идентификатор принадлежит аккаунту владельца и в репозитории
   * не хранится: он приходит из `MOYSKLAD_CANCELLED_STATE_ID`. Проверять
   * можно ЛЮБОЕ значение — важно поведение, а не конкретный UUID.
   */
  const CONFIGURED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('отменой считается ровно настроенный статус, а не тип «неуспех»', () => {
    const cancelled = { externalStateId: CONFIGURED };
    const other = {
      externalStateId: '11111111-2222-3333-4444-555555555555',
      externalStateType: 'Unsuccessful',
    };

    expect(isCancelledInSource(cancelled, CONFIGURED)).toBe(true);
    expect(isCancelledInSource(other, CONFIGURED)).toBe(false);
    // Прочий «неуспех» виден отдельно и отменой не притворяется.
    expect(isOtherUnsuccessful(other, CONFIGURED)).toBe(true);
    expect(
      isOtherUnsuccessful({ ...cancelled, externalStateType: 'Unsuccessful' }, CONFIGURED),
    ).toBe(false);
  });

  it('пустая настройка выключает распознавание, а не включает его для всех', () => {
    /*
     * Ровно наоборот было бы катастрофой: «идентификатор не задан» превратилось
     * бы в «любой статус — отмена», и весь день ушёл бы в отменённые.
     */
    expect(isCancelledInSource({ externalStateId: CONFIGURED }, null)).toBe(false);
    expect(isCancelledInSource({ externalStateId: null }, null)).toBe(false);
    expect(isCancelledInSource({ externalStateId: null }, CONFIGURED)).toBe(false);
  });

  it('production не стартует без идентификатора, а local и staging стартуют', async () => {
    const { loadConfig } = await import('../../../platform/config.js');
    const { TEST_SECRETS } = await import('../../../platform/testing/secrets.js');
    // Из общего набора значение убирается намеренно: проверяется именно
    // НЕнастроенный контур.
    const { MOYSKLAD_CANCELLED_STATE_ID: _configured, ...secrets } = TEST_SECRETS;
    const base = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      ...secrets,
    } as NodeJS.ProcessEnv;

    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'production',
        APP_ENVIRONMENT_MARKER: 'production',
      } as NodeJS.ProcessEnv),
    ).toThrow(/MOYSKLAD_CANCELLED_STATE_ID обязателен/);

    // Пустая строка и пропуск значат одно и то же — «не настроено».
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'production',
        APP_ENVIRONMENT_MARKER: 'production',
        MOYSKLAD_CANCELLED_STATE_ID: '',
      } as NodeJS.ProcessEnv),
    ).toThrow(/MOYSKLAD_CANCELLED_STATE_ID обязателен/);

    expect(
      loadConfig({
        ...base,
        APP_ENV: 'production',
        APP_ENVIRONMENT_MARKER: 'production',
        MOYSKLAD_CANCELLED_STATE_ID: CONFIGURED,
      } as NodeJS.ProcessEnv).MOYSKLAD_CANCELLED_STATE_ID,
    ).toBe(CONFIGURED);

    for (const env of ['local', 'staging'] as const) {
      const config = loadConfig({
        ...base,
        APP_ENV: env,
        APP_ENVIRONMENT_MARKER: env,
        ...(env === 'staging' ? { MOYSKLAD_READ_ONLY: 'true' } : {}),
      } as NodeJS.ProcessEnv);
      expect(config.MOYSKLAD_CANCELLED_STATE_ID, env).toBeUndefined();
    }

    // Мусор вместо идентификатора отвергается везде: молчаливое «не узнали
    // отмену из-за опечатки» хуже отказа запуска.
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'local',
        APP_ENVIRONMENT_MARKER: 'local',
        MOYSKLAD_CANCELLED_STATE_ID: 'Отменен',
      } as NodeJS.ProcessEnv),
    ).toThrow(/MOYSKLAD_CANCELLED_STATE_ID должен быть UUID/);
  });
});

// --- Стадии -------------------------------------------------------------------

describe('отмена на разных стадиях', () => {
  it('флорист не может взять отменённый заказ в работу', async () => {
    const florist = await actorFor(['FLORIST']);
    const order = await seedOrder({
      fulfillmentInScope: true,
      fulfillmentCompositionState: 'READY',
      fulfillmentSnapshotHash: 'hash',
      fulfillmentCompositionSyncedAt: new Date(),
    });
    await ctx.db.floristShift.create({
      data: { userId: florist.userId, startedAt: new Date(), activeKey: florist.userId },
    });

    await cancel(order.id);

    await expect(
      claimOrder(ctx.db, florist, order.id, { ip: null, userAgent: null }),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_CANCELLED' } });

    // Заказ не тронут: состояние процесса осталось прежним.
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentProcessState: true, fulfillmentAssigneeId: true },
    });
    expect(stored.fulfillmentProcessState).toBe('NEW');
    expect(stored.fulfillmentAssigneeId).toBeNull();
  });

  it('склад видит запрет на комплектование и выдачу', async () => {
    const order = await seedOrder();
    await cancel(order.id);

    const resolved = await resolveOrderByNumber(ctx.db, order.number);
    expect(blockingFlags(resolved)).toContain('CANCELLED');
  });

  it('в маршрутной ячейке появляется требование перемещения, а заказ остаётся на месте', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedOrder();
    const routeCell = await seedCell('ROUTE');
    const placement = await ctx.db.orderPlacement.create({
      data: {
        orderId: order.id,
        cellId: routeCell.id,
        source: 'RECEIVED',
        placedById: keeper.userId,
      },
      select: { id: true },
    });

    await cancel(order.id);

    const stored = await ctx.db.orderPlacement.findUniqueOrThrow({
      where: { id: placement.id },
      select: { requiresRelocation: true, releasedAt: true, cellId: true },
    });
    // Помечен — но не увезён: товар двигают руками.
    expect(stored.requiresRelocation).toBe(true);
    expect(stored.releasedAt).toBeNull();
    expect(stored.cellId).toBe(routeCell.id);
  });

  it('обычная ячейка отмены не двигает вовсе', async () => {
    const keeper = await actorFor(['WAREHOUSE']);
    const order = await seedOrder();
    const cell = await seedCell('STORAGE');
    const placement = await ctx.db.orderPlacement.create({
      data: {
        orderId: order.id,
        cellId: cell.id,
        source: 'RECEIVED',
        placedById: keeper.userId,
      },
      select: { id: true },
    });

    await cancel(order.id);

    const stored = await ctx.db.orderPlacement.findUniqueOrThrow({
      where: { id: placement.id },
      select: { requiresRelocation: true, releasedAt: true },
    });
    expect(stored.requiresRelocation).toBe(false);
    expect(stored.releasedAt).toBeNull();
  });
});

// --- Отмена после доставки ----------------------------------------------------

describe('отмена уже доставленного заказа', () => {
  it('ничего не меняет автоматически, но создаёт задачу на коррекцию', async () => {
    const courier = await actorFor(['COURIER']);
    const creator = await actorFor(['ADMIN']);
    const order = await seedOrder();
    const route = await ctx.db.deliveryRoute.create({
      data: {
        number: unique('CRT'),
        deliveryDate: toDateColumn(DAY),
        state: 'ACTIVE',
        vehicleType: 'CAR',
        createdById: creator.userId,
        courierUserId: courier.userId,
      },
      select: { id: true },
    });
    const participation = await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId: order.id, position: 1, addedById: creator.userId },
      select: { id: true },
    });
    await recordDeliveryResult(
      { db: ctx.db },
      courier,
      participation.id,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );

    await cancel(order.id);

    const task = await ctx.db.orderResolution.findUniqueOrThrow({
      where: { activeKey: order.id },
      select: { kind: true, decision: true },
    });
    expect(task.kind).toBe('CANCELLED_AFTER_DELIVERY');
    expect(task.decision).toBeNull();

    // Результат доставки остался нетронутым: букет у клиента.
    const attempt = await ctx.db.deliveryAttempt.findFirstOrThrow({
      where: { orderId: order.id, activeKey: { not: null } },
      select: { outcome: true },
    });
    expect(attempt.outcome).toBe('DELIVERED');

    // Повторный проход импорта второй задачи не создаёт.
    await cancel(order.id, false);
    await cancel(order.id, true);
    expect(await ctx.db.orderResolution.count({ where: { orderId: order.id } })).toBe(1);
  });
});

// --- Снятие отмены ------------------------------------------------------------

describe('снятие отмены', () => {
  it('возвращает заказ нераспределённым и не восстанавливает прежний маршрут', async () => {
    const creator = await actorFor(['ADMIN']);
    const order = await seedOrder();
    const route = await ctx.db.deliveryRoute.create({
      data: {
        number: unique('CDR'),
        deliveryDate: toDateColumn(DAY),
        state: 'DRAFT',
        vehicleType: 'CAR',
        createdById: creator.userId,
      },
      select: { id: true },
    });
    const participation = await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId: order.id, position: 1, addedById: creator.userId },
      select: { id: true },
    });

    await cancel(order.id);
    // Во время отмены заказ из маршрута НЕ исчезает: он там виден и помечен.
    const during = await ctx.db.routeOrder.findUniqueOrThrow({
      where: { id: participation.id },
      select: { removedAt: true },
    });
    expect(during.removedAt).toBeNull();

    await cancel(order.id, false);

    const after = await ctx.db.routeOrder.findUniqueOrThrow({
      where: { id: participation.id },
      select: { removedAt: true, removalReason: true },
    });
    expect(after.removedAt).not.toBeNull();
    expect(after.removalReason).toBe('SOURCE_CANCELLATION_WITHDRAWN');
    // Автора нет намеренно: участие закрыл проход импорта, а не человек.
    const author = await ctx.db.routeOrder.findUniqueOrThrow({
      where: { id: participation.id },
      select: { removedById: true },
    });
    expect(author.removedById).toBeNull();

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { cancelledInSource: true },
    });
    expect(stored.cancelledInSource).toBe(false);
  });

  it('маршрут с уже полученным результатом не переписывается', async () => {
    const courier = await actorFor(['COURIER']);
    const creator = await actorFor(['ADMIN']);
    const order = await seedOrder();
    const route = await ctx.db.deliveryRoute.create({
      data: {
        number: unique('CKR'),
        deliveryDate: toDateColumn(DAY),
        state: 'ACTIVE',
        vehicleType: 'CAR',
        createdById: creator.userId,
        courierUserId: courier.userId,
      },
      select: { id: true },
    });
    const participation = await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId: order.id, position: 1, addedById: creator.userId },
      select: { id: true },
    });
    await recordDeliveryResult(
      { db: ctx.db },
      courier,
      participation.id,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );

    await cancel(order.id);
    await cancel(order.id, false);

    const after = await ctx.db.routeOrder.findUniqueOrThrow({
      where: { id: participation.id },
      select: { removedAt: true },
    });
    // История доставки неприкосновенна.
    expect(after.removedAt).toBeNull();
  });
});
