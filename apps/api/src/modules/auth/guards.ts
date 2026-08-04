/**
 * Проверка доступа на каждый запрос.
 *
 * JWT сам по себе не считается достаточным основанием: заморозка, сброс PIN, выход
 * со всех устройств и смена ролей должны закрывать доступ немедленно, а не через
 * десять минут, когда истечёт access-токен. Поэтому при каждом запросе состояние
 * пользователя и его роли перечитываются из базы.
 *
 * Проверка вызывается явно в начале обработчика, а не хуком: так она видна в коде
 * маршрута и не зависит от типизации хуков Fastify.
 */

import type { Role } from '@fl/shared';
import { AppError } from '../../platform/errors.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { extractBearerToken, verifyAccessToken } from './tokens.js';

export interface AuthenticatedActor {
  userId: string;
  familyId: string;
  roles: Role[];
  fullName: string;
  phone: string;
}

/** Минимум, который нужен охране от объекта запроса. */
export interface AuthenticatableRequest {
  headers: { authorization?: string | undefined };
}

export interface AuthDependencies {
  db: Database;
  config: AppConfig;
}

function unauthenticated(reason: string): AppError {
  return new AppError('UNAUTHENTICATED', {
    message: reason,
    publicMessage: 'Требуется вход в систему.',
  });
}

/** Возвращает актора запроса либо бросает 401. */
export async function authenticate(
  request: AuthenticatableRequest,
  deps: AuthDependencies,
): Promise<AuthenticatedActor> {
  const token = extractBearerToken(request.headers.authorization);
  if (token === null) {
    throw unauthenticated('access token missing');
  }

  const claims = await verifyAccessToken(token, deps.config.AUTH_ACCESS_TOKEN_SECRET);
  if (claims === null) {
    throw unauthenticated('access token invalid');
  }

  const user = await deps.db.user.findUnique({
    where: { id: claims.userId },
    select: {
      id: true,
      phone: true,
      fullName: true,
      status: true,
      sessionVersion: true,
      roles: { select: { role: true } },
    },
  });

  if (user === null || user.status !== 'ACTIVE') {
    throw unauthenticated('user is not active');
  }

  // Версия сессий увеличивается при заморозке, сбросе PIN, смене телефона и ролей
  // и при выходе со всех устройств: старый access-токен перестаёт действовать сразу.
  if (user.sessionVersion !== claims.sessionVersion) {
    throw unauthenticated('session version outdated');
  }

  const familyAlive = await deps.db.refreshSession.count({
    where: { familyId: claims.familyId, revokedAt: null },
  });
  if (familyAlive === 0) {
    throw unauthenticated('device session revoked');
  }

  return {
    userId: user.id,
    familyId: claims.familyId,
    phone: user.phone,
    fullName: user.fullName,
    roles: user.roles.map((assignment) => assignment.role),
  };
}

/** Требует хотя бы одну из перечисленных ролей. */
export function requireAnyRole(actor: AuthenticatedActor, allowed: readonly Role[]): void {
  if (!actor.roles.some((role) => allowed.includes(role))) {
    throw new AppError('FORBIDDEN', { message: `role required: ${allowed.join('|')}` });
  }
}

/** Аутентификация вместе с проверкой ролей — самый частый случай. */
export async function authenticateWithRoles(
  request: AuthenticatableRequest,
  deps: AuthDependencies,
  allowed: readonly Role[],
): Promise<AuthenticatedActor> {
  const actor = await authenticate(request, deps);
  requireAnyRole(actor, allowed);
  return actor;
}
