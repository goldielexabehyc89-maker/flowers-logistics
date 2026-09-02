/**
 * Критические проверки автоматической раздачи заказов флористам.
 *
 * Защищаемое:
 *  * в ручном режиме сервер не раздаёт и очередь флористу видна;
 *  * в авто-режиме свободная очередь флористу НЕ отдаётся (сервер, а не UI),
 *    а руководитель её по-прежнему видит;
 *  * заказ уходит верхнему по общему `sortQueue`, свободный флорист — «дольше
 *    всех готов»; при равенстве детерминированно;
 *  * назначение атомарно: два заказа не уходят одному, один заказ — не двоим;
 *  * «закончить после текущего», занятость заказом и открытый отказ исключают
 *    флориста из раздачи;
 *  * запрос отказа обязателен по причине и идемпотентен (один открытый на заказ);
 *  * решение по отказу идемпотентно: «Подтвердить» возвращает заказ в раздачу и
 *    тому же флористу в этом прогоне не выдаёт; «Передать» переназначает.
 *
 * ВЛАДЕНИЕ ДАТАМИ: май 2029 (см. RESERVED_MONTHS).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { snapshotHash, type FulfillmentSnapshot } from './composition.js';
import { startShift } from './shifts.js';
import { claimOrder } from './assembly.js';
import { listDispatchableOrderIds, readQueue } from './queue-service.js';
import { readOrderCard } from './card.js';
import { dispatchFlorists } from './dispatch.js';
import {
  floristDispatchStatus,
  setDispatchReady,
  setFinishAfterCurrent,
  requestRefusal,
  decideRefusal,
  listPendingRefusalNotificationIds,
} from './dispatch-florist.js';
import { readFloristDispatchMode, saveFloristDispatchMode } from '../settings/service.js';
import { applyCancellation } from '../integrations/moysklad/cancellation.js';

let ctx: TestContext;
const CONTEXT = { ip: null, userAgent: null };
/** Полдень в мае 2029 по Москве: заказы этого дня — «сегодня» для очереди. */
const NOW = new Date('2029-05-15T06:00:00.000Z');
const DAY = '2029-05-15';

let admin: AuthenticatedActor;

beforeAll(async () => {
  ctx = await createTestContext();
  const adminUser = await seedUser(ctx.db, { roles: ['ADMIN'], fullName: 'Админ раздачи' });
  admin = { userId: adminUser.id, roles: ['ADMIN'], familyId: randomUUID() } as AuthenticatedActor;
});

afterAll(async () => {
  // Настройка глобальная: оставить авто-режим включённым — сломать очередь
  // всем следующим файлам в общей базе. Возвращаем ручной режим всегда.
  await setAuto(false);
  await closeTestContext(ctx);
});

