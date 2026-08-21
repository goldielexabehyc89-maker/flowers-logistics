/**
 * Правила складского экрана, вынесенные из компонентов.
 *
 * Здесь только чистые функции и типы: их проверяют тестами без браузера.
 * Состав повторяет безопасный ответ сервера — ни адреса, ни получателя,
 * ни состава заказа тут нет и появиться не может.
 */

export type StorageCellKind = 'STORAGE' | 'ROUTE';
export type IssueSessionState = 'OPEN' | 'COMPLETED' | 'CANCELLED';
export type RouteState = 'DRAFT' | 'CONFIRMED' | 'CANCELLED' | 'ACTIVE';

export interface PlacedOrderView {
  orderId: string;
  orderNumber: string;
  deliveryDate: string | null;
  cellId: string | null;
  cellCode: string | null;
  cellKind: StorageCellKind | null;
  requiresRelocation: boolean;
  blockedBy: string[];
  routeNumber: string | null;
  routeId: string | null;
}

export interface RouteFlowOrderView extends PlacedOrderView {
  position: number;
  issued: boolean;
  inRouteCell: boolean;
}

export interface RouteSummary {
  routeId: string;
  routeNumber: string;
  state: RouteState;
  deliveryDate: string;
  courier: { id: string; fullName: string } | null;
  total: number;
  inRouteCell: number;
  issued: number;
  hasIssueSession: boolean;
}

export interface RouteFlowView {
  routeId: string;
  routeNumber: string;
  state: RouteState;
  version: number;
  deliveryDate: string;
  courier: { id: string; fullName: string } | null;
  /** Маршрутные ячейки листа: их может быть несколько. */
  routeCells: { id: string; code: string }[];
  issueSession: { id: string; courierUserId: string; state: IssueSessionState } | null;
  orders: RouteFlowOrderView[];
}

export interface ScanContext {
  orderId: string;
  orderNumber: string;
  blockedBy: string[];
  needsAttention: boolean;
  currentCell: {
    id: string;
    code: string;
    kind: StorageCellKind;
    requiresRelocation: boolean;
  } | null;
  route: { id: string; number: string; routeCells: { id: string; code: string }[] } | null;
}

/** Человеческие названия признаков, блокирующих обычную работу. */
export const BLOCK_LABELS: Record<string, string> = {
  OUT_OF_SCOPE: 'Не наша доставка',
  SOURCE_ARCHIVED: 'Архивирован в МоемСкладе',
  SOURCE_MISSING: 'Не найден в МоемСкладе',
  CANCELLED: 'Отменён — не выдавать',
};

export function blockLabel(flag: string): string {
  return BLOCK_LABELS[flag] ?? flag;
}

export const CELL_KIND_LABELS: Record<StorageCellKind, string> = {
  STORAGE: 'Хранение',
  ROUTE: 'Маршрутная',
};

/** Что показать в колонке «Ячейка»: код либо честное «не принят». */
export function cellLabel(order: PlacedOrderView): string {
  return order.cellCode ?? 'Не принят';
}

/**
 * Ячейка заказа в строке листа.
 *
 * Показывается ФАКТИЧЕСКОЕ место коробки вместе с видом полки: идти за ней
 * придётся либо к маршрутной, либо в хранение, и одного кода для этого мало.
 * Скобки не украшение — подпись стоит вплотную к статусу и без них читалась
 * бы как часть его текста. Прочерк остаётся ровно для одного случая:
 * действующего размещения нет, коробки на складе нет вовсе.
 *
 * Формат один на «Выдачу» и «Сборку»: две записи одного и того же заставляли
 * бы сверять, одна ли это полка.
 */
export function issueCellLabel(order: {
  cellCode: string | null;
  cellKind: StorageCellKind | null;
}): string {
  if (order.cellCode === null || order.cellKind === null) {
    return '—';
  }
  return `(${order.cellCode} · ${CELL_KIND_LABELS[order.cellKind]})`;
}

