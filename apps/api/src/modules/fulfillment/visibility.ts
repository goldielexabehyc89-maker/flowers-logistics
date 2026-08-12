/**
 * Что из состава показывается флористу.
 *
 * Признак НЕ хранится в базе намеренно. Это политика конкретного аккаунта:
 * список скрытых позиций меняется решением владельца. Записанный в строку
 * состава, он застыл бы в исторических снимках, и после первого же изменения
 * списка прошлые ревизии показывали бы состав, которого флорист никогда
 * не видел, — история перестала бы быть достоверной. Поэтому в базе лежит
 * полный подтверждённый состав, а видимость вычисляется при показе.
 *
 * Правила (`docs/OWNER_DECISIONS.md`, `FUL-005` п.7):
 *
 *  * скрываются ТОЛЬКО три известные позиции доставки и только по их UUID;
 *  * «ЛФ-Выкладка Сердце» показывается: это инструкция по сборке;
 *  * любая новая неизвестная `service` показывается — случайно показать лишнюю
 *    строку безопаснее, чем скрыть новую инструкцию по сборке;
 *  * фильтр по всему типу `service` запрещён: тип содержит и доставку,
 *    и производство;
 *  * фильтр по названию запрещён: название в аккаунте переименовывается.
 */

import type { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import type { FulfillmentAssortmentKind } from './composition.js';

export interface VisibilityCandidate {
  assortmentKind: FulfillmentAssortmentKind;
  assortmentId: string | null;
}

/**
 * Показывается ли позиция флористу.
 *
 * Умолчание — «показывать». Всё, что не является одной из трёх известных
 * сервисных доставок, видно; неизвестное видно тем более.
 */
export function isVisibleToFlorist(
  position: VisibilityCandidate,
  ids: Pick<typeof MOYSKLAD_IDS, 'hiddenFulfillmentServices'>,
): boolean {
  // Скрытие ограничено типом `service`: даже если товар случайно получит UUID
  // из списка, товарная позиция состава скрыта не будет.
  if (position.assortmentKind !== 'SERVICE') {
    return true;
  }
  if (position.assortmentId === null) {
    return true;
  }
  return !ids.hiddenFulfillmentServices.includes(position.assortmentId as never);
}

/** Отбирает видимые флористу позиции, сохраняя исходный порядок. */
export function visiblePositions<T extends VisibilityCandidate>(
  positions: readonly T[],
  ids: Pick<typeof MOYSKLAD_IDS, 'hiddenFulfillmentServices'>,
): T[] {
  return positions.filter((position) => isVisibleToFlorist(position, ids));
}
