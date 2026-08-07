/**
 * Пригодность заказа для ручного распределения и вычисление его внутреннего состояния.
 *
 * Правила вынесены в чистые функции: они одинаково нужны добавлению, перемещению
 * и будущему подтверждению маршрута, и их проще проверить тестами, чем повторять
 * в трёх местах.
 *
 * Важное решение: «Требует внимания» и ручной интервал добавлению НЕ мешают.
 * Логист видит проблему в карточке и осознанно решает, брать ли заказ в маршрут;
 * запрет превратил бы предупреждение в блокировку и заставил бы обходить систему.
 */

import type { $Enums } from '../../generated/prisma/client.js';

/** Внутреннее состояние заказа. Не хранится, а вычисляется из активного участия. */
export type OrderAssignmentState = 'UNASSIGNED' | 'IN_DRAFT' | 'CONFIRMED';

/** Минимум сведений о заказе, нужный правилам пригодности. */
export interface EligibilityOrder {
  id: string;
  deliveryDate: Date | null;
  inScope: boolean;
  sourceArchived: boolean;
  sourceMissing: boolean;
}

export type IneligibleReason =
  'OUT_OF_SCOPE' | 'SOURCE_ARCHIVED' | 'SOURCE_MISSING' | 'NO_DELIVERY_DATE' | 'DATE_MISMATCH';

export const INELIGIBLE_MESSAGES: Record<IneligibleReason, string> = {
  OUT_OF_SCOPE: 'Заказ не относится к нашей доставке',
  SOURCE_ARCHIVED: 'Заказ архивирован в МоемСкладе',
  SOURCE_MISSING: 'Заказ не найден в МоемСкладе',
  NO_DELIVERY_DATE: 'У заказа не распознана дата доставки',
  DATE_MISMATCH: 'Дата заказа не совпадает с датой маршрута',
};

/**
 * Почему заказ нельзя положить в маршрут указанной даты.
 * `null` означает, что заказ пригоден.
 *
 * Даты сравниваются как календарные значения `YYYY-MM-DD`: обе колонки имеют тип
 * `DATE`, и сравнение моментов времени внесло бы часовой пояс туда, где его нет.
 */
export function ineligibleReason(
  order: EligibilityOrder,
  routeDate: string,
): IneligibleReason | null {
  if (!order.inScope) {
    return 'OUT_OF_SCOPE';
  }
  if (order.sourceArchived) {
    return 'SOURCE_ARCHIVED';
  }
  if (order.sourceMissing) {
    return 'SOURCE_MISSING';
  }
  if (order.deliveryDate === null) {
    return 'NO_DELIVERY_DATE';
  }
  if (calendarDate(order.deliveryDate) !== routeDate) {
    return 'DATE_MISMATCH';
  }
  return null;
}

/** Колонка `DATE` читается Prisma как полночь UTC, поэтому дата берётся из UTC-части. */
export function calendarDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Внутреннее состояние заказа.
 *
 * Единственный источник истины — активное участие в маршруте и состояние самого
 * маршрута. Отдельной колонки нет намеренно: она была бы вторым источником истины,
 * который база согласовать не может, и допускала бы «участие есть, а заказ считается
 * нераспределённым».
 */
export function assignmentStateOf(
  activeRouteState: $Enums.RouteState | null | undefined,
): OrderAssignmentState {
  if (activeRouteState === undefined || activeRouteState === null) {
    return 'UNASSIGNED';
  }
  if (activeRouteState === 'CONFIRMED') {
    return 'CONFIRMED';
  }
  // Отменённый маршрут активных участий не имеет: их закрывает операция отмены
  // (ветка 4.2). До неё в состоянии CANCELLED заказов не бывает.
  return 'IN_DRAFT';
}
