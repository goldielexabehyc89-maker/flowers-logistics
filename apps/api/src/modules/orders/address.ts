/**
 * Эффективный адрес заказа.
 *
 * Источников два — исходный `shipmentAddress` МоегоСклада и локальная правка
 * логиста, — а рабочее значение одно. Оно вычисляется здесь и больше нигде:
 * список, карта, геокодирование, матрица и маршрут обязаны видеть один и тот же
 * адрес. Две независимые формулы «какой адрес считать рабочим» разошлись бы,
 * и заказ поехал бы по одному адресу, а показывался бы по другому.
 *
 * Локальная правка сильнее исходного значения ДО будущей outbound-записи
 * в МойСклад (`docs/OWNER_DECISIONS.md`, `LOG-001`). Пока такой записи нет,
 * исходное поле не трогается вовсе: перезапись выдавала бы несделанную
 * отправку за выполненную.
 */

/**
 * Версия адресного контракта заказа.
 *
 * `LEGACY` — прежний путь: показывается `address`, геокодеру уходит
 * `geocodeAddress`. `V2` — структурированный: рабочий адрес собран из города,
 * улицы и дома, а детали живут отдельной строкой.
 */
export type AddressContract = 'LEGACY' | 'V2';

/**
 * Какой контракт у заказа.
 *
 * `null` — legacy: так выглядят все заказы, созданные до перехода. Двойки
 * не бывает случайно: её ставит только импорт при создании строки, а база
 * не принимает иных значений. Любое другое число означает, что данные
 * пришли не оттуда, откуда мы думаем, — и это отказ, а не молчаливый
 * возврат к прежнему поведению: молчание здесь показало бы курьеру не тот
 * адрес и никак себя не проявило бы.
 */
export function contractVersionOf(order: {
  addressContractVersion?: number | null;
}): AddressContract {
  const version = order.addressContractVersion;
  if (version === null || version === undefined) {
    return 'LEGACY';
  }
  if (version === 2) {
    return 'V2';
  }
  throw new Error(`неизвестная версия адресного контракта: ${String(version)}`);
}

/** Минимум, которого достаточно для вычисления рабочего адреса. */
export interface AddressSource {
  address: string | null;
  /**
   * Локальная правка.
   *
   * Поле необязательно намеренно: прежний код, не знающий о правке, продолжает
   * передавать заказ без неё, и это должно означать «правки нет», а не отказ.
   */
  localAddress?: string | null;
  /**
   * Запрос к геокодеру, собранный из разобранного адреса источника.
   *
   * Тоже необязательно: прежний код его не передаёт, и это означает
   * «отдельного запроса нет» — геокодер берёт адрес заказа.
   */
  geocodeAddress?: string | null;
  /**
   * Рабочий адрес нового контракта: город, улица, дом.
   *
   * Необязателен: прежний код его не передаёт, и это значит «заказ живёт
   * по старому контракту».
   */
  structuredAddress?: string | null;
  /** Детали адреса нового контракта. Наружу не уходят никогда. */
  addressDetails?: string | null;
  /** Версия контракта. Пусто — legacy. */
  addressContractVersion?: number | null;
}

/** Состояние локальной правки для карточки и правил внимания. */
export interface AddressState {
  /** Значение, которым пользуются все потребители. */
  effective: string | null;
  /** Исходное значение МоегоСклада — показывается рядом, но не используется. */
  source: string | null;
  /** Исправлен ли адрес логистом. */
  corrected: boolean;
  /** Разошёлся ли источник с тем, что видел логист при правке. */
  conflict: boolean;
  /** Детали адреса. `null` у legacy-заказа: их там не существует. */
  details: string | null;
  /** Версия контракта: по ней интерфейс решает, что показывать. */
  contract: AddressContract;
}

