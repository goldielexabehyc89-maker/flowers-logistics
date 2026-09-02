/**
 * Приоритет ближайших самовывозов в очереди флориста.
 *
 * Проверяется не «есть ли группа на экране», а то, нарушение чего стоит
 * пропущенного заказа:
 *
 *  * граница ровно в час — строгая: за 59:59 заказ уже в группе, ровно за час
 *    ещё нет. Полчаса разницы здесь — это покупатель, ушедший без букета;
 *  * наступившее начало из группы не выводит: просроченный самовывоз ждёт
 *    человека у прилавка прямо сейчас;
 *  * сравнение идёт по абсолютному моменту, а не по минутам внутри дня:
 *    заказ на 00:30 обязан подняться в 23:31 накануне, когда календарный день
 *    ещё вчерашний;
 *  * в группу не попадает ничто, кроме активного самовывоза с распознанным
 *    началом: курьерская доставка, отмена и завершённая сборка исключены;
 *  * ручной интервал логиста перекрывает импортированный — приоритет считается
 *    по тому времени, о котором договорились с клиентом;
 *  * порядок групп: самовывозы, затем маршрутные листы, затем всё остальное,
 *    и заказ ровно в одной группе.
 *
 * Порядок проверяется чистой функцией, а принадлежность к группе — через базу:
 * правило «что попало в выборку» держится не сортировкой, а условием запроса,
 * и доказывать его на выдуманных массивах бессмысленно.
 *
 * ВЛАДЕНИЕ ДАТАМИ: файл забронировал сентябрь 2028 года
 * (`platform/testing/test-days.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { snapshotHash, type FulfillmentSnapshot } from './composition.js';
import { readQueue } from './queue-service.js';
import { PICKUP_SOON_WINDOW_MINUTES, isPickupSoon, sortQueue, type QueueOrder } from './queue.js';

/** Забронированный день и следующий за ним. */
const DAY = '2028-09-15';
const NEXT_DAY = '2028-09-16';

/** 11:01 Москвы: до 12:00 остаётся пятьдесят девять минут. */
const NOW = new Date('2028-09-15T08:01:00.000Z');
/** 23:31 Москвы того же дня: до 00:30 следующего — двадцать девять минут. */
const NIGHT = new Date('2028-09-15T20:31:00.000Z');

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let sequence = 0;
function uniqueNumber(tag: string): string {
  sequence += 1;
  return `PSN-${tag}-${process.hrtime.bigint() % 1_000_000n}-${sequence}`;
}

interface SeedOptions {
  tag: string;
  day?: string;
  startMinute?: number | null;
  endMinute?: number | null;
  manualStartMinute?: number | null;
  manualEndMinute?: number | null;
  /** Способ получения. По умолчанию самовывоз: файл о нём. */
  pickup?: boolean;
  cancelled?: boolean;
  state?: 'NEW' | 'IN_ASSEMBLY';
  /** Кем собран. Задан — заказ переводится в «Собран» со всеми следами. */
  assembledById?: string;
  /** Общий префикс поиска: выборка теста не должна цеплять чужие заказы. */
  search: string;
}

/**
 * Заказ производственной области с подтверждённым составом.
 *
 * Состав минимальный: очередь читает только его состояние, а карточку этот
 * файл не открывает.
 */
