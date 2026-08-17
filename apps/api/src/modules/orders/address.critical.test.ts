/**
 * Критические проверки локального адреса.
 *
 * Здесь проверяется то, из-за чего заказ поехал бы не туда или потерял работу
 * логиста: какой адрес считается рабочим, что происходит при изменении
 * источника поверх правки, и может ли история адреса быть переписана.
 *
 * Настоящих адресов клиентов в тестах нет — только синтетические строки.
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
  addressState,
  automaticGeocodingAddress,
  effectiveAddress,
  geocodingAddress,
  isSourceConflict,
} from './address.js';
import { effectiveAttentionReasons, needsLogisticsAttention } from './attention.js';
import { setLocalAddress } from './address-service.js';

let ctx: TestContext;
const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;

const SOURCE_ADDRESS = 'Москва, синтетическая улица, дом 1';
const NEXT_SOURCE_ADDRESS = 'Москва, синтетическая улица, дом 2';
const LOCAL_ADDRESS = 'Москва, исправленная синтетическая улица, дом 3';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    name: `ADR-${process.hrtime.bigint() % 1_000_000n}`,
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

/** Импорт с включённой постановкой в очередь: так работает production. */
async function applyWithQueue(snapshot: OrderSnapshot): Promise<void> {
  await ctx.db.$transaction((tx) =>
    applyOrderSnapshot(tx, snapshot, new Date(), { geocoding: true }),
  );
}

/** Заказ с действующей локальной правкой. Правка ставится напрямую: сервис правки — следующий срез. */
async function seedCorrectedOrder(): Promise<{ id: string; externalId: string }> {
  const snapshot = snapshotOf();
  await apply(snapshot);
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { externalId: snapshot.externalId },
    select: { id: true },
  });
  const actor = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });

  await ctx.db.deliveryOrder.update({
    where: { id: order.id },
    data: {
      localAddress: LOCAL_ADDRESS,
      localAddressSetAt: new Date(),
      localAddressSetById: actor.id,
      sourceAddressAtLocalEdit: SOURCE_ADDRESS,
    },
  });

  return { id: order.id, externalId: snapshot.externalId };
}

// ---------------------------------------------------------------------------

describe('«Требует внимания» — разрешённый список', () => {
  /*
   * Признак рабочий, а не описательный: он красит карточку, поднимает её
   * вверх списка и убирает заказ с карты. Поэтому в него попадает ровно то,
   * что мешает логисту распределить заказ.
   */
  it('адрес, конфликт и интервал блокируют работу', () => {
    for (const reason of [
      'MISSING_ADDRESS',
      'GEOCODING_ADDRESS_INCOMPLETE',
      'ADDRESS_CONFLICT',
      'MISSING_INTERVAL',
      'UNRECOGNIZED_INTERVAL',
    ] as const) {
      expect(needsLogisticsAttention([reason]), reason).toBe(true);
    }
  });

  it('получатель, дата и деньги логиста не блокируют', () => {
    for (const reason of [
      'MISSING_RECIPIENT',
      'MISSING_DELIVERY_DATE',
      'UNRECOGNIZED_DELIVERY_DATE',
      'CASH_OVERPAYMENT',
    ] as const) {
      expect(needsLogisticsAttention([reason]), reason).toBe(false);
    }
    // Вместе они тоже ничего не блокируют: список разрешающий, а не счётный.
    expect(
      needsLogisticsAttention(['MISSING_RECIPIENT', 'MISSING_DELIVERY_DATE', 'CASH_OVERPAYMENT']),
    ).toBe(false);
  });

  it('новая посторонняя причина не становится блокирующей молча', () => {
    // Ровно то, ради чего список сделан разрешающим: причина, о которой эта
    // версия приложения не знает, не имеет права выносить день в «Требует
    // внимания».
    expect(needsLogisticsAttention(['SOMETHING_NEW' as never])).toBe(false);
    expect(needsLogisticsAttention(['SOMETHING_NEW' as never, 'MISSING_ADDRESS'])).toBe(true);
  });

  it('диагностические сведения остаются в наборе причин', () => {
    // Причины из МоегоСклада не выбрасываются: они видны в карточке и хранятся
    // в снимке — просто не управляют цветом и порядком.
    const reasons = effectiveAttentionReasons(['MISSING_RECIPIENT', 'CASH_OVERPAYMENT'], null);
    expect(reasons).toEqual(['MISSING_RECIPIENT', 'CASH_OVERPAYMENT']);
    expect(needsLogisticsAttention(reasons)).toBe(false);
  });
});

