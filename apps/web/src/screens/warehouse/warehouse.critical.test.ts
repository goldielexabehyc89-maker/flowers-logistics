/**
 * Критические проверки правил экрана «Склад».
 *
 * Проверяется то, что легко сломать незаметно: подпись действия называет
 * результат, а не текущее состояние, и время показывается по Москве,
 * а не по часовому поясу устройства кладовщика.
 */

import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  EMPTY_VALUE,
  formatMoscowTime,
  nextReadiness,
  READINESS_FILTERS,
  readinessTone,
} from './warehouse';

describe('состояния готовности', () => {
  it('действие всегда противоположно текущему состоянию', () => {
    expect(nextReadiness('NOT_READY')).toBe('READY');
    expect(nextReadiness('READY')).toBe('NOT_READY');
  });

  it('кнопка называет результат, а не текущее состояние', () => {
    // Кнопка «Не готов» на неготовом заказе выглядела бы как отметка о состоянии,
    // и человек нажимал бы её, чтобы подтвердить то, что и так верно.
    expect(actionLabel('NOT_READY')).toBe('Готов');
    expect(actionLabel('READY')).toBe('Не готов');
  });

  it('неготовый заказ не выглядит аварией', () => {
    // Красным на складе должно быть только то, что требует вмешательства.
    expect(readinessTone('NOT_READY')).toBe('neutral');
    expect(readinessTone('READY')).toBe('success');
  });

  it('фильтр предлагает ровно три варианта', () => {
    expect(READINESS_FILTERS.map((option) => option.value)).toEqual(['ALL', 'READY', 'NOT_READY']);
  });
});

describe('время последнего изменения', () => {
  it('показывается по Москве независимо от часового пояса устройства', () => {
    expect(formatMoscowTime('2026-08-07T10:15:00.000Z')).toBe('07.08.2026, 13:15');
    // Поздний вечер по Москве — это уже следующий день относительно UTC.
    expect(formatMoscowTime('2026-08-07T21:30:00.000Z')).toBe('08.08.2026, 00:30');
  });

  it('пустое и неразобранное значение остаётся честным прочерком', () => {
    expect(formatMoscowTime(null)).toBe(EMPTY_VALUE);
    expect(formatMoscowTime('не дата')).toBe(EMPTY_VALUE);
  });
});
