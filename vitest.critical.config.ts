/**
 * Критические проверки.
 *
 * Сюда попадают только тесты, защищающие авторизацию, права, деньги, статусы,
 * синхронизацию, миграции и данные. Тестов «ради процента покрытия» здесь нет.
 * Файлы именуются `*.critical.test.ts` и обязаны проходить в CI.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/*.critical.test.ts', 'packages/**/*.critical.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/generated/**'],
    passWithNoTests: false,
  },
});
