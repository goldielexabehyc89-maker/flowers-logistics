/**
 * Правила карты рабочего места черновиков.
 *
 * Карта показывает не «все заказы дня», а активный черновик: иначе точки
 * десяти маршрутов сливаются в одно облако, и понять, что везёт эта машина,
 * нельзя. Нераспределённые сделки появляются отдельным переключателем, когда
 * логист сам их запросил.
 *
 * Здесь только отбор и подписи — чистые функции, проверяемые без браузера.
 */

import { toLngLat, type MapPoint } from './geo';

/** Точка пригодна для карты, если у неё есть разбираемые координаты. */
export function isPlottable(point: MapPoint): boolean {
  return toLngLat(point) !== null;
}

export interface VisibleOptions {
  activeRouteId: string | null;
  showUnassigned: boolean;
}

/**
 * Что показать на карте.
 *
 * Точки чужих черновиков не показываются никогда: их номера остановок
 * относятся к другому маршруту и читались бы как номера активного.
 *
 * Сделки без пригодных координат не показываются вовсе — ни на карте,
 * ни как «точка в центре Москвы». Они остаются в «Требует внимания»
 * во вкладке «Сделки», где их можно исправить.
 */
export function visiblePoints(
  points: readonly MapPoint[],
  options: VisibleOptions,
): readonly MapPoint[] {
  return points.filter((point) => {
    if (!isPlottable(point)) {
      return false;
    }
    if (point.routeId !== null) {
      return point.routeId === options.activeRouteId;
    }
    return options.showUnassigned;
  });
}

/**
 * Подпись в кружке отметки.
 *
 * У остановки активного маршрута это позиция: нумерация на карте и в списке
 * обязана совпадать. У нераспределённой сделки позиции нет, и кружок остаётся
 * пустым — номер заказа там читался бы как порядок объезда, которого никто
 * не назначал. Номер и адрес показывает подсказка при наведении.
 */
export function pointLabel(point: MapPoint): string {
  return point.routeId !== null && point.position !== null ? String(point.position) : '';
}

/**
 * Можно ли перенести заказ этой точки в другой черновик.
 *
 * Нераспределённую сделку — назначить, остановку активного маршрута —
 * перенести. Точка без пригодных координат сюда не попадает вовсе.
 */
export type PointAction =
  { kind: 'ASSIGN'; orderId: string } | { kind: 'MOVE'; orderId: string; fromRouteId: string };

export function pointAction(point: MapPoint): PointAction {
  return point.routeId === null
    ? { kind: 'ASSIGN', orderId: point.orderId }
    : { kind: 'MOVE', orderId: point.orderId, fromRouteId: point.routeId };
}

/**
 * Куда можно переложить заказ.
 *
 * Собственный черновик из списка целей убирается: перенос в самого себя —
 * не операция, а ошибка, и предлагать её незачем.
 */
export function transferTargets<T extends { id: string }>(
  drafts: readonly T[],
  currentRouteId: string | null,
): readonly T[] {
  return drafts.filter((draft) => draft.id !== currentRouteId);
}
