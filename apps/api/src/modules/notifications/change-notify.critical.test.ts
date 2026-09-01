/**
 * Критические проверки раскладки изменений заказа по категориям и diff состава.
 *
 * Защищаемое: первый импорт и идентичный снимок уведомления не порождают;
 * категории берутся из уже посчитанных diff'ов импорта; перестановка одинаковых
 * позиций изменением состава не считается.
 */

import { describe, expect, it } from 'vitest';
import { categoriesFrom, diffComposition } from './change-notify.js';

describe('категории изменения', () => {
  it('первый импорт (CREATED) — ничего', () => {
    expect(
      categoriesFrom({
        orderId: 'o',
        orderOutcome: 'CREATED',
        orderChangedFields: ['address', 'deliveryDate'],
        fulfillmentOutcome: 'IMPORTED',
      }),
    ).toEqual([]);
  });

  it('идентичный снимок (UNCHANGED) — ничего', () => {
    expect(
      categoriesFrom({
        orderId: 'o',
        orderOutcome: 'UNCHANGED',
        orderChangedFields: [],
        fulfillmentOutcome: 'UNCHANGED',
      }),
    ).toEqual([]);
  });

  it('обновление адреса, даты и интервала → три категории, одно уведомление', () => {
    expect(
      categoriesFrom({
        orderId: 'o',
        orderOutcome: 'UPDATED',
        orderChangedFields: ['address', 'deliveryDate', 'intervalStartMinute'],
        fulfillmentOutcome: null,
      }),
    ).toEqual(['ADDRESS', 'DATE', 'INTERVAL']);
  });

  it('детали адреса — отдельная категория', () => {
    expect(
      categoriesFrom({
        orderId: 'o',
        orderOutcome: 'UPDATED',
        orderChangedFields: ['addressDetails'],
        fulfillmentOutcome: null,
      }),
    ).toEqual(['DETAILS']);
  });

  it('только координаты (нет полей снимка) — ничего', () => {
    // geoLat/geoLon не входят в changedFields снимка, поэтому категорий нет.
    expect(
      categoriesFrom({
        orderId: 'o',
        orderOutcome: 'UPDATED',
        orderChangedFields: ['geoState'],
        fulfillmentOutcome: null,
      }),
    ).toEqual([]);
  });

  it('изменение состава (CHANGED) → COMPOSITION', () => {
    expect(
      categoriesFrom({
        orderId: 'o',
        orderOutcome: 'UNCHANGED',
        orderChangedFields: [],
        fulfillmentOutcome: 'CHANGED',
      }),
    ).toEqual(['COMPOSITION']);
  });
});

describe('diff состава', () => {
  const rose = {
    externalPositionId: 'p1',
    name: 'Роза',
    quantity: '5',
    characteristicLabel: '60см',
  };
  const lily = { externalPositionId: 'p2', name: 'Лилия', quantity: '2' };

  it('перестановка одинаковых строк — не изменение', () => {
    const diff = diffComposition([rose, lily], [lily, rose]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.quantityChanged).toEqual([]);
    expect(diff.parameterChanged).toEqual([]);
  });

  it('добавление, удаление, количество и характеристика', () => {
    const roseMore = { ...rose, quantity: '7' };
    const roseParam = { ...rose, quantity: '7', characteristicLabel: '80см' };
    const tulip = { externalPositionId: 'p3', name: 'Тюльпан', quantity: '3' };

    const diff = diffComposition([rose, lily], [roseParam, tulip]);
    expect(diff.added.map((a) => a.name)).toEqual(['Тюльпан']);
    expect(diff.removed.map((r) => r.name)).toEqual(['Лилия']);
    expect(diff.quantityChanged).toEqual([{ name: 'Роза', old: '5', new: '7' }]);
    expect(diff.parameterChanged).toEqual([{ name: 'Роза' }]);

    // Контроль: изменение только количества без характеристики.
    const only = diffComposition([rose], [roseMore]);
    expect(only.quantityChanged).toEqual([{ name: 'Роза', old: '5', new: '7' }]);
    expect(only.parameterChanged).toEqual([]);
  });
});
