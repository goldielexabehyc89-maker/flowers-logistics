/**
 * Пометка «(ОТКРЫТКА)» в трёх списках (CORE-POSTCARD-MARKERS-AND-FLORIST-COUNTER-01).
 *
 * Защищаемое:
 *
 *  * признак `hasPostcard` приходит в строке заказа каждого из трёх ответов —
 *    состав маршрутного листа (`GET /api/routes/:id`), «Активные»
 *    (`GET /api/delivery/active`) и «Выдача» (`GET /api/warehouse/issue-board`);
 *  * источник — подтверждённый «Текст открытки», тот же, что печатает бланк;
 *    слово «открытка» в комментариях признаком не является;
 *  * сам текст открытки в эти ответы не уходит;
 *  * изменение текста открытки синхронизацией меняет признак и публикует
 *    `order.fulfillment_changed` тем ролям, которые видят эти списки, — по
 *    нему экраны перечитываются штатно. Курьеру оно не адресуется;
 *  * курьер узнаёт о появлении и снятии открытки ЛИЧНЫМ событием и только по
 *    своему листу: другой курьер его не видит, смена текста без смены
 *    признака курьера не тревожит.
 *
 * ВЛАДЕНИЕ ДАТАМИ: апрель 2031 (`platform/testing/test-days.ts`).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@fl/shared';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from '../auth/testing/harness.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { snapshotHash, type FulfillmentSnapshot } from './composition.js';
import { applyFulfillmentSnapshot } from './service.js';
import { hasPostcard } from './postcard.js';
import { readEventsForViewer, VISIBILITY_LAG_MS } from '../realtime/reader.js';

const DAY = '2031-04-14';
const CARD_TEXT = 'Синтетическая открытка: с днём рождения!';

let ctx: TestContext;
let creatorId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  creatorId = (await seedUser(ctx.db, { roles: ['ADMIN'], fullName: 'Автор листов' })).id;
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${sequence}`;
}

async function loginAs(roles: Role[]): Promise<{ token: string; userId: string }> {
  const { hashSecretCode } = await import('../auth/crypto.js');
  const { login } = await import('../auth/service.js');
  const pin = '1234';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles, pinHash });
  const session = await login(
    ctx,
    { phone: user.phone, pin },
    { ip: null, userAgent: 'vitest', deviceLabel: null },
  );
  return { token: session.accessToken, userId: user.id };
}

async function getJson(url: string, token: string): Promise<{ status: number; body: string }> {
  const response = (await ctx.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  })) as unknown as { statusCode: number; body: string };
  return { status: response.statusCode, body: response.body };
}

function snapshot(externalId: string, cardText: string | null): FulfillmentSnapshot {
  return {
    externalId,
    description: 'Нижний комментарий',
    cardText,
    positions: [],
  };
}

interface SeededOrder {
  id: string;
  number: string;
  externalId: string;
}

/**
 * Заказ с подтверждённым производственным снимком.
 *
 * Логистический комментарий намеренно содержит слово «открытка»: признак
 * обязан идти от атрибута «Текст открытки», а не от поиска по тексту.
 */
async function seedOrder(cardText: string | null): Promise<SeededOrder> {
  const externalId = randomUUID();
  const number = unique('PC');
  const snap = snapshot(externalId, cardText);
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId,
      externalName: number,
      externalUpdated: new Date('2031-04-01T00:00:00.000Z'),
      deliveryDate: toDateColumn(DAY),
      inScope: true,
      fulfillmentInScope: true,
      address: 'синтетический адрес',
      recipient: 'синтетический получатель',
      comment: 'Позвонить заранее; открытку вручить лично',
      fulfillmentDescription: snap.description,
      fulfillmentCardText: snap.cardText,
      fulfillmentSnapshotHash: snapshotHash(snap),
      fulfillmentCompositionState: 'READY',
      fulfillmentCompositionSyncedAt: new Date(),
      fulfillmentRevisions: {
        create: {
          externalUpdated: new Date('2031-04-01T00:00:00.000Z'),
          snapshot: snap as never,
          snapshotHash: snapshotHash(snap),
          changedFields: ['externalId', 'description', 'cardText', 'positions'],
          reason: 'INITIAL_IMPORT',
        },
      },
    },
    select: { id: true },
  });
  return { id: order.id, number, externalId };
}

async function seedRoute(
  state: 'CONFIRMED' | 'ACTIVE',
  courierUserId: string,
  orders: readonly SeededOrder[],
): Promise<string> {
  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('PCR'),
      deliveryDate: toDateColumn(DAY),
      state,
      vehicleType: 'CAR',
      createdById: creatorId,
      courierUserId,
    },
    select: { id: true },
  });
  let position = 1;
  for (const order of orders) {
    await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId: order.id, position, addedById: creatorId },
    });
    position += 1;
  }
  return route.id;
}

