/**
 * API склада.
 *
 * Доступ только у `ADMIN` и `WAREHOUSE`. Логист и курьер получают 403: готовность
 * к отгрузке — зона ответственности склада, и открывать её «заодно» логисту
 * незачем. Существующих разделов логиста это не касается.
 *
 * Дата обязательна и умолчания на сервере не имеет. Молчаливое «сегодня» означало бы,
 * что клиент с другим представлением о дне получил бы чужой список и отметил бы
 * готовым не тот заказ. Текущий день выбирает интерфейс и передаёт явно.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { authenticateWithRoles } from '../auth/guards.js';
import { isCalendarDate } from '../integrations/moysklad/delivery-date.js';
import {
  listWarehouseOrders,
  setShipmentReadiness,
  MAX_LIMIT,
  WAREHOUSE_ROLES,
} from './service.js';

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Некорректный id');

const idParamSchema = z.object({ id: uuid });

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается дата в формате ГГГГ-ММ-ДД')
  .refine(isCalendarDate, 'Ожидается существующая дата');

const listQuerySchema = z.object({
  /** Обязательна: складской список без дня не имеет смысла. */
  deliveryDate: dateSchema,
  readiness: z.enum(['ALL', 'READY', 'NOT_READY']).default('ALL'),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const setReadinessBodySchema = z.object({
  readiness: z.enum(['READY', 'NOT_READY']),
  /**
   * Версия заказа, которую видел клиент. Обязательна: без неё повторный клик
   * на устаревшем списке молча перетёр бы чужую отметку.
   */
  expectedVersion: z.number().int().min(0),
});

interface WarehouseDeps {
  db: Database;
  config: AppConfig;
}

export async function registerWarehouseRoutes(app: AppServer, deps: WarehouseDeps): Promise<void> {
  app.get('/api/warehouse/orders', async (request) => {
    await authenticateWithRoles(request, deps, WAREHOUSE_ROLES);
    const query = listQuerySchema.parse(request.query);

    return listWarehouseOrders(deps.db, query);
  });

  /**
   * Смена готовности одного заказа.
   *
   * PUT, а не PATCH: состояние задаётся целиком, повтор заменяет предыдущее
   * значение. Причина возврата из `READY` в `NOT_READY` в первом срезе
   * не требуется и не моделируется (`WH-001`).
   */
  app.put('/api/warehouse/orders/:id/readiness', async (request) => {
    const actor = await authenticateWithRoles(request, deps, WAREHOUSE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = setReadinessBodySchema.parse(request.body);

    const userAgent = request.headers['user-agent'];
    return setShipmentReadiness(
      deps,
      actor,
      { orderId: id, readiness: body.readiness, expectedVersion: body.expectedVersion },
      {
        ip: request.ip,
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
      },
    );
  });
}
