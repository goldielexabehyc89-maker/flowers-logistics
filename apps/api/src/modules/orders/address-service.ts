/**
 * Правка адреса заказа логистом.
 *
 * Четыре операции одного цикла: сохранить локальный адрес, снять правку и два
 * решения конфликта. Каждая выполняется ОДНОЙ транзакцией: адрес, координата,
 * причины внимания, история, аудит и realtime меняются вместе или не меняются
 * вовсе. Половинчатое состояние здесь опаснее отказа — заказ показывался бы по
 * одному адресу, а ехал бы по другому.
 *
 * Персональные данные не размножаются: сам адрес живёт в заказе и в профильной
 * истории `OrderAddressHistory`, а в общий аудит, realtime и логи уходят только
 * идентификаторы и вид изменения (`docs/OWNER_DECISIONS.md`, `LOG-001`).
 */

import type { $Enums } from '../../generated/prisma/client.js';
import { AppError } from '../../platform/errors.js';
import type { Database } from '../../platform/db.js';
import type { TransactionClient } from '../auth/sessions.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { effectiveAttentionReasons, type AttentionReason } from './attention.js';
import { enqueueGeocoding } from './geocoding/queue.js';

/** Адрес правят только логист и администратор. Проверяет сервер, а не экран. */
export const ADDRESS_ROLES = ['ADMIN', 'LOGISTICIAN'] as const;

/** События заказов видят те же роли: курьеру глобальный поток не нужен. */
const ORDER_AUDIENCE = ['ADMIN', 'LOGISTICIAN'] as const;

export const MAX_ADDRESS_LENGTH = 500;

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface Actor {
  userId: string;
}

interface Deps {
  db: Database;
}

/** Точка из подсказки. Принимается только точная привязка. */
export interface SuggestedPoint {
  latMicro: number;
  lonMicro: number;
}

export interface SetLocalAddressInput {
  address: string;
  point?: SuggestedPoint | null;
}

/** Строка заказа под блокировкой: ровно то, что нужно правилам. */
interface LockedOrder {
  id: string;
  address: string | null;
  localAddress: string | null;
  addressConflict: boolean;
  sourceMissing: boolean;
  sourceArchived: boolean;
  inScope: boolean;
  attentionReasons: AttentionReason[];
  manualIntervalStartMinute: number | null;
  manualIntervalEndMinute: number | null;
  geoState: $Enums.OrderGeoState;
  geoSource: $Enums.OrderGeoSource | null;
  geoLatMicro: number | null;
  geoLonMicro: number | null;
  geoGeneration: number;
  version: number;
}

