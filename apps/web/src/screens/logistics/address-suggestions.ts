/**
 * Общий контракт серверных подсказок адреса.
 *
 * Подсказки нужны и правке адреса заказа, и адресу склада. Контракт один
 * и живёт в одном месте: вторая интеграция означала бы второй разбор ответа,
 * второй набор правил «что считать точным» и разное поведение там, где
 * поведение обязано совпадать.
 *
 * Ключ DaData остаётся на сервере. Браузер знает только наш адрес — ни ключа,
 * ни адреса провайдера у него нет.
 */

/** Минимальная длина запроса. Короче сервер всё равно ответит пустым списком. */
export const MIN_SUGGEST_QUERY = 3;

export interface AddressSuggestion {
  value: string;
  latMicro: number | null;
  lonMicro: number | null;
  /** Код точности привязки как его вернула DaData. Технический, не PII. */
  qcGeo?: number | null;
  /** Точна ли привязка: только такая подсказка годится без проверки человеком. */
  exact: boolean;
}

export interface SuggestResponse {
  suggestions: AddressSuggestion[];
  /** `false` — подсказки не настроены в этом окружении. */
  available: boolean;
}

/**
 * Адрес нашего эндпоинта подсказок.
 *
 * Браузер обращается ТОЛЬКО сюда. Функция существует ради этой проверки —
 * иначе однажды кто-нибудь позвал бы провайдера напрямую «для скорости».
 */
export function suggestionsUrl(query: string): string {
  return `/api/orders/address-suggestions?query=${encodeURIComponent(query.trim())}`;
}

/**
 * Годится ли подсказка как точка склада.
 *
 * Складу нужен дом и координаты: улица без дома отправила бы курьеров
 * от середины улицы, а расчёт выдал бы это за настоящее время в пути.
 */
export function isUsablePoint(suggestion: AddressSuggestion): boolean {
  return suggestion.exact && suggestion.latMicro !== null && suggestion.lonMicro !== null;
}
