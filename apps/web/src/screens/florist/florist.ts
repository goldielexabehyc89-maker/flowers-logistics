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

import { formatCalendarDate, formatMinutesOfDay, moscowToday, shiftCalendarDate } from '@fl/shared';

export type QueueDay = 'today' | 'tomorrow';
export type QueueScope = 'general' | 'mine';
/** Область «Моих заказов»: работа или уже собранные заказы. */
export type QueueGroup = 'work' | 'assembled';
export type FloristTab = 'queue' | 'auto' | 'mine' | 'print' | 'stats';

/** Режим распределения свободных заказов. Ручной — очередь; авто — раздаёт сервер. */
export type DispatchMode = 'MANUAL' | 'AUTO';

/** Причина отказа флориста. Совпадает с серверным enum `OrderRefusalReason`. */
export type RefusalReason =
  'INSUFFICIENT_GOODS' | 'CANNOT_ASSEMBLE' | 'PHYSICALLY_IMPOSSIBLE' | 'WRONG_ASSIGNMENT' | 'OTHER';

export const REFUSAL_REASONS: RefusalReason[] = [
  'INSUFFICIENT_GOODS',
  'CANNOT_ASSEMBLE',
  'PHYSICALLY_IMPOSSIBLE',
  'WRONG_ASSIGNMENT',
  'OTHER',
];

export const REFUSAL_REASON_LABELS: Record<RefusalReason, string> = {
  INSUFFICIENT_GOODS: 'Не хватает товара',
  CANNOT_ASSEMBLE: 'Не могу собрать',
  PHYSICALLY_IMPOSSIBLE: 'Физически невозможно',
  WRONG_ASSIGNMENT: 'Ошибочное назначение',
  OTHER: 'Другое',
};

export function refusalReasonLabel(reason: string): string {
  return REFUSAL_REASON_LABELS[reason as RefusalReason] ?? reason;
}

/** Состояние запроса отказа: совпадает с серверным `OrderRefusalState`. */
export const REFUSAL_STATE_LABELS: Record<string, string> = {
  PENDING: 'Ожидает решения',
  REJECTED: 'Отклонён',
  APPROVED: 'Отказ подтверждён',
  TRANSFERRED: 'Передан другому',
};

export function refusalStateLabel(state: string): string {
  return REFUSAL_STATE_LABELS[state] ?? state;
}

/**
 * Ответ `/api/florist/dispatch/status` — рабочее место в режиме авто.
 *
 * `mode` считает сервер по общей настройке. Когда `AUTO`, свободная очередь
 * флористу не отдаётся вовсе (сервер возвращает пустой список): флорист не
 * выбирает заказ, а нажимает «Готов» и ждёт назначения.
 */
export interface FloristDispatchStatus {
  mode: DispatchMode;
  hasActiveShift: boolean;
  /** Нажата ли «Готов к заказам». Требует активной смены. */
  ready: boolean;
  readyAt: string | null;
  /** «Закончить после текущего»: новых автоназначений не будет. */
  finishAfterCurrent: boolean;
  /** Сколько заказов ждёт раздачи прямо сейчас (по полному серверному набору). */
  waitingCount: number;
  /** Текущий назначенный заказ или `null`. */
  activeOrder: { id: string; number: string; reassembly: boolean } | null;
  /** Есть открытый запрос отказа по текущему заказу — ждёт решения руководителя. */
  pendingRefusal: boolean;
}

/**
 * Что показать в панели авто-раздачи одной строкой состояния.
 *
 * Это подпись, а не право: любое действие всё равно проверяет сервер. Порядок
 * проверок повторяет серверный, чтобы человек видел near ту же причину, по
 * которой сервер не даёт новый заказ.
 */
