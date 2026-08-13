/**
 * Правила экрана флориста, вынесенные из компонентов.
 *
 * Здесь только чистые функции и типы: их проверяют тестами без браузера, и
 * именно они решают спорные вопросы — какое действие сейчас допустимо, как
 * назвать состояние человеческим языком и что показать вместо пустого значения.
 *
 * Ни одна из этих функций не является защитой. Скрытая кнопка не мешает
 * отправить запрос напрямую, поэтому право на действие всегда проверяет сервер;
 * здесь решается только то, что показывать.
 */

import { formatCalendarDate, formatMinutesOfDay } from '@fl/shared';

export type QueueDay = 'today' | 'tomorrow';
export type QueueScope = 'general' | 'mine';
export type FloristTab = 'queue' | 'mine' | 'print';

export interface QueueItemView {
  id: string;
  number: string;
  deliveryDate: string | null;
  startMinute: number | null;
  endMinute: number | null;
  overdue: boolean;
  processState: string;
  assignee: { id: string; fullName: string } | null;
  route: { id: string; number: string; position: number | null } | null;
  hasPrintForm: boolean;
  changedSinceClaim: boolean;
}

/**
 * Страница списка в том виде, в каком её отдаёт сервер.
 *
 * `total` и `hasMore` приходят с сервера и клиентом не вычисляются. Считать
 * «страница неполная — значит, конец» нельзя: последняя страница ровно в
 * `limit` строк неотличима от промежуточной, и человек решил бы, что заказов
 * больше нет.
 */
export interface PageMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface QueueResponse extends PageMeta {
  day: QueueDay;
  deliveryDate: string;
  scope: QueueScope;
  includeAssigned: boolean;
  /** Применённый сервером поиск: пустая строка поиском не считается. */
  search: string | null;
  items: QueueItemView[];
}

export interface PrintJobsResponse extends PageMeta {
  items: PrintJobView[];
}

export interface CardComponentView {
  name: string | null;
  quantity: string;
}

export interface CardPositionView {
  name: string | null;
  quantity: string;
  characteristicLabel: string | null;
  isBundle: boolean;
  assortmentId: string | null;
  components: CardComponentView[];
}

export interface CardPrintJobView {
  id: string;
  attempt: number;
  state: string;
  createdAt: string;
  completedAt: string | null;
  lastErrorCode: string | null;
}

export interface OrderCardView {
  id: string;
  number: string;
  deliveryDate: string | null;
  startMinute: number | null;
  endMinute: number | null;
  cardText: string | null;
  description: string | null;
  positions: CardPositionView[];
  process: {
    state: string;
    version: number;
    assignee: { id: string; fullName: string } | null;
    assignedAt: string | null;
    assembledAt: string | null;
    assembledById: string | null;
  };
  changedSinceClaim: boolean;
  print: { formId: string | null; jobs: CardPrintJobView[] };
}

export interface ShiftView {
  id: string;
  userId: string;
  userFullName: string;
  startedAt: string;
  closedAt: string | null;
  closeKind: string | null;
  closeReason: string | null;
  openAssignments: number;
}

export interface PrintJobView {
  id: string;
  orderId: string;
  orderNumber: string;
  printFormId: string;
  state: string;
  attempt: number;
  createdAt: string;
  completedAt: string | null;
  completedById: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
}

export interface FloristOption {
  userId: string;
  fullName: string;
  openAssignments: number;
}

/** Прочерк вместо пустоты: пустая ячейка читается как «забыли показать». */
export const EMPTY_VALUE = '—';

/**
 * Сколько строк клиент просит за раз.
 *
 * Совпадает с умолчанием сервера. Верхнюю границу задаёт сервер, и просить
 * больше неё бессмысленно: запрос будет отклонён, а не урезан.
 */
export const QUEUE_PAGE_SIZE = 50;

export const PROCESS_LABELS: Record<string, string> = {
  NEW: 'Свободен',
  IN_ASSEMBLY: 'В сборке',
  ASSEMBLED: 'Собран',
  NEEDS_REVIEW: 'Требует проверки',
};

export const PRINT_STATE_LABELS: Record<string, string> = {
  PENDING: 'Ожидает печати',
  PRINTED: 'Напечатано',
  ERROR: 'Ошибка печати',
};

export function processLabel(state: string): string {
  return PROCESS_LABELS[state] ?? state;
}

export function printStateLabel(state: string): string {
  return PRINT_STATE_LABELS[state] ?? state;
}

/**
 * Интервал доставки словами.
 *
 * Точное время — интервал нулевой ширины, и достраивать из него диапазон
 * запрещено: «к 14:00» и «с 14:00 до 18:00» — разные обещания клиенту.
 */
