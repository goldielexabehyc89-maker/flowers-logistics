/**
 * Что означает «Требует внимания» в логистике.
 *
 * Признак не описательный, а рабочий: он красит карточку, поднимает её вверх
 * списка и убирает заказ с карты. Поэтому в него попадает РОВНО то, что мешает
 * логисту распределить заказ, а не всё подряд, что показалось источнику
 * неполным.
 *
 * Список разрешающий, а не запрещающий. Новая причина, появившаяся в импорте,
 * по умолчанию НЕ становится логистически блокирующей: иначе однажды добавленный
 * в МоемСкладе признак молча вынес бы половину дня в «Требует внимания», и никто
 * не смог бы объяснить, почему.
 *
 * Диагностические сведения при этом не теряются: полный набор причин остаётся
 * в заказе, в снимке и в истории — просто он не управляет цветом и порядком.
 */

/** Причины, которые мешают распределить заказ. */
export const LOGISTICS_BLOCKING_REASONS = [
  // Адрес: без него везти некуда.
  'MISSING_ADDRESS',
  'GEOCODING_ADDRESS_INCOMPLETE',
  'ADDRESS_CONFLICT',
  // Интервал: без него нельзя поставить заказ в маршрут по времени.
  'MISSING_INTERVAL',
  'UNRECOGNIZED_INTERVAL',
] as const;

export type LogisticsBlockingReason = (typeof LOGISTICS_BLOCKING_REASONS)[number];

/**
 * Мешает ли причина работе логиста.
 *
 * Отсутствующий получатель, вопросы к дате и денежные расхождения сюда
 * не входят намеренно: они относятся к другим людям и другим экранам, а заказ
 * с ними распределяется как обычный.
 */
export function isLogisticsBlocking(reason: string): boolean {
  return (LOGISTICS_BLOCKING_REASONS as readonly string[]).includes(reason);
}

/** Есть ли среди причин хоть одна блокирующая. */
export function blocksLogistics(reasons: readonly string[]): boolean {
  return reasons.some(isLogisticsBlocking);
}

/** Только блокирующие причины: для окраски карточки и списка «Требует внимания». */
export function blockingReasonsOf(reasons: readonly string[]): string[] {
  return reasons.filter(isLogisticsBlocking);
}
