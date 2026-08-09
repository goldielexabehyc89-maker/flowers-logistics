/**
 * Геоданные заказа: ручная точка, история и инвалидация при смене адреса.
 *
 * Координаты живут целыми микроградусами. Число с плавающей точкой здесь
 * недопустимо: от координаты зависят порядок объезда и расстояние, а двоичная
 * дробь округляется незаметно и накапливает ошибку. Микроградус — около
 * 11 сантиметров, чего заведомо достаточно для доставки.
 *
 * Точка существует только в состоянии `RESOLVED` — это гарантирует база.
 * Поэтому будущее автоматическое планирование сможет просто взять заказы
 * с `geoState = RESOLVED` и не проверять пригодность отдельно.
 *
 * Ни адрес, ни координаты не попадают в аудит, realtime и тексты ошибок:
 * там только идентификаторы и технические состояния.
 */

import type { $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import type { Role } from '@fl/shared';

const ORDER_AUDIENCE: readonly Role[] = ['ADMIN', 'LOGISTICIAN'];

/** Микроградусы: 1° = 1 000 000. */
export const MICRO = 1_000_000;
export const MAX_LAT_MICRO = 90 * MICRO;
export const MAX_LON_MICRO = 180 * MICRO;

const MIN_REASON = 3;
const MAX_REASON = 500;

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface GeoPoint {
  latMicro: number;
  lonMicro: number;
}

/**
 * Разбирает координату из десятичной строки или числа.
 *
 * Строка предпочтительна: она проходит через JSON без потери знаков. Число тоже
 * принимается — браузерная карта отдаёт именно его, — но сразу переводится
 * в целые микроградусы и дальше живёт только так.
 */
export function toMicro(value: unknown, limit: number, field: string): number {
  const asNumber = typeof value === 'string' ? Number(value) : value;

  if (typeof asNumber !== 'number' || !Number.isFinite(asNumber)) {
    throw new AppError('VALIDATION_FAILED', {
      message: `invalid ${field}`,
      publicMessage: 'Координата указана неверно.',
    });
  }

  const micro = Math.round(asNumber * MICRO);
  if (Math.abs(micro) > limit) {
    throw new AppError('VALIDATION_FAILED', {
      message: `${field} is out of range`,
      publicMessage: 'Координата выходит за пределы допустимых значений.',
    });
  }
  return micro;
}

/** `55751244` → `55.751244`. Наружу координаты уходят десятичными строками. */
export function fromMicro(micro: number): string {
  const sign = micro < 0 ? '-' : '';
  const absolute = Math.abs(micro);
  const whole = Math.floor(absolute / MICRO);
  const fraction = String(absolute % MICRO).padStart(6, '0');
  return `${sign}${whole}.${fraction}`;
}

export function assertReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON || trimmed.length > MAX_REASON) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'reason length is out of range',
      publicMessage: `Причина должна содержать от ${MIN_REASON} до ${MAX_REASON} символов.`,
    });
  }
  return trimmed;
}

export interface SetPointInput {
  lat: string | number;
  lon: string | number;
  reason: string;
  expectedVersion: number;
}

export interface SetPointResult {
  orderId: string;
  version: number;
  geoState: $Enums.OrderGeoState;
  lat: string;
  lon: string;
  /** Точка уже стояла там же: ни истории, ни аудита, ни события не добавилось. */
  unchanged: boolean;
}

/**
 * Ручная установка точки логистом.
 *
 * Повторная установка той же точки идемпотентна: она не создаёт ложную запись
 * в неизменяемой истории, не увеличивает версию и не будит остальных логистов
 * событием. Иначе двойной клик выглядел бы как два разных решения.
 */
