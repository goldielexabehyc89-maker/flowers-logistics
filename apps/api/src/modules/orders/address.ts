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
  return normalize(order.localAddress) ?? normalize(order.address);
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
  return normalize(order.localAddress) ?? normalize(order.geocodeAddress);
}

export function geocodingAddress(order: AddressSource): string | null {
  return (
    normalize(order.localAddress) ?? normalize(order.geocodeAddress) ?? normalize(order.address)
  );
}

/** Полное состояние адреса для карточки. */
export function addressState(order: AddressSource & { addressConflict: boolean }): AddressState {
  const local = normalize(order.localAddress);
  return {
    effective: local ?? normalize(order.address),
    source: normalize(order.address),
    corrected: local !== null,
    conflict: order.addressConflict,
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
