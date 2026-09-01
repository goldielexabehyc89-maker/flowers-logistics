/**
 * Чистые правила вкладки «Ожидают приёмки»: фильтр по типу и его счётчики.
 *
 * Вынесены из компонента, чтобы проверяться без браузера. Тип заказа —
 * единственное, что делит набор на «Доставка» и «Самовывоз»; всё остальное
 * (даты, состав) экран лишь раскладывает.
 */

/** Что показывать: весь набор, только доставку или только самовывоз. */
export type AwaitingTypeFilter = 'all' | 'delivery' | 'pickup';

/** Минимум, который нужен фильтру: способ получения. */
export interface AwaitingTypeItem {
  isPickup: boolean;
}

export interface AwaitingTypeCounts {
  all: number;
  delivery: number;
  pickup: number;
}

/**
 * Счётчики чипов «Все / Доставка / Самовывоз».
 *
 * Считаются по уже показанному списку (он приходит с сервера отфильтрованным
 * по строке поиска), поэтому чипы и список говорят об одном и том же наборе.
 */
export function awaitingTypeCounts(items: readonly AwaitingTypeItem[]): AwaitingTypeCounts {
  let pickup = 0;
  for (const item of items) {
    if (item.isPickup) {
      pickup += 1;
    }
  }
  return { all: items.length, delivery: items.length - pickup, pickup };
}

/** Оставляет заказы выбранного типа. «Все» — набор целиком. */
export function filterAwaitingByType<T extends AwaitingTypeItem>(
  items: readonly T[],
  filter: AwaitingTypeFilter,
): T[] {
  if (filter === 'all') {
    return [...items];
  }
  const wantPickup = filter === 'pickup';
  return items.filter((item) => item.isPickup === wantPickup);
}
