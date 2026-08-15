/**
 * Критические проверки отбора «Сделок».
 *
 * Здесь проверяется единственное обещание, на котором держится экран: список,
 * карта и «выбрать все» видят ОДНО множество. Разойдись они — логист отправил
 * бы в расчёт не то, что видел, и узнал бы об этом уже на маршруте.
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
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { dealsCount, dealsIds } from './deals-scope.js';

let ctx: TestContext;
const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;

/** Отдельный день на файл: база общая, и чужие заказы не должны мешать. */
const DAY = '2027-09-11';
const OTHER_DAY = '2027-09-12';
const ADDRESS = 'Москва, синтетическая улица, дом 1';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    name: `DL-${process.hrtime.bigint() % 1_000_000n}`,
    updated: '2026-08-13 10:00:00.000',
    shipmentAddress: ADDRESS,
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
  };
}

function snapshotOf(overrides: Record<string, unknown> = {}): OrderSnapshot {
  return mapOrder(source(overrides) as never, IDS).snapshot;
}

/** Пригодный заказ: в области, с точкой и без внимания. */
async function seedRoutable(overrides: Record<string, unknown> = {}): Promise<string> {
  const snapshot = snapshotOf(overrides);
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

const scope = { deliveryDate: DAY };

// ---------------------------------------------------------------------------

describe('день и область', () => {
  it('в отбор попадают только заказы выбранного московского дня', async () => {
    const today = await seedRoutable();
    await seedRoutable({ deliveryPlannedMoment: `${OTHER_DAY} 12:00:00.000` });

    const ids = await dealsIds(ctx.db, scope);
    expect(ids).toContain(today);
    const otherDay = await dealsIds(ctx.db, { deliveryDate: OTHER_DAY });
    expect(otherDay).not.toContain(today);
  });

  it('архивные и пропавшие в рабочую область не входят', async () => {
    const archived = await seedRoutable();
    await ctx.db.deliveryOrder.update({
      where: { id: archived },
      data: { sourceArchived: true },
    });
    const missing = await seedRoutable();
    await ctx.db.deliveryOrder.update({ where: { id: missing }, data: { sourceMissing: true } });

    const ids = await dealsIds(ctx.db, scope);
    expect(ids).not.toContain(archived);
    expect(ids).not.toContain(missing);
  });
});

/**
 * Номер маршрута для фикстуры.
 *
 * Приложение выдаёт номера счётчиком дня и всегда цифрами: `formatRouteNumber`
 * даёт `R-<день>-001`, `-002` и так далее. Фикстура берёт ту же форму, но
 * с буквой — пересечься с настоящим номером она не может по построению.
 *
 * Счётчик, а не `hrtime % N`. Прежний вариант выбирал одно из девятисот
 * значений на фиксированный день, а номера маршрутов переживают прогон
 * в общей тестовой базе: совпадение было делом времени и роняло чужой файл
 * при исправном коде. Уникальный индекс при этом не ослаблен — разведены
 * только пространства номеров.
 */
let routeFixtureCounter = 0;
function testRouteNumber(day: string): string {
  routeFixtureCounter += 1;
  return `R-${day}-T${String(routeFixtureCounter).padStart(3, '0')}`;
}

describe('участие в маршрутах', () => {
  async function seedRoute(state: 'DRAFT' | 'CONFIRMED', orderId: string): Promise<void> {
    const user = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const route = await ctx.db.deliveryRoute.create({
      data: {
        number: testRouteNumber(DAY),
        deliveryDate: toDateColumn(DAY),
        state,
        vehicleType: 'CAR',
        createdById: user.id,
      },
      select: { id: true },
    });
    await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId, position: 1, addedById: user.id },
    });
  }

  it('подтверждённый маршрут выводит заказ из сделок совсем', async () => {
    const confirmed = await seedRoutable();
    await seedRoute('CONFIRMED', confirmed);

    expect(await dealsIds(ctx.db, scope)).not.toContain(confirmed);
    // Даже с переключателем черновиков: его состав уже решён.
    expect(await dealsIds(ctx.db, { ...scope, includeDrafts: true })).not.toContain(confirmed);
  });

  it('заказ черновика виден только по переключателю и выбрать его нельзя', async () => {
    const drafted = await seedRoutable();
    await seedRoute('DRAFT', drafted);

    expect(await dealsIds(ctx.db, scope)).not.toContain(drafted);
    expect(await dealsIds(ctx.db, { ...scope, includeDrafts: true })).toContain(drafted);
    // «Выбрать все» берёт только пригодные и черновики не включает никогда.
    const selectable = await dealsIds(ctx.db, {
      ...scope,
      includeDrafts: false,
      group: 'ROUTABLE',
    });
    expect(selectable).not.toContain(drafted);
  });
});

