/**
 * Критические проверки фильтра «Ожидают приёмки» по типу получения.
 *
 * Защищаемое: чипы «Все / Доставка / Самовывоз» и список говорят об одном и
 * том же наборе — счётчики совпадают с тем, что остаётся после фильтра, а
 * «Все» никогда не меньше суммы двух типов.
 */

import { describe, expect, it } from 'vitest';
import { awaitingTypeCounts, filterAwaitingByType } from './awaiting-view';

const items = [
  { orderNumber: 'A', isPickup: false },
  { orderNumber: 'B', isPickup: true },
  { orderNumber: 'C', isPickup: false },
  { orderNumber: 'D', isPickup: true },
  { orderNumber: 'E', isPickup: false },
];

describe('счётчики чипов', () => {
  it('«Все» = доставка + самовывоз', () => {
    const counts = awaitingTypeCounts(items);
    expect(counts).toEqual({ all: 5, delivery: 3, pickup: 2 });
    expect(counts.all).toBe(counts.delivery + counts.pickup);
  });

  it('пустой набор — нули', () => {
    expect(awaitingTypeCounts([])).toEqual({ all: 0, delivery: 0, pickup: 0 });
  });
});

describe('фильтр по типу', () => {
  it('«Все» возвращает набор целиком и не мутирует исходный', () => {
    const result = filterAwaitingByType(items, 'all');
    expect(result).toHaveLength(5);
    expect(result).not.toBe(items);
  });

  it('«Доставка» — только не-самовывоз', () => {
    const result = filterAwaitingByType(items, 'delivery');
    expect(result.map((item) => item.orderNumber)).toEqual(['A', 'C', 'E']);
    expect(result.every((item) => !item.isPickup)).toBe(true);
  });

  it('«Самовывоз» — только самовывоз', () => {
    const result = filterAwaitingByType(items, 'pickup');
    expect(result.map((item) => item.orderNumber)).toEqual(['B', 'D']);
    expect(result.every((item) => item.isPickup)).toBe(true);
  });

  it('счётчик типа совпадает с длиной отфильтрованного списка', () => {
    const counts = awaitingTypeCounts(items);
    expect(filterAwaitingByType(items, 'delivery')).toHaveLength(counts.delivery);
    expect(filterAwaitingByType(items, 'pickup')).toHaveLength(counts.pickup);
  });
});
