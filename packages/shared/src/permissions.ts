/**
 * Матрица прав на управление пользователями.
 *
 * Правила вынесены в чистые функции, чтобы их можно было проверить тестами
 * и переиспользовать в интерфейсе, не повторяя логику. Сервер всегда решает
 * самостоятельно: клиентское скрытие кнопок — удобство, а не защита.
 */

import type { Role } from './roles.js';

/** Роли, дающие доступ к чужим данным или к настройкам системы. */
export const PRIVILEGED_ROLES: readonly Role[] = ['ADMIN', 'LOGISTICIAN', 'WAREHOUSE'];

export function isPrivileged(roles: readonly Role[]): boolean {
  return roles.some((role) => PRIVILEGED_ROLES.includes(role));
}

/**
 * Курьер, доступный логисту, — это пользователь с ролью COURIER и БЕЗ привилегированных ролей.
 * Курьер, которому дополнительно выдали ADMIN или LOGISTICIAN, логисту недоступен:
 * иначе логист смог бы через «своего курьера» изменить администратора.
 */
export function isPlainCourier(roles: readonly Role[]): boolean {
  return roles.includes('COURIER') && !isPrivileged(roles);
}

/** Может ли актор управлять пользователем с такими ролями (создание, изменение, заморозка). */
export function canManageUserWithRoles(
  actorRoles: readonly Role[],
  targetRoles: readonly Role[],
): boolean {
  if (actorRoles.includes('ADMIN')) {
    return true;
  }
  if (actorRoles.includes('LOGISTICIAN')) {
    return isPlainCourier(targetRoles);
  }
  return false;
}

/** Может ли актор назначать роли. Только администратор. */
export function canAssignRoles(actorRoles: readonly Role[]): boolean {
  return actorRoles.includes('ADMIN');
}

/** Роли, которые актор вправе присвоить создаваемому пользователю. */
export function assignableRoles(actorRoles: readonly Role[]): readonly Role[] {
  if (actorRoles.includes('ADMIN')) {
    return ['ADMIN', 'LOGISTICIAN', 'COURIER', 'WAREHOUSE'];
  }
  if (actorRoles.includes('LOGISTICIAN')) {
    return ['COURIER'];
  }
  return [];
}

/** Имеет ли актор доступ к разделу управления пользователями вообще. */
export function canAccessUserManagement(actorRoles: readonly Role[]): boolean {
  return actorRoles.includes('ADMIN') || actorRoles.includes('LOGISTICIAN');
}

/**
 * Ограничение выборки: логисту сервер принудительно показывает только курьеров.
 * `null` означает «без ограничения» (администратор).
 */
export function forcedRoleFilter(actorRoles: readonly Role[]): Role | null {
  if (actorRoles.includes('ADMIN')) {
    return null;
  }
  if (actorRoles.includes('LOGISTICIAN')) {
    return 'COURIER';
  }
  return null;
}
