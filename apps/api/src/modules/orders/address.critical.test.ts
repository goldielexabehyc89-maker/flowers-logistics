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
import { addressState, effectiveAddress, geocodingAddress, isSourceConflict } from './address.js';
import { effectiveAttentionReasons } from './attention.js';

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