describe('группы и выбор', () => {
  it('«Требует внимания» отделено и в выбор не попадает', async () => {
    const attention = await seedRoutable();
    await ctx.db.deliveryOrder.update({
      where: { id: attention },
      data: { needsAttention: true, attentionReasons: ['MISSING_INTERVAL'] },
    });

    expect(await dealsIds(ctx.db, { ...scope, group: 'ATTENTION' })).toContain(attention);
    expect(await dealsIds(ctx.db, { ...scope, group: 'ROUTABLE' })).not.toContain(attention);
  });

  it('заказ без подтверждённой точки выбрать нельзя', async () => {
    const noPoint = await seedRoutable();
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

    expect(await dealsIds(ctx.db, { ...scope, group: 'ROUTABLE' })).not.toContain(noPoint);
  });
});

describe('поиск и время действуют на то же множество', () => {
  it('поиск идёт по номеру, адресам, получателю и комментарию', async () => {
    const marker = `SRCH${process.hrtime.bigint() % 100_000n}`;
    const byComment = await seedRoutable({ description: null });
    await ctx.db.deliveryOrder.update({
      where: { id: byComment },
      data: { comment: `комментарий ${marker}` },
    });
    const byLocal = await seedRoutable();
    await ctx.db.deliveryOrder.update({
      where: { id: byLocal },
      data: {
        localAddress: `Москва, ${marker}, дом 7`,
        localAddressSetAt: new Date(),
        localAddressSetById: (await seedUser(ctx.db, { roles: ['LOGISTICIAN'] })).id,
        sourceAddressAtLocalEdit: ADDRESS,
      },
    });

    const found = await dealsIds(ctx.db, { ...scope, search: marker });
    expect(found).toContain(byComment);
    expect(found).toContain(byLocal);
  });

  it('фильтр времени считает по эффективному интервалу', async () => {
    const manual = await seedRoutable();
    await ctx.db.deliveryOrder.update({
      where: { id: manual },
      data: {
        manualIntervalStartMinute: 18 * 60,
        manualIntervalEndMinute: 20 * 60,
        manualIntervalSetAt: new Date(),
      },
    });

    // Исходный интервал 10:00–14:00, ручной 18:00–20:00. Окно вечера обязано
    // видеть заказ по ручному значению, а не по исходному.
    const evening = await dealsIds(ctx.db, { ...scope, fromMinute: 17 * 60, toMinute: 21 * 60 });
    expect(evening).toContain(manual);

    const morning = await dealsIds(ctx.db, { ...scope, fromMinute: 8 * 60, toMinute: 11 * 60 });
    expect(morning).not.toContain(manual);
  });
});

describe('страницы и порядок', () => {
  it('страницы не пересекаются и покрывают весь отбор', async () => {
    const day = '2027-09-13';
    for (let index = 0; index < 5; index += 1) {
      await seedRoutable({ deliveryPlannedMoment: `${day} 12:00:00.000` });
    }

    const all = await dealsIds(ctx.db, { deliveryDate: day });
    const total = await dealsCount(ctx.db, { deliveryDate: day });
    expect(all).toHaveLength(total);

    const first = await dealsIds(ctx.db, { deliveryDate: day }, { limit: 2, offset: 0 });
    const second = await dealsIds(ctx.db, { deliveryDate: day }, { limit: 2, offset: 2 });
    const third = await dealsIds(ctx.db, { deliveryDate: day }, { limit: 2, offset: 4 });

    expect(new Set([...first, ...second, ...third]).size).toBe(total);
    expect(first.filter((id) => second.includes(id))).toHaveLength(0);
    // Порядок устойчив: повтор того же запроса даёт тот же результат.
    expect(await dealsIds(ctx.db, { deliveryDate: day }, { limit: 2, offset: 0 })).toEqual(first);
  });
});
