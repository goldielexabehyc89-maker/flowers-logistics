/**
 * Структурированный логгер приложения.
 *
 * Формат — JSON, время в ISO-8601. Любой объект, попадающий в лог, проходит глубокую редакцию
 * чувствительных полей (см. `redact.ts`).
 */

import { pino, type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from '../config.js';
import { redactDeep, safePath } from './redact.js';

export type AppLogger = Logger;

export function buildLoggerOptions(config: AppConfig): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    base: {
      service: 'flowers-logistics-api',
      env: config.APP_ENV,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      // Единая точка редакции: сюда попадает всё, что логируется как объект.
      log: (object) => redactDeep(object) as Record<string, unknown>,
    },
    // Дублирующая защита на уровне pino для заголовков запроса/ответа.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'headers.authorization',
        'headers.cookie',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req(request: { method?: string; url?: string; id?: string }) {
        return {
          method: request.method,
          path: request.url === undefined ? undefined : safePath(request.url),
          requestId: request.id,
        };
      },
      res(reply: { statusCode?: number }) {
        return { statusCode: reply.statusCode };
      },
    },
  };
}

export function createLogger(config: AppConfig): AppLogger {
  return pino(buildLoggerOptions(config));
}
