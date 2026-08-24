/**
 * Преобразование заказа МоегоСклада в наш канонический снимок.
 *
 * Здесь нет ни одного решения о бизнес-состоянии: внешний статус сохраняется,
 * но не превращается во внутренний, и ни отмена, ни доставка, ни готовность
 * из него не выводятся. Единственное решение mapper'а — относится ли заказ
 * к нашей области, и оно принимается по двум UUID.
 *
 * Снимок канонический: порядок ключей фиксирован, поэтому одинаковые данные
 * дают одинаковый хеш и не создают ложных изменений.
 */

import { createHash } from 'node:crypto';
import { idFromHref, type MoyskladOrderDto } from './dto.js';
import { parseDeliveryDate, type ParsedDeliveryDate } from './delivery-date.js';
import { parseDeliveryInterval, type ParsedInterval } from './interval.js';
import { cashToCollect, isOverpaid, toMinorUnits } from './money.js';
import type { MOYSKLAD_IDS } from './config.js';

export type AttentionReason =
  | 'MISSING_DELIVERY_DATE'
  | 'UNRECOGNIZED_DELIVERY_DATE'
  | 'MISSING_INTERVAL'
  | 'UNRECOGNIZED_INTERVAL'
  | 'MISSING_ADDRESS'
  | 'MISSING_RECIPIENT'
  | 'CASH_OVERPAYMENT'
  | 'GEOCODING_ADDRESS_INCOMPLETE';

export type ScopeExitReason = 'STORE_CHANGED' | 'DELIVERY_METHOD_CHANGED' | 'SOURCE_ARCHIVED';

/**
 * Канонический снимок: только подтверждённые импортируемые поля.
 * Сырой ответ API не сохраняется ни здесь, ни в базе.
 */
export interface OrderSnapshot {
  externalId: string;
  externalName: string;
  externalUpdated: string;
  externalMoment: string | null;
  externalStateId: string | null;
  externalStateName: string | null;
  externalStateType: string | null;
  storeId: string | null;
  deliveryMethodId: string | null;
  deliveryDateRaw: string | null;
  /** Календарная дата Москвы `YYYY-MM-DD`; из неё пишется колонка типа DATE. */
  deliveryDate: string | null;
  intervalRaw: string | null;
  intervalKind: ParsedInterval['kind'];
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
  address: string | null;
  /** Запрос к геокодеру. Пусто — отдельного запроса нет, берётся `address`. */
  geocodeAddress: string | null;
  /**
   * Кандидат рабочего адреса нового контракта: город, улица, дом.
   *
   * Именно кандидат: пользуется им только заказ версии 2, а решение о версии
   * принимает импорт, а не источник. Legacy-заказ это поле игнорирует.
   */
  structuredAddress: string | null;
  /** Кандидат деталей адреса: регион, квартира, «Другое». */
  addressDetails: string | null;
  recipient: string | null;
  comment: string | null;
  paymentTypeId: string | null;
  paymentTypeName: string | null;
  /** Строкой: снимок сериализуется в JSON, где bigint недопустим. */
  sumMinor: string;
  payedSumMinor: string;
  cashCollectable: boolean;
  cashToCollectMinor: string;
  cashAnomaly: boolean;
  sourceArchived: boolean;
  /** Логистическая область: склад + «Доставка» + не архивирован. Смысл прежний. */
  inScope: boolean;
  /**
   * Производственная область: склад + не архивирован, способ получения не важен.
   *
   * Строго шире логистической: `inScope` истинно только вместе с этим полем.
   * Самовывоз, другой способ и незаполненный способ сюда входят.
   */
  fulfillmentInScope: boolean;
  /**
   * Причина выхода из ЛОГИСТИЧЕСКОЙ области. Смысл поля не расширяется:
   * `DELIVERY_METHOD_CHANGED` по-прежнему означает «больше не доставка»,
   * а не производственный статус.
   */
  scopeExitReason: ScopeExitReason | null;
  attentionReasons: AttentionReason[];
}