/** Синхронизация принесла новый «Текст открытки»: тот же путь, что у импорта. */
async function syncCardText(order: SeededOrder, cardText: string | null): Promise<void> {
  const result = await ctx.db.$transaction((tx) =>
    applyFulfillmentSnapshot(
      tx,
      {
        externalId: order.externalId,
        externalUpdated: new Date(),
        texts: { description: 'Нижний комментарий', cardText },
        snapshot: snapshot(order.externalId, cardText),
        failure: null,
      },
      new Date(),
    ),
  );
  expect(result.outcome).toBe('CHANGED');
  expect(result.changedFields).toContain('cardText');
}

// --- Чтение трёх списков ------------------------------------------------------

interface Stand {
  courier: { token: string; userId: string };
  logistician: { token: string };
  supervisor: { token: string };
  keeper: { token: string };
  activeRouteId: string;
  confirmedRouteId: string;
  active: { withCard: SeededOrder; withoutCard: SeededOrder };
  confirmed: { withCard: SeededOrder; withoutCard: SeededOrder };
}

async function seedStand(): Promise<Stand> {
  const courier = await loginAs(['COURIER']);
  const active = { withCard: await seedOrder(CARD_TEXT), withoutCard: await seedOrder(null) };
  const confirmed = { withCard: await seedOrder(CARD_TEXT), withoutCard: await seedOrder(null) };
  const activeRouteId = await seedRoute('ACTIVE', courier.userId, [
    active.withCard,
    active.withoutCard,
  ]);
  const confirmedRouteId = await seedRoute('CONFIRMED', courier.userId, [
    confirmed.withCard,
    confirmed.withoutCard,
  ]);
  return {
    courier,
    logistician: await loginAs(['LOGISTICIAN']),
    supervisor: await loginAs(['SUPERVISOR']),
    keeper: await loginAs(['WAREHOUSE']),
    activeRouteId,
    confirmedRouteId,
    active,
    confirmed,
  };
}

/** Признак каждого заказа в составе маршрутного листа. */
async function routeSheetMarks(
  routeId: string,
  token: string,
): Promise<{ marks: Map<string, boolean>; body: string }> {
  const response = await getJson(`/api/routes/${routeId}`, token);
  expect(response.status).toBe(200);
  const card = JSON.parse(response.body) as {
    orders: { order: { number: string; hasPostcard: boolean } }[];
  };
  return {
    marks: new Map(card.orders.map((item) => [item.order.number, item.order.hasPostcard])),
    body: response.body,
  };
}

/** Признак каждого заказа в «Активных». */
async function activeMarks(
  token: string,
  routeId: string,
): Promise<{ marks: Map<string, boolean>; body: string }> {
  const response = await getJson(`/api/delivery/active?routeId=${routeId}`, token);
  expect(response.status).toBe(200);
  const data = JSON.parse(response.body) as {
    routes: { routeId: string; orders: { number: string; hasPostcard: boolean }[] }[];
  };
  const route = data.routes.find((item) => item.routeId === routeId);
  expect(route).toBeDefined();
  return {
    marks: new Map((route?.orders ?? []).map((item) => [item.number, item.hasPostcard])),
    body: response.body,
  };
}

/** Признак каждого заказа на доске «Выдача». */
async function issueMarks(
  token: string,
  routeId: string,
): Promise<{ marks: Map<string, boolean>; body: string }> {
  const response = await getJson('/api/warehouse/issue-board', token);
  expect(response.status).toBe(200);
  const data = JSON.parse(response.body) as {
    couriers: {
      routes: { routeId: string; orders: { orderNumber: string; hasPostcard: boolean }[] }[];
    }[];
  };
  const route = data.couriers
    .flatMap((courier) => courier.routes)
    .find((item) => item.routeId === routeId);
  expect(route).toBeDefined();
  return {
    marks: new Map((route?.orders ?? []).map((item) => [item.orderNumber, item.hasPostcard])),
    body: response.body,
  };
}

describe('признак открытки', () => {
  it('ровно подтверждённый «Текст открытки»: есть значение — есть открытка', () => {
    expect(hasPostcard({ fulfillmentCardText: CARD_TEXT })).toBe(true);
    expect(hasPostcard({ fulfillmentCardText: null })).toBe(false);
  });
});

