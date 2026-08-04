/**
 * Бизнес-логика авторизации.
 *
 * Здесь собраны сценарии активации, входа, обновления сессии и выхода.
 * Каждое изменение выполняется одной транзакцией вместе с записью аудита.
 */

import type { Role } from '@fl/shared';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { AppError } from '../../platform/errors.js';
import { writeAudit } from '../audit/service.js';
import {
  createDummyPinHash,
  hashSecretCode,
  isValidFourDigitCode,
  verifySecretCode,
} from './crypto.js';
import { checkLockout, ipKey, phoneKey, registerFailure, resetFailures } from './lockout.js';
import {
  createSession,
  revokeAllSessions,
  revokeFamily,
  rotateSession,
  type SessionContext,
} from './sessions.js';
import { signAccessToken } from './tokens.js';

/** Срок жизни одноразового кода активации. */
export const ACTIVATION_CODE_TTL_MS = 30 * 60 * 1000;

export type RequestContext = SessionContext;

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: AuthenticatedUser;
}

export interface AuthenticatedUser {
  id: string;
  phone: string;
  fullName: string;
  status: 'PENDING_ACTIVATION' | 'ACTIVE' | 'FROZEN';
  roles: Role[];
}

interface Deps {
  db: Database;
  config: AppConfig;
}

/**
 * Хеш-«пустышка» для неизвестного телефона: без неё ответ приходил бы заметно быстрее,
 * и список телефонов сотрудников можно было бы собрать по времени ответа.
 */
let dummyPinHash: string | null = null;

async function getDummyPinHash(pepper: string): Promise<string> {
  dummyPinHash ??= await createDummyPinHash(pepper);
  return dummyPinHash;
}

/** Единая ошибка для любой неудачи входа: различать причины наружу нельзя. */
function invalidCredentials(): AppError {
  return new AppError('UNAUTHENTICATED', {
    message: 'invalid credentials',
    publicMessage: 'Неверный телефон или PIN.',
  });
}

function rateLimited(retryAfterSeconds: number): AppError {
  return new AppError('RATE_LIMITED', {
    message: 'lockout active',
    publicMessage: `Слишком много попыток. Повторите через ${retryAfterSeconds} с.`,
    details: { retryAfterSeconds },
  });
}

function toAuthenticatedUser(user: {
  id: string;
  phone: string;
  fullName: string;
  status: string;
  roles: { role: Role }[];
}): AuthenticatedUser {
  return {
    id: user.id,
    phone: user.phone,
    fullName: user.fullName,
    status: user.status as AuthenticatedUser['status'],
    roles: user.roles.map((assignment) => assignment.role),
  };
}

/** Выдаёт access-токен для уже созданной сессии. */
async function issueAccessToken(
  config: AppConfig,
  userId: string,
  sessionVersion: number,
  familyId: string,
): Promise<string> {
  return signAccessToken({ userId, sessionVersion, familyId }, config.AUTH_ACCESS_TOKEN_SECRET);
}

/**
 * Активация: телефон + одноразовый код + новый PIN.
 * Успех погашает код, устанавливает PIN, переводит пользователя в ACTIVE и создаёт сессию.
 */
