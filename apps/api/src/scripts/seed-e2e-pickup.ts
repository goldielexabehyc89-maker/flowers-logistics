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
import { moscowMinuteOfDay } from '../modules/fulfillment/queue.js';

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

    /**
     * Заказ самовывоза с заданным интервалом.
     *
     * Отличаются фикстуры только временем: путь сборки и выдачи у них общий,
     * а проверяет их разное — сценарий выдачи и приоритет ближайшего часа.
     */
    async function createPickup(input: {
      number: string;
      startMinute: number;
      endMinute: number;
      day: string;
    }): Promise<string> {
      const created = await db.deliveryOrder.create({
        data: {
          externalId: crypto.randomUUID(),
          externalName: input.number,
          externalUpdated: new Date(),
          externalStateName: 'Новый',
          deliveryDate: toDateColumn(input.day),
          deliveryDateRaw: `${input.day} 12:00:00.000`,
          intervalKind: 'RANGE',
          intervalStartMinute: input.startMinute,
          intervalEndMinute: input.endMinute,
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
              externalPositionId: crypto.randomUUID(),
              ordinal: position.ordinal,
              assortmentId: position.assortmentId,
              assortmentKind: position.assortmentKind,
              assortmentKindRaw: position.assortmentKindRaw,
              name: position.name,
              quantity: position.quantity,
              characteristicLabel: position.characteristicLabel,
              components: {
                create: position.components.map((component) => ({
                  externalComponentId: crypto.randomUUID(),
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
      return created.externalName;
    }

    const order = {
      externalName: await createPickup({ number, day, startMinute: 600, endMinute: 840 }),
    };

    /*
     * Две фикстуры приоритета «Ближайшие самовывозы».
     *
     * Время считается от МОМЕНТА посева, а не задаётся числом: браузерный
     * прогон начинается через несколько минут после сидов и идёт десятками
     * минут, и постоянное «12:00» попадало бы в группу или не попадало
     * в зависимости от часа запуска.
     *
     * Ближний заказ начинается через пять минут и из группы уже не выходит:
     * наступившее начало приоритета не снимает. Дальний отстоит на пять часов
     * и в группу не попадает, пока прогон идёт.
     */
    const nowMinute = moscowMinuteOfDay(new Date());
    const soonStart = Math.min(nowMinute + 5, 1438);
    const soonNumber = await createPickup({
      number: `PS-${stamp}`,
      day,
      startMinute: soonStart,
      endMinute: Math.min(soonStart + 60, 1439),
    });
    const laterStart = Math.min(nowMinute + 300, 1438);
    const laterNumber = await createPickup({
      number: `PL-${stamp}`,
      day,
      startMinute: laterStart,
      endMinute: Math.min(laterStart + 60, 1439),
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
    process.stdout.write(`ближайший самовывоз: ${soonNumber}\n`);
    process.stdout.write(`дальний самовывоз: ${laterNumber}\n`);

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
