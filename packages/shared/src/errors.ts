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

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    /** Сообщение на русском языке, пригодное для показа пользователю. */
    message: string;
    /** Идентификатор запроса для сопоставления с логом. */
    requestId?: string;
  };
}