export async function activate(
  deps: Deps,
  input: { phone: string; code: string; pin: string },
  context: RequestContext,
): Promise<AuthResult> {
  const { db, config } = deps;

  if (!isValidFourDigitCode(input.pin)) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: 'PIN должен состоять из четырёх цифр.',
    });
  }

  const keys = [phoneKey(input.phone), ...(context.ip === null ? [] : [ipKey(context.ip)])];
  const lockout = await checkLockout(db, keys);
  if (lockout.locked) {
    throw rateLimited(lockout.retryAfterSeconds);
  }

  const user = await db.user.findUnique({
    where: { phone: input.phone },
    select: {
      id: true,
      phone: true,
      fullName: true,
      status: true,
      sessionVersion: true,
      roles: { select: { role: true } },
      activationCodes: {
        where: { activeKey: { not: null } },
        select: { id: true, codeHash: true, expiresAt: true },
        take: 1,
      },
    },
  });

  const activeCode = user?.activationCodes[0];

  // Активация доступна ТОЛЬКО пользователю в ожидании активации.
  // Без этого условия код активации превращался бы в способ заменить PIN
  // действующему сотруднику в обход сброса PIN администратором.
  // Неизвестный телефон, неподходящий статус и отсутствие кода обрабатываются
  // одинаково по времени и по ответу.
  if (
    user === undefined ||
    user === null ||
    user.status !== 'PENDING_ACTIVATION' ||
    activeCode === undefined
  ) {
    await verifySecretCode(
      await getDummyPinHash(config.AUTH_PIN_PEPPER),
      input.code,
      config.AUTH_PIN_PEPPER,
    );
    await db.$transaction(async (tx) => {
      await tx.authAttempt.create({
        data: {
          phone: input.phone,
          userId: user?.id ?? null,
          kind: 'ACTIVATION',
          success: false,
          ip: context.ip,
          userAgent: context.userAgent,
          reason: 'INVALID_ACTIVATION',
        },
      });
      await registerFailure(tx, keys);
    });
    throw invalidCredentials();
  }

  const codeValid =
    activeCode.expiresAt.getTime() > Date.now() &&
    (await verifySecretCode(activeCode.codeHash, input.code, config.AUTH_PIN_PEPPER));

  if (!codeValid) {
    await db.$transaction(async (tx) => {
      await tx.authAttempt.create({
        data: {
          phone: input.phone,
          userId: user.id,
          kind: 'ACTIVATION',
          success: false,
          ip: context.ip,
          userAgent: context.userAgent,
          reason: 'INVALID_ACTIVATION',
        },
      });
      await registerFailure(tx, keys);
    });
    throw invalidCredentials();
  }

  const pinHash = await hashSecretCode(input.pin, config.AUTH_PIN_PEPPER);

  const result = await db.$transaction(async (tx) => {
    // Единый порядок блокировок: строка User → ActivationCode → сессия и аудит.
    // Обратный порядок здесь и в перевыпуске кода приводил к взаимной блокировке.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id}::uuid FOR UPDATE`;

    // Статус перечитывается под блокировкой: пока проверялся код, администратор мог
    // активировать пользователя другим способом или заморозить его.
    const locked = await tx.user.findUnique({
      where: { id: user.id },
      select: { status: true },
    });

    if (locked === null || locked.status !== 'PENDING_ACTIVATION') {
      throw invalidCredentials();
    }

    // Погашение кода условное: он должен быть всё ещё активным, непогашенным,
    // неинвалидированным и не истёкшим. Из двух одновременных запросов с одним кодом
    // выигрывает ровно один — второй получит count = 0 и откатит всю транзакцию,
    // не создав ни сессии, ни успешной записи аудита.
    const consumed = await tx.activationCode.updateMany({
      where: {
        id: activeCode.id,
        activeKey: { not: null },
        consumedAt: null,
        invalidatedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date(), activeKey: null },
    });

    if (consumed.count === 0) {
      throw invalidCredentials();
    }

    // Смена статуса тоже условная: только из PENDING_ACTIVATION.
    const activated = await tx.user.updateMany({
      where: { id: user.id, status: 'PENDING_ACTIVATION' },
      data: {
        pinHash,
        pinSetAt: new Date(),
        status: 'ACTIVE',
        version: { increment: 1 },
      },
    });

    if (activated.count === 0) {
      throw invalidCredentials();
    }

    const updated = await tx.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { id: true, phone: true, fullName: true, status: true, sessionVersion: true },
    });

    const session = await createSession(tx, user.id, context);

    await tx.authAttempt.create({
      data: {
        phone: input.phone,
        userId: user.id,
        kind: 'ACTIVATION',
        success: true,
        ip: context.ip,
        userAgent: context.userAgent,
      },
    });

    await writeAudit(tx, {
      action: 'USER_ACTIVATED',
      entityType: 'User',
      entityId: user.id,
      actorUserId: user.id,
      actorRoles: user.roles.map((assignment) => assignment.role),
      newValue: { status: 'ACTIVE' },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await resetFailures(tx, keys);

    return { updated, session };
  });

  const accessToken = await issueAccessToken(
    config,
    user.id,
    result.updated.sessionVersion,
    result.session.familyId,
  );

  return {
    accessToken,
    refreshToken: result.session.refreshToken,
    user: toAuthenticatedUser({ ...result.updated, roles: user.roles }),
  };
}

