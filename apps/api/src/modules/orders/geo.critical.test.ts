/**
 * Критические проверки геоданных заказа.
 *
 * Внешних обращений нет: снимки строятся mapper'ом, точку ставит человек через
 * API, карта настраивается пустой строкой конфигурации. Ни DaData, ни OSM,
 * ни МойСклад здесь не вызываются.
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
import { fromMicro, toMicro, MAX_LAT_MICRO } from './geo.js';

let ctx: TestContext;
const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;
const NOW = new Date('2026-08-10T09:00:00.000Z');

/** Синтетические координаты Москвы: настоящих адресов клиентов в тестах нет. */
const POINT = { lat: '55.751244', lon: '37.618423' };
const OTHER_POINT = { lat: '55.760000', lon: '37.600000' };

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    name: `G-${process.hrtime.bigint() % 1_000_000n}`,
    updated: '2026-08-10 10:00:00.000',
    shipmentAddress: 'Москва, синтетический адрес, 1',
    deliveryPlannedMoment: '2026-08-10 12:00:00.000',
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
      { id: IDS.recipientAttribute, value: 'Получатель Синтетический' },
    ],
    ...overrides,
  };
}

function snapshotOf(overrides: Record<string, unknown> = {}): OrderSnapshot {
  return mapOrder(source(overrides) as never, IDS).snapshot;
}

async function apply(snapshot: OrderSnapshot, at = NOW) {
  return ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, at));
}

async function seedOrder(overrides: Record<string, unknown> = {}) {
  const snapshot = snapshotOf(overrides);
  await apply(snapshot);
  return {
    snapshot,
    order: await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    }),
  };
}

async function tokenFor(roles: Parameters<typeof seedUser>[1]['roles']): Promise<string> {
  const { hashSecretCode } = await import('../auth/crypto.js');
  const { login } = await import('../auth/service.js');
  const pin = '1234';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles, status: 'ACTIVE', pinHash });
  const session = await login(
    ctx,
    { phone: user.phone, pin },
    { ip: null, userAgent: 'vitest', deviceLabel: null },
  );
  return session.accessToken;
}