/**
 * Поля снимка и их порядок.
 *
 * Объект, а не массив, намеренно. `satisfies Record<keyof OrderSnapshot, true>`
 * требует ключ для КАЖДОГО поля снимка, поэтому новое поле нельзя забыть:
 * без него код не соберётся.
 *
 * Забыть было чем: через этот список работают сразу три вещи — сравнение
 * снимков, канонический JSON и хеш. Поле, добавленное в тип и в объект, но
 * не сюда, оказывалось невидимым для всех троих: изменение не попадало
 * в `changedFields`, хеш не менялся, и строка заказа не переписывалась
 * никогда. Ошибка молчаливая — данные просто оставались пустыми.
 *
 * Порядок ключей фиксирован: по нему считается канонический JSON, и от него
 * зависит хеш. `Object.keys` сохраняет порядок объявления строковых ключей,
 * поэтому перестановка полей здесь изменила бы хеш у всех заказов.
 */
const SNAPSHOT_FIELDS = {
  externalId: true,
  externalName: true,
  externalUpdated: true,
  externalMoment: true,
  externalStateId: true,
  externalStateName: true,
  externalStateType: true,
  storeId: true,
  deliveryMethodId: true,
  deliveryDateRaw: true,
  deliveryDate: true,
  intervalRaw: true,
  intervalKind: true,
  intervalStartMinute: true,
  intervalEndMinute: true,
  address: true,
  geocodeAddress: true,
  structuredAddress: true,
  addressDetails: true,
  recipient: true,
  comment: true,
  paymentTypeId: true,
  paymentTypeName: true,
  sumMinor: true,
  payedSumMinor: true,
  cashCollectable: true,
  cashToCollectMinor: true,
  cashAnomaly: true,
  sourceArchived: true,
  inScope: true,
  fulfillmentInScope: true,
  scopeExitReason: true,
  attentionReasons: true,
} satisfies Record<keyof OrderSnapshot, true>;

export const SNAPSHOT_KEYS = Object.keys(SNAPSHOT_FIELDS) as (keyof OrderSnapshot)[];

type Ids = typeof MOYSKLAD_IDS;

