/**
 * Названия операций журнала — общие для экрана и выгрузок.
 *
 * Проверка живёт здесь, а не в приложении: словарь один на весь продукт, и
 * расхождение «на экране одно, в файле другое» должно быть невозможно, а не
 * маловероятно. Именно так оно и возникло — два одинаковых на вид словаря
 * разъехались, и строку из выгрузки нельзя было найти на экране.
 */

import { describe, expect, it } from 'vitest';
import { ledgerEntryTitle, ledgerKindLabel } from './ledger-labels.js';

describe('названия операций журнала', () => {
  it('обычная операция называется по своему виду', () => {
    expect(ledgerKindLabel('OPENING_DEBT')).toBe('Начальный долг');
    expect(ledgerEntryTitle({ kind: 'OPENING_DEBT' })).toBe('Начальный долг');
    expect(ledgerEntryTitle({ kind: 'CASH_HANDED_TO_LOGIST' })).toBe('Курьер сдал логисту');
  });

  it('отмена называется по тому, что отменяет', () => {
    expect(ledgerEntryTitle({ kind: 'ADJUSTMENT', reversesKind: 'OPENING_DEBT' })).toBe(
      'Отмена: Начальный долг',
    );
    expect(ledgerEntryTitle({ kind: 'ADJUSTMENT', reversesKind: 'CASH_HANDED_TO_LOGIST' })).toBe(
      'Отмена: Курьер сдал логисту',
    );
  });

  it('перенос дня учёта называется по переносимой операции и стороне', () => {
    expect(
      ledgerEntryTitle({
        kind: 'ADJUSTMENT',
        relocatesKind: 'DISTANCE_FEE',
        relocationSide: 'OUT',
      }),
    ).toBe('Перенос учёта из дня: Оплата километров за МКАД');
    expect(
      ledgerEntryTitle({ kind: 'ADJUSTMENT', relocatesKind: 'DISTANCE_FEE', relocationSide: 'IN' }),
    ).toBe('Перенос учёта в день: Оплата километров за МКАД');
    // Сторно называется отменой даже при заполненном переносе: такой записи не бывает,
    // но название не должно зависеть от порядка полей.
    expect(
      ledgerEntryTitle({ kind: 'ADJUSTMENT', reversesKind: 'OPENING_DEBT', relocatesKind: null }),
    ).toBe('Отмена: Начальный долг');
  });

  it('вид отменяемой операции неизвестен — остаётся общее название', () => {
    expect(ledgerEntryTitle({ kind: 'ADJUSTMENT', reversesKind: null })).toBe(
      'Обратная корректировка',
    );
    expect(ledgerEntryTitle({ kind: 'ADJUSTMENT' })).toBe('Обратная корректировка');
  });

  it('неизвестный вид возвращается как есть, а не подменяется пустотой', () => {
    expect(ledgerKindLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
