/**
 * Критические проверки черновика из выбора «Сделок».
 *
 * Здесь проверяется то, из-за чего логист получил бы не тот маршрут: точность
 * порядка остановок, отказ по заказам, ставшим непригодными, безопасная гонка
 * двух логистов и повтор потерянного ответа.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { applyOrderSnapshot } from '../integrations/moysklad/import-service.js';
import { mapOrder, type OrderSnapshot } from '../integrations/moysklad/mapper.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { createDraftFromSelection } from './service.js';
import { eligibleOrders } from '../planning/service.js';

let ctx: TestContext;
const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;

/** Собственный месяц файла: база общая, чужие дни занимать нельзя. */
const DAY = '2027-10-14';
const CONTEXT = { ip: '127.0.0.1', userAgent: 'critical-test' };

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

function snapshotOf(overrides: Record<string, unknown> = {}): OrderSnapshot {
  return mapOrder(
    {
      id: randomUUID(),
      name: `SEL-${process.hrtime.bigint() % 1_000_000n}`,
      updated: '2026-08-13 10:00:00.000',
      shipmentAddress: 'Москва, синтетическая улица, дом 1',
      deliveryPlannedMoment: `${DAY} 12:00:00.000`,
      sum: 100000,
      payedSum: 0,
      store: { meta: { href: href('store', IDS.store) } },
      attributes: [
        {
          id: IDS.deliveryMethodAttribute,
          value: {
            name: 'Доставка',
            meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
          },
        },
        { id: IDS.intervalAttribute, value: 'с 10:00 по 14:00' },
        { id: IDS.recipientAttribute, value: 'Получатель Синтетический' },
      ],
      ...overrides,
    } as never,
    IDS,
  ).snapshot;
}

/** Пригодный к выбору заказ: в области, без внимания, с подтверждённой точкой. */
async function seedSelectable(): Promise<string> {
  const snapshot = snapshotOf();
  await ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, new Date()));
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { externalId: snapshot.externalId },
    select: { id: true },
  });
  await ctx.db.deliveryOrder.update({
    where: { id: order.id },
    data: {
      needsAttention: false,
      attentionReasons: [],
      geoState: 'RESOLVED',
      geoSource: 'DADATA',
      geoPrecision: 'EXACT_HOUSE',
      geoLatMicro: 55_751_244,
      geoLonMicro: 37_618_423,
      geoResolvedAt: new Date(),
    },
  });
  return order.id;
}

async function actor(): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
  return { userId: user.id, roles: ['LOGISTICIAN'], familyId: randomUUID() };
}

const deps = () => ({ db: ctx.db });

async function positionsOf(routeId: string): Promise<{ orderId: string; position: number }[]> {
  return ctx.db.routeOrder.findMany({
    where: { routeId, removedAt: null },
    orderBy: { position: 'asc' },
    select: { orderId: true, position: true },
  });
}

// ---------------------------------------------------------------------------

describe('порядок остановок — это порядок выбора', () => {
  it('черновик создаётся ровно в переданном порядке 1..N', async () => {
    const ids = [await seedSelectable(), await seedSelectable(), await seedSelectable()];
    const user = await actor();

    const route = await createDraftFromSelection(
      deps(),
      user,
      { deliveryDate: DAY, vehicleType: 'CAR', orderIds: ids },
      CONTEXT,
    );

    expect(route.repeated).toBe(false);
    expect(route.positions).toBe(3);

    const positions = await positionsOf(route.id);
    expect(positions.map((item) => item.orderId)).toEqual(ids);
    expect(positions.map((item) => item.position)).toEqual([1, 2, 3]);

    // Ничего не подтверждается: подтверждение остаётся отдельным действием.
    const created = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: route.id },
      select: { state: true },
    });
    expect(created.state).toBe('DRAFT');
  });

  it('обратный порядок даёт другой маршрут, а не тот же', async () => {
    const ids = [await seedSelectable(), await seedSelectable()];
    const user = await actor();

    const route = await createDraftFromSelection(
      deps(),
      user,
      { deliveryDate: DAY, vehicleType: 'FOOT', orderIds: [...ids].reverse() },
      CONTEXT,
    );

    const positions = await positionsOf(route.id);
    expect(positions.map((item) => item.orderId)).toEqual([...ids].reverse());
  });
});

