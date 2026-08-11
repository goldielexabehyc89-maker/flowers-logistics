/**
 * Роли и состояния пользователя.
 *
 * Один пользователь может иметь несколько ролей одновременно.
 *
 * Этот список — единственный источник полного множества ролей для приложения:
 * из него выводятся и серверная валидация, и форма назначения ролей. Второй
 * рукописный перечень однажды разошёлся бы с первым, и роль, существующая
 * в базе, оказалась бы недоступной в интерфейсе.
 *
 * Порядок совпадает с порядком значений перечисления `Role` в PostgreSQL:
 * новые значения добавляются только в конец.
 *
 * `WAREHOUSE`, `FLORIST` и `MANAGER` — роли производственного контура
 * (`docs/OWNER_DECISIONS.md`, `FUL-001`). Их разделы существуют, но пока
 * содержат только честные заглушки.
 */

export const ROLES = [
  'ADMIN',
  'LOGISTICIAN',
  'COURIER',
  'WAREHOUSE',
  'FLORIST',
  'MANAGER',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Администратор',
  LOGISTICIAN: 'Логист',
  COURIER: 'Курьер',
  WAREHOUSE: 'Кладовщик',
  FLORIST: 'Флорист',
  MANAGER: 'Менеджер выдачи',
};

/**
 * Состояния пользователя. Физического удаления сотрудников и курьеров не существует:
 * учётная запись переводится в `FROZEN` и может быть возвращена в `ACTIVE`.
 */
export const USER_STATUSES = ['PENDING_ACTIVATION', 'ACTIVE', 'FROZEN'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  PENDING_ACTIVATION: 'Ожидает активации',
  ACTIVE: 'Активен',
  FROZEN: 'Заморожен',
};

/** Тип транспорта курьера по умолчанию. */
export const VEHICLE_TYPES = ['CAR', 'FOOT'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  CAR: 'Автомобиль',
  FOOT: 'Пеший',
};

export function hasRole(roles: readonly Role[], role: Role): boolean {
  return roles.includes(role);
}

export function hasAnyRole(roles: readonly Role[], allowed: readonly Role[]): boolean {
  return roles.some((role) => allowed.includes(role));
}

/** Роли, которым доступны операционные разделы логистики. */
export const OPERATIONS_ROLES: readonly Role[] = ['ADMIN', 'LOGISTICIAN'];
