/**
 * Критические проверки правил экрана «Сделки».
 *
 * Проверяется то, что меняет решение логиста: какой интервал считается
 * фактическим, попадает ли заказ в блок «Требует внимания» и что именно
 * показывается вместо пустого значения.
 */

import { describe, expect, it } from 'vitest';
import {
  attentionLabel,
  describeIntegration,
  effectiveInterval,
  EMPTY_VALUE,
  formatDate,
  formatMinutes,
  groupOrders,
  moscowToday,
  parseMinutes,
  type OrderInterval,
  type OrderView,
} from './deals';

function interval(overrides: Partial<OrderInterval> = {}): OrderInterval {
  return {
    raw: null,
    kind: 'MISSING',
    startMinute: null,
    endMinute: null,
    manualStartMinute: null,
    manualEndMinute: null,
    ...overrides,
  };
}

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: 'id',
    number: 'A-1',
    deliveryDate: '2026-08-07',
    deliveryDateRaw: '2026-08-07 12:00:00.000',
    interval: interval(),
    address: 'Москва, тестовый адрес',
    addressDetails: null,
    recipient: 'Получатель',
    comment: null,
    externalState: { id: null, name: 'Новый', stateType: 'Regular' },
    money: {
      sum: '4990.00',
      payed: '0.00',
      cashToCollect: '4990.00',
      cashCollectable: true,
      anomaly: false,
    },
    scope: { inScope: true, exitReason: null, sourceMissing: false },
    needsAttention: false,
    attentionReasons: [],
    updatedAt: '2026-08-07T09:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('фактический интервал', () => {
  it('ручное исправление важнее текста источника', () => {
    const result = effectiveInterval(
      interval({
        raw: 'позвонить заранее',
        kind: 'UNRECOGNIZED',
        manualStartMinute: 600,
        manualEndMinute: 720,
      }),
    );

    expect(result.text).toBe('10:00 – 12:00');
    expect(result.manual).toBe(true);
  });

  it('распознанный диапазон показывается как есть', () => {
    const result = effectiveInterval(
      interval({ raw: 'с 16:00 по 19:00', kind: 'RANGE', startMinute: 960, endMinute: 1140 }),
    );

    expect(result.text).toBe('16:00 – 19:00');
    expect(result.manual).toBe(false);
  });

  it('точное время не превращается в придуманное окно', () => {
    const result = effectiveInterval(interval({ raw: 'в 14:00', kind: 'EXACT', startMinute: 840 }));

    expect(result.text).toBe('к 14:00');
    expect(result.text).not.toContain('–');
  });

  it('нераспознанный и пустой интервал дают честный прочерк', () => {
    expect(effectiveInterval(interval({ kind: 'MISSING' })).text).toBe(EMPTY_VALUE);
    expect(effectiveInterval(interval({ raw: 'когда удобно', kind: 'UNRECOGNIZED' })).text).toBe(
      EMPTY_VALUE,
    );
  });

  it('минуты и обратно переводятся без потерь', () => {
    expect(formatMinutes(0)).toBe('00:00');
    expect(formatMinutes(1439)).toBe('23:59');
    expect(parseMinutes('10:00')).toBe(600);
    expect(parseMinutes('9:05')).toBe(545);
    expect(parseMinutes('24:00')).toBeNull();
    expect(parseMinutes('10-00')).toBeNull();
    expect(parseMinutes('')).toBeNull();
  });
});

describe('группировка', () => {
  it('требующие внимания отделены от остальных', () => {
    const groups = groupOrders([
      order({ id: 'a', needsAttention: true, attentionReasons: ['MISSING_INTERVAL'] }),
      order({ id: 'b' }),
      order({ id: 'c', needsAttention: true, attentionReasons: ['MISSING_ADDRESS'] }),
    ]);

    expect(groups.attention.map((item) => item.id)).toEqual(['a', 'c']);
    expect(groups.unassigned.map((item) => item.id)).toEqual(['b']);
  });

  it('причины объясняются словами, а не кодом', () => {
    expect(attentionLabel('MISSING_INTERVAL')).toBe('Не указано время доставки');
    expect(attentionLabel('CASH_OVERPAYMENT')).toBe('Оплачено больше суммы заказа');
    // Неизвестный код не прячется: лучше показать его, чем промолчать.
    expect(attentionLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('дата', () => {
  it('текущий день считается по Москве, а не по UTC', () => {
    expect(moscowToday(new Date('2026-08-06T21:30:00.000Z'))).toBe('2026-08-07');
    expect(moscowToday(new Date('2026-08-06T20:59:59.000Z'))).toBe('2026-08-06');
  });

  it('дата показывается в привычном виде, а её отсутствие — прочерком', () => {
    expect(formatDate('2026-08-07')).toBe('07.08.2026');
    expect(formatDate(null)).toBe(EMPTY_VALUE);
  });
});

describe('состояние интеграции', () => {
  it('различает не настроено, работает и временную ошибку', () => {
    expect(describeIntegration(undefined).label).toBe('Интеграция не настроена');
    expect(describeIntegration('NOT_CONFIGURED').label).toBe('Интеграция не настроена');
    expect(describeIntegration('CONFIGURED').label).toBe('Синхронизация выключена');
    expect(describeIntegration('OK').tone).toBe('success');
    expect(describeIntegration('DEGRADED').tone).toBe('warning');
    expect(describeIntegration('ERROR').tone).toBe('error');
  });

  it('в тексте для логиста нет технических подробностей', () => {
    for (const state of ['OK', 'DEGRADED', 'ERROR', 'CONFIGURED', 'NOT_CONFIGURED'] as const) {
      const view = describeIntegration(state);
      const text = `${view.label} ${view.hint}`;
      expect(text).not.toContain('HTTP');
      expect(text).not.toContain('token');
      expect(text).not.toMatch(/\d{3}/);
    }
  });
});
