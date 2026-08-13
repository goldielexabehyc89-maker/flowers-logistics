/**
 * Критические проверки пользовательского цикла правки адреса.
 *
 * Здесь проверяется то, из-за чего логист потерял бы работу или отправил бы
 * курьера не туда: атомарность сохранения, судьба координаты, оба решения
 * конфликта, отсутствие персональных данных в общем аудите и realtime,
 * а также границы серверных подсказок.
 *
 * Настоящих обращений к DaData нет: HTTP подменён функцией.
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
import {
  MAX_QUERY_LENGTH,
  MAX_SUGGESTIONS,
  suggestAddresses,
} from '../integrations/dadata/suggest.js';
import {
  clearLocalAddress,
  listAddressHistory,
  resolveAddressConflict,
  setLocalAddress,
} from './address-service.js';

let ctx: TestContext;
const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;

const SOURCE_ADDRESS = 'Москва, синтетическая улица, дом 1';
const NEXT_SOURCE_ADDRESS = 'Москва, синтетическая улица, дом 2';
const LOCAL_ADDRESS = 'Москва, исправленная синтетическая улица, дом 3';
const CONTEXT = { ip: '127.0.0.1', userAgent: 'critical-test' };
const POINT = { latMicro: 55_751_244, lonMicro: 37_618_423 };

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    name: `AFL-${process.hrtime.bigint() % 1_000_000n}`,
    updated: '2026-08-13 10:00:00.000',
    shipmentAddress: SOURCE_ADDRESS,
    deliveryPlannedMoment: '2026-08-13 12:00:00.000',
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
      { id: IDS.intervalAttribute, value: 'с 16:00 по 19:00' },
      { id: IDS.recipientAttribute, value: 'Получатель Синтетический' },
    ],
    ...overrides,
  };
}

function snapshotOf(overrides: Record<string, unknown> = {}): OrderSnapshot {
  return mapOrder(source(overrides) as never, IDS).snapshot;
}

async function apply(snapshot: OrderSnapshot): Promise<void> {
  await ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, new Date()));
}

async function seedOrder(): Promise<{ id: string; externalId: string }> {
  const snapshot = snapshotOf();
  await apply(snapshot);
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { externalId: snapshot.externalId },
    select: { id: true },
  });
  return { id: order.id, externalId: snapshot.externalId };
}

async function actor(): Promise<{ userId: string }> {
  const user = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
  return { userId: user.id };
}

async function readOrder(id: string) {
  return ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { id },
    select: {
      address: true,
      localAddress: true,
      sourceAddressAtLocalEdit: true,
      addressConflict: true,
      localAddressSetById: true,
      attentionReasons: true,
      geoState: true,
      geoSource: true,
      geoLatMicro: true,
    },
  });
}

/** Поддельный HTTP подсказок: настоящих обращений к DaData в тестах не бывает. */
function fakeSuggest(payload: unknown, status = 200): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

const CREDENTIALS = { apiKey: 'test-only-key', secretKey: 'test-only-secret' };

// ---------------------------------------------------------------------------

