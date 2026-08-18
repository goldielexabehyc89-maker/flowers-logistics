/**
 * Критическая проверка видимости разделов по ролям.
 *
 * Скрытие разделов — удобство, а не защита: права проверяет сервер. Но логист
 * не должен видеть даже ссылку на настройки, а курьер — административные разделы.
 */

import { describe, expect, it } from 'vitest';
import { ROLES } from '@fl/shared';
import {
  APP_SECTIONS,
  firstAvailablePath,
  isSectionVisible,
  legacyRedirect,
  LOGISTICS_DEFAULT_TAB,
  LOGISTICS_TABS,
  splitMobileNavigation,
  visibleSections,
  MOBILE_PRIMARY_LIMIT,
} from './navigation';
import { PLACEHOLDERS } from '../screens/PlaceholderScreen';

const keysFor = (roles: Parameters<typeof visibleSections>[0]): string[] =>
  visibleSections(roles).map((section) => section.key);

describe('видимость разделов', () => {
  it('администратор видит настройки и все операционные разделы', () => {
    const keys = keysFor(['ADMIN']);

    expect(keys).toContain('settings');
    expect(keys).toContain('couriers');
    // Логистика теперь один пункт меню: её вкладки живут внутри раздела,
    // а не отдельными строками левого меню.
    expect(keys).toEqual(expect.arrayContaining(['logistics', 'active']));
    expect(keys).not.toContain('planning');
  });

  it('логист не видит настройки', () => {
    const keys = keysFor(['LOGISTICIAN']);

    expect(keys).not.toContain('settings');
    expect(isSectionVisible(['LOGISTICIAN'], '/settings')).toBe(false);
    // Но операционные разделы и курьеры ему доступны.
    expect(keys).toContain('couriers');
    expect(keys).toContain('logistics');
  });

  it('курьер видит только активные доставки и историю', () => {
    const keys = keysFor(['COURIER']);

    expect(keys).toEqual(['active', 'history']);
    for (const forbidden of [
      'settings',
      'couriers',
      'deals',
      'routing',
      'route-sheets',
      'reports',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('роли производственного контура видят ровно свой раздел', () => {
    // Прежний контракт «у кладовщика нет разделов» заменён осознанно:
    // разделы появились, но каждая роль видит только собственный.
    expect(keysFor(['WAREHOUSE'])).toEqual(['warehouse']);
    expect(keysFor(['FLORIST'])).toEqual(['florist']);
    expect(keysFor(['MANAGER'])).toEqual(['pickup']);
  });

  it('роли производственного контура не видят чужие разделы и логистику', () => {
    const production = [
      { roles: ['FLORIST'] as const, own: 'florist' },
      { roles: ['WAREHOUSE'] as const, own: 'warehouse' },
      { roles: ['MANAGER'] as const, own: 'pickup' },
    ];

    for (const { roles, own } of production) {
      const keys = keysFor([...roles]);

      // Ни соседнего производственного раздела, ни логистики, ни настроек,
      // ни управления пользователями.
      for (const forbidden of [
        'florist',
        'warehouse',
        'pickup',
        'deals',
        'routing',
        'planning',
        'route-sheets',
        'active',
        'history',
        'reports',
        'couriers',
        'settings',
      ].filter((key) => key !== own)) {
        expect(keys).not.toContain(forbidden);
      }

      // Прямой переход в чужой раздел закрыт.
      for (const path of [
        '/deals',
        '/settings',
        '/couriers',
        '/florist',
        '/warehouse',
        '/pickup',
      ]) {
        expect(isSectionVisible([...roles], path)).toBe(path === `/${own}`);
      }
    }
  });

  it('администратор видит все три производственных раздела', () => {
    const keys = keysFor(['ADMIN']);

    expect(keys).toEqual(expect.arrayContaining(['florist', 'warehouse', 'pickup']));
  });

  it('несколько ролей объединяются', () => {
    const keys = keysFor(['ADMIN', 'COURIER']);

    expect(keys).toContain('settings');
    expect(keys).toContain('active');

    const logistCourier = keysFor(['LOGISTICIAN', 'COURIER']);
    expect(logistCourier).toContain('couriers');
    expect(logistCourier).toContain('active');
    expect(logistCourier).not.toContain('settings');

    // Дубликатов не возникает.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('первый доступный раздел зависит от ролей', () => {
    // Домашние пути существующих ролей не сдвинулись от появления новых разделов.
    expect(firstAvailablePath(['ADMIN'])).toBe('/logistics');
    expect(firstAvailablePath(['LOGISTICIAN'])).toBe('/logistics');
    expect(firstAvailablePath(['COURIER'])).toBe('/active');

    // Роль производственного контура попадает в СВОЙ раздел, а не в чужой
    // и не в логистику.
    expect(firstAvailablePath(['FLORIST'])).toBe('/florist');
    expect(firstAvailablePath(['WAREHOUSE'])).toBe('/warehouse');
    expect(firstAvailablePath(['MANAGER'])).toBe('/pickup');
  });

  it('у каждой роли есть хотя бы один раздел', () => {
    // Пока это так, нейтральный экран «доступных разделов нет» в обычной работе
    // не появляется. Если роль заведут раньше её раздела, проверка это покажет.
    for (const role of ROLES) {
      expect(firstAvailablePath([role])).not.toBeNull();
    }
  });

  it('каждый раздел навигации имеет экран, а каждая заглушка — раздел', () => {
    const placeholderKeys = Object.keys(PLACEHOLDERS);
    const sectionKeys = APP_SECTIONS.map((section) => section.key);

    // Заглушка без раздела недостижима, раздел без экрана дал бы пустую страницу.
    for (const key of placeholderKeys) {
      expect(sectionKeys).toContain(key);
    }
    // Заглушек верхнего уровня не осталось вовсе: «Отчёты» и «История»
    // переехали во вкладки раздела «Логистика» и живут своими заглушками там.
    expect(placeholderKeys).toEqual([]);
    for (const key of ['florist', 'warehouse', 'pickup', 'active']) {
      expect(sectionKeys).toContain(key);
    }
  });

  it('заглушки честно называют неготовность и не выдумывают данные', () => {
    // Проверяются ВСЕ оставшиеся заглушки, а не выбранный список: новая
    // заглушка без честного этапа проскочила бы мимо перечисления.
    for (const key of Object.keys(PLACEHOLDERS)) {
      const placeholder = PLACEHOLDERS[key];

      expect(placeholder).toBeDefined();
      // Плановый этап назван: точным подэтапом либо этапом целиком.
      expect(placeholder?.stage).toMatch(/^[6-9]/);
      expect(placeholder?.upcoming.length).toBeGreaterThan(0);
      // Только описание будущего: ни одного числа, которое можно принять
      // за настоящий счётчик заказов, ячеек или остатков.
      expect(
        `${placeholder?.description ?? ''} ${(placeholder?.upcoming ?? []).join(' ')}`,
      ).not.toMatch(/\d+\s*(заказ|ячей|шт|остат)/i);
    }
  });

  it('мобильная навигация не превышает лимит основных кнопок', () => {
    const admin = splitMobileNavigation(['ADMIN']);

    expect(admin.primary.length).toBeLessThanOrEqual(MOBILE_PRIMARY_LIMIT - 1);
    expect(admin.extra.length).toBeGreaterThan(0);

    const courier = splitMobileNavigation(['COURIER']);
    expect(courier.primary).toHaveLength(2);
    expect(courier.extra).toHaveLength(0);
  });

  /**
   * Правило единственного раздела.
   *
   * Проверяется именно число ВЕРХНЕУРОВНЕВЫХ разделов, а не наличие вкладок
   * внутри раздела: у кладовщика вкладок несколько, но раздел один, и нижняя
   * кнопка «Склад» вела бы на уже открытую страницу.
   */
  it('чистым производственным ролям доступен ровно один верхнеуровневый раздел', () => {
    for (const role of ['FLORIST', 'WAREHOUSE', 'MANAGER'] as const) {
      expect(visibleSections([role])).toHaveLength(1);
    }
  });

  it('нескольким ролям остаётся обычная навигация', () => {
    // Две роли — два раздела: скрывать навигацию здесь было бы потерей функции.
    expect(visibleSections(['FLORIST', 'WAREHOUSE']).length).toBeGreaterThan(1);
    expect(visibleSections(['ADMIN']).length).toBeGreaterThan(1);
  });

  it('пустые роли не дают ни одного раздела и полосы тоже не требуют', () => {
    expect(visibleSections([])).toHaveLength(0);
  });
});

describe('раздел «Логистика»', () => {
  it('вкладки идут строго в утверждённом порядке', () => {
    expect(LOGISTICS_TABS.map((tab) => tab.title)).toEqual([
      'Сделки',
      'Маршрутизация',
      'Маршрутные листы',
      // Вкладка недоставок стоит сразу за листами: это следующий шаг того же
      // рабочего дня, а «История» и «Отчёты» — разбор уже закрытого.
      'Требуют решения',
      'История',
      'Отчёты',
    ]);
  });

  it('по умолчанию открываются «Сделки»', () => {
    expect(LOGISTICS_DEFAULT_TAB).toBe('/logistics/deals');
    expect(LOGISTICS_TABS[0]?.path).toBe(LOGISTICS_DEFAULT_TAB);
  });

  it('прежние адреса ведут в точный новый эквивалент', () => {
    expect(legacyRedirect('/deals')).toBe('/logistics/deals');
    expect(legacyRedirect('/routing')).toBe('/logistics/routing');
    expect(legacyRedirect('/route-sheets')).toBe('/logistics/route-sheets');
    expect(legacyRedirect('/reports')).toBe('/logistics/reports');
    // Отдельной вкладки «Планирование» больше нет, но её адрес не обрывается:
    // функция переехала в «Маршрутизацию», туда и ведёт ссылка.
    expect(legacyRedirect('/planning')).toBe('/logistics/routing');
    // Незнакомый адрес не выдумывается.
    expect(legacyRedirect('/unknown')).toBeNull();
  });

  it('«Активные» и «Сотрудники и курьеры» остаются отдельными пунктами', () => {
    const keys = visibleSections(['ADMIN']).map((section) => section.key);
    expect(keys).toContain('active');
    expect(keys).toContain('couriers');
  });
});

describe('вложенные адреса доступны наравне с разделом', () => {
  it('вкладки «Логистики» видимы её ролям и закрыты остальным', () => {
    for (const path of LOGISTICS_TABS.map((tab) => tab.path)) {
      expect(isSectionVisible(['ADMIN'], path), path).toBe(true);
      expect(isSectionVisible(['LOGISTICIAN'], path), path).toBe(true);
      expect(isSectionVisible(['COURIER'], path), path).toBe(false);
    }
  });

  it('похожий по началу чужой адрес разделом не считается', () => {
    // Иначе `/logistics-report` открывался бы по правам «Логистики».
    expect(isSectionVisible(['ADMIN'], '/logistics-report')).toBe(false);
    expect(isSectionVisible(['COURIER'], '/activex')).toBe(false);
  });
});
