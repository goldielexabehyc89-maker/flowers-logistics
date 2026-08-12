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
