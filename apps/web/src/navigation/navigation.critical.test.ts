/**
 * Критическая проверка видимости разделов по ролям.
 *
 * Скрытие разделов — удобство, а не защита: права проверяет сервер. Но логист
 * не должен видеть даже ссылку на настройки, а курьер — административные разделы.
 */

import { describe, expect, it } from 'vitest';
import {
  firstAvailablePath,
  isSectionVisible,
  splitMobileNavigation,
  visibleSections,
  MOBILE_PRIMARY_LIMIT,
} from './navigation';

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

  it('кладовщик видит ровно один раздел «Склад» и ни одного чужого', () => {
    // Этап 6.1 дал роли WAREHOUSE её первый и единственный раздел. Прежнее
    // утверждение «разделов нет» заменено осознанно: оно описывало состояние
    // до появления готовности заказа к отгрузке.
    expect(keysFor(['WAREHOUSE'])).toEqual(['warehouse']);
    expect(firstAvailablePath(['WAREHOUSE'])).toBe('/warehouse');

    for (const forbidden of [
      'settings',
      'couriers',
      'deals',
      'routing',
      'planning',
      'route-sheets',
      'active',
      'history',
      'reports',
    ]) {
      expect(keysFor(['WAREHOUSE'])).not.toContain(forbidden);
    }
  });

  it('раздел «Склад» доступен администратору и закрыт логисту и курьеру', () => {
    expect(keysFor(['ADMIN'])).toContain('warehouse');
    expect(isSectionVisible(['ADMIN'], '/warehouse')).toBe(true);

    expect(keysFor(['LOGISTICIAN'])).not.toContain('warehouse');
    expect(isSectionVisible(['LOGISTICIAN'], '/warehouse')).toBe(false);

    expect(keysFor(['COURIER'])).not.toContain('warehouse');
    expect(isSectionVisible(['COURIER'], '/warehouse')).toBe(false);
  });

  it('появление «Склада» не изменило стартовые разделы остальных ролей', () => {
    // Раздел добавлен в конец списка намеренно: администратор по-прежнему
    // начинает со «Сделок», а не со склада.
    expect(firstAvailablePath(['ADMIN'])).toBe('/deals');
    expect(firstAvailablePath(['LOGISTICIAN'])).toBe('/deals');
    expect(firstAvailablePath(['COURIER'])).toBe('/active');
    expect(firstAvailablePath([])).toBeNull();
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
    expect(firstAvailablePath(['ADMIN'])).toBe('/deals');
    expect(firstAvailablePath(['LOGISTICIAN'])).toBe('/deals');
    expect(firstAvailablePath(['COURIER'])).toBe('/active');
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
