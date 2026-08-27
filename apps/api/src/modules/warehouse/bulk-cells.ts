/**
 * Разбор партии складских ячеек.
 *
 * Кладовщик заводит полки не по одной: стеллаж — это сразу сотня кодов. Раньше
 * их приходилось вбивать поштучно, и именно там появлялись опечатки, которые
 * потом всплывали у сканера.
 *
 * Здесь только ЧИСТЫЕ функции: они превращают ввод человека в список кодов
 * и объясняют, что с ним не так. Ничего не создают и в базу не ходят —
 * поэтому предпросмотр и сохранение видят одно и то же, а разойтись
 * они не могут.
 *
 * Нормализация — та же самая, что у одиночного создания и у разрешения скана
 * (`normalizeCellCode`). Заведи мы здесь собственные правила, часть партии
 * создалась бы кодами, которые сканер потом не нашёл бы.
 */

import { AppError } from '../../platform/errors.js';
import { MAX_CODE_LENGTH, normalizeCellCode } from './cell-code.js';

/**
 * Предел одной операции.
 *
 * Не техническое ограничение, а рабочее: пятьсот ячеек — это уже больше,
 * чем человек в состоянии проверить глазами в предпросмотре. Партия крупнее
 * почти наверняка означает ошибку в диапазоне, а не намерение.
 */
export const MAX_BULK_CELLS = 500;

/** Предел ведущих нулей: шире — это уже не номер полки. */
const MAX_PAD = 6;

export interface RangeInput {
  prefix: string;
  from: number;
  to: number;
  /** Сколько знаков в номере с ведущими нулями. */
  pad: number;
}

/** Одна забракованная строка ввода: что было и почему не подошло. */
export interface RejectedCode {
  input: string;
  reason: string;
}

export interface ParsedBatch {
  /** Годные коды в порядке ввода, без повторов. */
  codes: { code: string; normalizedCode: string }[];
  /** Повторы ВНУТРИ ввода: человек написал один код дважды. */
  duplicates: string[];
  /** Строки, которые кодом ячейки быть не могут. */
  invalid: RejectedCode[];
}

/**
 * Коды диапазона: префикс плюс номера с ведущими нулями.
 *
 * Границы включительные с обеих сторон: «от 1 до 100» человек понимает как
 * сто полок, а не девяносто девять.
 */
export function expandRange(input: RangeInput): string[] {
  if (!Number.isInteger(input.from) || !Number.isInteger(input.to)) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'range bounds must be integers',
      publicMessage: 'Границы диапазона должны быть целыми числами.',
    });
  }
  if (input.from < 0 || input.to < 0) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'range bounds must not be negative',
      publicMessage: 'Границы диапазона не могут быть отрицательными.',
    });
  }
  if (input.to < input.from) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'range end is before start',
      publicMessage: 'Конец диапазона раньше начала.',
    });
  }
  if (!Number.isInteger(input.pad) || input.pad < 1 || input.pad > MAX_PAD) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'invalid padding',
      publicMessage: `Знаков в номере должно быть от 1 до ${MAX_PAD}.`,
    });
  }

  const count = input.to - input.from + 1;
  if (count > MAX_BULK_CELLS) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'range is too large',
      publicMessage: `За один раз создаётся не больше ${MAX_BULK_CELLS} ячеек, а в диапазоне ${count}.`,
    });
  }

  const codes: string[] = [];
  for (let value = input.from; value <= input.to; value += 1) {
    codes.push(`${input.prefix}${String(value).padStart(input.pad, '0')}`);
  }
  return codes;
}

/**
 * Готовый список: строки, запятые и точки с запятой.
 *
 * Человек вставляет список откуда угодно — из таблицы, из письма, из заметки.
 * Поэтому разделителем считается всё три сразу, края обрезаются, а пустые
 * строки просто исчезают: пустая строка в конце вставки не должна выглядеть
 * ошибкой ввода.
 */
export function splitList(input: string): string[] {
  return input
    .split(/[\n\r,;]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * Превращает список строк в разобранную партию.
 *
 * Повторы и негодные строки НЕ отбрасываются молча: человек должен увидеть,
 * что именно из его ввода не пойдёт в работу. Молчаливое «создано 98 из 100»
 * заставило бы искать недостающие две вручную.
 */
export function parseBatch(raw: readonly string[]): ParsedBatch {
  const codes: { code: string; normalizedCode: string }[] = [];
  const duplicates: string[] = [];
  const invalid: RejectedCode[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    let normalized;
    try {
      normalized = normalizeCellCode(item);
    } catch (error) {
      invalid.push({
        input: item,
        reason:
          error instanceof AppError && typeof error.publicMessage === 'string'
            ? error.publicMessage
            : `Код длиннее ${MAX_CODE_LENGTH} символов или содержит недопустимые символы.`,
      });
      continue;
    }

    if (seen.has(normalized.normalizedCode)) {
      duplicates.push(normalized.code);
      continue;
    }

    seen.add(normalized.normalizedCode);
    codes.push(normalized);
  }

  return { codes, duplicates, invalid };
}

/** Партия не помещается в предел: считать её обрезанной нельзя. */
export function assertBatchSize(count: number): void {
  if (count > MAX_BULK_CELLS) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'batch is too large',
      publicMessage: `За один раз создаётся не больше ${MAX_BULK_CELLS} ячеек, а получилось ${count}.`,
    });
  }
}