async function seedOrder(options: SeedOptions): Promise<{ id: string; number: string }> {
  const number = `${options.search}-${uniqueNumber(options.tag)}`;
  const composition: FulfillmentSnapshot = {
    externalId: crypto.randomUUID(),
    description: null,
    cardText: null,
    positions: [
      {
        externalPositionId: crypto.randomUUID(),
        ordinal: 0,
        assortmentId: crypto.randomUUID(),
        assortmentKind: 'PRODUCT',
        assortmentKindRaw: 'product',
        name: 'Букет проверочный',
        quantity: '1',
        uomId: null,
        uomName: null,
        characteristicLabel: null,
        components: [],
      },
    ],
  };

  const start = options.startMinute === undefined ? 720 : options.startMinute;
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: composition.externalId,
      externalName: number,
      externalUpdated: new Date('2028-09-01T00:00:00.000Z'),
      deliveryDate: toDateColumn(options.day ?? DAY),
      intervalKind: start === null ? 'MISSING' : 'RANGE',
      intervalStartMinute: start,
      intervalEndMinute: options.endMinute === undefined ? 840 : options.endMinute,
      manualIntervalStartMinute: options.manualStartMinute ?? null,
      manualIntervalEndMinute: options.manualEndMinute ?? null,
      // База требует ручной интервал целиком: половинчатый выглядит как
      // заданное время и уходит в планирование (`manual_interval_complete`).
      manualIntervalSetAt: options.manualStartMinute === undefined ? null : new Date(),
      // Самовывоз опознаётся ТОЛЬКО точным справочником, а не текстом.
      deliveryMethodId:
        options.pickup === false
          ? MOYSKLAD_IDS.deliveryMethodDelivery
          : MOYSKLAD_IDS.deliveryMethodPickup,
      address: options.pickup === false ? 'Москва, проверочный адрес 7' : null,
      recipient: 'Проверочный Получатель',
      cancelledInSource: options.cancelled === true,
      // Отмена в источнике неотделима от своей отметки времени
      // (`source_cancel_complete`): признак без даты базой не принимается.
      cancelledInSourceAt: options.cancelled === true ? new Date() : null,
      inScope: false,
      fulfillmentInScope: true,
      fulfillmentProcessState: options.state ?? 'NEW',
      fulfillmentDescription: composition.description,
      fulfillmentCardText: composition.cardText,
      fulfillmentSnapshotHash: snapshotHash(composition),
      fulfillmentCompositionState: 'READY',
      fulfillmentCompositionSyncedAt: new Date(),
      fulfillmentPositions: {
        create: composition.positions.map((position) => ({
          externalPositionId: position.externalPositionId,
          ordinal: position.ordinal,
          assortmentId: position.assortmentId,
          assortmentKind: position.assortmentKind,
          assortmentKindRaw: position.assortmentKindRaw,
          name: position.name,
          quantity: position.quantity,
          characteristicLabel: position.characteristicLabel,
        })),
      },
      fulfillmentRevisions: {
        create: {
          externalUpdated: new Date('2028-09-01T00:00:00.000Z'),
          snapshot: composition as never,
          snapshotHash: snapshotHash(composition),
          changedFields: ['externalId', 'positions'],
          reason: 'INITIAL_IMPORT',
        },
      },
    },
    select: { id: true, externalName: true },
  });

  /*
   * Собранный заказ создаётся вторым шагом.
   *
   * База требует у «Собран» полный след: кто, когда и по какой ревизии
   * (`fulfillment_assembled_is_complete`). Ревизия появляется только вместе
   * с самим заказом, поэтому раньше её идентификатора нет.
   */
  if (options.assembledById !== undefined) {
    const revision = await ctx.db.orderFulfillmentRevision.findFirstOrThrow({
      where: { orderId: order.id },
      select: { id: true },
    });
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: {
        fulfillmentProcessState: 'ASSEMBLED',
        fulfillmentAssigneeId: options.assembledById,
        fulfillmentAssignedAt: new Date(),
        fulfillmentAssembledAt: new Date(),
        fulfillmentAssembledById: options.assembledById,
        fulfillmentAssembledRevisionId: revision.id,
      },
    });
  }

  return { id: order.id, number: order.externalName };
}

async function floristId(): Promise<string> {
  const user = await seedUser(ctx.db, { roles: ['FLORIST'] });
  return user.id;
}

/** Очередь «Сегодня» по своему префиксу поиска и на заданный момент. */
async function queueAt(search: string, now: Date, userId: string) {
  return readQueue(
    ctx.db,
    { userId },
    { day: 'today', scope: 'general', includeAssigned: true, search },
    now,
  );
}

let searchSequence = 0;
function searchTag(): string {
  searchSequence += 1;
  return `PS${searchSequence}X${process.hrtime.bigint() % 100_000n}`;
}

