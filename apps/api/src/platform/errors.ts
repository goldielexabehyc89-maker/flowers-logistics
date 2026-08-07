/**
 * Ошибки приложения.
 *
 * Наружу отдаётся только код и русское сообщение из общего справочника.
 * Технические детали (`details`) уходят исключительно в лог.
 */

import {
  ERROR_MESSAGES,
  ERROR_STATUS,
  type ApiErrorBody,
  type ConflictDetails,
  type ErrorCode,
} from '@fl/shared';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;
  readonly publicMessage: string;
  /**
   * Машинно-читаемая причина конфликта. В отличие от `details`, уходит наружу:
   * интерфейсу нужно различать устаревшую версию и заказ, уже занятый другим
   * маршрутом. Персональных данных здесь нет — только вид, номер и идентификаторы.
   */
  readonly conflict: ConflictDetails | undefined;

  constructor(
    code: ErrorCode,
    options: {
      message?: string;
      publicMessage?: string;
      details?: Record<string, unknown>;
      conflict?: ConflictDetails;
    } = {},
  ) {
    super(options.message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_STATUS[code];
    this.publicMessage = options.publicMessage ?? ERROR_MESSAGES[code];
    this.details = options.details;
    this.conflict = options.conflict;
  }

  toBody(requestId?: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.publicMessage,
        ...(requestId === undefined ? {} : { requestId }),
        ...(this.conflict === undefined ? {} : { conflict: this.conflict }),
      },
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
