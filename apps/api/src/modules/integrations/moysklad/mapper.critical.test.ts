/**
 * Критические проверки преобразований МоегоСклада.
 *
 * Здесь защищаются решения, ошибка в которых портит данные молча: принадлежность
 * заказа нашей области, источники полей без резервных вариантов, разбор интервала,
 * деньги и набор причин «Требует внимания».
 */

import { describe, expect, it } from 'vitest';
import { MOYSKLAD_IDS } from './config.js';
import { parseDeliveryDate } from './delivery-date.js';
import { parseDeliveryInterval } from './interval.js';
import {
  cashToCollect,
  fromDecimalString,
  isOverpaid,
  toDecimalString,
  toMinorUnits,
} from './money.js';
import {
  attentionReasonsFor,
  canonicalJson,
  composeStructuredAddress,
  diffSnapshots,
  mapOrder,
  SNAPSHOT_KEYS,
  snapshotHash,
  type OrderSnapshot,
} from './mapper.js';
import type { MoyskladOrderDto } from './dto.js';

const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string =>
  `https://api.moysklad.ru/api/remap/1.2/entity/${kind}/${id}`;

/** Заказ, полностью попадающий в нашу область. Поля переопределяются точечно. */
function order(overrides: Partial<MoyskladOrderDto> = {}): MoyskladOrderDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'A-1',
    updated: '2026-08-06 10:00:00.000',
    moment: '2026-08-06 09:00:00.000',
    shipmentAddress: 'Москва, тестовый адрес',
    description: 'комментарий документа, который мы НЕ импортируем',
    deliveryPlannedMoment: '2026-08-07 12:00:00.000',
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
      { id: IDS.recipientAttribute, value: 'Получатель Тестовый +70000000000' },
      { id: IDS.commentAttribute, value: 'позвонить за час' },
      {
        id: IDS.paymentTypeAttribute,
        value: {
          name: 'Оплата на сайте',
          meta: { href: href('customentity', 'aaaaaaaa-0000-4000-8000-000000000000') },
        },
      },
    ],
    ...overrides,
  } as MoyskladOrderDto;
}

/** Заменяет один пользовательский атрибут, оставляя остальные. */
function withAttribute(base: MoyskladOrderDto, id: string, value: unknown): MoyskladOrderDto {
  const attributes = (base.attributes ?? []).filter((a) => a.id !== id);
  return { ...base, attributes: [...attributes, { id, value }] } as MoyskladOrderDto;
}

describe('принадлежность заказа нашей области', () => {
  it('совпадение склада и способа доставки включает заказ', () => {
    const { snapshot } = mapOrder(order(), IDS);

    expect(snapshot.inScope).toBe(true);
    expect(snapshot.scopeExitReason).toBeNull();
    expect(snapshot.storeId).toBe(IDS.store);
    expect(snapshot.deliveryMethodId).toBe(IDS.deliveryMethodDelivery);
  });

  it('другой склад выводит заказ из области', () => {
    const other = order({
      store: { meta: { href: href('store', '33333333-3333-4333-8333-333333333333') } },
    });
    const { snapshot } = mapOrder(other, IDS);

    expect(snapshot.inScope).toBe(false);
    expect(snapshot.scopeExitReason).toBe('STORE_CHANGED');
  });

  it('другой способ доставки выводит заказ из области', () => {
    const base = order();
    const other = withAttribute(base, IDS.deliveryMethodAttribute, {
      name: 'Самовывоз',
      meta: { href: href('customentity', '76f4977e-d33e-11ef-0a80-03b6000e555e') },
    });
    const { snapshot } = mapOrder(other, IDS);

    expect(snapshot.inScope).toBe(false);
    expect(snapshot.scopeExitReason).toBe('DELIVERY_METHOD_CHANGED');
  });

  it('незаполненный способ доставки не считается доставкой', () => {
    const base = order();
    const without = {
      ...base,
      attributes: (base.attributes ?? []).filter((a) => a.id !== IDS.deliveryMethodAttribute),
    };
    const { snapshot } = mapOrder(without as MoyskladOrderDto, IDS);

    expect(snapshot.inScope).toBe(false);
    expect(snapshot.deliveryMethodId).toBeNull();
  });

  it('название статуса «Самовывоз Завершен» на область не влияет', () => {
    // В контрольной выборке такие заказы реально встречались со способом «Доставка».
    const withState = order({
      state: {
        meta: { href: href('state', '7bd65371-176f-11ee-0a80-13af00160cb5') },
        id: '7bd65371-176f-11ee-0a80-13af00160cb5',
        name: 'Самовывоз Завершен',
        stateType: 'Regular',
      },
    });
    const { snapshot } = mapOrder(withState, IDS);

    expect(snapshot.inScope).toBe(true);
    expect(snapshot.externalStateName).toBe('Самовывоз Завершен');
  });

  it('неуспешный статус сам по себе заказ не исключает', () => {
    const cancelled = order({
      state: {
        meta: { href: href('state', '45533b00-2ea3-11ed-0a80-09c5000d6027') },
        id: '45533b00-2ea3-11ed-0a80-09c5000d6027',
        name: 'Отменен',
        stateType: 'Unsuccessful',
      },
    });
    const { snapshot } = mapOrder(cancelled, IDS);

    expect(snapshot.inScope).toBe(true);
    expect(snapshot.attentionReasons).not.toContain('CASH_OVERPAYMENT');
  });
});

