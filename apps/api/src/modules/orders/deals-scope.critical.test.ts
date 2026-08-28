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
import { TEST_SECRETS } from '../../platform/testing/secrets.js';
import { hashSecretCode } from '../auth/crypto.js';
import { login } from '../auth/service.js';
import { dealsCount, dealsIds, dealsWithoutPointCount } from './deals-scope.js';

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

// ---------------------------------------------------------------------------

/**
 * Что рабочее место читает о заказе.
 *
 * Проверяется ровно то, на что логист смотрит и по чему принимает решение:
 * готов ли заказ к отправке, есть ли у него точка и попадает ли он на карту.
 * Эти три факта раньше либо не отдавались вовсе, либо расходились с картой.
 */
describe('факты, по которым логист принимает решение', () => {
  async function logisticianToken(): Promise<string> {
    const pin = '4321';
    const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
    const user = await seedUser(ctx.db, { roles: ['LOGISTICIAN'], pinHash });
    const session = await login(
      ctx,
      { phone: user.phone, pin },
      { ip: null, userAgent: 'vitest', deviceLabel: null },
    );
    return session.accessToken;
  }

  async function get<T>(url: string): Promise<T> {
    const token = await logisticianToken();
    const response = await ctx.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as T;
  }

  const DECISION_DAY = '2027-09-19';
  const dayScope = { deliveryDate: DECISION_DAY };
  const dayQuery = `deliveryDate=${DECISION_DAY}`;

  it('готовность к отправке видна из обоих источников', async () => {
    // Флорист завершил сборку.
    const byFlorist = await seedRoutable({
      deliveryPlannedMoment: `${DECISION_DAY} 12:00:00.000`,
    });
    const florist = await seedUser(ctx.db, { roles: ['FLORIST'] });
    const revision = await ctx.db.orderFulfillmentRevision.create({
      data: {
        orderId: byFlorist,
        externalUpdated: new Date(),
        snapshot: {},
        snapshotHash: `hash-${process.hrtime.bigint() % 1_000_000n}`,
        changedFields: [],
        reason: 'INITIAL_IMPORT',
      },
      select: { id: true },
    });
    // Завершённая сборка называет и время, и исполнителя, и снимок состава:
    // неполная строка запрещена ограничением базы.
    await ctx.db.deliveryOrder.update({
      where: { id: byFlorist },
      data: {
        fulfillmentProcessState: 'ASSEMBLED',
        fulfillmentAssigneeId: florist.id,
        fulfillmentAssignedAt: new Date(),
        fulfillmentAssembledAt: new Date(),
        fulfillmentAssembledById: florist.id,
        fulfillmentAssembledRevisionId: revision.id,
      },
    });

    // Заказ уже лежит в складской ячейке. Для логиста это тот же факт
    // готовности: путь, которым она наступила, ему безразличен.
    const byPlacement = await seedRoutable({
      deliveryPlannedMoment: `${DECISION_DAY} 12:00:00.000`,
    });
    const keeper = await seedUser(ctx.db, { roles: ['WAREHOUSE'] });
    const code = `B01-${process.hrtime.bigint() % 1_000_000n}`;
    const cell = await ctx.db.storageCell.create({
      data: {
        code,
        normalizedCode: code.toUpperCase(),
        kind: 'STORAGE',
        createdById: keeper.id,
      },
      select: { id: true },
    });
    await ctx.db.orderPlacement.create({
      data: {
        orderId: byPlacement,
        cellId: cell.id,
        source: 'RECEIVED',
        placedById: keeper.id,
      },
    });

    const plain = await seedRoutable({ deliveryPlannedMoment: `${DECISION_DAY} 12:00:00.000` });

    const list = await get<{ items: { id: string; assembled: boolean }[] }>(
      `/api/deals?${dayQuery}&limit=100&offset=0`,
    );
    const assembledIn = (id: string): boolean =>
      list.items.find((item) => item.id === id)?.assembled === true;

    expect(assembledIn(byFlorist)).toBe(true);
    expect(assembledIn(byPlacement)).toBe(true);
    expect(assembledIn(plain)).toBe(false);

    // На карте тот же признак: отметка собранного заказа несёт галочку.
    const map = await get<{ points: { orderId: string; assembled: boolean }[] }>(
      `/api/deals/map?${dayQuery}`,
    );
    expect(map.points.find((point) => point.orderId === byPlacement)?.assembled).toBe(true);
  });

  it('заказ без точки посчитан отдельно и на карту не попадает', async () => {
    const withPoint = await seedRoutable({
      deliveryPlannedMoment: `${DECISION_DAY} 12:00:00.000`,
    });
    const withoutPoint = await seedRoutable({
      deliveryPlannedMoment: `${DECISION_DAY} 12:00:00.000`,
    });
    await ctx.db.deliveryOrder.update({
      where: { id: withoutPoint },
      // Признаки решённой геокодировки снимаются вместе: неполная строка
      // запрещена ограничением `DeliveryOrder_geo_resolved_complete`.
      data: {
        geoState: 'PENDING',
        geoLatMicro: null,
        geoLonMicro: null,
        geoSource: null,
        geoPrecision: null,
        geoResolvedAt: null,
      },
    });

    // Счётчик называет оба числа: иначе разница между списком и картой
    // выглядит как потеря заказов.
    expect(await dealsWithoutPointCount(ctx.db, dayScope)).toBeGreaterThanOrEqual(1);
    const list = await get<{ total: number; withoutPoint: number }>(
      `/api/deals?${dayQuery}&limit=100&offset=0`,
    );
    expect(list.withoutPoint).toBeGreaterThanOrEqual(1);
    expect(list.total).toBeGreaterThan(list.withoutPoint);

    const map = await get<{ points: { orderId: string }[] }>(`/api/deals/map?${dayQuery}`);
    const ids = map.points.map((point) => point.orderId);
    expect(ids).toContain(withPoint);
    expect(ids).not.toContain(withoutPoint);
  });

  it('заказ «Требует внимания» на карте не показывается вовсе', async () => {
    // Маркер заказа с нераспознанным интервалом выглядел бы готовым
    // к маршрутизации, хотя везти его нельзя.
    const attention = await seedRoutable({
      deliveryPlannedMoment: `${DECISION_DAY} 12:00:00.000`,
    });
    await ctx.db.deliveryOrder.update({
      where: { id: attention },
      data: { needsAttention: true, attentionReasons: ['UNRECOGNIZED_INTERVAL'] },
    });

    const list = await get<{ items: { id: string; attentionReasons: string[] }[] }>(
      `/api/deals?${dayQuery}&limit=100&offset=0`,
    );
    // В списке он остаётся, назван причиной и чинится именно там.
    expect(list.items.find((item) => item.id === attention)?.attentionReasons).toEqual([
      'UNRECOGNIZED_INTERVAL',
    ]);

    const map = await get<{ points: { orderId: string }[] }>(`/api/deals/map?${dayQuery}`);
    expect(map.points.map((point) => point.orderId)).not.toContain(attention);
  });

  it('точка сама говорит, можно ли выбрать заказ', async () => {
    // Без этого признака карта могла выбрать только тот заказ, чья карточка
    // уже загружена: отметка заказа за «Загрузить ещё» не выбиралась вовсе.
    const free = await seedRoutable({ deliveryPlannedMoment: `${DECISION_DAY} 12:00:00.000` });

    const map = await get<{ points: { orderId: string; selectable: boolean; address: string }[] }>(
      `/api/deals/map?${dayQuery}`,
    );
    const point = map.points.find((item) => item.orderId === free);
    expect(point?.selectable).toBe(true);
    // Адрес нужен подсказке при наведении: без него отметку не опознать.
    expect(point?.address).toBe(ADDRESS);
  });
});

