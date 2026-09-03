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
import {
  PICKUP_ROLES,
  issueToCustomer,
  cancelPickupLocally,
  type RequestContext,
} from './service.js';
import {
  findPickupByNumber,
  listIssuedOfDay,
  listPickupQueue,
  MAX_QUEUE_PAGE_SIZE,
} from './views.js';
import { readWarehouseManualEntry } from '../settings/service.js';

const numberSchema = z.string().min(1).max(MAX_ORDER_NUMBER_LENGTH);

const scanQuerySchema = z.object({ number: numberSchema });

/**
 * Способ действия объявляется явно.
 *
 * Значения по умолчанию здесь нет намеренно: «не сказали — значит скан»
 * превратило бы выключенную настройку в украшение.
 */
const issueSchema = z.object({
  orderNumber: numberSchema,
  source: z.enum(['SCAN', 'MANUAL', 'CARD']),
});

const cancelSchema = z.object({ orderNumber: numberSchema });

const queueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_QUEUE_PAGE_SIZE).optional(),
  cursor: z.string().min(1).max(500).optional(),
  /** Поиск по номеру заказа: полное и частичное совпадение, без учёта регистра. */
  search: z.string().max(MAX_ORDER_NUMBER_LENGTH).optional(),
});
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
  /**
   * Очередь ожидающих выдачи. Ко дню не привязана: покупатель приходит
   * когда придёт, и вчерашняя коробка стоит на той же полке.
   */
  app.get('/api/pickup/orders', async (request) => {
    await authenticateWithRoles(request, deps, PICKUP_ROLES);
    const query = queueQuerySchema.parse(request.query);

    const [queue, manual] = await Promise.all([
      listPickupQueue(deps.db, {
        ...query,
        operationsStartDate: deps.config.OPERATIONS_START_DATE,
        queueDateFrom: deps.config.PICKUP_WAREHOUSE_QUEUE_DATE_FROM,
      }),
      readWarehouseManualEntry(deps.db),
    ]);

    // Настройка приходит вместе с очередью: у менеджера нет своего экрана
    // настроек, а знать, доступна ли ручная выдача, он обязан.
    return { ...queue, manualEntry: manual.value.enabled };
  });

  /** Выданные за московский день: справочный список, а не рабочая очередь. */
  app.get('/api/pickup/issued', async (request) => {
    await authenticateWithRoles(request, deps, PICKUP_ROLES);
    const { deliveryDate } = dayQuerySchema.parse(request.query);

    return listIssuedOfDay(deps.db, deliveryDate ?? moscowToday(new Date()));
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
      { orderNumber: body.orderNumber, source: body.source },
      contextOf(request),
    );
  });

  /**
   * «Отмена» — ЛОКАЛЬНОЕ исключение заказа из очереди самовывоза.
   *
   * Не глобальная отмена: статус заказа не меняется, в МойСклад ничего не
   * уходит, задача синхронизации состояния не создаётся. Права те же, что
   * у выдачи; посторонний получает 403 ещё на входе.
   */
  app.post('/api/pickup/cancellations', async (request) => {
    const actor = await authenticateWithRoles(request, deps, PICKUP_ROLES);
    const body = cancelSchema.parse(request.body);

    return cancelPickupLocally(
      { db: deps.db },
      actor,
      { orderNumber: body.orderNumber },
      contextOf(request),
    );
  });
}