async function lockOrder(tx: TransactionClient, orderId: string): Promise<LockedOrder> {
  // Блокировка строки берётся сырым запросом: `FOR UPDATE` в Prisma-клиенте
  // не выражается. Сами поля читаются обычным запросом в той же транзакции —
  // массив перечислений через raw возвращается в форме PostgreSQL, а не JS.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "DeliveryOrder" WHERE "id" = ${orderId}::uuid FOR UPDATE
  `;
  if (locked[0] === undefined) {
    throw new AppError('NOT_FOUND', { publicMessage: 'Заказ не найден.' });
  }

  return tx.deliveryOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      id: true,
      address: true,
      localAddress: true,
      addressConflict: true,
      sourceMissing: true,
      sourceArchived: true,
      inScope: true,
      attentionReasons: true,
      manualIntervalStartMinute: true,
      manualIntervalEndMinute: true,
      geoState: true,
      geoSource: true,
      geoLatMicro: true,
      geoLonMicro: true,
      geoGeneration: true,
      version: true,
    },
  });
}

/**
 * Заказ, которого нет в источнике или который архивирован, не правится.
 *
 * Он мог быть отменён, и исправлять его адрес значит готовить поездку туда,
 * куда ехать уже не нужно.
 */
function assertEditable(order: LockedOrder): void {
  if (order.sourceMissing || order.sourceArchived) {
    throw new AppError('CONFLICT', {
      message: 'order source is missing or archived',
      publicMessage: 'Заказ помечен проблемным: адрес не правится.',
      conflict: { kind: 'ORDER_BLOCKED' },
    });
  }
}

function normalizeAddress(raw: string): string {
  const value = raw.trim();
  if (value === '') {
    throw new AppError('VALIDATION_FAILED', { publicMessage: 'Адрес не может быть пустым.' });
  }
  if (value.length > MAX_ADDRESS_LENGTH) {
    throw new AppError('VALIDATION_FAILED', { publicMessage: 'Адрес слишком длинный.' });
  }
  return value;
}

/** Причины внимания после изменения адреса. Считает общая чистая функция. */
function reasonsAfter(
  order: LockedOrder,
  next: { corrected: boolean; conflict: boolean },
): AttentionReason[] {
  // Из набора убираются локальные причины: их пересчитывает `effectiveAttentionReasons`
  // по новому состоянию, а причины снимка остаются как есть.
  const snapshotReasons = order.attentionReasons.filter((reason) => reason !== 'ADDRESS_CONFLICT');
  const manual = {
    startMinute: order.manualIntervalStartMinute,
    endMinute: order.manualIntervalEndMinute,
  };
  const withAddress = next.corrected
    ? snapshotReasons
    : // Правка снята: «нет адреса» возвращается, если исходного тоже нет.
      order.address === null || order.address.trim() === ''
      ? [...snapshotReasons, 'MISSING_ADDRESS' as AttentionReason]
      : snapshotReasons;

  return effectiveAttentionReasons([...new Set(withAddress)], manual, next);
}

/**
 * Обесценивает прежнюю точку и, если можно, ставит новую.
 *
 * Точная подсказка сохраняется сразу: человек уже увидел её на карте и выбрал.
 * Неточная привязка в автоматику не допускается — заказ уходит в проверку
 * и остаётся в «Требует внимания» (`GEO-002`).
 */
async function applyPoint(
  tx: TransactionClient,
  order: LockedOrder,
  point: SuggestedPoint | null | undefined,
  now: Date,
): Promise<void> {
  if (point !== null && point !== undefined) {
    await tx.deliveryOrder.update({
      where: { id: order.id },
      data: {
        geoState: 'RESOLVED',
        geoSource: 'DADATA',
        geoPrecision: 'EXACT_HOUSE',
        geoLatMicro: point.latMicro,
        geoLonMicro: point.lonMicro,
        geoResolvedAt: now,
        geoReviewReason: null,
      },
    });
    await tx.orderGeoHistory.create({
      data: {
        orderId: order.id,
        kind: 'GEOCODE_RESOLVED',
        occurredAt: now,
        state: 'RESOLVED',
        source: 'DADATA',
        precision: 'EXACT_HOUSE',
        latMicro: point.latMicro,
        lonMicro: point.lonMicro,
        previousLatMicro: order.geoLatMicro,
        previousLonMicro: order.geoLonMicro,
      },
    });
    return;
  }

  // Точки нет: прежняя к новому адресу не относится и остаться пригодной
  // не может — координата от старого адреса выглядит нормальной и молча
  // отправит курьера не туда.
  await tx.deliveryOrder.update({
    where: { id: order.id },
    data: {
      geoState: 'NEEDS_REVIEW',
      geoReviewReason: 'ADDRESS_CHANGED',
      geoSource: null,
      geoPrecision: null,
      geoLatMicro: null,
      geoLonMicro: null,
      geoResolvedAt: null,
    },
  });
  // Запись об инвалидации пишется, ТОЛЬКО если было что инвалидировать.
  //
  // Заказ мог не иметь точки никогда: без разобранного адреса задание
  // не создаётся, и он ждёт человека в «Требует внимания» с состоянием
  // UNRESOLVED. Запись «прежняя точка снята» для него была бы неправдой —
  // и база это ловит ограничением `OrderGeoHistory_invalidation_shape`,
  // которое требует прежних координат у события инвалидации.
  //
  // Ограничение не ослабляется и ошибка не подавляется: не нужно писать
  // событие, которого не происходило. История геоданных обязана означать
  // «здесь что-то произошло», иначе по ней нельзя восстановить прошлое.
  const hadPoint = order.geoLatMicro !== null && order.geoLonMicro !== null;
  if (hadPoint) {
    await tx.orderGeoHistory.create({
      data: {
        orderId: order.id,
        kind: 'INVALIDATED_ADDRESS_CHANGED',
        occurredAt: now,
        state: 'NEEDS_REVIEW',
        reviewReason: 'ADDRESS_CHANGED',
        previousLatMicro: order.geoLatMicro,
        previousLonMicro: order.geoLonMicro,
      },
    });
  }
}

/** Фактическое состояние точки после всех записей транзакции. */
async function currentGeoState(
  tx: TransactionClient,
  orderId: string,
): Promise<$Enums.OrderGeoState> {
  const row = await tx.deliveryOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { geoState: true },
  });
  return row.geoState;
}

export interface AddressChangeResult {
  orderId: string;
  corrected: boolean;
  conflict: boolean;
  geoState: $Enums.OrderGeoState;
}

/**
 * Сохранить локальный адрес.
 *
 * Снимок исходного значения фиксируется здесь: без него первая же
 * синхронизация объявила бы конфликтом саму правку. Явная новая правка
 * закрывает и действующий конфликт — человек только что принял решение.
 */
export async function setLocalAddress(
  deps: Deps,
  actor: Actor,
  orderId: string,
  input: SetLocalAddressInput,
  context: RequestContext,
): Promise<AddressChangeResult> {
  const address = normalizeAddress(input.address);
  const now = new Date();

  return deps.db.$transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    assertEditable(order);

    const previousEffective = order.localAddress ?? order.address;
    const reasons = reasonsAfter(order, { corrected: true, conflict: false });

    await tx.deliveryOrder.update({
      where: { id: order.id },
      data: {
        localAddress: address,
        localAddressSetAt: now,
        localAddressSetById: actor.userId,
        sourceAddressAtLocalEdit: order.address,
        addressConflict: false,
        addressConflictDetectedAt: null,
        needsAttention: reasons.length > 0,
        attentionReasons: reasons,
        version: order.version + 1,
      },
    });

    await applyPoint(tx, order, input.point, now);

    await tx.orderAddressHistory.create({
      data: {
        orderId: order.id,
        action: 'LOCAL_ADDRESS_SET',
        occurredAt: now,
        oldAddress: previousEffective,
        newAddress: address,
        sourceAddress: order.address,
        actorUserId: actor.userId,
      },
    });

    // Точки нет — адрес отправляется на разрешение обычной очередью.
    if (input.point === null || input.point === undefined) {
      await enqueueGeocoding(
        tx,
        {
          id: order.id,
          address: order.address,
          localAddress: address,
          inScope: order.inScope,
          sourceArchived: order.sourceArchived,
          sourceMissing: order.sourceMissing,
          geoState: 'NEEDS_REVIEW',
          geoSource: null,
          geoGeneration: order.geoGeneration,
        },
        now,
      );
    }

    await writeAudit(tx, {
      action: 'ORDER_ADDRESS_CORRECTED',
      entityType: 'DeliveryOrder',
      entityId: order.id,
      actorUserId: actor.userId,
      source: 'api',
      ip: context.ip,
      userAgent: context.userAgent,
      // Адреса здесь нет намеренно: он персональный и живёт в профильной истории.
      newValue: {
        corrected: true,
        pointFromSuggestion: input.point !== null && input.point !== undefined,
      },
    });

    await publishRealtimeEvent(tx, {
      topic: 'order.address_changed',
      payload: { orderId: order.id, change: 'CORRECTED' },
      audienceRoles: [...ORDER_AUDIENCE],
    });

    return {
      orderId: order.id,
      corrected: true,
      conflict: false,
      // Состояние читается фактическое: постановка в очередь переводит заказ
      // в PENDING, и объявлять его «на проверке» было бы неправдой.
      geoState: await currentGeoState(tx, order.id),
    };
  });
}

/** Снять локальную правку: рабочим снова становится исходный адрес. */
export async function clearLocalAddress(
  deps: Deps,
  actor: Actor,
  orderId: string,
  context: RequestContext,
): Promise<AddressChangeResult> {
  const now = new Date();

  return deps.db.$transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);

    if (order.localAddress === null) {
      throw new AppError('CONFLICT', {
        message: 'no local address',
        publicMessage: 'У заказа нет локальной правки адреса.',
        conflict: { kind: 'ADDRESS_NOT_CORRECTED' },
      });
    }

    const reasons = reasonsAfter(order, { corrected: false, conflict: false });

    await tx.deliveryOrder.update({
      where: { id: order.id },
      data: {
        localAddress: null,
        localAddressSetAt: null,
        localAddressSetById: null,
        sourceAddressAtLocalEdit: null,
        addressConflict: false,
        addressConflictDetectedAt: null,
        needsAttention: reasons.length > 0,
        attentionReasons: reasons,
        version: order.version + 1,
      },
    });

    await applyPoint(tx, order, null, now);

    await tx.orderAddressHistory.create({
      data: {
        orderId: order.id,
        action: 'LOCAL_ADDRESS_CLEARED',
        occurredAt: now,
        oldAddress: order.localAddress,
        newAddress: order.address,
        sourceAddress: order.address,
        actorUserId: actor.userId,
      },
    });

    await enqueueGeocoding(
      tx,
      {
        id: order.id,
        address: order.address,
        localAddress: null,
        inScope: order.inScope,
        sourceArchived: order.sourceArchived,
        sourceMissing: order.sourceMissing,
        geoState: 'NEEDS_REVIEW',
        geoSource: null,
        geoGeneration: order.geoGeneration,
      },
      now,
    );

    await writeAudit(tx, {
      action: 'ORDER_ADDRESS_CLEARED',
      entityType: 'DeliveryOrder',
      entityId: order.id,
      actorUserId: actor.userId,
      source: 'api',
      ip: context.ip,
      userAgent: context.userAgent,
      newValue: { corrected: false },
    });

    await publishRealtimeEvent(tx, {
      topic: 'order.address_changed',
      payload: { orderId: order.id, change: 'CLEARED' },
      audienceRoles: [...ORDER_AUDIENCE],
    });

    return {
      orderId: order.id,
      corrected: false,
      conflict: false,
      geoState: await currentGeoState(tx, order.id),
    };
  });
}

export type ConflictDecision = 'KEEP_LOCAL' | 'USE_SOURCE';

/**
 * Разрешить конфликт источника.
 *
 * `KEEP_LOCAL` оставляет адрес логиста и просто фиксирует новый снимок
 * источника: следующее изменение источника снова станет конфликтом.
 * `USE_SOURCE` снимает правку целиком — дальше действует адрес МоегоСклада.
 */
export async function resolveAddressConflict(
  deps: Deps,
  actor: Actor,
  orderId: string,
  decision: ConflictDecision,
  context: RequestContext,
): Promise<AddressChangeResult> {
  const now = new Date();

  return deps.db.$transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);

    if (!order.addressConflict) {
      throw new AppError('CONFLICT', {
        message: 'no address conflict',
        publicMessage: 'У заказа нет расхождения адресов.',
        conflict: { kind: 'ADDRESS_NO_CONFLICT' },
      });
    }

    const keepLocal = decision === 'KEEP_LOCAL';
    const reasons = reasonsAfter(order, { corrected: keepLocal, conflict: false });

    await tx.deliveryOrder.update({
      where: { id: order.id },
      data: {
        addressConflict: false,
        addressConflictDetectedAt: null,
        needsAttention: reasons.length > 0,
        attentionReasons: reasons,
        version: order.version + 1,
        ...(keepLocal
          ? // Правка остаётся, но снимок источника обновляется: иначе тот же
            // конфликт объявлялся бы на каждом проходе синхронизации.
            { sourceAddressAtLocalEdit: order.address }
          : {
              localAddress: null,
              localAddressSetAt: null,
              localAddressSetById: null,
              sourceAddressAtLocalEdit: null,
            }),
      },
    });

    // Рабочий адрес меняется только при выборе источника.
    if (!keepLocal) {
      await applyPoint(tx, order, null, now);
      await enqueueGeocoding(
        tx,
        {
          id: order.id,
          address: order.address,
          localAddress: null,
          inScope: order.inScope,
          sourceArchived: order.sourceArchived,
          sourceMissing: order.sourceMissing,
          geoState: 'NEEDS_REVIEW',
          geoSource: null,
          geoGeneration: order.geoGeneration,
        },
        now,
      );
    }

    await tx.orderAddressHistory.create({
      data: {
        orderId: order.id,
        action: keepLocal ? 'CONFLICT_RESOLVED_KEEP_LOCAL' : 'CONFLICT_RESOLVED_USE_SOURCE',
        occurredAt: now,
        oldAddress: order.localAddress,
        newAddress: keepLocal ? order.localAddress : order.address,
        sourceAddress: order.address,
        actorUserId: actor.userId,
      },
    });

    await writeAudit(tx, {
      action: 'ORDER_ADDRESS_CONFLICT_RESOLVED',
      entityType: 'DeliveryOrder',
      entityId: order.id,
      actorUserId: actor.userId,
      source: 'api',
      ip: context.ip,
      userAgent: context.userAgent,
      newValue: { decision },
    });

    await publishRealtimeEvent(tx, {
      topic: 'order.address_changed',
      payload: { orderId: order.id, change: decision },
      audienceRoles: [...ORDER_AUDIENCE],
    });

    return {
      orderId: order.id,
      corrected: keepLocal,
      conflict: false,
      geoState: await currentGeoState(tx, order.id),
    };
  });
}

export interface AddressHistoryItem {
  id: string;
  action: $Enums.OrderAddressAction;
  occurredAt: string;
  oldAddress: string | null;
  newAddress: string | null;
  sourceAddress: string | null;
  actor: { id: string; fullName: string } | null;
}

/**
 * Полная история адреса.
 *
 * Персональные данные выдаются целиком, поэтому доступ закрыт ролями на входе
 * маршрута: это профильный административный просмотр, а не часть общего списка.
 */
export async function listAddressHistory(
  deps: Deps,
  orderId: string,
): Promise<AddressHistoryItem[]> {
  const rows = await deps.db.orderAddressHistory.findMany({
    where: { orderId },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      action: true,
      occurredAt: true,
      oldAddress: true,
      newAddress: true,
      sourceAddress: true,
      actor: { select: { id: true, fullName: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    occurredAt: row.occurredAt.toISOString(),
    oldAddress: row.oldAddress,
    newAddress: row.newAddress,
    sourceAddress: row.sourceAddress,
    actor: row.actor,
  }));
}