describe('рабочий адрес один', () => {
  it('локальная правка сильнее исходного адреса', () => {
    expect(effectiveAddress({ address: SOURCE_ADDRESS, localAddress: LOCAL_ADDRESS })).toBe(
      LOCAL_ADDRESS,
    );
    expect(effectiveAddress({ address: SOURCE_ADDRESS, localAddress: null })).toBe(SOURCE_ADDRESS);
    expect(effectiveAddress({ address: null, localAddress: null })).toBeNull();
  });

  it('пустая строка адресом не считается ни в одном источнике', () => {
    expect(effectiveAddress({ address: SOURCE_ADDRESS, localAddress: '   ' })).toBe(SOURCE_ADDRESS);
    expect(effectiveAddress({ address: '  ', localAddress: null })).toBeNull();
  });

  it('состояние карточки различает исходный и эффективный адрес', () => {
    const state = addressState({
      address: SOURCE_ADDRESS,
      localAddress: LOCAL_ADDRESS,
      addressConflict: false,
    });
    expect(state).toEqual({
      effective: LOCAL_ADDRESS,
      source: SOURCE_ADDRESS,
      corrected: true,
      conflict: false,
    });
  });

  it('прежний код без поля правки продолжает работать', () => {
    // Совместимость: заказ, прочитанный старым запросом без localAddress,
    // означает «правки нет», а не отказ.
    expect(effectiveAddress({ address: SOURCE_ADDRESS })).toBe(SOURCE_ADDRESS);
  });
});

describe('конфликт источника', () => {
  it('конфликт объявляется только при изменении источника поверх правки', () => {
    const corrected = {
      localAddress: LOCAL_ADDRESS,
      sourceAddressAtLocalEdit: SOURCE_ADDRESS,
      addressConflict: false,
    };
    expect(isSourceConflict(corrected, NEXT_SOURCE_ADDRESS)).toBe(true);
    // Та же самая строка источника конфликтом не является: иначе первая же
    // синхронизация объявляла бы конфликтом саму правку.
    expect(isSourceConflict(corrected, SOURCE_ADDRESS)).toBe(false);
    // Без локальной правки расходиться не с чем.
    expect(
      isSourceConflict(
        { localAddress: null, sourceAddressAtLocalEdit: null, addressConflict: false },
        NEXT_SOURCE_ADDRESS,
      ),
    ).toBe(false);
    // Уже объявленный конфликт не переоткрывается на каждом проходе.
    expect(isSourceConflict({ ...corrected, addressConflict: true }, NEXT_SOURCE_ADDRESS)).toBe(
      false,
    );
  });

  it('синхронизация не затирает правку и оставляет конфликт с историей', async () => {
    const { id, externalId } = await seedCorrectedOrder();

    await apply(
      snapshotOf({
        id: externalId,
        shipmentAddress: NEXT_SOURCE_ADDRESS,
        updated: '2026-08-13 11:00:00.000',
      }),
    );

    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id },
      select: {
        address: true,
        localAddress: true,
        addressConflict: true,
        addressConflictDetectedAt: true,
        needsAttention: true,
        attentionReasons: true,
      },
    });

    // Источник обновился, локальное значение осталось нетронутым.
    expect(after.address).toBe(NEXT_SOURCE_ADDRESS);
    expect(after.localAddress).toBe(LOCAL_ADDRESS);
    expect(after.addressConflict).toBe(true);
    expect(after.addressConflictDetectedAt).not.toBeNull();
    // Конфликт блокирует маршрутизацию через «Требует внимания».
    expect(after.attentionReasons).toContain('ADDRESS_CONFLICT');
    expect(after.needsAttention).toBe(true);

    const history = await ctx.db.orderAddressHistory.findMany({ where: { orderId: id } });
    expect(history).toHaveLength(1);
    expect(history[0]?.action).toBe('SOURCE_CONFLICT_DETECTED');
    // Системное обнаружение автора не имеет: конфликт находит синхронизация.
    expect(history[0]?.actorUserId).toBeNull();
  });

  it('точка не обесценивается, пока рабочий адрес не изменился', async () => {
    const { id, externalId } = await seedCorrectedOrder();
    await ctx.db.deliveryOrder.update({
      where: { id },
      data: {
        geoState: 'RESOLVED',
        geoSource: 'DADATA',
        geoPrecision: 'EXACT_HOUSE',
        geoLatMicro: 55_751_244,
        geoLonMicro: 37_618_423,
        geoResolvedAt: new Date(),
      },
    });

    await apply(
      snapshotOf({
        id: externalId,
        shipmentAddress: NEXT_SOURCE_ADDRESS,
        updated: '2026-08-13 12:00:00.000',
      }),
    );

    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id },
      select: { geoState: true, geoLatMicro: true },
    });
    // Координата относится к адресу логиста, а он не менялся.
    expect(after.geoState).toBe('RESOLVED');
    expect(after.geoLatMicro).toBe(55_751_244);
  });
});

