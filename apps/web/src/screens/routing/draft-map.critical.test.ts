/**
 * Проверки отбора точек рабочего места черновиков.
 *
 * Защищаемые свойства: карта показывает ровно активный черновик, нумерация
 * на карте совпадает со списком, а сделка без пригодных координат не рисуется
 * нигде — выдуманная точка увела бы курьера не туда.
 */

import { describe, expect, it } from 'vitest';
import type { MapPoint } from './geo';
import { markerContentOf } from './geo';
import { pointAction, pointLabel, transferTargets, visiblePoints } from './draft-map';
import { formatMinutes } from '../deals/deals';
import { planMarkers, type DealMapPoint } from '../deals/DealsMapCanvas';

const ACTIVE = 'route-active';
const OTHER = 'route-other';

function point(patch: Partial<MapPoint>): MapPoint {
  return {
    orderId: 'order-1',
    number: 'A-1024',
    lat: '55.751244',
    lon: '37.618423',
    precision: 'EXACT_HOUSE',
    needsAttention: false,
    assigned: false,
    routeId: null,
    routeNumber: null,
    position: null,
    ...patch,
  };
}

describe('что показывает карта', () => {
  it('показывает только остановки активного черновика', () => {
    const points = [
      point({ orderId: 'a', routeId: ACTIVE, assigned: true, position: 1 }),
      point({ orderId: 'b', routeId: OTHER, assigned: true, position: 1 }),
    ];

    const visible = visiblePoints(points, { activeRouteId: ACTIVE, showUnassigned: false });

    expect(visible.map((item) => item.orderId)).toEqual(['a']);
  });

  it('нераспределённые появляются только по переключателю', () => {
    const points = [point({ orderId: 'free' })];

    expect(visiblePoints(points, { activeRouteId: ACTIVE, showUnassigned: false })).toEqual([]);
    expect(
      visiblePoints(points, { activeRouteId: ACTIVE, showUnassigned: true }).map((i) => i.orderId),
    ).toEqual(['free']);
  });

  it('сделка без пригодных координат не показывается даже по переключателю', () => {
    // Точка «где-то в центре» увела бы курьера не туда. Такая сделка остаётся
    // в «Требует внимания» во вкладке «Сделки».
    const points = [
      point({ orderId: 'blind', lat: null, lon: null }),
      point({ orderId: 'broken', lat: 'не число', lon: '37.6' }),
    ];

    expect(visiblePoints(points, { activeRouteId: ACTIVE, showUnassigned: true })).toEqual([]);
  });

  it('без активного черновика видны только нераспределённые', () => {
    const points = [
      point({ orderId: 'a', routeId: ACTIVE, assigned: true, position: 1 }),
      point({ orderId: 'free' }),
    ];

    expect(
      visiblePoints(points, { activeRouteId: null, showUnassigned: true }).map((i) => i.orderId),
    ).toEqual(['free']);
  });
});

describe('подписи маркеров', () => {
  it('остановка подписана позицией, а не номером заказа', () => {
    // Нумерация на карте и в списке обязана совпадать.
    expect(pointLabel(point({ routeId: ACTIVE, position: 3, number: 'A-1024' }))).toBe('3');
  });

  it('нераспределённая сделка не подписана вовсе', () => {
    // Цифра в кружке читается как позиция в маршруте. У сделки, которая ещё
    // никуда не входит, позиции нет: номер заказа там означал бы порядок
    // объезда, которого никто не назначал.
    expect(pointLabel(point({ number: 'A-1024' }))).toBe('');
  });
});

describe('вид отметки на карте', () => {
  function contentOf(patch: Partial<MapPoint>) {
    const value = point(patch);
    return markerContentOf(value, {
      label: pointLabel(value),
      selected: false,
      formatMinute: formatMinutes,
    });
  }

  it('нераспределённая сделка — круг без номера, со временем и подсказкой', () => {
    const content = contentOf({
      number: 'A-1024',
      address: 'Москва, Тверская, 1',
      startMinute: 600,
      endMinute: 720,
    });

    // Внутри кружка пусто: номер заказа там читался бы как позиция в маршруте.
    expect(content.label).toBe('');
    expect(content.interval).toBe('10:00–12:00');
    expect(content.hint).toBe('A-1024 · Москва, Тверская, 1');
    // Опознание для клавиатуры и чтения с экрана остаётся по номеру заказа.
    expect(content.ariaLabel).toContain('A-1024');
  });

  it('остановка активного черновика остаётся нумерованной', () => {
    const content = contentOf({ routeId: ACTIVE, assigned: true, position: 3 });

    expect(content.label).toBe('3');
    expect(content.className).toContain('map-point--picked');
  });

  it('вид совпадает с невыбранной отметкой карты «Сделок»', () => {
    /*
     * Один заказ обязан выглядеть одинаково из любого раздела. Сравнение идёт
     * с настоящей раскладкой «Сделок», а не с переписанной строкой классов:
     * иначе однажды разойдутся именно они.
     */
    const deal: DealMapPoint = {
      orderId: 'order-1',
      number: 'A-1024',
      address: 'Москва, Тверская, 1',
      lat: '55.751244',
      lon: '37.618423',
      startMinute: 600,
      endMinute: 720,
      assembled: false,
      selectable: true,
    };
    const reference = planMarkers([], [{ key: 'one', points: [deal] }], () => null)[0];
    const routing = contentOf({
      number: 'A-1024',
      address: 'Москва, Тверская, 1',
      startMinute: 600,
      endMinute: 720,
    });

    expect(routing.className).toBe(reference?.className);
    expect(routing.label).toBe(reference?.label);
    expect(routing.interval).toBe(reference?.interval);
    expect(routing.hint).toBe(reference?.hint);
  });

  it('время отсутствует честно, а не выдуманным интервалом', () => {
    expect(contentOf({ startMinute: null, endMinute: null }).interval).toBe('время не задано');
  });
});

describe('действие по точке', () => {
  it('нераспределённую сделку назначают', () => {
    expect(pointAction(point({ orderId: 'free' }))).toEqual({ kind: 'ASSIGN', orderId: 'free' });
  });

  it('остановку переносят и знают, откуда', () => {
    expect(pointAction(point({ orderId: 'a', routeId: ACTIVE, position: 1 }))).toEqual({
      kind: 'MOVE',
      orderId: 'a',
      fromRouteId: ACTIVE,
    });
  });

  it('перенос в самого себя не предлагается', () => {
    const drafts = [{ id: ACTIVE }, { id: OTHER }];
    expect(transferTargets(drafts, ACTIVE)).toEqual([{ id: OTHER }]);
    expect(transferTargets(drafts, null)).toHaveLength(2);
  });
});
