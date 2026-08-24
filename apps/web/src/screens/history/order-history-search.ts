/**
 * Правила раздела «История заказов», вынесенные из компонента.
 *
 * Подписи состояний и разбор интервала берутся у экрана истории, а не пишутся
 * заново: два списка про один заказ обязаны называть вещи одинаково, иначе
 * поиск и лента разойдутся в словах на пустом месте.
 */

export {
  PROCESS_LABELS,
  ROUTE_STATE_LABELS,
  RETURN_STATE_LABELS,
  formatMoscowDay,
  intervalLine,
} from '../logistics/order-history';

/** Сколько строк просит клиент за раз. Совпадает с умолчанием сервера. */
export const HISTORY_SEARCH_PAGE_SIZE = 20;

export interface HistorySearchRowView {
  orderId: string;
  number: string;
  processState: string;
  externalState: string | null;
  pickup: boolean;
  deliveryDate: string | null;
  interval: { startMinute: number | null; endMinute: number | null; manual: boolean };
  florist: { id: string; fullName: string } | null;
  route: { id: string; number: string; state: string } | null;
  courier: { id: string; fullName: string } | null;
  cell: { code: string; kind: string } | null;
  delivery: { outcome: string; occurredAt: string; reason: string | null } | null;
  returnObligation: { displayNumber: string; state: string } | null;
  cancellation: { source: boolean; logist: boolean } | null;
  lastEventAt: string | null;
}

export interface HistorySearchPage {
  items: HistorySearchRowView[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Склейка страниц поиска.
 *
 * Заказ не показывается дважды: пока человек читал первую страницу, список мог
 * сдвинуться, и та же строка пришла бы во второй раз. Первое вхождение
 * остаётся на своём месте — оно уже перед глазами.
 */
export function mergeSearchPages(
  pages: readonly { items: HistorySearchRowView[] }[],
): HistorySearchRowView[] {
  const seen = new Set<string>();
  const result: HistorySearchRowView[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.orderId)) {
        continue;
      }
      seen.add(item.orderId);
      result.push(item);
    }
  }
  return result;
}

/**
 * Ключ сохранённого положения списка.
 *
 * Своё положение у каждого запроса: вернувшись к другому поиску, человек ждёт
 * его начала, а не чужого смещения.
 */
export function scrollKeyFor(query: string): string {
  return `order-history-scroll:${query}`;
}