/** Пустая строка и пробелы — то же самое, что отсутствие значения. */
export function text(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export interface AttributeValue {
  id: string | null;
  name: string | null;
  text: string | null;
}

/**
 * Достаёт атрибут по UUID: и скалярное значение, и ссылку на элемент справочника.
 *
 * Экспортируется, чтобы производственный снимок читал атрибуты тем же кодом.
 * Вторая реализация того же разбора однажды разошлась бы с этой — и разошлась бы
 * молча, дав двум областям разное значение одного и того же поля.
 */
export function attribute(order: MoyskladOrderDto, attributeId: string): AttributeValue {
  const found = (order.attributes ?? []).find((item) => item.id === attributeId);
  if (found === undefined) {
    return { id: null, name: null, text: null };
  }

  const value = found.value;
  if (value !== null && typeof value === 'object') {
    const record = value as { name?: unknown; meta?: { href?: string } };
    return {
      id: idFromHref(record.meta?.href),
      name: text(record.name),
      text: text(record.name),
    };
  }

  return { id: null, name: null, text: text(value) };
}

export interface MapOrderResult {
  snapshot: OrderSnapshot;
  interval: ParsedInterval;
  deliveryDate: ParsedDeliveryDate;
}

/**
 * Строит снимок заказа.
 *
 * Адрес берётся только из `shipmentAddress`, получатель — только из «Получатель»,
 * комментарий — только из «Комментарий по доставке», интервал — только из
 * «Время доставки». Резервных источников нет: подстановка «похожего» поля
 * молча подменила бы ошибку заполнения правдоподобной догадкой.
 */
/**
 * Собирает адрес из разобранных частей МоегоСклада.
 *
 * В строку входят ТОЛЬКО те части, которые ищет геокодер: индекс, страна,
 * регион, город, улица и дом. Квартира, подъезд, этаж и комментарии
 * не входят намеренно — геокодер ищет дом, а не квартиру в нём, и лишние
 * слова только уводят поиск.
 *
 * Без улицы или дома адреса нет. Возвращается `null`, и заказ уходит к человеку:
 * подставлять вместо этого строку `shipmentAddress` нельзя — ради её замены
 * источник и включали, а тихий откат к ней превратил бы проверку источника
 * в проверку неизвестно чего.
 */
export function composeStructuredAddress(
  full: MoyskladOrderDto['shipmentAddressFull'],
): string | null {
  if (full === undefined || full === null) {
    return null;
  }

  const street = text(full.street);
  const house = text(full.house);
  if (street === null || house === null) {
    return null;
  }

  const name = (value: unknown): string | null =>
    typeof value === 'object' && value !== null && 'name' in value
      ? text((value as { name?: unknown }).name)
      : null;

  const parts = [
    text(full.postalCode),
    name(full.country),
    name(full.region),
    text(full.city),
    street,
    house,
  ].filter((part): part is string => part !== null);

  return parts.length === 0 ? null : parts.join(', ');
}

/**
 * Названия регионов по ссылке на справочник.
 *
 * МойСклад отдаёт регион ССЫЛКОЙ без названия — проверено на живой выборке:
 * из двадцати четырёх заказов с заполненным регионом название не пришло
 * ни разу, только `meta.href`. Название достаётся отдельным чтением
 * справочника, поэтому оно передаётся в маппер уже готовым: маппер остаётся
 * чистой функцией и в сеть не ходит.
 *
 * Неизвестная ссылка означает «названия нет»: регион просто не показывается.
 * Придумывать его по идентификатору нельзя.
 */
export type RegionNames = ReadonlyMap<string, string>;

/**
 * РАБОЧИЙ адрес нового контракта: город, улица, дом — и ничего больше.
 *
 * Индекс, страна и регион не входят: они не уточняют дом, а сбивают геокодер
 * на соседний населённый пункт с той же улицей. Квартира и «Другое» не входят
 * тем более — геокодер ищет дом, а не квартиру в нём.
 *
 * Без города, улицы или дома адреса нет: возвращается `null`, и заказ уходит
 * к человеку. Подставлять вместо этого `shipmentAddress` запрещено — ради его
 * замены контракт и вводился, а тихий откат превратил бы проверку нового
 * контракта в проверку неизвестно чего.
 */
export function composeWorkingAddress(
  full: MoyskladOrderDto['shipmentAddressFull'],
): string | null {
  if (full === undefined || full === null) {
    return null;
  }
  const city = text(full.city);
  const street = text(full.street);
  const house = text(full.house);
  if (city === null || street === null || house === null) {
    return null;
  }
  return [city, street, house].join(', ');
}

/**
 * ДЕТАЛИ адреса: то, что нужно человеку и мешает машине.
 *
 * Регион, квартира или офис и «Другое». Подписи ставятся только у непустых
 * частей: строка «Регион:  · Кв./офис: 55» заставляла бы гадать, потеряно
 * значение или его не было.
 *
 * Поле источника `comment` сюда НЕ входит: в интерфейсе МоегоСклада «Другое» —
 * это `addInfo`, а `comment` — отдельное поле адреса, и склеивать их значило
 * бы приписать человеку слова, которых он не писал.
 *
 * Индекс и страна пока не показываются — решение владельца.
 */
export function composeAddressDetails(
  full: MoyskladOrderDto['shipmentAddressFull'],
  regions: RegionNames = new Map(),
): string | null {
  if (full === undefined || full === null) {
    return null;
  }

  const regionHref =
    typeof full.region === 'object' && full.region !== null
      ? text((full.region as { meta?: { href?: unknown } }).meta?.href)
      : null;
  const regionName = regionHref === null ? null : (text(regions.get(regionHref)) ?? null);

  const parts = [
    regionName === null ? null : `Регион: ${regionName}`,
    text(full.apartment) === null ? null : `Кв./офис: ${text(full.apartment) ?? ''}`,
    text(full.addInfo) === null ? null : `Другое: ${text(full.addInfo) ?? ''}`,
  ].filter((part): part is string => part !== null);

  return parts.length === 0 ? null : parts.join(' · ');
}

/** Откуда собирать запрос к геокодеру. Адрес заказа этим не управляется. */
export type AddressSource = 'shipmentAddress' | 'shipmentAddressFull';

export function mapOrder(
  order: MoyskladOrderDto,
  ids: Ids,
  addressSource: AddressSource = 'shipmentAddress',
  regions: RegionNames = new Map(),
): MapOrderResult {
  const storeId = idFromHref(order.store?.meta.href);
  const deliveryMethod = attribute(order, ids.deliveryMethodAttribute);
  const paymentType = attribute(order, ids.paymentTypeAttribute);
  const intervalAttribute = attribute(order, ids.intervalAttribute);
  const interval = parseDeliveryInterval(intervalAttribute.text);

  const sumMinor = toMinorUnits(order.sum);
  const payedSumMinor = toMinorUnits(order.payedSum);

  // Наличные существуют ТОЛЬКО при точном типе оплаты «Наличные/карта на ТТ».
  // При любом другом типе денег у курьера нет, поэтому нет ни суммы к получению,
  // ни денежной аномалии: онлайн-переплата к долгу курьера отношения не имеет.
  const cashCollectable = paymentType.id === ids.paymentTypeCash;
  const cashToCollectMinor = cashCollectable ? cashToCollect(sumMinor, payedSumMinor) : 0n;
  const cashAnomaly = cashCollectable && isOverpaid(sumMinor, payedSumMinor);

  const sourceArchived = order.archived === true;
  const storeMatches = storeId === ids.store;
  const methodMatches = deliveryMethod.id === ids.deliveryMethodDelivery;
  const inScope = storeMatches && methodMatches && !sourceArchived;
  // Производство не зависит от способа получения: букет собирают одинаково
  // и для доставки, и для самовывоза. Отсюда вторая, более широкая область
  // над тем же самым заказом — второго заказа и второй строки не появляется.
  const fulfillmentInScope = storeMatches && !sourceArchived;

  // Причина выхода называется по первому несовпавшему условию: она объясняет
  // логисту, что именно изменилось, а не просто «заказ пропал».
  let scopeExitReason: ScopeExitReason | null = null;
  if (!inScope) {
    if (!storeMatches) {
      scopeExitReason = 'STORE_CHANGED';
    } else if (!methodMatches) {
      scopeExitReason = 'DELIVERY_METHOD_CHANGED';
    } else {
      scopeExitReason = 'SOURCE_ARCHIVED';
    }
  }

  const deliveryDate = parseDeliveryDate(order.deliveryPlannedMoment);
  // Адрес заказа — операционный: его читают логист и курьер, и квартира,
  // подъезд и домофон в нём обязаны остаться. Он не зависит от источника
  // запроса к геокодеру.
  const address = text(order.shipmentAddress);

  // Запрос к геокодеру — отдельное значение. Пусто означает «отдельного
  // запроса нет»: геокодер возьмёт адрес заказа, как и раньше.
  const geocodeAddress =
    addressSource === 'shipmentAddressFull'
      ? composeStructuredAddress(order.shipmentAddressFull)
      : null;

  /*
   * Кандидаты нового контракта собираются ВСЕГДА.
   *
   * Разбор ответа ничего не стоит и ни на что не влияет сам по себе: решение,
   * жить ли заказу по новому контракту, принимает импорт при создании строки.
   * Собирать их «только когда включён выключатель» значило бы завести второй
   * источник правды о том, что пришло из МоегоСклада.
   */
  const structuredAddress = composeWorkingAddress(order.shipmentAddressFull);
  const addressDetails = composeAddressDetails(order.shipmentAddressFull, regions);
  const recipient = attribute(order, ids.recipientAttribute).text;
  const comment = attribute(order, ids.commentAttribute).text;

  const snapshot: OrderSnapshot = {
    externalId: order.id,
    externalName: order.name,
    externalUpdated: order.updated,
    externalMoment: text(order.moment),
    externalStateId: order.state?.id ?? idFromHref(order.state?.meta.href),
    externalStateName: text(order.state?.name),
    externalStateType: text(order.state?.stateType),
    storeId,
    deliveryMethodId: deliveryMethod.id,
    deliveryDateRaw: deliveryDate.raw,
    deliveryDate: deliveryDate.date,
    intervalRaw: interval.raw,
    intervalKind: interval.kind,
    intervalStartMinute: interval.startMinute,
    intervalEndMinute: interval.endMinute,
    address,
    geocodeAddress,
    structuredAddress,
    addressDetails,
    recipient,
    comment,
    paymentTypeId: paymentType.id,
    paymentTypeName: paymentType.name,
    sumMinor: sumMinor.toString(),
    payedSumMinor: payedSumMinor.toString(),
    cashCollectable,
    cashToCollectMinor: cashToCollectMinor.toString(),
    cashAnomaly,
    sourceArchived,
    inScope,
    fulfillmentInScope,
    scopeExitReason,
    attentionReasons: [],
  };

  snapshot.attentionReasons = attentionReasonsFor(snapshot, addressSource);
  return { snapshot, interval, deliveryDate };
}

/**
 * Причины «Требует внимания» — детерминированная функция снимка.
 * Внешний статус в них не участвует: он ничего не решает.
 */
export function attentionReasonsFor(
  snapshot: OrderSnapshot,
  addressSource: AddressSource = 'shipmentAddress',
): AttentionReason[] {
  const reasons: AttentionReason[] = [];

  if (snapshot.deliveryDateRaw === null) {
    reasons.push('MISSING_DELIVERY_DATE');
  } else if (snapshot.deliveryDate === null) {
    // Значение есть, но разобрать его не удалось: считать такой заказ нормальным
    // нельзя — без даты он не попадёт ни в один маршрут.
    reasons.push('UNRECOGNIZED_DELIVERY_DATE');
  }
  if (snapshot.intervalKind === 'MISSING') {
    reasons.push('MISSING_INTERVAL');
  }
  if (snapshot.intervalKind === 'UNRECOGNIZED') {
    reasons.push('UNRECOGNIZED_INTERVAL');
  }
  if (snapshot.address === null) {
    reasons.push('MISSING_ADDRESS');
  } else if (addressSource === 'shipmentAddressFull' && snapshot.geocodeAddress === null) {
    // Адрес есть, но геокодеру его мало: улицы или дома в разобранных данных
    // источника не оказалось. Второй причины к «адреса нет» здесь быть не может
    // — состояния взаимоисключающие, и дублировать их значило бы запутать.
    //
    // Причина осмысленна ТОЛЬКО когда разобранный источник включён. При
    // источнике по умолчанию `geocodeAddress` пуст у всех заказов просто
    // потому, что его никто не собирал, и причина оказалась бы у каждого —
    // то есть не значила бы ничего.
    //
    // Ручная правка это состояние снимает, но о ней снимок не знает: её
    // учитывает `effectiveAttentionReasons`.
    reasons.push('GEOCODING_ADDRESS_INCOMPLETE');
  }
  if (snapshot.recipient === null) {
    reasons.push('MISSING_RECIPIENT');
  }
  if (snapshot.cashAnomaly) {
    reasons.push('CASH_OVERPAYMENT');
  }

  return reasons;
}

/** Канонический JSON: ключи в фиксированном порядке, массивы — как есть. */
export function canonicalJson(snapshot: OrderSnapshot): string {
  const ordered: Record<string, unknown> = {};
  for (const key of SNAPSHOT_KEYS) {
    ordered[key] = snapshot[key];
  }
  return JSON.stringify(ordered);
}

export function snapshotHash(snapshot: OrderSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

/**
 * Поля, изменившиеся между версиями снимка.
 * Порядок ключей во входном объекте на результат не влияет.
 */
export function diffSnapshots(
  previous: OrderSnapshot | null,
  next: OrderSnapshot,
): (keyof OrderSnapshot)[] {
  if (previous === null) {
    return [...SNAPSHOT_KEYS];
  }

  const changed: (keyof OrderSnapshot)[] = [];
  for (const key of SNAPSHOT_KEYS) {
    // Отсутствие ключа и `null` — одно и то же: «значения нет».
    //
    // Снимки, сохранённые до появления поля, ключа не содержат вовсе.
    // Без приведения `undefined` и `null` разошлись бы, и первый же проход
    // объявил бы изменившимся КАЖДЫЙ заказ — включая те, у которых нового
    // значения нет и не будет. Это дало бы ревизию, аудит и событие на ровном
    // месте, а история перестала бы означать «здесь что-то произошло».
    if (JSON.stringify(previous[key] ?? null) !== JSON.stringify(next[key] ?? null)) {
      changed.push(key);
    }
  }
  return changed;
}
