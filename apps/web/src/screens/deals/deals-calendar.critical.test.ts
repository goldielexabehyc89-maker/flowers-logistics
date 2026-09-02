import { describe, expect, it } from 'vitest';
import {
  daysInMonth,
  isoOf,
  monthGrid,
  monthOf,
  monthTitle,
  stepMonth,
  type CalendarMonth,
} from './deals-calendar';

describe('арифметика календаря сделок', () => {
  it('месяц выбранной даты читается, битая строка — null', () => {
    expect(monthOf('2026-09-02')).toEqual({ year: 2026, month: 9 });
    expect(monthOf('')).toBeNull();
    expect(monthOf('2026-13-01')).toBeNull();
    expect(monthOf('нет')).toBeNull();
  });

  it('листание переносит год на границе декабря и января', () => {
    const december: CalendarMonth = { year: 2026, month: 12 };
    expect(stepMonth(december, 1)).toEqual({ year: 2027, month: 1 });

    const january: CalendarMonth = { year: 2026, month: 1 };
    expect(stepMonth(january, -1)).toEqual({ year: 2025, month: 12 });

    // Несколько шагов подряд не накапливают ошибку.
    expect(stepMonth(stepMonth(december, 1), 1)).toEqual({ year: 2027, month: 2 });
    expect(stepMonth(january, -13)).toEqual({ year: 2024, month: 12 });
  });

  it('заголовок называет месяц и год по-русски', () => {
    expect(monthTitle({ year: 2026, month: 9 })).toBe('Сентябрь 2026');
    expect(monthTitle({ year: 2027, month: 1 })).toBe('Январь 2027');
  });

  it('число дней учитывает високосный февраль', () => {
    expect(daysInMonth({ year: 2026, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 2028, month: 2 })).toBe(29); // високосный
    expect(daysInMonth({ year: 2026, month: 4 })).toBe(30);
    expect(daysInMonth({ year: 2026, month: 12 })).toBe(31);
  });

  it('ISO-день собирается с ведущими нулями', () => {
    expect(isoOf({ year: 2026, month: 9 }, 1)).toBe('2026-09-01');
    expect(isoOf({ year: 2026, month: 12 }, 25)).toBe('2026-12-25');
  });

  it('сетка месяца ставит дни под своими днями недели и содержит все числа', () => {
    // Сентябрь 2026: 1-е — вторник, значит первая ячейка (Пн) пустая.
    const grid = monthGrid({ year: 2026, month: 9 });
    expect(grid[0]?.[0]).toBeNull();
    expect(grid[0]?.[1]).toBe('2026-09-01');

    const flat = grid.flat();
    const days = flat.filter((cell): cell is string => cell !== null);
    expect(days).toHaveLength(30); // все дни сентября
    expect(days[0]).toBe('2026-09-01');
    expect(days[days.length - 1]).toBe('2026-09-30');
    // Ровно недели по 7 ячеек, без «рваного» хвоста.
    for (const week of grid) {
      expect(week).toHaveLength(7);
    }
  });

  it('месяц, начинающийся с понедельника, не даёт пустых ячеек в начале', () => {
    // Июнь 2026: 1-е — понедельник.
    const grid = monthGrid({ year: 2026, month: 6 });
    expect(grid[0]?.[0]).toBe('2026-06-01');
  });
});
