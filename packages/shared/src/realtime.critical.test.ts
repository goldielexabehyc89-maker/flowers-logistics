/**
 * Критическая проверка адресации realtime-событий.
 *
 * Требование владельца: курьер не должен получать ни административные события,
 * ни персональные события другого пользователя. Правило видимости проверяется здесь;
 * SSE-канал (ветка feat/stage1-realtime-outbox-deploy) обязан использовать именно его.
 */

import { describe, expect, it } from 'vitest';
import { isEventVisibleTo, personalAudience, roleAudience } from './realtime.js';

const courier = { userId: 'courier-1', roles: ['COURIER'] as const };
const otherCourier = { userId: 'courier-2', roles: ['COURIER'] as const };
const logistician = { userId: 'logist-1', roles: ['LOGISTICIAN'] as const };
const admin = { userId: 'admin-1', roles: ['ADMIN'] as const };
const adminCourier = { userId: 'both-1', roles: ['ADMIN', 'COURIER'] as const };

describe('видимость realtime-событий', () => {
  it('курьер не получает административное событие', () => {
    const event = roleAudience('ADMIN', 'LOGISTICIAN');

    expect(isEventVisibleTo(event, courier)).toBe(false);
    expect(isEventVisibleTo(event, admin)).toBe(true);
    expect(isEventVisibleTo(event, logistician)).toBe(true);
  });

  it('курьер не получает персональное событие другого пользователя', () => {
    const event = personalAudience(otherCourier.userId);

    expect(isEventVisibleTo(event, courier)).toBe(false);
    expect(isEventVisibleTo(event, otherCourier)).toBe(true);
  });

  it('персональное событие не «протекает» администратору по роли', () => {
    const event = personalAudience(courier.userId);

    expect(isEventVisibleTo(event, admin)).toBe(false);
    expect(isEventVisibleTo(event, courier)).toBe(true);
  });

  it('событие без адресата не видит никто', () => {
    const event = { audienceUserId: null, audienceRoles: [] };

    expect(isEventVisibleTo(event, admin)).toBe(false);
    expect(isEventVisibleTo(event, logistician)).toBe(false);
    expect(isEventVisibleTo(event, courier)).toBe(false);
  });

  it('пользователь с несколькими ролями получает событие по любой из них', () => {
    expect(isEventVisibleTo(roleAudience('ADMIN'), adminCourier)).toBe(true);
    expect(isEventVisibleTo(roleAudience('COURIER'), adminCourier)).toBe(true);
    expect(isEventVisibleTo(roleAudience('WAREHOUSE'), adminCourier)).toBe(false);
  });
});
