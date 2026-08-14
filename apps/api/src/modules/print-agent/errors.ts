/**
 * Закрытый перечень причин отказа печати.
 *
 * ТЕКСТ ВЫБИРАЕТ СЕРВЕР, А НЕ ОБРАБОТЧИК. Обработчик присылает только код из
 * этого списка. Свободная строка с чужой машины могла бы принести путь к файлу,
 * имя пользователя Windows, имя домена или сообщение драйвера на неизвестном
 * языке — и всё это оказалось бы на экране флориста и в базе. Неизвестный код
 * не отвергается, а превращается в `UNKNOWN`: обработчик более новой версии
 * не должен ронять подтверждение уже случившейся печати.
 *
 * Сообщения написаны для флориста, а не для инженера: он видит их у станка
 * и должен понять, что делать, без обращения к администратору.
 */

export const PRINT_ERROR_CODES = [
  /** Принтер по умолчанию в системе не назначен вовсе. */
  'NO_DEFAULT_PRINTER',
  /** Принтер по умолчанию назначен, но в системе его больше нет. */
  'PRINTER_NOT_FOUND',
  /** Принтер выключен, не подключён или не отвечает. */
  'PRINTER_OFFLINE',
  /** Драйвер принял документ и отказал. */
  'PRINTER_ERROR',
  /** Служба печати Windows недоступна. */
  'SPOOLER_UNAVAILABLE',
  /** Документ не удалось получить с сервера. */
  'DOWNLOAD_FAILED',
  /** Полученный файл не является ожидаемым документом. */
  'DOCUMENT_INVALID',
  /** Обработчик перезапустился, не дождавшись исхода. Исход неизвестен. */
  'AGENT_RESTARTED',
  /** Устройство отозвали, пока документ был в печати. */
  'DEVICE_REVOKED',
  /** Задание слишком долго оставалось в печати без подтверждения. */
  'PRINTING_TIMED_OUT',
  /** Причина, которой этот сервер не знает. */
  'UNKNOWN',
] as const;

export type PrintErrorCode = (typeof PRINT_ERROR_CODES)[number];

const PRINT_ERROR_MESSAGES: Record<PrintErrorCode, string> = {
  NO_DEFAULT_PRINTER: 'На компьютере не выбран принтер по умолчанию. Выберите его в Windows.',
  PRINTER_NOT_FOUND: 'Принтер по умолчанию не найден в системе. Проверьте, подключён ли он.',
  PRINTER_OFFLINE: 'Принтер не отвечает. Проверьте, включён ли он и подключён ли кабель.',
  PRINTER_ERROR: 'Принтер отказался печатать документ. Проверьте бумагу и сообщения на экране.',
  SPOOLER_UNAVAILABLE: 'Служба печати Windows недоступна. Перезагрузите компьютер.',
  DOWNLOAD_FAILED: 'Компьютер не смог получить документ. Проверьте связь с сервером.',
  DOCUMENT_INVALID: 'Полученный документ повреждён. Попробуйте повторить печать.',
  AGENT_RESTARTED: 'Компьютер перезапустился во время печати. Проверьте, вышел ли бланк.',
  DEVICE_REVOKED: 'Устройство отключили, пока документ был в печати. Проверьте бумагу.',
  PRINTING_TIMED_OUT: 'Принтер не подтвердил печать. Проверьте, вышел ли бланк.',
  UNKNOWN: 'Печать не удалась. Проверьте принтер и повторите.',
};

/** Приводит присланный код к известному. Незнакомое становится `UNKNOWN`. */
export function normalizePrintErrorCode(value: string | null | undefined): PrintErrorCode {
  if (value === null || value === undefined) {
    return 'UNKNOWN';
  }
  return (PRINT_ERROR_CODES as readonly string[]).includes(value)
    ? (value as PrintErrorCode)
    : 'UNKNOWN';
}

/** Понятный человеку текст по коду. */
export function printErrorMessage(code: PrintErrorCode): string {
  return PRINT_ERROR_MESSAGES[code];
}

/**
 * Исходы, при которых бумага МОГЛА выйти.
 *
 * Документ уже передан драйверу, подтверждения нет — повторять автоматически
 * нельзя. Такое задание уходит человеку (`NEEDS_REVIEW`).
 */
export const AMBIGUOUS_ERROR_CODES: readonly PrintErrorCode[] = [
  'AGENT_RESTARTED',
  'DEVICE_REVOKED',
  'PRINTING_TIMED_OUT',
  'PRINTER_ERROR',
];

/**
 * Однозначно ли, что бумага НЕ выходила.
 *
 * `PRINTER_ERROR` сознательно считается неоднозначным: драйвер сообщает об
 * отказе и после того, как часть страницы уже ушла на бумагу.
 */
export function isUnambiguousFailure(code: PrintErrorCode): boolean {
  return !AMBIGUOUS_ERROR_CODES.includes(code);
}