describe('причины внимания', () => {
  it('правка закрывает «нет адреса», конфликт добавляет блокирующую причину', () => {
    expect(
      effectiveAttentionReasons(['MISSING_ADDRESS'], null, { corrected: true, conflict: false }),
    ).toEqual([]);

    expect(effectiveAttentionReasons([], null, { corrected: true, conflict: true })).toEqual([
      'ADDRESS_CONFLICT',
    ]);

    // Без состояния адреса поведение прежнее: старый вызов не меняет смысла.
    expect(effectiveAttentionReasons(['MISSING_ADDRESS'], null)).toEqual(['MISSING_ADDRESS']);
  });
});

describe('история адреса неизменяема', () => {
  it('UPDATE и DELETE отвергаются базой', async () => {
    const { id } = await seedCorrectedOrder();
    const record = await ctx.db.orderAddressHistory.create({
      data: {
        orderId: id,
        action: 'SOURCE_CONFLICT_DETECTED',
        oldAddress: SOURCE_ADDRESS,
        newAddress: LOCAL_ADDRESS,
        sourceAddress: NEXT_SOURCE_ADDRESS,
      },
    });

    await expect(
      ctx.db.orderAddressHistory.update({
        where: { id: record.id },
        data: { newAddress: SOURCE_ADDRESS },
      }),
    ).rejects.toThrow();

    await expect(ctx.db.orderAddressHistory.delete({ where: { id: record.id } })).rejects.toThrow();
  });

  it('ручное действие без автора базой не принимается', async () => {
    const { id } = await seedCorrectedOrder();
    await expect(
      ctx.db.orderAddressHistory.create({
        data: {
          orderId: id,
          action: 'LOCAL_ADDRESS_SET',
          newAddress: LOCAL_ADDRESS,
          actorUserId: null,
        },
      }),
    ).rejects.toThrow();
  });

  it('запись без единого значения адреса невозможна', async () => {
    const { id } = await seedCorrectedOrder();
    await expect(
      ctx.db.orderAddressHistory.create({
        data: { orderId: id, action: 'SOURCE_CONFLICT_DETECTED' },
      }),
    ).rejects.toThrow();
  });
});

