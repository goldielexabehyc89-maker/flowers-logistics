/**
 * Правила выбора заказов в «Сделках».
 *
 * Выбор — общее состояние списка и карты, поэтому он живёт отдельным модулем
 * чистых функций: два независимых состояния (одно в списке, другое на карте)
 * разошлись бы, и логист отправил бы в расчёт не то, что видел.
 *
 * Порядок выбора — это порядок остановок будущего маршрута. Он задаётся руками
 * и никогда не пересортировывается автоматически: перестановка «для красоты»
 * изменила бы маршрут, который человек уже спланировал.
 */

/** Заказ в том виде, в каком его показывает список и карта. */
export interface DealCard {
  id: string;
  number: string;
  address: string | null;
  sourceAddress: string | null;
  addressCorrected: boolean;
  addressConflict: boolean;
  recipient: string | null;
  comment: string | null;
  deliveryDate: string | null;
  startMinute: number | null;
  endMinute: number | null;
  intervalCorrected: boolean;
  needsAttention: boolean;
  attentionReasons: string[];
  geoState: string;
  draftRouteId: string | null;
  draftRouteNumber: string | null;
  selectable: boolean;
}

/** Почему заказ нельзя выбрать. `null` — можно. */
export type UnselectableReason = 'ATTENTION' | 'IN_DRAFT' | 'NO_POINT';

/**
 * Причина недоступности выбора.
 *
 * Интерфейс обязан объяснить отказ, а не просто погасить чекбокс: невидимая
 * причина выглядит как поломка.
 */
export function unselectableReason(order: DealCard): UnselectableReason | null {
  if (order.draftRouteId !== null) {
    return 'IN_DRAFT';
  }
  if (order.needsAttention) {
    return 'ATTENTION';
  }
  if (order.geoState !== 'RESOLVED') {
    return 'NO_POINT';
  }
  return null;
}

export const UNSELECTABLE_LABELS: Record<UnselectableReason, string> = {
  ATTENTION: 'Требует внимания: сначала устраните причину',
  IN_DRAFT: 'Уже в черновике маршрута',
  NO_POINT: 'Нет подтверждённой точки на карте',
};

/**
 * Переключает заказ в выборе.
 *
 * Возвращает НОВЫЙ массив: выбор хранится как последовательность, а не как
 * множество, потому что порядок — часть смысла. Непригодный заказ не попадает
 * в выбор вовсе, даже если клик как-то дошёл: сервер всё равно откажет, но
 * человек не должен увидеть номер там, где маршрут невозможен.
 */
export function toggleSelection(selected: readonly string[], order: DealCard): string[] {
  if (selected.includes(order.id)) {
    return selected.filter((id) => id !== order.id);
  }
  if (unselectableReason(order) !== null) {
    return [...selected];
  }
  return [...selected, order.id];
}

/**
 * Номер заказа в выборе, начиная с единицы.
 *
 * `null` — заказ не выбран. Снятие элемента перенумеровывает оставшиеся
 * предсказуемо: порядок сохраняется, номера просто сдвигаются.
 */
export function selectionNumber(selected: readonly string[], orderId: string): number | null {
  const index = selected.indexOf(orderId);
  return index === -1 ? null : index + 1;
}

/** Добавляет весь серверный набор «выбрать все», сохраняя уже выбранный порядок. */
export function selectAll(selected: readonly string[], ids: readonly string[]): string[] {
  const known = new Set(selected);
  return [...selected, ...ids.filter((id) => !known.has(id))];
}

export interface SelectionSummary {
  total: number;
  /** Выбранные заказы, которых нет на текущей странице/в текущем фильтре. */
  hiddenCount: number;
}

/**
 * Сводка выбора.
 *
 * Считает и то, что скрыто фильтром: иначе логист отправил бы в расчёт заказ,
 * которого не видит. Именно поэтому закреплённая сводка показывает полный
 * набор, а не пересечение с текущей страницей.
 */
export function summarize(
  selected: readonly string[],
  visibleIds: readonly string[],
): SelectionSummary {
  const visible = new Set(visibleIds);
  return {
    total: selected.length,
    hiddenCount: selected.filter((id) => !visible.has(id)).length,
  };
}

/**
 * Снимает заказы, ставшие недоступными.
 *
 * Вызывается по realtime-событию: другой логист включил заказ в маршрут или
 * изменил блокирующие данные. Возвращает новый выбор и список снятых, чтобы
 * интерфейс мог назвать их человеку — тихое исчезновение номера выглядит как
 * сбой, а не как чужое действие.
 */
export function dropUnavailable(
  selected: readonly string[],
  unavailable: readonly string[],
): { selected: string[]; removed: string[] } {
  const drop = new Set(unavailable);
  return {
    selected: selected.filter((id) => !drop.has(id)),
    removed: selected.filter((id) => drop.has(id)),
  };
}

/** Минуты от полуночи из строки `ЧЧ:ММ`. Пустая строка — фильтр не задан. */
export function parseTimeFilter(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}
