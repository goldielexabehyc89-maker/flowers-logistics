/**
 * Решения логиста и возвраты от курьера.
 *
 * Разделение прав по ролям: решает логист, принимает склад, объявляет о
 * возврате курьер. Каждое действие проверяется сервером — интерфейс лишь
 * не показывает лишних кнопок.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { authenticateWithRoles } from '../auth/guards.js';
import {
  acceptReturn,
  countUnresolved,
  decideAcknowledge,
  decideCancel,
  decideRedeliver,
  listAcceptedReturns,
  listPendingReturns,
  listResolutions,
  markReturning,
} from './service.js';

/** Решения принимают логист и администратор. */
const RESOLUTION_ROLES = ['ADMIN', 'LOGISTICIAN'] as const;
/** Возврат принимает склад. */
const WAREHOUSE_ROLES = ['ADMIN', 'WAREHOUSE'] as const;
/** О выезде на склад сообщает курьер. */
const COURIER_ROLES = ['ADMIN', 'COURIER'] as const;

const idParamSchema = z.object({ id: z.string().uuid() });
const orderParamSchema = z.object({ orderId: z.string().uuid() });
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  includeDecided: z.coerce.boolean().optional(),
});
const acceptSchema = z.object({
  orderNumber: z.string().trim().min(1).max(120),
  cellCode: z.string().trim().min(1).max(60),
});

export interface ReturnsDeps {
  db: Database;
  config: AppConfig;
}

function contextOf(request: { ip: string; headers: Record<string, unknown> }): {
  ip: string | null;
  userAgent: string | null;
} {
  const agent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof agent === 'string' ? agent.slice(0, 255) : null,
  };
}

export function registerReturnRoutes(app: AppServer, deps: ReturnsDeps): void {
  /** Список «Требуют решения» вместе с точным счётчиком нерешённых. */
  app.get('/api/logistics/resolutions', async (request) => {
    await authenticateWithRoles(request, deps, RESOLUTION_ROLES);
    const query = listQuerySchema.parse(request.query);
    return listResolutions(deps.db, query);
  });

  /** Только счётчик: вкладка обязана показывать серверное число, а не оценку. */
  app.get('/api/logistics/resolutions/count', async (request) => {
    await authenticateWithRoles(request, deps, RESOLUTION_ROLES);
    return { unresolved: await countUnresolved(deps.db) };
  });

  app.post('/api/logistics/resolutions/:id/cancel-order', async (request) => {
    const actor = await authenticateWithRoles(request, deps, RESOLUTION_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return decideCancel({ db: deps.db }, actor, id, contextOf(request));
  });

  /** Задача разобрана вручную: заказ не меняется. */
  app.post('/api/logistics/resolutions/:id/acknowledge', async (request) => {
    const actor = await authenticateWithRoles(request, deps, RESOLUTION_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return decideAcknowledge({ db: deps.db }, actor, id, contextOf(request));
  });

  app.post('/api/logistics/resolutions/:id/redeliver', async (request) => {
    const actor = await authenticateWithRoles(request, deps, RESOLUTION_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return decideRedeliver({ db: deps.db }, actor, id, contextOf(request));
  });

  /** Курьер объявляет, что везёт заказ на склад. */
  app.post('/api/delivery/returns/:orderId/returning', async (request) => {
    const actor = await authenticateWithRoles(request, deps, COURIER_ROLES);
    const { orderId } = orderParamSchema.parse(request.params);
    return markReturning({ db: deps.db }, actor, orderId);
  });

  /** Очередь возвратов склада: чего ждём и что уже принято. */
  app.get('/api/warehouse/returns', async (request) => {
    await authenticateWithRoles(request, deps, WAREHOUSE_ROLES);
    const [pending, accepted] = await Promise.all([
      listPendingReturns(deps.db),
      listAcceptedReturns(deps.db),
    ]);
    return { pending, accepted };
  });

  /** Приёмка возврата: скан заказа и скан ячейки одной операцией. */
  app.post('/api/warehouse/returns/accept', async (request) => {
    const actor = await authenticateWithRoles(request, deps, WAREHOUSE_ROLES);
    const body = acceptSchema.parse(request.body);
    return acceptReturn({ db: deps.db }, actor, body, contextOf(request));
  });
}
