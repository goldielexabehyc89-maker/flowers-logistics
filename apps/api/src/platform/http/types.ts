/**
 * Тип экземпляра Fastify с нашим логгером.
 *
 * Fastify параметризуется типом логгера. Поскольку мы передаём собственный экземпляр pino,
 * во всех сигнатурах используется этот псевдоним, а не generic по умолчанию.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, RawServerDefault } from 'fastify';
import type { AppLogger } from '../logging/logger.js';

export type AppServer = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  AppLogger
>;
