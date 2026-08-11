/**
 * Импорт обезличенного снимка заказов на staging.
 *
 * Тонкая обёртка: вся защита живёт в `importOrdersSnapshot` и покрыта тестами.
 * Здесь только разбор аргумента, чтение одного явного файла и отчёт числами.
 *
 * В вывод не попадает ничего из снимка — ни псевдонимов, ни координат, ни сумм,
 * ни номеров заказов. Отчёт состоит из количеств: этого достаточно, чтобы
 * понять, что произошло, и недостаточно, чтобы что-нибудь узнать о данных.
 *
 *   npm run snapshot:import -- --file /srv/.../snapshot.json
 */

import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import {
  describeSnapshotFailure,
  fileArgument,
  readSnapshotFile,
} from '../modules/orders/snapshot/file.js';
import {
  assertStagingEnvironment,
  importOrdersSnapshot,
} from '../modules/orders/snapshot/import.js';

async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);

  // Окружение проверяется ДО чтения файла: команда, читающая снимок
  // в production, уже сделала половину того, чего делать нельзя.
  try {
    assertStagingEnvironment(config);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : 'окружение не позволяет импорт');
    return 2;
  }

  const file = fileArgument(process.argv.slice(2));
  const snapshot = await readSnapshotFile(file);

  const db = createDatabase(config, logger);
  try {
    const result = await importOrdersSnapshot(db, config, snapshot);

    process.stdout.write(
      [
        `формат: ${snapshot.format}`,
        `заказов в снимке: ${snapshot.orders.length}`,
        `создано: ${result.created}`,
        `обновлено: ${result.updated}`,
        `без изменений: ${result.unchanged}`,
        `возвращено в область: ${result.restored}`,
        `без синтетической точки: ${result.withoutPoint}`,
        '',
      ].join('\n'),
    );

    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // Правило «что можно показать» одно на обе команды и проверяется тестом.
    console.error('Импорт снимка не выполнен:', describeSnapshotFailure(error));
    process.exit(1);
  });
