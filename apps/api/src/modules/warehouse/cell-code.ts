/**
 * Код складской ячейки: форма и нормализация.
 *
 * Код — это то, что напечатано на этикетке и попадает в сканер. Поэтому у него
 * два представления: написание для человека и приведённая форма для сравнения.
 * Сравнение обязано быть нечувствительным к регистру и внешним пробелам —
 * скан `a-01` не должен выбрать другую ячейку `A-01`.
 *
 * Правила вынесены в чистые функции: их проверяют тестами, и одна и та же
 * нормализация применяется при создании ячейки и при разрешении скана.
 * Разные правила в этих двух местах означали бы, что созданную ячейку
 * невозможно отсканировать.
 */

import { AppError } from '../../platform/errors.js';

/**
 * Предел длины кода.
 *
 * Число не взято с потолка: код целиком помещается в QR версии 6 с уровнем
 * коррекции M даже в кириллице (два байта на символ), поэтому этикетка
 * генерируется всегда и не упирается в предел кодировщика.
 */
export const MAX_CODE_LENGTH = 48;

/** Управляющие и невидимые форматирующие символы в коде недопустимы. */
const FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export interface NormalizedCellCode {
  /** Написание для человека и для этикетки: регистр сохранён. */
  code: string;
  /** Форма для сравнения и уникальности. */
  normalizedCode: string;
}

/**
 * Приводит введённый или отсканированный код к паре «показать / сравнить».
 *
 * Порядок шагов важен. `NFKC` выполняется ПЕРВЫМ: он превращает неразрывный
 * пробел в обычный, и только после этого обрезка краёв срабатывает так, как
 * ожидает человек. Обратный порядок оставил бы невидимый пробел внутри кода.
 */
export function normalizeCellCode(input: string): NormalizedCellCode {
  const code = input.normalize('NFKC').trim();

  if (code === '') {
    throw new AppError('VALIDATION_FAILED', {
      message: 'cell code is empty',
      publicMessage: 'Код ячейки не может быть пустым.',
    });
  }

  if (code.length > MAX_CODE_LENGTH) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'cell code is too long',
      publicMessage: `Код ячейки не длиннее ${MAX_CODE_LENGTH} символов.`,
    });
  }

  if (FORBIDDEN_CHARACTERS.test(code)) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'cell code contains control characters',
      publicMessage: 'Код ячейки содержит недопустимые символы.',
    });
  }

  return { code, normalizedCode: code.toUpperCase() };
}
