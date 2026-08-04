/**
 * Критическая проверка конфигурации.
 *
 * Приложение должно отказываться стартовать с неполной конфигурацией (fail closed),
 * а сообщение об ошибке не должно раскрывать значения переменных окружения:
 * текст ошибки попадает в stderr, в логи CI и в вывод deploy-скриптов.
 */

import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const VALID_URL = 'postgresql://user:sup3r-s3cret@localhost:5432/db';

describe('загрузка конфигурации', () => {
  it('падает без DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('сообщение об ошибке не содержит значений переменных', () => {
    let message = '';
    try {
      loadConfig({ DATABASE_URL: VALID_URL, AUTH_PIN_PEPPER: 'слишком-короткий-секрет' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('AUTH_PIN_PEPPER');
    expect(message).not.toContain('слишком-короткий-секрет');
    expect(message).not.toContain('sup3r-s3cret');
  });

  it('применяет безопасные значения по умолчанию', () => {
    const config = loadConfig({ DATABASE_URL: VALID_URL });

    expect(config.APP_ENV).toBe('local');
    expect(config.APP_ENVIRONMENT_MARKER).toBe('local');
    expect(config.isProduction).toBe(false);
    expect(config.PORT).toBe(3000);
  });

  it('распознаёт production и маркер окружения', () => {
    const config = loadConfig({
      DATABASE_URL: VALID_URL,
      NODE_ENV: 'production',
      APP_ENV: 'production',
      APP_ENVIRONMENT_MARKER: 'production',
    });

    expect(config.isProduction).toBe(true);
    expect(config.APP_ENVIRONMENT_MARKER).toBe('production');
  });
});
