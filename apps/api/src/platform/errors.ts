/**
 * Ошибки приложения.
 *
 * Наружу отдаётся только код и русское сообщение из общего справочника.
 * Технические детали (`details`) уходят исключительно в лог.
 */

import { ERROR_MESSAGES, ERROR_STATUS, type ApiErrorBody, type ErrorCode } from '@fl/shared';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;
  readonly publicMessage: string;

  constructor(
    code: ErrorCode,
    options: { message?: string; publicMessage?: string; details?: Record<string, unknown> } = {},
  ) {
    super(options.message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_STATUS[code];
    this.publicMessage = options.publicMessage ?? ERROR_MESSAGES[code];
    this.details = options.details;
  }

  toBody(requestId?: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.publicMessage,
        ...(requestId === undefined ? {} : { requestId }),
      },
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
