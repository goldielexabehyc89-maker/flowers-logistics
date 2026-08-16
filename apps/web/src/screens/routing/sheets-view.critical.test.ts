/**
 * Проверки правил экрана маршрутных листов.
 *
 * Защищаемые свойства: текущий день раскрыт, прошлые сворачиваются, отгрузка
 * без курьера недоступна и названа причиной, а отмена с доставленными заказами
 * всегда предупреждает.
 */

import { describe, expect, it } from 'vitest';
import {
  canShip,
  isDayOpen,
  needsCancelWarning,
  SECTION_TITLES,
  SHEET_SECTIONS,
  shipBlockedReason,
  toggleDay,
  type SheetView,
} from './sheets-view';

function sheet(patch: Partial<SheetView> = {}): SheetView {
  return {
    id: 'sheet-1',
    number: 'R-1',
    deliveryDate: '2026-08-15',
    state: 'CONFIRMED',
    version: 1,
    courier: { id: 'u-1', fullName: 'Иванов Иван' },
    totalOrders: 3,
    deliveredOrders: 0,
    deliveredNumbers: [],
    ...patch,
  };
}

describe('разделы', () => {
  it('три раздела в фиксированном порядке', () => {
    expect([...SHEET_SECTIONS]).toEqual(['UNSHIPPED', 'SHIPPED', 'DELIVERED']);
    expect(SECTION_TITLES.UNSHIPPED).toBe('Неотгруженные');
  });
});

describe('дни', () => {
  it('текущий день раскрыт, прошлый свёрнут', () => {
    expect(isDayOpen('2026-08-15', '2026-08-15', new Set())).toBe(true);
    expect(isDayOpen('2026-08-14', '2026-08-15', new Set())).toBe(false);
  });

  it('прошлый день раскрывается по требованию и сворачивается обратно', () => {
    const opened = toggleDay(new Set(), '2026-08-14');
    expect(isDayOpen('2026-08-14', '2026-08-15', opened)).toBe(true);
    expect(isDayOpen('2026-08-14', '2026-08-15', toggleDay(opened, '2026-08-14'))).toBe(false);
  });
});

describe('отгрузка', () => {
  it('без курьера недоступна и причина названа', () => {
    expect(canShip(sheet({ courier: null }), true)).toBe(false);
    expect(shipBlockedReason(sheet({ courier: null }), true)).toContain('курьера');
  });

  it('выключенная настройка запрещает отгрузку целиком', () => {
    expect(canShip(sheet(), false)).toBe(false);
    expect(shipBlockedReason(sheet(), false)).toContain('выключена');
  });

  it('с курьером и включённой настройкой доступна', () => {
    expect(canShip(sheet(), true)).toBe(true);
    expect(shipBlockedReason(sheet(), true)).toBeNull();
  });
});

describe('отмена отгрузки', () => {
  it('без доставленных заказов предупреждения не нужно', () => {
    expect(needsCancelWarning(sheet())).toBe(false);
  });

  it('с доставленными заказами предупреждение обязательно', () => {
    // Человек обязан увидеть их номера и выбрать, что с ними делать.
    expect(needsCancelWarning(sheet({ deliveredNumbers: ['A-1'], deliveredOrders: 1 }))).toBe(true);
  });
});
