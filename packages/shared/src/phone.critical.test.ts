/**
 * Критическая проверка нормализации телефона.
 *
 * Телефон — логин пользователя. Ошибка нормализации означает либо двух пользователей
 * с одним номером, либо невозможность войти под собственным номером.
 */

import { describe, expect, it } from 'vitest';
import { maskPhone, normalizePhone, tryNormalizePhone } from './phone.js';

describe('нормализация телефона', () => {
  it('приводит распространённые формы записи к единому виду', () => {
    const variants = [
      '+79161234567',
      '79161234567',
      '89161234567',
      '+7 916 123-45-67',
      '8 (916) 123 45 67',
      '+7 (916) 123-45-67',
      '9161234567',
    ];

    for (const variant of variants) {
      expect(normalizePhone(variant)).toBe('+79161234567');
    }
  });

  it('отвергает всё, что не является российским номером', () => {
    const invalid = [
      '',
      '123',
      '+1 202 555 0143',
      '+7916123456',
      '+791612345678',
      'абвгд',
      '++79161234567',
    ];

    for (const value of invalid) {
      expect(() => normalizePhone(value)).toThrow();
      expect(tryNormalizePhone(value)).toBeNull();
    }
  });

  it('сохраняет значащие цифры номера', () => {
    // Ведущий ноль в номере абонента не должен потеряться.
    expect(normalizePhone('+7 901 000-00-01')).toBe('+79010000001');
  });

  it('маскирует номер для показа, не раскрывая середину', () => {
    const masked = maskPhone('+79161234567');
    expect(masked).toBe('+7 (916) ***-**-67');
    expect(masked).not.toContain('123');
  });
});
