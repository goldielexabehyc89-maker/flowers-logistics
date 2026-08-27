/**
 * Правила формы складских ячеек, вынесенные из компонента.
 *
 * Здесь только чистые функции: их проверяют тестами без браузера. Нормализация
 * повторяет серверную ровно затем, чтобы администратор ЗАРАНЕЕ видел, каким
 * код станет на этикетке, а не узнавал об этом после сохранения. Решение
 * по-прежнему принимает сервер — клиентская копия правил защитой не является.
 */

export type StorageCellKind = 'STORAGE' | 'ROUTE';

export interface StorageCellView {
  id: string;
  code: string;
  normalizedCode: string;
  kind: StorageCellKind;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface StorageCellListResponse {
  items: StorageCellView[];
  total: number;
  limit: number;
  offset: number;
  activeByKind: Record<StorageCellKind, number>;
}

export const CELL_KIND_LABELS: Record<StorageCellKind, string> = {
  STORAGE: 'Хранение',
  ROUTE: 'Маршрутная',
};

/** Предел совпадает с серверным: длиннее код не поместится на этикетку. */
export const MAX_CODE_LENGTH = 48;

const FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Как код будет выглядеть на этикетке и в сравнении. */
export function previewCellCode(input: string): { code: string; normalizedCode: string } {
  const code = input.normalize('NFKC').trim();
  return { code, normalizedCode: code.toUpperCase() };
}

/**
 * Причина, по которой код нельзя сохранить, либо `null`.
 *
 * Сообщения намеренно объясняют следствие, а не называют правило: «код уже
 * напечатан на этикетке» человеку понятнее, чем «поле immutable».
 */
export function cellCodeError(input: string): string | null {
  const { code } = previewCellCode(input);

  if (code === '') {
    return 'Введите код ячейки';
  }
  if (code.length > MAX_CODE_LENGTH) {
    return `Не длиннее ${MAX_CODE_LENGTH} символов`;
  }
  if (FORBIDDEN_CHARACTERS.test(code)) {
    return 'Код содержит недопустимые символы';
  }
  return null;
}

/** Показывать ли предупреждение, что сохранённый код будет отличаться от введённого. */
export function codeWillChange(input: string): boolean {
  const { code, normalizedCode } = previewCellCode(input);
  return code !== '' && normalizedCode !== input;
}

// ---------------------------------------------------------------------------
// Партия ячеек
// ---------------------------------------------------------------------------

/**
 * Предел одной операции. Совпадает с серверным.
 *
 * Здесь он нужен не как защита — её выполняет сервер, — а чтобы человек узнал
 * о превышении до отправки: диапазон «от 1 до 5000» набирается за секунду,
 * и отказ после ожидания выглядел бы поломкой.
 */
export const MAX_BULK_CELLS = 500;

/** Ширина номера с ведущими нулями: шире — это уже не номер полки. */
export const MAX_BULK_PAD = 6;

export type BulkMode = 'RANGE' | 'LIST';

/** Поля диапазона хранятся строками: пустое поле — это не ноль. */
export interface BulkRangeForm {
  prefix: string;
  from: string;
  to: string;
  pad: string;
}

export interface BulkRange {
  prefix: string;
  from: number;
  to: number;
  pad: number;
}

/**
 * Разбирает диапазон или объясняет, что с ним не так.
 *
 * Возвращается либо готовый диапазон, либо причина отказа — но не оба сразу:
 * форма, показывающая ошибку и одновременно считающая количество, однажды
 * отправила бы то, что сама признала негодным.
 */
export function parseBulkRange(form: BulkRangeForm): { range: BulkRange } | { error: string } {
  const from = Number(form.from.trim());
  const to = Number(form.to.trim());
  const pad = Number(form.pad.trim());

  if (form.from.trim() === '' || form.to.trim() === '') {
    return { error: 'Укажите начало и конец диапазона' };
  }
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0) {
    return { error: 'Границы — целые числа не меньше нуля' };
  }
  if (to < from) {
    return { error: 'Конец диапазона раньше начала' };
  }
  if (!Number.isInteger(pad) || pad < 1 || pad > MAX_BULK_PAD) {
    return { error: `Знаков в номере — от 1 до ${MAX_BULK_PAD}` };
  }
  if (to - from + 1 > MAX_BULK_CELLS) {
    return {
      error: `За один раз — не больше ${MAX_BULK_CELLS} ячеек, а в диапазоне ${to - from + 1}`,
    };
  }

  return { range: { prefix: form.prefix.normalize('NFKC').trim(), from, to, pad } };
}

/**
 * Коды диапазона — теми же правилами, что и на сервере.
 *
 * Клиент разворачивает диапазон только чтобы показать первый и последний код
 * до отправки. Сохраняет всё равно сервер, и он разворачивает диапазон
 * заново — расхождение правил здесь дало бы неверный предпросмотр, а не
 * неверные данные.
 */
export function expandBulkRange(range: BulkRange): string[] {
  const codes: string[] = [];
  for (let value = range.from; value <= range.to; value += 1) {
    codes.push(`${range.prefix}${String(value).padStart(range.pad, '0')}`);
  }
  return codes;
}

/** Разбиение вставленного списка. Разделители те же, что на сервере. */
export function splitBulkList(input: string): string[] {
  return input
    .split(/[\n\r,;]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

export interface BulkPreviewResponse {
  willCreate: { code: string; normalizedCode: string }[];
  existing: { code: string; normalizedCode: string }[];
  duplicates: string[];
  invalid: { input: string; reason: string }[];
  total: number;
}

export interface BulkResultResponse {
  created: number;
  skippedExisting: number;
  duplicates: number;
  invalid: number;
}

/**
 * Границы будущей партии: «A-001 … A-010».
 *
 * Человек проверяет диапазон именно по краям: середина предсказуема, а
 * ошибаются в ведущих нулях и в последнем номере.
 */
export function bulkEdges(codes: readonly string[]): string | null {
  if (codes.length === 0) {
    return null;
  }
  const first = codes[0] ?? '';
  const last = codes[codes.length - 1] ?? '';
  return first === last ? first : `${first} … ${last}`;
}

/** Слово «ячейка» в нужном числе: «1 ячейка», «3 ячейки», «10 ячеек». */
export function cellsPlural(count: number): string {
  const tail = count % 100;
  const unit = count % 10;
  if (tail >= 11 && tail <= 14) {
    return `${count} ячеек`;
  }
  if (unit === 1) {
    return `${count} ячейка`;
  }
  if (unit >= 2 && unit <= 4) {
    return `${count} ячейки`;
  }
  return `${count} ячеек`;
}