describe('порог «меньше часа»', () => {
  it('за 59 минут 59 секунд заказ уже в группе, ровно за час — ещё нет', () => {
    const base = { pickup: true, cancelled: false, deliveryDate: DAY, startMinute: 720 };
    // 12:00 московского дня минус 59:59 и минус ровно час.
    const almost = new Date('2028-09-15T08:00:01.000Z');
    const exactly = new Date('2028-09-15T08:00:00.000Z');

    expect(isPickupSoon(base, almost)).toBe(true);
    expect(isPickupSoon(base, exactly)).toBe(false);
    // Условие строгое: граница принадлежит «ещё не скоро».
    expect(PICKUP_SOON_WINDOW_MINUTES).toBe(60);
  });

  it('больше часа — не в группе, наступившее начало — остаётся в группе', () => {
    const base = { pickup: true, cancelled: false, deliveryDate: DAY, startMinute: 720 };
    expect(isPickupSoon(base, new Date('2028-09-15T07:00:00.000Z'))).toBe(false);
    // 12:30 Москвы: начало прошло полчаса назад, заказ ещё активен.
    expect(isPickupSoon(base, new Date('2028-09-15T09:30:00.000Z'))).toBe(true);
  });

  it('переход через полночь считается по абсолютному моменту', () => {
    // 00:30 следующего дня против 23:31 текущего — двадцать девять минут.
    const night = { pickup: true, cancelled: false, deliveryDate: NEXT_DAY, startMinute: 30 };
    expect(isPickupSoon(night, NIGHT)).toBe(true);
    // За два часа до полуночи тот же заказ ещё не ближайший.
    expect(isPickupSoon(night, new Date('2028-09-15T19:00:00.000Z'))).toBe(false);
  });

  it('курьерская доставка, отмена и неизвестный интервал в группу не попадают', () => {
    const soon = { deliveryDate: DAY, startMinute: 720 };
    expect(isPickupSoon({ ...soon, pickup: false, cancelled: false }, NOW)).toBe(false);
    expect(isPickupSoon({ ...soon, pickup: true, cancelled: true }, NOW)).toBe(false);
    expect(
      isPickupSoon({ pickup: true, cancelled: false, deliveryDate: DAY, startMinute: null }, NOW),
    ).toBe(false);
    expect(
      isPickupSoon({ pickup: true, cancelled: false, deliveryDate: null, startMinute: 720 }, NOW),
    ).toBe(false);
  });
});

describe('порядок очереди', () => {
  const context = { viewDate: DAY, todayMoscow: DAY, nowMinuteMoscow: 661 };

  function order(input: Partial<QueueOrder> & { id: string }): QueueOrder {
    return {
      externalName: input.id,
      deliveryDate: DAY,
      startMinute: 720,
      endMinute: 840,
      route: null,
      routePosition: null,
      pickupSoon: false,
      ...input,
    };
  }

  it('самовывозы сверху, затем маршруты, затем остальные заказы', () => {
    const route = { id: 'r1', number: 'МЛ-1', deliveryDate: DAY, firstStopMinute: 600 };
    const later = { id: 'r2', number: 'МЛ-2', deliveryDate: DAY, firstStopMinute: 900 };

    const sorted = sortQueue(
      [
        order({ id: 'plain', startMinute: 700 }),
        order({ id: 'late-route', route: later, routePosition: 1 }),
        order({ id: 'early-route', route, routePosition: 1 }),
        order({ id: 'pickup-late', startMinute: 740, pickupSoon: true }),
        order({ id: 'pickup-early', startMinute: 700, pickupSoon: true }),
      ],
      context,
    );

    expect(sorted.map((entry) => entry.id)).toEqual([
      // Внутри группы — самый ранний сверху.
      'pickup-early',
      'pickup-late',
      // Маршруты по времени первой остановки.
      'early-route',
      'late-route',
      // Всё остальное — прежним порядком.
      'plain',
    ]);
  });

  it('самовывоз в группе не уступает даже своему маршруту, а порядок устойчив', () => {
    const route = { id: 'r1', number: 'МЛ-1', deliveryDate: DAY, firstStopMinute: 540 };
    const sorted = sortQueue(
      [
        order({ id: 'in-route', route, routePosition: 1 }),
        order({ id: 'pickup', pickupSoon: true, route, routePosition: 2 }),
      ],
      context,
    );
    expect(sorted[0]?.id).toBe('pickup');

    // Одинаковое время — устойчивый добор по номеру заказа.
    const tie = sortQueue(
      [
        order({ id: 'b', externalName: 'Б-2', pickupSoon: true }),
        order({ id: 'a', externalName: 'А-1', pickupSoon: true }),
      ],
      context,
    );
    expect(tie.map((entry) => entry.externalName)).toEqual(['А-1', 'Б-2']);
  });

  it('ближайший завтрашний самовывоз стоит выше сегодняшнего позднего', () => {
    const sorted = sortQueue(
      [
        order({ id: 'tomorrow', deliveryDate: NEXT_DAY, startMinute: 30, pickupSoon: true }),
        order({ id: 'today', deliveryDate: DAY, startMinute: 1400, pickupSoon: true }),
      ],
      { viewDate: DAY, todayMoscow: DAY, nowMinuteMoscow: 1411 },
    );
    expect(sorted.map((entry) => entry.id)).toEqual(['today', 'tomorrow']);
  });
});