/*
 * Счётчики комплектования и выдачи здесь больше не считаются.
 *
 * Оба экрана показывают серверный прогресс: за одним листом стоят два
 * кладовщика, и число «внесено N из M» обязано быть одним и тем же на
 * обоих телефонах. Локальный подсчёт по загруженному списку показывал бы
 * каждому свою правду до следующего обновления.
 */

/**
 * Следующий шаг двухсканной операции.
 *
 * До второго скана база не меняется, поэтому интерфейс обязан честно
 * показывать, чего он ждёт: иначе кладовщик решит, что заказ уже принят.
 */
export type ScanStep = 'ORDER' | 'CELL' | 'ROUTE_CELL';

export function nextStep(orderScanned: boolean): ScanStep {
  return orderScanned ? 'CELL' : 'ORDER';
}

export const SCAN_HINTS: Record<ScanStep, string> = {
  ORDER: 'Отсканируйте QR заказа',
  CELL: 'Теперь отсканируйте QR ячейки',
  // Сборка ждёт полку листа, а не любую свободную ячейку.
  ROUTE_CELL: 'Теперь отсканируйте QR маршрутной ячейки',
};

/**
 * Порядок групп складского списка.
 *
 * Смысл порядка — срочность, а не аккуратность. Заказ, требующий
 * перемещения, держит маршрутную ячейку и мешает комплектованию соседнего
 * листа: он обязан быть сверху. Отменённые лежат мёртвым грузом и ждут
 * решения, поэтому идут следом, но свёрнутыми — их бывает много, и
 * разворачивать ими весь экран незачем.
 *
 * Заказ попадает РОВНО В ОДНУ группу. Дубль в двух группах читался бы как
 * две разные коробки: кладовщик пошёл бы искать вторую.
 */
export interface PlacementGroups<T> {
  relocation: T[];
  cancelled: T[];
  rest: T[];
}

export function groupPlacements<T extends { requiresRelocation: boolean; blockedBy: string[] }>(
  items: readonly T[],
): PlacementGroups<T> {
  const relocation: T[] = [];
  const cancelled: T[] = [];
  const rest: T[] = [];

  for (const item of items) {
    if (item.requiresRelocation) {
      relocation.push(item);
    } else if (item.blockedBy.includes('CANCELLED')) {
      cancelled.push(item);
    } else {
      rest.push(item);
    }
  }

  return { relocation, cancelled, rest };
}

/**
 * Полные размеры групп складского списка.
 *
 * Приходят с сервера и считаются по всему складу, а не по загруженным
 * страницам: счётчик у заголовка обязан отвечать на вопрос «сколько таких
 * коробок на складе», а не «сколько их успело попасть в первую сотню».
 */
export interface PlacementGroupTotals {
  relocation: number;
  cancelled: number;
  rest: number;
}

/**
 * Ключ строки складского списка.
 *
 * Одна коробка — это заказ в КОНКРЕТНОЙ ячейке: один заказ может лежать
 * разложенным по двум ячейкам, и тогда это две разные строки.
 */
function placementKey(item: { orderId: string; cellId: string | null }): string {
  return `${item.orderId}:${item.cellId ?? ''}`;
}

/**
 * Склейка дочитанных страниц складского списка.
 *
 * Повтор отбрасывается: склад живёт, и между запросом первой и второй страницы
 * коробку могут снять с хранения — тогда смещение сдвигается, и одна и та же
 * строка приходит дважды. Кладовщик увидел бы один заказ дважды и пошёл бы
 * искать вторую коробку.
 *
 * Порядок сохраняется: первым остаётся то вхождение, которое пришло раньше.
 */
