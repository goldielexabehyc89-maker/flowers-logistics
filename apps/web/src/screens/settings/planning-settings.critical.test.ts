/**
 * Критические правила форм настроек планирования.
 *
 * Клиентская проверка решения не принимает — его принимает сервер, — но именно
 * она решает, увидит ли человек ошибку рядом с полем. Проверяется то, что
 * иначе попало бы в систему молча: смена, заканчивающаяся раньше начала,
 * время обслуживания дробью и координата вне Земли.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  activePoint,
  depotError,
  depotSuggestHint,
  formatTimeOfDay,
  parseTimeOfDay,
  serviceTimeError,
  shiftError,
} from './planning-settings';

describe('время суток', () => {
  it('разбирается из ЧЧ:ММ и собирается обратно без потерь', () => {
    expect(parseTimeOfDay('09:00')).toBe(540);
    expect(parseTimeOfDay('9:05')).toBe(545);
    expect(parseTimeOfDay('23:59')).toBe(1439);
    expect(parseTimeOfDay('00:00')).toBe(0);

    expect(formatTimeOfDay(540)).toBe('09:00');
    expect(formatTimeOfDay(1439)).toBe('23:59');
    expect(formatTimeOfDay(parseTimeOfDay('21:30') ?? -1)).toBe('21:30');
  });

  it('не принимает то, что временем суток не является', () => {
    for (const value of ['', '9', '09-00', '24:00', '09:60', 'девять', '09:0', '1e1:00']) {
      expect(parseTimeOfDay(value), value).toBeNull();
    }
  });
});

describe('форма смены', () => {
  it('принимает осмысленный рабочий день', () => {
    expect(shiftError({ start: '09:00', end: '21:00' })).toBeNull();
  });

  it('требует обе границы в виде времени', () => {
    expect(shiftError({ start: '', end: '21:00' })).not.toBeNull();
    expect(shiftError({ start: '09:00', end: 'вечер' })).not.toBeNull();
  });

  it('отвергает окончание раньше или равное началу', () => {
    // Переход через полночь система не поддерживает и не притворяется,
    // что умеет: такое значение — опечатка, а не ночная смена.
    expect(shiftError({ start: '21:00', end: '09:00' })).not.toBeNull();
    expect(shiftError({ start: '09:00', end: '09:00' })).not.toBeNull();
  });
});

describe('форма времени обслуживания', () => {
  it('принимает целые минуты в разумных пределах', () => {
    expect(serviceTimeError('10', '10')).toBeNull();
    expect(serviceTimeError('0', '120')).toBeNull();
  });

  it('отвергает дробь, отрицательное и слишком большое значение', () => {
    expect(serviceTimeError('10.5', '10')).not.toBeNull();
    expect(serviceTimeError('-1', '10')).not.toBeNull();
    expect(serviceTimeError('10', '121')).not.toBeNull();
    expect(serviceTimeError('', '10')).not.toBeNull();
    expect(serviceTimeError('десять', '10')).not.toBeNull();
  });
});

describe('форма склада', () => {
  const chosen = {
    name: 'Основной',
    address: 'Москва, Цветочная улица, 1',
    point: { value: 'Москва, Цветочная улица, 1', lat: 55.751244, lon: 37.618423 },
  };

  it('принимает склад с адресом, выбранным из подсказок', () => {
    expect(depotError(chosen)).toBeNull();
    expect(activePoint(chosen)).toEqual({ lat: 55.751244, lon: 37.618423 });
  });

  it('требует название и адрес', () => {
    expect(depotError({ ...chosen, name: '  ' })).not.toBeNull();
    expect(depotError({ ...chosen, address: '' })).not.toBeNull();
  });

  it('напечатанный, но не выбранный адрес складом не становится', () => {
    // Ровно эта поломка и приводила к складу без точки: текст есть,
    // подсказка не выбрана, координат нет.
    const typed = { name: 'Основной', address: 'Москва, Цветочная улица, 1', point: null };
    expect(activePoint(typed)).toBeNull();
    expect(depotError(typed)).toMatch(/выберите адрес из подсказок/i);
  });

  it('правка текста после выбора немедленно сбрасывает точку', () => {
    // Логист дописал «, подъезд 2»: прежние координаты относятся к другой
    // строке и указывали бы не туда.
    const edited = { ...chosen, address: `${chosen.address}, подъезд 2` };
    expect(activePoint(edited)).toBeNull();
    expect(depotError(edited)).not.toBeNull();
  });

  it('ручного ввода координат в форме нет', () => {
    // Проверка смотрит в исходник намеренно: поля широты и долготы легко
    // вернуть «одной строчкой», и тогда склад снова окажется не на карте.
    const source = readFileSync(new URL('./PlanningSettings.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/depot-lat/);
    expect(source).not.toMatch(/depot-lon/);
  });

  it('без подсказок предлагается настроить их, а не вводить координаты', () => {
    expect(depotSuggestHint(false)).toMatch(/подсказки адреса не настроены/i);
    expect(depotSuggestHint(false)).not.toMatch(/координат/i);
    expect(depotSuggestHint(true)).toMatch(/подсказку/i);
  });
});
