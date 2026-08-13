/**
 * API раздела «Самовывоз».
 *
 * Права закрыты на входе каждого маршрута: `MANAGER` и `ADMIN`. Кладовщик сюда
 * не входит намеренно — он отвечает за полку, а не за выдачу покупателю
 * (`FUL-001`, `FUL-003` п.8). Проверка ролей серверная: скрыть раздел на
 * клиенте значило бы отдать операцию тому, кто откроет адрес напрямую.
 *
 * Московский день считает сервер и здесь: параметр дня не обязателен, и без
 * него берётся текущий московский день, а не «сегодня» по часам браузера.
 */

import { z } from 'zod';
import { moscowToday } from '@fl/shared';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { authenticateWithRoles } from '../auth/guards.js';
import { isCalendarDate } from '../integrations/moysklad/delivery-date.js';
import { MAX_ORDER_NUMBER_LENGTH } from '../warehouse/order-lookup.js';
import { PICKUP_ROLES, issueToCustomer, type RequestContext } from './service.js';
import { findPickupByNumber, listPickupsOfDay } from './views.js';

const numberSchema = z.string().min(1).max(MAX_ORDER_NUMBER_LENGTH);

const scanQuerySchema = z.object({ number: numberSchema });
const issueSchema = z.object({ orderNumber: numberSchema });
const dayQuerySchema = z.object({
  deliveryDate: z
    .string()
    .refine(isCalendarDate, 'Дата должна быть календарной в формате ГГГГ-ММ-ДД')
    .optional(),
});

export interface PickupRouteDeps {
  db: Database;
  config: AppConfig;
}

function contextOf(request: { ip: string; headers: Record<string, unknown> }): RequestContext {
  const agent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof agent === 'string' ? agent : null };
}

export async function registerPickupRoutes(app: AppServer, deps: PickupRouteDeps): Promise<void> {
  /** Самовывозы дня: ждут выдачи и уже выданные. */
  app.get('/api/pickup/orders', async (request) => {
    await authenticateWithRoles(request, deps, PICKUP_ROLES);
    const { deliveryDate } = dayQuerySchema.parse(request.query);

    return listPickupsOfDay(deps.db, deliveryDate ?? moscowToday(new Date()));
  });

  /** Поиск или скан номера заказа. */
  app.get('/api/pickup/scan', async (request) => {
    await authenticateWithRoles(request, deps, PICKUP_ROLES);
    const { number } = scanQuerySchema.parse(request.query);

    return findPickupByNumber(deps.db, number);
  });

  /** «Выдан покупателю». Скан ячейки и проверка получателя не требуются. */
  app.post('/api/pickup/issues', async (request) => {
    const actor = await authenticateWithRoles(request, deps, PICKUP_ROLES);
    const body = issueSchema.parse(request.body);

    return issueToCustomer(
      { db: deps.db },
      actor,
      { orderNumber: body.orderNumber },
      contextOf(request),
    );
  });
}
