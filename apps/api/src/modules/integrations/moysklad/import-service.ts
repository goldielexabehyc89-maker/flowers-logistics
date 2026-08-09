/**
 * Применение одной карточки МоегоСклада к нашей базе.
 *
 * Всё выполняется в ОДНОЙ транзакции: карточка, ревизия, аудит и realtime-событие.
 * Иначе возможны состояния «заказ обновлён, следа нет» и «событие ушло, данных нет».
 *
 * Порядок блокировок единый во всём модуле:
 *   1) глобальный advisory-lock прохода синхронизации (берётся снаружи, в sync.ts);
 *   2) строка `DeliveryOrder` через `SELECT … FOR UPDATE` по `externalId`;
 *   3) вставки в `DeliveryOrderRevision`, `AuditLog`, `RealtimeEvent`.
 * Обратного порядка нет нигде, поэтому взаимной блокировки между проходами не возникает.
 *
 * PII не покидает таблицу заказа и его ревизии: ни аудит, ни realtime не получают
 * адрес, получателя, комментарий, номер заказа и суммы.
 */

import type { $Enums, Prisma } from '../../../generated/prisma/client.js';
import type { TransactionClient } from '../../auth/sessions.js';
import { writeAudit, type AuditAction } from '../../audit/service.js';
import { publishRealtimeEvent } from '../../realtime/events.js';
import { toDateColumn } from './delivery-date.js';
import { parseMoscow } from './moscow-time.js';
import { diffSnapshots, snapshotHash, type OrderSnapshot } from './mapper.js';
import {
  effectiveAttentionReasons,
  type AttentionReason,
  type ManualInterval,
} from '../../orders/attention.js';
import { recordOrderConflicts } from '../../routing/conflicts.js';
import { invalidateGeoOnAddressChange } from '../../orders/geo.js';
import { enqueueGeocoding } from '../../orders/geocoding/queue.js';

/** События заказов видят только эти роли. Курьеру глобальный поток заказов не нужен. */
const ORDER_AUDIENCE = ['ADMIN', 'LOGISTICIAN'] as const;

export type ApplyOutcome =
  'CREATED' | 'UPDATED' | 'UNCHANGED' | 'SCOPE_ENTERED' | 'SCOPE_EXITED' | 'SKIPPED_OUT_OF_SCOPE';

export interface ApplyResult {
  outcome: ApplyOutcome;
  changedFields: string[];
}

export interface ApplyOptions {
  /**
   * Ставить ли адрес в очередь геокодирования.
   *
   * По умолчанию — нет. Очередь имеет смысл только там, где её кто-то
   * обрабатывает: в local, CI и staging worker не существует, и заказ,
   * навсегда застрявший в состоянии «Определяется», врал бы логисту о том,
   * что точка вот-вот появится. Заказы, импортированные до включения
   * геокодирования, попадают в очередь разовым наполнением (`backfillGeocoding`).
   */
  geocoding?: boolean;
}

interface StoredOrder {
  id: string;
  version: number;
  inScope: boolean;
  sourceMissing: boolean;
  /// Геоданные: смена адреса обесценивает прежнюю точку.
  geoState: $Enums.OrderGeoState;
  geoSource: $Enums.OrderGeoSource | null;
  geoLatMicro: number | null;
  geoLonMicro: number | null;
  /// Поколение адреса: постановка новой версии в очередь увеличивает его.
  geoGeneration: number;
  /// Ручной интервал логиста: синхронизация обязана его учитывать и не затирать.
  manualIntervalStartMinute: number | null;
  manualIntervalEndMinute: number | null;
}

/**
 * Применяет снимок заказа.
 *
 * Заказ, который никогда к нам не относился, не создаётся вовсе: хранить чужие
 * персональные данные «на всякий случай» нельзя. Уже импортированный заказ
 * сохраняется всегда — даже выйдя из области.
 */
export async function applyOrderSnapshot(
  tx: TransactionClient,
  snapshot: OrderSnapshot,
  now: Date,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const existing = await lockByExternalId(tx, snapshot.externalId);

  if (existing === null) {
    if (!snapshot.inScope) {
      // Пункт Б задания: чужой заказ не попадает в базу ни одним полем.
      return { outcome: 'SKIPPED_OUT_OF_SCOPE', changedFields: [] };
    }
    return createOrder(tx, snapshot, now, options);
  }

  return updateOrder(tx, existing, snapshot, now, options);
}

/**
 * Блокирует строку заказа по внешнему идентификатору.
 * Без `FOR UPDATE` два прохода могли бы одновременно прочитать одну версию
 * и создать две ревизии одного изменения.
 */
