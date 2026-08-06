/**
 * Критические проверки преобразований МоегоСклада.
 *
 * Здесь защищаются решения, ошибка в которых портит данные молча: принадлежность
 * заказа нашей области, источники полей без резервных вариантов, разбор интервала,
 * деньги и набор причин «Требует внимания».
 */

import { describe, expect, it } from 'vitest';
import { MOYSKLAD_IDS } from './config.js';
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
  diffSnapshots,
  mapOrder,
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
    state: { meta: { href: href('state', '22222222-2222-4222-8222-222222222222') }, name: 'Новый' },
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
        name: 'Самовывоз Завершен',
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
        name: 'Отменен',
      },
    });
    const { snapshot } = mapOrder(cancelled, IDS);

    expect(snapshot.inScope).toBe(true);
    expect(snapshot.attentionReasons).not.toContain('CASH_OVERPAYMENT');
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

  it('переплата даёт ноль и признак аномалии', () => {
    const base = order({ sum: 100000, payedSum: 150000 });
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