describe('две области одного заказа', () => {
  const PICKUP = {
    name: 'Самовывоз',
    meta: { href: href('customentity', '76f4977e-d33e-11ef-0a80-03b6000e555e') },
  };

  it('доставка утверждённого склада попадает в обе области', () => {
    const { snapshot } = mapOrder(order(), IDS);

    expect(snapshot.inScope).toBe(true);
    expect(snapshot.fulfillmentInScope).toBe(true);
    expect(snapshot.scopeExitReason).toBeNull();
  });

  it('самовывоз того же склада выходит только из логистической области', () => {
    const { snapshot } = mapOrder(withAttribute(order(), IDS.deliveryMethodAttribute, PICKUP), IDS);

    expect(snapshot.inScope).toBe(false);
    // Букет собирают одинаково и для доставки, и для самовывоза.
    expect(snapshot.fulfillmentInScope).toBe(true);
    // Смысл причины выхода прежний, логистический: производственным статусом
    // она не становится.
    expect(snapshot.scopeExitReason).toBe('DELIVERY_METHOD_CHANGED');
  });

  it('другой и незаполненный способ получения ведут себя так же, как самовывоз', () => {
    const another = withAttribute(order(), IDS.deliveryMethodAttribute, {
      name: 'Курьерская служба',
      meta: { href: href('customentity', '99999999-9999-4999-8999-999999999999') },
    });
    const base = order();
    const missing = {
      ...base,
      attributes: (base.attributes ?? []).filter((a) => a.id !== IDS.deliveryMethodAttribute),
    } as MoyskladOrderDto;

    for (const source of [another, missing]) {
      const { snapshot } = mapOrder(source, IDS);
      expect(snapshot.inScope).toBe(false);
      expect(snapshot.fulfillmentInScope).toBe(true);
    }
  });

  it('чужой склад и архив выводят заказ из обеих областей', () => {
    const foreign = mapOrder(
      order({ store: { meta: { href: href('store', '33333333-3333-4333-8333-333333333333') } } }),
      IDS,
    ).snapshot;
    const inArchive = mapOrder(order({ archived: true }), IDS).snapshot;

    expect(foreign.inScope).toBe(false);
    expect(foreign.fulfillmentInScope).toBe(false);
    expect(inArchive.inScope).toBe(false);
    expect(inArchive.fulfillmentInScope).toBe(false);
  });

  it('архив утверждённого склада важнее способа получения', () => {
    const { snapshot } = mapOrder(
      withAttribute(order({ archived: true }), IDS.deliveryMethodAttribute, PICKUP),
      IDS,
    );

    expect(snapshot.fulfillmentInScope).toBe(false);
  });

  it('производственная область строго шире логистической', () => {
    // Сочетание «в логистике, но не в производстве» невозможно по построению.
    const variants = [
      order(),
      order({ archived: true }),
      order({ store: { meta: { href: href('store', '33333333-3333-4333-8333-333333333333') } } }),
      withAttribute(order(), IDS.deliveryMethodAttribute, PICKUP),
    ];

    for (const source of variants) {
      const { snapshot } = mapOrder(source, IDS);
      expect(snapshot.inScope && !snapshot.fulfillmentInScope).toBe(false);
    }
  });

  it('признак производственной области входит в канонический снимок и хеш', () => {
    const byDelivery = mapOrder(order(), IDS).snapshot;
    const byPickup = mapOrder(
      withAttribute(order(), IDS.deliveryMethodAttribute, PICKUP),
      IDS,
    ).snapshot;

    expect(canonicalJson(byDelivery)).toContain('"fulfillmentInScope":true');
    expect(diffSnapshots(byDelivery, byPickup)).toContain('inScope');
    expect(snapshotHash(byDelivery)).not.toBe(snapshotHash(byPickup));

    // Ключ стоит сразу после inScope: порядок ключей входит в хеш, и его
    // перестановка обесценила бы все сохранённые ревизии разом.
    const keys = Object.keys(JSON.parse(canonicalJson(byDelivery)) as Record<string, unknown>);
    expect(keys.indexOf('fulfillmentInScope')).toBe(keys.indexOf('inScope') + 1);
  });

  it('расширение снимка даёт ровно одну объяснимую ревизию, а не чередование хешей', () => {
    // Снимок прежнего формата: поля производственной области в нём ещё нет.
    const stored = { ...mapOrder(order(), IDS).snapshot } as Record<string, unknown>;
    delete stored['fulfillmentInScope'];

    const fresh = mapOrder(order(), IDS).snapshot;

    // Первый проход после обновления видит ровно одно изменившееся поле.
    expect(diffSnapshots(stored as unknown as OrderSnapshot, fresh)).toEqual([
      'fulfillmentInScope',
    ]);
    // Второй проход по тем же данным не видит ничего: чередования нет.
    expect(diffSnapshots(fresh, mapOrder(order(), IDS).snapshot)).toEqual([]);
    expect(snapshotHash(fresh)).toBe(snapshotHash(mapOrder(order(), IDS).snapshot));
  });
});

