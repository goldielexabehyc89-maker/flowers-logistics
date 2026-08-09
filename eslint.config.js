// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/generated/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      // Service worker подключается браузером как отдельный скрипт, вне сборки
      // и вне модульной системы проекта. Его правила кэширования продублированы
      // из apps/web/src/pwa/cache-policy.ts, который покрыт критическими тестами.
      'apps/web/public/**',
      'deploy/state/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // Скрипты обслуживания и конфиги выполняются вручную и пишут в stdout осознанно.
    files: ['**/*.config.{js,ts}', 'scripts/**/*.{js,ts}', 'apps/api/src/scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    /*
     * Инструменты сборки артефактов и проверки при выкатке.
     *
     * Это отдельные скрипты Node, запускаемые вручную либо внутри закреплённого
     * образа: они не входят в сборку приложения, пишут в stderr осознанно
     * и пользуются глобальными объектами среды выполнения напрямую.
     */
    files: ['tools/**/*.mjs', 'deploy/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
  prettier,
);