describe('пометка в трёх списках', () => {
  let stand: Stand;

  beforeAll(async () => {
    stand = await seedStand();
  });

  it('«Маршрутные листы»: состав листа несёт признак, текста нет', async () => {
    for (const routeId of [stand.activeRouteId, stand.confirmedRouteId]) {
      for (const token of [stand.logistician.token, stand.supervisor.token]) {
        const { marks, body } = await routeSheetMarks(routeId, token);
        const orders = routeId === stand.activeRouteId ? stand.active : stand.confirmed;
        expect(marks.get(orders.withCard.number)).toBe(true);
        expect(marks.get(orders.withoutCard.number)).toBe(false);
        expect(body).not.toContain(CARD_TEXT);
      }
    }
  });

  it('«Активные»: признак у курьера и у логиста, текста нет', async () => {
    // Управляющий здесь не проверяется: «Активные» показывают ему только его
    // собственные маршруты (прежнее правило `isManager`), а их у него нет.
    for (const token of [stand.courier.token, stand.logistician.token]) {
      const { marks, body } = await activeMarks(token, stand.activeRouteId);
      expect(marks.get(stand.active.withCard.number)).toBe(true);
      expect(marks.get(stand.active.withoutCard.number)).toBe(false);
      expect(body).not.toContain(CARD_TEXT);
    }
  });

  it('«Выдача»: признак у кладовщика и управляющего, текста нет', async () => {
    for (const token of [stand.keeper.token, stand.supervisor.token]) {
      const { marks, body } = await issueMarks(token, stand.confirmedRouteId);
      expect(marks.get(stand.confirmed.withCard.number)).toBe(true);
      expect(marks.get(stand.confirmed.withoutCard.number)).toBe(false);
      expect(body).not.toContain(CARD_TEXT);
    }
  });

  it('слово «открытка» в комментарии признаком не является', async () => {
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: stand.active.withoutCard.id },
      select: { comment: true, fulfillmentCardText: true },
    });
    expect(stored.comment).toContain('открытку');
    expect(stored.fulfillmentCardText).toBeNull();
    const { marks } = await activeMarks(stand.courier.token, stand.activeRouteId);
    expect(marks.get(stand.active.withoutCard.number)).toBe(false);
  });
});

describe('изменение открытки', () => {
  it('появление и снятие текста меняют пометку во всех трёх списках', async () => {
    const stand = await seedStand();

    await syncCardText(stand.active.withoutCard, CARD_TEXT);
    await syncCardText(stand.confirmed.withoutCard, CARD_TEXT);
    await syncCardText(stand.active.withCard, null);
    await syncCardText(stand.confirmed.withCard, null);

    const sheetActive = await routeSheetMarks(stand.activeRouteId, stand.logistician.token);
    expect(sheetActive.marks.get(stand.active.withoutCard.number)).toBe(true);
    expect(sheetActive.marks.get(stand.active.withCard.number)).toBe(false);

    const sheetConfirmed = await routeSheetMarks(stand.confirmedRouteId, stand.logistician.token);
    expect(sheetConfirmed.marks.get(stand.confirmed.withoutCard.number)).toBe(true);
    expect(sheetConfirmed.marks.get(stand.confirmed.withCard.number)).toBe(false);

    const active = await activeMarks(stand.courier.token, stand.activeRouteId);
    expect(active.marks.get(stand.active.withoutCard.number)).toBe(true);
    expect(active.marks.get(stand.active.withCard.number)).toBe(false);

    const issue = await issueMarks(stand.keeper.token, stand.confirmedRouteId);
    expect(issue.marks.get(stand.confirmed.withoutCard.number)).toBe(true);
    expect(issue.marks.get(stand.confirmed.withCard.number)).toBe(false);
  });

  it('изменение публикует событие тем, кто видит списки; курьеру — нет', async () => {
    const order = await seedOrder(null);
    const before = await ctx.db.realtimeEvent.aggregate({ _max: { id: true } });

    await syncCardText(order, CARD_TEXT);

    const events = await ctx.db.realtimeEvent.findMany({
      where: { id: { gt: before._max.id ?? 0n }, topic: 'order.fulfillment_changed' },
      select: { payload: true, audienceRoles: true, audienceUserId: true },
    });
    const mine = events.filter(
      (event) => (event.payload as { orderId?: string }).orderId === order.id,
    );
    expect(mine).toHaveLength(1);
    const event = mine[0]!;
    expect((event.payload as { changedFields: string[] }).changedFields).toContain('cardText');
    // Содержимого в событии нет: ни текста открытки, ни номера.
    expect(JSON.stringify(event.payload)).not.toContain(CARD_TEXT);
    expect(event.audienceUserId).toBeNull();
    for (const role of ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR', 'WAREHOUSE'] as const) {
      expect(event.audienceRoles, role).toContain(role);
    }
    expect(event.audienceRoles).not.toContain('COURIER');
  });
});

// --- Курьер ------------------------------------------------------------------