describe('источники полей без резервных вариантов', () => {
  it('адрес, получатель и комментарий берутся только из утверждённых источников', () => {
    const { snapshot } = mapOrder(order(), IDS);

    expect(snapshot.address).toBe('Москва, тестовый адрес');
    expect(snapshot.recipient).toBe('Получатель Тестовый +70000000000');
    expect(snapshot.comment).toBe('позвонить за час');
    // description документа не является нашим комментарием.
    expect(snapshot.comment).not.toContain('комментарий документа');
  });

  it('при пустых источниках поля пусты, а не подставлены из похожих', () => {
    const base = order({ shipmentAddress: undefined });
    const stripped = {
      ...base,
      attributes: (base.attributes ?? []).filter(
        (a) => a.id !== IDS.recipientAttribute && a.id !== IDS.commentAttribute,
      ),
      // Поля, которые нельзя использовать как fallback.
      agent: {
        meta: { href: href('counterparty', '44444444-4444-4444-8444-444444444444') },
        phone: '+79990000000',
      },
    };
    const { snapshot } = mapOrder(stripped as MoyskladOrderDto, IDS);

    expect(snapshot.address).toBeNull();
    expect(snapshot.recipient).toBeNull();
    expect(snapshot.comment).toBeNull();
    expect(canonicalJson(snapshot)).not.toContain('+79990000000');
  });

  it('получатель не разделяется на имя и телефон', () => {
    const { snapshot } = mapOrder(order(), IDS);
    expect(snapshot.recipient).toBe('Получатель Тестовый +70000000000');
  });
});

describe('разбор интервала', () => {
  it('распознаёт утверждённые форматы', () => {
    const cases: [string, number, number][] = [
      ['с 16:00 по 19:00', 16 * 60, 19 * 60],
      ['13:47 до 14:17', 13 * 60 + 47, 14 * 60 + 17],
      ['12:00 - 15:00', 12 * 60, 15 * 60],
      ['С 14:00 до 16:00', 14 * 60, 16 * 60],
      ['12:00 – 15:00', 12 * 60, 15 * 60],
      ['12:00 — 15:00', 12 * 60, 15 * 60],
      ['  09:30-10:00  ', 9 * 60 + 30, 10 * 60],
    ];

    for (const [input, start, end] of cases) {
      const parsed = parseDeliveryInterval(input);
      expect(parsed.kind, input).toBe('RANGE');
      expect(parsed.startMinute, input).toBe(start);
      expect(parsed.endMinute, input).toBe(end);
      expect(parsed.raw, input).toBe(input);
    }
  });

  it('одиночное время остаётся точным и не превращается в диапазон', () => {
    const parsed = parseDeliveryInterval('14:30');

    expect(parsed.kind).toBe('EXACT');
    expect(parsed.startMinute).toBe(14 * 60 + 30);
    expect(parsed.endMinute).toBeNull();
  });

  it('пустое значение и отсутствие дают MISSING', () => {
    expect(parseDeliveryInterval(null).kind).toBe('MISSING');
    expect(parseDeliveryInterval(undefined).kind).toBe('MISSING');
    expect(parseDeliveryInterval('   ').kind).toBe('MISSING');
  });

  it('произвольный текст не превращается в интервал', () => {
    for (const input of [
      'позвонить за 15 минут',
      'после 18',
      'вечером',
      '25:00 - 26:00',
      '12:60-13:00',
    ]) {
      const parsed = parseDeliveryInterval(input);
      expect(parsed.kind, input).toBe('UNRECOGNIZED');
      expect(parsed.startMinute, input).toBeNull();
      expect(parsed.raw, input).toBe(input);
    }
  });

  it('обратный и нулевой диапазон не распознаются', () => {
    expect(parseDeliveryInterval('с 19:00 по 16:00').kind).toBe('UNRECOGNIZED');
    expect(parseDeliveryInterval('14:00 - 14:00').kind).toBe('UNRECOGNIZED');
  });

  it('границы времени принимаются корректно', () => {
    expect(parseDeliveryInterval('00:00 - 23:59')).toMatchObject({
      kind: 'RANGE',
      startMinute: 0,
      endMinute: 23 * 60 + 59,
    });
  });
});

