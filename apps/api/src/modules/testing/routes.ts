/**
 * Входы, существующие только ради браузерных проверок.
 *
 * Каждый из них нужен по одной и той же причине: событие приходит ИЗВНЕ —
 * проходом импорта из МоегоСклада. В интерфейсе его вызвать нечем, а без него
 * браузерный сценарий не может показать, что видит человек, когда источник
 * что-то изменил.
 *
 * Первый вход — отмена заказа: без неё не показать, что видят логист, флорист,
 * склад и курьер при отмене и при её снятии. Второй — изменение адреса
 * источником: им проверяется, что правка деталей приходит на экран без
 * перезагрузки и не сбрасывает точку, а смена дома точку сбрасывает.
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
import { applyOrderSnapshot } from '../integrations/moysklad/import-service.js';
import { mapOrder, type RegionNames } from '../integrations/moysklad/mapper.js';
import type { MoyskladOrderDto } from '../integrations/moysklad/dto.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';

const cancellationSchema = z.object({
  orderNumber: z.string().trim().min(1).max(120),
  cancelled: z.boolean(),
});

/**
 * Новый адрес источника.
 *
 * Части передаются по отдельности ровно потому, что именно из них источник
 * и состоит: собранная строка проверяла бы разбор на стороне теста, а не
 * правила приложения.
 */
const sourceAddressSchema = z.object({
  orderNumber: z.string().trim().min(1).max(120),
  city: z.string().trim().max(200).optional(),
  street: z.string().trim().max(200).optional(),
  house: z.string().trim().max(100).optional(),
  apartment: z.string().trim().max(100).optional(),
  addInfo: z.string().trim().max(300).optional(),
  /** Операционная строка источника: у прежнего контракта работает она. */
  address: z.string().trim().max(500).optional(),
});

export interface TestingDeps {
  db: Database;
  config: AppConfig;
}

const NO_REGIONS: RegionNames = new Map();

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

  /**
   * Источник изменил адрес заказа.
   *
   * Вход НЕ пишет колонки: он собирает такой же ответ МоегоСклада, какой
   * пришёл бы по сети, и прогоняет его тем же путём `mapOrder` →
   * `applyOrderSnapshot`. Поэтому проверяется настоящее поведение импорта —
   * версия контракта, ревизия, история, точка и очередь, — а не запись полей.
   */
  app.post('/api/testing/source-address', async (request) => {
    await authenticateWithRoles(request, deps, ['ADMIN'] as const);
    const body = sourceAddressSchema.parse(request.body);

    const existing = await deps.db.deliveryOrder.findFirst({
      where: { externalName: body.orderNumber },
      select: {
        id: true,
        externalId: true,
        externalName: true,
        address: true,
        deliveryDate: true,
        deliveryDateRaw: true,
        intervalRaw: true,
        recipient: true,
        comment: true,
      },
    });
    if (existing === null) {
      throw new AppError('NOT_FOUND', { publicMessage: 'Заказ с таким номером не найден.' });
    }

    const ids = MOYSKLAD_IDS;
    const href = (kind: string, id: string): string =>
      `https://api.moysklad.ru/api/remap/1.2/entity/${kind}/${id}`;
    const now = new Date();
    const stamp = now.toISOString().replace('T', ' ').replace('Z', '');

    const order = {
      id: existing.externalId,
      name: existing.externalName,
      updated: stamp,
      shipmentAddress: body.address ?? existing.address ?? '',
      shipmentAddressFull: {
        ...(body.city === undefined ? {} : { city: body.city }),
        ...(body.street === undefined ? {} : { street: body.street }),
        ...(body.house === undefined ? {} : { house: body.house }),
        ...(body.apartment === undefined ? {} : { apartment: body.apartment }),
        ...(body.addInfo === undefined ? {} : { addInfo: body.addInfo }),
      },
      ...(existing.deliveryDateRaw === null
        ? {}
        : { deliveryPlannedMoment: existing.deliveryDateRaw }),
      sum: 0,
      payedSum: 0,
      store: { meta: { href: href('store', ids.store) } },
      attributes: [
        {
          id: ids.deliveryMethodAttribute,
          value: {
            name: 'Доставка',
            meta: { href: href('customentity', ids.deliveryMethodDelivery) },
          },
        },
        ...(existing.intervalRaw === null
          ? []
          : [{ id: ids.intervalAttribute, value: existing.intervalRaw }]),
        ...(existing.recipient === null
          ? []
          : [{ id: ids.recipientAttribute, value: existing.recipient }]),
        ...(existing.comment === null
          ? []
          : [{ id: ids.commentAttribute, value: existing.comment }]),
      ],
    } as MoyskladOrderDto;

    const { snapshot } = mapOrder(order, ids, 'shipmentAddressFull', NO_REGIONS);

    return deps.db.$transaction(async (tx) => {
      // Версия контракта здесь не выбирается: заказ уже существует, и импорт
      // читает её из строки. Выключатель на существующий заказ не влияет.
      const result = await applyOrderSnapshot(tx, snapshot, new Date(), {
        structuredAddressV2: false,
        geocoding: true,
      });
      return { orderId: existing.id, outcome: result.outcome, changedFields: result.changedFields };
    });
  });
}
