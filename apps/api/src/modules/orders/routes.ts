/**
 * Чтение импортированных заказов.
 *
 * Доступ только у `ADMIN` и `LOGISTICIAN`: глобальный список заказов курьеру
 * не нужен — ему видны лишь собственные доставки, и это появится вместе
 * с маршрутами. Замороженные пользователи отсекаются общей авторизацией.
 *
 * Деньги отдаются десятичными строками: `bigint` не сериализуется в JSON,
 * а `number` теряет точность на больших суммах.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { AppError } from '../../platform/errors.js';
import { authenticateWithRoles } from '../auth/guards.js';
import { fromDateColumn, toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { toDecimalString } from '../integrations/moysklad/money.js';

const ORDER_ROLES = ['ADMIN', 'LOGISTICIAN'] as const;
const MAX_LIMIT = 100;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /** Календарная дата `YYYY-MM-DD`. По умолчанию — текущий день Москвы. */
  deliveryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается дата в формате ГГГГ-ММ-ДД')
    .optional(),
  needsAttention: z.enum(['true', 'false']).optional(),
  inScope: z.enum(['true', 'false']).optional(),
});

const idParamSchema = z.object({
  id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Некорректный id'),
});

interface OrdersDeps {
  db: Database;
  config: AppConfig;
}

/** Текущий календарный день Москвы. */
export function moscowToday(now: Date): string {
  return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function toListItem(order: {
  id: string;
  externalName: string;
  deliveryDate: Date | null;
  deliveryDateRaw: string | null;
  intervalKind: string;
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
  manualIntervalStartMinute: number | null;
  manualIntervalEndMinute: number | null;
  address: string | null;
  recipient: string | null;
  comment: string | null;
  externalStateId: string | null;
  externalStateName: string | null;
  externalStateType: string | null;
  sumMinor: bigint;
  payedSumMinor: bigint;
  cashCollectable: boolean;
  cashToCollectMinor: bigint;
  cashAnomaly: boolean;
  inScope: boolean;
  scopeExitReason: string | null;
  sourceMissing: boolean;
  needsAttention: boolean;
  attentionReasons: string[];
  updatedAt: Date;
}) {
  return {
    id: order.id,
    number: order.externalName,
    deliveryDate: order.deliveryDate === null ? null : fromDateColumn(order.deliveryDate),
    deliveryDateRaw: order.deliveryDateRaw,
    interval: {
      kind: order.intervalKind,
      startMinute: order.intervalStartMinute,
      endMinute: order.intervalEndMinute,
      manualStartMinute: order.manualIntervalStartMinute,
      manualEndMinute: order.manualIntervalEndMinute,
    },
    address: order.address,
    recipient: order.recipient,
    comment: order.comment,
    externalState: {
      id: order.externalStateId,
      name: order.externalStateName,
      stateType: order.externalStateType,
    },
    money: {
      sum: toDecimalString(order.sumMinor),
      payed: toDecimalString(order.payedSumMinor),
      cashToCollect: toDecimalString(order.cashToCollectMinor),
      cashCollectable: order.cashCollectable,
      anomaly: order.cashAnomaly,
    },
    scope: {
      inScope: order.inScope,
      exitReason: order.scopeExitReason,
      sourceMissing: order.sourceMissing,
    },
    needsAttention: order.needsAttention,
    attentionReasons: order.attentionReasons,
    updatedAt: order.updatedAt.toISOString(),
  };
}

export async function registerOrderRoutes(app: AppServer, deps: OrdersDeps): Promise<void> {
  app.get('/api/orders', async (request) => {
    await authenticateWithRoles(request, deps, ORDER_ROLES);
    const query = listQuerySchema.parse(request.query);

    const inScope = query.inScope === undefined ? true : query.inScope === 'true';
    const where: Record<string, unknown> = { inScope };

    if (query.needsAttention !== undefined) {
      where['needsAttention'] = query.needsAttention === 'true';
    }

    if (query.deliveryDate !== undefined) {
      where['deliveryDate'] = toDateColumn(query.deliveryDate);
    } else if (inScope) {
      // По умолчанию — текущий день. Но заказ без распознанной даты обязан
      // оставаться видимым: иначе он исчез бы из «Требует внимания» именно тогда,
      // когда им нужно заняться.
      where['OR'] = [
        { deliveryDate: toDateColumn(moscowToday(new Date())) },
        { deliveryDate: null },
      ];
    }

    const [rows, total] = await Promise.all([
      deps.db.deliveryOrder.findMany({
        where,
        // Сначала требующие внимания, затем по времени интервала, затем стабильный
        // дополнительный порядок — иначе одинаковые заказы прыгали бы между страницами.
        orderBy: [
          { needsAttention: 'desc' },
          { deliveryDate: 'asc' },
          { intervalStartMinute: 'asc' },
          { externalName: 'asc' },
          { id: 'asc' },
        ],
        take: query.limit,
        skip: query.offset,
      }),
      deps.db.deliveryOrder.count({ where }),
    ]);

    return { items: rows.map(toListItem), total, limit: query.limit, offset: query.offset };
  });

  app.get('/api/orders/:id', async (request) => {
    await authenticateWithRoles(request, deps, ORDER_ROLES);
    const { id } = idParamSchema.parse(request.params);

    const order = await deps.db.deliveryOrder.findUnique({ where: { id } });
    if (order === null) {
      throw new AppError('NOT_FOUND', { message: 'order not found' });
    }

    // Снимок ревизии наружу не отдаётся: он дублировал бы персональные данные
    // и раскрывал внутренний формат. Клиенту нужны факт и перечень полей.
    const revisions = await deps.db.deliveryOrderRevision.findMany({
      where: { orderId: id },
      orderBy: { receivedAt: 'desc' },
      take: 50,
      select: { receivedAt: true, externalUpdated: true, reason: true, changedFields: true },
    });

    return {
      order: toListItem(order),
      revisions: revisions.map((revision) => ({
        receivedAt: revision.receivedAt.toISOString(),
        externalUpdated: revision.externalUpdated.toISOString(),
        reason: revision.reason,
        changedFields: revision.changedFields,
      })),
    };
  });
}
