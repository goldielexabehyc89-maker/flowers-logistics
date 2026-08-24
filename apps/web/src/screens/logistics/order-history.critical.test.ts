/**
 * Правила экрана «История заказа».
 *
 * Проверяется то, что экран решает сам: как назван автор, как строки ложатся
 * по московским дням и не пересчитывает ли клиент то, что уже посчитал сервер.
 */

import { describe, expect, it } from 'vitest';
import { actorLine, groupByDay, intervalLine, type TimelineEventView } from './order-history';
import { invalidationKeysFor } from '../../realtime/stream';

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
