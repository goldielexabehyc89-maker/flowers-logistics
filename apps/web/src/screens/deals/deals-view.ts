/**
 * Правила рабочего вида «Сделок».
 *
 * Здесь то, что решает, как заказ выглядит логисту: попал ли он в «Требует
 * внимания», что именно чинить, готов ли он к отправке и какие точки остаются
 * на карте. Только чистые функции — их видно целиком и можно доказать без
 * браузера.
 */

import type { DealCard } from './selection';

/**
 * Одна названная причина внимания вместе с действием, которое её закрывает.
 *
 * Причина без действия заставляет логиста гадать, куда нажимать; действие без
 * причины — что именно не так. В карточке они стоят рядом.
 */
export type AttentionAction = 'FIX_ADDRESS' | 'SET_INTERVAL' | 'NONE';

export interface AttentionReason {
  code: string;
  label: string;
  action: AttentionAction;
}

/** Что предлагается сделать с причиной. */
export const ATTENTION_ACTION_LABELS: Record<AttentionAction, string | null> = {
  FIX_ADDRESS: 'Исправить адрес',
  SET_INTERVAL: 'Задать интервал',
  NONE: null,
};

/**
 * Человеческие названия серверных причин.
 *
 * `GEOCODING_ADDRESS_INCOMPLETE` и `ADDRESS_CONFLICT` сервер отдаёт давно,
 * а списка здесь не было: логист видел сырой код перечисления.
 */
const REASON_LABELS: Record<string, string> = {
  MISSING_DELIVERY_DATE: 'Не указана дата доставки',
  UNRECOGNIZED_DELIVERY_DATE: 'Дата доставки не распознана',
  MISSING_INTERVAL: 'Не указан интервал',
  UNRECOGNIZED_INTERVAL: 'Не распознан интервал',
  MISSING_ADDRESS: 'Не указан адрес',
  GEOCODING_ADDRESS_INCOMPLETE: 'Адрес неполный',
  ADDRESS_CONFLICT: 'Адрес разошёлся с МоимСкладом',
  MISSING_RECIPIENT: 'Не указан получатель',
  CASH_OVERPAYMENT: 'Оплачено больше суммы заказа',
};

const REASON_ACTIONS: Record<string, AttentionAction> = {
  MISSING_INTERVAL: 'SET_INTERVAL',
  UNRECOGNIZED_INTERVAL: 'SET_INTERVAL',
  MISSING_DELIVERY_DATE: 'NONE',
  UNRECOGNIZED_DELIVERY_DATE: 'NONE',
  MISSING_ADDRESS: 'FIX_ADDRESS',
  GEOCODING_ADDRESS_INCOMPLETE: 'FIX_ADDRESS',
  ADDRESS_CONFLICT: 'FIX_ADDRESS',
  MISSING_RECIPIENT: 'NONE',
  CASH_OVERPAYMENT: 'NONE',
};

/** Отсутствие подтверждённой точки — такая же причина внимания, как и прочие. */
export const NO_POINT_REASON: AttentionReason = {
  code: 'NO_POINT',
  label: 'Нет подтверждённой точки на карте',
  action: 'FIX_ADDRESS',
};

/**
 * Все причины внимания заказа, названные по-человечески.
 *
 * Отсутствие точки добавляется к серверным причинам: для логиста это одно
 * состояние «этот заказ нельзя везти», а не два разных. Раньше «нет координат»
 * жило отдельной строкой блокировки и в «Требует внимания» не попадало.
 */
export function attentionReasonsOf(card: DealCard): AttentionReason[] {
  const reasons: AttentionReason[] = card.attentionReasons.map((code) => ({
    code,
    label: REASON_LABELS[code] ?? code,
    action: REASON_ACTIONS[code] ?? 'NONE',
  }));

  if (card.geoState !== 'RESOLVED') {
    reasons.push(NO_POINT_REASON);
  }

  return reasons;
}

/**
 * Требует ли заказ внимания.
 *
 * Именно этот признак красит карточку и убирает её с карты: маркер заказа,
 * который нельзя везти, выглядел бы готовым к маршрутизации.
 */
export function needsAttention(card: DealCard): boolean {
  return attentionReasonsOf(card).length > 0;
}

/**
 * Первая причина — она и показывается в компактной строке внимания.
 *
 * Перечислять все причины абзацем незачем: логист чинит их по одной, и после
 * исправления строка сама покажет следующую.
 */
export function primaryAttention(card: DealCard): AttentionReason | null {
  return attentionReasonsOf(card)[0] ?? null;
}

/** Готов ли заказ к отправке: собран флористом либо размещён на складе. */
export function isAssembled(card: Pick<DealCard, 'assembled'>): boolean {
  return card.assembled;
}

// --- Карта -----------------------------------------------------------------

export interface MapPoint {
  orderId: string;
  number: string;
  address: string | null;
  lat: string;
  lon: string;
  startMinute: number | null;
  endMinute: number | null;
  assembled: boolean;
  selectable: boolean;
}

export interface TimeWindow {
  fromMinute: number | null;
  toMinute: number | null;
}

/**
 * Фильтр времени карты.
 *
 * Ограничивает ТОЛЬКО показанные точки: список заказов при этом не исчезает
 * и не перезагружается — это отдельный, более узкий вопрос «что я вижу
 * на карте», а не смена рабочего отбора дня.
 *
 * Заказ без интервала под фильтр не подходит: время у него неизвестно, и
 * выдать его за подходящее значило бы соврать.
 */
export function matchesWindow(point: MapPoint, window: TimeWindow): boolean {
  if (window.fromMinute === null && window.toMinute === null) {
    return true;
  }
  if (point.startMinute === null || point.endMinute === null) {
    return false;
  }
  if (window.fromMinute !== null && point.endMinute < window.fromMinute) {
    return false;
  }
  if (window.toMinute !== null && point.startMinute > window.toMinute) {
    return false;
  }
  return true;
}

export function visiblePoints(
  points: readonly MapPoint[],
  window: TimeWindow,
): readonly MapPoint[] {
  return points.filter((point) => matchesWindow(point, window));
}

/**
 * Что написано на маркере.
 *
 * Невыбранный заказ — простой круг без номера: сотня номеров на карте
 * не читается и превращает её в текст. Выбранный сохраняет номер порядка:
 * это будущий порядок остановок, и он важнее.
 */
export function markerLabel(selectionNumber: number | null): string {
  return selectionNumber === null ? '' : String(selectionNumber);
}

/** Интервал над маркером. Показан всегда: по нему логист и группирует день. */
export function markerInterval(point: MapPoint, format: (minute: number) => string): string {
  if (point.startMinute === null || point.endMinute === null) {
    return 'время не задано';
  }
  return `${format(point.startMinute)}–${format(point.endMinute)}`;
}

/** Подсказка при наведении: номер и адрес — то, чего нет на самом маркере. */
export function markerHint(point: MapPoint): string {
  return point.address === null ? point.number : `${point.number} · ${point.address}`;
}