describe('подсказки адреса', () => {
  it('наружу выходят только стандартизованные поля и координаты', async () => {
    const suggestions = await suggestAddresses(
      {
        credentials: CREDENTIALS,
        fetch: fakeSuggest({
          suggestions: [
            {
              value: LOCAL_ADDRESS,
              unsafe_data: 'сырой ответ провайдера',
              data: { geo_lat: '55.751244', geo_lon: '37.618423', qc_geo: '0', fias_id: 'x' },
            },
          ],
        }),
      },
      'Москва, исправ',
    );

    expect(suggestions).toEqual([
      { value: LOCAL_ADDRESS, latMicro: POINT.latMicro, lonMicro: POINT.lonMicro, exact: true },
    ]);
    // Полей провайдера, которых мы не обещали хранить, в ответе нет.
    expect(JSON.stringify(suggestions)).not.toContain('fias_id');
    expect(JSON.stringify(suggestions)).not.toContain('unsafe_data');
  });

  it('неточная привязка точной не объявляется', async () => {
    const [first] = await suggestAddresses(
      {
        credentials: CREDENTIALS,
        fetch: fakeSuggest({
          suggestions: [
            {
              value: 'Москва, улица без дома',
              data: { geo_lat: '55.7', geo_lon: '37.6', qc_geo: '2' },
            },
          ],
        }),
      },
      'Москва, улица',
    );
    expect(first?.exact).toBe(false);
  });

  it('короткий запрос и незаданные ключи в сеть не уходят', async () => {
    let called = 0;
    const counting: typeof globalThis.fetch = (async () => {
      called += 1;
      return new Response('{"suggestions":[]}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    expect(await suggestAddresses({ credentials: CREDENTIALS, fetch: counting }, 'Мо')).toEqual([]);
    expect(
      await suggestAddresses(
        { credentials: { apiKey: null, secretKey: null }, fetch: counting },
        'Москва, улица',
      ),
    ).toEqual([]);
    expect(called).toBe(0);
  });

  it('число подсказок ограничено, длинный запрос обрезается до сети', async () => {
    let sentQuery = '';
    const capture: typeof globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentQuery = JSON.parse(String(init.body)).query as string;
      return new Response(
        JSON.stringify({
          suggestions: Array.from({ length: 25 }, (_, index) => ({ value: `вариант ${index}` })),
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const suggestions = await suggestAddresses(
      { credentials: CREDENTIALS, fetch: capture },
      'М'.repeat(MAX_QUERY_LENGTH + 50),
    );

    expect(suggestions).toHaveLength(MAX_SUGGESTIONS);
    expect(sentQuery.length).toBe(MAX_QUERY_LENGTH);
  });

  it('отказ провайдера не превращается в тихий успех', async () => {
    await expect(
      suggestAddresses({ credentials: CREDENTIALS, fetch: fakeSuggest({}, 500) }, 'Москва, улица'),
    ).rejects.toThrow();
  });
});

describe('сохранение локального адреса', () => {
  it('адрес, точка, история и снимок источника сохраняются вместе', async () => {
    const { id } = await seedOrder();
    const user = await actor();

    const result = await setLocalAddress(
      { db: ctx.db },
      user,
      id,
      { address: LOCAL_ADDRESS, point: POINT },
      CONTEXT,
    );

    expect(result).toMatchObject({ corrected: true, conflict: false, geoState: 'RESOLVED' });

    const order = await readOrder(id);
    // Исходное поле не тронуто: обратной записи в МойСклад ещё нет.
    expect(order.address).toBe(SOURCE_ADDRESS);
    expect(order.localAddress).toBe(LOCAL_ADDRESS);
    expect(order.sourceAddressAtLocalEdit).toBe(SOURCE_ADDRESS);
    expect(order.localAddressSetById).toBe(user.userId);
    expect(order.geoState).toBe('RESOLVED');
    expect(order.geoLatMicro).toBe(POINT.latMicro);

    const history = await listAddressHistory({ db: ctx.db }, id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: 'LOCAL_ADDRESS_SET',
      oldAddress: SOURCE_ADDRESS,
      newAddress: LOCAL_ADDRESS,
    });
    expect(history[0]?.actor?.id).toBe(user.userId);
  });

  it('без точки заказ уходит на проверку, а прежняя координата обесценивается', async () => {
    const { id } = await seedOrder();
    const user = await actor();
    await ctx.db.deliveryOrder.update({
      where: { id },
      data: {
        geoState: 'RESOLVED',
        geoSource: 'DADATA',
        geoPrecision: 'EXACT_HOUSE',
        geoLatMicro: POINT.latMicro,
        geoLonMicro: POINT.lonMicro,
        geoResolvedAt: new Date(),
      },
    });

    await setLocalAddress({ db: ctx.db }, user, id, { address: LOCAL_ADDRESS }, CONTEXT);

    const order = await readOrder(id);
    // Адрес ушёл в очередь разрешения: прежняя координата снята, а состояние
    // стало PENDING — это и есть «точки нет, она запрошена».
    expect(order.geoState).toBe('PENDING');
    expect(order.geoLatMicro).toBeNull();
  });

  it('в общий аудит и realtime адрес не попадает', async () => {
    const { id } = await seedOrder();
    const user = await actor();
    await setLocalAddress(
      { db: ctx.db },
      user,
      id,
      { address: LOCAL_ADDRESS, point: POINT },
      CONTEXT,
    );

    const audit = await ctx.db.auditLog.findMany({
      where: { entityId: id, action: 'ORDER_ADDRESS_CORRECTED' },
      select: { newValue: true, oldValue: true },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(LOCAL_ADDRESS);

    const events = await ctx.db.realtimeEvent.findMany({
      where: { topic: 'order.address_changed' },
      select: { payload: true },
    });
    expect(JSON.stringify(events)).not.toContain(LOCAL_ADDRESS);
    expect(JSON.stringify(events)).not.toContain(SOURCE_ADDRESS);
  });

  it('пустой адрес не принимается', async () => {
    const { id } = await seedOrder();
    const user = await actor();
    await expect(
      setLocalAddress({ db: ctx.db }, user, id, { address: '   ' }, CONTEXT),
    ).rejects.toThrow();
  });
});

describe('снятие правки', () => {
  it('рабочим снова становится исходный адрес, история пополняется', async () => {
    const { id } = await seedOrder();
    const user = await actor();
    await setLocalAddress(
      { db: ctx.db },
      user,
      id,
      { address: LOCAL_ADDRESS, point: POINT },
      CONTEXT,
    );

    await clearLocalAddress({ db: ctx.db }, user, id, CONTEXT);

    const order = await readOrder(id);
    expect(order.localAddress).toBeNull();
    expect(order.sourceAddressAtLocalEdit).toBeNull();
    expect(order.geoState).toBe('PENDING');

    const history = await listAddressHistory({ db: ctx.db }, id);
    expect(history.map((item) => item.action)).toEqual([
      'LOCAL_ADDRESS_CLEARED',
      'LOCAL_ADDRESS_SET',
    ]);
  });

  it('снимать нечего — штатный отказ, а не молчание', async () => {
    const { id } = await seedOrder();
    const user = await actor();
    await expect(clearLocalAddress({ db: ctx.db }, user, id, CONTEXT)).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/локальной правки/i) as unknown as string,
    });
  });
});

describe('оба решения конфликта', () => {
  async function seedConflict(): Promise<{ id: string; user: { userId: string } }> {
    const { id, externalId } = await seedOrder();
    const user = await actor();
    await setLocalAddress(
      { db: ctx.db },
      user,
      id,
      { address: LOCAL_ADDRESS, point: POINT },
      CONTEXT,
    );
    await apply(
      snapshotOf({
        id: externalId,
        shipmentAddress: NEXT_SOURCE_ADDRESS,
        updated: '2026-08-13 11:00:00.000',
      }),
    );
    return { id, user };
  }

  it('«оставить локальный» сохраняет адрес и обновляет снимок источника', async () => {
    const { id, user } = await seedConflict();
    expect((await readOrder(id)).addressConflict).toBe(true);

    await resolveAddressConflict({ db: ctx.db }, user, id, 'KEEP_LOCAL', CONTEXT);

    const order = await readOrder(id);
    expect(order.addressConflict).toBe(false);
    expect(order.localAddress).toBe(LOCAL_ADDRESS);
    // Снимок обновлён: тот же конфликт не объявляется на каждом проходе.
    expect(order.sourceAddressAtLocalEdit).toBe(NEXT_SOURCE_ADDRESS);
    expect(order.attentionReasons).not.toContain('ADDRESS_CONFLICT');
    // Рабочий адрес не менялся — координата осталась.
    expect(order.geoState).toBe('RESOLVED');
  });

  it('«принять источник» снимает правку и отправляет адрес на разрешение', async () => {
    const { id, user } = await seedConflict();

    await resolveAddressConflict({ db: ctx.db }, user, id, 'USE_SOURCE', CONTEXT);

    const order = await readOrder(id);
    expect(order.addressConflict).toBe(false);
    expect(order.localAddress).toBeNull();
    expect(order.geoState).toBe('PENDING');
    expect(order.attentionReasons).not.toContain('ADDRESS_CONFLICT');

    const history = await listAddressHistory({ db: ctx.db }, id);
    expect(history[0]?.action).toBe('CONFLICT_RESOLVED_USE_SOURCE');
  });

  it('конфликта нет — решать нечего', async () => {
    const { id } = await seedOrder();
    const user = await actor();
    await expect(
      resolveAddressConflict({ db: ctx.db }, user, id, 'KEEP_LOCAL', CONTEXT),
    ).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/расхождения/i) as unknown as string,
    });
  });

  it('новая правка поверх конфликта закрывает его сама', async () => {
    const { id, user } = await seedConflict();
    await setLocalAddress(
      { db: ctx.db },
      user,
      id,
      { address: 'Москва, третья синтетическая улица, дом 5', point: POINT },
      CONTEXT,
    );

    const order = await readOrder(id);
    expect(order.addressConflict).toBe(false);
    expect(order.sourceAddressAtLocalEdit).toBe(NEXT_SOURCE_ADDRESS);
  });
});
