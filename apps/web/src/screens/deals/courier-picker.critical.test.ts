/**
 * Проверки выбора курьера.
 *
 * Защищаемое свойство: назначается существующий сотрудник, а набранная строка
 * сама по себе никого не создаёт и никем не становится.
 */

import { describe, expect, it } from 'vitest';
import {
  courierIdFor,
  courierLabel,
  filterCouriers,
  matchesCourier,
  type CourierOption,
} from './courier-picker';

const ivan: CourierOption = { id: 'u-1', fullName: 'Иванов Иван', phone: '+79990000001' };
const petr: CourierOption = { id: 'u-2', fullName: 'Петров Пётр', phone: '+79995551122' };
const noPhone: CourierOption = { id: 'u-3', fullName: 'Сидоров Сидор', phone: null };

describe('поиск курьера', () => {
  it('находит по части имени независимо от регистра', () => {
    expect(matchesCourier(ivan, 'иван')).toBe(true);
    expect(matchesCourier(ivan, 'ИВАНОВ')).toBe(true);
    expect(matchesCourier(petr, 'иван')).toBe(false);
  });

  it('находит по телефону в любом написании', () => {
    // Логист чаще помнит номер, чем точное написание фамилии.
    expect(matchesCourier(ivan, '9990000001')).toBe(true);
    expect(matchesCourier(ivan, '+7 (999) 000-00-01')).toBe(true);
    expect(matchesCourier(petr, '5551122')).toBe(true);
  });

  it('сотрудник без телефона по цифрам не находится и не ломает поиск', () => {
    expect(matchesCourier(noPhone, '999')).toBe(false);
    expect(matchesCourier(noPhone, 'Сидор')).toBe(true);
  });

  it('пустой запрос показывает всех', () => {
    expect(filterCouriers([ivan, petr, noPhone], '   ')).toHaveLength(3);
  });
});

describe('назначение', () => {
  it('без выбранного сотрудника назначения нет', () => {
    // Произвольная строка нового курьера не создаёт: маршрутный лист может
    // остаться без курьера, и это нормальное рабочее состояние.
    expect(courierIdFor(null)).toBeNull();
    expect(courierLabel(null)).toBe('Курьер не назначен');
  });

  it('выбранный сотрудник уходит на сервер идентификатором', () => {
    expect(courierIdFor(ivan)).toBe('u-1');
    expect(courierLabel(ivan)).toBe('Иванов Иван · +79990000001');
    expect(courierLabel(noPhone)).toBe('Сидоров Сидор');
  });
});
