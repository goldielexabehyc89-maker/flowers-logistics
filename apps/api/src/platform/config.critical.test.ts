/**
 * Критическая проверка конфигурации.
 *
 * Приложение должно отказываться стартовать с неполной конфигурацией (fail closed),
 * а сообщение об ошибке не должно раскрывать значения переменных окружения:
 * текст ошибки попадает в stderr, в логи CI и в вывод deploy-скриптов.
 */

import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { TEST_SECRETS } from './testing/secrets.js';

const VALID_URL = 'postgresql://user:sup3r-s3cret@localhost:5432/db';

// Секреты авторизации обязательны во всех окружениях, поэтому базовая конфигурация
// теста всегда включает их: проверяются остальные правила, а не их отсутствие.
const BASE = { DATABASE_URL: VALID_URL, ...TEST_SECRETS };

describe('загрузка конфигурации', () => {
  it('падает без DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('сообщение об ошибке не содержит значений переменных', () => {
    let message = '';
    try {
      loadConfig({ ...BASE, AUTH_PIN_PEPPER: 'слишком-короткий-секрет' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('AUTH_PIN_PEPPER');
    expect(message).not.toContain('слишком-короткий-секрет');
    expect(message).not.toContain('sup3r-s3cret');
  });

  it('подменный решатель выключен по умолчанию', () => {
    expect(loadConfig({ ...BASE }).PLANNING_TEST_SOLVER).toBe(false);
  });

  it('подменный решатель допустим только в локальном окружении', () => {
    // Он не оптимизирует, а раскладывает заказы подряд. Выданный за посчитанный
    // план на staging или в production был бы обманом, поэтому проверка
    // происходит до старта приложения, а не «договорённостью выключить».
    expect(() =>
      loadConfig({ ...BASE, APP_ENV: 'local', PLANNING_TEST_SOLVER: 'true' }),
    ).not.toThrow();

    for (const env of ['staging', 'production'] as const) {
      expect(() =>
        loadConfig({
          ...BASE,
          APP_ENV: env,
          APP_ENVIRONMENT_MARKER: env,
          PLANNING_TEST_SOLVER: 'true',
        }),
      ).toThrow(/PLANNING_TEST_SOLVER/);
    }

    // Смешанная конфигурация тоже отвергается: маркер production при APP_ENV=local
    // означает ошибку развёртывания, а не локальную машину.
    expect(() =>
      loadConfig({
        ...BASE,
        APP_ENV: 'local',
        APP_ENVIRONMENT_MARKER: 'production',
        PLANNING_TEST_SOLVER: 'true',
      }),
    ).toThrow(/PLANNING_TEST_SOLVER/);
  });

  it('подменённые подсказки выключены по умолчанию и закрыты вне local', () => {
    expect(loadConfig({ ...BASE }).DADATA_TEST_SUGGESTIONS).toBe(false);

    expect(() =>
      loadConfig({ ...BASE, APP_ENV: 'local', DADATA_TEST_SUGGESTIONS: 'true' }),
    ).not.toThrow();

    for (const env of ['staging', 'production'] as const) {
      expect(() =>
        loadConfig({
          ...BASE,
          APP_ENV: env,
          APP_ENVIRONMENT_MARKER: env,
          DADATA_TEST_SUGGESTIONS: 'true',
        }),
      ).toThrow(/DADATA_TEST_SUGGESTIONS/);
    }
  });

  it('применяет безопасные значения по умолчанию', () => {
    const config = loadConfig({ ...BASE });

    expect(config.APP_ENV).toBe('local');
    expect(config.APP_ENVIRONMENT_MARKER).toBe('local');
    expect(config.isProduction).toBe(false);
    expect(config.PORT).toBe(3000);
  });

  it('по умолчанию не доверяет заголовкам прокси', () => {
    expect(loadConfig({ ...BASE }).trustProxy).toBe(false);
    expect(loadConfig({ ...BASE, TRUST_PROXY: '' }).trustProxy).toBe(false);
    expect(loadConfig({ ...BASE, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
  });

  it('запрещает безусловное доверие прокси', () => {
    // TRUST_PROXY=true позволило бы клиенту подделать X-Forwarded-For
    // и обойти будущий rate limit по IP.
    expect(() => loadConfig({ ...BASE, TRUST_PROXY: 'true' })).toThrow(
      /TRUST_PROXY=true запрещено/,
    );
  });

  it('принимает список доверенных адресов и число переходов', () => {
    expect(loadConfig({ ...BASE, TRUST_PROXY: '10.0.0.1, 172.16.0.0/12' }).trustProxy).toEqual([
      '10.0.0.1',
      '172.16.0.0/12',
    ]);

    expect(loadConfig({ ...BASE, TRUST_PROXY: '1' }).trustProxy).toBe(1);
  });

  it('отказывается стартовать при непонятном значении TRUST_PROXY', () => {
    expect(() => loadConfig({ ...BASE, TRUST_PROXY: 'да' })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...BASE, TRUST_PROXY: '99' })).toThrow(/переходов/);
  });

  it('распознаёт production и маркер окружения', () => {
    const config = loadConfig({
      ...BASE,
      NODE_ENV: 'production',
      APP_ENV: 'production',
      APP_ENVIRONMENT_MARKER: 'production',
    });

    expect(config.isProduction).toBe(true);
    expect(config.APP_ENVIRONMENT_MARKER).toBe('production');
  });
});
