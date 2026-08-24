/**
 * Правила экрана «История заказа».
 *
 * Проверяется то, что экран решает сам: как назван автор, как строки ложатся
 * по московским дням и не пересчитывает ли клиент то, что уже посчитал сервер.
 */

import { describe, expect, it } from 'vitest';
import { actorLine, groupByDay, intervalLine, type TimelineEventView } from './order-history';
import { invalidationKeysFor } from '../../realtime/stream';
import type { Role } from '@fl/shared';
import { APP_SECTIONS, isSectionVisible, visibleSections } from '../../navigation/navigation';
import { mergeSearchPages, scrollKeyFor } from '../history/order-history-search';

function entry(overrides: Partial<TimelineEventView> & { key: string }): TimelineEventView {
  return {
    occurredAt: '2028-10-12T09:00:00.000Z',
    moscowDate: '2028-10-12',
    group: 'IMPORT',
    kind: 'ORDER_INITIAL_IMPORT',
    title: 'Заказ импортирован',
    actor: { kind: 'SOURCE', userId: null, fullName: null, roles: [] },
    details: [],
    reverted: false,
    route: null,
    ...overrides,
  };
}

describe('автор строки', () => {
  it('система и источник названы прямо, а не пустым именем', () => {
    expect(actorLine({ kind: 'SOURCE', userId: null, fullName: null, roles: [] })).toBe('МойСклад');
    expect(actorLine({ kind: 'SYSTEM', userId: null, fullName: null, roles: [] })).toBe('Система');
  });

  it('роль показывается только вместе со снимком, а не выдумывается', () => {
    // Журнал сохранил роли на момент действия — их и видно.
    expect(
      actorLine({ kind: 'USER', userId: 'u1', fullName: 'Иван Логистов', roles: ['LOGISTICIAN'] }),
    ).toBe('Иван Логистов · логист');

    // У доменной таблицы снимка ролей нет: подставлять текущие нельзя —
    // за месяцы они меняются, и строка обещала бы чужую должность.
    expect(actorLine({ kind: 'USER', userId: 'u2', fullName: 'Пётр Складов', roles: [] })).toBe(
      'Пётр Складов',
    );
  });
});

describe('раскладка по дням', () => {
  it('день берётся из строки события, а не считается заново', () => {
    // 21:30 UTC — это уже следующий московский день, и сервер так и сказал.
    const days = groupByDay([
      entry({ key: 'a', occurredAt: '2028-10-12T18:00:00.000Z', moscowDate: '2028-10-12' }),
      entry({ key: 'b', occurredAt: '2028-10-12T21:30:00.000Z', moscowDate: '2028-10-13' }),
      entry({ key: 'c', occurredAt: '2028-10-12T22:00:00.000Z', moscowDate: '2028-10-13' }),
    ]);

    expect(days.map((day) => day.date)).toEqual(['2028-10-12', '2028-10-13']);
    expect(days[1]?.events.map((item) => item.key)).toEqual(['b', 'c']);
  });

  it('пустая лента не создаёт пустого дня', () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe('интервал в шапке', () => {
  it('ручной интервал назван ручным, а отсутствующий не выдумывается', () => {
    expect(intervalLine({ startMinute: 600, endMinute: 840, manual: false })).toBe('10:00–14:00');
    expect(intervalLine({ startMinute: 600, endMinute: 720, manual: true })).toBe(
      '10:00–12:00 · задан вручную',
    );
    expect(intervalLine({ startMinute: null, endMinute: null, manual: false })).toBe(null);
  });
});

describe('обновление без перезагрузки', () => {
  it('любое действие над заказом перечитывает открытую историю', () => {
    for (const topic of [
      'order.updated',
      'order.address_changed',
      'order.fulfillment_process_changed',
      'warehouse.placement_changed',
      'route.confirmed',
      'delivery.result_recorded',
      'order.return_changed',
      'pickup.issued',
    ]) {
      expect(invalidationKeysFor(topic), topic).toContainEqual(['order-timeline']);
    }
  });

  it('события, не относящиеся к заказу, историю не трогают', () => {
    for (const topic of ['user.created', 'depot.changed', 'route.edit_lock_changed']) {
      expect(invalidationKeysFor(topic), topic).not.toContainEqual(['order-timeline']);
    }
  });
});

describe('раздел «История заказов»', () => {
  it('виден администратору и логисту и скрыт остальным ролям', () => {
    const section = APP_SECTIONS.find((item) => item.key === 'order-history');
    expect(section?.path).toBe('/order-history');

    for (const roles of [['ADMIN'], ['LOGISTICIAN'], ['ADMIN', 'LOGISTICIAN']] as Role[][]) {
      expect(
        visibleSections(roles).some((item) => item.key === 'order-history'),
        roles.join(','),
      ).toBe(true);
      expect(isSectionVisible(roles, '/order-history'), roles.join(',')).toBe(true);
      expect(isSectionVisible(roles, '/order-history/order-1'), roles.join(',')).toBe(true);
    }

    // Спрятанный пункт — не защита, но и показывать его этим ролям незачем:
    // сервер их запрос всё равно отклонит.
    for (const roles of [['FLORIST'], ['WAREHOUSE'], ['COURIER'], ['MANAGER']] as Role[][]) {
      expect(
        visibleSections(roles).some((item) => item.key === 'order-history'),
        roles.join(','),
      ).toBe(false);
      expect(isSectionVisible(roles, '/order-history'), roles.join(',')).toBe(false);
    }
  });

  it('страницы поиска склеиваются без повторов', () => {
    const row = (id: string): { orderId: string } => ({ orderId: id });
    const merged = mergeSearchPages([
      { items: [row('a'), row('b')] as never[] },
      // Пока человек читал первую страницу, список сдвинулся и строка «b»
      // пришла второй раз: в списке она обязана остаться одна.
      { items: [row('b'), row('c')] as never[] },
    ]);
    expect(merged.map((item) => item.orderId)).toEqual(['a', 'b', 'c']);
  });

  it('положение списка помнится по своему запросу', () => {
    expect(scrollKeyFor('OH-1')).not.toBe(scrollKeyFor('OH-2'));
  });

  it('событие заказа перечитывает и ленту, и результаты поиска', () => {
    for (const topic of ['order.updated', 'delivery.result_recorded', 'order.return_changed']) {
      expect(invalidationKeysFor(topic), topic).toContainEqual(['order-history-search']);
    }
    expect(invalidationKeysFor('user.created')).not.toContainEqual(['order-history-search']);
  });
});