describe('деньги', () => {
  it('сумма к получению считается целыми копейками', () => {
    expect(cashToCollect(499000n, 0n)).toBe(499000n);
    expect(cashToCollect(499000n, 100000n)).toBe(399000n);
  });

  it('полная оплата даёт ноль', () => {
    expect(cashToCollect(669000n, 669000n)).toBe(0n);
    expect(isOverpaid(669000n, 669000n)).toBe(false);
  });

  it('переплата наличными даёт ноль и признак аномалии', () => {
    // Аномалия имеет смысл только там, где курьер вообще берёт деньги,
    // поэтому тип оплаты обязан быть наличным.
    const base = withAttribute(order({ sum: 100000, payedSum: 150000 }), IDS.paymentTypeAttribute, {
      name: 'Наличные/карта на ТТ',
      meta: { href: href('customentity', IDS.paymentTypeCash) },
    });
    const { snapshot } = mapOrder(base, IDS);

    expect(snapshot.cashToCollectMinor).toBe('0');
    expect(snapshot.cashAnomaly).toBe(true);
    expect(snapshot.attentionReasons).toContain('CASH_OVERPAYMENT');
  });

  it('долг курьеру возникает только при точном типе оплаты «Наличные/карта на ТТ»', () => {
    const online = mapOrder(order(), IDS).snapshot;
    expect(online.cashCollectable).toBe(false);

    const cash = withAttribute(order(), IDS.paymentTypeAttribute, {
      name: 'Наличные/карта на ТТ',
      meta: { href: href('customentity', IDS.paymentTypeCash) },
    });
    expect(mapOrder(cash, IDS).snapshot.cashCollectable).toBe(true);
  });

  it('дробное и небезопасное значение отвергается, а не округляется', () => {
    expect(() => toMinorUnits(1234.5)).toThrow();
    expect(() => toMinorUnits(Number.MAX_SAFE_INTEGER + 2)).toThrow();
    expect(() => toMinorUnits('499000')).toThrow();
  });

  it('денежный контракт JSON — десятичная строка без потери точности', () => {
    expect(toDecimalString(499000n)).toBe('4990.00');
    expect(toDecimalString(0n)).toBe('0.00');
    expect(toDecimalString(5n)).toBe('0.05');
    expect(fromDecimalString('4990.00')).toBe(499000n);
    // Значение крупнее безопасного целого JavaScript проходит без искажения.
    expect(fromDecimalString(toDecimalString(90071992547409910n))).toBe(90071992547409910n);
  });
});

describe('причины «Требует внимания»', () => {
  it('полный заказ не требует внимания', () => {
    const { snapshot } = mapOrder(order(), IDS);
    expect(snapshot.attentionReasons).toEqual([]);
  });

  it('недостающие обязательные поля дают точный набор причин', () => {
    const base = order({ shipmentAddress: undefined, deliveryPlannedMoment: undefined });
    const stripped = {
      ...base,
      attributes: (base.attributes ?? []).filter(
        (a) => a.id !== IDS.recipientAttribute && a.id !== IDS.intervalAttribute,
      ),
    };
    const { snapshot } = mapOrder(stripped as MoyskladOrderDto, IDS);

    expect(snapshot.attentionReasons).toEqual([
      'MISSING_DELIVERY_DATE',
      'MISSING_INTERVAL',
      'MISSING_ADDRESS',
      'MISSING_RECIPIENT',
    ]);
  });

  it('нераспознанный интервал отличается от отсутствующего', () => {
    const weird = withAttribute(order(), IDS.intervalAttribute, 'после обеда');
    const { snapshot } = mapOrder(weird, IDS);

    expect(snapshot.attentionReasons).toContain('UNRECOGNIZED_INTERVAL');
    expect(snapshot.attentionReasons).not.toContain('MISSING_INTERVAL');
    expect(snapshot.intervalRaw).toBe('после обеда');
  });

  it('отсутствующий комментарий причиной не является', () => {
    const base = order();
    const without = {
      ...base,
      attributes: (base.attributes ?? []).filter((a) => a.id !== IDS.commentAttribute),
    };
    const { snapshot } = mapOrder(without as MoyskladOrderDto, IDS);

    expect(snapshot.comment).toBeNull();
    expect(snapshot.attentionReasons).toEqual([]);
  });

  it('причины детерминированы и не зависят от статуса', () => {
    const snapshot = mapOrder(order(), IDS).snapshot;
    const withOtherState: OrderSnapshot = { ...snapshot, externalStateName: 'Отменен' };

    expect(attentionReasonsFor(withOtherState)).toEqual(attentionReasonsFor(snapshot));
  });
});