describe('инварианты заказа держит база', () => {
  it('половинчатая локальная правка не сохраняется', async () => {
    const snapshot = snapshotOf();
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
      select: { id: true },
    });

    // Адрес без автора и времени выглядел бы как правка, которую некому объяснить.
    await expect(
      ctx.db.deliveryOrder.update({
        where: { id: order.id },
        data: { localAddress: LOCAL_ADDRESS },
      }),
    ).rejects.toThrow();
  });

  it('пустая локальная правка не сохраняется', async () => {
    const { id } = await seedCorrectedOrder();
    await expect(
      ctx.db.deliveryOrder.update({ where: { id }, data: { localAddress: '   ' } }),
    ).rejects.toThrow();
  });

  it('конфликт без локальной правки и без времени невозможен', async () => {
    const snapshot = snapshotOf();
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
      select: { id: true },
    });

    await expect(
      ctx.db.deliveryOrder.update({
        where: { id: order.id },
        data: { addressConflict: true, addressConflictDetectedAt: new Date() },
      }),
    ).rejects.toThrow();

    const corrected = await seedCorrectedOrder();
    await expect(
      ctx.db.deliveryOrder.update({
        where: { id: corrected.id },
        data: { addressConflict: true },
      }),
    ).rejects.toThrow();
  });
});

describe('запрос геокодеру отличается от адреса курьеру', () => {
  it('курьер видит полный адрес, геокодер — разобранный запрос', () => {
    const order = {
      address: 'Москва, Тверская улица, 13, кв. 5, домофон 1234',
      geocodeAddress: 'Москва, Тверская улица, 13',
      localAddress: null,
    };

    // Без квартиры и домофона курьер не доедет.
    expect(effectiveAddress(order)).toBe('Москва, Тверская улица, 13, кв. 5, домофон 1234');
    // А геокодеру они мешают: он ищет дом, а не квартиру в нём.
    expect(geocodingAddress(order)).toBe('Москва, Тверская улица, 13');
  });

  it('правка логиста сильнее обоих', () => {
    const order = {
      address: 'Москва, Тверская улица, 13, кв. 5',
      geocodeAddress: 'Москва, Тверская улица, 13',
      localAddress: 'Москва, Тверская улица, 15',
    };

    // Логист подтверждал конкретный адрес: подменять его разобранным нельзя.
    expect(effectiveAddress(order)).toBe('Москва, Тверская улица, 15');
    expect(geocodingAddress(order)).toBe('Москва, Тверская улица, 15');
  });

  it('без отдельного запроса геокодер берёт адрес заказа', () => {
    // Прежнее поведение сохраняется до единого символа там, где источник
    // не включён: пустое поле означает «отдельного запроса нет».
    for (const geocodeAddress of [null, undefined, '   ']) {
      const order = { address: 'Москва, Тверская улица, 13', geocodeAddress, localAddress: null };
      expect(geocodingAddress(order), JSON.stringify(geocodeAddress)).toBe(
        'Москва, Тверская улица, 13',
      );
    }
  });

  it('смена квартиры меняет адрес курьеру, но не запрос геокодеру', () => {
    // Именно на этом держится «не геокодировать дом заново из-за квартиры»:
    // поколение растёт только при изменении запроса.
    const before = {
      address: 'Москва, Тверская улица, 13, кв. 5',
      geocodeAddress: 'Москва, Тверская улица, 13',
      localAddress: null,
    };
    const after = { ...before, address: 'Москва, Тверская улица, 13, кв. 9' };

    expect(effectiveAddress(before)).not.toBe(effectiveAddress(after));
    expect(geocodingAddress(before)).toBe(geocodingAddress(after));
  });
});

