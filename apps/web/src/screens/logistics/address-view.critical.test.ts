/**
 * Правило показа адреса и деталей.
 *
 * Проверяется то, что нельзя заметить глазами на одном экране: склейка деталей
 * с адресом и пустой блок вместо отсутствующих деталей.
 */

import { describe, expect, it } from 'vitest';
import { ADDRESS_MISSING, addressView } from './address-view';
import { routeLink } from '../delivery/delivery-flow';

describe('адрес и детали', () => {
  it('детали остаются отдельной строкой и с адресом не склеиваются', () => {
    const view = addressView({
      address: 'г. Москва, ул. Маленковская, д. 14',
      addressDetails: 'Регион: Москва · Кв./офис: 55 · Другое: домофон 42',
    });

    expect(view.address).toBe('г. Москва, ул. Маленковская, д. 14');
    expect(view.details).toBe('Регион: Москва · Кв./офис: 55 · Другое: домофон 42');
    // Строку адреса копируют в поиск и сверяют с запросом геокодера: квартира
    // в ней увела бы поиск с дома.
    expect(view.address).not.toContain('55');
    expect(view.address).not.toContain('домофон');
  });

  it('пустые детали второй строки не создают', () => {
    expect(addressView({ address: 'Москва, улица, 1', addressDetails: null }).details).toBeNull();
    expect(addressView({ address: 'Москва, улица, 1', addressDetails: '   ' }).details).toBeNull();
    // Заказ прежнего контракта деталей не присылает вовсе.
    expect(addressView({ address: 'Москва, улица, 1' }).details).toBeNull();
  });

  it('отсутствующий адрес назван прямо, а не пустотой', () => {
    expect(addressView({ address: null }).address).toBe(ADDRESS_MISSING);
    expect(addressView({ address: '  ' }).address).toBe(ADDRESS_MISSING);
    // Экран заказа говорит об этом своими словами — подпись задаётся вызовом.
    expect(addressView({ address: null }, 'не указан').address).toBe('не указан');
  });

  it('детали без адреса второй строкой не подменяют первую', () => {
    // Такое бывает у версии 2: дом ещё не приехал, а квартира уже есть.
    const view = addressView({ address: null, addressDetails: 'Кв./офис: 55' });
    expect(view.address).toBe(ADDRESS_MISSING);
    expect(view.details).toBe('Кв./офис: 55');
  });
});

describe('ссылка на карты', () => {
  it('строится по подтверждённой точке, а не по строке адреса', () => {
    // Ни адреса, ни деталей в ссылке нет и быть не может: функция принимает
    // только координату. По строке карты нашли бы «примерно тот» дом, а
    // квартира в запросе увела бы поиск ещё дальше.
    const link = routeLink({ lat: '55.757997', lon: '37.614069' });

    expect(link).toBe('https://yandex.ru/maps/?rtext=~55.757997,37.614069&rtt=auto');
    expect(link).not.toContain('Маленковская');
    expect(link).not.toContain('домофон');

    // Без подтверждённой точки ссылки нет вовсе.
    expect(routeLink(null)).toBeNull();
  });
});
