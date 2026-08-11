/**
 * Разделы приложения и их видимость по ролям.
 *
 * Правило вынесено в чистую функцию: интерфейс скрывает недоступные разделы ради
 * удобства, но решение о правах всегда принимает сервер. Скрытая кнопка — не защита.
 */

import type { Role } from '@fl/shared';

export interface AppSection {
  key: string;
  path: string;
  title: string;
  /** Короткая подпись для нижней навигации на мобильном. */
  shortTitle: string;
  roles: readonly Role[];
}

/** Операционные разделы логистики и администрирование. */
export const APP_SECTIONS: readonly AppSection[] = [
  {
    key: 'deals',
    path: '/deals',
    title: 'Сделки',
    shortTitle: 'Сделки',
    roles: ['ADMIN', 'LOGISTICIAN'],
  },
  {
    key: 'routing',
    path: '/routing',
    title: 'Маршрутизация',
    shortTitle: 'Маршруты',
    roles: ['ADMIN', 'LOGISTICIAN'],
  },
  {
    key: 'planning',
    path: '/planning',
    title: 'Планирование',
    shortTitle: 'План',
    roles: ['ADMIN', 'LOGISTICIAN'],
  },
  {
    key: 'route-sheets',
    path: '/route-sheets',
    title: 'Маршрутные листы',
    shortTitle: 'Листы',
    roles: ['ADMIN', 'LOGISTICIAN'],
  },
  {
    key: 'active',
    path: '/active',
    title: 'Активные',
    shortTitle: 'Активные',
    roles: ['ADMIN', 'LOGISTICIAN', 'COURIER'],
  },
  {
    key: 'history',
    path: '/history',
    title: 'История',
    shortTitle: 'История',
    roles: ['ADMIN', 'LOGISTICIAN', 'COURIER'],
  },
  {
    key: 'reports',
    path: '/reports',
    title: 'Отчёты',
    shortTitle: 'Отчёты',
    roles: ['ADMIN', 'LOGISTICIAN'],
  },
  {
    key: 'couriers',
    path: '/couriers',
    title: 'Сотрудники и курьеры',
    shortTitle: 'Курьеры',
    roles: ['ADMIN', 'LOGISTICIAN'],
  },
  // Разделы производственного контура. Каждая роль видит ровно свой раздел
  // и не видит соседние: флорист не попадает на склад, кладовщик — в самовывоз.
  //
  // Порядок важен: новые разделы стоят ПОСЛЕ логистических, поэтому первый
  // доступный путь администратора и логиста остаётся `/deals`, а курьера —
  // `/active`. Перестановка молча сменила бы им домашнюю страницу.
  {
    key: 'florist',
    path: '/florist',
    title: 'Флорист',
    shortTitle: 'Флорист',
    roles: ['ADMIN', 'FLORIST'],
  },
  {
    key: 'warehouse',
    path: '/warehouse',
    title: 'Склад',
    shortTitle: 'Склад',
    roles: ['ADMIN', 'WAREHOUSE'],
  },
  {
    key: 'pickup',
    path: '/pickup',
    title: 'Самовывоз',
    shortTitle: 'Самовывоз',
    roles: ['ADMIN', 'MANAGER'],
  },
  {
    key: 'settings',
    path: '/settings',
    title: 'Настройки',
    shortTitle: 'Настройки',
    roles: ['ADMIN'],
  },
];

/**
 * Разделы, доступные набору ролей. При нескольких ролях берётся объединение:
 * администратор-курьер видит и административные разделы, и курьерские.
 */
export function visibleSections(roles: readonly Role[]): readonly AppSection[] {
  return APP_SECTIONS.filter((section) => section.roles.some((role) => roles.includes(role)));
}

export function isSectionVisible(roles: readonly Role[], path: string): boolean {
  return visibleSections(roles).some((section) => section.path === path);
}

/**
 * Первый доступный раздел. Используется как стартовая страница и как цель
 * перенаправления с неизвестного или запрещённого адреса.
 *
 * `null` означает, что доступных разделов нет вовсе. Сейчас такого набора ролей
 * не существует — у каждой роли есть свой раздел, — но проверка остаётся: роль,
 * заведённая раньше своего раздела, не должна показывать пустой экран без выхода.
 */
export function firstAvailablePath(roles: readonly Role[]): string | null {
  return visibleSections(roles)[0]?.path ?? null;
}

/** Сколько разделов показывать в нижней навигации до кнопки «Ещё». */
export const MOBILE_PRIMARY_LIMIT = 4;

export interface MobileNavigation {
  primary: readonly AppSection[];
  extra: readonly AppSection[];
}

/** Делит разделы на основные кнопки и содержимое меню «Ещё». */
export function splitMobileNavigation(roles: readonly Role[]): MobileNavigation {
  const sections = visibleSections(roles);
  if (sections.length <= MOBILE_PRIMARY_LIMIT) {
    return { primary: sections, extra: [] };
  }
  return {
    // Одна кнопка резервируется под «Ещё».
    primary: sections.slice(0, MOBILE_PRIMARY_LIMIT - 1),
    extra: sections.slice(MOBILE_PRIMARY_LIMIT - 1),
  };
}
