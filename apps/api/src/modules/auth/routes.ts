/**
 * HTTP-слой авторизации.
 *
 * Access-токен возвращается в теле ответа и хранится клиентом только в памяти.
 * Refresh-токен уходит исключительно в httpOnly cookie с ограниченным путём:
 * недоступный JavaScript токен нельзя украсть через XSS.
 */

import { z } from 'zod';
import { normalizePhone, tryNormalizePhone } from '@fl/shared';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { AppError } from '../../platform/errors.js';
import { authenticate } from './guards.js';
import { activate, login, logout, logoutAll, refresh, type RequestContext } from './service.js';

export const REFRESH_COOKIE_NAME = 'fl_refresh';
export const REFRESH_COOKIE_PATH = '/api/auth';

/** Телефон принимается в свободной форме и приводится к единому виду. */
const phoneSchema = z
  .string()
  .min(1)
  .refine((value) => tryNormalizePhone(value) !== null, 'Некорректный номер телефона')
  .transform((value) => normalizePhone(value));

const fourDigits = z.string().regex(/^\d{4}$/, 'Значение должно состоять из четырёх цифр');
const deviceLabel = z.string().max(120).optional();

const activateSchema = z.object({
  phone: phoneSchema,
  code: fourDigits,
  pin: fourDigits,
  deviceLabel,
});

const loginSchema = z.object({ phone: phoneSchema, pin: fourDigits, deviceLabel });

interface AuthDeps {
  db: Database;
  config: AppConfig;
}

interface IncomingRequest {
  ip: string;
  headers: { authorization?: string | undefined; 'user-agent'?: string | undefined };
  body?: unknown;
}

function requestContext(request: IncomingRequest): RequestContext {
  const body = (request.body ?? {}) as { deviceLabel?: unknown };
  const userAgent = request.headers['user-agent'];

  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
    deviceLabel: typeof body.deviceLabel === 'string' ? body.deviceLabel.slice(0, 120) : null,
  };
}

export async function registerAuthRoutes(app: AppServer, deps: AuthDeps): Promise<void> {
  const { config } = deps;

  const cookieOptions = {
    httpOnly: true,
    // Secure обязателен везде, кроме локальной разработки без TLS.
    secure: !config.isLocal,
    sameSite: 'strict' as const,
    path: REFRESH_COOKIE_PATH,
  };

  app.post('/api/auth/activate', async (request, reply) => {
    // Ответы авторизации не должны оседать в кэшах и историях прокси.
    reply.header('Cache-Control', 'no-store');

    const input = activateSchema.parse(request.body);
    const result = await activate(deps, input, requestContext(request));

    reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, cookieOptions);
    return { accessToken: result.accessToken, user: result.user };
  });

  app.post('/api/auth/login', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');

    const input = loginSchema.parse(request.body);
    const result = await login(deps, input, requestContext(request));

    reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, cookieOptions);
    return { accessToken: result.accessToken, user: result.user };
  });

  app.post('/api/auth/refresh', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');

    const presented = request.cookies[REFRESH_COOKIE_NAME];
    if (presented === undefined || presented === '') {
      throw new AppError('UNAUTHENTICATED', {
        message: 'refresh cookie missing',
        publicMessage: 'Сессия недействительна. Войдите заново.',
      });
    }

    try {
      const result = await refresh(deps, presented, requestContext(request));
      reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, cookieOptions);
      return { accessToken: result.accessToken, user: result.user };
    } catch (error) {
      // Недействительная сессия обязана очистить cookie: иначе клиент будет
      // бесконечно повторять запрос с мёртвым токеном.
      reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
      throw error;
    }
  });

  app.get('/api/auth/me', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const actor = await authenticate(request, deps);

    return {
      user: {
        id: actor.userId,
        phone: actor.phone,
        fullName: actor.fullName,
        roles: actor.roles,
      },
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const actor = await authenticate(request, deps);

    await logout(deps, actor, requestContext(request));

    reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    return { status: 'ok' };
  });

  app.post('/api/auth/logout-all', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const actor = await authenticate(request, deps);

    await logoutAll(deps, actor, requestContext(request));

    reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    return { status: 'ok' };
  });
}