describe('канонический снимок и diff', () => {
  it('порядок полей в ответе API не создаёт ложного изменения', () => {
    const straight = mapOrder(order(), IDS).snapshot;

    const base = order();
    const reordered = {
      payedSum: base.payedSum,
      sum: base.sum,
      state: base.state,
      store: base.store,
      attributes: [...(base.attributes ?? [])].reverse(),
      deliveryPlannedMoment: base.deliveryPlannedMoment,
      shipmentAddress: base.shipmentAddress,
      moment: base.moment,
      updated: base.updated,
      name: base.name,
      id: base.id,
      description: base.description,
    } as MoyskladOrderDto;

    const shuffled = mapOrder(reordered, IDS).snapshot;

    expect(snapshotHash(shuffled)).toBe(snapshotHash(straight));
    expect(diffSnapshots(straight, shuffled)).toEqual([]);
  });

  it('неизвестные поля API игнорируются и снимок не меняют', () => {
    const extended = {
      ...order(),
      somethingNew: { nested: true },
      vatSum: 12345,
    } as MoyskladOrderDto;

    expect(snapshotHash(mapOrder(extended, IDS).snapshot)).toBe(
      snapshotHash(mapOrder(order(), IDS).snapshot),
    );
  });

  it('изменение каждого импортируемого поля попадает в diff', () => {
    const previous = mapOrder(order(), IDS).snapshot;

    const cases: [Partial<MoyskladOrderDto>, keyof OrderSnapshot][] = [
      [{ name: 'A-2' }, 'externalName'],
      [{ updated: '2026-08-06 11:00:00.000' }, 'externalUpdated'],
      [{ moment: '2026-08-06 10:30:00.000' }, 'externalMoment'],
      [{ shipmentAddress: 'Москва, другой адрес' }, 'address'],
      [{ deliveryPlannedMoment: '2026-08-08 12:00:00.000' }, 'deliveryDateRaw'],
      [{ sum: 500000 }, 'sumMinor'],
      [{ payedSum: 100000 }, 'payedSumMinor'],
      [{ archived: true }, 'sourceArchived'],
    ];

    for (const [override, field] of cases) {
      const changed = mapOrder(order(override), IDS).snapshot;
      expect(diffSnapshots(previous, changed), field).toContain(field);
    }

    const recipientChanged = mapOrder(
      withAttribute(order(), IDS.recipientAttribute, 'Другой получатель'),
      IDS,
    ).snapshot;
    expect(diffSnapshots(previous, recipientChanged)).toContain('recipient');

    const intervalChanged = mapOrder(
      withAttribute(order(), IDS.intervalAttribute, '10:00 - 12:00'),
      IDS,
    ).snapshot;
    expect(diffSnapshots(previous, intervalChanged)).toContain('intervalStartMinute');
  });

  it('первая ревизия помечает все поля изменившимися', () => {
    const snapshot = mapOrder(order(), IDS).snapshot;
    expect(diffSnapshots(null, snapshot).length).toBeGreaterThan(20);
  });
});

