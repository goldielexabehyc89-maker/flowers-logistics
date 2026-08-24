/**
 * Сквозная история заказа: агрегация, порядок и границы.
 *
 * Проверяется не «строится ли список», а то, нарушение чего сделает историю
 * бесполезной или опасной:
 *
 *  * каждое обязательное событие берётся из своего источника и попадает
 *    в ленту ровно один раз — двойная строка про одну отгрузку заставляет
 *    искать несуществующую вторую;
 *  * порядок строго хронологический и УСТОЙЧИВЫЙ: одна транзакция пишет
 *    несколько строк с одинаковым временем, и без второго ключа они менялись
 *    бы местами между запросами, а курсор давал бы то пропуск, то повтор;
 *  * события двух заказов не смешиваются;
 *  * московские сутки считает сервер: событие в 21:30 UTC принадлежит
 *    следующему московскому дню;
 *  * отменённое действие и его отмена видны ОДНОВРЕМЕННО — история не
 *    переписывается задним числом;
 *  * повторная доставка и возврат остаются связаны с исходным заказом;
 *  * в ленте нет получателя, телефона и комментария: это карточка, а не
 *    история;
 *  * право проверяет сервер: чужая роль получает 403, неизвестный заказ — 404.
 *
 * ВЛАДЕНИЕ ДАТАМИ: файл забронировал октябрь 2028 года
 * (`platform/testing/test-days.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { TEST_SECRETS } from '../../platform/testing/secrets.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { readOrderTimeline, type TimelineEvent } from './timeline.js';

const DAY = '2028-10-12';

let ctx: TestContext;

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

/** Момент внутри забронированного дня: `at('10:00')`. */
function at(time: string, day = DAY): Date {
  return new Date(`${day}T${time}:00.000Z`);
}

async function seedOrder(number: string): Promise<string> {
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: crypto.randomUUID(),
      externalName: number,
      externalUpdated: at('06:00'),
      deliveryDate: toDateColumn(DAY),
      intervalKind: 'RANGE',
      intervalStartMinute: 600,
      intervalEndMinute: 840,
      address: 'Москва, проверочный адрес 7',
      recipient: 'Проверочный Получатель +79990000000',
      comment: 'Комментарий по доставке',
      inScope: true,
      fulfillmentInScope: true,
    },
    select: { id: true },
  });
  return order.id;
}

async function seedRoute(createdById: string, courierUserId: string | null): Promise<string> {
  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('МЛ'),
      deliveryDate: toDateColumn(DAY),
      state: 'CONFIRMED',
      vehicleType: 'CAR',
      createdById,
      ...(courierUserId === null ? {} : { courierUserId }),
    },
    select: { id: true },
  });
  return route.id;
}

async function seedCell(createdById: string, kind: 'STORAGE' | 'ROUTE'): Promise<string> {
  const code = unique(kind === 'STORAGE' ? 'S' : 'R');
  const cell = await ctx.db.storageCell.create({
    data: { code, normalizedCode: code, kind, createdById },
    select: { id: true },
  });
  return cell.id;
}

function kindsOf(events: readonly TimelineEvent[]): string[] {
  return events.map((entry) => entry.kind);
}

