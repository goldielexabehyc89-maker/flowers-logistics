/**
 * CLI создания первого администратора.
 *
 * Команда безопасна при повторном запуске: второго администратора она не создаёт
 * и старый код не показывает. Пароля по умолчанию не существует — доступ выдаётся
 * одноразовым кодом, который печатается ровно один раз.
 *
 *   npm run bootstrap:admin -- --phone +79161234567 --name "Иван Иванов"
 *   npm run bootstrap:admin -- --phone +79161234567 --name "Иван Иванов" --reissue
 *
 * Флаг --reissue нужен, если первый администратор не успел активироваться за 30 минут.
 * Вся логика — в модуле auth/bootstrap.ts, здесь только разбор аргументов и вывод.
 */

import { parseArgs } from 'node:util';
import { normalizePhone } from '@fl/shared';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { bootstrapAdmin } from '../modules/auth/bootstrap.js';

interface Options {
  phone: string;
  name: string;
  reissue: boolean;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      phone: { type: 'string' },
      name: { type: 'string' },
      reissue: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.phone === undefined || values.name === undefined) {
    throw new Error(
      'Использование: npm run bootstrap:admin -- --phone <телефон> --name <имя> [--reissue]',
    );
  }

  return {
    phone: normalizePhone(values.phone),
    name: values.name.trim(),
    reissue: values.reissue === true,
  };
}

/** Печатает код один раз. Отдельная функция, чтобы код не оказался в логгере. */
function printOneTimeCode(phone: string, code: string, expiresAt: Date): void {
  process.stdout.write(
    [
      '',
      '─────────────────────────────────────────────',
      ' Одноразовый код активации администратора',
      '',
      `   телефон: ${phone}`,
      `   код:     ${code}`,
      `   годен до ${expiresAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (МСК)`,
      '',
      ' Код показывается один раз и в базе не хранится.',
      ' Передайте его администратору лично и не пересылайте в переписке.',
      '─────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<number> {
  const options = parseOptions();
  const config = loadConfig();
  const logger = createLogger(config);
  const db = createDatabase(config, logger);

  try {
    const outcome = await bootstrapAdmin(db, config, options);

    switch (outcome.kind) {
      case 'already-exists':
        // Повторный запуск — не ошибка, а ожидаемое поведение при переустановке.
        process.stdout.write(
          'Администратор уже существует. Второй не создан, прежний код не раскрывается.\n' +
            'Если первый администратор не успел активироваться, используйте --reissue.\n',
        );
        return 0;

      case 'reissue-not-allowed':
        process.stderr.write(`Перевыпуск кода невозможен: ${outcome.reason}.\n`);
        return 1;

      case 'created':
      case 'reissued':
        printOneTimeCode(options.phone, outcome.code, outcome.expiresAt);
        return 0;

      default:
        return 1;
    }
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // Сообщение не содержит кода и PIN: печатается только текст ошибки.
    process.stderr.write(
      `Не удалось выполнить команду: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
