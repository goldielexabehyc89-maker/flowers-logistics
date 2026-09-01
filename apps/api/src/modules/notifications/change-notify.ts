/**
 * Создание уведомления об изменении существующего заказа источником.
 *
 * Вызывается ВНУТРИ той же транзакции импорта, что и применение снимка заказа
 * и состава, и опирается на уже посчитанные диффы: `ApplyResult.changedFields`
 * (адрес/детали/дата/интервал) и `ApplyFulfillmentResult` (состав). Своего
 * механизма сравнения здесь нет — только раскладка существующих diff по
 * категориям и сборка «старое → новое» из уже записанных ревизий.
 *
 * Правила (все обеспечены существующим импортом, здесь лишь используются):
 *  * первый импорт уведомление не создаёт — гейт по исходу `UPDATED`/`CHANGED`;
 *  * идентичный снимок уведомление не создаёт — исход `UNCHANGED`;
 *  * несколько изменённых полей одного снимка → ОДНО уведомление;
 *  * сравнение нормализованное (диффы считаются по нормализованным снимкам);
 *  * изменение только координат при неизменном адресе не создаёт уведомления —
 *    координаты не входят в поля снимка, поэтому в `changedFields` их нет.
 *
 * Наружу (realtime, аудит) значения не уходят: событие несёт только id. Старое
 * и новое значения лежат в `payload` и показываются лишь авторизованному
 * сотруднику через ролевой API.
 */

import type { TransactionClient } from '../auth/sessions.js';
import { publishRealtimeEvent } from '../realtime/events.js';

/** Категория изменения. */
export type ChangeCategory = 'ADDRESS' | 'DETAILS' | 'DATE' | 'INTERVAL' | 'COMPOSITION';

/** Роли, которым адресуются всплывающие уведомления и вкладка. */
export const NOTIFICATION_AUDIENCE = ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'] as const;

const CATEGORY_FIELDS: Record<Exclude<ChangeCategory, 'COMPOSITION'>, readonly string[]> = {
  ADDRESS: ['address', 'structuredAddress'],
  DETAILS: ['addressDetails'],
  DATE: ['deliveryDate', 'deliveryDateRaw'],
  INTERVAL: ['intervalRaw', 'intervalKind', 'intervalStartMinute', 'intervalEndMinute'],
};

const CATEGORY_LABEL: Record<ChangeCategory, string> = {
  ADDRESS: 'Адрес доставки',
  DETAILS: 'Детали адреса',
  DATE: 'Дата доставки',
  INTERVAL: 'Интервал доставки',
  COMPOSITION: 'Состав заказа',
};

interface PositionSnapshot {
  externalPositionId?: string | null;
  name?: string | null;
  quantity?: string | null;
  uomName?: string | null;
  characteristicLabel?: string | null;
  components?: unknown;
}

interface CompositionDiff {
  added: { name: string; quantity: string }[];
  removed: { name: string; quantity: string }[];
  quantityChanged: { name: string; old: string; new: string }[];
  parameterChanged: { name: string }[];
}

export interface RecordChangeInput {
  orderId: string;
  /** Исход применения снимка заказа: уведомляем только об обновлении. */
  orderOutcome: string;
  orderChangedFields: readonly string[];
  /** Исход применения состава: `CHANGED` — состав реально изменился. */
  fulfillmentOutcome: string | null;
}

function snapshotFieldString(snapshot: Record<string, unknown>, key: string): string | null {
  const value = snapshot[key];
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value);
}

/** Рабочий адрес из снимка: структурированный кандидат, иначе операционный. */
function addressOf(snapshot: Record<string, unknown> | null): string | null {
  if (snapshot === null) {
    return null;
  }
  return (
    snapshotFieldString(snapshot, 'structuredAddress') ?? snapshotFieldString(snapshot, 'address')
  );
}

/** Ключ позиции для сопоставления: устойчивый id позиции, иначе имя. */
function positionKey(position: PositionSnapshot): string {
  return (position.externalPositionId ?? position.name ?? '').trim();
}

function positionName(position: PositionSnapshot): string {
  return (position.name ?? '').trim() || '—';
}

/** Существенная характеристика позиции: ярлык характеристики и состав. */
function positionParameter(position: PositionSnapshot): string {
  return JSON.stringify([position.characteristicLabel ?? null, position.components ?? null]);
}

/**
 * Понятный diff состава по нормализованным позициям: добавлено, удалено,
 * изменено количество, изменена существенная характеристика. Перестановка
 * одинаковых строк без изменения состава сюда не попадает — сравнение идёт по
 * ключу позиции, а не по порядку.
 */
export function diffComposition(
  prev: PositionSnapshot[],
  next: PositionSnapshot[],
): CompositionDiff {
  const prevByKey = new Map(prev.map((p) => [positionKey(p), p]));
  const nextByKey = new Map(next.map((p) => [positionKey(p), p]));
  const diff: CompositionDiff = {
    added: [],
    removed: [],
    quantityChanged: [],
    parameterChanged: [],
  };

  for (const [key, position] of nextByKey) {
    const before = prevByKey.get(key);
    if (before === undefined) {
      diff.added.push({ name: positionName(position), quantity: position.quantity ?? '—' });
      continue;
    }
    if ((before.quantity ?? '') !== (position.quantity ?? '')) {
      diff.quantityChanged.push({
        name: positionName(position),
        old: before.quantity ?? '—',
        new: position.quantity ?? '—',
      });
    }
    if (positionParameter(before) !== positionParameter(position)) {
      diff.parameterChanged.push({ name: positionName(position) });
    }
  }
  for (const [key, position] of prevByKey) {
    if (!nextByKey.has(key)) {
      diff.removed.push({ name: positionName(position), quantity: position.quantity ?? '—' });
    }
  }
  return diff;
}

