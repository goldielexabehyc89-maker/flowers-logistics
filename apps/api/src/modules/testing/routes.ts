/**
 * Входы, существующие только ради браузерных проверок.
 *
 * Здесь ровно одна операция, и она нужна по конкретной причине: отмена заказа
 * приходит ИЗВНЕ — проходом импорта из МоегоСклада. В интерфейсе её вызвать
 * нечем, а без неё браузерный сценарий не может показать, что видит логист,
 * флорист, склад и курьер при отмене и при её снятии.
 *
 * Ничего собственного этот вход не решает: он вызывает ту же доменную
 * функцию `applyCancellation`, что и импорт. Подделывается не последствие,
 * а только сигнал.
 *
 * Fail closed дважды: модуль регистрируется только при `E2E_TEST_HOOKS=true`,
 * а сама конфигурация допускает это значение только при `APP_ENV=local`.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { AppError } from '../../platform/errors.js';
import { authenticateWithRoles } from '../auth/guards.js';
import { applyCancellation } from '../integrations/moysklad/cancellation.js';

const cancellationSchema = z.object({
  orderNumber: z.string().trim().min(1).max(120),
  cancelled: z.boolean(),
});

export interface TestingDeps {
  db: Database;
  config: AppConfig;
}

export function registerTestingRoutes(app: AppServer, deps: TestingDeps): void {
  app.post('/api/testing/source-cancellation', async (request) => {
    await authenticateWithRoles(request, deps, ['ADMIN'] as const);
    const body = cancellationSchema.parse(request.body);

    return deps.db.$transaction(async (tx) => {
      const order = await tx.deliveryOrder.findFirst({
        where: { externalName: body.orderNumber },
        select: { id: true, cancelledInSource: true },
      });
      if (order === null) {
        throw new AppError('NOT_FOUND', { publicMessage: 'Заказ с таким номером не найден.' });
      }

      const changed = await applyCancellation(tx, {
        orderId: order.id,
        cancelled: body.cancelled,
        previous: order.cancelledInSource,
        now: new Date(),
      });

      return { orderId: order.id, cancelled: body.cancelled, changed };
    });
  });
}
