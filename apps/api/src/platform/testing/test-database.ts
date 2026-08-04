/**
 * Защита от запуска разрушающих тестов против рабочей базы.
 *
 * Критические тесты пишут в базу записи, которые нельзя удалить (пользователи и аудит
 * защищены триггерами). Поэтому они допускаются только к отдельной одноразовой базе,
 * которая пересоздаётся скриптом `scripts/reset-test-db.sh`.
 *
 * Модуль намеренно строгий: при любом сомнении он отказывает в запуске, а не «пробует».
 */

/** Базы, к которым разрешено подключать разрушающие тесты. */
export const ALLOWED_TEST_DATABASES = ['fl_test', 'fl_ci'] as const;

/** Окружения, в которых такие тесты запрещены при любых обстоятельствах. */
const FORBIDDEN_ENVIRONMENTS = ['staging', 'production'];

export interface TestDatabaseEnv {
  TEST_DATABASE_URL?: string | undefined;
  DATABASE_URL?: string | undefined;
  APP_ENV?: string | undefined;
  APP_ENVIRONMENT_MARKER?: string | undefined;
}

function databaseNameOf(connectionString: string): string {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('Строка подключения для тестов не является корректным URL');
  }
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
}

/**
 * Возвращает строку подключения для разрушающих тестов либо бросает исключение
 * с объяснением, почему запуск запрещён. Молчаливого пропуска тестов не предусмотрено:
 * пропущенная проверка создаёт ложное ощущение защищённости.
 */
export function resolveTestDatabaseUrl(env: TestDatabaseEnv = process.env): string {
  // Оба маркера проверяются НЕЗАВИСИМО. Приоритет одного над другим означал бы,
  // что APP_ENV=local скрывает APP_ENVIRONMENT_MARKER=production, и разрушающие
  // тесты отработали бы по production-окружению. Достаточно одного опасного
  // значения из двух, чтобы отказать.
  const markers = [
    { name: 'APP_ENV', value: env.APP_ENV },
    { name: 'APP_ENVIRONMENT_MARKER', value: env.APP_ENVIRONMENT_MARKER },
  ];

  const dangerous = markers.filter(
    (marker) => marker.value !== undefined && FORBIDDEN_ENVIRONMENTS.includes(marker.value),
  );

  if (dangerous.length > 0) {
    const listed = dangerous.map((marker) => `${marker.name}=${marker.value ?? ''}`).join(', ');
    throw new Error(
      `Разрушающие тесты запрещены: ${listed}. ` +
        'Они допускаются только к одноразовой тестовой базе локально и в CI.',
    );
  }

  const connectionString = env.TEST_DATABASE_URL ?? env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      'Не задан TEST_DATABASE_URL. Подготовьте тестовую базу: ./scripts/reset-test-db.sh, ' +
        'затем запускайте критические тесты через docker compose (см. README).',
    );
  }

  const name = databaseNameOf(connectionString);
  if (!(ALLOWED_TEST_DATABASES as readonly string[]).includes(name)) {
    throw new Error(
      `База «${name}» не предназначена для разрушающих тестов: они оставляют записи, ` +
        `которые невозможно удалить. Разрешены только ${ALLOWED_TEST_DATABASES.join(', ')}. ` +
        'Пересоздайте тестовую базу командой ./scripts/reset-test-db.sh',
    );
  }

  return connectionString;
}