async function lockByExternalId(
  tx: TransactionClient,
  externalId: string,
): Promise<StoredOrder | null> {
  const rows = await tx.$queryRaw<StoredOrder[]>`
    SELECT "id", "version", "inScope", "sourceMissing",
           "manualIntervalStartMinute", "manualIntervalEndMinute",
           "geoState", "geoSource", "geoLatMicro", "geoLonMicro", "geoGeneration"
    FROM "DeliveryOrder"
    WHERE "externalId" = ${externalId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Поля карточки из снимка.
 *
 * Сам ручной интервал сюда не входит намеренно — синхронизация его не трогает.
 * Но на расчёт «Требует внимания» он влияет: иначе следующий же проход вернул бы
 * причину, которую логист уже закрыл руками.
 */
function orderData(
  snapshot: OrderSnapshot,
  now: Date,
  manual: ManualInterval | null,
): Prisma.DeliveryOrderUncheckedUpdateInput {
  const reasons = effectiveAttentionReasons(snapshot.attentionReasons, manual);

  return {
    externalName: snapshot.externalName,
    externalUpdated: parseMoscow(snapshot.externalUpdated),
    externalMoment: snapshot.externalMoment === null ? null : parseMoscow(snapshot.externalMoment),
    externalStateId: snapshot.externalStateId,
    externalStateName: snapshot.externalStateName,
    externalStateType: snapshot.externalStateType,
    storeId: snapshot.storeId,
    deliveryMethodId: snapshot.deliveryMethodId,
    deliveryDate: snapshot.deliveryDate === null ? null : toDateColumn(snapshot.deliveryDate),
    deliveryDateRaw: snapshot.deliveryDateRaw,
    intervalRaw: snapshot.intervalRaw,
    intervalKind: snapshot.intervalKind,
    intervalStartMinute: snapshot.intervalStartMinute,
    intervalEndMinute: snapshot.intervalEndMinute,
    address: snapshot.address,
    recipient: snapshot.recipient,
    comment: snapshot.comment,
    paymentTypeId: snapshot.paymentTypeId,
    paymentTypeName: snapshot.paymentTypeName,
    sumMinor: BigInt(snapshot.sumMinor),
    payedSumMinor: BigInt(snapshot.payedSumMinor),
    cashCollectable: snapshot.cashCollectable,
    cashToCollectMinor: BigInt(snapshot.cashToCollectMinor),
    cashAnomaly: snapshot.cashAnomaly,
    sourceArchived: snapshot.sourceArchived,
    inScope: snapshot.inScope,
    needsAttention: reasons.length > 0,
    attentionReasons: reasons,
    scopeExitReason: snapshot.inScope ? null : snapshot.scopeExitReason,
    scopeExitedAt: snapshot.inScope ? null : now,
    // Возвращение в область снимает признак отсутствия источника.
    sourceMissing: false,
    updatedAt: now,
  };
}

async function createOrder(
  tx: TransactionClient,
  snapshot: OrderSnapshot,
  now: Date,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const created = await tx.deliveryOrder.create({
    data: {
      // Новый заказ ручного интервала иметь не может: он появляется только руками.
      ...(orderData(snapshot, now, null) as Prisma.DeliveryOrderUncheckedCreateInput),
      // Ключ идемпотентности и версия задаются после общих полей: они не входят
      // в набор, который переиспользуется при обновлении.
      externalId: snapshot.externalId,
      version: 1,
    },
    select: { id: true },
  });

  // Адрес нового заказа сразу отправляется на разрешение — в той же транзакции.
  // Отдельная постановка «потом» дала бы состояние «заказ есть, задания нет»,
  // и такой заказ навсегда остался бы без точки.
  if (options.geocoding === true) {
    await enqueueGeocoding(
      tx,
      {
        id: created.id,
        address: snapshot.address,
        inScope: snapshot.inScope,
        sourceArchived: snapshot.sourceArchived,
        sourceMissing: false,
        geoState: 'UNRESOLVED',
        geoSource: null,
        geoGeneration: 0,
      },
      now,
    );
  }

  const changedFields = diffSnapshots(null, snapshot);
  await writeRevision(tx, created.id, snapshot, changedFields, 'INITIAL_IMPORT');
  await writeOrderAudit(tx, 'ORDER_IMPORTED', created.id, snapshot, changedFields, 1, [
    ...snapshot.attentionReasons,
  ]);
  await publishOrderEvent(tx, 'order.created', created.id, snapshot, [
    ...snapshot.attentionReasons,
  ]);

  return { outcome: 'CREATED', changedFields };
}

async function updateOrder(
  tx: TransactionClient,
  existing: StoredOrder,
  snapshot: OrderSnapshot,
  now: Date,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const previous = await previousSnapshot(tx, existing.id);
  const changedFields = diffSnapshots(previous, snapshot);

  // Заказ, найденный снова после контрольной сверки, обязан вернуться в работу
  // даже если внешний снимок не изменился ни одним полем: пропал он не из-за
  // изменения данных, а из-за отсутствия в выборке.
  const restoring = existing.sourceMissing && snapshot.inScope;

  if (changedFields.length === 0 && !restoring) {
    // Та же версия пришла повторно в overlap-окне: ни ревизии, ни аудита,
    // ни события. Иначе перекрытие порождало бы поток пустых уведомлений.
    return { outcome: 'UNCHANGED', changedFields: [] };
  }

  // Заказ, который был и остаётся вне нашей области. Обновляются только
  // технические поля, нужные для определения области: полная ревизия сохранила бы
  // адрес, получателя и суммы чужого склада, а хранить их мы не имеем оснований.
  if (!snapshot.inScope && !existing.inScope) {
    await tx.deliveryOrder.update({
      where: { id: existing.id },
      data: scopeOnlyData(snapshot, now),
    });
    return { outcome: 'SKIPPED_OUT_OF_SCOPE', changedFields: [] };
  }

  const enteredScope = snapshot.inScope && (!existing.inScope || existing.sourceMissing);
  const exitedScope = !snapshot.inScope && existing.inScope;
  // Аудит и событие показывают то же, что увидит логист в карточке, а не сырой
  // набор причин из снимка: иначе уведомление противоречило бы экрану.
  const manual: ManualInterval = {
    startMinute: existing.manualIntervalStartMinute,
    endMinute: existing.manualIntervalEndMinute,
  };
  const reasons = effectiveAttentionReasons(snapshot.attentionReasons, manual);

  await tx.deliveryOrder.update({
    where: { id: existing.id },
    data: { ...orderData(snapshot, now, manual), version: existing.version + 1 },
  });

  const reason = restoring
    ? 'SOURCE_RESTORED'
    : enteredScope
      ? 'SCOPE_ENTERED'
      : exitedScope
        ? 'SCOPE_EXITED'
        : 'EXTERNAL_UPDATE';
  await writeRevision(tx, existing.id, snapshot, changedFields, reason);

  const action: AuditAction = restoring
    ? 'ORDER_SOURCE_RESTORED'
    : enteredScope
      ? 'ORDER_SCOPE_ENTERED'
      : exitedScope
        ? 'ORDER_SCOPE_EXITED'
        : 'ORDER_SYNCED';
  await writeOrderAudit(
    tx,
    action,
    existing.id,
    snapshot,
    changedFields,
    existing.version + 1,
    reasons,
  );

  await publishOrderEvent(
    tx,
    restoring || enteredScope || exitedScope ? 'order.scope_changed' : 'order.updated',
    existing.id,
    snapshot,
    reasons,
  );

  // Адрес изменился — прежняя точка больше не относится к этому заказу.
  // Оставить её пригодной опаснее, чем потерять: координата от старого адреса
  // выглядит как нормальные данные и молча отправит курьера не туда.
  if (changedFields.includes('address')) {
    const invalidated = await invalidateGeoOnAddressChange(tx, existing.id, {
      geoState: existing.geoState,
      latMicro: existing.geoLatMicro,
      lonMicro: existing.geoLonMicro,
    });

    // Новый адрес отправляется на разрешение заново. Прежняя точка к нему
    // не относится — в том числе поставленная человеком: он подтверждал другой
    // адрес. Поколение растёт, поэтому ответ по старому адресу, если он ещё
    // летит от провайдера, будет распознан как устаревший и отброшен.
    if (options.geocoding === true) {
      await enqueueGeocoding(
        tx,
        {
          id: existing.id,
          address: snapshot.address,
          inScope: snapshot.inScope,
          sourceArchived: snapshot.sourceArchived,
          sourceMissing: false,
          geoState: invalidated ? 'NEEDS_REVIEW' : existing.geoState,
          geoSource: invalidated ? null : existing.geoSource,
          geoGeneration: existing.geoGeneration,
        },
        now,
      );
    }
  }

  // Заказ мог уже лежать в маршруте. Из маршрута он НЕ удаляется: участие и история
  // сохраняются, а расхождение становится видимым конфликтом. Блокировка маршрута
  // здесь не берётся — порядок импорта начинается с заказа (см. routing/conflicts.ts).
  await recordOrderConflicts(tx, existing.id, {
    deliveryDate: snapshot.deliveryDate === null ? null : toDateColumn(snapshot.deliveryDate),
    inScope: snapshot.inScope,
    sourceArchived: snapshot.sourceArchived,
    sourceMissing: false,
  });

  return {
    outcome: enteredScope ? 'SCOPE_ENTERED' : exitedScope ? 'SCOPE_EXITED' : 'UPDATED',
    changedFields,
  };
}

/** Минимальные технические поля для заказа, остающегося вне нашей области. */
function scopeOnlyData(
  snapshot: OrderSnapshot,
  now: Date,
): Prisma.DeliveryOrderUncheckedUpdateInput {
  return {
    externalUpdated: parseMoscow(snapshot.externalUpdated),
    storeId: snapshot.storeId,
    deliveryMethodId: snapshot.deliveryMethodId,
    sourceArchived: snapshot.sourceArchived,
    inScope: false,
    updatedAt: now,
  };
}

/** Последний канонический снимок заказа. Ревизии неизменяемы, поэтому он достоверен. */
async function previousSnapshot(
  tx: TransactionClient,
  orderId: string,
): Promise<OrderSnapshot | null> {
  const revision = await tx.deliveryOrderRevision.findFirst({
    where: { orderId },
    // Одинаковые миллисекунды реальны при пакетной обработке, поэтому
    // порядок доопределяется идентификатором.
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    select: { snapshot: true },
  });
  return revision === null ? null : (revision.snapshot as unknown as OrderSnapshot);
}

async function writeRevision(
  tx: TransactionClient,
  orderId: string,
  snapshot: OrderSnapshot,
  changedFields: string[],
  // Тип берётся из сгенерированного клиента: перечисление и код не могут разойтись.
  reason: $Enums.OrderRevisionReason,
): Promise<void> {
  await tx.deliveryOrderRevision.create({
    data: {
      orderId,
      externalUpdated: parseMoscow(snapshot.externalUpdated),
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      snapshotHash: snapshotHash(snapshot),
      changedFields,
      reason,
    },
  });
}

/**
 * Аудит системного действия.
 *
 * Значения полей заказа сюда не попадают: они лежат в защищённой ревизии.
 * Здесь — только факт, идентификатор, перечень изменившихся полей и признаки области.
 */
async function writeOrderAudit(
  tx: TransactionClient,
  action: AuditAction,
  orderId: string,
  snapshot: OrderSnapshot,
  changedFields: string[],
  version: number,
  reasons: AttentionReason[],
): Promise<void> {
  await writeAudit(tx, {
    action,
    entityType: 'DeliveryOrder',
    entityId: orderId,
    actorUserId: null,
    source: 'worker',
    newValue: {
      changedFields,
      version,
      inScope: snapshot.inScope,
      scopeExitReason: snapshot.scopeExitReason,
      needsAttention: reasons.length > 0,
      attentionReasons: reasons,
      externalStateType: snapshot.externalStateType,
    },
  });
}

/**
 * Realtime-событие без персональных данных.
 *
 * Клиент по нему перезапрашивает список: пересылать адрес, получателя и суммы
 * в широковещательном канале незачем и небезопасно.
 */
async function publishOrderEvent(
  tx: TransactionClient,
  topic: 'order.created' | 'order.updated' | 'order.scope_changed',
  orderId: string,
  snapshot: OrderSnapshot,
  reasons: AttentionReason[],
): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic,
    payload: {
      orderId,
      inScope: snapshot.inScope,
      needsAttention: reasons.length > 0,
      deliveryDate: snapshot.deliveryDate,
    },
    audienceRoles: [...ORDER_AUDIENCE],
  });
}

/** Помечает заказ отсутствующим в источнике. Вызывается только контрольной сверкой. */
export async function markSourceMissing(
  tx: TransactionClient,
  orderId: string,
  now: Date,
): Promise<void> {
  const updated = await tx.deliveryOrder.updateMany({
    where: { id: orderId, sourceMissing: false },
    data: {
      sourceMissing: true,
      inScope: false,
      scopeExitReason: 'SOURCE_MISSING',
      scopeExitedAt: now,
      updatedAt: now,
    },
  });

  if (updated.count === 0) {
    return;
  }

  await writeAudit(tx, {
    action: 'ORDER_SOURCE_MISSING',
    entityType: 'DeliveryOrder',
    entityId: orderId,
    actorUserId: null,
    source: 'worker',
    newValue: { inScope: false, scopeExitReason: 'SOURCE_MISSING' },
  });

  await publishRealtimeEvent(tx, {
    topic: 'order.scope_changed',
    payload: { orderId, inScope: false, sourceMissing: true },
    audienceRoles: [...ORDER_AUDIENCE],
  });

  // Пропавший заказ мог быть распределён. Этот путь не проходит через
  // applyOrderSnapshot, поэтому конфликт фиксируется здесь отдельно.
  // Строка заказа уже заблокирована обновлением выше — порядок соблюдён.
  const stored = await tx.deliveryOrder.findUnique({
    where: { id: orderId },
    select: { deliveryDate: true },
  });
  await recordOrderConflicts(tx, orderId, {
    deliveryDate: stored?.deliveryDate ?? null,
    inScope: false,
    sourceArchived: false,
    sourceMissing: true,
  });
}
