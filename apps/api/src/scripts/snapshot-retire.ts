/**
 * Вывод синтетического набора из рабочих выборок staging.
 *
 * Ничего не удаляет. Заказы набора выходят из области тем же путём, каким
 * выходит заказ, исчезнувший в источнике: `sourceMissing = true`,
 * `inScope = false`, причина `SOURCE_MISSING`. Они перестают попадать
 * в планирование, нераспределённые и на карту, но остаются в истории.
 *
 * Сухая проверка выполняется ВСЕГДА и первой. Если хотя бы один заказ набора
 * состоит в активном маршруте, команда отказывается целиком: маршруты отменяет
 * человек через интерфейс, потому что отмена требует причины и остаётся его
 * решением, а не следствием запуска скрипта.
 *
 *   npm run snapshot:retire -- --file /srv/.../snapshot.json
 */

import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import {
  describeSnapshotFailure,
  fileArgument,
  readSnapshotFile,
} from '../modules/orders/snapshot/file.js';
import { assertStagingEnvironment } from '../modules/orders/snapshot/import.js';
import { retireSnapshotOrders } from '../modules/orders/snapshot/retire.js';

async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);

  try {
    assertStagingEnvironment(config);
  } catch (error) {
    logger.error(
      error instanceof Error ? error.message : 'окружение не позволяет вывод из области',
    );
    return 2;
  }

  const file = fileArgument(process.argv.slice(2));
  const snapshot = await readSnapshotFile(file);

  const db = createDatabase(config, logger);
  try {
    // Сначала проверка без записи: она же ловит активные маршруты.
    const planned = await retireSnapshotOrders(db, config, snapshot, { dryRun: true });

    process.stdout.write(
      [
        'проверка без записи:',
        `  заказов в снимке: ${snapshot.orders.length}`,
        `  найдено в базе: ${planned.matched}`,
        `  отсутствует в базе: ${planned.missing}`,
        `  будет выведено: ${planned.retired}`,
        `  уже выведено ранее: ${planned.alreadyRetired}`,
        '',
      ].join('\n'),
    );

    if (planned.retired === 0) {
      process.stdout.write('выводить нечего: набор уже вне рабочих выборок\n');
      return 0;
    }

    const result = await retireSnapshotOrders(db, config, snapshot, { dryRun: false });

    process.stdout.write(
      [
        'выполнено:',
        `  выведено из области: ${result.retired}`,
        `  уже было выведено: ${result.alreadyRetired}`,
        '  удалено: 0 (физическое удаление невозможно и не выполняется)',
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
    console.error('Вывод из области не выполнен:', describeSnapshotFailure(error));
    process.exit(1);
  });