export function dispatchStateLabel(status: FloristDispatchStatus): string {
  if (!status.hasActiveShift) {
    return 'Откройте смену, чтобы принимать заказы';
  }
  if (status.activeOrder !== null) {
    return status.pendingRefusal ? 'Заказ на решении руководителя' : 'Собирается текущий заказ';
  }
  if (status.finishAfterCurrent) {
    return 'Готовность снята: новых заказов не будет';
  }
  if (!status.ready) {
    return 'Нажмите «Готов», чтобы получить заказ';
  }
  return status.waitingCount > 0 ? 'Ожидаем назначения…' : 'Свободных заказов пока нет';
}

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
  /** Пересборка: новый круг сборки. Карточка показывает «Пересборка». */
  reassembly?: boolean;
  /** Заказ отменён: собирать нельзя. Из списка при этом не исчезает. */
  cancelled?: boolean;
  /**
   * Ближайший самовывоз: до начала интервала меньше часа.
   *
   * Признак считает сервер по полному набору очереди. Клиент им только
   * группирует строки: выводить принадлежность к приоритету из подписи или
   * из времени в браузере значило бы получить второй ответ на тот же вопрос.
   */
  pickupSoon?: boolean;
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
  group: QueueGroup;
  includeAssigned: boolean;
  /** Применённый сервером поиск: пустая строка поиском не считается. */
  search: string | null;
  /**
   * Сколько всего собранных заказов в этом дне у флориста.
   *
   * Считает сервер, поэтому число верно и тогда, когда группа свёрнута и её
   * строки не загружены. `null` — область не «Мои заказы».
   */
  assembledTotal: number | null;
  /**
   * Собранные, разложенные по дате доставки. Каждый счётчик — по полному
   * серверному набору (день и поиск учтены), а не по загруженной странице.
   * `null` — область не «Мои заказы».
   */
  assembledByDate: AssembledDateCount[] | null;
  items: QueueItemView[];
}

/** Число собранных на одну дату доставки (`null` — заказы без даты). */
export interface AssembledDateCount {
  date: string | null;
  count: number;
}

/** Группа собранных заказов одной даты доставки для показа с заголовком. */
export interface AssembledDateGroup {
  date: string | null;
  label: string;
  /** Счётчик ПОЛНОГО серверного набора этой даты (не загруженной страницы). */
  count: number;
  items: QueueItemView[];
}

/** «Сегодня, ДД.ММ» / «Завтра, ДД.ММ» / «ДД.ММ.ГГГГ» / «Без даты». */
export function assembledDateLabel(date: string | null, today: string, tomorrow: string): string {
  if (date === null) {
    return 'Без даты';
  }
  const short = formatCalendarDate(date).slice(0, 5);
  if (date === today) {
    return `Сегодня, ${short}`;
  }
  if (date === tomorrow) {
    return `Завтра, ${short}`;
  }
  return formatCalendarDate(date);
}

/**
 * Раскладывает ЗАГРУЖЕННЫЕ собранные строки по дате доставки, а счётчики берёт
 * из серверного набора `counts` (полного, с учётом поиска).
 *
 * Датированные группы идут по дате доставки ПО ВОЗРАСТАНИЮ (старые и ближайшие
 * выше будущих), бездатная — в самом низу. Внутри даты порядок строк
 * сохраняется тем, что пришёл с сервера. Пустые группы не создаются: заголовок
 * появляется только у даты, чьи строки уже загружены.
 */
