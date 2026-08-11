/**
 * Готовность заказа к отгрузке — этап 6.1.
 *
 * Границы заданы решением владельца `WH-001`: это ВНУТРЕННЕЕ состояние нашего
 * приложения, которое меняет только человек. Из внешнего статуса МоегоСклада оно
 * не выводится, обратно не пишется, на маршруты, `Depot`, планирование и расчёты
 * не влияет. Товаров, остатков, приёмки, перемещений и списаний здесь нет.
 *
 * Модуль отдельный намеренно. Общий API заказов принадлежит логисту и отдаёт
 * адрес, получателя, комментарий, деньги и координаты; складу они не нужны
 * и не должны быть доступны. Дописать сюда роль `WAREHOUSE` значило бы открыть
 * ей весь этот состав ради одного признака.
 */

import type { $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { fromDateColumn, toDateColumn } from '../integrations/moysklad/delivery-date.js';

/** Раздел и его API доступны только этим ролям. Логист и курьер сюда не входят. */
export const WAREHOUSE_ROLES = ['ADMIN', 'WAREHOUSE'] as const;

/** Кому адресуются события готовности. Тот же список, что и права. */
export const WAREHOUSE_AUDIENCE = ['ADMIN', 'WAREHOUSE'] as const;

export type ShipmentReadiness = $Enums.OrderShipmentReadiness;

/** Фильтр рабочего списка. `ALL` — без сужения по готовности. */
export type ReadinessFilter = 'ALL' | ShipmentReadiness;

export const MAX_LIMIT = 200;

/**
 * Безопасный состав строки склада.
 *
 * Ни адреса, ни получателя, ни комментария, ни денег, ни координат, ни внешних
 * идентификаторов интеграции. Кладовщику для решения «готов / не готов» нужен
 * номер заказа, день и текущее состояние; всё остальное — чужие персональные
 * данные, которые нельзя показывать только потому, что они лежат в той же строке.
 */
export interface WarehouseOrderView {
  id: string;
  /** Отображаемый номер заказа. PII не содержит. */
  number: string;
  deliveryDate: string | null;
  /** Название внешнего статуса — read-only контекст. Состоянием не управляет. */
  externalStateName: string | null;
  readiness: ShipmentReadiness;
  readinessSetAt: string | null;
  version: number;
}

export interface ListInput {
  deliveryDate: string;
  readiness: ReadinessFilter;
  limit: number;
  offset: number;
}

export interface ListResult {
  items: WarehouseOrderView[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Заказы рабочего дня склада.
 *
 * Из списка исключены заказы вне нашей области, архивированные и пропавшие
 * из источника: собирать их незачем, а показать значило бы попросить человека
 * подготовить то, что никто не повезёт. Сохранённая история при этом не трогается —
 * запись остаётся в базе со своим прежним состоянием.
 */
export async function listWarehouseOrders(db: Database, input: ListInput): Promise<ListResult> {
  const where = {
    inScope: true,
    sourceArchived: false,
    sourceMissing: false,
    deliveryDate: toDateColumn(input.deliveryDate),
    ...(input.readiness === 'ALL' ? {} : { shipmentReadiness: input.readiness }),
  };

  // Порядок полный, а не «по номеру»: номера заказов МоегоСклада не обязаны быть
  // уникальными, и при совпадении страницы поехали бы относительно друг друга,
  // показывая один заказ дважды и теряя другой. Идентификатор доводит сортировку
  // до однозначной.
  const [rows, total] = await Promise.all([
    db.deliveryOrder.findMany({
      where,
      orderBy: [{ externalName: 'asc' }, { id: 'asc' }],
      take: input.limit,
      skip: input.offset,
      select: {
        id: true,
        externalName: true,
        deliveryDate: true,
        externalStateName: true,
        shipmentReadiness: true,
        shipmentReadinessSetAt: true,
        version: true,
      },
    }),
    db.deliveryOrder.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      number: row.externalName,
      deliveryDate: row.deliveryDate === null ? null : fromDateColumn(row.deliveryDate),
      externalStateName: row.externalStateName,
      readiness: row.shipmentReadiness,
      readinessSetAt: row.shipmentReadinessSetAt?.toISOString() ?? null,
      version: row.version,
    })),
    total,
    limit: input.limit,
    offset: input.offset,
  };
}

export interface SetReadinessInput {
  orderId: string;
  readiness: ShipmentReadiness;
  expectedVersion: number;
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface SetReadinessResult {
  orderId: string;
  readiness: ShipmentReadiness;
  readinessSetAt: string | null;
  version: number;
  /** Повтор того же состояния: запись не выполнялась. */
  unchanged: boolean;
}

/**
 * Ручная смена готовности одного заказа.
 *
 * Оптимистическая блокировка обязательна: два кладовщика на общем экране —
 * обычная ситуация, а «последний выиграл» здесь означает, что чужую отметку
 * молча стёрли. Устаревшая версия получает 409 и не пишет ничего.
 *
 * Повтор того же состояния при актуальной версии идемпотентен: ни версия,
 * ни `updatedAt`, ни отметка времени, ни аудит, ни событие не меняются. Иначе
 * двойной клик выглядел бы в журнале как два решения человека, а realtime
 * заставлял бы всех перечитывать список без причины.
 */
export async function setShipmentReadiness(
  deps: { db: Database },
  actor: AuthenticatedActor,
  input: SetReadinessInput,
  context: RequestContext,
): Promise<SetReadinessResult> {
  return deps.db.$transaction(async (tx: TransactionClient) => {
    const order = await tx.deliveryOrder.findUnique({
      where: { id: input.orderId },
      select: {
        id: true,
        version: true,
        inScope: true,
        sourceArchived: true,
        sourceMissing: true,
        shipmentReadiness: true,
        shipmentReadinessSetAt: true,
      },
    });

    if (order === null) {
      throw new AppError('NOT_FOUND', { message: 'order not found' });
    }

    if (!order.inScope || order.sourceArchived || order.sourceMissing) {
      throw new AppError('VALIDATION_FAILED', {
        message: 'order is not in the warehouse working list',
        publicMessage: 'Заказ не относится к рабочему списку склада, готовность не изменяется.',
      });
    }

    // Версия проверяется ДО идемпотентности. Совпадение состояния при устаревшей
    // версии не означает согласия: человек принимал решение, глядя на другую
    // карточку, и подтверждать её молча нельзя.
    if (order.version !== input.expectedVersion) {
      throw new AppError('CONFLICT', {
        message: 'optimistic lock conflict',
        publicMessage: 'Заказ изменён другим пользователем. Обновите список и повторите.',
        conflict: { kind: 'STALE_VERSION' },
      });
    }

    if (order.shipmentReadiness === input.readiness) {
      return {
        orderId: order.id,
        readiness: order.shipmentReadiness,
        readinessSetAt: order.shipmentReadinessSetAt?.toISOString() ?? null,
        version: order.version,
        unchanged: true,
      };
    }

    const setAt = new Date();

    // Состояние, автор, время и версия меняются ОДНИМ условным запросом: между
    // чтением строки и записью проходит время, и без условия по версии сюда
    // успела бы вклиниться параллельная транзакция.
    const updated = await tx.deliveryOrder.updateMany({
      where: { id: order.id, version: input.expectedVersion },
      data: {
        shipmentReadiness: input.readiness,
        shipmentReadinessSetAt: setAt,
        shipmentReadinessSetById: actor.userId,
        version: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      throw new AppError('CONFLICT', {
        message: 'optimistic lock conflict',
        publicMessage: 'Заказ изменён другим пользователем. Обновите список и повторите.',
        conflict: { kind: 'STALE_VERSION' },
      });
    }

    const version = order.version + 1;

    // В аудите только состояния и технические идентификаторы: ни номера заказа,
    // ни адреса, ни получателя, ни денег. Автор и время лежат в самой записи.
    await writeAudit(tx, {
      action: 'ORDER_SHIPMENT_READINESS_CHANGED',
      entityType: 'DeliveryOrder',
      entityId: order.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      oldValue: { readiness: order.shipmentReadiness },
      newValue: { readiness: input.readiness, version },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishRealtimeEvent(tx, {
      topic: 'order.shipment_readiness_changed',
      payload: { orderId: order.id, readiness: input.readiness, version },
      audienceRoles: [...WAREHOUSE_AUDIENCE],
    });

    return {
      orderId: order.id,
      readiness: input.readiness,
      readinessSetAt: setAt.toISOString(),
      version,
      unchanged: false,
    };
  });
}
