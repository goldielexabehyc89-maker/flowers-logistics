/**
 * Хранение применённого фильтра времени карты «Сделок».
 *
 * Проверяется, что фильтр раздельный по userId, что порча значения не ломает
 * экран (безопасно игнорируется) и что запись/чтение/очистка согласованы.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearTimeFilter,
  parseTimeFilter,
  readTimeFilter,
  timeFilterStorageKey,
  writeTimeFilter,
} from './time-filter-storage';

function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const mock = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  vi.stubGlobal('window', { localStorage: mock });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ключ хранения', () => {
  it('раздельный по userId, у анонима — отдельный', () => {
    expect(timeFilterStorageKey('u1')).toBe('deals-map-time-filter:u1');
    expect(timeFilterStorageKey('u2')).toBe('deals-map-time-filter:u2');
    expect(timeFilterStorageKey(null)).toBe('deals-map-time-filter:anon');
    expect(timeFilterStorageKey('u1')).not.toBe(timeFilterStorageKey('u2'));
  });
});

describe('разбор сохранённого значения', () => {
  it('корректное значение читается, ЧЧ:ММ сохраняется', () => {
    expect(parseTimeFilter('{"from":"09:00","to":"18:00"}')).toEqual({
      from: '09:00',
      to: '18:00',
    });
  });

  it('пустые поля допустимы', () => {
    expect(parseTimeFilter('{"from":"","to":"14:30"}')).toEqual({ from: '', to: '14:30' });
  });

  it('порча значения безопасно игнорируется', () => {
    expect(parseTimeFilter(null)).toEqual({ from: '', to: '' });
    expect(parseTimeFilter('не json')).toEqual({ from: '', to: '' });
    expect(parseTimeFilter('[1,2,3]')).toEqual({ from: '', to: '' });
    expect(parseTimeFilter('"строка"')).toEqual({ from: '', to: '' });
    // Нечисловое/неформатное время отбрасывается по отдельности.
    expect(parseTimeFilter('{"from":"25:99","to":"18:00"}')).toEqual({ from: '', to: '18:00' });
    expect(parseTimeFilter('{"from":42,"to":"18:00"}')).toEqual({ from: '', to: '18:00' });
  });
});

describe('запись, чтение и очистка раздельно по userId', () => {
  it('фильтры двух пользователей не смешиваются', () => {
    const store = installLocalStorage();

    writeTimeFilter('u1', { from: '09:00', to: '12:00' });
    writeTimeFilter('u2', { from: '13:00', to: '' });

    expect(readTimeFilter('u1')).toEqual({ from: '09:00', to: '12:00' });
    expect(readTimeFilter('u2')).toEqual({ from: '13:00', to: '' });
    expect(store.size).toBe(2);

    // Очистка одного не трогает другого.
    clearTimeFilter('u1');
    expect(readTimeFilter('u1')).toEqual({ from: '', to: '' });
    expect(readTimeFilter('u2')).toEqual({ from: '13:00', to: '' });
  });

  it('пустой фильтр не хранится: запись пустого удаляет запись', () => {
    const store = installLocalStorage();
    writeTimeFilter('u1', { from: '09:00', to: '' });
    expect(store.size).toBe(1);
    writeTimeFilter('u1', { from: '', to: '' });
    expect(store.size).toBe(0);
    expect(readTimeFilter('u1')).toEqual({ from: '', to: '' });
  });

  it('недоступное хранилище не роняет чтение и запись', () => {
    // window нет вовсе — все обёртки должны вернуть пустое/ничего без исключений.
    vi.stubGlobal('window', undefined);
    expect(() => writeTimeFilter('u1', { from: '09:00', to: '10:00' })).not.toThrow();
    expect(readTimeFilter('u1')).toEqual({ from: '', to: '' });
    expect(() => clearTimeFilter('u1')).not.toThrow();
  });
});
