/**
 * Фиксированные секреты для тестов.
 *
 * Секреты авторизации обязательны во всех окружениях, поэтому любой тест, который
 * собирает конфигурацию, должен их передать. Значения заведомо непригодны для
 * реальных окружений: они помечены `test-only` прямо в самом значении и лежат
 * в репозитории открыто.
 */

export const TEST_SECRETS = {
  AUTH_ACCESS_TOKEN_SECRET: 'test-only-access-token-secret-0000000000',
  AUTH_PIN_PEPPER: 'test-only-pin-pepper-000000000000000000',
  /** 32 байта в base64 — ключ AES-256-GCM. */
  AUTH_REFRESH_REPLAY_KEY: Buffer.alloc(32, 7).toString('base64'),
  /** Pepper кода привязки обработчика печати: отдельный контур, отдельный секрет. */
  PRINT_AGENT_PAIRING_PEPPER: 'test-only-print-agent-pepper-0000000000',
} as const;
