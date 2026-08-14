/**
 * Проверки отбора точек рабочего места черновиков.
 *
 * Защищаемые свойства: карта показывает ровно активный черновик, нумерация
 * на карте совпадает со списком, а сделка без пригодных координат не рисуется
 * нигде — выдуманная точка увела бы курьера не туда.
 */

import { describe, expect, it } from 'vitest';
import type { MapPoint } from './geo';
import { pointAction, pointLabel, transferTargets, visiblePoints } from './draft-map';

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

  it('нераспределённая сделка подписана номером заказа', () => {
    expect(pointLabel(point({ number: 'A-1024' }))).toBe('A-1024');
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
