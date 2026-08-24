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
  /** Детали адреса: вторая строка карточки. `null` у прежнего контракта. */
  addressDetails: string | null;
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
  /** Интервал источника: показывается рядом с рабочим для сравнения. */
  sourceStartMinute: number | null;
  sourceEndMinute: number | null;
  sourceIntervalRaw: string | null;
  /** Версия заказа: ручная правка интервала работает по ней. */
  version: number;
  /**
   * Готов к отправке: собран флористом ЛИБО размещён в складской ячейке.
   * Сервер сводит оба факта в один признак — логисту важна готовность,
   * а не путь, которым она наступила.
   */
  assembled: boolean;
  /** Заказ отменён — в МоемСкладе или решением логиста. */
  cancelled?: boolean;
  /** Букет ещё не вернулся на склад: состояние возврата или `null`. */
  awaitingReturn?: string | null;
}

/** Почему заказ нельзя выбрать. `null` — можно. */
export type UnselectableReason =
  'ATTENTION' | 'IN_DRAFT' | 'NO_POINT' | 'CANCELLED' | 'AWAITING_RETURN';

/**
 * Причина недоступности выбора.
 *
 * Интерфейс обязан объяснить отказ, а не просто погасить чекбокс: невидимая
 * причина выглядит как поломка.
 */
export function unselectableReason(order: DealCard): UnselectableReason | null {
  /*
   * Отмена и невозвращённый букет проверяются ПЕРВЫМИ.
   *
   * Обе причины физические и неустранимые на этом экране: отменённый заказ
   * везти нельзя вовсе, а тот, что лежит в машине курьера, нельзя поставить
   * в маршрут, потому что на складе его нет. Назвать вместо них «требует
   * внимания» значило бы отправить логиста чинить адрес.
   */
  if (order.cancelled === true) {
    return 'CANCELLED';
  }
  if (order.awaitingReturn !== undefined && order.awaitingReturn !== null) {
    return 'AWAITING_RETURN';
  }
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
  CANCELLED: 'Заказ отменён',
  AWAITING_RETURN: 'Ждёт возврата на склад: букет ещё у курьера',
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
 * Переключает заказ, известный только карте.
 *
 * Отметка на карте существует независимо от того, загружена ли страница списка,
 * на которой лежит эта карточка. Раньше клик по такой отметке молча не делал
 * ничего: обработчик искал заказ среди загруженных и не находил его.
 *
 * Пригодность берётся из самой точки: сервер уже не отдаёт на карту заказы,
 * требующие внимания, а `selectable` говорит, не занят ли заказ черновиком.
 */
export function toggleMapPoint(
  selected: readonly string[],
  point: { orderId: string; selectable: boolean },
): string[] {
  if (selected.includes(point.orderId)) {
    return selected.filter((id) => id !== point.orderId);
  }
  if (!point.selectable) {
    return [...selected];
  }
  return [...selected, point.orderId];
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

/**
 * Покрыт ли весь пригодный отбор текущим выбором.
 *
 * От этого зависит, чем является одна и та же кнопка: «Выбрать все» или
 * «Снять все». Считается по серверному набору пригодных заказов, а не по
 * загруженной странице — иначе кнопка меняла бы смысл от того, докрутил ли
 * человек список.
 */
export function coversScope(
  selected: readonly string[],
  selectableIds: readonly string[] | null,
): boolean {
  if (selectableIds === null || selectableIds.length === 0) {
    return false;
  }
  const chosen = new Set(selected);
  return selectableIds.every((id) => chosen.has(id));
}

/** Что написано на кнопке общего выбора. */
export function selectAllLabel(
  selected: readonly string[],
  selectableIds: readonly string[] | null,
): string {
  return coversScope(selected, selectableIds) ? 'Снять все' : 'Выбрать все';
}

/**
 * Снятие всего выбора.
 *
 * Снимаются и те заказы, которых нет в серверном наборе: человек нажал
 * «Снять все», а не «снять то, что я вижу».
 */
export function clearSelection(): string[] {
  return [];
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

/**
 * Проверка ручного интервала перед отправкой.
 *
 * Возвращает причину отказа, а не булево: интерфейс обязан объяснить, что
 * именно не так. Это удобство, а не защита — те же правила проверяет сервер,
 * и его отказ показывается как есть, без оптимистической лжи.
 */
export function intervalProblem(from: string, to: string): string | null {
  const start = parseTimeFilter(from);
  const end = parseTimeFilter(to);

  if (start === null || end === null) {
    // Половина интервала выглядела бы как заданное время и попала бы
    // в планирование — поэтому обе границы обязательны.
    return 'Укажите обе границы в формате ЧЧ:ММ.';
  }
  if (end <= start) {
    return 'Окончание должно быть позже начала.';
  }
  return null;
}
