/**
 * Матрица прав на управление пользователями.
 *
 * Правила вынесены в чистые функции, чтобы их можно было проверить тестами
 * и переиспользовать в интерфейсе, не повторяя логику. Сервер всегда решает
 * самостоятельно: клиентское скрытие кнопок — удобство, а не защита.
 */

import { ROLES, type Role } from './roles.js';

/**
 * Внутренние роли: всё, кроме обычного курьера.
 *
 * Название историческое, а смысл шире привилегий: сюда входят и роли
 * производственного контура, которые никакими чужими данными не управляют.
 * Список отвечает ровно на один вопрос — «этот аккаунт логисту недоступен?».
 * Логист заводит и правит только курьеров; аккаунт с любой внутренней ролью
 * заводит и правит администратор, иначе логист смог бы через «своего курьера»
 * изменить чужую учётную запись.
 */
export const PRIVILEGED_ROLES: readonly Role[] = [
  'ADMIN',
  'LOGISTICIAN',
  'WAREHOUSE',
  'FLORIST',
  'MANAGER',
  'SUPERVISOR',
];

export function isPrivileged(roles: readonly Role[]): boolean {
  return roles.some((role) => PRIVILEGED_ROLES.includes(role));
}

/**
 * Курьер, доступный логисту, — это пользователь с ролью COURIER и БЕЗ внутренних ролей.
 * Курьер, которому дополнительно выдали ADMIN, LOGISTICIAN, WAREHOUSE, FLORIST
 * или MANAGER, логисту недоступен: иначе логист смог бы через «своего курьера»
 * изменить чужую учётную запись.
 */
export function isPlainCourier(roles: readonly Role[]): boolean {
  return roles.includes('COURIER') && !isPrivileged(roles);
}

/**
 * Может ли актор управлять пользователем с такими ролями (создание, изменение, заморозка).
 *
 * `targetHasUnsupportedRoles` — признак того, что у цели есть роль, которой эта
 * версия приложения не знает. Такой пользователь НЕ считается обычным курьером
 * даже при наличии `COURIER`: раз версия не понимает часть его ролей, она
 * не вправе решать, что он безопасен для логиста. Fail closed.
 */
export function canManageUserWithRoles(
  actorRoles: readonly Role[],
  targetRoles: readonly Role[],
  targetHasUnsupportedRoles = false,
): boolean {
  if (actorRoles.includes('ADMIN')) {
    return true;
  }
  // «Управляющий» администрирует сотрудников ВСЕХ прочих ролей, включая других
  // управляющих, но не трогает администраторов. Учётка с ролью ADMIN ему
  // недоступна целиком: ни изменить, ни заморозить, ни сбросить PIN или код.
  // Роль более новой версии — fail closed: раз версия её не понимает, она не
  // вправе объявить учётку безопасной для управляющего.
  if (actorRoles.includes('SUPERVISOR')) {
    return !targetHasUnsupportedRoles && !targetRoles.includes('ADMIN');
  }
  if (actorRoles.includes('LOGISTICIAN')) {
    return !targetHasUnsupportedRoles && isPlainCourier(targetRoles);
  }
  return false;
}

/** Может ли актор назначать роли. Администратор и управляющий (последний — кроме ADMIN). */
export function canAssignRoles(actorRoles: readonly Role[]): boolean {
  return actorRoles.includes('ADMIN') || actorRoles.includes('SUPERVISOR');
}

/**
 * Роли, которые актор вправе присвоить создаваемому пользователю.
 *
 * Администратору доступно ВСЁ множество ролей, и оно берётся из `ROLES`, а не
 * переписывается здесь: перечень-копия при добавлении новой роли остался бы
 * прежним, и администратор не смог бы её назначить.
 */
export function assignableRoles(actorRoles: readonly Role[]): readonly Role[] {
  if (actorRoles.includes('ADMIN')) {
    return ROLES;
  }
  // Управляющий назначает любые роли, КРОМЕ ADMIN: он не вправе ни создать
  // администратора, ни повысить кого-либо (в том числе себя) до администратора.
  // Список выводится из `ROLES` вычитанием, а не переписывается: новая роль,
  // добавленная в конец, станет назначаемой управляющему автоматически.
  if (actorRoles.includes('SUPERVISOR')) {
    return ROLES.filter((role) => role !== 'ADMIN');
  }
  if (actorRoles.includes('LOGISTICIAN')) {
    return ['COURIER'];
  }
  return [];
}

/**
 * Имеет ли актор доступ к разделу управления пользователями вообще.
 *
 * Роли производственного контура (`WAREHOUSE`, `FLORIST`, `MANAGER`) и курьер
 * управления пользователями не получают.
 */
export function canAccessUserManagement(actorRoles: readonly Role[]): boolean {
  return (
    actorRoles.includes('ADMIN') ||
    actorRoles.includes('LOGISTICIAN') ||
    actorRoles.includes('SUPERVISOR')
  );
}

/**
 * Имеет ли актор доступ к общему разделу «Настройки» и к записи настроек.
 *
 * Только администратор. Управляющий — операционный администратор: рабочие
 * разделы и история ему доступны, но общие настройки, интеграции и секреты —
 * нет. Отдельные операционные READ-эндпоинты (точки отгрузки, флаг ручной
 * отгрузки) выдаются управляющему точечно на уровне маршрутов, а не через этот
 * общий доступ.
 */
export function canAccessGeneralSettings(actorRoles: readonly Role[]): boolean {
  return actorRoles.includes('ADMIN');
}

/**
 * Ограничение выборки: логисту сервер принудительно показывает только курьеров.
 * `null` означает «без ограничения» (администратор).
 */
export function forcedRoleFilter(actorRoles: readonly Role[]): Role | null {
  if (actorRoles.includes('ADMIN')) {
    return null;
  }
  // Управляющий видит сотрудников всех ролей (кроме администраторов —
  // они отфильтровываются отдельно, см. `visibilityScope` на сервере),
  // поэтому единственной ролью выборку не ограничиваем.
  if (actorRoles.includes('SUPERVISOR')) {
    return null;
  }
  if (actorRoles.includes('LOGISTICIAN')) {
    return 'COURIER';
  }
  return null;
}