export function groupAssembledByDate(
  items: QueueItemView[],
  counts: AssembledDateCount[],
  now: Date = new Date(),
): AssembledDateGroup[] {
  const today = moscowToday(now);
  const tomorrow = shiftCalendarDate(today, 1);
  const countByDate = new Map(counts.map((entry) => [entry.date, entry.count]));

  const order: (string | null)[] = [];
  const buckets = new Map<string | null, QueueItemView[]>();
  for (const item of items) {
    const key = item.deliveryDate;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [item]);
      order.push(key);
    } else {
      bucket.push(item);
    }
  }

  const dated: AssembledDateGroup[] = [];
  let undated: AssembledDateGroup | null = null;
  for (const key of order) {
    const groupItems = buckets.get(key) ?? [];
    const group: AssembledDateGroup = {
      date: key,
      label: assembledDateLabel(key, today, tomorrow),
      count: countByDate.get(key) ?? groupItems.length,
      items: groupItems,
    };
    if (key === null) {
      undated = group;
    } else {
      dated.push(group);
    }
  }
  dated.sort((a, b) =>
    (a.date ?? '') < (b.date ?? '') ? -1 : (a.date ?? '') > (b.date ?? '') ? 1 : 0,
  );
  return undated === null ? dated : [...dated, undated];
}

export interface PrintJobsResponse extends PageMeta {
  items: PrintJobView[];
}

export interface CardComponentView {
  name: string | null;
  quantity: string;
  /** Обозначение единицы измерения на момент снимка. `null` — только число. */
  uomName: string | null;
}

export interface CardPositionView {
  name: string | null;
  quantity: string;
  uomName: string | null;
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
  /** Заказ отменён: собирать нельзя. Из списка при этом не исчезает. */
  cancelled?: boolean;
  /**
   * Заказ вышел из производственной области (исчез из МоегоСклада или выведен)
   * уже после того, как попал в работу. Карточка открывается, но показывает
   * безопасную причину — почему заказа «нет» в очереди и справочнике.
   */
  outOfScope?: boolean;
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
  /**
   * Точка печати смены.
   *
   * Живёт в смене, а не отдельной сессией: завершение смены снимает выбор
   * само. У смен, открытых до появления печати, здесь `null` — точку спросят
   * при первом «Собран».
   */
  printPointId: string | null;
  printPointName: string | null;
}

/** Точка печати в списке выбора. Флористу видно название и связь. */
export interface PrintPointOption {
  id: string;
  name: string;
  state: 'ONLINE' | 'OFFLINE' | 'ERROR';
}

/**
 * Ответ на «какая у меня смена и сколько за мной работы».
 *
 * `activeOrders` — серверное итоговое число заказов в состояниях
 * `IN_ASSEMBLY` и `NEEDS_REVIEW`. Оно НЕ выводится из списков: день, поиск,
 * догруженные страницы и открытая вкладка на него не влияют, а на вкладке
 * «Печать» списка «Моих заказов» нет вовсе. Смены может не быть, а заказы
 * за человеком остаться, поэтому число лежит рядом со сменой, а не внутри неё.
 */
export interface ShiftResponse {
  shift: ShiftView | null;
  activeOrders: number;
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
  /**
   * Состояние автоматической доставки в спулер. `SENT_TO_PRINTER` означает, что
   * наклейка ушла на печать сама, но бумага человеком ещё не подтверждена —
   * задание остаётся в «Требуют внимания» с явной отметкой «Передано принтеру».
   */
  deliveryState: string | null;
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

/**
 * Как часто перезапрашивается очередь.
 *
 * Приоритет ближайших самовывозов наступает от хода времени: в момент, когда
 * до начала интервала остаётся меньше часа, никто ничего не делает, и события
 * realtime не происходит. Полминуты — компромисс: заказ поднимается наверх
 * почти сразу, а нагрузка остаётся двумя запросами в минуту на смену.
 */
export const QUEUE_POLL_MS = 30_000;

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
    // Предлог обязателен: голое «14:00» в строке очереди читается как начало
    // чего-то, и флорист гадает, есть ли у него запас до конца окна.
    return `к ${formatMinutesOfDay(item.startMinute)}`;
  }
  return `${formatMinutesOfDay(item.startMinute)} – ${formatMinutesOfDay(item.endMinute)}`;
}

/** Дата строкой: браузерный парсер даты способен сдвинуть день. */
export function formatDay(value: string | null): string {
  return value === null ? EMPTY_VALUE : formatCalendarDate(value);
}

