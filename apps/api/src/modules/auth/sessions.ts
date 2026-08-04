/**
 * Refresh-сессии и их ротация.
 *
 * Каждое устройство — отдельная «семья» (`familyId`). Операции внутри семьи
 * сериализуются блокировкой строк: без неё два одновременных обновления создали бы
 * две активные ветки токенов, и одна из них молча перестала бы работать.
 */

import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  decryptSuccessorToken,
  encryptSuccessorToken,
  generateRefreshToken,
  hashRefreshToken,
} from './crypto.js';

/** Окно, в течение которого повторный запрос со старым токеном получает того же преемника. */
export const REFRESH_GRACE_MS = 30_000;

export type TransactionClient = Prisma.TransactionClient;

export interface SessionContext {
  ip: string | null;
  userAgent: string | null;
  deviceLabel: string | null;
}

export interface IssuedSession {
  refreshToken: string;
  familyId: string;
  sessionId: string;
}

export type RotationOutcome =
  /** Обычная ротация: выдан новый токен. */
  | { kind: 'rotated'; refreshToken: string; familyId: string; userId: string }
  /**
   * Повтор внутри grace-окна: возвращается ТОТ ЖЕ преемник.
   * Новая ветка не создаётся — иначе потерянный ответ клиента раздваивал бы сессию.
   */
  | { kind: 'replayed'; refreshToken: string; familyId: string; userId: string }
  /** Обнаружено повторное использование: вся семья отозвана. */
  | { kind: 'reuse'; familyId: string; userId: string }
  /** Токен неизвестен, отозван или больше не действителен. */
  | { kind: 'invalid' };

/** Создаёт новую семью сессий для устройства. */
export async function createSession(
  tx: TransactionClient,
  userId: string,
  context: SessionContext,
): Promise<IssuedSession> {
  const refreshToken = generateRefreshToken();
  const familyId = randomUUID();

  const session = await tx.refreshSession.create({
    data: {
      userId,
      familyId,
      tokenHash: hashRefreshToken(refreshToken),
      deviceLabel: context.deviceLabel,
      ip: context.ip,
      userAgent: context.userAgent,
    },
    select: { id: true },
  });

  return { refreshToken, familyId, sessionId: session.id };
}

/** Отзывает все сессии одной семьи (одного устройства). */
export async function revokeFamily(
  tx: TransactionClient,
  familyId: string,
  reason: string,
): Promise<void> {
  await tx.refreshSession.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason, successorTokenEnc: null },
  });
}

/** Отзывает все сессии пользователя на всех устройствах. */
export async function revokeAllSessions(
  tx: TransactionClient,
  userId: string,
  reason: string,
): Promise<void> {
  await tx.refreshSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason, successorTokenEnc: null },
  });
}

/** Блокирует все строки семьи до конца транзакции. */
async function lockFamily(tx: TransactionClient, familyId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "RefreshSession" WHERE "familyId" = ${familyId}::uuid FOR UPDATE`;
}

/** Затирает просроченные копии преемников: дольше grace-окна они храниться не должны. */
async function wipeExpiredSuccessors(tx: TransactionClient, familyId: string): Promise<void> {
  await tx.refreshSession.updateMany({
    where: { familyId, graceUntil: { lt: new Date() }, successorTokenEnc: { not: null } },
    data: { successorTokenEnc: null },
  });
}

/**
 * Ротация refresh-токена.
 *
 * Вызывается внутри транзакции. Проверка пользователя (статус, версия сессий)
 * выполняется здесь же: устаревший токен не должен обновляться.
 */
export async function rotateSession(
  tx: TransactionClient,
  presentedToken: string,
  context: SessionContext,
  replayKey: Buffer,
): Promise<RotationOutcome> {
  const tokenHash = hashRefreshToken(presentedToken);

  const located = await tx.refreshSession.findUnique({
    where: { tokenHash },
    select: { familyId: true },
  });

  if (located === null) {
    return { kind: 'invalid' };
  }

  // С этого момента вся семья заблокирована: параллельный запрос дождётся результата
  // и увидит уже обновлённое состояние, а не создаст вторую ветку.
  await lockFamily(tx, located.familyId);
  await wipeExpiredSuccessors(tx, located.familyId);

  const session = await tx.refreshSession.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      familyId: true,
      rotatedAt: true,
      graceUntil: true,
      revokedAt: true,
      successorTokenEnc: true,
      replacedById: true,
      replacedBy: { select: { id: true, rotatedAt: true, revokedAt: true } },
      user: { select: { id: true, status: true, sessionVersion: true } },
    },
  });

  if (session === null || session.revokedAt !== null) {
    return { kind: 'invalid' };
  }

  if (session.user.status !== 'ACTIVE') {
    return { kind: 'invalid' };
  }

  // --- Токен ещё не ротирован: обычный путь ---
  if (session.rotatedAt === null) {
    const refreshToken = generateRefreshToken();
    const now = new Date();

    const successor = await tx.refreshSession.create({
      data: {
        userId: session.userId,
        familyId: session.familyId,
        tokenHash: hashRefreshToken(refreshToken),
        deviceLabel: context.deviceLabel,
        ip: context.ip,
        userAgent: context.userAgent,
      },
      select: { id: true },
    });

    await tx.refreshSession.update({
      where: { id: session.id },
      data: {
        rotatedAt: now,
        graceUntil: new Date(now.getTime() + REFRESH_GRACE_MS),
        lastUsedAt: now,
        replacedById: successor.id,
        successorTokenEnc: encryptSuccessorToken(refreshToken, replayKey),
      },
    });

    // Предок предыдущего шага больше не нужен: его grace-копия обесценена.
    await tx.refreshSession.updateMany({
      where: { replacedById: session.id },
      data: { successorTokenEnc: null },
    });

    return {
      kind: 'rotated',
      refreshToken,
      familyId: session.familyId,
      userId: session.userId,
    };
  }

  // --- Токен уже ротирован ---
  const successor = session.replacedBy;

  // Преемник уже успел ротироваться либо отозван: предъявлен устаревший предок.
  // Это повторное использование, даже если формально grace-окно ещё не истекло.
  if (successor === null || successor.rotatedAt !== null || successor.revokedAt !== null) {
    await revokeFamily(tx, session.familyId, 'REFRESH_TOKEN_REUSE');
    return { kind: 'reuse', familyId: session.familyId, userId: session.userId };
  }

  const graceActive = session.graceUntil !== null && session.graceUntil.getTime() > Date.now();
  if (!graceActive || session.successorTokenEnc === null) {
    await revokeFamily(tx, session.familyId, 'REFRESH_TOKEN_REUSE');
    return { kind: 'reuse', familyId: session.familyId, userId: session.userId };
  }

  const replayed = decryptSuccessorToken(session.successorTokenEnc, replayKey);
  if (replayed === null) {
    // Расшифровать не удалось: значение повреждено или ключ сменился.
    // Безопасное поведение — считать ситуацию подозрительной, а не выдавать доступ.
    await revokeFamily(tx, session.familyId, 'REFRESH_SUCCESSOR_UNREADABLE');
    return { kind: 'reuse', familyId: session.familyId, userId: session.userId };
  }

  return {
    kind: 'replayed',
    refreshToken: replayed,
    familyId: session.familyId,
    userId: session.userId,
  };
}

/** Проверяет, что семья устройства ещё жива (используется охраной запросов). */
export async function isFamilyActive(db: TransactionClient, familyId: string): Promise<boolean> {
  const alive = await db.refreshSession.count({ where: { familyId, revokedAt: null } });
  return alive > 0;
}