describe('вход проверяется до изменения данных', () => {
  it('пустой выбор, дубли и несуществующая дата отклоняются', async () => {
    const user = await actor();
    const id = await seedSelectable();

    await expect(
      createDraftFromSelection(
        deps(),
        user,
        { deliveryDate: DAY, vehicleType: 'CAR', orderIds: [] },
        CONTEXT,
      ),
    ).rejects.toThrow();

    await expect(
      createDraftFromSelection(
        deps(),
        user,
        { deliveryDate: DAY, vehicleType: 'CAR', orderIds: [id, id] },
        CONTEXT,
      ),
    ).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/повторя/i) as unknown as string,
    });

    await expect(
      createDraftFromSelection(
        deps(),
        user,
        { deliveryDate: '2027-02-30', vehicleType: 'CAR', orderIds: [id] },
        CONTEXT,
      ),
    ).rejects.toThrow();

    // Ни один отказ не создал маршрут.
    expect(await ctx.db.routeOrder.count({ where: { orderId: id, removedAt: null } })).toBe(0);
  });

  it('заказ с вниманием и заказ без точки распределить нельзя', async () => {
    const user = await actor();
    const attention = await seedSelectable();
    await ctx.db.deliveryOrder.update({
      where: { id: attention },
      data: { needsAttention: true, attentionReasons: ['MISSING_RECIPIENT'] },
    });
    const noPoint = await seedSelectable();
    await ctx.db.deliveryOrder.update({
      where: { id: noPoint },
      data: {
        geoState: 'PENDING',
        geoSource: null,
        geoPrecision: null,
        geoLatMicro: null,
        geoLonMicro: null,
        geoResolvedAt: null,
      },
    });

    for (const id of [attention, noPoint]) {
      await expect(
        createDraftFromSelection(
          deps(),
          user,
          { deliveryDate: DAY, vehicleType: 'CAR', orderIds: [id] },
          CONTEXT,
        ),
      ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_ELIGIBLE' } });
    }
  });

  it('заказ другого дня в маршрут не попадает', async () => {
    const user = await actor();
    const id = await seedSelectable();

    await expect(
      createDraftFromSelection(
        deps(),
        user,
        { deliveryDate: '2027-10-15', vehicleType: 'CAR', orderIds: [id] },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_ELIGIBLE' } });
  });
});

describe('гонка двух логистов и потерянный ответ', () => {
  it('одновременный выбор одного заказа даёт один успех и безопасный отказ', async () => {
    const shared = await seedSelectable();
    const own = await seedSelectable();
    const first = await actor();
    const second = await actor();

    const results = await Promise.allSettled([
      createDraftFromSelection(
        deps(),
        first,
        { deliveryDate: DAY, vehicleType: 'CAR', orderIds: [shared] },
        CONTEXT,
      ),
      createDraftFromSelection(
        deps(),
        second,
        { deliveryDate: DAY, vehicleType: 'CAR', orderIds: [shared, own] },
        CONTEXT,
      ),
    ]);

    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter((item) => item.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Отказ называет заказ и не показывает ни адреса, ни получателя.
    const reason = (rejected[0] as PromiseRejectedResult).reason as {
      conflict?: { kind: string; orderIds?: string[] };
      publicMessage?: string;
    };
    expect(reason.conflict?.kind).toBe('ORDER_ALREADY_IN_ROUTE');
    expect(reason.publicMessage ?? '').not.toContain('Москва');

    // Заказ участвует ровно в одном маршруте: второго не появилось.
    expect(await ctx.db.routeOrder.count({ where: { orderId: shared, removedAt: null } })).toBe(1);
    // Заказ проигравшего остался свободным: транзакция откатилась целиком.
    expect(await ctx.db.routeOrder.count({ where: { orderId: own, removedAt: null } })).toBe(0);
  });

  it('повтор того же запроса возвращает прежний маршрут, а не второй', async () => {
    const ids = [await seedSelectable(), await seedSelectable()];
    const user = await actor();
    const input = { deliveryDate: DAY, vehicleType: 'CAR' as const, orderIds: ids };

    const first = await createDraftFromSelection(deps(), user, input, CONTEXT);
    const repeat = await createDraftFromSelection(deps(), user, input, CONTEXT);

    expect(repeat.id).toBe(first.id);
    expect(repeat.repeated).toBe(true);
    expect(
      await ctx.db.deliveryRoute.count({
        where: { deliveryDate: new Date(`${DAY}T00:00:00.000Z`) },
      }),
    ).toBeGreaterThan(0);
    // Второй маршрут с тем же составом не появился.
    const routes = await ctx.db.routeOrder.findMany({
      where: { orderId: ids[0], removedAt: null },
      select: { routeId: true },
    });
    expect(routes).toHaveLength(1);
  });

  it('другой состав тем же первым заказом за повтор не выдаётся', async () => {
    const ids = [await seedSelectable(), await seedSelectable()];
    const extra = await seedSelectable();
    const user = await actor();

    await createDraftFromSelection(
      deps(),
      user,
      { deliveryDate: DAY, vehicleType: 'CAR', orderIds: ids },
      CONTEXT,
    );

    await expect(
      createDraftFromSelection(
        deps(),
        user,
        { deliveryDate: DAY, vehicleType: 'CAR', orderIds: [...ids, extra] },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_ALREADY_IN_ROUTE' } });
  });
});

describe('автоматический расчёт замораживает ровно выбранное', () => {
  it('в снимок попадают только выбранные заказы дня', async () => {
    const selected = [await seedSelectable(), await seedSelectable()];
    const foreign = await seedSelectable();

    // Проверяется сам отбор планирования: чужой заказ того же дня не должен
    // попасть в набор, даже будучи полностью пригодным.
    const chosen = await eligibleOrders(ctx.db, DAY, selected);
    expect(chosen.map((order) => order.id).sort()).toEqual([...selected].sort());
    expect(chosen.map((order) => order.id)).not.toContain(foreign);

    // Без выбора поведение прежнее: планируется весь пригодный день.
    const whole = await eligibleOrders(ctx.db, DAY);
    expect(whole.map((order) => order.id)).toContain(foreign);
  });

  it('заказ, ставший непригодным, из выбора выпадает и расчёт его не подменяет', async () => {
    const good = await seedSelectable();
    const broken = await seedSelectable();
    await ctx.db.deliveryOrder.update({
      where: { id: broken },
      data: { sourceMissing: true },
    });

    const chosen = await eligibleOrders(ctx.db, DAY, [good, broken]);
    expect(chosen.map((order) => order.id)).toEqual([good]);
  });

  it('заказ, уже попавший в маршрут, в расчёт не берётся', async () => {
    const ids = [await seedSelectable(), await seedSelectable()];
    const user = await actor();
    await createDraftFromSelection(
      deps(),
      user,
      { deliveryDate: DAY, vehicleType: 'CAR', orderIds: [ids[0] as string] },
      CONTEXT,
    );

    const chosen = await eligibleOrders(ctx.db, DAY, ids);
    expect(chosen.map((order) => order.id)).toEqual([ids[1]]);
  });
});

// ---------------------------------------------------------------------------

/**
 * Маршрутный лист прямо из выбора.
 *
 * Защищаемое свойство: это тот же доменный переход, что и подтверждение
 * черновика, и он атомарен. «Наполовину созданного» листа, оставшегося
 * черновиком, о котором никто не просил, быть не может.
 */
describe('маршрутный лист из выбора', () => {
  async function courier(): Promise<string> {
    const user = await seedUser(ctx.db, { roles: ['COURIER'] });
    return user.id;
  }

  it('режим по умолчанию оставляет черновик', async () => {
    const ids = [await seedSelectable()];
    const route = await createDraftFromSelection(
      deps(),
      await actor(),
      { deliveryDate: DAY, vehicleType: 'CAR', orderIds: ids },
      CONTEXT,
    );

    expect(route.state).toBe('DRAFT');
  });

  it('режим SHEET доводит маршрут до подтверждённого одной операцией', async () => {
    const ids = [await seedSelectable(), await seedSelectable()];

    const route = await createDraftFromSelection(
      deps(),
      await actor(),
      { deliveryDate: DAY, vehicleType: 'CAR', orderIds: ids, mode: 'SHEET' },
      CONTEXT,
    );

    expect(route.state).toBe('CONFIRMED');
    const stored = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: route.id },
      select: { state: true, courierUserId: true },
    });
    expect(stored.state).toBe('CONFIRMED');
    // Курьер может остаться неназначенным: его назначают ближе к отгрузке.
    expect(stored.courierUserId).toBeNull();

    // Состав и порядок сохранены целиком.
    expect(await positionsOf(route.id)).toEqual([
      { orderId: ids[0], position: 1 },
      { orderId: ids[1], position: 2 },
    ]);

    // Переход записан историей состояний, а не молчаливым обновлением поля.
    const transitions = await ctx.db.routeStateTransition.findMany({
      where: { routeId: route.id },
      select: { toState: true },
    });
    expect(transitions.map((row) => row.toState)).toContain('CONFIRMED');
  });

  it('выбранный заранее курьер назначается тем же созданием', async () => {
    const ids = [await seedSelectable()];
    const courierId = await courier();

    const route = await createDraftFromSelection(
      deps(),
      await actor(),
      {
        deliveryDate: DAY,
        vehicleType: 'CAR',
        orderIds: ids,
        courierUserId: courierId,
        mode: 'SHEET',
      },
      CONTEXT,
    );

    const stored = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: route.id },
      select: { courierUserId: true, state: true },
    });
    expect(stored.courierUserId).toBe(courierId);
    expect(stored.state).toBe('CONFIRMED');
  });

  it('пользователь не той роли курьером не становится', async () => {
    // Иначе маршрут уехал бы на человека, который его не повезёт.
    const ids = [await seedSelectable()];
    const notCourier = await seedUser(ctx.db, { roles: ['FLORIST'] });

    await expect(
      createDraftFromSelection(
        deps(),
        await actor(),
        {
          deliveryDate: DAY,
          vehicleType: 'CAR',
          orderIds: ids,
          courierUserId: notCourier.id,
          mode: 'SHEET',
        },
        CONTEXT,
      ),
    ).rejects.toThrow();

    // Отказ атомарен: маршрута не осталось ни одного.
    const routes = await ctx.db.routeOrder.findMany({ where: { orderId: ids[0] } });
    expect(routes).toHaveLength(0);
  });
});
