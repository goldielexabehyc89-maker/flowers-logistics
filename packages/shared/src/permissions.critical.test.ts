/**
 * Критическая проверка матрицы прав.
 *
 * Логист управляет курьерами, но не должен получить доступ к администраторам,
 * логистам и кладовщикам — в том числе через пользователя, которому роль курьера
 * выдана вместе с привилегированной.
 */

import { describe, expect, it } from 'vitest';
import {
  assignableRoles,
  canAccessUserManagement,
  canAssignRoles,
  canManageUserWithRoles,
  forcedRoleFilter,
  isPlainCourier,
  isPrivileged,
} from './permissions.js';

const ADMIN = ['ADMIN'] as const;
const LOGISTICIAN = ['LOGISTICIAN'] as const;
const COURIER = ['COURIER'] as const;
const WAREHOUSE = ['WAREHOUSE'] as const;

describe('права на управление пользователями', () => {
  it('администратор управляет всеми', () => {
    for (const target of [ADMIN, LOGISTICIAN, COURIER, WAREHOUSE]) {
      expect(canManageUserWithRoles(ADMIN, target)).toBe(true);
    }
  });

  it('логист управляет только обычным курьером', () => {
    expect(canManageUserWithRoles(LOGISTICIAN, COURIER)).toBe(true);
    expect(canManageUserWithRoles(LOGISTICIAN, ADMIN)).toBe(false);
    expect(canManageUserWithRoles(LOGISTICIAN, LOGISTICIAN)).toBe(false);
    expect(canManageUserWithRoles(LOGISTICIAN, WAREHOUSE)).toBe(false);
  });

  it('курьер с привилегированной ролью логисту недоступен', () => {
    // Иначе логист изменил бы администратора, которому дополнительно выдали COURIER.
    expect(canManageUserWithRoles(LOGISTICIAN, ['COURIER', 'ADMIN'])).toBe(false);
    expect(canManageUserWithRoles(LOGISTICIAN, ['COURIER', 'LOGISTICIAN'])).toBe(false);
    expect(canManageUserWithRoles(LOGISTICIAN, ['COURIER', 'WAREHOUSE'])).toBe(false);
    expect(isPlainCourier(['COURIER', 'ADMIN'])).toBe(false);
    expect(isPlainCourier(COURIER)).toBe(true);
  });

  it('курьер и кладовщик не имеют доступа к управлению пользователями', () => {
    expect(canAccessUserManagement(COURIER)).toBe(false);
    expect(canAccessUserManagement(WAREHOUSE)).toBe(false);
    expect(canManageUserWithRoles(COURIER, COURIER)).toBe(false);
    expect(canManageUserWithRoles(WAREHOUSE, COURIER)).toBe(false);
  });

  it('роли назначает только администратор', () => {
    expect(canAssignRoles(ADMIN)).toBe(true);
    expect(canAssignRoles(LOGISTICIAN)).toBe(false);
    expect(assignableRoles(LOGISTICIAN)).toEqual(['COURIER']);
    expect(assignableRoles(COURIER)).toEqual([]);
  });

  it('выборка логиста принудительно ограничена курьерами', () => {
    expect(forcedRoleFilter(ADMIN)).toBeNull();
    expect(forcedRoleFilter(LOGISTICIAN)).toBe('COURIER');
  });

  it('привилегированные роли перечислены полностью', () => {
    expect(isPrivileged(ADMIN)).toBe(true);
    expect(isPrivileged(LOGISTICIAN)).toBe(true);
    expect(isPrivileged(WAREHOUSE)).toBe(true);
    expect(isPrivileged(COURIER)).toBe(false);
  });
});