/** JSON.stringify не умеет bigint, а в записях аудита встречаются суммы. */
function asText(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

function setPoint(
  token: string,
  orderId: string,
  body: Record<string, unknown>,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'PUT',
    url: `/api/orders/${orderId}/geo-point`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe('инварианты геоданных в базе', () => {
  it('координаты невозможны вне состояния RESOLVED', async () => {
    const { order } = await seedOrder();

    await expect(
      ctx.db.deliveryOrder.update({
        where: { id: order.id },
        data: { geoLatMicro: 55_751_244, geoLonMicro: 37_618_423 },
      }),
    ).rejects.toThrow();
  });

  it('RESOLVED без источника, точности и времени невозможен', async () => {
    const { order } = await seedOrder();

    await expect(
      ctx.db.deliveryOrder.update({
        where: { id: order.id },
        data: {
          geoState: 'RESOLVED',
          geoLatMicro: 55_751_244,
          geoLonMicro: 37_618_423,
        },
      }),
    ).rejects.toThrow();
  });

  it('половина координаты не проходит: широта без долготы отвергается', async () => {
    const { order } = await seedOrder();

    await expect(
      ctx.db.deliveryOrder.update({
        where: { id: order.id },
        data: {
          geoState: 'RESOLVED',
          geoSource: 'MANUAL',
          geoPrecision: 'EXACT_HOUSE',
          geoResolvedAt: NOW,
          geoLatMicro: 55_751_244,
        },
      }),
    ).rejects.toThrow();
  });

  it('координата за пределами планеты отвергается', async () => {
    const { order } = await seedOrder();

    await expect(
      ctx.db.deliveryOrder.update({
        where: { id: order.id },
        data: {
          geoState: 'RESOLVED',
          geoSource: 'MANUAL',
          geoPrecision: 'EXACT_HOUSE',
          geoResolvedAt: NOW,
          geoLatMicro: 95_000_000,
          geoLonMicro: 37_618_423,
        },
      }),
    ).rejects.toThrow();
  });

  it('NEEDS_REVIEW без причины невозможен', async () => {
    const { order } = await seedOrder();

    await expect(
      ctx.db.deliveryOrder.update({
        where: { id: order.id },
        data: { geoState: 'NEEDS_REVIEW' },
      }),
    ).rejects.toThrow();
  });

  it('история геоданных не редактируется и не удаляется', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const { order } = await seedOrder();

    const response = await setPoint(token, order.id, {
      ...POINT,
      reason: 'Клиент уточнил подъезд',
      expectedVersion: order.version,
    });
    expect(response.statusCode).toBe(200);

    const entry = await ctx.db.orderGeoHistory.findFirstOrThrow({ where: { orderId: order.id } });

    await expect(
      ctx.db.orderGeoHistory.update({ where: { id: entry.id }, data: { reason: 'подмена' } }),
    ).rejects.toThrow();
    await expect(ctx.db.orderGeoHistory.delete({ where: { id: entry.id } })).rejects.toThrow();
  });

  it('ручная запись истории без причины и автора невозможна', async () => {
    const { order } = await seedOrder();

    await expect(
      ctx.db.orderGeoHistory.create({
        data: {
          orderId: order.id,
          kind: 'MANUAL_SET',
          state: 'RESOLVED',
          source: 'MANUAL',
          precision: 'EXACT_HOUSE',
          latMicro: 55_751_244,
          lonMicro: 37_618_423,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('форма записи в неизменяемой истории', () => {
  /**
   * История геоданных не редактируется и не удаляется, поэтому неверная запись
   * останется в ней навсегда как ложное доказательство. Единственная защита —
   * запрет на её появление, и держит его база, а не код приложения.
   */
  async function seedActor(): Promise<string> {
    const { hashSecretCode } = await import('../auth/crypto.js');
    const pinHash = await hashSecretCode('1234', TEST_SECRETS.AUTH_PIN_PEPPER);
    const user = await seedUser(ctx.db, {
      roles: ['LOGISTICIAN'],
      status: 'ACTIVE',
      pinHash,
    });
    return user.id;
  }

  it('допустимая ручная запись создаётся', async () => {
    const { order } = await seedOrder();
    const actorUserId = await seedActor();

    const entry = await ctx.db.orderGeoHistory.create({
      data: {
        orderId: order.id,
        kind: 'MANUAL_SET',
        state: 'RESOLVED',
        source: 'MANUAL',
        precision: 'EXACT_HOUSE',
        latMicro: 55_751_244,
        lonMicro: 37_618_423,
        previousLatMicro: null,
        previousLonMicro: null,
        reason: 'Логист показал дом на карте',
        actorUserId,
      },
    });
    expect(entry.kind).toBe('MANUAL_SET');
  });

  it('допустимая запись об обесценивании создаётся', async () => {
    const { order } = await seedOrder();

    const entry = await ctx.db.orderGeoHistory.create({
      data: {
        orderId: order.id,
        kind: 'INVALIDATED_ADDRESS_CHANGED',
        state: 'NEEDS_REVIEW',
        reviewReason: 'ADDRESS_CHANGED',
        previousLatMicro: 55_751_244,
        previousLonMicro: 37_618_423,
      },
    });
    expect(entry.kind).toBe('INVALIDATED_ADDRESS_CHANGED');
  });

  const IMPOSSIBLE: { title: string; data: Record<string, unknown> }[] = [
    {
      title: 'ручная запись с точностью улицы',
      data: {
        kind: 'MANUAL_SET',
        state: 'RESOLVED',
        source: 'MANUAL',
        precision: 'STREET',
        latMicro: 55_751_244,
        lonMicro: 37_618_423,
        reason: 'Точность не соответствует ручной установке',
      },
    },
    {
      title: 'ручная запись с источником геокодера',
      data: {
        kind: 'MANUAL_SET',
        state: 'RESOLVED',
        source: 'DADATA',
        precision: 'EXACT_HOUSE',
        latMicro: 55_751_244,
        lonMicro: 37_618_423,
        reason: 'Источник не соответствует ручной установке',
      },
    },
    {
      title: 'ручная запись в состоянии проверки',
      data: {
        kind: 'MANUAL_SET',
        state: 'NEEDS_REVIEW',
        source: 'MANUAL',
        precision: 'EXACT_HOUSE',
        latMicro: 55_751_244,
        lonMicro: 37_618_423,
        reason: 'Состояние не соответствует ручной установке',
      },
    },
    {
      title: 'ручная запись с причиной проверки',
      data: {
        kind: 'MANUAL_SET',
        state: 'RESOLVED',
        source: 'MANUAL',
        precision: 'EXACT_HOUSE',
        latMicro: 55_751_244,
        lonMicro: 37_618_423,
        reviewReason: 'MANUAL_CHECK',
        reason: 'Проверку только что выполнил человек',
      },
    },
    {
      title: 'ручная запись без координат',
      data: {
        kind: 'MANUAL_SET',
        state: 'RESOLVED',
        source: 'MANUAL',
        precision: 'EXACT_HOUSE',
        reason: 'Ручная установка без точки бессмысленна',
      },
    },
    {
      title: 'ручная запись со слишком короткой причиной',
      data: {
        kind: 'MANUAL_SET',
        state: 'RESOLVED',
        source: 'MANUAL',
        precision: 'EXACT_HOUSE',
        latMicro: 55_751_244,
        lonMicro: 37_618_423,
        reason: 'ок',
      },
    },
    {
      title: 'обесценивание с новой точкой',
      data: {
        kind: 'INVALIDATED_ADDRESS_CHANGED',
        state: 'NEEDS_REVIEW',
        reviewReason: 'ADDRESS_CHANGED',
        latMicro: 55_751_244,
        lonMicro: 37_618_423,
        previousLatMicro: 55_760_000,
        previousLonMicro: 37_600_000,
      },
    },
    {
      title: 'обесценивание с источником',
      data: {
        kind: 'INVALIDATED_ADDRESS_CHANGED',
        state: 'NEEDS_REVIEW',
        reviewReason: 'ADDRESS_CHANGED',
        source: 'DADATA',
        previousLatMicro: 55_751_244,
        previousLonMicro: 37_618_423,
      },
    },
    {
      title: 'обесценивание с точностью',
      data: {
        kind: 'INVALIDATED_ADDRESS_CHANGED',
        state: 'NEEDS_REVIEW',
        reviewReason: 'ADDRESS_CHANGED',
        precision: 'STREET',
        previousLatMicro: 55_751_244,
        previousLonMicro: 37_618_423,
      },
    },
    {
      title: 'обесценивание без прежней точки',
      data: {
        kind: 'INVALIDATED_ADDRESS_CHANGED',
        state: 'NEEDS_REVIEW',
        reviewReason: 'ADDRESS_CHANGED',
      },
    },
    {
      title: 'обесценивание с половиной прежней точки',
      data: {
        kind: 'INVALIDATED_ADDRESS_CHANGED',
        state: 'NEEDS_REVIEW',
        reviewReason: 'ADDRESS_CHANGED',
        previousLatMicro: 55_751_244,
      },
    },
    {
      title: 'обесценивание в состоянии RESOLVED',
      data: {
        kind: 'INVALIDATED_ADDRESS_CHANGED',
        state: 'RESOLVED',
        reviewReason: 'ADDRESS_CHANGED',
        previousLatMicro: 55_751_244,
        previousLonMicro: 37_618_423,
      },
    },
    {
      title: 'обесценивание с чужой причиной проверки',
      data: {
        kind: 'INVALIDATED_ADDRESS_CHANGED',
        state: 'NEEDS_REVIEW',
        reviewReason: 'LOW_PRECISION',
        previousLatMicro: 55_751_244,
        previousLonMicro: 37_618_423,
      },
    },
  ];

  for (const testCase of IMPOSSIBLE) {
    it(`невозможно: ${testCase.title}`, async () => {
      const { order } = await seedOrder();
      const actorUserId = await seedActor();
      const base = testCase.data['kind'] === 'MANUAL_SET' ? { actorUserId } : {};

      await expect(
        ctx.db.orderGeoHistory.create({
          data: { orderId: order.id, ...base, ...testCase.data } as never,
        }),
      ).rejects.toThrow();
    });
  }

  it('ручная запись без автора невозможна', async () => {
    const { order } = await seedOrder();

    await expect(
      ctx.db.orderGeoHistory.create({
        data: {
          orderId: order.id,
          kind: 'MANUAL_SET',
          state: 'RESOLVED',
          source: 'MANUAL',
          precision: 'EXACT_HOUSE',
          latMicro: 55_751_244,
          lonMicro: 37_618_423,
          reason: 'Запись без автора не доказывает ничьего решения',
        },
      }),
    ).rejects.toThrow();
  });
});

describe('строгий разбор координаты', () => {
  /**
   * Значения, которые `Number()` принял бы молча.
   *
   * Пустая строка стала бы нулём — это точка в Гвинейском заливе; `0x10` —
   * шестнадцатью; `1e2` — сотней. Такая координата не выглядит как ошибка
   * и потому опаснее отказа.
   */
  const REJECTED: { title: string; lat: unknown; lon: unknown }[] = [
    { title: 'пустая строка', lat: '', lon: '37.618423' },
    { title: 'пробелы', lat: '   ', lon: '37.618423' },
    { title: 'шестнадцатеричная запись', lat: '0x10', lon: '37.618423' },
    { title: 'экспонента', lat: '1e2', lon: '37.618423' },
    { title: 'экспонента в допустимом диапазоне', lat: '5.5e1', lon: '37.618423' },
    { title: 'запятая вместо точки', lat: '55,751244', lon: '37.618423' },
    { title: 'пробел внутри числа', lat: '55.75 1244', lon: '37.618423' },
    { title: 'единицы измерения', lat: '55.751244°', lon: '37.618423' },
    { title: 'Infinity', lat: 'Infinity', lon: '37.618423' },
    { title: 'широта чуть за пределом', lat: '90.0000004', lon: '37.618423' },
    { title: 'южная широта чуть за пределом', lat: '-90.0000004', lon: '37.618423' },
    { title: 'долгота чуть за пределом', lat: '55.751244', lon: '180.0000004' },
    { title: 'широта числом за пределом', lat: 90.0000004, lon: 37.618423 },
    { title: 'нечисловой тип', lat: true, lon: '37.618423' },
  ];

  for (const testCase of REJECTED) {
    it(`отклоняет: ${testCase.title}`, async () => {
      const token = await tokenFor(['LOGISTICIAN']);
      const { order } = await seedOrder();

      const response = await setPoint(token, order.id, {
        lat: testCase.lat,
        lon: testCase.lon,
        reason: `Проверка: ${testCase.title}`,
        expectedVersion: order.version,
      });

      expect(response.statusCode).toBe(400);

      // Отказ происходит до любой записи: ни точки, ни истории, ни версии.
      const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
      expect(stored.geoState).toBe('UNRESOLVED');
      expect(stored.geoLatMicro).toBeNull();
      expect(stored.version).toBe(order.version);
      expect(await ctx.db.orderGeoHistory.count({ where: { orderId: order.id } })).toBe(0);
    });
  }

  it('точные границы планеты принимаются', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const { order } = await seedOrder();

    const response = await setPoint(token, order.id, {
      lat: '-90.000000',
      lon: '180.000000',
      reason: 'Полюс и линия перемены даты — не ошибка',
      expectedVersion: order.version,
    });

    expect(response.statusCode).toBe(200);
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoLatMicro).toBe(-90_000_000);
    expect(stored.geoLonMicro).toBe(180_000_000);
  });

  it('чистая функция отклоняет то же самое и принимает границы', () => {
    for (const value of ['', '   ', '0x10', '1e2', '90.0000004', '.5', '5.', '+55.5']) {
      expect(() => toMicro(value, MAX_LAT_MICRO, 'lat'), value).toThrow();
    }

    expect(toMicro('90', MAX_LAT_MICRO, 'lat')).toBe(90_000_000);
    expect(toMicro('-90.000000', MAX_LAT_MICRO, 'lat')).toBe(-90_000_000);
    expect(toMicro(90, MAX_LAT_MICRO, 'lat')).toBe(90_000_000);
  });
});

describe('ручная установка точки', () => {
  it('ставит точку, пишет историю, аудит и событие без адреса и координат', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const { order } = await seedOrder();

    const response = await setPoint(token, order.id, {
      ...POINT,
      reason: 'Дом уточнён по звонку',
      expectedVersion: order.version,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      version: number;
      geoState: string;
      lat: string;
      lon: string;
      unchanged: boolean;
    };
    expect(body.geoState).toBe('RESOLVED');
    expect(body.unchanged).toBe(false);
    expect(body.version).toBe(order.version + 1);
    // Наружу уходит десятичная строка, а не число с плавающей точкой.
    expect(body.lat).toBe('55.751244');
    expect(body.lon).toBe('37.618423');

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoState).toBe('RESOLVED');
    expect(stored.geoSource).toBe('MANUAL');
    expect(stored.geoPrecision).toBe('EXACT_HOUSE');
    expect(stored.geoLatMicro).toBe(55_751_244);
    expect(stored.geoReviewReason).toBeNull();

    const history = await ctx.db.orderGeoHistory.findMany({ where: { orderId: order.id } });
    expect(history).toHaveLength(1);
    expect(history[0]?.kind).toBe('MANUAL_SET');
    expect(history[0]?.reason).toBe('Дом уточнён по звонку');

    const audit = await ctx.db.auditLog.findMany({
      where: { entityId: order.id, action: 'ORDER_GEO_POINT_SET' },
    });
    expect(audit).toHaveLength(1);
    const auditText = asText(audit[0]);
    expect(auditText).not.toContain('синтетический адрес');
    expect(auditText).not.toContain('55.751244');
    expect(auditText).not.toContain('55751244');

    const events = await ctx.db.realtimeEvent.findMany({ where: { topic: 'order.geo_changed' } });
    const own = events.filter((event) => asText(event.payload).includes(order.id));
    expect(own.length).toBeGreaterThan(0);
    const eventText = asText(own);
    expect(eventText).not.toContain('синтетический адрес');
    expect(eventText).not.toContain('55.751244');
    expect(eventText).not.toContain('55751244');
  });

  it('повторная та же точка идемпотентна: ни истории, ни версии, ни события', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const { order } = await seedOrder();

    const first = await setPoint(token, order.id, {
      ...POINT,
      reason: 'Первая установка',
      expectedVersion: order.version,
    });
    expect(first.statusCode).toBe(200);
    const version = (first.json() as { version: number }).version;

    const auditBefore = await ctx.db.auditLog.count({ where: { entityId: order.id } });

    const second = await setPoint(token, order.id, {
      ...POINT,
      reason: 'Повтор того же клика',
      expectedVersion: version,
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { unchanged: boolean }).unchanged).toBe(true);
    expect((second.json() as { version: number }).version).toBe(version);

    expect(await ctx.db.orderGeoHistory.count({ where: { orderId: order.id } })).toBe(1);
    expect(await ctx.db.auditLog.count({ where: { entityId: order.id } })).toBe(auditBefore);
  });

  it('подтверждение точки геокодера меняет источник и не считается повтором', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const { order } = await seedOrder();

    // Точка, как если бы её нашёл геокодер: ветка 5.2 запишет её так же.
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: {
        geoState: 'RESOLVED',
        geoSource: 'DADATA',
        geoPrecision: 'NEARBY_HOUSE',
        geoLatMicro: 55_751_244,
        geoLonMicro: 37_618_423,
        geoResolvedAt: NOW,
      },
    });
    const found = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });

    const response = await setPoint(token, order.id, {
      ...POINT,
      reason: 'Логист подтвердил точку геокодера',
      expectedVersion: found.version,
    });

    expect(response.statusCode).toBe(200);
    // Координаты те же, но ответственность перешла к человеку: это изменение.
    expect((response.json() as { unchanged: boolean }).unchanged).toBe(false);
    expect((response.json() as { version: number }).version).toBe(found.version + 1);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoSource).toBe('MANUAL');
    expect(stored.geoPrecision).toBe('EXACT_HOUSE');

    const history = await ctx.db.orderGeoHistory.findMany({ where: { orderId: order.id } });
    expect(history).toHaveLength(1);
    expect(history[0]?.kind).toBe('MANUAL_SET');
    expect(history[0]?.reason).toBe('Логист подтвердил точку геокодера');

    expect(
      await ctx.db.auditLog.count({ where: { entityId: order.id, action: 'ORDER_GEO_POINT_SET' } }),
    ).toBe(1);

    // А вот повтор уже ручной точки идемпотентен.
    const repeat = await setPoint(token, order.id, {
      ...POINT,
      reason: 'Повтор уже ручной точки',
      expectedVersion: found.version + 1,
    });
    expect(repeat.statusCode).toBe(200);
    expect((repeat.json() as { unchanged: boolean }).unchanged).toBe(true);
    expect(await ctx.db.orderGeoHistory.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('устаревшая версия возвращает 409 STALE_VERSION и ничего не меняет', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const { order } = await seedOrder();

    const first = await setPoint(token, order.id, {
      ...POINT,
      reason: 'Первая установка',
      expectedVersion: order.version,
    });
    expect(first.statusCode).toBe(200);

    const stale = await setPoint(token, order.id, {
      ...OTHER_POINT,
      reason: 'Попытка с устаревшей версией',
      expectedVersion: order.version,
    });

    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { conflict?: { kind: string } } }).error.conflict?.kind).toBe(
      'STALE_VERSION',
    );

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoLatMicro).toBe(55_751_244);
    expect(await ctx.db.orderGeoHistory.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('недопустимая координата отклоняется и не оставляет следов', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const { order } = await seedOrder();

    const response = await setPoint(token, order.id, {
      lat: '95.000000',
      lon: '37.618423',
      reason: 'Координата за пределами планеты',
      expectedVersion: order.version,
    });

    expect(response.statusCode).toBe(400);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoState).toBe('UNRESOLVED');
    expect(stored.version).toBe(order.version);
    expect(await ctx.db.orderGeoHistory.count({ where: { orderId: order.id } })).toBe(0);
    expect(
      await ctx.db.auditLog.count({ where: { entityId: order.id, action: 'ORDER_GEO_POINT_SET' } }),
    ).toBe(0);
  });

  it('две одновременные установки: одна побеждает, вторая получает 409 без частичной записи', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const { order } = await seedOrder();

    // Оба запроса идут с одной и той же версией: блокировка строки обязана
    // выстроить их в очередь, а не позволить обоим записать свою точку.
    const [first, second] = await Promise.all([
      setPoint(token, order.id, {
        ...POINT,
        reason: 'Одновременная установка A',
        expectedVersion: order.version,
      }),
      setPoint(token, order.id, {
        ...OTHER_POINT,
        reason: 'Одновременная установка B',
        expectedVersion: order.version,
      }),
    ]);

    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.version).toBe(order.version + 1);
    expect(await ctx.db.orderGeoHistory.count({ where: { orderId: order.id } })).toBe(1);
    expect(
      await ctx.db.auditLog.count({ where: { entityId: order.id, action: 'ORDER_GEO_POINT_SET' } }),
    ).toBe(1);
  });

  it('заказ вне нашей доставки точку не получает', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const { snapshot, order } = await seedOrder();

    await apply({
      ...snapshot,
      storeId: '33333333-3333-4333-8333-333333333333',
      inScope: false,
      scopeExitReason: 'STORE_CHANGED',
      externalUpdated: '2026-08-10 13:00:00.000',
    });
    const moved = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(moved.inScope).toBe(false);

    const response = await setPoint(token, order.id, {
      ...POINT,
      reason: 'Попытка для заказа чужого склада',
      expectedVersion: moved.version,
    });
    expect(response.statusCode).toBe(400);
    expect(await ctx.db.orderGeoHistory.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('права: ADMIN и LOGISTICIAN допущены, COURIER, WAREHOUSE и аноним — нет', async () => {
    const { order } = await seedOrder();

    for (const roles of [['ADMIN'], ['LOGISTICIAN']] as const) {
      const fresh = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
      const response = await setPoint(await tokenFor([...roles]), order.id, {
        ...POINT,
        reason: `Установка ролью ${roles.join()}`,
        expectedVersion: fresh.version,
      });
      expect(response.statusCode, roles.join()).toBe(200);
    }

    for (const roles of [['COURIER'], ['WAREHOUSE']] as const) {
      const fresh = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
      const response = await setPoint(await tokenFor([...roles]), order.id, {
        ...OTHER_POINT,
        reason: `Попытка ролью ${roles.join()}`,
        expectedVersion: fresh.version,
      });
      expect(response.statusCode, roles.join()).toBe(403);
    }

    const anonymous = await ctx.app.inject({
      method: 'PUT',
      url: `/api/orders/${order.id}/geo-point`,
      payload: { ...OTHER_POINT, reason: 'Аноним', expectedVersion: 1 },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('смена адреса обесценивает точку', () => {
  it('после другого адреса точка исчезает, а прежняя остаётся в истории', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const { snapshot, order } = await seedOrder();

    const set = await setPoint(token, order.id, {
      ...POINT,
      reason: 'Точка до смены адреса',
      expectedVersion: order.version,
    });
    expect(set.statusCode).toBe(200);

    await apply(
      {
        ...snapshot,
        address: 'Москва, другой синтетический адрес, 2',
        externalUpdated: '2026-08-10 14:00:00.000',
      },
      new Date('2026-08-10T11:00:00.000Z'),
    );

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoState).toBe('NEEDS_REVIEW');
    expect(stored.geoReviewReason).toBe('ADDRESS_CHANGED');
    expect(stored.geoLatMicro).toBeNull();
    expect(stored.geoLonMicro).toBeNull();
    expect(stored.geoSource).toBeNull();

    const history = await ctx.db.orderGeoHistory.findMany({
      where: { orderId: order.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(history).toHaveLength(2);
    expect(history[1]?.kind).toBe('INVALIDATED_ADDRESS_CHANGED');
    // Прежняя точка остаётся доказательством: где заказ был до правки адреса.
    expect(history[1]?.previousLatMicro).toBe(55_751_244);
    expect(history[1]?.latMicro).toBeNull();

    expect(
      await ctx.db.auditLog.count({
        where: { entityId: order.id, action: 'ORDER_GEO_INVALIDATED' },
      }),
    ).toBe(1);
  });

  it('заказ без точки смена адреса не трогает', async () => {
    const { snapshot, order } = await seedOrder();

    await apply(
      {
        ...snapshot,
        address: 'Москва, ещё один синтетический адрес, 3',
        externalUpdated: '2026-08-10 14:00:00.000',
      },
      new Date('2026-08-10T11:00:00.000Z'),
    );

    expect(await ctx.db.orderGeoHistory.count({ where: { orderId: order.id } })).toBe(0);
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.geoState).toBe('UNRESOLVED');
  });
});

describe('выборка для карты и список', () => {
  it('карта отдаёт только заказы выбранного дня с подтверждённой точкой', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const day = '2027-02-20';

    const withPoint = await seedOrder({ deliveryPlannedMoment: `${day} 12:00:00.000` });
    const withoutPoint = await seedOrder({ deliveryPlannedMoment: `${day} 13:00:00.000` });
    const otherDay = await seedOrder({ deliveryPlannedMoment: '2027-02-21 12:00:00.000' });

    for (const seeded of [withPoint, otherDay]) {
      const response = await setPoint(token, seeded.order.id, {
        ...POINT,
        reason: 'Точка для проверки карты',
        expectedVersion: seeded.order.version,
      });
      expect(response.statusCode).toBe(200);
    }

    const map = await ctx.app.inject({
      method: 'GET',
      url: `/api/orders/map?deliveryDate=${day}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(map.statusCode).toBe(200);

    const ids = (map.json() as { points: { orderId: string }[] }).points.map(
      (point) => point.orderId,
    );
    expect(ids).toContain(withPoint.order.id);
    // Заказ без точки на карте не появляется…
    expect(ids).not.toContain(withoutPoint.order.id);
    expect(ids).not.toContain(otherDay.order.id);

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/orders?deliveryDate=${day}&limit=100`,
      headers: { authorization: `Bearer ${token}` },
    });
    const items = (list.json() as { items: { id: string; geo: { state: string } }[] }).items;
    // …но из списка не исчезает: логист обязан видеть его и работать с ним.
    const listed = items.find((item) => item.id === withoutPoint.order.id);
    expect(listed).toBeDefined();
    expect(listed?.geo.state).toBe('UNRESOLVED');
  });

  it('архивированный и пропавший в источнике заказ на карту не попадают', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const day = '2027-02-25';

    const normal = await seedOrder({ deliveryPlannedMoment: `${day} 12:00:00.000` });
    const archived = await seedOrder({ deliveryPlannedMoment: `${day} 13:00:00.000` });
    const missing = await seedOrder({ deliveryPlannedMoment: `${day} 14:00:00.000` });

    for (const seeded of [normal, archived, missing]) {
      const response = await setPoint(token, seeded.order.id, {
        ...POINT,
        reason: 'Точка до исчезновения заказа',
        expectedVersion: seeded.order.version,
      });
      expect(response.statusCode).toBe(200);
    }

    // Состояние готовится прямо в базе: важно, что фильтрует выборка карты,
    // а не то, каким путём заказ дошёл до этого состояния.
    await ctx.db.deliveryOrder.update({
      where: { id: archived.order.id },
      data: { sourceArchived: true },
    });
    await ctx.db.deliveryOrder.update({
      where: { id: missing.order.id },
      data: { sourceMissing: true },
    });

    const map = await ctx.app.inject({
      method: 'GET',
      url: `/api/orders/map?deliveryDate=${day}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(map.statusCode).toBe(200);

    const ids = (map.json() as { points: { orderId: string }[] }).points.map(
      (point) => point.orderId,
    );
    expect(ids).toContain(normal.order.id);
    expect(ids).not.toContain(archived.order.id);
    expect(ids).not.toContain(missing.order.id);
  });

  it('несуществующая дата в запросе карты отклоняется', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/orders/map?deliveryDate=2026-02-30',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
  });

  it('фильтр по состоянию георазрешения работает', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const day = '2027-02-22';
    const resolved = await seedOrder({ deliveryPlannedMoment: `${day} 12:00:00.000` });
    const unresolved = await seedOrder({ deliveryPlannedMoment: `${day} 13:00:00.000` });

    await setPoint(token, resolved.order.id, {
      ...POINT,
      reason: 'Точка для фильтра',
      expectedVersion: resolved.order.version,
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/orders?deliveryDate=${day}&geoState=UNRESOLVED&limit=100`,
      headers: { authorization: `Bearer ${token}` },
    });
    const ids = (response.json() as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids).toContain(unresolved.order.id);
    expect(ids).not.toContain(resolved.order.id);
  });
});

describe('конфигурация карты', () => {
  it('без MAP_STYLE_URL честно сообщает, что карта не настроена', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/map/config',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { configured: boolean; styleUrl: string | null };
    // Тестовое окружение адрес стиля не задаёт: значит, обращения наружу нет.
    expect(body.configured).toBe(false);
    expect(body.styleUrl).toBeNull();
  });

  it('в конфигурации карты нет секретов и ключей', async () => {
    const token = await tokenFor(['ADMIN']);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/map/config',
      headers: { authorization: `Bearer ${token}` },
    });

    const keys = Object.keys(response.json() as Record<string, unknown>).sort();
    expect(keys).toEqual([
      'attribution',
      'configured',
      'problem',
      'revision',
      'routingAvailable',
      'source',
      'styleUrl',
      'trafficMode',
    ]);

    // Адрес маршрутизатора известен только серверу и в браузер не уходит.
    expect(response.body).not.toContain('valhalla');
    expect(response.body).not.toContain('8002');
  });

  it('исходный код карты не содержит публичных тайлов и демонстрационных стилей', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const directory = new URL('../../../../web/src/screens/routing/', import.meta.url);
    const files = (await readdir(directory)).filter(
      (name) => name.endsWith('.tsx') || name.endsWith('.ts'),
    );

    for (const file of files) {
      const code = await readFile(new URL(file, directory), 'utf8');
      const lines = code
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n');

      expect(lines, file).not.toContain('tile.openstreetmap.org');
      expect(lines, file).not.toContain('demotiles.maplibre.org');
      expect(lines, file).not.toContain('api.maptiler.com');
    }
  });
});

describe('перевод координат', () => {
  it('строка и число дают одно и то же целое значение', () => {
    expect(toMicro('55.751244', MAX_LAT_MICRO, 'lat')).toBe(55_751_244);
    expect(toMicro(55.751244, MAX_LAT_MICRO, 'lat')).toBe(55_751_244);
  });

  it('обратный перевод сохраняет шесть знаков, включая нули и знак', () => {
    expect(fromMicro(55_751_244)).toBe('55.751244');
    expect(fromMicro(37_600_000)).toBe('37.600000');
    expect(fromMicro(-1_000_001)).toBe('-1.000001');
    expect(fromMicro(0)).toBe('0.000000');
  });
});
