/**
 * Критические проверки выбора в «Сделках».
 *
 * Выбор общий для списка и карты, а его порядок — это порядок остановок
 * будущего маршрута. Здесь проверяется ровно то, из-за чего логист получил бы
 * не тот маршрут: порядок, перенумерация, скрытые фильтром элементы и запрет
 * выбирать непригодный заказ.
 */

import { describe, expect, it } from 'vitest';
import {
  dropUnavailable,
  intervalProblem,
  parseTimeFilter,
  selectAll,
  selectionNumber,
  summarize,
  toggleMapPoint,
  toggleSelection,
  unselectableReason,
  type DealCard,
} from './selection';

function card(overrides: Partial<DealCard> = {}): DealCard {
  return {
    id: overrides.id ?? 'o-1',
    number: overrides.number ?? 'N-1',
    address: 'Москва, синтетическая улица, дом 1',
    sourceAddress: 'Москва, синтетическая улица, дом 1',
    addressCorrected: false,
    addressConflict: false,
    recipient: 'Получатель Синтетический',
    comment: null,
    deliveryDate: '2027-05-05',
    startMinute: 600,
    endMinute: 720,
    intervalCorrected: false,
    needsAttention: false,
    attentionReasons: [],
    geoState: 'RESOLVED',
    draftRouteId: null,
    draftRouteNumber: null,
    selectable: true,
    sourceStartMinute: 600,
    sourceEndMinute: 720,
    sourceIntervalRaw: 'с 10:00 по 12:00',
    version: 1,
    assembled: false,
    ...overrides,
  };
}

describe('порядок выбора', () => {
  it('номера идут по порядку кликов, а не по порядку списка', () => {
    let selected: string[] = [];
    selected = toggleSelection(selected, card({ id: 'c' }));
    selected = toggleSelection(selected, card({ id: 'a' }));
    selected = toggleSelection(selected, card({ id: 'b' }));

    expect(selected).toEqual(['c', 'a', 'b']);
    expect(selectionNumber(selected, 'c')).toBe(1);
    expect(selectionNumber(selected, 'a')).toBe(2);
    expect(selectionNumber(selected, 'b')).toBe(3);
    expect(selectionNumber(selected, 'нет')).toBeNull();
  });

  it('снятие среднего элемента перенумеровывает оставшиеся предсказуемо', () => {
    let selected = ['a', 'b', 'c'];
    selected = toggleSelection(selected, card({ id: 'b' }));

    expect(selected).toEqual(['a', 'c']);
    expect(selectionNumber(selected, 'a')).toBe(1);
    // Порядок сохранился, номер просто сдвинулся: маршрут не переставился.
    expect(selectionNumber(selected, 'c')).toBe(2);
  });

  it('«выбрать все» дополняет выбор, не ломая уже заданный порядок', () => {
    const selected = selectAll(['c'], ['a', 'b', 'c']);
    expect(selected).toEqual(['c', 'a', 'b']);
  });
});

describe('непригодный заказ выбрать нельзя', () => {
  it('внимание, черновик и отсутствие точки названы отдельно', () => {
    expect(unselectableReason(card({ needsAttention: true }))).toBe('ATTENTION');
    expect(unselectableReason(card({ draftRouteId: 'r-1', draftRouteNumber: 'R-1' }))).toBe(
      'IN_DRAFT',
    );
    expect(unselectableReason(card({ geoState: 'PENDING' }))).toBe('NO_POINT');
    expect(unselectableReason(card())).toBeNull();
  });

  it('клик по непригодному заказу выбор не меняет', () => {
    expect(toggleSelection([], card({ needsAttention: true }))).toEqual([]);
    expect(toggleSelection([], card({ draftRouteId: 'r-1' }))).toEqual([]);
    expect(toggleSelection([], card({ geoState: 'NEEDS_REVIEW' }))).toEqual([]);
  });

  it('уже выбранный заказ снимается всегда, даже если стал непригодным', () => {
    // Иначе заказ, ставший недоступным, невозможно было бы убрать руками.
    expect(toggleSelection(['o-1'], card({ id: 'o-1', needsAttention: true }))).toEqual([]);
  });
});

describe('выбор по отметке карты', () => {
  it('не зависит от того, загружена ли карточка заказа', () => {
    // Раньше клик по отметке заказа со второй страницы списка молча ничего
    // не делал: обработчик искал заказ среди загруженных и не находил его.
    expect(toggleMapPoint([], { orderId: 'far-away', selectable: true })).toEqual(['far-away']);
  });

  it('занятый черновиком заказ отметкой не забрать', () => {
    expect(toggleMapPoint([], { orderId: 'in-draft', selectable: false })).toEqual([]);
  });

  it('повторное нажатие снимает выбор в любом случае', () => {
    // Даже если заказ успел стать непригодным: снять выбор человек вправе
    // всегда, иначе номер остался бы на карте навсегда.
    expect(toggleMapPoint(['a'], { orderId: 'a', selectable: false })).toEqual([]);
  });

  it('порядок выбора сохраняется', () => {
    let selected = toggleMapPoint([], { orderId: 'a', selectable: true });
    selected = toggleMapPoint(selected, { orderId: 'b', selectable: true });

    expect(selected).toEqual(['a', 'b']);
  });
});

describe('закреплённая сводка', () => {
  it('считает выбранные элементы, скрытые текущим фильтром', () => {
    const summary = summarize(['a', 'b', 'c'], ['a']);
    expect(summary.total).toBe(3);
    // Два заказа выбраны, но не видны: сводка обязана о них сказать, иначе
    // они уедут в расчёт незаметно.
    expect(summary.hiddenCount).toBe(2);
  });

  it('при полностью видимом выборе скрытых нет', () => {
    expect(summarize(['a'], ['a', 'b']).hiddenCount).toBe(0);
  });
});

describe('realtime снимает ставшие недоступными', () => {
  it('возвращает новый выбор и список снятых для сообщения человеку', () => {
    const result = dropUnavailable(['a', 'b', 'c'], ['b', 'нет-такого']);
    expect(result.selected).toEqual(['a', 'c']);
    expect(result.removed).toEqual(['b']);
  });
});

describe('фильтр времени', () => {
  it('разбирает ЧЧ:ММ и отвергает мусор', () => {
    expect(parseTimeFilter('10:00')).toBe(600);
    expect(parseTimeFilter('9:05')).toBe(545);
    expect(parseTimeFilter('')).toBeNull();
    expect(parseTimeFilter('25:00')).toBeNull();
    expect(parseTimeFilter('10:60')).toBeNull();
    expect(parseTimeFilter('десять')).toBeNull();
  });
});

describe('ручной интервал', () => {
  it('обе границы обязательны и окончание строго позже начала', () => {
    expect(intervalProblem('10:00', '14:00')).toBeNull();
    expect(intervalProblem('10:00', '')).toMatch(/обе границы/i);
    expect(intervalProblem('', '14:00')).toMatch(/обе границы/i);
    // Равные границы интервалом не являются: доставить «в момент» нельзя.
    expect(intervalProblem('14:00', '14:00')).toMatch(/позже начала/i);
    expect(intervalProblem('15:00', '14:00')).toMatch(/позже начала/i);
  });

  it('границы суток соблюдаются', () => {
    expect(intervalProblem('00:00', '23:59')).toBeNull();
    expect(intervalProblem('10:00', '24:00')).toMatch(/обе границы/i);
  });
});
