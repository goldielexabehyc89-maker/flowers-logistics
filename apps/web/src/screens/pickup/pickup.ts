/**
 * Правила экрана «Самовывоз».
 *
 * Клиентские правила защитой не являются — решение принимает сервер. Но они
 * обязаны честно называть состояние: менеджер стоит перед покупателем, и
 * «ещё не привезли со сборки» вместо пустого места здесь важнее любой анимации.
 */

export type PickupBlocker =
  'NOT_PICKUP' | 'ORDER_CANCELLED' | 'ORDER_BLOCKED' | 'NOT_PLACED' | 'ALREADY_ISSUED';

export type AssemblyState = 'NEW' | 'IN_ASSEMBLY' | 'ASSEMBLED' | 'NEEDS_REVIEW';

export interface PickupCard {
  orderId: string;
  orderNumber: string;
  deliveryDate: string | null;
  isPickup: boolean;
  assemblyState: AssemblyState | null;
  assembledAt: string | null;
  printJobs: number;
  printedJobs: number;
  cellId: string | null;
  cellCode: string | null;
  issuedAt: string | null;
  issuedById: string | null;
  blockers: PickupBlocker[];
}

/**
 * Страница очереди ожидающих выдачи.
 *
 * Счётчик приходит с сервера по ПОЛНОМУ отбору, а не по загруженной странице:
 * «ожидают выдачи 50» при сотне коробок на полке — это неверная работа.
 */
export interface PickupQueueView {
  total: number;
  items: PickupCard[];
  nextCursor: string | null;
  /** Разрешён ли ручной ввод. Решение администратора, не экрана. */
  manualEntry: boolean;
}

export interface PickupIssuedView {
  deliveryDate: string;
  issued: PickupCard[];
}

/** Почему выдать нельзя — словами, которые понятны за прилавком. */
export const BLOCKER_LABELS: Record<PickupBlocker, string> = {
  NOT_PICKUP: 'Это не самовывозный заказ',
  ORDER_CANCELLED: 'Заказ отменён — выдавать нельзя',
  ORDER_BLOCKED: 'Заказ помечен проблемным',
  NOT_PLACED: 'Нет фактической ячейки',
  ALREADY_ISSUED: 'Заказ уже выдан покупателю',
};

export const ASSEMBLY_LABELS: Record<AssemblyState, string> = {
  NEW: 'Не собран',
  IN_ASSEMBLY: 'Собирается',
  ASSEMBLED: 'Собран',
  NEEDS_REVIEW: 'Требует проверки',
};

/** Неизвестное состояние показывается как есть, а не теряется. */
export function blockerLabel(kind: string): string {
  return BLOCKER_LABELS[kind as PickupBlocker] ?? kind;
}

export function assemblyLabel(state: AssemblyState | null): string {
  return state === null ? 'Вне производства' : ASSEMBLY_LABELS[state];
}

/** Фактическое место заказа. Отсутствие места называется честно. */
export function cellLabel(card: Pick<PickupCard, 'cellCode'>): string {
  return card.cellCode ?? 'Нет ячейки';
}

/**
 * Подпись дня в строке очереди.
 *
 * Справка, а не отбор: очередь одна на все дни, и вчерашняя коробка стоит
 * в ней рядом с завтрашней. Заказ без даты так и называется — без даты.
 */
export function dayLabel(card: Pick<PickupCard, 'deliveryDate'>): string {
  /*
   * День читается как дата, а не как машинная запись.
   *
   * `2026-08-19` менеджер за прилавком разбирает по частям, а «19.08.2026»
   * узнаёт сразу — так дата написана на всех остальных экранах.
   */
  const value = card.deliveryDate;
  if (value === null || value === undefined || value === '') {
    return 'без даты';
  }
  const [year, month, day] = value.split('-');
  return day === undefined ? value : `${day}.${month}.${year}`;
}

/**
 * Состояние печати бланка одной строкой.
 *
 * Это контекст, а не условие выдачи: непечатавшийся бланк коробку не задержит,
 * но менеджеру полезно видеть, что с ней происходило.
 */
export function printLabel(card: Pick<PickupCard, 'printJobs' | 'printedJobs'>): string {
  if (card.printJobs === 0) {
    return 'Бланк не печатался';
  }
  return card.printedJobs > 0 ? 'Бланк напечатан' : 'Бланк в очереди печати';
}

/**
 * Можно ли выдавать. Пустой список причин — единственное условие.
 *
 * Отдельного «почти можно» не существует намеренно: любая причина означает
 * отказ сервера, и кнопка, которая всегда даёт ошибку, хуже её отсутствия.
 */
export function canIssue(card: PickupCard): boolean {
  return card.blockers.length === 0;
}

/** Первая причина отказа — та, которую показываем крупно. */
export function primaryBlocker(card: PickupCard): string | null {
  const first = card.blockers[0];
  return first === undefined ? null : blockerLabel(first);
}
