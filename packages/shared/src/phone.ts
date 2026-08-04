/**
 * Нормализация телефона.
 *
 * Телефон — логин пользователя, поэтому уникальность и поиск работают только
 * по нормализованному значению: иначе «+7 916 123-45-67» и «89161234567»
 * создали бы двух разных пользователей с одним номером.
 *
 * В первой версии поддерживаются только российские номера. Результат всегда `+7XXXXXXXXXX`.
 */

/** Формат хранения и сравнения: `+7` и ровно 10 цифр. */
export const NORMALIZED_PHONE_PATTERN = /^\+7\d{10}$/;

export class PhoneFormatError extends Error {
  constructor() {
    super('Телефон должен быть российским номером в формате +7XXXXXXXXXX');
    this.name = 'PhoneFormatError';
  }
}

/**
 * Приводит телефон к `+7XXXXXXXXXX`.
 *
 * Принимается распространённый ввод: `+7`, `7` или `8` в начале, пробелы, скобки,
 * дефисы и неразрывные пробелы. Всё остальное отвергается: молчаливое «исправление»
 * непонятного ввода привело бы к входу под чужим номером.
 */
export function normalizePhone(input: string): string {
  const digitsOnly = input.replace(/[\s ()\-.]/g, '');

  if (!/^\+?\d+$/.test(digitsOnly)) {
    throw new PhoneFormatError();
  }

  const digits = digitsOnly.replace(/^\+/, '');

  let national: string;
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    national = digits.slice(1);
  } else if (digits.length === 10) {
    national = digits;
  } else {
    throw new PhoneFormatError();
  }

  const normalized = `+7${national}`;
  if (!NORMALIZED_PHONE_PATTERN.test(normalized)) {
    throw new PhoneFormatError();
  }
  return normalized;
}

/** Безопасный вариант: возвращает null вместо исключения. */
export function tryNormalizePhone(input: string): string | null {
  try {
    return normalizePhone(input);
  } catch {
    return null;
  }
}

/**
 * Маска для показа в интерфейсе: `+7 (916) ***-**-67`.
 * В логи и аудит телефон не пишется даже в маскированном виде.
 */
export function maskPhone(normalized: string): string {
  if (!NORMALIZED_PHONE_PATTERN.test(normalized)) {
    return '[некорректный номер]';
  }
  const national = normalized.slice(2);
  return `+7 (${national.slice(0, 3)}) ***-**-${national.slice(8)}`;
}
