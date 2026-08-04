/**
 * Access-токен.
 *
 * Короткий JWT HS256 (10 минут), который клиент держит только в памяти и передаёт
 * в заголовке `Authorization`. Токен — не источник истины о правах: при каждом запросе
 * статус, версия сессии и роли перечитываются из базы. JWT нужен лишь для того,
 * чтобы дешёво узнать, о каком пользователе и устройстве идёт речь.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export const ACCESS_TOKEN_TTL_SECONDS = 600;

const ISSUER = 'flowers-logistics';
const AUDIENCE = 'flowers-logistics-app';

export interface AccessTokenClaims {
  /** Идентификатор пользователя. */
  userId: string;
  /** Версия сессий пользователя на момент выпуска. */
  sessionVersion: number;
  /** Семья refresh-сессий (устройство). */
  familyId: string;
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
): Promise<string> {
  return new SignJWT({ sv: claims.sessionVersion, fid: claims.familyId } satisfies JWTPayload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secretKey(secret));
}

/**
 * Проверяет подпись и срок действия. Возвращает null при любой ошибке:
 * различать «истёк» и «подделан» на этом уровне не нужно, наружу уходит один и тот же 401.
 */
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });

    const userId = payload.sub;
    const sessionVersion = payload['sv'];
    const familyId = payload['fid'];

    if (
      typeof userId !== 'string' ||
      typeof sessionVersion !== 'number' ||
      typeof familyId !== 'string'
    ) {
      return null;
    }

    return { userId, sessionVersion, familyId };
  } catch {
    return null;
  }
}

/** Извлекает токен из заголовка `Authorization: Bearer …`. */
export function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}
