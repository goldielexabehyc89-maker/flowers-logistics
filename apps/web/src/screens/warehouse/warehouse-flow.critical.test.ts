/**
 * Критические проверки правил складского экрана.
 *
 * Клиентские правила защитой не являются — решение принимает сервер. Но они
 * обязаны честно называть состояние: кладовщик действует по тому, что видит
 * на экране, и «не принят» вместо пустого места здесь важнее любой анимации.
 */

import { describe, expect, it } from 'vitest';
import {
  BLOCK_LABELS,
  CELL_KIND_LABELS,
  SCAN_HINTS,
  blockLabel,
  cellLabel,
  nextStep,
  type PlacedOrderView,
} from './warehouse-flow';

function order(overrides: Partial<PlacedOrderView> = {}): PlacedOrderView {
  return {
    orderId: 'id',
    orderNumber: 'W-1',
    deliveryDate: '2027-05-04',
    cellId: 'cell',
    cellCode: 'S-01',
    cellKind: 'STORAGE',
    requiresRelocation: false,
    blockedBy: [],
    routeNumber: 'R-1',
    routeId: 'route',
    ...overrides,
  };
}

describe('двухсканный шаг', () => {
  it('до скана заказа ждём заказ, после — ячейку', () => {
    expect(nextStep(false)).toBe('ORDER');
    expect(nextStep(true)).toBe('CELL');
    expect(SCAN_HINTS.ORDER).toMatch(/заказ/i);
    expect(SCAN_HINTS.CELL).toMatch(/ячейк/i);
  });
});

describe('состояние заказа на экране', () => {
  it('отсутствие размещения называется честно, а не пустым местом', () => {
    expect(cellLabel(order({ cellCode: null, cellId: null }))).toBe('Не принят');
    expect(cellLabel(order({ cellCode: 'S-07' }))).toBe('S-07');
  });

  it('известный признак называется по-человечески, неизвестный — как есть', () => {
    expect(blockLabel('OUT_OF_SCOPE')).toBe(BLOCK_LABELS['OUT_OF_SCOPE']);
    // Признак, которого мы ещё не знаем, теряться не должен.
    expect(blockLabel('НЕЧТО_НОВОЕ')).toBe('НЕЧТО_НОВОЕ');
  });

  it('оба типа ячеек названы по-человечески', () => {
    expect(Object.keys(CELL_KIND_LABELS).sort()).toEqual(['ROUTE', 'STORAGE']);
  });
});
