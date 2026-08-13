/**
 * Длинная очередь флориста для браузерной проверки.
 *
 * Проверять «Загрузить ещё» на трёх заказах бессмысленно: кнопки там не будет
 * вовсе. Нужен день эксплуатационного объёма — больше одной страницы.
 *
 * ЗАКАЗЫ НАМЕРЕННО ТОЛЬКО ПРОИЗВОДСТВЕННЫЕ (`inScope: false`). Логистическая
 * область их не видит, поэтому «Сделки», планирование, маршрутизация и склад
 * остаются такими же, какими их застают остальные сценарии. Иначе одна фикстура
 * очереди флориста молча испортила бы половину браузерной проверки.
 *
 * ПОРЯДОК ТОЖЕ НЕ СЛУЧАЕН. У этих заказов нет распознанного интервала, как и
 * у заказов `seed:e2e-order`, а номер начинается с `QUEUE-` — позже, чем `E2E-`
 * при сравнении строк. Канонический порядок ставит заказы без времени вниз
 * и добирает по номеру, поэтому основной проверочный заказ остаётся на первой
 * странице, и сценарий сборки продолжает работать.
 *
 * Состав НЕ создаётся: очередь показывает заказ по состоянию `READY`, а карточку
 * этих заказов сценарий не открывает. Полная фикстура на шесть десятков заказов
 * стоила бы минут ради данных, которые никто не прочитает.
 *
 * Fail closed: только локальное окружение и только одноразовая база.
 *
 *   npm run seed:e2e-florist-queue -- --count=60
 */

import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { toDateColumn } from '../modules/integrations/moysklad/delivery-date.js';
import { moscowToday } from '../modules/orders/routes.js';
import { snapshotHash, type FulfillmentSnapshot } from '../modules/fulfillment/composition.js';

/** Базы, где допустимо создавать проверочные данные. */
const ALLOWED_DATABASES = ['fl_e2e', 'fl_ci', 'fl_test'];

/** Больше одной страницы: только так видно продолжение. */
const DEFAULT_COUNT = 60;
const MAX_COUNT = 500;

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
    logger.error('очередь флориста наполняется только в локальном окружении');
    return 2;
  }

  const database = databaseNameOf(config.DATABASE_URL);
  if (!ALLOWED_DATABASES.includes(database)) {
    logger.error(
      { allowed: ALLOWED_DATABASES },
      'очередь флориста наполняется только в одноразовой базе',
    );
    return 2;
  }

  const countArg = process.argv.find((argument) => argument.startsWith('--count='));
  const count = Math.min(
    Math.max(Number(countArg?.split('=')[1] ?? DEFAULT_COUNT) || DEFAULT_COUNT, 1),
    MAX_COUNT,
  );

  // Общая метка прогона: по ней сценарий ищет заказ серверным поиском, а
  // повторный запуск не сталкивается с прежними номерами.
  const prefix = `QUEUE-${String(Date.now() % 1_000_000).padStart(6, '0')}`;
  const day = moscowToday(new Date());

  const db = createDatabase(config, logger);
  try {
    await db.deliveryOrder.createMany({
      data: Array.from({ length: count }, (_, index) => {
        // Внешние идентификаторы выдуманы намеренно: настоящих заказов здесь нет.
        const externalId = crypto.randomUUID();
        // Состав подтверждён, но пуст: очередь показывает заказ по состоянию
        // `READY`, а карточку этих заказов сценарий не читает. База требует
        // полноты подтверждённого состояния, поэтому хеш настоящий.
        const composition: FulfillmentSnapshot = {
          externalId,
          description: null,
          cardText: null,
          positions: [],
        };
        return {
          externalId,
          fulfillmentSnapshotHash: snapshotHash(composition),
          // Ширина номера постоянная: сравнение строк не должно зависеть от того,
          // что «10» короче «9».
          externalName: `${prefix}-${String(index).padStart(4, '0')}`,
          externalUpdated: new Date(),
          externalStateName: 'Новый',
          externalStateType: 'Regular',
          deliveryDate: toDateColumn(day),
          intervalRaw: 'уточнить у клиента',
          intervalKind: 'UNRECOGNIZED' as const,
          address: 'Москва, проверочный адрес очереди',
          recipient: 'Проверочный Получатель',
          comment: 'Заказ длинной очереди флориста',
          // Логистическая область эти заказы не видит: остальные сценарии
          // обязаны остаться неизменными.
          inScope: false,
          fulfillmentInScope: true,
          fulfillmentCompositionState: 'READY' as const,
          fulfillmentCompositionSyncedAt: new Date(),
        };
      }),
    });

    logger.info({ count, prefix }, 'очередь флориста наполнена');
    // Значения нужны браузерному сценарию, поэтому печатаются отдельными строками.
    process.stdout.write(`префикс: ${prefix}\n`);
    process.stdout.write(`количество: ${count}\n`);
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      'не удалось наполнить очередь флориста:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