/**
 * Количество человеку: русская десятичная запятая и единица, если она известна.
 *
 * Правило то же, что на бланке (`apps/api/.../pdf.ts`): каноническое значение
 * хранится с точкой, запятая появляется только при показе. Разойтись эти два
 * формата не должны — «0.5 м» на экране и «0,5 м» на бумаге читаются как
 * разные документы об одном заказе.
 *
 * Единицы может не быть. Тогда показывается одно число: ни «ед. не указана»,
 * ни подставленное «шт.» — догадка о единице выглядит как факт и приводит к
 * собранному не тому букету.
 */
export function formatQuantity(quantity: string, uomName: string | null): string {
  const value = quantity.replace('.', ',');
  const unit = uomName !== null && uomName.trim() !== '' ? ` ${uomName.trim()}` : '';
  return `${value}${unit}`;
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
    // Возврат собранного на шаг назад: администратору/управляющему — любой,
    // флористу — только СВОЙ и только на активной смене (как сборка и снятие).
    canReopen:
      (state === 'ASSEMBLED' || state === 'NEEDS_REVIEW') && (isAdmin || (mine && hasActiveShift)),
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

/** Что это за группа очереди: приоритетные самовывозы, лист или всё прочее. */
export type QueueGroupKind = 'pickup-soon' | 'route' | 'none';

export interface QueueGroupView {
  key: string;
  kind: QueueGroupKind;
  /** Лист группы. `null` у приоритетных самовывозов и у заказов без листа. */
  route: { id: string; number: string } | null;
  items: QueueItemView[];
}

/** Заголовок группы очереди. */
export function queueGroupTitle(group: {
  kind: QueueGroupKind;
  route: { number: string } | null;
}): string {
  if (group.kind === 'pickup-soon') {
    return 'Ближайшие самовывозы';
  }
  return group.route === null ? 'Без маршрута' : `Маршрут ${group.route.number}`;
}

/**
 * Очередь, разложенная по листам.
 *
 * Порядок строк уже задал сервер: заказы подтверждённых листов идут первыми,
 * листы — по времени первой остановки, внутри листа — по остановкам. Здесь
 * соседние строки одного листа лишь собираются в группу, порядок не меняется:
 * пересортировка на клиенте разошлась бы с постраничной загрузкой.
 */
export function groupQueueByRoute(items: readonly QueueItemView[]): QueueGroupView[] {
  const groups: QueueGroupView[] = [];
  for (const item of items) {
    /*
     * Ближайшие самовывозы — своя группа, и она перекрывает маршрутную.
     *
     * Сервер уже поставил их первыми, поэтому строки идут подряд и группа
     * собирается тем же проходом. Один заказ попадает ровно в одну группу:
     * вид выбирается один раз, и в маршрутную он после этого не заходит.
     */
    const kind: QueueGroupKind =
      item.pickupSoon === true ? 'pickup-soon' : item.route === null ? 'none' : 'route';
    const route = kind === 'route' ? item.route : null;
    const key = route === null ? kind : route.id;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key) {
      last.items.push(item);
      continue;
    }
    groups.push({ key, kind, route, items: [item] });
  }
  return groups;
}

/**
 * Имя файла этикетки — то же, что формирует сервер.
 *
 * Правило повторено на клиенте не ради проверки, а ради папки загрузок:
 * браузер берёт имя из атрибута ссылки, и разойдись оно с серверным —
 * этикетка и бланк одного заказа легли бы рядом под несопоставимыми
 * именами. Всё, что не буква латиницы, цифра, точка, дефис или
 * подчёркивание, заменяется подчёркиванием: кириллица и пробелы в имени
 * файла переживают не каждую файловую систему и не каждый принтерный
 * каталог.
 */
export function safeFileName(orderNumber: string): string {
  return orderNumber.replace(/[^A-Za-z0-9._-]/g, '_');
}