describe('внешний статус сохраняется полностью', () => {
  it('UUID, название и stateType попадают в снимок', () => {
    const { snapshot } = mapOrder(order(), IDS);

    expect(snapshot.externalStateId).toBe('22222222-2222-4222-8222-222222222222');
    expect(snapshot.externalStateName).toBe('Новый');
    expect(snapshot.externalStateType).toBe('Regular');
  });

  it('stateType не влияет ни на область, ни на причины внимания', () => {
    const unsuccessful = order({
      state: {
        meta: { href: href('state', '45533b00-2ea3-11ed-0a80-09c5000d6027') },
        id: '45533b00-2ea3-11ed-0a80-09c5000d6027',
        name: 'Отменен',
        stateType: 'Unsuccessful',
      },
    });
    const { snapshot } = mapOrder(unsuccessful, IDS);

    expect(snapshot.externalStateType).toBe('Unsuccessful');
    expect(snapshot.inScope).toBe(true);
    expect(snapshot.attentionReasons).toEqual([]);
  });

  it('изменение статуса попадает в diff', () => {
    const previous = mapOrder(order(), IDS).snapshot;
    const changed = mapOrder(
      order({
        state: {
          meta: { href: href('state', '4cf29373-38f4-11ed-0a80-0c0500153e5a') },
          id: '4cf29373-38f4-11ed-0a80-0c0500153e5a',
          name: 'Завершен',
          stateType: 'Successful',
        },
      }),
      IDS,
    ).snapshot;

    const diff = diffSnapshots(previous, changed);
    expect(diff).toContain('externalStateId');
    expect(diff).toContain('externalStateName');
    expect(diff).toContain('externalStateType');
  });
});

describe('наличные возникают только при точном типе оплаты', () => {
  /** Оплата, при которой курьер принимает деньги. */
  const cash = (overrides: Partial<MoyskladOrderDto> = {}) =>
    withAttribute(order(overrides), IDS.paymentTypeAttribute, {
      name: 'Наличные/карта на ТТ',
      meta: { href: href('customentity', IDS.paymentTypeCash) },
    });

  it('другой тип оплаты при неполной оплате не создаёт долга курьеру', () => {
    const { snapshot } = mapOrder(order({ sum: 500000, payedSum: 100000 }), IDS);

    expect(snapshot.cashCollectable).toBe(false);
    expect(snapshot.cashToCollectMinor).toBe('0');
  });

  it('другой тип оплаты при переплате не создаёт денежной аномалии', () => {
    const { snapshot } = mapOrder(order({ sum: 100000, payedSum: 150000 }), IDS);

    expect(snapshot.cashCollectable).toBe(false);
    expect(snapshot.cashAnomaly).toBe(false);
    expect(snapshot.attentionReasons).not.toContain('CASH_OVERPAYMENT');
    expect(snapshot.cashToCollectMinor).toBe('0');
  });

  it('наличные при неполной оплате дают долг курьеру', () => {
    const { snapshot } = mapOrder(cash({ sum: 500000, payedSum: 100000 }), IDS);

    expect(snapshot.cashCollectable).toBe(true);
    expect(snapshot.cashToCollectMinor).toBe('400000');
    expect(snapshot.cashAnomaly).toBe(false);
  });

  it('наличные при переплате дают ноль и аномалию', () => {
    const { snapshot } = mapOrder(cash({ sum: 100000, payedSum: 150000 }), IDS);

    expect(snapshot.cashToCollectMinor).toBe('0');
    expect(snapshot.cashAnomaly).toBe(true);
    expect(snapshot.attentionReasons).toContain('CASH_OVERPAYMENT');
  });
});

describe('плановая дата — календарная дата Москвы', () => {
  it('отсутствующая дата даёт MISSING и причину внимания', () => {
    const { snapshot } = mapOrder(order({ deliveryPlannedMoment: undefined }), IDS);

    expect(snapshot.deliveryDate).toBeNull();
    expect(snapshot.deliveryDateRaw).toBeNull();
    expect(snapshot.attentionReasons).toContain('MISSING_DELIVERY_DATE');
    expect(snapshot.attentionReasons).not.toContain('UNRECOGNIZED_DELIVERY_DATE');
  });

  it('обычная дата берётся из строки без пересчёта', () => {
    const { snapshot } = mapOrder(order({ deliveryPlannedMoment: '2026-08-07 12:00:00.000' }), IDS);

    expect(snapshot.deliveryDate).toBe('2026-08-07');
    expect(snapshot.deliveryDateRaw).toBe('2026-08-07 12:00:00.000');
    expect(snapshot.attentionReasons).toEqual([]);
  });

  it('значения у границ суток остаются в своём дне', () => {
    // Именно здесь пересчёт через UTC перенёс бы доставку на соседний день:
    // Москва опережает UTC на три часа.
    expect(parseDeliveryDate('2026-08-07 00:15:00.000').date).toBe('2026-08-07');
    expect(parseDeliveryDate('2026-08-07 23:45:00.000').date).toBe('2026-08-07');
    expect(parseDeliveryDate('2026-01-01 02:00:00.000').date).toBe('2026-01-01');
    expect(parseDeliveryDate('2025-12-31 23:59:59.999').date).toBe('2025-12-31');
  });

  it('непустое неразбираемое значение поднимает заказ в «Требует внимания»', () => {
    for (const raw of [
      'завтра',
      '07.08.2026',
      '2026-13-01 10:00:00.000',
      '2026-02-30 10:00:00.000',
    ]) {
      const { snapshot } = mapOrder(order({ deliveryPlannedMoment: raw }), IDS);

      expect(snapshot.deliveryDate, raw).toBeNull();
      expect(snapshot.deliveryDateRaw, raw).toBe(raw);
      expect(snapshot.attentionReasons, raw).toContain('UNRECOGNIZED_DELIVERY_DATE');
      expect(snapshot.attentionReasons, raw).not.toContain('MISSING_DELIVERY_DATE');
    }
  });

  it('дата без времени принимается', () => {
    expect(parseDeliveryDate('2026-08-07').date).toBe('2026-08-07');
  });
});

