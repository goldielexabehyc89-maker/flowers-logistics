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
  | 'CASH_OVERPAYMENT';

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

/** Порядок ключей снимка. Фиксирован, чтобы хеш не зависел от порядка полей API. */
const SNAPSHOT_KEYS: (keyof OrderSnapshot)[] = [
  'externalId',
  'externalName',
  'externalUpdated',
  'externalMoment',
  'externalStateId',
  'externalStateName',
  'externalStateType',
  'storeId',
  'deliveryMethodId',
  'deliveryDateRaw',
  'deliveryDate',
  'intervalRaw',
  'intervalKind',
  'intervalStartMinute',
  'intervalEndMinute',
  'address',
  'recipient',
  'comment',
  'paymentTypeId',
  'paymentTypeName',
  'sumMinor',
  'payedSumMinor',
  'cashCollectable',
  'cashToCollectMinor',
  'cashAnomaly',
  'sourceArchived',
  'inScope',
  'fulfillmentInScope',
  'scopeExitReason',
  'attentionReasons',
];

type Ids = typeof MOYSKLAD_IDS;

/** Пустая строка и пробелы — то же самое, что отсутствие значения. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

interface AttributeValue {
  id: string | null;
  name: string | null;
  text: string | null;
}

/** Достаёт атрибут по UUID: и скалярное значение, и ссылку на элемент справочника. */
function attribute(order: MoyskladOrderDto, attributeId: string): AttributeValue {
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
export function mapOrder(order: MoyskladOrderDto, ids: Ids): MapOrderResult {
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
  const address = text(order.shipmentAddress);
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

  snapshot.attentionReasons = attentionReasonsFor(snapshot);
  return { snapshot, interval, deliveryDate };
}

/**
 * Причины «Требует внимания» — детерминированная функция снимка.
 * Внешний статус в них не участвует: он ничего не решает.
 */
export function attentionReasonsFor(snapshot: OrderSnapshot): AttentionReason[] {
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
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      changed.push(key);
    }
  }
  return changed;
}
