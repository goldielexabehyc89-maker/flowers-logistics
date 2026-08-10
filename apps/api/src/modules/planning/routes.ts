/**
 * API планирования маршрутов.
 *
 * Доступ у `ADMIN` и `LOGISTICIAN`: планирование — работа логиста.
 * `DELETE` нет: запуск не удаляется, а завершается — применением, отказом
 * либо явным истечением превью.
 *
 * Расчёт выполняется фоновым исполнителем, поэтому постановка отвечает `202`
 * и идентификатором запуска. Ждать в HTTP-запросе матрицу и решатель нельзя:
 * они работают секундами, а иногда десятками секунд.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { authenticateWithRoles } from '../auth/guards.js';
import { isCalendarDate } from '../integrations/moysklad/delivery-date.js';
import { applyPlan } from './apply.js';
import {
  expirePreview,
  MAX_SLOTS,
  readRun,
  requestPlan,
  type PlanningDeps,
  type RequestContext,
} from './service.js';

export const PLANNING_ROLES = ['ADMIN', 'LOGISTICIAN'] as const;

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Некорректный id');

const idParamSchema = z.object({ id: uuid });

const dateSchema = z
  .string()
  .refine(isCalendarDate, 'Ожидается существующая дата в формате ГГГГ-ММ-ДД');

const MINUTES_IN_DAY = 24 * 60;

const slotSchema = z.object({
  /** Курьер необязателен: слот может остаться без человека. */
  courierUserId: uuid.nullable().default(null),
  vehicleType: z.enum(['CAR', 'FOOT']),
  /** Вместимость в заказах: один заказ — одна единица. */
  capacityOrders: z.number().int().min(1).max(500),
  shiftStartMinute: z
    .number()
    .int()
    .min(0)
    .max(MINUTES_IN_DAY - 1)
    .optional(),
  shiftEndMinute: z.number().int().min(1).max(MINUTES_IN_DAY).optional(),
});

const requestSchema = z.object({
  deliveryDate: dateSchema,
  slots: z.array(slotSchema).min(1).max(MAX_SLOTS),
  /**
   * Осознанная замена готового превью. Без него новое превью старое
   * не вытесняет: молчаливая замена стёрла бы просмотренный план.
   */
  replacePreviewId: uuid.optional(),
});

const applySchema = z.object({
  expectedVersion: z.number().int().min(1),
  /** Отдельное подтверждение частичного применения. */
  allowUnassigned: z.boolean().default(false),
});

const expireSchema = z.object({ expectedVersion: z.number().int().min(1) });

const listQuerySchema = z.object({
  deliveryDate: dateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface PlanningRouteDeps {
  db: Database;
  config: AppConfig;
  /** Зависимости планирования. Сетевых обращений HTTP-слой не выполняет. */
  planning: PlanningDeps;
}

interface IncomingRequest {
  ip: string;
  headers: { authorization?: string | undefined; 'user-agent'?: string | undefined };
}

function contextOf(request: IncomingRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
  };
}

export async function registerPlanningRoutes(
  app: AppServer,
  deps: PlanningRouteDeps,
): Promise<void> {
  app.get('/api/route-plans', async (request) => {
    await authenticateWithRoles(request, deps, PLANNING_ROLES);
    const query = listQuerySchema.parse(request.query);

    const where =
      query.deliveryDate === undefined
        ? {}
        : { deliveryDate: new Date(`${query.deliveryDate}T00:00:00.000Z`) };

    const runs = await deps.db.routePlanRun.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      take: query.limit,
      select: {
        id: true,
        deliveryDate: true,
        state: true,
        version: true,
        failureCode: true,
        createdAt: true,
        appliedAt: true,
        _count: { select: { slots: true } },
      },
    });

    return {
      items: runs.map((run) => ({
        id: run.id,
        deliveryDate: run.deliveryDate.toISOString().slice(0, 10),
        state: run.state,
        version: run.version,
        failureCode: run.failureCode,
        createdAt: run.createdAt.toISOString(),
        appliedAt: run.appliedAt?.toISOString() ?? null,
        slotCount: run._count.slots,
      })),
    };
  });

  app.post('/api/route-plans', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, PLANNING_ROLES);
    const body = requestSchema.parse(request.body);

    const created = await requestPlan(
      deps.planning,
      actor,
      {
        deliveryDate: body.deliveryDate,
        slots: body.slots.map((slot) => ({
          courierUserId: slot.courierUserId,
          vehicleType: slot.vehicleType,
          capacityOrders: slot.capacityOrders,
          shiftStartMinute: slot.shiftStartMinute,
          shiftEndMinute: slot.shiftEndMinute,
        })),
        replacePreviewId: body.replacePreviewId,
      },
      contextOf(request),
    );

    // 202: запуск принят, но ещё не посчитан. Отвечать 201 значило бы
    // обещать готовый результат, которого пока нет.
    return reply.code(202).send(await readRun(deps.db, created.id));
  });

  app.get('/api/route-plans/:id', async (request) => {
    await authenticateWithRoles(request, deps, PLANNING_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return readRun(deps.db, id);
  });

  app.post('/api/route-plans/:id/apply', async (request) => {
    const actor = await authenticateWithRoles(request, deps, PLANNING_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = applySchema.parse(request.body);

    const applied = await applyPlan(deps.planning, actor, id, body, contextOf(request));
    return { ...(await readRun(deps.db, id)), alreadyApplied: applied.alreadyApplied };
  });

  app.post('/api/route-plans/:id/expire', async (request) => {
    const actor = await authenticateWithRoles(request, deps, PLANNING_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = expireSchema.parse(request.body);

    await expirePreview(deps.planning, actor, id, body, contextOf(request));
    return readRun(deps.db, id);
  });
}