describe('адрес курьеру и запрос геокодеру — разные значения', () => {
  const full = {
    postalCode: '141014',
    country: { name: 'Россия' },
    region: { name: 'Московская область' },
    city: 'Мытищи',
    street: 'Олимпийский проспект',
    house: '29',
    apartment: '137',
    addInfo: 'код домофона 1234',
    comment: 'позвонить за час',
  };

  it('без настройки отдельного запроса нет, адрес прежний', () => {
    const mapped = mapOrder(order({ shipmentAddressFull: full } as never), IDS);
    expect(mapped.snapshot.address).toBe('Москва, тестовый адрес');
    expect(mapped.snapshot.geocodeAddress).toBeNull();
  });

  it('при включённом источнике адрес курьеру НЕ меняется', () => {
    // Главное свойство: что бы ни делал геокодер, курьеру нужен операционный
    // адрес целиком — с квартирой, подъездом и домофоном.
    const mapped = mapOrder(
      order({ shipmentAddressFull: full } as never),
      IDS,
      'shipmentAddressFull',
    );
    expect(mapped.snapshot.address).toBe('Москва, тестовый адрес');
  });

  it('запрос геокодеру собирается только из нужных частей', () => {
    const mapped = mapOrder(
      order({ shipmentAddressFull: full } as never),
      IDS,
      'shipmentAddressFull',
    );
    expect(mapped.snapshot.geocodeAddress).toBe(
      '141014, Россия, Московская область, Мытищи, Олимпийский проспект, 29',
    );
    for (const excluded of ['137', 'домофон', '1234', 'позвонить']) {
      expect(mapped.snapshot.geocodeAddress, excluded).not.toContain(excluded);
    }
  });

  it('без улицы или дома запроса нет, и адрес заказа его не подменяет', () => {
    const mapped = mapOrder(
      order({ shipmentAddressFull: { ...full, house: undefined } } as never),
      IDS,
      'shipmentAddressFull',
    );
    expect(mapped.snapshot.geocodeAddress).toBeNull();
    // Адрес курьеру при этом на месте.
    expect(mapped.snapshot.address).toBe('Москва, тестовый адрес');
  });
});

describe('сборка адреса для геокодера', () => {
  /**
   * Разобранный адрес МоегоСклада. Синтетический: настоящих адресов тут нет.
   *
   * Функция готова, но НЕ подключена: хранить собранную строку отдельно
   * от операционного адреса пока негде — свободного поля в модели нет,
   * а класть её в `address` значило бы потерять квартиру и домофон,
   * которые нужны курьеру.
   */
  const full = {
    postalCode: '141014',
    country: { name: 'Россия' },
    region: { name: 'Московская область' },
    city: 'Мытищи',
    street: 'Олимпийский проспект',
    house: '29',
    apartment: '137',
    addInfo: 'код домофона 1234',
    comment: 'позвонить за час',
  };

  it('адрес заказа остаётся операционным: квартира не теряется', () => {
    // Что бы ни делал геокодер, курьеру нужен полный адрес.
    const mapped = mapOrder(order({ shipmentAddressFull: full } as never), IDS);
    expect(mapped.snapshot.address).toBe('Москва, тестовый адрес');
  });

  it('в запрос к геокодеру входят только части, которые он ищет', () => {
    expect(composeStructuredAddress(full as never)).toBe(
      '141014, Россия, Московская область, Мытищи, Олимпийский проспект, 29',
    );

    // Квартира, домофон и комментарий не входят: геокодер ищет дом,
    // а не квартиру в нём, и лишние слова только уводят поиск.
    const query = composeStructuredAddress(full as never) ?? '';
    for (const excluded of ['137', 'домофон', '1234', 'позвонить']) {
      expect(query, excluded).not.toContain(excluded);
    }
  });

  it('без улицы или дома запроса нет, и запасной вариант не подставляется', () => {
    for (const missing of [{ street: undefined }, { house: undefined }]) {
      expect(
        composeStructuredAddress({ ...full, ...missing } as never),
        JSON.stringify(missing),
      ).toBeNull();
    }
    expect(composeStructuredAddress(undefined)).toBeNull();
  });

  it('пропущенные необязательные части просто не попадают в строку', () => {
    expect(composeStructuredAddress({ street: 'Тверская улица', house: '13' } as never)).toBe(
      'Тверская улица, 13',
    );
  });

  it('смена дома меняет запрос, смена квартиры — нет', () => {
    const base = composeStructuredAddress(full as never);
    expect(composeStructuredAddress({ ...full, house: '31' } as never)).not.toBe(base);
    // Для геокодера это тот же дом, и повторный запрос ничего не изменил бы.
    expect(composeStructuredAddress({ ...full, apartment: '999' } as never)).toBe(base);
  });
});

