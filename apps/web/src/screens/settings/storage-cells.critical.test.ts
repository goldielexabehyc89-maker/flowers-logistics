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
  MAX_CODE_LENGTH,
  cellCodeError,
  codeWillChange,
  previewCellCode,
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
