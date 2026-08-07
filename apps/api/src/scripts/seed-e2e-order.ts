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

  const db = createDatabase(config, logger);
  try {
    const number = `E2E-${String(Date.now() % 1_000_000).padStart(6, '0')}`;
    const order = await db.deliveryOrder.create({
      data: {
        // Внешние идентификаторы выдуманы намеренно: настоящих заказов здесь нет.
        externalId: crypto.randomUUID(),
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
      },
      select: { id: true, externalName: true },
    });

    logger.info({ number: order.externalName }, 'проверочный заказ создан');
    // Номер нужен браузерному сценарию, поэтому печатается отдельной строкой.
    process.stdout.write(`номер: ${order.externalName}\n`);
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
