/** Типы экрана «Сотрудники и курьеры». Соответствуют ответам API. */

import type { Role, UserStatus, VehicleType } from '@fl/shared';

export interface UserView {
  id: string;
  phone: string;
  fullName: string;
  status: UserStatus;
  comment: string | null;
  version: number;
  frozenAt: string | null;
  createdAt: string;
  updatedAt: string;
  pinSetAt: string | null;
  roles: Role[];
  courierProfile: { defaultVehicleType: VehicleType; comment: string | null } | null;
}

export interface UserListResponse {
  items: UserView[];
  total: number;
}

export interface ActivationCodeResponse {
  activationCode: string;
  expiresAt: string;
}

export interface CreatedUserResponse extends ActivationCodeResponse {
  user: UserView;
}

export interface HistoryEntry {
  id: string;
  occurredAt: string;
  action: string;
  actorUserId: string | null;
  actorRoles: Role[];
  source: string;
}

export const ACTION_LABELS: Record<string, string> = {
  USER_CREATED: 'Создан',
  USER_UPDATED: 'Изменён',
  USER_ROLES_CHANGED: 'Изменены роли',
  USER_FROZEN: 'Заморожен',
  USER_UNFROZEN: 'Разморожен',
  PIN_RESET: 'Сброшен PIN',
  ACTIVATION_CODE_ISSUED: 'Выдан код активации',
  ACTIVATION_CODE_REISSUED: 'Перевыпущен код активации',
  USER_ACTIVATED: 'Активирован',
  AUTH_LOGIN_SUCCEEDED: 'Вход в систему',
  AUTH_LOGOUT: 'Выход',
  AUTH_LOGOUT_ALL: 'Выход на всех устройствах',
  ADMIN_BOOTSTRAPPED: 'Создан первый администратор',
};
