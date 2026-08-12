/**
 * Критические проверки единого часового пояса.
 *
 * Ошибка здесь не видна глазом и появляется только у части пользователей:
 * логист в Москве и владелец в поездке видят один и тот же заказ разными днями,
 * а «сегодня» на границе полуночи расходится между экраном и сервером.
 *
 * Поэтому проверяются ровно две вещи: московская граница суток и независимость
 * результата от часового пояса среды. Тесты не зависят от фактической даты
 * запуска — все моменты заданы явно.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_TIME_VALUE,
  formatCalendarDate,
  formatMinutesOfDay,
  formatMoscowDateTime,
  formatMoscowTime,
  moscowCalendarDate,
  moscowToday,
  MOSCOW_LOCALE,
  MOSCOW_TIME_ZONE,
  shiftCalendarDate,
} from './time.js';

/**
 * Часовые пояса, в которых сегодня разные даты.
 *
 * `America/Los_Angeles` выбран намеренно: в момент московского полудня там
 * ещё вчерашний день, и любая функция, полагающаяся на локальные геттеры,
 * ошибётся на сутки.
 */
const FOREIGN_ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Kamchatka'];

describe('граница московских суток', () => {
  it('20:59:59Z — ещё прежний день Москвы, 21:00:00Z — уже следующий', () => {
    expect(moscowCalendarDate(new Date('2026-08-11T20:59:59.999Z'))).toBe('2026-08-11');
    expect(moscowCalendarDate(new Date('2026-08-11T21:00:00.000Z'))).toBe('2026-08-12');
  });

  it('граница года: 31 декабря 21:00Z — уже первое января', () => {
    expect(moscowCalendarDate(new Date('2026-12-31T20:59:59.000Z'))).toBe('2026-12-31');
    expect(moscowCalendarDate(new Date('2026-12-31T21:00:00.000Z'))).toBe('2027-01-01');
  });

  it('високосный февраль считается календарно', () => {
    expect(moscowCalendarDate(new Date('2028-02-28T21:00:00.000Z'))).toBe('2028-02-29');
    expect(moscowCalendarDate(new Date('2028-02-29T21:00:00.000Z'))).toBe('2028-03-01');
    // Невисокосный год той же датой границы даёт первое марта.
    expect(moscowCalendarDate(new Date('2027-02-28T21:00:00.000Z'))).toBe('2027-03-01');
  });

  it('соседний день считается по календарю, а не прибавлением суток к моменту', () => {
    expect(shiftCalendarDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftCalendarDate('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftCalendarDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftCalendarDate('2027-02-28', 1)).toBe('2027-03-01');
  });

  it('«сегодня» берёт тот же момент, что и календарная дата', () => {
    const instant = new Date('2026-08-11T21:00:00.000Z');
    expect(moscowToday(instant)).toBe(moscowCalendarDate(instant));
    expect(moscowToday(instant)).toBe('2026-08-12');
  });
});

describe('результат не зависит от часового пояса среды', () => {
  /**
   * Часовой пояс процесса подменяется на время одной проверки.
   *
   * `Intl` и `Date` читают `process.env.TZ` при создании форматтера, поэтому
   * подмена работает и в Node без перезапуска.
   */
  function withTimeZone<T>(zone: string, run: () => T): T {
    const previous = process.env['TZ'];
    process.env['TZ'] = zone;
    try {
      return run();
    } finally {
      if (previous === undefined) {
        delete process.env['TZ'];
      } else {
        process.env['TZ'] = previous;
      }
    }
  }

  it('московский день одинаков в любом поясе процесса', () => {
    const boundary = new Date('2026-08-11T21:00:00.000Z');
    const before = new Date('2026-08-11T20:59:59.000Z');

    for (const zone of FOREIGN_ZONES) {
      expect(
        withTimeZone(zone, () => moscowCalendarDate(boundary)),
        zone,
      ).toBe('2026-08-12');
      expect(
        withTimeZone(zone, () => moscowCalendarDate(before)),
        zone,
      ).toBe('2026-08-11');
    }
  });

  it('человекочитаемый момент одинаков в любом поясе процесса', () => {
    const instant = '2026-08-11T21:00:00.000Z';
    const expected = formatMoscowDateTime(instant);

    for (const zone of FOREIGN_ZONES) {
      expect(
        withTimeZone(zone, () => formatMoscowDateTime(instant)),
        zone,
      ).toBe(expected);
    }

    // И это именно московское время: полночь следующего дня, а не 21:00 UTC.
    expect(expected).toContain('12.08.2026');
    expect(expected).toContain('00:00');
  });

  it('календарная дата не проходит через локальный парсер', () => {
    // `new Date('2026-08-07')` западнее Гринвича даёт шестое августа.
    for (const zone of FOREIGN_ZONES) {
      expect(
        withTimeZone(zone, () => formatCalendarDate('2026-08-07')),
        zone,
      ).toBe('07.08.2026');
    }
  });
});

describe('показ значений', () => {
  it('пустое значение остаётся честным прочерком', () => {
    expect(formatCalendarDate(null)).toBe(EMPTY_TIME_VALUE);
    expect(formatMoscowDateTime(null)).toBe(EMPTY_TIME_VALUE);
    expect(formatMoscowTime(undefined)).toBe(EMPTY_TIME_VALUE);
    expect(formatMinutesOfDay(null)).toBe(EMPTY_TIME_VALUE);
  });

  it('неразобранное значение не превращается в «Invalid Date»', () => {
    expect(formatMoscowDateTime('не дата')).toBe(EMPTY_TIME_VALUE);
    expect(formatMoscowTime('не дата')).toBe(EMPTY_TIME_VALUE);
    // Календарная дата чужого формата возвращается как есть: она могла прийти
    // из внешнего источника, и молча превращать её в прочерк нельзя.
    expect(formatCalendarDate('07/08/2026')).toBe('07/08/2026');
  });

  it('минуты внутри дня к часовому поясу отношения не имеют', () => {
    expect(formatMinutesOfDay(0)).toBe('00:00');
    expect(formatMinutesOfDay(600)).toBe('10:00');
    expect(formatMinutesOfDay(1439)).toBe('23:59');
  });

  it('только московское время и одна локаль', () => {
    expect(MOSCOW_TIME_ZONE).toBe('Europe/Moscow');
    expect(MOSCOW_LOCALE).toBe('ru-RU');
    expect(formatMoscowTime('2026-08-11T21:00:00.000Z')).toBe('00:00');
  });
});
