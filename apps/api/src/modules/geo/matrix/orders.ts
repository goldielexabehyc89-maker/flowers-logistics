/**
 * Матрица по заказам.
 *
 * Единственный способ получить матрицу в приложении: координаты берутся
 * из заказов, а не приходят снаружи. Так автоматический расчёт физически
 * не может оказаться сервисом для посторонних, а список точек всегда
 * соответствует реальной работе на день.
 *
 * К расчёту допускаются только заказы с подтверждённой точкой
 * (`geoState = RESOLVED`). Заказ, ожидающий проверки, в матрицу не попадает:
 * его координаты либо отсутствуют, либо не подтверждены, и построенный по ним
 * порядок объезда выглядел бы правдоподобно, оставаясь неверным.
 */

import type { $Enums } from '../../../generated/prisma/client.js';
import type { Database } from '../../../platform/db.js';
import { AppError } from '../../../platform/errors.js';
import { MICRO } from '../../orders/geo.js';
import { computeMatrix, type MatrixDeps, type MatrixResult } from './service.js';

export interface OrdersMatrixRequest {
  /** Упорядоченный список заказов. Порядок значим: матрица направленная. */
  orderIds: readonly string[];
  profile: $Enums.VehicleType;
}

export interface OrdersMatrixResult extends MatrixResult {
  /** Тот же порядок, что и во входном списке: строка i — это orderIds[i]. */
  orderIds: string[];
}

/**
 * Считает матрицу для перечисленных заказов.
 *
 * Отказывает целиком, если хотя бы один заказ непригоден. Частичный расчёт
 * здесь опаснее отказа: планировщик получил бы матрицу, молча не включающую
 * часть заказов, и построил бы маршрут без них.
 */
export async function matrixForOrders(
  deps: MatrixDeps & { db: Database },
  request: OrdersMatrixRequest,
): Promise<OrdersMatrixResult> {
  const unique = new Set(request.orderIds);
  if (unique.size !== request.orderIds.length) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'duplicate order in matrix request',
      publicMessage: 'Один и тот же заказ указан в расчёте дважды.',
    });
  }

  const rows = await deps.db.deliveryOrder.findMany({
    where: { id: { in: [...unique] } },
    select: {
      id: true,
      geoState: true,
      geoLatMicro: true,
      geoLonMicro: true,
      inScope: true,
      sourceArchived: true,
      sourceMissing: true,
    },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));

  const points = request.orderIds.map((orderId) => {
    const order = byId.get(orderId);

    if (order === undefined) {
      throw new AppError('NOT_FOUND', {
        message: 'order for matrix not found',
        publicMessage: 'Заказ из списка расчёта не найден.',
      });
    }

    if (!order.inScope || order.sourceArchived || order.sourceMissing) {
      throw new AppError('VALIDATION_FAILED', {
        message: 'order is out of scope for matrix',
        publicMessage: 'В расчёт попал заказ, который мы не везём.',
      });
    }

    if (order.geoState !== 'RESOLVED' || order.geoLatMicro === null || order.geoLonMicro === null) {
      // Точка не подтверждена. Считать по ней — значит выдать правдоподобный
      // и при этом неверный порядок объезда.
      throw new AppError('VALIDATION_FAILED', {
        message: 'order has no confirmed point',
        publicMessage: 'У заказа нет подтверждённой точки: расчёт невозможен.',
      });
    }

    return { lat: order.geoLatMicro / MICRO, lon: order.geoLonMicro / MICRO };
  });

  const result = await computeMatrix(deps, { points, profile: request.profile });

  return { ...result, orderIds: [...request.orderIds] };
}
