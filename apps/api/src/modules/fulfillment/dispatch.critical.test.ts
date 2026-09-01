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
import { readQueue } from './queue-service.js';
import { dispatchFlorists } from './dispatch.js';
import {
  floristDispatchStatus,
  setDispatchReady,
  setFinishAfterCurrent,
  requestRefusal,
  decideRefusal,
} from './dispatch-florist.js';
import { readFloristDispatchMode, saveFloristDispatchMode } from '../settings/service.js';

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
