/**
 * Проверки рабочего вида «Сделок».
 *
 * Защищаемые свойства: заказ, который нельзя везти, назван причиной и не
 * попадает на карту; готовность к отправке видна из обоих источников; фильтр
 * времени карты не притворяется, что знает неизвестный интервал; невыбранный
 * маркер не подписан номером.
 */

import { describe, expect, it } from 'vitest';
import {
  ATTENTION_ACTION_LABELS,
  attentionReasonsOf,
  isAssembled,
  markerHint,
  markerInterval,
  markerLabel,
  matchesWindow,
  needsAttention,
  primaryAttention,
  visiblePoints,
  type MapPoint,
} from './deals-view';
import type { DealCard } from './selection';

function card(patch: Partial<DealCard> = {}): DealCard {
  return {
    id: 'order-1',
    number: 'A-1024',
    address: 'Москва, Цветочная улица, 1',
    sourceAddress: 'Москва, Цветочная улица, 1',
    addressCorrected: false,
    addressConflict: false,
    recipient: 'Получатель',
    comment: null,
    deliveryDate: '2026-08-15',
    startMinute: 12 * 60,
    endMinute: 18 * 60,
    intervalCorrected: false,
    needsAttention: false,
    attentionReasons: [],
    geoState: 'RESOLVED',
    draftRouteId: null,
    draftRouteNumber: null,
    selectable: true,
    sourceStartMinute: 12 * 60,
    sourceEndMinute: 18 * 60,
    sourceIntervalRaw: 'с 12:00 по 18:00',
    version: 1,
    assembled: false,
    ...patch,
  };
}

function point(patch: Partial<MapPoint> = {}): MapPoint {
  return {
    orderId: 'order-1',
    number: 'A-1024',
    address: 'Москва, Цветочная улица, 1',
    lat: '55.751244',
    lon: '37.618423',
    startMinute: 12 * 60,
    endMinute: 18 * 60,
    assembled: false,
    selectable: true,
    ...patch,
  };
}

const hhmm = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

describe('«Требует внимания» называет причину', () => {
  it('пригодный заказ внимания не требует', () => {
    expect(needsAttention(card())).toBe(false);
    expect(primaryAttention(card())).toBeNull();
  });

  it('нераспознанный интервал попадает во внимание и предлагает задать интервал', () => {
    const reason = primaryAttention(card({ attentionReasons: ['UNRECOGNIZED_INTERVAL'] }));

    expect(reason?.label).toBe('Не распознан интервал');
    expect(reason?.action).toBe('SET_INTERVAL');
    expect(ATTENTION_ACTION_LABELS[reason?.action ?? 'NONE']).toBe('Задать интервал');
  });

  it('неполный адрес попадает во внимание и предлагает исправить адрес', () => {
    // Сервер отдавал этот код давно, а списка названий не было: логист видел
    // сырое значение перечисления.
    const reason = primaryAttention(card({ attentionReasons: ['GEOCODING_ADDRESS_INCOMPLETE'] }));

    expect(reason?.label).toBe('Адрес неполный');
    expect(reason?.action).toBe('FIX_ADDRESS');
  });

  it('отсутствие точки — такая же причина внимания, а не отдельная блокировка', () => {
    const problem = card({ geoState: 'NEEDS_REVIEW' });

    expect(needsAttention(problem)).toBe(true);
    expect(primaryAttention(problem)?.label).toBe('Нет подтверждённой точки на карте');
    expect(primaryAttention(problem)?.action).toBe('FIX_ADDRESS');
  });

  it('причины перечисляются все, а показывается первая', () => {
    const problem = card({
      attentionReasons: ['UNRECOGNIZED_INTERVAL', 'MISSING_RECIPIENT'],
      geoState: 'FAILED',
    });

    expect(attentionReasonsOf(problem).map((item) => item.code)).toEqual([
      'UNRECOGNIZED_INTERVAL',
      'MISSING_RECIPIENT',
      'NO_POINT',
    ]);
    expect(primaryAttention(problem)?.code).toBe('UNRECOGNIZED_INTERVAL');
  });

  it('незнакомый код не прячется, а показывается как есть', () => {
    expect(primaryAttention(card({ attentionReasons: ['НОВЫЙ_КОД'] }))?.label).toBe('НОВЫЙ_КОД');
  });
});

describe('готовность к отправке', () => {
  it('видна из любого источника', () => {
    // Сервер сводит оба факта в один признак: флорист завершил сборку либо
    // заказ уже лежит в ячейке.
    expect(isAssembled(card({ assembled: true }))).toBe(true);
    expect(isAssembled(card({ assembled: false }))).toBe(false);
  });
});

describe('фильтр времени карты', () => {
  it('пустой фильтр показывает всё', () => {
    expect(matchesWindow(point(), { fromMinute: null, toMinute: null })).toBe(true);
  });

  it('пересечение с окном считается пересечением, а не вложенностью', () => {
    // Заказ 12:00–18:00 попадает в фильтр «с 17:00»: курьер ещё успевает.
    expect(matchesWindow(point(), { fromMinute: 17 * 60, toMinute: null })).toBe(true);
    expect(matchesWindow(point(), { fromMinute: null, toMinute: 13 * 60 })).toBe(true);
  });

  it('непересекающийся интервал отсеивается', () => {
    expect(matchesWindow(point(), { fromMinute: 19 * 60, toMinute: null })).toBe(false);
    expect(matchesWindow(point(), { fromMinute: null, toMinute: 11 * 60 })).toBe(false);
  });

  it('заказ без интервала под фильтр не подходит', () => {
    // Выдать неизвестное время за подходящее значило бы соврать.
    const unknown = point({ startMinute: null, endMinute: null });

    expect(matchesWindow(unknown, { fromMinute: null, toMinute: null })).toBe(true);
    expect(matchesWindow(unknown, { fromMinute: 9 * 60, toMinute: null })).toBe(false);
  });

  it('фильтр отбирает точки, не трогая их состав', () => {
    const points = [
      point({ orderId: 'a' }),
      point({ orderId: 'b', startMinute: 8 * 60, endMinute: 9 * 60 }),
    ];

    expect(
      visiblePoints(points, { fromMinute: 12 * 60, toMinute: null }).map((item) => item.orderId),
    ).toEqual(['a']);
  });
});

describe('подписи маркеров', () => {
  it('невыбранный заказ — круг без номера', () => {
    // Сотня номеров на карте не читается и превращает её в текст.
    expect(markerLabel(null)).toBe('');
  });

  it('выбранный сохраняет номер порядка', () => {
    expect(markerLabel(3)).toBe('3');
  });

  it('интервал показан всегда, а неизвестный назван прямо', () => {
    expect(markerInterval(point(), hhmm)).toBe('12:00–18:00');
    expect(markerInterval(point({ startMinute: null, endMinute: null }), hhmm)).toBe(
      'время не задано',
    );
  });

  it('при наведении видны номер и адрес', () => {
    expect(markerHint(point())).toBe('A-1024 · Москва, Цветочная улица, 1');
    expect(markerHint(point({ address: null }))).toBe('A-1024');
  });
});
