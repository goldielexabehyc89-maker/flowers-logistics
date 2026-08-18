/**
 * API работы курьера.
 *
 * Права проверяются здесь, на сервере, а не скрытием раздела в навигации:
 * спрятанная кнопка не мешает отправить запрос руками.
 *
 * `DELETE` нет: результат доставки не стирается, он отменяется связанной
 * операцией и остаётся в истории.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { authenticateWithRoles } from '../auth/guards.js';
import { isCalendarDate } from '../integrations/moysklad/delivery-date.js';
import {
  DELIVERY_MANAGER_ROLES,
  DELIVERY_ROLES,
  cancelDeliveryResult,
  listActiveDeliveries,
  listCourierReturns,
  listDeliveryHistory,
  listFailureReasons,
  recordDeliveryResult,
  updateFailureReason,
  type DeliveryDeps,
} from './service.js';

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Некорректный id');

const idParamSchema = z.object({ id: uuid });

/** Комментарий и причина исправления: длина ограничена, содержимое не разбирается. */
const textSchema = z.string().trim().min(1).max(500);

const activeQuerySchema = z.object({
  routeId: uuid.optional(),
  courierUserId: uuid.optional(),
});

const historyQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается дата в формате ГГГГ-ММ-ДД')
    .refine(isCalendarDate, 'Ожидается существующая дата')
    .optional(),
  courierUserId: uuid.optional(),
});

const resultSchema = z.object({
  outcome: z.enum(['DELIVERED', 'NOT_DELIVERED']),
  reasonId: uuid.optional(),
  comment: textSchema.optional(),
});

const cancelSchema = z.object({ reason: textSchema.optional() });

const reasonUpdateSchema = z.object({
  name: textSchema.optional(),
  isActive: z.boolean().optional(),
  expectedVersion: z.number().int().min(1),
});

export interface DeliveryRouteDeps extends DeliveryDeps {
  db: Database;
  config: AppConfig;
}

function contextOf(request: { ip: string; headers: Record<string, unknown> }): {
  ip: string | null;
  userAgent: string | null;
} {
  const agent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof agent === 'string' ? agent : null };
}

export async function registerDeliveryRoutes(
  app: AppServer,
  deps: DeliveryRouteDeps,
): Promise<void> {
  /** Активные доставки: курьеру — свои, менеджерам — все. */
  /*
   * Возвраты курьера отдаются вместе с активными доставками.
   *
   * Один запрос на экран: обязательство вернуть букет — часть той же работы,
   * и второй поход на сервер оставил бы окно, в котором список уже обновился,
   * а возвраты ещё нет.
   */
  app.get('/api/delivery/returns', async (request) => {
    const actor = await authenticateWithRoles(request, deps, DELIVERY_ROLES);
    return { items: await listCourierReturns(deps, actor) };
  });

  app.get('/api/delivery/active', async (request) => {
    const actor = await authenticateWithRoles(request, deps, DELIVERY_ROLES);
    const query = activeQuerySchema.parse(request.query);

    return listActiveDeliveries(deps, actor, query);
  });

  /** История результатов за календарный день Москвы. */
  app.get('/api/delivery/history', async (request) => {
    const actor = await authenticateWithRoles(request, deps, DELIVERY_ROLES);
    const query = historyQuerySchema.parse(request.query);

    return listDeliveryHistory(deps, actor, query);
  });

  /** Справочник причин недоставки. Курьеру нужен активный список. */
  app.get('/api/delivery/failure-reasons', async (request) => {
    const actor = await authenticateWithRoles(request, deps, DELIVERY_ROLES);
    const manager = actor.roles.some((role) => role === 'ADMIN' || role === 'LOGISTICIAN');

    return { items: await listFailureReasons(deps.db, { includeInactive: manager }) };
  });

  /** Название и активность причины меняют логист и администратор. */
  app.put('/api/delivery/failure-reasons/:id', async (request) => {
    const actor = await authenticateWithRoles(request, deps, DELIVERY_MANAGER_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = reasonUpdateSchema.parse(request.body);

    return { reason: await updateFailureReason(deps, actor, id, body, contextOf(request)) };
  });

  /** Окончательный результат доставки. Время ставит сервер. */
  app.post('/api/delivery/orders/:id/result', async (request) => {
    const actor = await authenticateWithRoles(request, deps, DELIVERY_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = resultSchema.parse(request.body);

    return recordDeliveryResult(deps, actor, id, body, contextOf(request));
  });

  /** Отмена результата: своя в пятиминутном окне либо исправление менеджером. */
  app.post('/api/delivery/attempts/:id/cancel', async (request) => {
    const actor = await authenticateWithRoles(request, deps, DELIVERY_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = cancelSchema.parse(request.body ?? {});

    return cancelDeliveryResult(deps, actor, id, body, contextOf(request));
  });
}
