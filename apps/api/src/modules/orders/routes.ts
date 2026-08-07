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
import { MAX_MINUTE, MIN_MINUTE, setManualInterval } from './service.js';

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
  /** Поиск по номеру, адресу и получателю. Пустая строка ищет всё. */
  search: z.string().trim().max(200).optional(),
  /**
   * Только заказы, пригодные для распределения на выбранный день.
   *
   * Экран маршрутизации не должен выгружать все заказы и вычитать из них состав
   * маршрутов на клиенте: при сотнях заказов это лишний трафик и гарантированное
   * расхождение с сервером в момент чужой правки.
   */
  unassigned: z.enum(['true', 'false']).optional(),
});

const setIntervalBodySchema = z.object({
  startMinute: z.number().int().min(MIN_MINUTE).max(MAX_MINUTE),
  endMinute: z.number().int().min(MIN_MINUTE).max(MAX_MINUTE),
  version: z.number().int().min(0),
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
  intervalRaw: string | null;
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
  version: number;
  updatedAt: Date;
}) {
  return {
    id: order.id,
    number: order.externalName,
    deliveryDate: order.deliveryDate === null ? null : fromDateColumn(order.deliveryDate),
    deliveryDateRaw: order.deliveryDateRaw,
    interval: {
      // Исходный текст источника отдаётся всегда: логист должен видеть, что именно
      // написано в МоемСкладе, даже когда интервал исправлен вручную.
      raw: order.intervalRaw,
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
    // Версия нужна интерфейсу: без неё ручное исправление не смогло бы
    // сослаться на конкретное состояние заказа.
    version: order.version,
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

    // Условия собираются в AND: у поиска и у дня свои наборы OR, и записать их
    // в одно поле `OR` нельзя — второй набор молча вытеснил бы первый.
    const conditions: Record<string, unknown>[] = [];
    const searching = query.search !== undefined && query.search !== '';

    if (searching) {
      // Поиск идёт по тем полям, которые логист реально помнит: номер заказа,
      // адрес и получатель. Регистр не важен — номер часто набирают латиницей
      // и в нижнем регистре.
      conditions.push({
        OR: [
          { externalName: { contains: query.search, mode: 'insensitive' } },
          { address: { contains: query.search, mode: 'insensitive' } },
          { recipient: { contains: query.search, mode: 'insensitive' } },
        ],
      });
    }

    const unassignedOnly = query.unassigned === 'true';

    // Заказ без распознанной даты виден при ЛЮБОМ выбранном дне — и при дне
    // по умолчанию, и при явно указанном. Иначе он исчезал бы из «Требует
    // внимания» именно тогда, когда им нужно заняться, а даты у него нет
    // ровно потому, что с ним что-то не так.
    //
    // Исключение — выборка для распределения: заказ без даты положить в маршрут
    // нельзя, и на экране маршрутизации он был бы ложным обещанием. Он остаётся
    // в «Сделках → Требуют внимания», где им и занимаются.
    const day = query.deliveryDate ?? (searching || !inScope ? null : moscowToday(new Date()));

    if (day !== null) {
      conditions.push(
        unassignedOnly
          ? { deliveryDate: toDateColumn(day) }
          : { OR: [{ deliveryDate: toDateColumn(day) }, { deliveryDate: null }] },
      );
    }

    if (unassignedOnly) {
      // Пригодность считает сервер: клиент не знает ни о пропавших заказах,
      // ни о чужих активных маршрутах, и его версия «свободного» заказа
      // устаревала бы к моменту нажатия кнопки.
      conditions.push({ sourceMissing: false, sourceArchived: false, deliveryDate: { not: null } });
      conditions.push({ routeOrders: { none: { removedAt: null } } });
    }

    if (conditions.length > 0) {
      where['AND'] = conditions;
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
    const [revisions, manualChanges] = await Promise.all([
      deps.db.deliveryOrderRevision.findMany({
        where: { orderId: id },
        // Порядок доопределён идентификатором: одинаковые миллисекунды реальны
        // при пакетной обработке, и без этого «последняя» версия прыгала бы.
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: { receivedAt: true, externalUpdated: true, reason: true, changedFields: true },
      }),
      // Ручные исправления живут в аудите, а не в ревизиях: ревизия — это версия
      // источника, а интервал задаём мы сами.
      deps.db.auditLog.findMany({
        where: { entityType: 'DeliveryOrder', entityId: id, action: 'ORDER_INTERVAL_SET' },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: { occurredAt: true, actorUserId: true, newValue: true },
      }),
    ]);

    return {
      order: toListItem(order),
      revisions: revisions.map((revision) => ({
        receivedAt: revision.receivedAt.toISOString(),
        externalUpdated: revision.externalUpdated.toISOString(),
        reason: revision.reason,
        changedFields: revision.changedFields,
      })),
      manualIntervalChanges: manualChanges.map((entry) => {
        const value = (entry.newValue ?? {}) as { startMinute?: number; endMinute?: number };
        return {
          occurredAt: entry.occurredAt.toISOString(),
          actorUserId: entry.actorUserId,
          startMinute: value.startMinute ?? null,
          endMinute: value.endMinute ?? null,
        };
      }),
    };
  });

  /**
   * Ручное локальное исправление интервала.
   *
   * PUT, а не PATCH: значение задаётся целиком и повторное исправление заменяет
   * предыдущее. Дата, адрес, получатель и комментарий не редактируются вовсе —
   * они принадлежат МоемуСкладу.
   */
  app.put('/api/orders/:id/interval', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ORDER_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = setIntervalBodySchema.parse(request.body);

    const userAgent = request.headers['user-agent'];
    return setManualInterval(
      deps,
      actor,
      { orderId: id, ...body },
      {
        ip: request.ip,
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
      },
    );
  });
}