export function formatInterval(item: {
  startMinute: number | null;
  endMinute: number | null;
}): string {
  if (item.startMinute === null) {
    return 'без времени';
  }
  if (item.endMinute === null || item.endMinute === item.startMinute) {
    return formatMinutesOfDay(item.startMinute);
  }
  return `${formatMinutesOfDay(item.startMinute)} – ${formatMinutesOfDay(item.endMinute)}`;
}

/** Дата строкой: браузерный парсер даты способен сдвинуть день. */
export function formatDay(value: string | null): string {
  return value === null ? EMPTY_VALUE : formatCalendarDate(value);
}

export interface ActionContext {
  card: OrderCardView;
  viewerId: string;
  isAdmin: boolean;
  hasActiveShift: boolean;
}

/**
 * Что флорист может сделать с заказом прямо сейчас.
 *
 * Правила ровно те же, что проверяет сервер, — но выражены один раз и отдельно
 * от разметки. Без этого условия расползлись бы по кнопкам, и однажды одна
 * из них осталась бы включённой там, где действие уже невозможно.
 */
export function availableActions(context: ActionContext): {
  canClaim: boolean;
  canRelease: boolean;
  canAssemble: boolean;
  canReopen: boolean;
  canReassign: boolean;
  canPrint: boolean;
} {
  const { card, viewerId, isAdmin, hasActiveShift } = context;
  const state = card.process.state;
  const mine = card.process.assignee?.id === viewerId;

  return {
    // Смена — условие СЕРВЕРА, а не украшение: после её закрытия ни взять,
    // ни отпустить, ни завершить заказ нельзя, и кнопка не должна обещать
    // того, что заведомо получит отказ. Администратор разбирает оставшиеся
    // назначения и в смене не нуждается.
    canClaim: state === 'NEW' && hasActiveShift,
    canRelease: state === 'IN_ASSEMBLY' && (isAdmin || (mine && hasActiveShift)),
    canAssemble: state === 'IN_ASSEMBLY' && mine && hasActiveShift,
    canReopen: (state === 'ASSEMBLED' || state === 'NEEDS_REVIEW') && isAdmin,
    canReassign: (state === 'NEW' || state === 'IN_ASSEMBLY') && isAdmin,
    // Бланк существует с момента завершения сборки и остаётся доступным даже
    // после возврата заказа в работу: напечатанная бумага никуда не делась.
    canPrint: card.print.formId !== null,
  };
}

/** Последнее задание печати заказа: с ним и работают кнопки карточки. */
export function latestJob(card: OrderCardView): CardPrintJobView | null {
  return [...card.print.jobs].sort((a, b) => b.attempt - a.attempt)[0] ?? null;
}

/**
 * Смещение следующей страницы или `null`, если продолжения нет.
 *
 * Считается от того, что сервер ФАКТИЧЕСКИ вернул (`offset + limit`), а не от
 * числа накопленных строк: клиент, потерявший или отбросивший строку, иначе
 * запросил бы не то смещение и создал бы пропуск.
 */
export function nextPageOffset(page: PageMeta): number | null {
  return page.hasMore ? page.offset + page.limit : null;
}

/**
 * Склейка накопленных страниц в один список.
 *
 * Повторный идентификатор отбрасывается. Это не украшение: очередь живёт, и
 * между запросом первой и второй страницы заказ может появиться или уйти —
 * тогда смещение сдвигается, и одна и та же строка приходит дважды. Два
 * одинаковых ключа в списке React означают либо предупреждение, либо молча
 * потерянную строку, а человек увидел бы один заказ дважды и решил, что их два.
 *
 * Порядок сохраняется: первым остаётся то вхождение, которое пришло раньше,
 * то есть выше по канонической очереди.
 */
export function mergePages<T extends { id: string }>(pages: readonly { items: T[] }[]): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Сколько строк показано из скольких.
 *
 * Человеку нужны оба числа: без общего он не знает, что список продолжается,
 * а без показанного не понимает, сколько уже просмотрел.
 */
export function pageSummary(shown: number, total: number): string {
  return `Показано ${shown} из ${total}`;
}

/**
 * Заголовок группы заказов маршрута.
 *
 * Маршрут показывается явно: флорист обязан понимать, почему заказ с поздним
 * временем оказался выше — очередь ведёт маршрут целой группой (`FUL-002` §2.4.1).
 */
export function routeLabel(item: QueueItemView): string | null {
  if (item.route === null) {
    return null;
  }
  return item.route.position === null
    ? `Маршрут ${item.route.number}`
    : `Маршрут ${item.route.number}, остановка ${item.route.position}`;
}