describe('запрос к геокодеру: импорт и повторы', () => {
  /** Разобранный адрес: синтетический, настоящих адресов тут нет. */
  const FULL = {
    postalCode: '141014',
    country: { name: 'Россия' },
    region: { name: 'Московская область' },
    city: 'Мытищи',
    street: 'Олимпийский проспект',
    house: '29',
    apartment: '137',
  };

  const structured = (overrides: Record<string, unknown> = {}): OrderSnapshot =>
    mapOrder(
      source({ shipmentAddressFull: FULL, ...overrides }) as never,
      IDS,
      'shipmentAddressFull',
    ).snapshot;

  it('запрос сохраняется отдельно, а адрес заказа остаётся операционным', async () => {
    const snapshot = structured();
    await applyWithQueue(snapshot);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });

    // Курьеру достаётся полный адрес источника — с квартирой.
    expect(stored.address).toBe(SOURCE_ADDRESS);
    // Геокодеру — только то, что он ищет.
    expect(stored.geocodeAddress).toBe(
      '141014, Россия, Московская область, Мытищи, Олимпийский проспект, 29',
    );
    expect(stored.geocodeAddress).not.toContain('137');
    expect(geocodingAddress(stored)).toBe(stored.geocodeAddress);
    expect(effectiveAddress(stored)).toBe(SOURCE_ADDRESS);
  });

  it('повторный импорт того же снимка не создаёт вторую ревизию', async () => {
    const snapshot = structured();
    await applyWithQueue(snapshot);

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    const revisionsBefore = await ctx.db.deliveryOrderRevision.count({
      where: { orderId: order.id },
    });

    // Тот же снимок в overlap-окне: ни ревизии, ни изменения версии.
    await apply(snapshot);

    expect(
      await ctx.db.deliveryOrderRevision.count({ where: { orderId: order.id } }),
      'повтор создал лишнюю ревизию',
    ).toBe(revisionsBefore);
    const again = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(again.version).toBe(order.version);
    expect(again.geocodeAddress).toBe(order.geocodeAddress);
  });

  it('появление запроса у существующего заказа переписывает строку', async () => {
    // Так выглядит первый проход после включения разобранного источника.
    const plain = snapshotOf();
    await apply(plain);

    const before = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: plain.externalId },
    });
    expect(before.geocodeAddress).toBeNull();

    await apply({
      ...structured(),
      externalId: plain.externalId,
      externalName: plain.externalName,
    });

    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.geocodeAddress).not.toBeNull();
    // Адрес для человека при этом не пострадал.
    expect(after.address).toBe(SOURCE_ADDRESS);
  });

  it('смена одной лишь квартиры запрос не меняет и ревизии не создаёт', async () => {
    const snapshot = structured();
    await applyWithQueue(snapshot);

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    const revisionsBefore = await ctx.db.deliveryOrderRevision.count({
      where: { orderId: order.id },
    });

    // Для геокодера это тот же дом: повторно искать его незачем.
    await apply({
      ...mapOrder(
        source({
          id: snapshot.externalId,
          name: snapshot.externalName,
          shipmentAddressFull: { ...FULL, apartment: '999' },
        }) as never,
        IDS,
        'shipmentAddressFull',
      ).snapshot,
    });

    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.geocodeAddress).toBe(order.geocodeAddress);
    expect(await ctx.db.deliveryOrderRevision.count({ where: { orderId: order.id } })).toBe(
      revisionsBefore,
    );
  });
});

