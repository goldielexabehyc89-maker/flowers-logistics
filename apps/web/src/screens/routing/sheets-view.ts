/**
 * Правила экрана маршрутных листов.
 *
 * Только чистые функции: какие разделы существуют, какой день раскрыт
 * по умолчанию и что можно сделать с листом. Их видно целиком и можно
 * доказать без браузера.
 */

/** Разделы идут в этом порядке и отвечают на вопрос «что дальше». */
export const SHEET_SECTIONS = ['UNSHIPPED', 'SHIPPED', 'DELIVERED'] as const;

export type SheetSection = (typeof SHEET_SECTIONS)[number];

export const SECTION_TITLES: Record<SheetSection, string> = {
  UNSHIPPED: 'Неотгруженные',
  SHIPPED: 'Отгруженные',
  DELIVERED: 'Доставленные',
};

export interface SheetView {
  id: string;
  number: string;
  deliveryDate: string;
  state: string;
  version: number;
  courier: { id: string; fullName: string } | null;
  totalOrders: number;
  deliveredOrders: number;
  deliveredNumbers: string[];
}

export interface SheetsDay {
  date: string;
  sheets: SheetView[];
}

/**
 * Раскрыт ли день.
 *
 * Текущий день раскрыт всегда: смена начинается с него. Прошлые свёрнуты, пока
 * человек не открыл их сам — иначе история дня за днём превращает экран
 * в бесконечную ленту.
 */
export function isDayOpen(date: string, today: string, opened: ReadonlySet<string>): boolean {
  return date === today || opened.has(date);
}

/** Переключение дня: раскрытый сворачивается, свёрнутый раскрывается. */
export function toggleDay(opened: ReadonlySet<string>, date: string): Set<string> {
  const next = new Set(opened);
  if (next.has(date)) {
    next.delete(date);
  } else {
    next.add(date);
  }
  return next;
}

/**
 * Можно ли отгрузить лист.
 *
 * Без курьера — нельзя: лист «уехал» бы неизвестно с кем. Выключенная
 * администратором настройка запрещает ручную отгрузку целиком, и кнопка
 * тогда не притворяется доступной.
 */
export function canShip(sheet: SheetView, manualIssueEnabled: boolean): boolean {
  return manualIssueEnabled && sheet.courier !== null;
}

/**
 * Показывать ли кнопку отгрузки вообще.
 *
 * При выключенной настройке кнопки нет: погашенная кнопка обещает действие,
 * которого в этом контуре не существует, и логист раз за разом возвращается
 * к ней в поисках, что же ещё нажать.
 */
export function showsShipButton(manualIssueEnabled: boolean): boolean {
  return manualIssueEnabled;
}

/**
 * Почему отгрузка недоступна. `null` — доступна.
 *
 * Возвращает причину и для выключенной настройки: она нужна там, где кнопку
 * всё же показывают (например, в объяснении на самой вкладке).
 */
export function shipBlockedReason(sheet: SheetView, manualIssueEnabled: boolean): string | null {
  if (!manualIssueEnabled) {
    return 'Ручная отгрузка выключена администратором';
  }
  if (sheet.courier === null) {
    return 'Сначала назначьте курьера: без него отгружать некому';
  }
  return null;
}

/**
 * Нужно ли предупреждение перед отменой отгрузки.
 *
 * Если в листе есть доставленные заказы, отмена перестаёт быть обычной:
 * человек обязан увидеть их номера и выбрать, что с ними делать.
 */
export function needsCancelWarning(sheet: SheetView): boolean {
  return sheet.deliveredNumbers.length > 0;
}