/** Пусты ли изменения состава: если да — уведомления по составу не создаём. */
function compositionUnchanged(diff: CompositionDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.quantityChanged.length === 0 &&
    diff.parameterChanged.length === 0
  );
}

/** Категории изменений из уже посчитанных diff'ов импорта. */
export function categoriesFrom(input: RecordChangeInput): ChangeCategory[] {
  const categories: ChangeCategory[] = [];
  if (input.orderOutcome === 'UPDATED') {
    for (const category of ['ADDRESS', 'DETAILS', 'DATE', 'INTERVAL'] as const) {
      if (input.orderChangedFields.some((field) => CATEGORY_FIELDS[category].includes(field))) {
        categories.push(category);
      }
    }
  }
  if (input.fulfillmentOutcome === 'CHANGED') {
    categories.push('COMPOSITION');
  }
  return categories;
}

/**
 * Создаёт одно уведомление, если что-то из отслеживаемого реально изменилось.
 * Возвращает id созданного уведомления или `null`, если создавать нечего.
 */
export async function recordOrderChangeNotification(
  tx: TransactionClient,
  input: RecordChangeInput,
): Promise<string | null> {
  const categories = categoriesFrom(input);
  if (categories.length === 0) {
    return null;
  }

  // Старое → новое берём из двух последних ревизий (новая только что записана
  // этой же транзакцией). Своего диффа не считаем — используем нормализованные
  // снимки, которые уже сложены импортом.
  const fields: {
    category: ChangeCategory;
    label: string;
    old: string | null;
    new: string | null;
  }[] = [];
  const orderCategories = categories.filter((c) => c !== 'COMPOSITION');
  if (orderCategories.length > 0) {
    const revisions = await tx.deliveryOrderRevision.findMany({
      where: { orderId: input.orderId },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: 2,
      select: { snapshot: true },
    });
    const nextSnap = (revisions[0]?.snapshot ?? null) as Record<string, unknown> | null;
    const prevSnap = (revisions[1]?.snapshot ?? null) as Record<string, unknown> | null;
    for (const category of orderCategories) {
      if (category === 'ADDRESS') {
        fields.push({
          category,
          label: CATEGORY_LABEL.ADDRESS,
          old: addressOf(prevSnap),
          new: addressOf(nextSnap),
        });
      } else {
        const key =
          category === 'DETAILS'
            ? 'addressDetails'
            : category === 'DATE'
              ? 'deliveryDate'
              : 'intervalRaw';
        fields.push({
          category,
          label: CATEGORY_LABEL[category],
          old: prevSnap === null ? null : snapshotFieldString(prevSnap, key),
          new: nextSnap === null ? null : snapshotFieldString(nextSnap, key),
        });
      }
    }
  }

  let composition: CompositionDiff | null = null;
  if (categories.includes('COMPOSITION')) {
    const revisions = await tx.orderFulfillmentRevision.findMany({
      where: { orderId: input.orderId },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: 2,
      select: { snapshot: true },
    });
    const nextSnap = (revisions[0]?.snapshot ?? null) as { positions?: PositionSnapshot[] } | null;
    const prevSnap = (revisions[1]?.snapshot ?? null) as { positions?: PositionSnapshot[] } | null;
    composition = diffComposition(prevSnap?.positions ?? [], nextSnap?.positions ?? []);
    // Перестановка одинаковых строк — не изменение состава: если по ключам
    // ничего не разошлось, убираем категорию и не создаём пустое уведомление.
    if (compositionUnchanged(composition)) {
      composition = null;
      const index = categories.indexOf('COMPOSITION');
      categories.splice(index, 1);
      if (categories.length === 0) {
        return null;
      }
    }
  }

  // Состав изменён у заказа, который уже прошёл сборку (есть печатный бланк) —
  // это уведомление с решением о пересборке, а не простое информирование.
  const assembled =
    composition !== null &&
    (await tx.orderPrintForm.count({ where: { orderId: input.orderId } })) > 0;
  const kind = assembled ? 'COMPOSITION_AFTER_ASSEMBLY' : 'INFO';

  const created = await tx.orderChangeNotification.create({
    data: {
      orderId: input.orderId,
      source: 'MOYSKLAD_SYNC',
      categories,
      kind,
      payload: { fields, composition } as unknown as object,
    },
    select: { id: true },
  });

  // В событие уходит только id: ни адреса, ни состава наружу.
  await publishRealtimeEvent(tx, {
    topic: 'notification.created',
    audienceRoles: [...NOTIFICATION_AUDIENCE],
    payload: { notificationId: created.id, orderId: input.orderId, kind },
  });

  return created.id;
}
