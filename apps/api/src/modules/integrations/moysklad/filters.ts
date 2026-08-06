/**
 * Выражения фильтра МоегоСклада.
 *
 * Условия собираются обычными строками и соединяются `;` внутри одного параметра
 * `filter`. Кодирование выполняется ровно один раз — в `URLSearchParams` клиента.
 * Ручное кодирование частей дало бы двойное кодирование, и ссылка перестала бы
 * совпадать с идентификатором на стороне МоегоСклада.
 *
 * Область запросов различается намеренно:
 *  * первоначальная загрузка сужает выборку на сервере по складу, способу доставки
 *    и нижней границе даты;
 *  * delta-проход фильтрует ТОЛЬКО по `updated`. Фильтруй он по складу или способу,
 *    заказ, перенесённый на другой склад, исчез бы из выборки, и система никогда
 *    не узнала бы, что он вышел из нашей области.
 */

import { MOYSKLAD_BASE_URL, type MOYSKLAD_IDS } from './config.js';
import { formatMoscow } from './moscow-time.js';

type Ids = typeof MOYSKLAD_IDS;

const entity = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;

/**
 * Формат даты и времени МоегоСклада — всегда московское время.
 * Отправленное в UTC значение сдвинуло бы окно на три часа, и синхронизация
 * молча отставала бы. Пробел закодирует URLSearchParams.
 */
export function formatMoment(date: Date): string {
  return formatMoscow(date);
}

/**
 * Фильтр первоначальной загрузки: склад, способ доставки «Доставка» и нижняя
 * граница плановой даты. Верхней границы нет — будущие заказы нужны целиком.
 * По статусу не фильтруем: он ничего не решает о принадлежности заказа.
 */
export function initialLoadFilter(ids: Ids, since: Date): string {
  const attribute = `${MOYSKLAD_BASE_URL}/entity/customerorder/metadata/attributes/${ids.deliveryMethodAttribute}`;
  const value = `${MOYSKLAD_BASE_URL}/entity/customentity/${ids.deliveryMethodDictionary}/${ids.deliveryMethodDelivery}`;

  return [
    `store=${entity('store', ids.store)}`,
    `${attribute}=${value}`,
    `deliveryPlannedMoment>=${formatMoment(since)}`,
  ].join(';');
}

/**
 * Фильтр delta-прохода: конечное окно по `updated`.
 *
 * Верхняя граница обязательна — без неё окно росло бы вместе с потоком изменений,
 * и проход никогда не заканчивался бы на активном аккаунте.
 */
export function deltaFilter(from: Date, to: Date): string {
  return [`updated>=${formatMoment(from)}`, `updated<=${formatMoment(to)}`].join(';');
}