// ---------------------------------------------------------------------------

/**
 * Порядок отбора.
 *
 * Защищаемое свойство: заказы, которые нельзя везти, стоят выше во ВСЁМ
 * результате, а не внутри уже загруженной страницы. Иначе логист разбирал бы
 * проблемные заказы по мере прокрутки и часть из них не увидел бы вовсе.
 */
describe('«Требует внимания» идёт первым во всём отборе', () => {
  const SORT_DAY = '2027-09-27';
  const sortScope = { deliveryDate: SORT_DAY };

  it('проблемный заказ впереди пригодного даже с более поздним интервалом', async () => {
    const early = await seedRoutable({
      deliveryPlannedMoment: `${SORT_DAY} 12:00:00.000`,
      attributes: [
        {
          id: IDS.deliveryMethodAttribute,
          value: {
            name: 'Доставка',
            meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
          },
        },
        { id: IDS.intervalAttribute, value: 'с 08:00 по 10:00' },
        { id: IDS.recipientAttribute, value: 'Получатель Синтетический' },
      ],
    });
    const late = await seedRoutable({ deliveryPlannedMoment: `${SORT_DAY} 12:00:00.000` });
    await ctx.db.deliveryOrder.update({
      where: { id: late },
      data: { needsAttention: true, attentionReasons: ['UNRECOGNIZED_INTERVAL'] },
    });

    const ids = await dealsIds(ctx.db, sortScope);
    expect(ids.indexOf(late)).toBeLessThan(ids.indexOf(early));
  });

  it('заказ без точки поднимается наверх так же, как названный сервером', async () => {
    // Для логиста это одно состояние «этот заказ нельзя везти».
    const noPoint = await seedRoutable({ deliveryPlannedMoment: `${SORT_DAY} 12:00:00.000` });
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

    const ids = await dealsIds(ctx.db, sortScope);
    const routable = await dealsIds(ctx.db, { ...sortScope, group: 'ROUTABLE' });
    const firstRoutable = ids.findIndex((id) => routable.includes(id));

    expect(ids.indexOf(noPoint)).toBeLessThan(firstRoutable);
  });

  it('порядок держится на первой странице, а не внутри загруженной', async () => {
    // Собственный день: соседние проверки этого файла оставляют свои проблемные
    // заказы, и первая страница общего дня доказывала бы не то, что заявлено.
    const PAGE_DAY = '2027-09-28';
    const attention = await seedRoutable({ deliveryPlannedMoment: `${PAGE_DAY} 12:00:00.000` });
    await ctx.db.deliveryOrder.update({
      where: { id: attention },
      data: { needsAttention: true, attentionReasons: ['MISSING_RECIPIENT'] },
    });
    for (let index = 0; index < 3; index += 1) {
      await seedRoutable({ deliveryPlannedMoment: `${PAGE_DAY} 12:00:00.000` });
    }

    // Проблемный заказ обязан попасть на первую страницу независимо от того,
    // сколько пригодных заказов в дне и каким по счёту он создан.
    const firstPage = await dealsIds(ctx.db, { deliveryDate: PAGE_DAY }, { limit: 2, offset: 0 });
    expect(firstPage[0]).toBe(attention);
  });
});

