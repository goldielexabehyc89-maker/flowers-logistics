/**
 * Критические проверки правил формы складских ячеек.
 *
 * Клиентские правила защитой не являются — решение принимает сервер. Но они
 * обязаны совпадать с серверными по СМЫСЛУ: если форма покажет один код,
 * а сохранится другой, администратор напечатает этикетку и наклеит её на полку,
 * которую сканер не найдёт.
 *
 * Непечатаемые символы записаны escape-последовательностями намеренно:
 * литеральный управляющий байт в исходнике не виден при чтении кода и при
 * ревью, а именно его наличие проверка и обязана поймать.
 */

import { describe, expect, it } from 'vitest';
import {
  CELL_KIND_LABELS,
  MAX_BULK_CELLS,
  MAX_BULK_PAD,
  MAX_CODE_LENGTH,
  bulkEdges,
  cellCodeError,
  cellsPlural,
  codeWillChange,
  expandBulkRange,
  parseBulkRange,
  previewCellCode,
  splitBulkList,
  type BulkRangeForm,
} from './storage-cells';

describe('код ячейки', () => {
  it('предпросмотр совпадает с тем, что сохранит сервер', () => {
    expect(previewCellCode('  a-01 ')).toEqual({ code: 'a-01', normalizedCode: 'A-01' });
    expect(previewCellCode('Полка-7')).toEqual({ code: 'Полка-7', normalizedCode: 'ПОЛКА-7' });
    // Неразрывный пробел по краям — тоже пробел: иначе он остался бы в коде
    // невидимым, и скан обычного написания ячейку не нашёл бы.
    expect(previewCellCode('\u00a0A-02\u00a0').code).toBe('A-02');
  });

  it('пустой, слишком длинный и непечатаемый код не проходят', () => {
    expect(cellCodeError('')).not.toBeNull();
    expect(cellCodeError('   ')).not.toBeNull();
    expect(cellCodeError('\u00a0')).not.toBeNull();
    expect(cellCodeError('A'.repeat(MAX_CODE_LENGTH + 1))).not.toBeNull();
    expect(cellCodeError('A\u0007B')).not.toBeNull();
    expect(cellCodeError('A\u200bB')).not.toBeNull();
  });

  it('обычный код проходит', () => {
    for (const good of ['A-01', 'a-01', 'Полка 7', 'R-2026-08-12-003']) {
      expect(cellCodeError(good), good).toBeNull();
    }
  });

  it('предупреждение показывается только когда код действительно изменится', () => {
    expect(codeWillChange('a-01')).toBe(true);
    expect(codeWillChange(' A-01 ')).toBe(true);
    expect(codeWillChange('A-01')).toBe(false);
    // Пустая строка ещё не повод пугать: об этом скажет ошибка поля.
    expect(codeWillChange('')).toBe(false);
  });

  it('оба типа названы по-человечески', () => {
    expect(Object.keys(CELL_KIND_LABELS).sort()).toEqual(['ROUTE', 'STORAGE']);
    for (const label of Object.values(CELL_KIND_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Партия ячеек: правила формы.
 *
 * Клиент разворачивает диапазон и разбивает список только затем, чтобы
 * показать человеку края будущей партии и её размер ДО отправки. Сохраняет
 * сервер, и он разбирает ввод заново — поэтому расхождение правил здесь даёт
 * неверный предпросмотр, а не неверные данные. Именно предпросмотр и
 * проверяется: человек принимает решение по нему.
 */
describe('партия ячеек', () => {
  const base: BulkRangeForm = { prefix: 'A-', from: '1', to: '10', pad: '3' };

  it('диапазон включает обе границы и хранит ведущие нули', () => {
    const parsed = parseBulkRange(base);
    expect('range' in parsed).toBe(true);
    if (!('range' in parsed)) {
      return;
    }

    const codes = expandBulkRange(parsed.range);
    // «От 1 до 10» — это десять полок, а не девять.
    expect(codes).toHaveLength(10);
    expect(codes[0]).toBe('A-001');
    expect(codes[9]).toBe('A-010');
  });

  it('число шире заданной ширины не обрезается', () => {
    const parsed = parseBulkRange({ ...base, from: '99', to: '101', pad: '2' });
    expect('range' in parsed).toBe(true);
    if (!('range' in parsed)) {
      return;
    }
    // Обрезание дало бы «A-99, A-00, A-01» — два кода из ста и один повтор.
    expect(expandBulkRange(parsed.range)).toEqual(['A-99', 'A-100', 'A-101']);
  });

  it('невозможный диапазон назван причиной, а не молчаливым нулём', () => {
    const cases: [BulkRangeForm, RegExp][] = [
      [{ ...base, from: '' }, /начало и конец/i],
      [{ ...base, from: '10', to: '1' }, /раньше начала/i],
      [{ ...base, from: '-1' }, /целые числа/i],
      [{ ...base, from: '1.5' }, /целые числа/i],
      [{ ...base, pad: '0' }, /Знаков в номере/i],
      [{ ...base, pad: String(MAX_BULK_PAD + 1) }, /Знаков в номере/i],
      [{ ...base, from: '1', to: String(MAX_BULK_CELLS + 1) }, /не больше 500/],
    ];

    for (const [form, expected] of cases) {
      const parsed = parseBulkRange(form);
      expect('error' in parsed, JSON.stringify(form)).toBe(true);
      if ('error' in parsed) {
        expect(parsed.error, JSON.stringify(form)).toMatch(expected);
      }
    }
  });

  it('ровно предельная партия допустима', () => {
    const parsed = parseBulkRange({ ...base, from: '1', to: String(MAX_BULK_CELLS), pad: '4' });
    expect('range' in parsed).toBe(true);
  });

  it('префикс приводится так же, как код: невидимый пробел не уезжает в партию', () => {
    const parsed = parseBulkRange({ ...base, prefix: '\u00a0A-\u00a0' });
    expect('range' in parsed).toBe(true);
    if ('range' in parsed) {
      expect(parsed.range.prefix).toBe('A-');
    }
  });

  it('вставленный список делится строками, запятыми и точками с запятой', () => {
    expect(splitBulkList('A-1\nA-2,A-3; A-4\r\nA-5')).toEqual(['A-1', 'A-2', 'A-3', 'A-4', 'A-5']);
    // Перевод строки в конце вставки — не ошибка ввода.
    expect(splitBulkList('  A-1  \n\n')).toEqual(['A-1']);
    expect(splitBulkList('  \n ; , ')).toEqual([]);
  });

  it('края партии показываются так, как их проверяют глазами', () => {
    expect(bulkEdges([])).toBeNull();
    expect(bulkEdges(['A-001'])).toBe('A-001');
    expect(bulkEdges(['A-001', 'A-002', 'A-010'])).toBe('A-001 … A-010');
  });

  it('количество названо по-русски', () => {
    expect(cellsPlural(1)).toBe('1 ячейка');
    expect(cellsPlural(3)).toBe('3 ячейки');
    expect(cellsPlural(10)).toBe('10 ячеек');
    // Одиннадцать — не «одна»: исключение, на котором обычно и ошибаются.
    expect(cellsPlural(11)).toBe('11 ячеек');
    expect(cellsPlural(21)).toBe('21 ячейка');
    expect(cellsPlural(102)).toBe('102 ячейки');
    expect(cellsPlural(112)).toBe('112 ячеек');
  });
});