async function currentMaxEventId(): Promise<bigint> {
  const newest = await ctx.db.realtimeEvent.findFirst({
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  return newest?.id ?? 0n;
}

/** События, которые канал отдал бы этому курьеру после курсора. */
async function eventsSeenByCourier(
  courierUserId: string,
  after: bigint,
): Promise<{ topic: string; payload: { routeId?: string; orderIds?: string[] } }[]> {
  const read = await readEventsForViewer(
    ctx.db,
    { userId: courierUserId, roles: ['COURIER'] },
    after,
    new Date(Date.now() + VISIBILITY_LAG_MS + 1_000),
  );
  return read.events.map((event) => ({
    topic: event.topic,
    payload: event.payload as { routeId?: string; orderIds?: string[] },
  }));
}

function aboutOrder(
  events: readonly { topic: string; payload: { routeId?: string; orderIds?: string[] } }[],
  orderId: string,
): { topic: string; routeId: string | undefined }[] {
  return events
    .filter((event) => (event.payload.orderIds ?? []).includes(orderId))
    .map((event) => ({ topic: event.topic, routeId: event.payload.routeId }));
}

describe('курьер узнаёт о смене пометки лично', () => {
  it('появление и снятие открытки: личное событие курьеру листа, другому — ничего', async () => {
    const stand = await seedStand();
    const stranger = await loginAs(['COURIER']);
    await seedRoute('ACTIVE', stranger.userId, [await seedOrder(null)]);
    const order = stand.active.withoutCard;

    const beforeAdd = await currentMaxEventId();
    await syncCardText(order, CARD_TEXT);
    expect(
      aboutOrder(await eventsSeenByCourier(stand.courier.userId, beforeAdd), order.id),
    ).toEqual([{ topic: 'route.updated', routeId: stand.activeRouteId }]);
    expect(aboutOrder(await eventsSeenByCourier(stranger.userId, beforeAdd), order.id)).toEqual([]);
    // По событию «Активные» курьера перечитываются — и показывают пометку.
    expect(
      (await activeMarks(stand.courier.token, stand.activeRouteId)).marks.get(order.number),
    ).toBe(true);

    const beforeRemove = await currentMaxEventId();
    await syncCardText(order, null);
    expect(
      aboutOrder(await eventsSeenByCourier(stand.courier.userId, beforeRemove), order.id),
    ).toEqual([{ topic: 'route.updated', routeId: stand.activeRouteId }]);
    expect(aboutOrder(await eventsSeenByCourier(stranger.userId, beforeRemove), order.id)).toEqual(
      [],
    );
    expect(
      (await activeMarks(stand.courier.token, stand.activeRouteId)).marks.get(order.number),
    ).toBe(false);
  });

  it('событие личное: адресат — курьер листа, ролям оно не рассылается, текста в нём нет', async () => {
    const stand = await seedStand();
    const order = stand.active.withoutCard;
    const before = await currentMaxEventId();

    await syncCardText(order, CARD_TEXT);

    const rows = await ctx.db.realtimeEvent.findMany({
      where: { id: { gt: before }, topic: 'route.updated' },
      select: { audienceUserId: true, audienceRoles: true, payload: true },
    });
    const personal = rows.filter((row) =>
      ((row.payload as { orderIds?: string[] }).orderIds ?? []).includes(order.id),
    );
    expect(personal).toHaveLength(1);
    expect(personal[0]?.audienceUserId).toBe(stand.courier.userId);
    expect(personal[0]?.audienceRoles).toEqual([]);
    expect(personal[0]?.payload).toEqual({ routeId: stand.activeRouteId, orderIds: [order.id] });
    expect(JSON.stringify(personal[0]?.payload)).not.toContain(CARD_TEXT);
  });

  it('смена текста без смены признака курьера не тревожит', async () => {
    const stand = await seedStand();
    const order = stand.active.withCard;
    const before = await currentMaxEventId();

    await syncCardText(order, 'Другой синтетический текст открытки');

    expect(aboutOrder(await eventsSeenByCourier(stand.courier.userId, before), order.id)).toEqual(
      [],
    );
    expect(
      (await activeMarks(stand.courier.token, stand.activeRouteId)).marks.get(order.number),
    ).toBe(true);
  });

  it('курьер ещё не отгруженного листа тоже узнаёт: гонка с ручной отгрузкой закрыта', async () => {
    const stand = await seedStand();
    const order = stand.confirmed.withoutCard;
    const before = await currentMaxEventId();

    await syncCardText(order, CARD_TEXT);

    expect(aboutOrder(await eventsSeenByCourier(stand.courier.userId, before), order.id)).toEqual([
      { topic: 'route.updated', routeId: stand.confirmedRouteId },
    ]);
  });
});
