/**
 * Критические правила форм настроек планирования.
 *
 * Клиентская проверка решения не принимает — его принимает сервер, — но именно
 * она решает, увидит ли человек ошибку рядом с полем. Проверяется то, что
 * иначе попало бы в систему молча: смена, заканчивающаяся раньше начала,
 * время обслуживания дробью и координата вне Земли.
 */

import { describe, expect, it } from 'vitest';
import {
  depotError,
  formatTimeOfDay,
  parseCoordinate,
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
  it('принимает заполненный склад с координатами', () => {
    expect(
      depotError({
        name: 'Основной',
        address: 'Москва, Цветочная 1',
        lat: '55.751244',
        lon: '37.618423',
      }),
    ).toBeNull();
  });

  it('принимает координату с запятой: так её набирают чаще', () => {
    expect(
      depotError({ name: 'Основной', address: 'Москва', lat: '55,751244', lon: '37,618423' }),
    ).toBeNull();
    expect(parseCoordinate('55,751244')).toBeCloseTo(55.751244, 6);
  });

  it('требует название и адрес', () => {
    expect(depotError({ name: '  ', address: 'Москва', lat: '55.7', lon: '37.6' })).not.toBeNull();
    expect(depotError({ name: 'Склад', address: '', lat: '55.7', lon: '37.6' })).not.toBeNull();
  });

  it('отвергает координаты вне Земли и нечисловые', () => {
    expect(depotError({ name: 'С', address: 'А', lat: '95', lon: '37.6' })).not.toBeNull();
    expect(depotError({ name: 'С', address: 'А', lat: '55.7', lon: '190' })).not.toBeNull();
    expect(depotError({ name: 'С', address: 'А', lat: 'север', lon: '37.6' })).not.toBeNull();
    expect(depotError({ name: 'С', address: 'А', lat: '', lon: '' })).not.toBeNull();
  });
});
