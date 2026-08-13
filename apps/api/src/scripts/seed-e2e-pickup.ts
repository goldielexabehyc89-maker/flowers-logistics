/**
 * Фикстура самовывоза для браузерного сценария.
 *
 * Нужен заказ, который проходит весь путь: флорист его собирает, кладовщик
 * кладёт на полку, менеджер отдаёт покупателю. Отличие от обычного заказа
 * ровно одно и оно существенное: способ получения — точный UUID «Самовывоза»,
 * а логистическая область выключена. Такой заказ не едет по маршруту и обязан
 * попадать в раздел выдачи покупателю, а не в маршрутизацию.
 *
 * Состав создаётся здесь же: токена МоегоСклада в проверках нет, а очередь
 * флориста показывает только заказы с ПОДТВЕРЖДЁННЫМ составом — без него
 * сценарий проверял бы не поведение, а отсутствие данных.
 *
 * Fail closed. Скрипт отказывается работать где-либо, кроме локального
 * окружения с одноразовой базой.
 *
 *   npm run seed:e2e-pickup
 */

import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { toDateColumn } from '../modules/integrations/moysklad/delivery-date.js';
import { MOYSKLAD_IDS } from '../modules/integrations/moysklad/config.js';
import { snapshotHash, type FulfillmentSnapshot } from '../modules/fulfillment/composition.js';
import { moscowToday } from '@fl/shared';

/** Базы, где допустимо создавать проверочные данные. */
const ALLOWED_DATABASES = ['fl_e2e', 'fl_ci', 'fl_test'];

function databaseNameOf(connectionString: string): string {
  try {
    return new URL(connectionString).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);

  if (config.APP_ENV !== 'local' || config.APP_ENVIRONMENT_MARKER !== 'local') {
    logger.error('фикстура самовывоза создаётся только в локальном окружении');
    return 2;
  }

  const database = databaseNameOf(config.DATABASE_URL);
  if (!ALLOWED_DATABASES.includes(database)) {
    logger.error(
      { allowed: ALLOWED_DATABASES },
      'фикстура самовывоза создаётся только в одноразовой базе',
    );
    return 2;
  }

  const db = createDatabase(config, logger);
  try {
    const admin = await db.user.findFirst({
      where: { roles: { some: { role: 'ADMIN' } } },
      select: { id: true },
    });
    if (admin === null) {
      logger.error('нет ни одного администратора: сначала выполните bootstrap:admin');
      return 2;
    }

    const stamp = String(Date.now() % 1_000_000).padStart(6, '0');
    const day = moscowToday(new Date());
    const externalId = crypto.randomUUID();
    const number = `PU-${stamp}`;

    const composition: FulfillmentSnapshot = {
      externalId,
      description: 'Проверочный самовывоз',
      cardText: 'С праздником!',
      positions: [
        {
          externalPositionId: crypto.randomUUID(),
          ordinal: 0,
          assortmentId: crypto.randomUUID(),
          assortmentKind: 'BUNDLE',
          assortmentKindRaw: 'bundle',
          name: 'Букет самовывоза',
          quantity: '1',
          uomId: null,
          uomName: null,
          characteristicLabel: null,
          components: [
            {
              externalComponentId: crypto.randomUUID(),
              ordinal: 0,
              assortmentId: crypto.randomUUID(),
              assortmentKind: 'PRODUCT',
              assortmentKindRaw: 'product',
              name: 'Роза проверочная',
              quantity: '9',
              uomId: null,
              uomName: null,
            },
          ],
        },
      ],
    };

    const order = await db.deliveryOrder.create({
      data: {
        externalId,
        externalName: number,
        externalUpdated: new Date(),
        externalStateName: 'Новый',
        deliveryDate: toDateColumn(day),
        deliveryDateRaw: `${day} 12:00:00.000`,
        intervalKind: 'RANGE',
        intervalStartMinute: 600,
        intervalEndMinute: 840,
        // Адреса доставки у самовывоза нет: покупатель приходит сам.
        address: null,
        recipient: 'Проверочный Покупатель',
        // Самовывоз опознаётся ТОЛЬКО этим значением, а логистическая
        // область на него не распространяется (`FUL-005`).
        deliveryMethodId: MOYSKLAD_IDS.deliveryMethodPickup,
        storeId: MOYSKLAD_IDS.store,
        inScope: false,
        fulfillmentInScope: true,
        fulfillmentDescription: composition.description,
        fulfillmentCardText: composition.cardText,
        fulfillmentSnapshotHash: snapshotHash(composition),
        fulfillmentCompositionState: 'READY',
        fulfillmentCompositionSyncedAt: new Date(),
        fulfillmentPositions: {
          create: composition.positions.map((position) => ({
            externalPositionId: position.externalPositionId,
            ordinal: position.ordinal,
            assortmentId: position.assortmentId,
            assortmentKind: position.assortmentKind,
            assortmentKindRaw: position.assortmentKindRaw,
            name: position.name,
            quantity: position.quantity,
            characteristicLabel: position.characteristicLabel,
            components: {
              create: position.components.map((component) => ({
                externalComponentId: component.externalComponentId,
                ordinal: component.ordinal,
                assortmentId: component.assortmentId,
                assortmentKind: component.assortmentKind,
                assortmentKindRaw: component.assortmentKindRaw,
                name: component.name,
                quantity: component.quantity,
              })),
            },
          })),
        },
        fulfillmentRevisions: {
          create: {
            externalUpdated: new Date(),
            snapshot: composition as never,
            snapshotHash: snapshotHash(composition),
            changedFields: ['externalId', 'description', 'cardText', 'positions'],
            reason: 'INITIAL_IMPORT',
          },
        },
      },
      select: { externalName: true },
    });

    const cell = await db.storageCell.create({
      data: {
        code: `P-${stamp}`,
        normalizedCode: `P-${stamp}`,
        kind: 'STORAGE',
        createdById: admin.id,
      },
      select: { normalizedCode: true },
    });

    // Значения нужны браузерному сценарию, поэтому печатаются отдельными строками.
    process.stdout.write(`заказ самовывоза: ${order.externalName}\n`);
    process.stdout.write(`ячейка самовывоза: ${cell.normalizedCode}\n`);

    logger.info({ number: order.externalName }, 'фикстура самовывоза создана');
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      'не удалось создать фикстуру самовывоза:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
