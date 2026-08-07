/**
 * Коды ошибок приложения и русские сообщения для интерфейса.
 *
 * Сообщение для пользователя никогда не содержит технических деталей, секретов и PII.
 * Технические подробности уходят только в структурированный лог и администратору.
 */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'Проверьте правильность заполнения полей.',
  UNAUTHENTICATED: 'Требуется вход в систему.',
  FORBIDDEN: 'Недостаточно прав для выполнения операции.',
  NOT_FOUND: 'Запись не найдена.',
  CONFLICT: 'Данные были изменены другим пользователем. Обновите страницу.',
  RATE_LIMITED: 'Слишком много попыток. Повторите позже.',
  INTERNAL_ERROR: 'Внутренняя ошибка сервиса. Попробуйте позже.',
  SERVICE_UNAVAILABLE: 'Сервис временно недоступен.',
};

export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

/**
 * Машинно-читаемые причины конфликта.
 *
 * Общий код `CONFLICT` отвечает на вопрос «почему 409» одинаково для всех случаев,
 * а интерфейсу нужно разное поведение: устаревшую версию достаточно перезапросить,
 * а заказ, уже лежащий в другом маршруте, нужно показать вместе с его номером.
 * Разбирать текст сообщения ради этого нельзя — он предназначен человеку.
 */
export const CONFLICT_KINDS = [
  /** Заказ уже состоит в другом активном маршруте. Возвращается его номер. */
  'ORDER_ALREADY_IN_ROUTE',
  /** Переданная версия записи устарела: кто-то изменил её раньше. */
  'STALE_VERSION',
  /** Заказ не пригоден для ручного распределения. */
  'ORDER_NOT_ELIGIBLE',
  /** Операция допустима только для черновика. */
  'ROUTE_NOT_DRAFT',
  /** Переданный порядок не совпадает с текущим активным составом маршрута. */
  'ROUTE_ORDER_SET_MISMATCH',
] as const;

export type ConflictKind = (typeof CONFLICT_KINDS)[number];

/**
 * Подробности конфликта. Персональных данных не содержит:
 * только вид, номер маршрута и идентификаторы заказов.
 */
export interface ConflictDetails {
  kind: ConflictKind;
  routeNumber?: string;
  orderIds?: string[];
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    /** Сообщение на русском языке, пригодное для показа пользователю. */
    message: string;
    /** Идентификатор запроса для сопоставления с логом. */
    requestId?: string;
    /** Заполняется только для `CONFLICT`. */
    conflict?: ConflictDetails;
  };
}
