/**
 * Один заказ для браузерной проверки экрана «Сделки».
 *
 * Импорт из МоегоСклада в браузерной проверке невозможен: токена там нет
 * и сетевых обращений быть не должно. Поэтому заказ создаётся напрямую —
 * ровно один, с заведомо тестовыми значениями и без распознанного интервала,
 * чтобы сценарий мог проверить ручное исправление.
 *
 * Fail closed. Скрипт отказывается работать где-либо, кроме локального
 * окружения с одноразовой базой: заказ с выдуманным адресом в production
 * или staging выглядел бы как настоящий и попал бы в планирование.
 *
 *   npm run seed:e2e-order
 */

import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { toDateColumn } from '../modules/integrations/moysklad/delivery-date.js';
import { moscowToday } from '../modules/orders/routes.js';
import { snapshotHash, type FulfillmentSnapshot } from '../modules/fulfillment/composition.js';

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
    logger.error('проверочный заказ создаётся только в локальном окружении');
    return 2;
  }

  const database = databaseNameOf(config.DATABASE_URL);
  if (!ALLOWED_DATABASES.includes(database)) {
    logger.error(
      { allowed: ALLOWED_DATABASES },
      'проверочный заказ создаётся только в одноразовой базе',
    );
    return 2;
  }

  // Сколько заказов создать. Сценарию маршрутов нужен не один: порядок остановок
  // проверяется только там, где остановок хотя бы две.
  const countArg = process.argv.find((argument) => argument.startsWith('--count='));
  const count = Math.min(Math.max(Number(countArg?.split('=')[1] ?? '1') || 1, 1), 10);

  const db = createDatabase(config, logger);
  try {
    for (let index = 0; index < count; index += 1) {
      const number = `E2E-${String((Date.now() + index) % 1_000_000).padStart(6, '0')}`;
      const externalId = crypto.randomUUID();

      /**
       * Производственный состав того же заказа.
       *
       * Он создаётся здесь, а не подгружается: токена МоегоСклада в проверках
       * нет, а очередь флориста намеренно показывает только заказы с
       * ПОДТВЕРЖДЁННЫМ составом — иначе пустой состав был бы неотличим от
       * настоящего пустого. Без него браузерный сценарий сборки проверял бы
       * не поведение, а отсутствие данных.
       */
      const composition: FulfillmentSnapshot = {
        externalId,
        description: 'Нижний комментарий заказа для проверки',
        cardText: 'С праздником! Проверочная открытка',
        positions: [
          {
            externalPositionId: crypto.randomUUID(),
            ordinal: 0,
            assortmentId: crypto.randomUUID(),
            assortmentKind: 'BUNDLE',
            assortmentKindRaw: 'bundle',
            name: 'Букет проверочный',
            quantity: '1',
            // У верхнеуровневой позиции единицы намеренно нет: браузерный
            // сценарий обязан увидеть и число с единицей, и число без неё
            // в одной карточке.
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
                quantity: '11',
                uomId: crypto.randomUUID(),
                // ПОЛНОЕ название — именно так единица и попадает в базу, когда
                // у неё нет короткого обозначения в справочнике МоегоСклада.
                // Браузерный сценарий обязан увидеть на экране «11 шт».
                uomName: 'штука',
              },
            ],
          },
        ],
      };

      const order = await db.deliveryOrder.create({
        data: {
          // Внешние идентификаторы выдуманы намеренно: настоящих заказов здесь нет.
          externalId,
          externalName: number,
          externalUpdated: new Date(),
          externalStateName: 'Новый',
          externalStateType: 'Regular',
          deliveryDate: toDateColumn(moscowToday(new Date())),
          deliveryDateRaw: `${moscowToday(new Date())} 12:00:00.000`,
          // Интервал намеренно не распознан: сценарий проверяет ручное исправление.
          intervalRaw: 'уточнить у клиента',
          intervalKind: 'UNRECOGNIZED',
          address: 'Москва, проверочный адрес 1',
          recipient: 'Проверочный Получатель',
          comment: 'Проверочный заказ браузерного сценария',
          sumMinor: 499000n,
          payedSumMinor: 0n,
          cashCollectable: true,
          cashToCollectMinor: 499000n,
          inScope: true,
          needsAttention: true,
          attentionReasons: ['UNRECOGNIZED_INTERVAL'],
          version: 1,
          // Производственная область: она шире логистической и включает этот
          // заказ независимо от способа получения.
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
              uomId: position.uomId,
              uomName: position.uomName,
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
                  uomId: component.uomId,
                  uomName: component.uomName,
                })),
              },
            })),
          },
          // Ревизия обязательна: именно на неё ссылается собранный заказ,
          // и по ней строится неизменяемый бланк.
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
        select: { id: true, externalName: true },
      });

      logger.info({ number: order.externalName }, 'проверочный заказ создан');
      // Номер нужен браузерному сценарию, поэтому печатается отдельной строкой.
      process.stdout.write(`номер: ${order.externalName}\n`);
    }
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      'не удалось создать проверочный заказ:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