/** Вход по телефону и PIN. */
export async function login(
  deps: Deps,
  input: { phone: string; pin: string; deviceLabel?: string | undefined },
  context: RequestContext,
): Promise<AuthResult> {
  const { db, config } = deps;

  const keys = [phoneKey(input.phone), ...(context.ip === null ? [] : [ipKey(context.ip)])];
  const lockout = await checkLockout(db, keys);
  if (lockout.locked) {
    throw rateLimited(lockout.retryAfterSeconds);
  }

  const user = await db.user.findUnique({
    where: { phone: input.phone },
    select: {
      id: true,
      phone: true,
      fullName: true,
      status: true,
      pinHash: true,
      sessionVersion: true,
      roles: { select: { role: true } },
    },
  });

  // Проверка выполняется всегда, даже для неизвестного номера: сравнение с dummy hash
  // занимает столько же времени, сколько настоящая проверка.
  const candidateHash = user?.pinHash ?? (await getDummyPinHash(config.AUTH_PIN_PEPPER));
  const pinMatches = await verifySecretCode(candidateHash, input.pin, config.AUTH_PIN_PEPPER);
  const allowed = user !== null && user.status === 'ACTIVE' && user.pinHash !== null && pinMatches;

  if (!allowed || user === null) {
    await db.$transaction(async (tx) => {
      await tx.authAttempt.create({
        data: {
          phone: input.phone,
          userId: user?.id ?? null,
          kind: 'LOGIN',
          success: false,
          ip: context.ip,
          userAgent: context.userAgent,
          reason: 'INVALID_CREDENTIALS',
        },
      });
      await registerFailure(tx, keys);
    });
    throw invalidCredentials();
  }

  const sessionContext: RequestContext = {
    ...context,
    deviceLabel: input.deviceLabel ?? context.deviceLabel,
  };

  const session = await db.$transaction(async (tx) => {
    const created = await createSession(tx, user.id, sessionContext);

    await tx.authAttempt.create({
      data: {
        phone: input.phone,
        userId: user.id,
        kind: 'LOGIN',
        success: true,
        ip: context.ip,
        userAgent: context.userAgent,
      },
    });

    await writeAudit(tx, {
      action: 'AUTH_LOGIN_SUCCEEDED',
      entityType: 'User',
      entityId: user.id,
      actorUserId: user.id,
      actorRoles: user.roles.map((assignment) => assignment.role),
      newValue: { deviceLabel: sessionContext.deviceLabel },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await resetFailures(tx, keys);

    return created;
  });

  const accessToken = await issueAccessToken(
    config,
    user.id,
    user.sessionVersion,
    session.familyId,
  );

  return { accessToken, refreshToken: session.refreshToken, user: toAuthenticatedUser(user) };
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  user: AuthenticatedUser;
}

/** Обновление сессии с безопасной ротацией. */
export async function refresh(
  deps: Deps,
  presentedToken: string,
  context: RequestContext,
): Promise<RefreshResult> {
  const { db, config } = deps;

  const outcome = await db.$transaction(async (tx) => {
    const rotation = await rotateSession(tx, presentedToken, context, config.refreshReplayKey);

    if (rotation.kind === 'reuse') {
      // Пользователь обязан существовать: идентификатор пришёл из его же сессии.
      // Пустой телефон в журнале сделал бы запись бесполезной при расследовании.
      const actor = await tx.user.findUniqueOrThrow({
        where: { id: rotation.userId },
        select: { phone: true, roles: { select: { role: true } } },
      });

      await writeAudit(tx, {
        action: 'AUTH_REFRESH_REUSE_DETECTED',
        entityType: 'RefreshSession',
        entityId: rotation.familyId,
        actorUserId: rotation.userId,
        actorRoles: actor.roles.map((assignment) => assignment.role),
        newValue: { familyRevoked: true },
        ip: context.ip,
        userAgent: context.userAgent,
      });

      await tx.authAttempt.create({
        data: {
          // Настоящий нормализованный телефон: без него запись бесполезна
          // при расследовании и не находится по владельцу.
          phone: actor.phone,
          userId: rotation.userId,
          kind: 'REFRESH',
          success: false,
          ip: context.ip,
          userAgent: context.userAgent,
          reason: 'REFRESH_TOKEN_REUSE',
        },
      });
    }

    return rotation;
  });

  if (outcome.kind === 'invalid' || outcome.kind === 'reuse') {
    throw new AppError('UNAUTHENTICATED', {
      message: `refresh rejected: ${outcome.kind}`,
      publicMessage: 'Сессия недействительна. Войдите заново.',
    });
  }

  const user = await db.user.findUniqueOrThrow({
    where: { id: outcome.userId },
    select: {
      id: true,
      phone: true,
      fullName: true,
      status: true,
      sessionVersion: true,
      roles: { select: { role: true } },
    },
  });

  const accessToken = await issueAccessToken(
    config,
    user.id,
    user.sessionVersion,
    outcome.familyId,
  );

  return {
    accessToken,
    refreshToken: outcome.refreshToken,
    user: toAuthenticatedUser(user),
  };
}

/** Выход с текущего устройства: отзывается только его семья. */
export async function logout(
  deps: Deps,
  actor: { userId: string; familyId: string; roles: Role[] },
  context: RequestContext,
): Promise<void> {
  await deps.db.$transaction(async (tx) => {
    await revokeFamily(tx, actor.familyId, 'LOGOUT');
    await writeAudit(tx, {
      action: 'AUTH_LOGOUT',
      entityType: 'RefreshSession',
      entityId: actor.familyId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  });
}

/**
 * Выход со всех устройств. Кроме отзыва сессий увеличивается `sessionVersion`,
 * иначе уже выданные access-токены продолжали бы работать до истечения десяти минут.
 */
export async function logoutAll(
  deps: Deps,
  actor: { userId: string; roles: Role[] },
  context: RequestContext,
): Promise<void> {
  await deps.db.$transaction(async (tx) => {
    await revokeAllSessions(tx, actor.userId, 'LOGOUT_ALL');
    await tx.user.update({
      where: { id: actor.userId },
      data: { sessionVersion: { increment: 1 } },
    });
    await writeAudit(tx, {
      action: 'AUTH_LOGOUT_ALL',
      entityType: 'User',
      entityId: actor.userId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  });
}

/** Только для тестов: сбрасывает закешированный dummy hash. */
export function resetDummyHashCache(): void {
  dummyPinHash = null;
}
