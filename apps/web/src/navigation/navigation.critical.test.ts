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
    expect(keys).toEqual(
      expect.arrayContaining(['deals', 'routing', 'route-sheets', 'active', 'history', 'reports']),
    );
  });

  it('логист не видит настройки', () => {
    const keys = keysFor(['LOGISTICIAN']);

    expect(keys).not.toContain('settings');
    expect(isSectionVisible(['LOGISTICIAN'], '/settings')).toBe(false);
    // Но операционные разделы и курьеры ему доступны.
    expect(keys).toContain('couriers');
    expect(keys).toContain('deals');
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
    expect(firstAvailablePath(['ADMIN'])).toBe('/deals');
    expect(firstAvailablePath(['LOGISTICIAN'])).toBe('/deals');
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
    // Разделы «Флорист» (6.2–6.3), «Склад» (6.5) и «Самовывоз» (6.7) получили
    // рабочие экраны и заглушками больше не являются: заглушка перехватывала бы
    // тот же адрес и показывала «раздел не реализован» поверх работающего
    // экрана. Остальные разделы по-прежнему честно говорят о неготовности.
    for (const key of ['active', 'history', 'reports']) {
      expect(placeholderKeys).toContain(key);
    }
    for (const key of ['florist', 'warehouse', 'pickup']) {
      expect(placeholderKeys).not.toContain(key);
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
});
