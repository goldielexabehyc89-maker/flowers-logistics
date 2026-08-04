/**
 * Критическая проверка защиты от запуска разрушающих тестов против рабочей базы.
 *
 * Проверка нужна именно как критическая: если защита однажды сломается незаметно,
 * тесты начнут писать неудаляемые записи в базу разработки, staging или production.
 */

import { describe, expect, it } from 'vitest';
import { resolveTestDatabaseUrl } from './test-database.js';

const TEST_URL = 'postgresql://fl_app:pwd@db:5432/fl_test?schema=public';
const DEV_URL = 'postgresql://fl_app:pwd@db:5432/fl_dev?schema=public';
const CI_URL = 'postgresql://fl_app:pwd@localhost:5432/fl_ci?schema=public';

describe('защита тестовой базы', () => {
  it('разрешает одноразовые базы fl_test и fl_ci', () => {
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: TEST_URL })).toBe(TEST_URL);
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: CI_URL })).toBe(CI_URL);
  });

  it('отказывает базе разработки', () => {
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: DEV_URL })).toThrow(/fl_dev/);
    expect(() => resolveTestDatabaseUrl({ DATABASE_URL: DEV_URL })).toThrow(/fl_dev/);
  });

  it('отказывает staging и production независимо от имени базы', () => {
    expect(() =>
      resolveTestDatabaseUrl({ TEST_DATABASE_URL: TEST_URL, APP_ENV: 'production' }),
    ).toThrow(/production/);

    expect(() =>
      resolveTestDatabaseUrl({ TEST_DATABASE_URL: TEST_URL, APP_ENVIRONMENT_MARKER: 'staging' }),
    ).toThrow(/staging/);
  });

  it('отказывает, если строка подключения не задана', () => {
    expect(() => resolveTestDatabaseUrl({})).toThrow(/TEST_DATABASE_URL/);
  });

  it('отказывает при некорректной строке подключения', () => {
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: 'не-url' })).toThrow(/URL/);
  });
});