// Каждый тест начинается с чистого режима: авто включает только тот, кому нужно.
afterEach(async () => {
  await setAuto(false);
});

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${seq}`;
}

async function setAuto(auto: boolean): Promise<void> {
  const current = await readFloristDispatchMode(ctx.db);
  await saveFloristDispatchMode(ctx.db, admin, {
    value: { auto },
    expectedVersion: current.version,
    ip: null,
    userAgent: null,
  });
}

function composition(externalId: string): FulfillmentSnapshot {
  return {
    externalId,
    description: 'Букет',
    cardText: null,
    positions: [
      {
        externalPositionId: randomUUID(),
        ordinal: 0,
        assortmentId: randomUUID(),
        assortmentKind: 'PRODUCT',
        assortmentKindRaw: 'product',
        name: 'Роза',
        quantity: '3',
        uomId: null,
        uomName: 'шт',
        characteristicLabel: null,
        components: [],
      },
    ],
  };
}

/** Свободный заказ, готовый к сборке, с датой доставки «сегодня». */
async function seedOrder(startMinute = 600): Promise<{ id: string; number: string }> {
  const number = unique('AD');
  const externalId = randomUUID();
  const snap = composition(externalId);
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId,
      externalName: number,
      externalUpdated: new Date('2029-05-01T00:00:00.000Z'),
      deliveryDate: toDateColumn(DAY),
      intervalKind: 'RANGE',
      intervalStartMinute: startMinute,
      intervalEndMinute: startMinute + 240,
      inScope: true,
      fulfillmentInScope: true,
      fulfillmentDescription: snap.description,
      fulfillmentCardText: snap.cardText,
      fulfillmentSnapshotHash: snapshotHash(snap),
      fulfillmentCompositionState: 'READY',
      fulfillmentCompositionSyncedAt: new Date(),
      fulfillmentPositions: {
        create: snap.positions.map((p) => ({
          externalPositionId: p.externalPositionId,
          ordinal: p.ordinal,
          assortmentId: p.assortmentId,
          assortmentKind: p.assortmentKind,
          assortmentKindRaw: p.assortmentKindRaw,
          name: p.name,
          quantity: p.quantity,
          characteristicLabel: p.characteristicLabel,
        })),
      },
      fulfillmentRevisions: {
        create: {
          externalUpdated: new Date('2029-05-01T00:00:00.000Z'),
          snapshot: snap as never,
          snapshotHash: snapshotHash(snap),
          changedFields: ['externalId', 'description', 'positions'],
          reason: 'INITIAL_IMPORT',
        },
      },
    },
    select: { id: true },
  });
  return { id: order.id, number };
}

/** Флорист на активной смене. `readyAt` управляем — для порядка «дольше готов». */
async function floristReady(
  name: string,
  readyAt: Date | null,
): Promise<AuthenticatedActor & { shiftId: string }> {
  const user = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: name });
  const actor = {
    userId: user.id,
    roles: ['FLORIST'],
    familyId: randomUUID(),
  } as AuthenticatedActor;
  await startShift(ctx.db, actor, CONTEXT);
  const shift = await ctx.db.floristShift.findFirstOrThrow({
    where: { activeKey: user.id },
    select: { id: true },
  });
  if (readyAt !== null) {
    await ctx.db.floristShift.update({
      where: { id: shift.id },
      data: { dispatchReadyAt: readyAt },
    });
  }
  return Object.assign(actor, { shiftId: shift.id });
}

/** Флорист на активной смене, БЕЗ готовности: её выставляют отдельно. */
async function floristOnShift(name: string): Promise<AuthenticatedActor & { shiftId: string }> {
  const user = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: name });
  const actor = {
    userId: user.id,
    roles: ['FLORIST'],
    familyId: randomUUID(),
  } as AuthenticatedActor;
  await startShift(ctx.db, actor, CONTEXT);
  const shift = await ctx.db.floristShift.findFirstOrThrow({
    where: { activeKey: user.id },
    select: { id: true },
  });
  return Object.assign(actor, { shiftId: shift.id });
}

/** Управляемая готовность: порядок «дольше всех готов» задаётся временем. */
async function makeReady(shiftId: string, readyAt: Date): Promise<void> {
  await ctx.db.floristShift.update({ where: { id: shiftId }, data: { dispatchReadyAt: readyAt } });
}

/**
 * Изоляция прогона в общей базе.
 *
 * Критические файлы копят и заказы (их нельзя удалять), и готовых флористов от
 * предыдущих тестов. Без изоляции движок раздал бы чужое: снимаем готовность со
 * ВСЕХ смен и выводим из раздачи все свободные заказы, кроме нужных этому тесту.
 */
async function isolate(keepOrderIds: string[]): Promise<void> {
  await ctx.db.floristShift.updateMany({
    where: { closedAt: null },
    data: { dispatchReadyAt: null },
  });
  // Обе области сразу: триггер `fulfillment_scope_covers_logistics` вернул бы
  // `fulfillmentInScope=true`, пока `inScope=true`. Заказ выводится из работы
  // целиком — из логистики и из сборки.
  await ctx.db.deliveryOrder.updateMany({
    where: { fulfillmentProcessState: 'NEW', id: { notIn: keepOrderIds } },
    data: { inScope: false, fulfillmentInScope: false },
  });
}

function processState(orderId: string): Promise<{
  fulfillmentProcessState: string;
  fulfillmentAssigneeId: string | null;
}> {
  return ctx.db.deliveryOrder.findFirstOrThrow({
    where: { id: orderId },
    select: { fulfillmentProcessState: true, fulfillmentAssigneeId: true },
  });
}

describe('режим и видимость очереди', () => {
  it('ручной режим: сервер не раздаёт, очередь флористу видна', async () => {
    await setAuto(false);
    const order = await seedOrder();
    const florist = await floristReady('Ручной флорист', NOW);
    // Общая база копит заказы: без изоляции свежий заказ ушёл бы за первую
    // страницу очереди, и проверка «виден в очереди» ловила бы пагинацию.
    await isolate([order.id]);

    const assigned = await dispatchFlorists(ctx.db, NOW);
    expect(assigned).toBe(0);
    expect((await processState(order.id)).fulfillmentProcessState).toBe('NEW');

    const queue = await readQueue(
      ctx.db,
      { userId: florist.userId, roles: ['FLORIST'] },
      { day: 'today', scope: 'general', includeAssigned: false },
      NOW,
    );
    expect(queue.items.some((item) => item.id === order.id)).toBe(true);
  });

  it('авто-режим: очередь скрыта у флориста, но видна руководителю', async () => {
    const order = await seedOrder();
    const florist = await floristReady('Скрытая очередь', NOW);
    // Изоляция от накопленных заказов: у руководителя проверяем наличие именно
    // этого заказа, а у флориста — что очередь пуста из-за режима, а не страницы.
    await isolate([order.id]);
    await setAuto(true);

    const floristQueue = await readQueue(
      ctx.db,
      { userId: florist.userId, roles: ['FLORIST'] },
      { day: 'today', scope: 'general', includeAssigned: false },
      NOW,
    );
    expect(floristQueue.items).toHaveLength(0);
    expect(floristQueue.total).toBe(0);

    const adminQueue = await readQueue(
      ctx.db,
      { userId: admin.userId, roles: ['ADMIN'] },
      { day: 'today', scope: 'general', includeAssigned: false },
      NOW,
    );
    expect(adminQueue.items.some((item) => item.id === order.id)).toBe(true);
  });
});

describe('назначение', () => {
  it('заказ уходит флористу, готовому дольше всех', async () => {
    const order = await seedOrder();
    const early = await floristOnShift('Готов давно');
    const late = await floristOnShift('Готов недавно');
    await isolate([order.id]);
    await makeReady(early.shiftId, new Date('2029-05-15T05:00:00.000Z'));
    await makeReady(late.shiftId, new Date('2029-05-15T05:30:00.000Z'));
    await setAuto(true);

    const assigned = await dispatchFlorists(ctx.db, NOW);
    expect(assigned).toBe(1);

    const state = await processState(order.id);
    expect(state.fulfillmentProcessState).toBe('IN_ASSEMBLY');
    expect(state.fulfillmentAssigneeId).toBe(early.userId);
  });

  it('два заказа — двум флористам, один заказ одному не даётся дважды', async () => {
    const orderA = await seedOrder(600);
    const orderB = await seedOrder(660);
    const florA = await floristOnShift('Двое A');
    const florB = await floristOnShift('Двое B');
    await isolate([orderA.id, orderB.id]);
    await makeReady(florA.shiftId, new Date('2029-05-15T05:00:00.000Z'));
    await makeReady(florB.shiftId, new Date('2029-05-15T05:10:00.000Z'));
    await setAuto(true);

    const assigned = await dispatchFlorists(ctx.db, NOW);
    expect(assigned).toBe(2);

    const stateA = await processState(orderA.id);
    const stateB = await processState(orderB.id);
    const assignees = [stateA.fulfillmentAssigneeId, stateB.fulfillmentAssigneeId].sort();
    expect(assignees).toEqual([florA.userId, florB.userId].sort());
    expect(stateA.fulfillmentAssigneeId).not.toBe(stateB.fulfillmentAssigneeId);
  });

  it('«закончить после текущего» и занятость исключают из раздачи', async () => {
    const order = await seedOrder();
    const finishing = await floristOnShift('Заканчивает');
    const busyOrder = await seedOrder(700);
    const busy = await floristOnShift('Занят');
    await claimOrder(ctx.db, busy, busyOrder.id, CONTEXT);
    await isolate([order.id]);
    await makeReady(finishing.shiftId, NOW);
    await setFinishAfterCurrent(ctx.db, finishing, true, CONTEXT);
    await makeReady(busy.shiftId, NOW);

    await setAuto(true);
    const assigned = await dispatchFlorists(ctx.db, NOW);
    // Раздать некому: один заканчивает, другой занят. Заказ остаётся свободным.
    expect(assigned).toBe(0);
    expect((await processState(order.id)).fulfillmentProcessState).toBe('NEW');
  });
});

describe('готовность требует смены', () => {
  it('без активной смены «Готов» отклоняется', async () => {
    const user = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: 'Без смены' });
    const actor = {
      userId: user.id,
      roles: ['FLORIST'],
      familyId: randomUUID(),
    } as AuthenticatedActor;
    await expect(setDispatchReady(ctx.db, actor, true, CONTEXT)).rejects.toThrow();
  });
});

describe('отказ', () => {
  it('причина «Другое» без комментария отклоняется, обычная — создаёт запрос', async () => {
    const order = await seedOrder();
    const florist = await floristReady('Отказ причина', NOW);
    await claimOrder(ctx.db, florist, order.id, CONTEXT);

    await expect(
      requestRefusal(
        ctx.db,
        florist,
        { orderId: order.id, reason: 'OTHER', comment: null },
        CONTEXT,
      ),
    ).rejects.toThrow();

    const first = await requestRefusal(
      ctx.db,
      florist,
      { orderId: order.id, reason: 'INSUFFICIENT_GOODS', comment: null },
      CONTEXT,
    );
    expect(first.created).toBe(true);

    // Повтор не создаёт второй открытый запрос — возвращает тот же.
    const again = await requestRefusal(
      ctx.db,
      florist,
      { orderId: order.id, reason: 'CANNOT_ASSEMBLE', comment: null },
      CONTEXT,
    );
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id);

    const pending = await ctx.db.orderRefusalRequest.count({
      where: { orderId: order.id, state: 'PENDING' },
    });
    expect(pending).toBe(1);

    const status = await floristDispatchStatus(ctx.db, florist, NOW);
    expect(status.pendingRefusal).toBe(true);
  });

  it('«Подтвердить отказ» возвращает заказ в раздачу и не отдаёт его тому же флористу', async () => {
    const order = await seedOrder();
    const refuser = await floristReady('Отказавшийся', new Date('2029-05-15T05:00:00.000Z'));
    await claimOrder(ctx.db, refuser, order.id, CONTEXT);
    const request = await requestRefusal(
      ctx.db,
      refuser,
      { orderId: order.id, reason: 'WRONG_ASSIGNMENT', comment: null },
      CONTEXT,
    );
    const notificationId = await ctx.db.orderRefusalRequest
      .findFirstOrThrow({ where: { id: request.id }, select: { notificationId: true } })
      .then((row) => row.notificationId ?? '');

    const decision = await decideRefusal(
      ctx.db,
      admin,
      { notificationId, action: 'APPROVE', floristId: null },
      CONTEXT,
    );
    expect(decision.state).toBe('APPROVED');
    expect(decision.alreadyDecided).toBe(false);

    const afterApprove = await processState(order.id);
    expect(afterApprove.fulfillmentProcessState).toBe('NEW');
    expect(afterApprove.fulfillmentAssigneeId).toBeNull();

    // Повторное решение идемпотентно.
    const repeat = await decideRefusal(
      ctx.db,
      admin,
      { notificationId, action: 'REJECT', floristId: null },
      CONTEXT,
    );
    expect(repeat.alreadyDecided).toBe(true);
    expect(repeat.state).toBe('APPROVED');

    // Раздача: заказ не возвращается отказавшемуся, уходит другому готовому.
    const other = await floristOnShift('Другой готовый');
    await isolate([order.id]);
    // Отказавшийся снова свободен и готов раньше — но по одобренному отказу
    // заказ не его: движок пропускает его и отдаёт заказ другому.
    await makeReady(refuser.shiftId, new Date('2029-05-15T05:00:00.000Z'));
    await makeReady(other.shiftId, new Date('2029-05-15T05:30:00.000Z'));
    await setAuto(true);

    await dispatchFlorists(ctx.db, NOW);
    const reassigned = await processState(order.id);
    expect(reassigned.fulfillmentProcessState).toBe('IN_ASSEMBLY');
    expect(reassigned.fulfillmentAssigneeId).toBe(other.userId);
  });

  it('«Передать другому» переназначает заказ выбранному флористу', async () => {
    const order = await seedOrder();
    const refuser = await floristReady('Передающий', NOW);
    await claimOrder(ctx.db, refuser, order.id, CONTEXT);
    const target = await floristReady('Принимающий', NOW);

    const request = await requestRefusal(
      ctx.db,
      refuser,
      { orderId: order.id, reason: 'PHYSICALLY_IMPOSSIBLE', comment: null },
      CONTEXT,
    );
    const notificationId = await ctx.db.orderRefusalRequest
      .findFirstOrThrow({ where: { id: request.id }, select: { notificationId: true } })
      .then((row) => row.notificationId ?? '');

    const decision = await decideRefusal(
      ctx.db,
      admin,
      { notificationId, action: 'TRANSFER', floristId: target.userId },
      CONTEXT,
    );
    expect(decision.state).toBe('TRANSFERRED');

    const state = await processState(order.id);
    expect(state.fulfillmentProcessState).toBe('IN_ASSEMBLY');
    expect(state.fulfillmentAssigneeId).toBe(target.userId);
  });
});

/** Выводит заказ из области (исчез из источника) — как ORDER_SOURCE_MISSING. */
async function makeOutOfScope(orderId: string): Promise<void> {
  await ctx.db.deliveryOrder.update({
    where: { id: orderId },
    data: { inScope: false, fulfillmentInScope: false, sourceMissing: true },
  });
}

describe('застрявший назначенный заказ', () => {
  it('карточка открывается, а руководитель находит заказ поиском, даже вне области', async () => {
    const order = await seedOrder();
    const florist = await floristReady('Держит застрявший', NOW);
    await claimOrder(ctx.db, florist, order.id, CONTEXT);
    // Заказ исчез из МоегоСклада уже ПОСЛЕ того, как попал в работу.
    await makeOutOfScope(order.id);

    // 1. Карточка открывается у назначенного флориста (не 404) и помечена.
    const card = await readOrderCard(ctx.db, order.id, {
      userId: florist.userId,
      roles: ['FLORIST'],
    });
    expect(card.process.state).toBe('IN_ASSEMBLY');
    expect(card.process.assignee?.id).toBe(florist.userId);
    expect(card.outOfScope).toBe(true);

    // 2. Флорист видит заказ в «Моей работе», несмотря на выход из области.
    const mine = await readQueue(
      ctx.db,
      { userId: florist.userId, roles: ['FLORIST'] },
      { day: 'today', scope: 'mine', includeAssigned: false },
      NOW,
    );
    expect(mine.items.some((item) => item.id === order.id)).toBe(true);

    // 3. Руководитель находит его поиском по номеру и видит исполнителя.
    const found = await readQueue(
      ctx.db,
      { userId: admin.userId, roles: ['ADMIN'] },
      { day: 'today', scope: 'general', includeAssigned: false, search: order.number },
      NOW,
    );
    const row = found.items.find((item) => item.id === order.id);
    expect(row, 'заказ найден поиском руководителя').toBeDefined();
    expect(row?.assignee?.id).toBe(florist.userId);
  });

  it('свободный заказ вне области карточкой по прямой ссылке НЕ отдаётся', async () => {
    const order = await seedOrder();
    await isolate([]); // остаётся NEW, но выводим из области ниже
    await makeOutOfScope(order.id);
    await expect(
      readOrderCard(ctx.db, order.id, { userId: admin.userId, roles: ['ADMIN'] }),
    ).rejects.toThrow();
  });
});

describe('единый источник очереди', () => {
  it('свободная очередь руководителя и кандидаты автораздачи — один список и порядок', async () => {
    const a = await seedOrder(600);
    const b = await seedOrder(660);
    const c = await seedOrder(720);
    await isolate([a.id, b.id, c.id]);

    const candidates = await listDispatchableOrderIds(ctx.db, NOW);
    const queue = await readQueue(
      ctx.db,
      { userId: admin.userId, roles: ['ADMIN'] },
      { day: 'today', scope: 'general', includeAssigned: false },
      NOW,
    );
    // Тот же набор и тот же порядок: кандидаты раздачи == видимая очередь.
    expect(candidates).toEqual(queue.items.map((item) => item.id));
    expect(candidates.slice(0, 3)).toEqual([a.id, b.id, c.id]);
  });
});

describe('регрессия: два флориста, отказ, возврат в очередь', () => {
  it('A→первому; отказ подтверждён; A уходит второму; первому — B; все находятся и открываются', async () => {
    const a = await seedOrder(600);
    const b = await seedOrder(660);
    const c = await seedOrder(720);
    const flor1 = await floristOnShift('Первый');
    const flor2 = await floristOnShift('Второй');
    await isolate([a.id, b.id, c.id]);

    // Сначала готов только первый — ему достаётся верхний A.
    await makeReady(flor1.shiftId, new Date('2029-05-15T05:00:00.000Z'));
    await setAuto(true);
    await dispatchFlorists(ctx.db, NOW);
    expect((await processState(a.id)).fulfillmentAssigneeId).toBe(flor1.userId);

    // Первый отказывается от A; руководитель подтверждает — A возвращается в NEW.
    const req = await requestRefusal(
      ctx.db,
      flor1,
      { orderId: a.id, reason: 'INSUFFICIENT_GOODS', comment: null },
      CONTEXT,
    );
    const notificationId = await ctx.db.orderRefusalRequest
      .findFirstOrThrow({ where: { id: req.id }, select: { notificationId: true } })
      .then((row) => row.notificationId ?? '');
    const decision = await decideRefusal(
      ctx.db,
      admin,
      { notificationId, action: 'APPROVE', floristId: null },
      CONTEXT,
    );
    expect(decision.state).toBe('APPROVED');
    expect((await processState(a.id)).fulfillmentProcessState).toBe('NEW');

    // A снова первый в общей очереди.
    const queue = await readQueue(
      ctx.db,
      { userId: admin.userId, roles: ['ADMIN'] },
      { day: 'today', scope: 'general', includeAssigned: false },
      NOW,
    );
    expect(queue.items[0]?.id).toBe(a.id);

    // Второй становится готов; раздача идёт снова: A уходит второму (первому —
    // нельзя, отказ одобрен), первому достаётся следующий свободный — B.
    await makeReady(flor2.shiftId, new Date('2029-05-15T05:10:00.000Z'));
    await dispatchFlorists(ctx.db, NOW);

    const aState = await processState(a.id);
    const bState = await processState(b.id);
    expect(aState.fulfillmentAssigneeId).toBe(flor2.userId);
    expect(bState.fulfillmentAssigneeId).toBe(flor1.userId);
    // C остаётся свободным — флористов больше нет.
    expect((await processState(c.id)).fulfillmentProcessState).toBe('NEW');

    // Все три заказа находятся руководителем поиском и открываются.
    for (const order of [a, b, c]) {
      const found = await readQueue(
        ctx.db,
        { userId: admin.userId, roles: ['ADMIN'] },
        { day: 'today', scope: 'general', includeAssigned: false, search: order.number },
        NOW,
      );
      expect(
        found.items.some((item) => item.id === order.id),
        `найден ${order.number}`,
      ).toBe(true);
      const card = await readOrderCard(ctx.db, order.id, {
        userId: admin.userId,
        roles: ['ADMIN'],
      });
      expect(card.number).toBe(order.number);
    }
  });
});

describe('догоняющие окна отказов', () => {
  it('открытый отказ попадает в догоняющий список, решённый — нет', async () => {
    const order = await seedOrder();
    const florist = await floristReady('Отказ для догона', NOW);
    await claimOrder(ctx.db, florist, order.id, CONTEXT);
    const req = await requestRefusal(
      ctx.db,
      florist,
      { orderId: order.id, reason: 'CANNOT_ASSEMBLE', comment: null },
      CONTEXT,
    );
    const notificationId = await ctx.db.orderRefusalRequest
      .findFirstOrThrow({ where: { id: req.id }, select: { notificationId: true } })
      .then((row) => row.notificationId ?? '');

    // Пока PENDING — уведомление в догоняющем списке (всплывёт после входа).
    const pending = await listPendingRefusalNotificationIds(ctx.db);
    expect(pending).toContain(notificationId);

    // После решения — из списка исчезает и повторно не всплывает.
    await decideRefusal(
      ctx.db,
      admin,
      { notificationId, action: 'REJECT', floristId: null },
      CONTEXT,
    );
    const afterDecision = await listPendingRefusalNotificationIds(ctx.db);
    expect(afterDecision).not.toContain(notificationId);
  });
});

describe('доступ к застрявшему заказу вне области (доменное чтение карточки)', () => {
  it('владелец, ADMIN и SUPERVISOR видят; посторонний флорист получает 404', async () => {
    const owner = await floristReady('Владелец застрявшего', NOW);
    const order = await seedOrder();
    await claimOrder(ctx.db, owner, order.id, CONTEXT);
    await makeOutOfScope(order.id);

    // Владелец (назначенный флорист) — видит.
    const ownCard = await readOrderCard(ctx.db, order.id, {
      userId: owner.userId,
      roles: ['FLORIST'],
    });
    expect(ownCard.outOfScope).toBe(true);
    expect(ownCard.process.assignee?.id).toBe(owner.userId);

    // ADMIN и SUPERVISOR — видят.
    await expect(
      readOrderCard(ctx.db, order.id, { userId: admin.userId, roles: ['ADMIN'] }),
    ).resolves.toMatchObject({ number: order.number });
    const supervisor = await seedUser(ctx.db, { roles: ['SUPERVISOR'], fullName: 'Управляющий' });
    await expect(
      readOrderCard(ctx.db, order.id, { userId: supervisor.id, roles: ['SUPERVISOR'] }),
    ).resolves.toMatchObject({ number: order.number });

    // Посторонний флорист — 404, даже зная UUID.
    const stranger = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: 'Посторонний' });
    await expect(
      readOrderCard(ctx.db, order.id, { userId: stranger.id, roles: ['FLORIST'] }),
    ).rejects.toThrow();
  });
});

describe('единая финальная проверка кандидата', () => {
  it('отменённый кандидат не назначается, берётся следующий подходящий', async () => {
    const cancelled = await seedOrder(600);
    const valid = await seedOrder(660);
    // Отмена в источнике: заказ ещё числится свободным и в области, но собирать
    // его нельзя — финальная проверка назначения обязана его отклонить.
    await ctx.db.deliveryOrder.update({
      where: { id: cancelled.id },
      data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
    });
    const florist = await floristOnShift('Финальная проверка');
    await isolate([cancelled.id, valid.id]);
    await makeReady(florist.shiftId, NOW);
    await setAuto(true);

    await dispatchFlorists(ctx.db, NOW);

    // Верхний по очереди — отменённый; он НЕ назначен (конкретная причина —
    // отмена), а флорист получил следующий подходящий заказ.
    expect((await processState(cancelled.id)).fulfillmentProcessState).toBe('NEW');
    expect((await processState(valid.id)).fulfillmentAssigneeId).toBe(florist.userId);
  });
});

describe('отменённый заказ скрыт из работы флориста (change 1)', () => {
  it('не в свободной очереди, не в поиске, не в кандидатах автораздачи', async () => {
    const cancelled = await seedOrder(600);
    const valid = await seedOrder(660);
    await ctx.db.deliveryOrder.update({
      where: { id: cancelled.id },
      data: { cancelledInSource: true, cancelledInSourceAt: new Date() },
    });
    await isolate([cancelled.id, valid.id]);

    // Свободная очередь руководителя: отменённого нет, обычный есть.
    const queue = await readQueue(
      ctx.db,
      { userId: admin.userId, roles: ['ADMIN'] },
      { day: 'today', scope: 'general', includeAssigned: false },
      NOW,
    );
    const ids = queue.items.map((i) => i.id);
    expect(ids).toContain(valid.id);
    expect(ids).not.toContain(cancelled.id);

    // Поиск по номеру отменённого — пусто (свободный отменённый не находится).
    const found = await readQueue(
      ctx.db,
      { userId: admin.userId, roles: ['ADMIN'] },
      { day: 'today', scope: 'general', includeAssigned: false, search: cancelled.number },
      NOW,
    );
    expect(found.items.some((i) => i.id === cancelled.id)).toBe(false);

    // Кандидаты автораздачи: отменённого нет.
    const candidates = await listDispatchableOrderIds(ctx.db, NOW);
    expect(candidates).not.toContain(cancelled.id);
    expect(candidates).toContain(valid.id);
  });

  it('отмена, пришедшая на назначенный (не собранный) заказ, снимает назначение', async () => {
    const order = await seedOrder();
    const florist = await floristReady('Держал отменённый', NOW);
    await claimOrder(ctx.db, florist, order.id, CONTEXT);
    expect((await processState(order.id)).fulfillmentProcessState).toBe('IN_ASSEMBLY');

    await applyCancellation(ctx.db, {
      orderId: order.id,
      cancelled: true,
      previous: false,
      now: new Date(),
    });

    const state = await processState(order.id);
    // Флорист освобождён: назначения нет; в свободную очередь заказ не вернулся
    // (он отменён и из неё исключён).
    expect(state.fulfillmentAssigneeId).toBeNull();
    expect(state.fulfillmentProcessState).toBe('NEW');
    const mine = await readQueue(
      ctx.db,
      { userId: florist.userId, roles: ['FLORIST'] },
      { day: 'today', scope: 'mine', includeAssigned: false },
      NOW,
    );
    expect(mine.items.some((i) => i.id === order.id)).toBe(false);
  });
});
