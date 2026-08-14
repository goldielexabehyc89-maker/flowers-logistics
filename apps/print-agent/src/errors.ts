/**
 * Причины отказа, которые обработчик имеет право назвать.
 *
 * СПИСОК ЗАКРЫТ. Это копия серверного перечня
 * (`apps/api/src/modules/print-agent/errors.ts`), а не импорт: обработчик —
 * отдельная программа на чужом компьютере, он не собирается вместе с сервером
 * и не может зависеть от его модулей.
 *
 * Копия намеренно короче оригинала. `DEVICE_REVOKED`, `PRINTING_TIMED_OUT` и
 * `UNKNOWN` — приговоры сервера, а не наблюдения обработчика: об отзыве он
 * узнаёт отказом 401 и отчитаться уже не может, таймаут отмеряет сервер, а
 * `UNKNOWN` сервер подставляет сам, встретив незнакомый код.
 *
 * Текст драйвера сюда не попадает НИКОГДА. Сообщение Windows о сбое печати
 * несёт путь к файлу, имя пользователя и имя домена, а прочитает его флорист
 * у станка — и оно же осядет в базе. Наружу уходит только код.
 */
export const AGENT_ERROR_CODES = [
  'NO_DEFAULT_PRINTER',
  'PRINTER_NOT_FOUND',
  'PRINTER_OFFLINE',
  'PRINTER_ERROR',
  'SPOOLER_UNAVAILABLE',
  'PRINT_HELPER_MISSING',
  'DOWNLOAD_FAILED',
  'DOCUMENT_INVALID',
  'AGENT_RESTARTED',
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/**
 * Тексты для окна состояния на самом рабочем месте.
 *
 * Дублируют серверные по смыслу, но живут отдельно: когда связи с сервером нет,
 * объяснить происходящее человеку у принтера должен сам обработчик.
 */
const AGENT_ERROR_MESSAGES: Record<AgentErrorCode, string> = {
  NO_DEFAULT_PRINTER: 'Не выбран принтер по умолчанию. Выберите его в настройках Windows.',
  PRINTER_NOT_FOUND: 'Принтер по умолчанию не найден в системе. Проверьте, подключён ли он.',
  PRINTER_OFFLINE: 'Принтер не отвечает. Проверьте питание и кабель.',
  PRINTER_ERROR: 'Принтер отказался печатать. Проверьте бумагу и сообщения на его экране.',
  SPOOLER_UNAVAILABLE: 'Служба печати Windows недоступна. Перезагрузите компьютер.',
  PRINT_HELPER_MISSING:
    'Не установлена программа для печати PDF без диалога. Установите SumatraPDF.',
  DOWNLOAD_FAILED: 'Не удалось получить документ с сервера. Проверьте связь.',
  DOCUMENT_INVALID: 'Полученный файл не является бланком. Печать отменена.',
  AGENT_RESTARTED: 'Программа перезапустилась во время печати. Проверьте, вышел ли бланк.',
};

export function agentErrorMessage(code: AgentErrorCode): string {
  return AGENT_ERROR_MESSAGES[code];
}

/**
 * Отказ, у которого есть код из закрытого перечня.
 *
 * Отдельный класс нужен затем, чтобы случайное исключение (ошибка разбора,
 * опечатка в коде обработчика) НЕ превратилось молча в отчёт о неудачной
 * печати: такой отчёт закрыл бы задание, которое на самом деле никто не
 * рассматривал.
 */
export class PrintFailure extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PrintFailure';
    this.code = code;
  }
}

/**
 * Сервер ответил 401.
 *
 * Обособлен от сетевых сбоев намеренно: сетевой сбой повторяют, а отзыв
 * устройства повторять бессмысленно и вредно — обработчик обязан перестать
 * забирать задания, иначе он будет бесконечно занимать очередь отказами.
 */
export class DeviceRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceRevokedError';
  }
}

/**
 * Сервер недоступен или ответил не тем.
 *
 * Сюда же попадает бессмысленный ответ на понятный запрос: реакция обработчика
 * одна и та же — подождать и повторить, — а различать «сети нет» и «сервер
 * сломан» на рабочем месте флориста нечем и незачем.
 */
export class TransportFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransportFailure';
  }
}

/** Настройка рабочего места непригодна: без неё запускаться нельзя. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
