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
  issueBlocker,
  issueProgress,
  nextStep,
  pickProgress,
  type RouteFlowOrderView,
  type RouteFlowView,
} from './warehouse-flow';

function order(overrides: Partial<RouteFlowOrderView> = {}): RouteFlowOrderView {
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
    position: 1,
    issued: false,
    inRouteCell: false,
    ...overrides,
  };
}

function view(orders: RouteFlowOrderView[]): RouteFlowView {
  return {
    routeId: 'route',
    routeNumber: 'R-1',
    state: 'CONFIRMED',
    version: 1,
    deliveryDate: '2027-05-04',
    courier: { id: 'c', fullName: 'Курьер' },
    routeCell: { id: 'rc', code: 'R-01' },
    issueSession: null,
    orders,
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

  it('выдача заблокирована для непринятого, проблемного и требующего перемещения', () => {
    expect(issueBlocker(order({ cellId: null, cellCode: null }))).toBe('Не принят на склад');
    expect(issueBlocker(order({ requiresRelocation: true }))).toBe('Требуется перемещение');
    expect(issueBlocker(order({ blockedBy: ['OUT_OF_SCOPE'] }))).toBe(BLOCK_LABELS['OUT_OF_SCOPE']);
    expect(issueBlocker(order())).toBeNull();
    // Уже выданный заказ блокировок не показывает: работа по нему закончена.
    expect(issueBlocker(order({ issued: true, cellId: null, cellCode: null }))).toBeNull();
  });

  it('неизвестный признак показывается как есть, а не теряется', () => {
    expect(blockLabel('НЕЧТО_НОВОЕ')).toBe('НЕЧТО_НОВОЕ');
  });

  it('оба типа ячеек названы по-человечески', () => {
    expect(Object.keys(CELL_KIND_LABELS).sort()).toEqual(['ROUTE', 'STORAGE']);
  });
});

describe('прогресс', () => {
  it('комплектование считает заказы в маршрутной ячейке', () => {
    const progress = pickProgress(
      view([order({ inRouteCell: true }), order({ orderId: 'b', inRouteCell: false })]),
    );
    expect(progress).toEqual({ picked: 1, total: 2 });
  });

  it('выдача считает выданные заказы', () => {
    const progress = issueProgress(
      view([order({ issued: true }), order({ orderId: 'b', issued: false })]),
    );
    expect(progress).toEqual({ issued: 1, total: 2 });
  });

  it('пустой маршрут не делит на ноль и не выглядит завершённым', () => {
    expect(issueProgress(view([]))).toEqual({ issued: 0, total: 0 });
    expect(pickProgress(view([]))).toEqual({ picked: 0, total: 0 });
  });
});
