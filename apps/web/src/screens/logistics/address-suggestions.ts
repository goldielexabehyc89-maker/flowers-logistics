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

/**
 * Сколько подсказок показывать.
 *
 * Четыре — это выбор, а не чтение списка. Длинный перечень адресов,
 * отличающихся корпусом, разбирают дольше, чем дописывают номер дома
 * руками; к тому же список, закрывающий половину карточки, прячет то,
 * ради чего адрес и правят.
 */
export const MAX_SUGGESTIONS = 4;

/** Видимая часть подсказок: ровно столько, сколько показываем. */
export function visibleSuggestions<T>(items: readonly T[]): T[] {
  return items.slice(0, MAX_SUGGESTIONS);
}

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

// --- Поведение выпадающего списка ------------------------------------------

/**
 * Состояние поля с подсказками.
 *
 * Раньше видимость списка выводилась только из «пришли ли варианты», а
 * выбранное значение попадало обратно в ключ запроса. Выбор был неотличим
 * от набора текста: список тут же открывался снова на только что принятый
 * адрес, и закрыть его можно было лишь уходом фокуса.
 *
 * Поэтому состояние помнит, ДЛЯ КАКОГО текста подсказка уже принята. Пока
 * текст совпадает с принятым — запроса нет и список закрыт; любое изменение
 * текста человеком снова открывает подбор.
 */
export interface SuggestBox {
  /** Что сейчас в поле. */
  text: string;
  /** Текст, для которого подсказку уже выбрали. `null` — выбора не было. */
  acceptedFor: string | null;
}

export const EMPTY_SUGGEST_BOX: SuggestBox = { text: '', acceptedFor: null };

/** Поле с готовым текстом и без выбора: так открывается правка адреса заказа. */
export function suggestBoxFrom(text: string): SuggestBox {
  return { text, acceptedFor: null };
}

/** Нужно ли спрашивать подсказки. Принятый адрес заново не запрашивается. */
export function shouldRequestSuggestions(box: SuggestBox): boolean {
  return box.text.trim().length >= MIN_SUGGEST_QUERY && box.text !== box.acceptedFor;
}

/** Открыт ли список. Закрыт сразу после выбора и пока текст не изменили. */
export function isSuggestListOpen(box: SuggestBox, hasSuggestions: boolean): boolean {
  return hasSuggestions && shouldRequestSuggestions(box);
}

/** Человек правит текст: прежний выбор перестаёт действовать. */
export function typeInSuggestBox(box: SuggestBox, text: string): SuggestBox {
  return { text, acceptedFor: box.acceptedFor === text ? box.acceptedFor : null };
}

/** Человек выбрал подсказку: список закрывается, новый запрос не уходит. */
export function acceptSuggestion(value: string): SuggestBox {
  return { text: value, acceptedFor: value };
}
