/**
 * Общие типы отказов DaData.
 *
 * Платный `Clean API` в этом проекте НЕ используется и клиента для него здесь
 * намеренно нет: автоматическое геокодирование выполняет собственный Photon,
 * а DaData участвует только подсказками в ручной правке адреса
 * (`docs/OWNER_DECISIONS.md`, `GEO-005`). Неиспользуемый платный вызов,
 * оставленный «на всякий случай», рано или поздно кто-нибудь вызовет.
 *
 * Наружу не выходит ничего чувствительного: ни ключи, ни заголовки, ни адрес,
 * ни тело ответа. Ошибка содержит только безопасный код и HTTP-статус.
 */

/**
 * Коды отказа подсказок.
 *
 * Перечислено только то, что действительно может произойти на единственном
 * оставшемся пути — подсказках адреса. Коды исчезнувшего платного клиента
 * (лимит, баланс, отзыв прав) убраны: недостижимая ветка обработки ошибок
 * выглядит как защита, но никогда не проверяется и потому не защищает.
 */
export type DadataErrorCode =
  | 'BAD_REQUEST'
  | 'SERVER_ERROR'
  | 'TRANSPORT_ERROR'
  | 'BAD_RESPONSE';

const MESSAGES: Record<DadataErrorCode, string> = {
  BAD_REQUEST: 'DaData отклонила запрос',
  SERVER_ERROR: 'DaData ответила ошибкой',
  TRANSPORT_ERROR: 'Не удалось связаться с DaData',
  BAD_RESPONSE: 'Ответ DaData не удалось разобрать',
};

/**
 * Ошибка провайдера без подробностей запроса.
 *
 * Текст фиксирован: динамическое сообщение внешнего сервиса могло бы протащить
 * в лог отправленный адрес.
 */
export class DadataError extends Error {
  readonly code: DadataErrorCode;
  readonly status: number | null;

  constructor(code: DadataErrorCode, status: number | null = null) {
    super(MESSAGES[code]);
    this.name = 'DadataError';
    this.code = code;
    this.status = status;
  }
}

export interface DadataCredentials {
  apiKey: string | null;
  secretKey: string | null;
}
