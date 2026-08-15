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
    key: 'logistics',
    path: '/logistics',
    title: 'Логистика',
    shortTitle: 'Логистика',
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
    title: 'История доставок',
    shortTitle: 'История',
    roles: ['COURIER'],
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
  // Порядок важен: логистика стоит первой, поэтому первый доступный путь
  // администратора и логиста — `/logistics`, а курьера — `/active`.
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
 * Вкладки внутри раздела «Логистика».
 *
 * Горизонтальные и в этом порядке — решение владельца. По умолчанию всегда
 * открываются «Сделки»: логист начинает рабочий день с них, а не с пустого
 * выбора раздела.
 */
export interface LogisticsTab {
  key: string;
  path: string;
  title: string;
}

export const LOGISTICS_TABS: readonly LogisticsTab[] = [
  { key: 'deals', path: '/logistics/deals', title: 'Сделки' },
  { key: 'routing', path: '/logistics/routing', title: 'Маршрутизация' },
  { key: 'route-sheets', path: '/logistics/route-sheets', title: 'Маршрутные листы' },
  { key: 'history', path: '/logistics/history', title: 'История' },
  { key: 'reports', path: '/logistics/reports', title: 'Отчёты' },
];

export const LOGISTICS_DEFAULT_TAB = '/logistics/deals';

/**
 * Прежние адреса верхнего уровня и их точный новый эквивалент.
 *
 * Существующие ссылки, закладки и история браузера обязаны продолжать
 * работать: пустой экран вместо знакомого раздела выглядит как поломка,
 * а не как переезд. Отдельная вкладка «Планирование» удалена, но её функция
 * переехала в «Маршрутизацию» — туда и ведёт прежний адрес.
 */
export const LEGACY_PATHS: Readonly<Record<string, string>> = Object.freeze({
  '/deals': '/logistics/deals',
  '/routing': '/logistics/routing',
  '/planning': '/logistics/routing',
  '/route-sheets': '/logistics/route-sheets',
  '/reports': '/logistics/reports',
});

/** Новый адрес для прежнего, если он известен. */
export function legacyRedirect(path: string): string | null {
  return LEGACY_PATHS[path] ?? null;
}

/**
 * Разделы, доступные набору ролей. При нескольких ролях берётся объединение:
 * администратор-курьер видит и административные разделы, и курьерские.
 */
export function visibleSections(roles: readonly Role[]): readonly AppSection[] {
  return APP_SECTIONS.filter((section) => section.roles.some((role) => roles.includes(role)));
}

/**
 * Доступен ли адрес роли.
 *
 * Сравнение по префиксу, а не по точному равенству: у раздела «Логистика» есть
 * вложенные вкладки, и точное сравнение объявляло бы `/logistics/deals`
 * недоступным. Прежняя версия отправляла такой адрес на первый доступный
 * раздел, тот перенаправлял на вкладку по умолчанию — и получался цикл.
 *
 * Граница проверяется явно: `/logistics-x` не считается частью `/logistics`.
 */
export function isSectionVisible(roles: readonly Role[], path: string): boolean {
  return visibleSections(roles).some(
    (section) => path === section.path || path.startsWith(`${section.path}/`),
  );
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

/**
 * Разделы, которым нужна вся ширина окна.
 *
 * Обычная страница ограничена по ширине: строка данных во весь монитор
 * читается хуже, чем та же строка в колонке. Но карта, доска сделок и крупная
 * рабочая таблица от ограничения теряют — карту пришлось бы разглядывать
 * в узкой полосе, а таблица получила бы горизонтальную прокрутку при пустых
 * полях по бокам.
 *
 * Список задан целым разделом «Логистика», а не отдельными вкладками: все его
 * вкладки — это либо карта, либо крупная операционная таблица, и ширина,
 * меняющаяся при каждом переключении вкладки внутри одного рабочего места,
 * читалась бы как прыжок вёрстки.
 *
 * Флорист, склад, печать, сотрудники и настройки сюда НЕ входят: это обычные
 * страницы и пошаговые физические операции, которым ширина не нужна.
 */
const WIDE_LAYOUT_PATHS: readonly string[] = ['/logistics'];

export function isWideLayout(path: string): boolean {
  return WIDE_LAYOUT_PATHS.some((wide) => path === wide || path.startsWith(`${wide}/`));
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