/** Пустая строка адресом не считается: она неотличима от отсутствия значения. */
function normalize(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Рабочий адрес заказа.
 *
 * Локальная правка сильнее. Если её нет — исходный адрес; если нет и его —
 * адреса у заказа нет, и он остаётся в «Требует внимания».
 */
export function effectiveAddress(order: AddressSource): string | null {
  if (contractVersionOf(order) === 'V2') {
    /*
     * У нового контракта запасного пути нет.
     *
     * `address` — операционная строка источника вперемешку с квартирой и
     * домофоном; ради её замены контракт и вводился. Тихий откат к ней
     * означал бы, что проверка нового контракта проверяет неизвестно что,
     * а курьер едет по строке, которую никто не разбирал.
     */
    return normalize(order.localAddress) ?? normalize(order.structuredAddress);
  }
  return normalize(order.localAddress) ?? normalize(order.address);
}

/**
 * Детали адреса для показа человеку.
 *
 * Только у нового контракта: у legacy их не существует, и пустая строка
 * там означала бы «деталей нет», хотя на самом деле они просто не разбирались.
 */
export function addressDetailsOf(order: AddressSource): string | null {
  return contractVersionOf(order) === 'V2' ? normalize(order.addressDetails) : null;
}

/**
 * Строка, которая уходит в геокодер.
 *
 * Отличается от адреса для человека намеренно. Курьеру нужен операционный
 * адрес целиком — с квартирой, подъездом и домофоном. Геокодеру они мешают:
 * он ищет дом, а не квартиру в нём.
 *
 * Порядок тот же: правка логиста сильнее всего — он подтверждал конкретный
 * адрес, и подменять его разобранным нельзя.
 */
/**
 * Источник АВТОМАТИЧЕСКОГО геокодирования.
 *
 * Только правка логиста и разобранный адрес. Старое поле `address` сюда
 * не входит намеренно: по строке произвольного формата геокодер не находит
 * нужный дом, а подбирает похожий — измерено, 2 точных дома из 20 запросов.
 * Показывать `address` человеку по-прежнему нужно, а спрашивать по нему
 * геокодер автоматически — нет.
 *
 * Отдельная функция, а не флаг у `geocodingAddress`: флагом старую цепочку
 * однажды вернут в событийный путь, и заметить это будет нечем. Явная
 * операторская команда исторического прохода пользуется `geocodingAddress`
 * с прежним запасным вариантом — там выбор делает человек.
 */
export function automaticGeocodingAddress(
  order: AddressSource & { geocodeAddress?: string | null },
): string | null {
  if (contractVersionOf(order) === 'V2') {
    return normalize(order.localAddress) ?? normalize(order.structuredAddress);
  }
  return normalize(order.localAddress) ?? normalize(order.geocodeAddress);
}

export function geocodingAddress(order: AddressSource): string | null {
  if (contractVersionOf(order) === 'V2') {
    // Ни `geocodeAddress`, ни `address` у нового контракта в запас не идут:
    // первый собран по прежним правилам (с индексом и регионом), второй —
    // операционная строка. Оба увели бы геокодер от нужного дома.
    return normalize(order.localAddress) ?? normalize(order.structuredAddress);
  }
  return (
    normalize(order.localAddress) ?? normalize(order.geocodeAddress) ?? normalize(order.address)
  );
}

/** Полное состояние адреса для карточки. */
export function addressState(order: AddressSource & { addressConflict: boolean }): AddressState {
  const local = normalize(order.localAddress);
  const contract = contractVersionOf(order);
  return {
    effective: effectiveAddress(order),
    // Исходная строка источника показывается рядом при обоих контрактах:
    // сравнением её с рабочим адресом логист и принимает решение о правке.
    source: normalize(order.address),
    corrected: local !== null,
    conflict: order.addressConflict,
    details: addressDetailsOf(order),
    contract,
  };
}

/**
 * Изменился ли исходный адрес относительно снимка, сделанного при правке.
 *
 * Конфликт — это изменение источника ПОСЛЕ локальной правки, а не любое
 * несовпадение: без снимка «каким источник был на момент правки» первая же
 * синхронизация объявляла бы конфликтом саму правку.
 */
export function isSourceConflict(
  order: {
    localAddress?: string | null;
    sourceAddressAtLocalEdit: string | null;
    addressConflict: boolean;
  },
  nextSourceAddress: string | null,
): boolean {
  if (normalize(order.localAddress) === null) {
    return false;
  }
  if (order.addressConflict) {
    // Уже объявленный конфликт не переоткрывается на каждом проходе.
    return false;
  }
  return normalize(order.sourceAddressAtLocalEdit) !== normalize(nextSourceAddress);
}

/**
 * Колонки, без которых рабочий адрес посчитать нельзя.
 *
 * Общий фрагмент, а не переписанный в каждом модуле список: забытая колонка
 * не даёт ошибки — она молча превращает заказ версии 2 в legacy, и человек
 * видит операционную строку вместо разобранного адреса.
 */
export const ORDER_ADDRESS_SELECT = {
  address: true,
  localAddress: true,
  geocodeAddress: true,
  structuredAddress: true,
  addressDetails: true,
  addressContractVersion: true,
} as const;