describe('автоматический источник геокодирования', () => {
  const FULL = {
    postalCode: '141014',
    country: { name: 'Россия' },
    region: { name: 'Московская область' },
    city: 'Мытищи',
    street: 'Олимпийский проспект',
    house: '29',
    apartment: '137',
  };

  const structured = (overrides: Record<string, unknown> = {}): OrderSnapshot =>
    mapOrder(
      source({ shipmentAddressFull: FULL, ...overrides }) as never,
      IDS,
      'shipmentAddressFull',
    ).snapshot;

  async function jobsOf(orderId: string): Promise<number> {
    return ctx.db.orderGeocodeJob.count({ where: { orderId } });
  }

  it('старый address источником не является ни при каких условиях', () => {
    // Главное правило: по строке произвольного формата геокодер подбирает
    // похожий дом, а не находит нужный.
    expect(
      automaticGeocodingAddress({
        address: SOURCE_ADDRESS,
        geocodeAddress: null,
        localAddress: null,
      }),
    ).toBeNull();

    // А правка логиста и разобранный адрес — являются.
    expect(
      automaticGeocodingAddress({
        address: SOURCE_ADDRESS,
        geocodeAddress: null,
        localAddress: LOCAL_ADDRESS,
      }),
    ).toBe(LOCAL_ADDRESS);
    expect(
      automaticGeocodingAddress({
        address: SOURCE_ADDRESS,
        geocodeAddress: 'Тверская улица, 13',
        localAddress: null,
      }),
    ).toBe('Тверская улица, 13');

    // Правка логиста сильнее разобранного адреса: он подтверждал конкретный.
    expect(
      automaticGeocodingAddress({
        address: SOURCE_ADDRESS,
        geocodeAddress: 'Тверская улица, 13',
        localAddress: LOCAL_ADDRESS,
      }),
    ).toBe(LOCAL_ADDRESS);
  });

  it('мутация: возврат ?? address в автоматический источник ломает правило', () => {
    // Проверка с зубами. Если кто-то вернёт запасной вариант, первое же
    // утверждение выше перестанет выполняться — здесь это показано явно.
    const withFallback = (order: {
      address: string | null;
      geocodeAddress: string | null;
      localAddress: string | null;
    }): string | null => order.localAddress ?? order.geocodeAddress ?? order.address;

    const order = { address: SOURCE_ADDRESS, geocodeAddress: null, localAddress: null };
    expect(withFallback(order)).toBe(SOURCE_ADDRESS);
    expect(automaticGeocodingAddress(order)).toBeNull();
    expect(automaticGeocodingAddress(order)).not.toBe(withFallback(order));
  });

  it('новый заказ с разобранным адресом получает ровно одно задание', async () => {
    const snapshot = structured();
    await applyWithQueue(snapshot);

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    expect(await jobsOf(order.id)).toBe(1);
    expect(order.attentionReasons).not.toContain('GEOCODING_ADDRESS_INCOMPLETE');
  });

  it('новый заказ без разобранного адреса задания НЕ получает', async () => {
    // Строка `address` у него непустая — и всё равно основанием не служит.
    const snapshot = mapOrder(source() as never, IDS, 'shipmentAddressFull').snapshot;
    expect(snapshot.address).not.toBeNull();
    expect(snapshot.geocodeAddress).toBeNull();
    await applyWithQueue(snapshot);

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    expect(await jobsOf(order.id)).toBe(0);
    expect(order.attentionReasons).toContain('GEOCODING_ADDRESS_INCOMPLETE');
    expect(order.needsAttention).toBe(true);
  });

  it('повторный импорт задним числом задания не создаёт', async () => {
    const snapshot = snapshotOf();
    await applyWithQueue(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });

    await applyWithQueue(snapshot);
    expect(await jobsOf(order.id)).toBe(0);
  });

  it('пустой адрес даёт только MISSING_ADDRESS, без второй причины', async () => {
    // Состояния взаимоисключающие: «адреса нет» и «адреса мало» вместе
    // запутали бы того, кто разбирает список.
    const snapshot = snapshotOf({ shipmentAddress: '' });
    expect(snapshot.address).toBeNull();
    await applyWithQueue(snapshot);

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    expect(order.attentionReasons).toContain('MISSING_ADDRESS');
    expect(order.attentionReasons).not.toContain('GEOCODING_ADDRESS_INCOMPLETE');
    expect(await jobsOf(order.id)).toBe(0);
  });

  it('ручная правка создаёт задание по localAddress и снимает причину', async () => {
    const snapshot = mapOrder(source() as never, IDS, 'shipmentAddressFull').snapshot;
    await applyWithQueue(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    expect(order.attentionReasons).toContain('GEOCODING_ADDRESS_INCOMPLETE');

    const actor = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    await setLocalAddress(
      { db: ctx.db, config: ctx.config },
      { userId: actor.id, roles: ['LOGISTICIAN'] },
      order.id,
      { address: LOCAL_ADDRESS, point: null },
      { ip: null, userAgent: null },
    );

    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    // Ровно одно задание, и его источник — адрес логиста.
    expect(await jobsOf(order.id)).toBe(1);

    // Ложной записи «прежняя точка снята» не появилось: точки не было никогда.
    const invalidations = await ctx.db.orderGeoHistory.count({
      where: { orderId: order.id, kind: 'INVALIDATED_ADDRESS_CHANGED' },
    });
    expect(invalidations, 'записана инвалидация несуществующей точки').toBe(0);

    // Аудит правки при этом сохранён: событие произошло и должно быть видно.
    expect(
      await ctx.db.orderAddressHistory.count({
        where: { orderId: order.id, action: 'LOCAL_ADDRESS_SET' },
      }),
    ).toBe(1);
    expect(automaticGeocodingAddress(after)).toBe(LOCAL_ADDRESS);
    // Причина снята: данных теперь достаточно.
    expect(after.attentionReasons).not.toContain('GEOCODING_ADDRESS_INCOMPLETE');

    // При выключенном обработчике задание просто ждёт.
    const job = await ctx.db.orderGeocodeJob.findFirstOrThrow({ where: { orderId: order.id } });
    expect(job.attempts).toBe(0);
    expect(job.status).toBe('PENDING');
  });
  it('при существующей точке инвалидация записывается ровно одна', async () => {
    // Прежнее поведение обязано сохраниться: точка была, она снята,
    // и в истории это видно — иначе прошлое не восстановить.
    const snapshot = structured();
    await applyWithQueue(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });

    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: {
        geoState: 'RESOLVED',
        geoSource: 'PHOTON',
        geoPrecision: 'EXACT_HOUSE',
        geoLatMicro: 55_928_900,
        geoLonMicro: 37_751_900,
        geoResolvedAt: new Date(),
      },
    });

    const actor = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    await setLocalAddress(
      { db: ctx.db, config: ctx.config },
      { userId: actor.id, roles: ['LOGISTICIAN'] },
      order.id,
      { address: LOCAL_ADDRESS, point: null },
      { ip: null, userAgent: null },
    );

    const invalidations = await ctx.db.orderGeoHistory.findMany({
      where: { orderId: order.id, kind: 'INVALIDATED_ADDRESS_CHANGED' },
    });
    expect(invalidations).toHaveLength(1);
    // И в ней сохранены прежние координаты: без них запись бессмысленна.
    expect(invalidations[0]?.previousLatMicro).toBe(55_928_900);
    expect(invalidations[0]?.previousLonMicro).toBe(37_751_900);

    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.geoLatMicro).toBeNull();
  });

  it('отказ внутри правки откатывает всё: транзакция атомарна', async () => {
    const snapshot = snapshotOf();
    await applyWithQueue(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    const jobsBefore = await jobsOf(order.id);
    const historyBefore = await ctx.db.orderAddressHistory.count({ where: { orderId: order.id } });

    // Несуществующий автор: внешний ключ отклонит запись истории, и вся
    // правка обязана откатиться целиком.
    await expect(
      setLocalAddress(
        { db: ctx.db, config: ctx.config },
        { userId: '00000000-0000-4000-8000-000000000000', roles: ['LOGISTICIAN'] },
        order.id,
        { address: LOCAL_ADDRESS, point: null },
        { ip: null, userAgent: null },
      ),
    ).rejects.toThrow();

    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.localAddress).toBeNull();
    expect(await jobsOf(order.id)).toBe(jobsBefore);
    expect(await ctx.db.orderAddressHistory.count({ where: { orderId: order.id } })).toBe(
      historyBefore,
    );
  });
});