export function mergePlacementPages<T extends { orderId: string; cellId: string | null }>(
  pages: readonly { items: T[] }[],
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      const key = placementKey(item);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Смещение следующей страницы или `null`, когда дочитывать нечего.
 *
 * Считается по фактически полученным строкам, а не по номеру страницы: если
 * последняя страница пришла короче запрошенной, дочитывать всё равно нужно
 * ровно до серверного `total`.
 */
export function nextPlacementOffset(page: {
  items: readonly unknown[];
  total: number;
  limit: number;
  offset: number;
}): number | null {
  const loaded = page.offset + page.items.length;
  return loaded < page.total ? loaded : null;
}

// --- Доска сборки ------------------------------------------------------------

/**
 * Стадия заказа в листе. Считает сервер: «готов» — это действующее
 * размещение в маршрутной ячейке ИМЕННО этого листа.
 */
export type RouteOrderStage = 'NOT_ASSEMBLED' | 'AWAITING_INTAKE' | 'IN_STORAGE' | 'READY';

/** Подписи стадий. Текст, значок и цвет различают их вместе, а не поодиночке. */
export const STAGE_LABELS: Record<RouteOrderStage, string> = {
  NOT_ASSEMBLED: 'Не собран',
  AWAITING_INTAKE: 'Ожидает приёмки',
  IN_STORAGE: 'В хранении',
  READY: 'Готов',
};

export const STAGE_TONES: Record<RouteOrderStage, 'neutral' | 'info' | 'warning' | 'success'> = {
  NOT_ASSEMBLED: 'neutral',
  AWAITING_INTAKE: 'info',
  IN_STORAGE: 'warning',
  READY: 'success',
};

export interface AssemblyOrderView {
  orderId: string;
  orderNumber: string;
  position: number;
  startMinute: number | null;
  endMinute: number | null;
  cellCode: string | null;
  cellKind: StorageCellKind | null;
  stage: RouteOrderStage;
  requiresRelocation: boolean;
  cancelled: boolean;
}

export interface AssemblyRouteView {
  routeId: string;
  routeNumber: string;
  deliveryDate: string;
  earliestMinute: number | null;
  courier: { id: string; fullName: string } | null;
  cells: { id: string; code: string }[];
  total: number;
  ready: number;
  orders: AssemblyOrderView[];
}

export interface AssemblyBoard {
  active: AssemblyRouteView[];
  /** Собрано всё, но часть коробок ещё в хранении: остался только перенос. */
  relocatable: AssemblyRouteView[];
  assembled: AssemblyRouteView[];
}

// --- Доска выдачи ------------------------------------------------------------

export interface IssueOrderView {
  orderId: string;
  orderNumber: string;
  position: number;
  /** Ячейка, в которой коробка лежит сейчас: маршрутная или хранения. */
  cellCode: string | null;
  /** Тип ячейки приходит с сервера и по коду не угадывается. */
  cellKind: StorageCellKind | null;
  ready: boolean;
  /** Коробка стоит в маршрутной ячейке именно этого листа. */
  inRouteCell: boolean;
  checked: boolean;
}

/** Готовность листа к выдаче: считает сервер, клиент только показывает. */
export type IssueReadiness = 'ASSEMBLED' | 'CAN_ISSUE' | 'NOT_READY';

/**
 * Подписи готовности.
 *
 * Два положительных состояния различаются не правом отгрузить, а тем, где
 * стоят коробки: «собран» означает, что по складу ходить не придётся.
 */
export const ISSUE_READINESS_LABELS: Record<Exclude<IssueReadiness, 'NOT_READY'>, string> = {
  ASSEMBLED: 'Собран — можно выдавать',
  CAN_ISSUE: 'Можно выдать',
};

export interface IssueRouteView {
  routeId: string;
  routeNumber: string;
  deliveryDate: string;
  earliestMinute: number | null;
  total: number;
  checked: number;
  sessionOpen: boolean;
  shippable: boolean;
  readiness: IssueReadiness;
  orders: IssueOrderView[];
}

export interface IssueBoard {
  couriers: {
    courierUserId: string;
    fullName: string;
    /** Телефон приходит обычным ответом API и в realtime не уходит. */
    phone: string;
    /** Сколько листов курьера готовы к выдаче: считает сервер. */
    readyRoutes: number;
    routes: IssueRouteView[];
  }[];
}