export async function setManualPoint(
  deps: { db: Database },
  actor: AuthenticatedActor,
  orderId: string,
  input: SetPointInput,
  context: RequestContext,
): Promise<SetPointResult> {
  const latMicro = toMicro(input.lat, MAX_LAT_MICRO, 'lat');
  const lonMicro = toMicro(input.lon, MAX_LON_MICRO, 'lon');
  const reason = assertReason(input.reason);

  return deps.db.$transaction(async (tx: TransactionClient) => {
    const order = await lockOrder(tx, orderId);

    if (order.version !== input.expectedVersion) {
      throw new AppError('CONFLICT', {
        message: 'stale order version',
        publicMessage: 'Заказ изменён другим пользователем. Обновите страницу и повторите.',
        conflict: { kind: 'STALE_VERSION' },
      });
    }

    // Точку ставят только тому заказу, который мы действительно везём.
    if (!order.inScope || order.sourceArchived || order.sourceMissing) {
      throw new AppError('VALIDATION_FAILED', {
        message: 'order is not eligible for manual point',
        publicMessage: 'Заказ не относится к нашей доставке: точку установить нельзя.',
      });
    }

    if (
      order.geoState === 'RESOLVED' &&
      order.geoLatMicro === latMicro &&
      order.geoLonMicro === lonMicro
    ) {
      return {
        orderId: order.id,
        version: order.version,
        geoState: order.geoState,
        lat: fromMicro(latMicro),
        lon: fromMicro(lonMicro),
        unchanged: true,
      };
    }

    const now = new Date();
    await tx.deliveryOrder.update({
      where: { id: orderId },
      data: {
        geoState: 'RESOLVED',
        geoSource: 'MANUAL',
        // Человек показал дом на карте: это самая точная информация, какая есть.
        geoPrecision: 'EXACT_HOUSE',
        geoLatMicro: latMicro,
        geoLonMicro: lonMicro,
        geoResolvedAt: now,
        geoReviewReason: null,
        version: { increment: 1 },
      },
    });

    await tx.orderGeoHistory.create({
      data: {
        orderId,
        kind: 'MANUAL_SET',
        occurredAt: now,
        state: 'RESOLVED',
        source: 'MANUAL',
        precision: 'EXACT_HOUSE',
        latMicro,
        lonMicro,
        previousLatMicro: order.geoLatMicro,
        previousLonMicro: order.geoLonMicro,
        reason,
        actorUserId: actor.userId,
      },
    });

    await writeAudit(tx, {
      action: 'ORDER_GEO_POINT_SET',
      entityType: 'DeliveryOrder',
      entityId: orderId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      // Ни адреса, ни координат: точка живёт в защищённой истории заказа.
      oldValue: { geoState: order.geoState },
      newValue: { geoState: 'RESOLVED', geoSource: 'MANUAL', version: order.version + 1 },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishRealtimeEvent(tx, {
      topic: 'order.geo_changed',
      payload: { orderId, geoState: 'RESOLVED' },
      audienceRoles: [...ORDER_AUDIENCE],
    });

    return {
      orderId,
      version: order.version + 1,
      geoState: 'RESOLVED' as const,
      lat: fromMicro(latMicro),
      lon: fromMicro(lonMicro),
      unchanged: false,
    };
  });
}

interface LockedOrder {
  id: string;
  version: number;
  inScope: boolean;
  sourceArchived: boolean;
  sourceMissing: boolean;
  geoState: $Enums.OrderGeoState;
  geoLatMicro: number | null;
  geoLonMicro: number | null;
}

async function lockOrder(tx: TransactionClient, orderId: string): Promise<LockedOrder> {
  const rows = await tx.$queryRaw<LockedOrder[]>`
    SELECT "id", "version", "inScope", "sourceArchived", "sourceMissing",
           "geoState", "geoLatMicro", "geoLonMicro"
    FROM "DeliveryOrder"
    WHERE "id" = ${orderId}::uuid
    FOR UPDATE
  `;
  const order = rows[0];
  if (order === undefined) {
    throw new AppError('NOT_FOUND', { message: 'order not found' });
  }
  return order;
}

/**
 * Обесценивает точку после смены адреса.
 *
 * Вызывается синхронизацией внутри её транзакции. Прежняя точка не может молча
 * остаться пригодной: адрес изменился, а координата осталась от старого — это
 * худший вид ошибки, потому что выглядит как нормальные данные.
 *
 * Возвращает `true`, если инвалидация действительно произошла.
 */
export async function invalidateGeoOnAddressChange(
  tx: TransactionClient,
  orderId: string,
  previous: { geoState: $Enums.OrderGeoState; latMicro: number | null; lonMicro: number | null },
): Promise<boolean> {
  // Обесценивать нечего: точки не было.
  if (previous.geoState !== 'RESOLVED') {
    return false;
  }

  const now = new Date();

  await tx.deliveryOrder.update({
    where: { id: orderId },
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

  await tx.orderGeoHistory.create({
    data: {
      orderId,
      kind: 'INVALIDATED_ADDRESS_CHANGED',
      occurredAt: now,
      state: 'NEEDS_REVIEW',
      reviewReason: 'ADDRESS_CHANGED',
      previousLatMicro: previous.latMicro,
      previousLonMicro: previous.lonMicro,
    },
  });

  await writeAudit(tx, {
    action: 'ORDER_GEO_INVALIDATED',
    entityType: 'DeliveryOrder',
    entityId: orderId,
    actorUserId: null,
    source: 'worker',
    newValue: { geoState: 'NEEDS_REVIEW', geoReviewReason: 'ADDRESS_CHANGED' },
  });

  await publishRealtimeEvent(tx, {
    topic: 'order.geo_changed',
    payload: { orderId, geoState: 'NEEDS_REVIEW', reviewReason: 'ADDRESS_CHANGED' },
    audienceRoles: [...ORDER_AUDIENCE],
  });

  return true;
}