describe('группа в ответе сервера', () => {
  it('в группе — только ближайший активный самовывоз', async () => {
    const userId = await floristId();
    const search = searchTag();

    const soon = await seedOrder({ tag: 'SOON', search, startMinute: 720 });
    const exactly = await seedOrder({ tag: 'EXACT', search, startMinute: 721 });
    const later = await seedOrder({ tag: 'LATE', search, startMinute: 780 });
    const passed = await seedOrder({ tag: 'PASS', search, startMinute: 600, endMinute: 660 });
    const courier = await seedOrder({ tag: 'CUR', search, startMinute: 720, pickup: false });
    const cancelled = await seedOrder({ tag: 'CAN', search, startMinute: 720, cancelled: true });
    const noTime = await seedOrder({
      tag: 'NOTIME',
      search,
      startMinute: null,
      endMinute: null,
    });
    const done = await seedOrder({
      tag: 'DONE',
      search,
      startMinute: 720,
      assembledById: userId,
    });

    const queue = await queueAt(search, NOW, userId);
    const inGroup = new Set(queue.items.filter((item) => item.pickupSoon).map((item) => item.id));

    expect(inGroup.has(soon.id)).toBe(true);
    // Начало уже наступило, заказ активен — из группы не выпадает.
    expect(inGroup.has(passed.id)).toBe(true);

    expect(inGroup.has(exactly.id)).toBe(false);
    expect(inGroup.has(later.id)).toBe(false);
    expect(inGroup.has(courier.id)).toBe(false);
    expect(inGroup.has(cancelled.id)).toBe(false);
    expect(inGroup.has(noTime.id)).toBe(false);

    // Отменённый («Отменён — не собирать») из очереди флориста ИСКЛЮЧЁН вовсе:
    // его не показывают ни как задание, ни как приоритет (CORE-…-MOYSKLAD-02 §1).
    expect(queue.items.map((item) => item.id)).not.toContain(cancelled.id);
    // Собранный в рабочую очередь не входит вовсе.
    expect(queue.items.map((item) => item.id)).not.toContain(done.id);

    // Группа идёт первой, и внутри неё самый ранний сверху.
    const ids = queue.items.map((item) => item.id);
    expect(ids.slice(0, 2)).toEqual([passed.id, soon.id]);
  });

  it('ручной интервал решает, а импортированный уступает', async () => {
    const userId = await floristId();
    const search = searchTag();

    // Импорт говорит «вечером», логист договорился на полдень.
    const corrected = await seedOrder({
      tag: 'MAN',
      search,
      startMinute: 1200,
      endMinute: 1260,
      manualStartMinute: 720,
      manualEndMinute: 780,
    });
    // И обратный случай: импорт на полдень, ручной перенос на вечер.
    const postponed = await seedOrder({
      tag: 'MOVED',
      search,
      startMinute: 720,
      endMinute: 780,
      manualStartMinute: 1200,
      manualEndMinute: 1260,
    });

    const queue = await queueAt(search, NOW, userId);
    const byId = new Map(queue.items.map((item) => [item.id, item]));
    expect(byId.get(corrected.id)?.pickupSoon).toBe(true);
    expect(byId.get(postponed.id)?.pickupSoon).toBe(false);
  });

  it('ночной самовывоз следующего дня появляется в «Сегодня» за полчаса до начала', async () => {
    const userId = await floristId();
    const search = searchTag();

    const night = await seedOrder({
      tag: 'NIGHT',
      search,
      day: NEXT_DAY,
      startMinute: 30,
      endMinute: 90,
    });
    // Завтрашний самовывоз, до которого ещё далеко, в сегодняшнем дне не нужен.
    const tomorrowLate = await seedOrder({
      tag: 'TMLATE',
      search,
      day: NEXT_DAY,
      startMinute: 720,
      endMinute: 780,
    });

    const early = await queueAt(search, new Date('2028-09-15T19:00:00.000Z'), userId);
    expect(early.items.map((item) => item.id)).not.toContain(night.id);

    const queue = await queueAt(search, NIGHT, userId);
    const ids = queue.items.map((item) => item.id);
    expect(ids).toContain(night.id);
    expect(ids).not.toContain(tomorrowLate.id);
    expect(queue.items.find((item) => item.id === night.id)?.pickupSoon).toBe(true);
    // Заказ показан один раз: он не может оказаться и в приоритете, и ниже.
    expect(ids.filter((id) => id === night.id)).toHaveLength(1);
  });
});
