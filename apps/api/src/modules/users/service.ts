/**
 * Управление сотрудниками и курьерами.
 *
 * Физического удаления не существует: недоступность выражается заморозкой, которую
 * можно снять. Каждое изменение выполняется одной транзакцией вместе с аудитом.
 * Наружу никогда не отдаются хеши PIN, кодов и токенов.
 */

import { canManageUserWithRoles, PRIVILEGED_ROLES, type Role, type VehicleType } from '@fl/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { AppError } from '../../platform/errors.js';
import { writeAudit } from '../audit/service.js';
import { generateFourDigitCode, hashSecretCode } from '../auth/crypto.js';
import { revokeAllSessions, type TransactionClient } from '../auth/sessions.js';
import { ACTIVATION_CODE_TTL_MS } from '../auth/service.js';

export interface Actor {
  userId: string;
  roles: Role[];
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

interface Deps {
  db: Database;
  config: AppConfig;
}

/** Публичное представление пользователя: без единого секретного поля. */
const USER_SELECT = {
  id: true,
  phone: true,
  fullName: true,
  status: true,
  comment: true,
  version: true,
  frozenAt: true,
  createdAt: true,
  updatedAt: true,
  pinSetAt: true,
  roles: { select: { role: true } },
  courierProfile: { select: { defaultVehicleType: true, comment: true } },
} as const;

export interface UserView {
  id: string;
  phone: string;
  fullName: string;
  status: string;
  comment: string | null;
  version: number;
  frozenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  pinSetAt: Date | null;
  roles: Role[];
  courierProfile: { defaultVehicleType: VehicleType; comment: string | null } | null;
}

type RawUser = {
  roles: { role: Role }[];
  courierProfile: { defaultVehicleType: VehicleType; comment: string | null } | null;
} & Omit<UserView, 'roles' | 'courierProfile'>;

function toView(user: RawUser): UserView {
  return { ...user, roles: user.roles.map((assignment) => assignment.role) };
}

function forbidden(message: string): AppError {
  return new AppError('FORBIDDEN', { message });
}

/** Проверяет право актора управлять пользователем с такими ролями. */
function assertCanManage(actor: Actor, targetRoles: readonly Role[]): void {
  if (!canManageUserWithRoles(actor.roles, targetRoles)) {
    throw forbidden('actor cannot manage target user');
  }
}

/**
 * Блокирует строку пользователя и заново проверяет права уже внутри транзакции.
 *
 * Проверка прав до транзакции создавала гонку: пока логист открывал карточку курьера,
 * администратор мог выдать этому курьеру роль ADMIN, и операция логиста применилась бы
 * к уже привилегированному сотруднику. `FOR UPDATE` по строке пользователя ждёт
 * завершения конкурентного изменения ролей — оно тоже блокирует эту строку.
 */
async function lockAndAuthorize(
  tx: TransactionClient,
  actor: Actor,
  userId: string,
): Promise<UserView> {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;

  const user = await tx.user.findUnique({ where: { id: userId }, select: USER_SELECT });
  if (user === null) {
    throw new AppError('NOT_FOUND', { message: 'user not found' });
  }

  const view = toView(user);
  assertCanManage(actor, view.roles);
  return view;
}

/**
 * Не позволяет остаться без активного администратора.
 *
 * Advisory-блокировка нужна, потому что две параллельные заморозки двух последних
 * администраторов иначе прошли бы обе: каждая увидела бы «есть ещё один активный».
 */
async function assertNotLastActiveAdmin(tx: TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('flowers-logistics:last-active-admin'))`;

  const target = await tx.user.findUnique({
    where: { id: userId },
    select: { status: true, roles: { select: { role: true } } },
  });

  const isActiveAdmin =
    target?.status === 'ACTIVE' && target.roles.some((assignment) => assignment.role === 'ADMIN');

  if (!isActiveAdmin) {
    return;
  }

  const activeAdmins = await tx.user.count({
    where: { status: 'ACTIVE', roles: { some: { role: 'ADMIN' } } },
  });

  if (activeAdmins <= 1) {
    throw new AppError('CONFLICT', {
      message: 'last active admin protection',
      publicMessage:
        'Нельзя оставить систему без активного администратора. Сначала назначьте другого администратора.',
    });
  }
}

/** Готовит новый одноразовый код: хеш считается вне транзакции, она должна быть короткой. */
async function prepareActivationCode(
  pepper: string,
): Promise<{ code: string; codeHash: string; expiresAt: Date }> {
  const code = generateFourDigitCode();
  return {
    code,
    codeHash: await hashSecretCode(code, pepper),
    expiresAt: new Date(Date.now() + ACTIVATION_CODE_TTL_MS),
  };
}

/** Записывает новый код, инвалидируя предыдущий. Открытый код в базу не попадает. */
async function storeActivationCode(
  tx: TransactionClient,
  userId: string,
  issuedById: string | null,
  prepared: { codeHash: string; expiresAt: Date },
): Promise<void> {
  await tx.activationCode.updateMany({
    where: { userId, activeKey: { not: null } },
    data: { activeKey: null, invalidatedAt: new Date() },
  });

  await tx.activationCode.create({
    data: {
      userId,
      codeHash: prepared.codeHash,
      expiresAt: prepared.expiresAt,
      activeKey: userId,
      issuedById,
    },
  });
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

export interface ListFilters {
  status?: 'PENDING_ACTIVATION' | 'ACTIVE' | 'FROZEN' | undefined;
  role?: Role | undefined;
  limit: number;
  offset: number;
}

/** Ограничение выборки для логиста: только обычные курьеры, без привилегированных ролей. */
function visibilityScope(actor: Actor): Prisma.UserWhereInput {
  if (actor.roles.includes('ADMIN')) {
    return {};
  }
  if (actor.roles.includes('LOGISTICIAN')) {
    return {
      roles: { some: { role: 'COURIER' } },
      NOT: { roles: { some: { role: { in: [...PRIVILEGED_ROLES] } } } },
    };
  }
  throw forbidden('user management is not available for this role');
}

export async function listUsers(
  deps: Deps,
  actor: Actor,
  filters: ListFilters,
): Promise<{ items: UserView[]; total: number }> {
  // Условия объединяются через AND: фильтр роли не должен подменять ограничение
  // видимости, иначе логист увидел бы администраторов, передав role=ADMIN.
  const where: Prisma.UserWhereInput = {
    AND: [
      visibilityScope(actor),
      // По умолчанию в рабочих списках только активные; остальные — явным фильтром.
      { status: filters.status ?? 'ACTIVE' },
      ...(filters.role === undefined ? [] : [{ roles: { some: { role: filters.role } } }]),
    ],
  };

  const [items, total] = await Promise.all([
    deps.db.user.findMany({
      where,
      select: USER_SELECT,
      orderBy: [{ fullName: 'asc' }, { createdAt: 'asc' }],
      take: filters.limit,
      skip: filters.offset,
    }),
    deps.db.user.count({ where }),
  ]);

  return { items: items.map(toView), total };
}

export async function getUser(deps: Deps, actor: Actor, userId: string): Promise<UserView> {
  const user = await deps.db.user.findUnique({ where: { id: userId }, select: USER_SELECT });

  if (user === null) {
    throw new AppError('NOT_FOUND', { message: 'user not found' });
  }

  const view = toView(user);
  assertCanManage(actor, view.roles);
  return view;
}

export async function getUserHistory(
  deps: Deps,
  actor: Actor,
  userId: string,
  limit: number,
): Promise<
  Array<{
    id: string;
    occurredAt: Date;
    action: string;
    actorUserId: string | null;
    actorRoles: Role[];
    oldValue: unknown;
    newValue: unknown;
    source: string;
  }>
> {
  // Право на историю определяется правом на самого пользователя.
  await getUser(deps, actor, userId);

  const entries = await deps.db.auditLog.findMany({
    where: { entityType: 'User', entityId: userId },
    orderBy: { occurredAt: 'desc' },
    take: limit,
    select: {
      id: true,
      occurredAt: true,
      action: true,
      actorUserId: true,
      actorRoles: true,
      oldValue: true,
      newValue: true,
      source: true,
    },
  });

  return entries.map((entry) => ({ ...entry, id: entry.id.toString() }));
}

// ---------------------------------------------------------------------------
// Создание и изменение
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  phone: string;
  fullName: string;
  roles: Role[];
  comment?: string | undefined;
  defaultVehicleType?: VehicleType | undefined;
}

export async function createUser(
  deps: Deps,
  actor: Actor,
  input: CreateUserInput,
  meta: RequestMeta,
): Promise<{ user: UserView; activationCode: string }> {
  assertCanManage(actor, input.roles);

  if (input.roles.length === 0) {
    throw new AppError('VALIDATION_FAILED', { publicMessage: 'Нужно указать хотя бы одну роль.' });
  }

  const existing = await deps.db.user.findUnique({
    where: { phone: input.phone },
    select: { id: true },
  });
  if (existing !== null) {
    throw new AppError('CONFLICT', {
      message: 'phone already exists',
      publicMessage: 'Пользователь с таким телефоном уже существует.',
    });
  }

  const prepared = await prepareActivationCode(deps.config.AUTH_PIN_PEPPER);

  const created = await deps.db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        phone: input.phone,
        fullName: input.fullName,
        comment: input.comment ?? null,
        createdById: actor.userId,
        roles: { create: input.roles.map((role) => ({ role })) },
        ...(input.roles.includes('COURIER')
          ? {
              courierProfile: {
                create: { defaultVehicleType: input.defaultVehicleType ?? 'CAR' },
              },
            }
          : {}),
      },
      select: USER_SELECT,
    });

    await storeActivationCode(tx, user.id, actor.userId, prepared);

    await writeAudit(tx, {
      action: 'USER_CREATED',
      entityType: 'User',
      entityId: user.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { fullName: input.fullName, roles: input.roles, status: 'PENDING_ACTIVATION' },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    await writeAudit(tx, {
      action: 'ACTIVATION_CODE_ISSUED',
      entityType: 'User',
      entityId: user.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { expiresAt: prepared.expiresAt.toISOString() },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return user;
  });

  // Открытый код показывается ровно один раз и больше нигде не хранится.
  return { user: toView(created), activationCode: prepared.code };
}

export interface UpdateUserInput {
  version: number;
  fullName?: string | undefined;
  phone?: string | undefined;
  comment?: string | null | undefined;
  roles?: Role[] | undefined;
  defaultVehicleType?: VehicleType | undefined;
}

export async function updateUser(
  deps: Deps,
  actor: Actor,
  userId: string,
  input: UpdateUserInput,
  meta: RequestMeta,
): Promise<UserView> {
  const current = await deps.db.user.findUnique({ where: { id: userId }, select: USER_SELECT });
  if (current === null) {
    throw new AppError('NOT_FOUND', { message: 'user not found' });
  }

  const currentView = toView(current);
  assertCanManage(actor, currentView.roles);

  if (input.roles !== undefined) {
    if (!actor.roles.includes('ADMIN')) {
      throw forbidden('only admin can change roles');
    }
    if (input.roles.length === 0) {
      throw new AppError('VALIDATION_FAILED', {
        publicMessage: 'Нужно указать хотя бы одну роль.',
      });
    }
  }

  const rolesChanged =
    input.roles !== undefined &&
    [...input.roles].sort().join(',') !== [...currentView.roles].sort().join(',');
  const phoneChanged = input.phone !== undefined && input.phone !== currentView.phone;

  if (phoneChanged) {
    const duplicate = await deps.db.user.findUnique({
      where: { phone: input.phone as string },
      select: { id: true },
    });
    if (duplicate !== null && duplicate.id !== userId) {
      throw new AppError('CONFLICT', {
        message: 'phone already exists',
        publicMessage: 'Пользователь с таким телефоном уже существует.',
      });
    }
  }

  return deps.db.$transaction(async (tx) => {
    // Снятие роли ADMIN у последнего активного администратора недопустимо.
    if (rolesChanged && !(input.roles ?? []).includes('ADMIN')) {
      await assertNotLastActiveAdmin(tx, userId);
    }

    // Оптимистическая блокировка: обновление проходит, только если версия не менялась.
    const updateResult = await tx.user.updateMany({
      where: { id: userId, version: input.version },
      data: {
        ...(input.fullName === undefined ? {} : { fullName: input.fullName }),
        ...(input.phone === undefined ? {} : { phone: input.phone }),
        ...(input.comment === undefined ? {} : { comment: input.comment }),
        version: { increment: 1 },
        ...(phoneChanged || rolesChanged ? { sessionVersion: { increment: 1 } } : {}),
      },
    });

    if (updateResult.count === 0) {
      throw new AppError('CONFLICT', {
        message: 'optimistic lock conflict',
        publicMessage: 'Запись изменена другим пользователем. Обновите страницу и повторите.',
      });
    }

    if (input.roles !== undefined && rolesChanged) {
      await tx.userRoleAssignment.deleteMany({ where: { userId } });
      await tx.userRoleAssignment.createMany({
        data: input.roles.map((role) => ({ userId, role })),
      });

      // Профиль курьера появляется вместе с ролью и не удаляется при её снятии:
      // история транспорта остаётся, удаление данных в проекте запрещено.
      if (input.roles.includes('COURIER') && currentView.courierProfile === null) {
        await tx.courierProfile.create({
          data: { userId, defaultVehicleType: input.defaultVehicleType ?? 'CAR' },
        });
      }
    }

    if (input.defaultVehicleType !== undefined && currentView.courierProfile !== null) {
      await tx.courierProfile.update({
        where: { userId },
        data: { defaultVehicleType: input.defaultVehicleType },
      });
    }

    // Смена телефона или ролей закрывает активные сессии: старые права и логин
    // не должны продолжать действовать.
    if (phoneChanged || rolesChanged) {
      await revokeAllSessions(tx, userId, phoneChanged ? 'PHONE_CHANGED' : 'ROLES_CHANGED');
    }

    await writeAudit(tx, {
      action: 'USER_UPDATED',
      entityType: 'User',
      entityId: userId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      oldValue: {
        fullName: currentView.fullName,
        comment: currentView.comment,
        phoneChanged,
      },
      newValue: {
        fullName: input.fullName ?? currentView.fullName,
        comment: input.comment === undefined ? currentView.comment : input.comment,
        phoneChanged,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    if (rolesChanged) {
      await writeAudit(tx, {
        action: 'USER_ROLES_CHANGED',
        entityType: 'User',
        entityId: userId,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        oldValue: { roles: currentView.roles },
        newValue: { roles: input.roles },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }

    const updated = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: USER_SELECT });
    return toView(updated);
  });
}

// ---------------------------------------------------------------------------
// Заморозка, разморозка, сброс PIN, перевыпуск кода
// ---------------------------------------------------------------------------

export async function freezeUser(
  deps: Deps,
  actor: Actor,
  userId: string,
  meta: RequestMeta,
): Promise<UserView> {
  return deps.db.$transaction(async (tx) => {
    // Права проверяются здесь, а не до транзакции: роли пользователя могли
    // измениться между открытием карточки и нажатием кнопки.
    const current = await lockAndAuthorize(tx, actor, userId);

    if (current.status === 'FROZEN') {
      return current;
    }

    await assertNotLastActiveAdmin(tx, userId);

    await tx.user.update({
      where: { id: userId },
      data: {
        status: 'FROZEN',
        frozenAt: new Date(),
        version: { increment: 1 },
        // Заморозка обязана закрывать доступ немедленно, а не через 10 минут.
        sessionVersion: { increment: 1 },
      },
    });

    await revokeAllSessions(tx, userId, 'USER_FROZEN');

    await writeAudit(tx, {
      action: 'USER_FROZEN',
      entityType: 'User',
      entityId: userId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      oldValue: { status: current.status },
      newValue: { status: 'FROZEN' },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const updated = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: USER_SELECT });
    return toView(updated);
  });
}

export async function unfreezeUser(
  deps: Deps,
  actor: Actor,
  userId: string,
  meta: RequestMeta,
): Promise<UserView> {
  return deps.db.$transaction(async (tx) => {
    const current = await lockAndAuthorize(tx, actor, userId);

    if (current.status !== 'FROZEN') {
      return current;
    }

    // Пользователь без PIN возвращается в ожидание активации, а не в ACTIVE:
    // войти ему всё равно нечем.
    const nextStatus = current.pinSetAt === null ? 'PENDING_ACTIVATION' : 'ACTIVE';

    await tx.user.update({
      where: { id: userId },
      data: { status: nextStatus, frozenAt: null, version: { increment: 1 } },
    });

    // Ранее отозванные сессии не воскрешают: нужен новый вход.
    await writeAudit(tx, {
      action: 'USER_UNFROZEN',
      entityType: 'User',
      entityId: userId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      oldValue: { status: 'FROZEN' },
      newValue: { status: nextStatus },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const updated = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: USER_SELECT });
    return toView(updated);
  });
}

export async function reissueActivationCode(
  deps: Deps,
  actor: Actor,
  userId: string,
  meta: RequestMeta,
): Promise<{ activationCode: string; expiresAt: Date }> {
  const prepared = await prepareActivationCode(deps.config.AUTH_PIN_PEPPER);

  await deps.db.$transaction(async (tx) => {
    const current = await lockAndAuthorize(tx, actor, userId);

    if (current.status === 'FROZEN') {
      throw new AppError('CONFLICT', {
        message: 'frozen user cannot receive activation code',
        publicMessage: 'Сначала разморозьте пользователя.',
      });
    }

    // Действующему сотруднику код активации не выдаётся: иначе его PIN можно было бы
    // заменить публичной активацией. Для него существует отдельная операция сброса PIN,
    // которая аудируется как PIN_RESET и отзывает все сессии.
    if (current.status !== 'PENDING_ACTIVATION') {
      throw new AppError('CONFLICT', {
        message: 'activation code is only for pending users',
        publicMessage:
          'Пользователь уже активирован. Чтобы выдать новый код, используйте сброс PIN.',
      });
    }

    await storeActivationCode(tx, userId, actor.userId, prepared);

    await writeAudit(tx, {
      action: 'ACTIVATION_CODE_REISSUED',
      entityType: 'User',
      entityId: userId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { expiresAt: prepared.expiresAt.toISOString() },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });

  return { activationCode: prepared.code, expiresAt: prepared.expiresAt };
}

export async function resetPin(
  deps: Deps,
  actor: Actor,
  userId: string,
  meta: RequestMeta,
): Promise<{ activationCode: string; expiresAt: Date }> {
  const prepared = await prepareActivationCode(deps.config.AUTH_PIN_PEPPER);

  await deps.db.$transaction(async (tx) => {
    const target = await lockAndAuthorize(tx, actor, userId);

    if (target.status === 'FROZEN') {
      throw new AppError('CONFLICT', {
        message: 'frozen user requires unfreeze first',
        publicMessage: 'Сначала разморозьте пользователя, затем сбрасывайте PIN.',
      });
    }

    await assertNotLastActiveAdmin(tx, userId);

    await tx.user.update({
      where: { id: userId },
      data: {
        pinHash: null,
        pinSetAt: null,
        status: 'PENDING_ACTIVATION',
        version: { increment: 1 },
        sessionVersion: { increment: 1 },
      },
    });

    await revokeAllSessions(tx, userId, 'PIN_RESET');
    await storeActivationCode(tx, userId, actor.userId, prepared);

    await writeAudit(tx, {
      action: 'PIN_RESET',
      entityType: 'User',
      entityId: userId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      oldValue: { status: target.status },
      newValue: { status: 'PENDING_ACTIVATION' },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });

  return { activationCode: prepared.code, expiresAt: prepared.expiresAt };
}