describe('лента истории заказа', () => {
  it('собирает полный жизненный цикл по одному событию на источник', async () => {
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const florist = await seedUser(ctx.db, { roles: ['FLORIST'] });
    const keeper = await seedUser(ctx.db, { roles: ['WAREHOUSE'] });
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });

    const orderId = await seedOrder(unique('OH'));
    const routeId = await seedRoute(logist.id, courier.id);
    const storage = await seedCell(keeper.id, 'STORAGE');
    const routeCell = await seedCell(keeper.id, 'ROUTE');

    // 1. Импорт и обновление источника.
    await ctx.db.deliveryOrderRevision.create({
      data: {
        orderId,
        externalUpdated: at('06:00'),
        receivedAt: at('06:00'),
        snapshot: {},
        snapshotHash: 'h1',
        changedFields: [],
        reason: 'INITIAL_IMPORT',
      },
    });
    await ctx.db.deliveryOrderRevision.create({
      data: {
        orderId,
        externalUpdated: at('06:30'),
        receivedAt: at('06:30'),
        snapshot: {},
        snapshotHash: 'h2',
        changedFields: ['deliveryDate'],
        reason: 'EXTERNAL_UPDATE',
      },
    });
    // Обновление без изменений строкой не становится: синхронизация ходит
    // часто, и такой список читать было бы невозможно.
    await ctx.db.deliveryOrderRevision.create({
      data: {
        orderId,
        externalUpdated: at('06:40'),
        receivedAt: at('06:40'),
        snapshot: {},
        snapshotHash: 'h3',
        changedFields: [],
        reason: 'EXTERNAL_UPDATE',
      },
    });

    // 2. Состав подтверждён — заказ виден флористу.
    await ctx.db.orderFulfillmentRevision.create({
      data: {
        orderId,
        externalUpdated: at('06:05'),
        receivedAt: at('06:05'),
        snapshot: {},
        snapshotHash: 'c1',
        changedFields: ['positions'],
        reason: 'INITIAL_IMPORT',
      },
    });

    // 3. Адрес и интервал.
    await ctx.db.orderAddressHistory.create({
      data: {
        orderId,
        action: 'LOCAL_ADDRESS_SET',
        occurredAt: at('07:00'),
        oldAddress: 'Москва, проверочный адрес 7',
        newAddress: 'Москва, проверочный адрес 9',
        sourceAddress: 'Москва, проверочный адрес 7',
        actorUserId: logist.id,
      },
    });
    await ctx.db.auditLog.create({
      data: {
        action: 'ORDER_INTERVAL_SET',
        entityType: 'DeliveryOrder',
        entityId: orderId,
        actorUserId: logist.id,
        actorRoles: ['LOGISTICIAN'],
        occurredAt: at('07:10'),
        oldValue: { startMinute: null, endMinute: null },
        newValue: { startMinute: 600, endMinute: 720 },
      },
    });

    // 4. Флорист: взял и собрал.
    await ctx.db.auditLog.create({
      data: {
        action: 'ORDER_FULFILLMENT_CLAIMED',
        entityType: 'DeliveryOrder',
        entityId: orderId,
        actorUserId: florist.id,
        actorRoles: ['FLORIST'],
        occurredAt: at('08:00'),
        newValue: { processState: 'IN_ASSEMBLY' },
      },
    });
    await ctx.db.auditLog.create({
      data: {
        action: 'ORDER_FULFILLMENT_ASSEMBLED',
        entityType: 'DeliveryOrder',
        entityId: orderId,
        actorUserId: florist.id,
        actorRoles: ['FLORIST'],
        occurredAt: at('08:40'),
        newValue: { processState: 'ASSEMBLED' },
      },
    });

    // 5. Бланк и две печати.
    const revision = await ctx.db.orderFulfillmentRevision.findFirstOrThrow({
      where: { orderId },
      select: { id: true },
    });
    const form = await ctx.db.orderPrintForm.create({
      data: {
        orderId,
        revisionId: revision.id,
        assemblyRound: 1,
        templateVersion: 1,
        snapshot: {},
        snapshotHash: 'p1',
        createdAt: at('08:41'),
      },
      select: { id: true },
    });
    await ctx.db.orderPrintJob.create({
      data: {
        orderId,
        printFormId: form.id,
        state: 'PRINTED',
        attempt: 1,
        createdAt: at('08:42'),
        completedAt: at('08:43'),
        completedById: florist.id,
      },
    });
    await ctx.db.orderPrintJob.create({
      data: {
        orderId,
        printFormId: form.id,
        state: 'PRINTED',
        attempt: 2,
        createdAt: at('08:50'),
        completedAt: at('08:51'),
        completedById: florist.id,
      },
    });

    // 6. Склад: приёмка в хранение, перенос на маршрутную полку, выдача.
    await ctx.db.orderPlacement.create({
      data: {
        orderId,
        cellId: storage,
        source: 'RECEIVED',
        placedAt: at('09:00'),
        placedById: keeper.id,
        releasedAt: at('09:30'),
        releasedById: keeper.id,
        releaseReason: 'MOVED_TO_ROUTE_CELL',
        movedToCellId: routeCell,
      },
    });
    /*
     * Выдача курьеру неотделима от сессии комплектования: база требует
     * связь (`OrderPlacement_issue_session`), и обойти её нечем.
     */
    const session = await ctx.db.routeIssueSession.create({
      data: {
        routeId,
        courierUserId: courier.id,
        confirmedAt: at('10:20'),
        confirmedById: keeper.id,
      },
      select: { id: true },
    });
    const routePlacement = await ctx.db.orderPlacement.create({
      data: {
        orderId,
        cellId: routeCell,
        fromCellId: storage,
        source: 'MOVED',
        placedAt: at('09:30'),
        placedById: keeper.id,
        releasedAt: at('10:30'),
        releasedById: keeper.id,
        releaseReason: 'ISSUED_TO_COURIER',
        issueSessionId: session.id,
      },
      select: { id: true },
    });
    expect(routePlacement.id).not.toBe('');

    // 7. Лист: заказ добавлен, лист подтверждён и отгружен.
    const participation = await ctx.db.routeOrder.create({
      data: {
        routeId,
        orderId,
        position: 1,
        addedById: logist.id,
        addedAt: at('09:10'),
      },
      select: { id: true },
    });
    await ctx.db.routeStateTransition.create({
      data: {
        routeId,
        fromState: 'DRAFT',
        toState: 'CONFIRMED',
        actorUserId: logist.id,
        occurredAt: at('09:20'),
      },
    });
    await ctx.db.auditLog.create({
      data: {
        action: 'ROUTE_COURIER_ASSIGNED',
        entityType: 'DeliveryRoute',
        entityId: routeId,
        actorUserId: logist.id,
        actorRoles: ['LOGISTICIAN'],
        occurredAt: at('09:21'),
        newValue: { previousCourierUserId: null, courierUserId: courier.id },
      },
    });
    await ctx.db.auditLog.create({
      data: {
        action: 'ROUTE_ORDERS_REORDERED',
        entityType: 'DeliveryRoute',
        entityId: routeId,
        actorUserId: logist.id,
        actorRoles: ['LOGISTICIAN'],
        occurredAt: at('09:22'),
        newValue: { orderIds: ['00000000-0000-4000-8000-000000000001', orderId], totalOrders: 2 },
      },
    });
    await ctx.db.routeStateTransition.create({
      data: {
        routeId,
        fromState: 'CONFIRMED',
        toState: 'ACTIVE',
        actorUserId: keeper.id,
        occurredAt: at('10:30'),
      },
    });

    // 8. Комплектование.
    await ctx.db.routeIssueCheck.create({
      data: {
        sessionId: session.id,
        orderId,
        checkedAt: at('10:25'),
        checkedById: keeper.id,
      },
    });

    // 9. Недоставка, возврат и решение логиста.
    // Недоставка неотделима от справочной причины: база требует и ссылку,
    // и снимок названия (`DeliveryAttempt_reason_matches_outcome`).
    const reason = await ctx.db.deliveryFailureReason.create({
      data: { code: unique('R').slice(0, 40), name: unique('Причина'), ordinal: 1 },
      select: { id: true, name: true },
    });
    const attempt = await ctx.db.deliveryAttempt.create({
      data: {
        routeOrderId: participation.id,
        orderId,
        routeId,
        outcome: 'NOT_DELIVERED',
        reasonId: reason.id,
        reasonNameSnapshot: reason.name,
        courierUserId: courier.id,
        occurredAt: at('12:00'),
      },
      select: { id: true },
    });
    const resolution = await ctx.db.orderResolution.create({
      data: {
        orderId,
        routeOrderId: participation.id,
        attemptId: attempt.id,
        reasonNameSnapshot: reason.name,
        createdAt: at('12:01'),
        decision: 'REDELIVER_SAME_BOUQUET',
        decidedAt: at('12:30'),
        decidedById: logist.id,
      },
      select: { id: true },
    });
    expect(resolution.id).not.toBe('');
    /*
     * Принятый возврат неотделим от полки, на которую его положили
     * (`OrderReturn_accepted_complete`): «принят и лежит неизвестно где»
     * база не допускает.
     */
    const returnCell = await seedCell(keeper.id, 'STORAGE');
    const returnPlacement = await ctx.db.orderPlacement.create({
      data: {
        orderId,
        cellId: returnCell,
        source: 'COURIER_RETURN',
        placedAt: at('13:00'),
        placedById: keeper.id,
      },
      select: { id: true },
    });
    const orderReturn = await ctx.db.orderReturn.create({
      data: {
        orderId,
        routeOrderId: participation.id,
        attemptId: attempt.id,
        courierUserId: courier.id,
        sequence: 1,
        displayNumber: unique('ВЗ'),
        state: 'ACCEPTED',
        createdAt: at('12:02'),
        acceptedAt: at('13:00'),
        acceptedById: keeper.id,
        placementId: returnPlacement.id,
      },
      select: { id: true },
    });
    await ctx.db.orderReturnTransition.create({
      data: {
        returnId: orderReturn.id,
        fromState: 'WITH_COURIER',
        toState: 'ACCEPTED',
        occurredAt: at('13:00'),
        actorUserId: keeper.id,
      },
    });

    const page = await readOrderTimeline(ctx.db, { orderId, limit: 200, cursor: null });
    const kinds = kindsOf(page.events);

    // Каждое обязательное событие на месте и ровно одно.
    for (const kind of [
      'ORDER_INITIAL_IMPORT',
      'ORDER_EXTERNAL_UPDATE',
      'ORDER_QUEUED_FOR_FLORIST',
      'ADDRESS_LOCAL_ADDRESS_SET',
      'ORDER_INTERVAL_SET',
      'ORDER_FULFILLMENT_CLAIMED',
      'ORDER_FULFILLMENT_ASSEMBLED',
      'ORDER_PRINT_FORM_CREATED',
      'ORDER_PRINTED',
      'ORDER_REPRINTED',
      'PLACEMENT_RECEIVED',
      'PLACEMENT_RELEASED_MOVED_TO_ROUTE_CELL',
      'PLACEMENT_MOVED',
      'PLACEMENT_RELEASED_ISSUED_TO_COURIER',
      'ROUTE_ORDER_ADDED',
      'ROUTE_CONFIRMED',
      'ROUTE_COURIER_ASSIGNED',
      'ROUTE_ORDER_REORDERED',
      'ROUTE_ACTIVE',
      'ROUTE_ISSUE_CHECKED',
      'DELIVERY_FAILED',
      'ORDER_RESOLUTION_OPENED',
      'ORDER_RESOLUTION_REDELIVER_SAME_BOUQUET',
      'ORDER_RETURN_OPENED',
      'ORDER_RETURN_ACCEPTED',
    ]) {
      expect(
        kinds.filter((value) => value === kind),
        kind,
      ).toHaveLength(1);
    }

    // Пустое обновление источника строкой не стало.
    expect(kinds.filter((value) => value === 'ORDER_EXTERNAL_UPDATE')).toHaveLength(1);

    // Порядок строго по времени.
    const times = page.events.map((entry) => entry.occurredAt);
    expect([...times].sort()).toEqual(times);

    // Автор и роль берутся из источника, а не подставляются текущими.
    const claimed = page.events.find((entry) => entry.kind === 'ORDER_FULFILLMENT_CLAIMED');
    expect(claimed?.actor.kind).toBe('USER');
    expect(claimed?.actor.userId).toBe(florist.id);
    expect(claimed?.actor.roles).toEqual(['FLORIST']);
    expect(claimed?.actor.fullName).not.toBe(null);

    // У события из доменной таблицы снимка ролей нет — и он не выдумывается.
    const received = page.events.find((entry) => entry.kind === 'PLACEMENT_RECEIVED');
    expect(received?.actor.userId).toBe(keeper.id);
    expect(received?.actor.roles).toEqual([]);
    expect(received?.details).toContainEqual({ label: 'Вид полки', value: 'Хранение' });

    // Импорт и обновление источника подписаны МоимСкладом, а не человеком.
    expect(page.events.find((entry) => entry.kind === 'ORDER_INITIAL_IMPORT')?.actor.kind).toBe(
      'SOURCE',
    );

    // Позиция в листе после пересортировки взята из самого события.
    expect(
      page.events.find((entry) => entry.kind === 'ROUTE_ORDER_REORDERED')?.details,
    ).toContainEqual({ label: 'Новая позиция', value: '2' });

    // Ни получателя, ни телефона, ни комментария в ленте нет.
    const dump = JSON.stringify(page.events);
    expect(dump).not.toContain('Проверочный Получатель');
    expect(dump).not.toContain('+79990000000');
    expect(dump).not.toContain('Комментарий по доставке');

    // Шапка описывает текущее состояние, а не догадки.
    expect(page.header.number).not.toBe('');
    expect(page.header.route?.id).toBe(routeId);
    expect(page.header.courier?.id).toBe(courier.id);
    expect(page.header.returnObligation?.state).toBe('ACCEPTED');
    expect(page.header.delivery?.outcome).toBe('NOT_DELIVERED');
    // Коробка вернулась на склад и лежит на полке возврата: шапка показывает
    // ту полку, на которой она НА САМОМ ДЕЛЕ стоит сейчас.
    expect(page.header.cell?.kind).toBe('Хранение');
    expect(kinds.filter((value) => value === 'PLACEMENT_COURIER_RETURN')).toHaveLength(1);
  });

  it('отменённый результат и его отмена видны одновременно', async () => {
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
    const orderId = await seedOrder(unique('OH-CANCEL'));
    const routeId = await seedRoute(logist.id, courier.id);
    const participation = await ctx.db.routeOrder.create({
      data: { routeId, orderId, position: 1, addedById: logist.id, addedAt: at('09:00') },
      select: { id: true },
    });
    const attempt = await ctx.db.deliveryAttempt.create({
      data: {
        routeOrderId: participation.id,
        orderId,
        routeId,
        outcome: 'DELIVERED',
        courierUserId: courier.id,
        occurredAt: at('12:00'),
      },
      select: { id: true },
    });
    await ctx.db.deliveryAttemptCancellation.create({
      data: {
        attemptId: attempt.id,
        kind: 'MANAGER_CORRECTION',
        reason: 'Курьер ошибся адресом',
        actorUserId: logist.id,
        occurredAt: at('12:20'),
      },
    });

    const page = await readOrderTimeline(ctx.db, { orderId, limit: 200, cursor: null });
    const delivered = page.events.find((entry) => entry.kind === 'DELIVERY_DELIVERED');
    const cancelled = page.events.find(
      (entry) => entry.kind === 'DELIVERY_RESULT_CANCELLED_MANAGER_CORRECTION',
    );

    // Первоначальное событие НЕ исчезает: оно помечено как отменённое.
    expect(delivered).toBeDefined();
    expect(delivered?.reverted).toBe(true);
    expect(cancelled).toBeDefined();
    expect((cancelled?.occurredAt ?? '') > (delivered?.occurredAt ?? '')).toBe(true);
    // Результат отменён — шапка о доставке больше не сообщает.
    expect(page.header.delivery).toBe(null);
  });

  it('события двух заказов не смешиваются', async () => {
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const first = await seedOrder(unique('OH-A'));
    const second = await seedOrder(unique('OH-B'));

    for (const [orderId, marker] of [
      [first, 'первый'],
      [second, 'второй'],
    ] as const) {
      await ctx.db.orderAddressHistory.create({
        data: {
          orderId,
          action: 'LOCAL_ADDRESS_SET',
          occurredAt: at('07:00'),
          oldAddress: null,
          newAddress: `Москва, адрес ${marker}`,
          actorUserId: logist.id,
        },
      });
    }

    const page = await readOrderTimeline(ctx.db, { orderId: first, limit: 200, cursor: null });
    const dump = JSON.stringify(page.events);
    expect(dump).toContain('адрес первый');
    expect(dump).not.toContain('адрес второй');
  });

  it('московские сутки считает сервер, а порядок при равном времени устойчив', async () => {
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const orderId = await seedOrder(unique('OH-DAY'));

    // 21:30 UTC — это уже 00:30 следующего дня по Москве.
    await ctx.db.orderAddressHistory.create({
      data: {
        orderId,
        action: 'LOCAL_ADDRESS_SET',
        occurredAt: at('21:30'),
        newAddress: 'Москва, ночной адрес',
        actorUserId: logist.id,
      },
    });
    // Две строки с ОДИНАКОВЫМ временем: одна транзакция пишет их вместе.
    await ctx.db.auditLog.create({
      data: {
        action: 'ORDER_INTERVAL_SET',
        entityType: 'DeliveryOrder',
        entityId: orderId,
        actorUserId: logist.id,
        actorRoles: ['LOGISTICIAN'],
        occurredAt: at('08:00'),
        oldValue: { startMinute: null, endMinute: null },
        newValue: { startMinute: 600, endMinute: 720 },
      },
    });
    await ctx.db.deliveryOrderRevision.create({
      data: {
        orderId,
        externalUpdated: at('08:00'),
        receivedAt: at('08:00'),
        snapshot: {},
        snapshotHash: 'same',
        changedFields: ['address'],
        reason: 'EXTERNAL_UPDATE',
      },
    });

    const first = await readOrderTimeline(ctx.db, { orderId, limit: 200, cursor: null });
    const second = await readOrderTimeline(ctx.db, { orderId, limit: 200, cursor: null });

    expect(kindsOf(first.events)).toEqual(kindsOf(second.events));
    const night = first.events.find((entry) => entry.kind === 'ADDRESS_LOCAL_ADDRESS_SET');
    expect(night?.moscowDate).toBe('2028-10-13');
    const dayEvent = first.events.find((entry) => entry.kind === 'ORDER_INTERVAL_SET');
    expect(dayEvent?.moscowDate).toBe('2028-10-12');
  });

  it('страницы курсора не теряют и не повторяют строки', async () => {
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const orderId = await seedOrder(unique('OH-PAGE'));
    for (let index = 0; index < 7; index += 1) {
      await ctx.db.orderAddressHistory.create({
        data: {
          orderId,
          action: 'LOCAL_ADDRESS_SET',
          occurredAt: at(`0${index + 1}:00`),
          newAddress: `Москва, адрес ${index}`,
          actorUserId: logist.id,
        },
      });
    }

    const whole = await readOrderTimeline(ctx.db, { orderId, limit: 200, cursor: null });
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: Awaited<ReturnType<typeof readOrderTimeline>> = await readOrderTimeline(ctx.db, {
        orderId,
        limit: 3,
        cursor,
      });
      collected.push(...page.events.map((entry) => entry.key));
      cursor = page.nextCursor;
      if (cursor === null) {
        break;
      }
    }

    expect(collected).toEqual(whole.events.map((entry) => entry.key));
    expect(new Set(collected).size).toBe(collected.length);
    expect(whole.total).toBe(collected.length);
  });
});

describe('права и границы входа', () => {
  async function tokenFor(roles: ('ADMIN' | 'LOGISTICIAN' | 'FLORIST')[]): Promise<string> {
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
    return session.accessToken;
  }

  it('логист читает историю, флорист получает 403, неизвестный заказ — 404', async () => {
    const orderId = await seedOrder(unique('OH-ACL'));

    const logistToken = await tokenFor(['LOGISTICIAN']);
    const allowed = await ctx.app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}/timeline`,
      headers: { authorization: `Bearer ${logistToken}` },
    });
    expect(allowed.statusCode).toBe(200);

    const floristToken = await tokenFor(['FLORIST']);
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}/timeline`,
      headers: { authorization: `Bearer ${floristToken}` },
    });
    expect(denied.statusCode).toBe(403);

    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}/timeline`,
    });
    expect(anonymous.statusCode).toBe(401);

    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/orders/00000000-0000-4000-8000-0000000000ff/timeline',
      headers: { authorization: `Bearer ${logistToken}` },
    });
    expect(missing.statusCode).toBe(404);
  });
});