describe('статус «Принят, Не оплачен»', () => {
  const HOLD_DAY = '2027-10-05';

  it('заказ в статусе «Принят, Не оплачен» в «Сделки» не попадает, а после смены статуса появляется', async () => {
    // Заказ полностью пригоден (в области, с точкой, без внимания) — скрывает
    // его ровно статус источника, а не что-то ещё.
    const held = await seedRoutable({
      deliveryPlannedMoment: `${HOLD_DAY} 12:00:00.000`,
      state: { meta: { href: href('state', IDS.states.acceptedUnpaid) } },
    });
    expect(await dealsIds(ctx.db, { deliveryDate: HOLD_DAY })).not.toContain(held);

    // Статус в источнике стал допустимым — заказ обязан появиться в «Сделках».
    await ctx.db.deliveryOrder.update({
      where: { id: held },
      data: { externalStateId: IDS.states.delivering },
    });
    expect(await dealsIds(ctx.db, { deliveryDate: HOLD_DAY })).toContain(held);
  });

  it('заказ без известного статуса из «Сделок» не пропадает', async () => {
    const unknown = await seedRoutable({
      deliveryPlannedMoment: `${HOLD_DAY} 12:00:00.000`,
      state: undefined,
    });
    await ctx.db.deliveryOrder.update({
      where: { id: unknown },
      data: { externalStateId: null },
    });
    expect(await dealsIds(ctx.db, { deliveryDate: HOLD_DAY })).toContain(unknown);
  });
});