describe('полнота списка полей снимка', () => {
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

  /*
   * Оба снимка сняты с ОДНОГО заказа: различается только источник запроса.
   *
   * Разобранные части присутствуют в обоих — их маппер собирает всегда,
   * независимо от источника и версии контракта. Так проверка и остаётся
   * проверкой одного поля: убери мы части из «до», отличий стало бы три,
   * и утверждение «изменилось ровно одно» доказывало бы совсем другое.
   */
  const withQuery = (): OrderSnapshot =>
    mapOrder(order({ shipmentAddressFull: FULL } as never), IDS, 'shipmentAddressFull').snapshot;
  const withoutQuery = (): OrderSnapshot =>
    mapOrder(order({ shipmentAddressFull: FULL } as never), IDS).snapshot;

  it('запрос к геокодеру входит в список полей снимка', () => {
    // Через этот список работают сравнение снимков, канонический JSON и хеш.
    // Поле, добавленное в тип, но не сюда, было бы невидимо для всех троих.
    expect(SNAPSHOT_KEYS).toContain('geocodeAddress');
    expect(SNAPSHOT_KEYS).toContain('address');
    // Рабочий адрес и детали нового контракта — там же. Поля, невидимого для
    // сравнения снимков, изменение источника не достигло бы вовсе: заказ
    // считался бы неизменившимся, и новая квартира не доехала бы до карточки.
    expect(SNAPSHOT_KEYS).toContain('structuredAddress');
    expect(SNAPSHOT_KEYS).toContain('addressDetails');
    // А версии контракта в снимке нет и быть не должно: это наше решение
    // о переходе, а не данные МоегоСклада.
    expect(SNAPSHOT_KEYS).not.toContain('addressContractVersion');
  });

  it('изменение ОДНОГО лишь запроса геокодера видно в changedFields', () => {
    const before = withoutQuery();
    const after = withQuery();

    // Отличаются ровно одним полем — и оно названо.
    expect(diffSnapshots(before, after)).toEqual(['geocodeAddress']);
  });

  it('вместе с полем меняются канонический JSON и хеш', () => {
    const before = withoutQuery();
    const after = withQuery();

    expect(canonicalJson(before)).not.toBe(canonicalJson(after));
    expect(snapshotHash(before)).not.toBe(snapshotHash(after));
    // Именно на хеше держится дедупликация: без его изменения повтор
    // в overlap-окне считался бы той же версией, и строка не переписалась бы.
    expect(canonicalJson(after)).toContain('geocodeAddress');
  });

  it('одинаковое значение изменением не считается', () => {
    const a = withQuery();
    const b = withQuery();

    expect(diffSnapshots(a, b)).toEqual([]);
    expect(snapshotHash(a)).toBe(snapshotHash(b));
  });

  it('отсутствующий ключ старого снимка и null — одно и то же', () => {
    // Снимки, сохранённые до появления поля, ключа не содержат вовсе.
    // Если считать это отличием от `null`, первый же проход объявит
    // изменившимся КАЖДЫЙ заказ — включая те, у которых значения нет и не будет.
    const legacy: Record<string, unknown> = { ...withoutQuery() };
    delete legacy['geocodeAddress'];

    expect(diffSnapshots(legacy as unknown as OrderSnapshot, withoutQuery())).toEqual([]);

    // А появление настоящего значения изменением быть обязано.
    expect(diffSnapshots(legacy as unknown as OrderSnapshot, withQuery())).toEqual([
      'geocodeAddress',
    ]);
  });
});
