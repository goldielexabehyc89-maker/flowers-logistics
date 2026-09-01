/**
 * Критические проверки подписей вкладки «Уведомления».
 *
 * Защищаемое: текущее состояние заказа читается однозначно и всегда называет
 * маршрутный лист, когда заказ в нём.
 */

import { describe, expect, it } from 'vitest';
import {
  hasCompositionChange,
  orderStateLabel,
  refusalReasonLabel,
  refusalStateLabel,
} from './notifications';

describe('подпись текущего состояния', () => {
  it('в маршрутном листе — с номером листа', () => {
    expect(
      orderStateLabel({ kind: 'IN_ROUTE', routeNumber: 'R-12', routeState: 'CONFIRMED' }),
    ).toBe('В маршрутном листе R-12 (подтверждён)');
  });

  it('у курьера — курьер и номер листа', () => {
    expect(
      orderStateLabel({ kind: 'WITH_COURIER', routeNumber: 'R-9', courierName: 'Иван' }),
    ).toContain('R-9');
    expect(
      orderStateLabel({ kind: 'WITH_COURIER', routeNumber: 'R-9', courierName: 'Иван' }),
    ).toContain('Иван');
  });

  it('в маршрутной ячейке — ячейка и лист', () => {
    expect(orderStateLabel({ kind: 'IN_ROUTE_CELL', cellCode: 'A1', routeNumber: 'R-3' })).toBe(
      'В маршрутной ячейке A1 · МЛ R-3',
    );
  });

  it('в ячейке хранения — номер ячейки', () => {
    expect(orderStateLabel({ kind: 'IN_STORAGE_CELL', cellCode: 'S7' })).toBe(
      'В ячейке хранения S7',
    );
  });

  it('собран/ожидает, не назначен, отменён, списан', () => {
    expect(orderStateLabel({ kind: 'AWAITING_INTAKE' })).toBe('Собран, ожидает приёмки');
    expect(orderStateLabel({ kind: 'UNASSIGNED' })).toBe('Не назначен в маршрутный лист');
    expect(orderStateLabel({ kind: 'CANCELLED' })).toBe('Отменён');
    expect(orderStateLabel({ kind: 'WRITTEN_OFF' })).toBe('Списан');
  });
});

describe('признак изменения состава', () => {
  it('пусто — нет изменения', () => {
    expect(
      hasCompositionChange({ added: [], removed: [], quantityChanged: [], parameterChanged: [] }),
    ).toBe(false);
    expect(hasCompositionChange(null)).toBe(false);
  });

  it('любое непустое поле — есть изменение', () => {
    expect(
      hasCompositionChange({
        added: [{ name: 'Роза', quantity: '3' }],
        removed: [],
        quantityChanged: [],
        parameterChanged: [],
      }),
    ).toBe(true);
  });
});

describe('подписи отказа', () => {
  it('причины переведены, неизвестная возвращается как есть', () => {
    expect(refusalReasonLabel('INSUFFICIENT_GOODS')).toBe('Не хватает товара');
    expect(refusalReasonLabel('OTHER')).toBe('Другое');
    expect(refusalReasonLabel('WHAT')).toBe('WHAT');
  });

  it('состояния решения переведены, неизвестное возвращается как есть', () => {
    expect(refusalStateLabel('PENDING')).toBe('Ожидает решения');
    expect(refusalStateLabel('APPROVED')).toBe('Отказ подтверждён');
    expect(refusalStateLabel('ZZZ')).toBe('ZZZ');
  });
});
