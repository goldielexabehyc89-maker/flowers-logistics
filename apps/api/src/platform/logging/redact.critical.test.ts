/**
 * Критическая проверка: секреты и PII не попадают в лог.
 *
 * Проверяется не только вспомогательная функция, но и фактический вывод pino
 * с боевыми настройками — именно он уходит в файлы логов и в систему сбора.
 */

import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Writable } from 'node:stream';
import { redactDeep, redactString, safePath, REDACTED } from './redact.js';
import { buildLoggerOptions } from './logger.js';
import { loadConfig } from '../config.js';
import { TEST_SECRETS } from '../testing/secrets.js';

const SECRET_VALUES = [
  '1234', // PIN
  '9137', // временный код
  '+79161234567', // телефон
  'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
  'refresh_token_value_abcdef',
  'sid=abc123; Path=/',
];

function captureLogOutput(write: (line: string) => void) {
  return new Writable({
    write(chunk, _encoding, callback) {
      write(String(chunk));
      callback();
    },
  });
}

describe('редакция чувствительных данных', () => {
  it('заменяет секретные поля на любом уровне вложенности', () => {
    const result = redactDeep({
      user: {
        phone: '+79161234567',
        profile: { pin: '1234', nested: { activationCode: '9137' } },
      },
      headers: { authorization: 'Bearer token', cookie: 'sid=abc123' },
      tokens: [{ refreshToken: 'abc' }, { accessToken: 'def' }],
      safeField: 'значение остаётся',
    }) as Record<string, never>;

    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('+79161234567');
    expect(serialized).not.toContain('1234');
    expect(serialized).not.toContain('9137');
    expect(serialized).not.toContain('Bearer token');
    expect(serialized).not.toContain('sid=abc123');
    expect(serialized).toContain('значение остаётся');
    expect(serialized.split(REDACTED).length - 1).toBeGreaterThanOrEqual(6);
  });

  it('не зацикливается на циклических ссылках', () => {
    const cyclic: Record<string, unknown> = { name: 'корень' };
    cyclic.self = cyclic;

    expect(() => redactDeep(cyclic)).not.toThrow();
    expect(JSON.stringify(redactDeep(cyclic))).toContain('[circular]');
  });

  it('убирает строку запроса из пути: она может содержать телефон или код', () => {
    expect(safePath('/api/users?phone=%2B79161234567')).toBe('/api/users?[redacted]');
    expect(safePath('/api/users')).toBe('/api/users');
  });

  it('очищает секреты внутри произвольной строки', () => {
    const text = redactString(
      'connect ECONNREFUSED postgresql://fl_app:sup3r-s3cret@db:5432/fl_dev?password=other-secret ' +
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2ln клиент +7 916 123-45-67',
    );

    expect(text).not.toContain('sup3r-s3cret');
    expect(text).not.toContain('other-secret');
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(text).not.toContain('9161234567');
    expect(text).not.toContain('916 123-45-67');
    // Диагностически полезная часть сообщения сохраняется.
    expect(text).toContain('ECONNREFUSED');
    expect(text).toContain('db:5432');
  });

  it('очищает текст и стек ошибки', () => {
    const error = new Error(
      'ошибка подключения postgresql://fl_app:sup3r-s3cret@db:5432/fl_dev, телефон +79161234567',
    );
    error.stack = `Error: токен Bearer eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2ln\n    at db.ts:1:1`;

    const serialized = JSON.stringify(redactDeep({ err: error }));

    expect(serialized).not.toContain('sup3r-s3cret');
    expect(serialized).not.toContain('79161234567');
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(serialized).toContain('ошибка подключения');
  });

  it('очищает вложенную причину ошибки', () => {
    const cause = new Error('пароль password=sup3r-s3cret');
    const error = new Error('обёртка', { cause });

    const serialized = JSON.stringify(redactDeep({ err: error }));

    expect(serialized).not.toContain('sup3r-s3cret');
    expect(serialized).toContain('обёртка');
  });

  it('фактический вывод логгера не содержит секрет из текста ошибки и из сообщения', () => {
    const lines: string[] = [];
    const config = loadConfig({
      ...TEST_SECRETS,
      DATABASE_URL: 'postgresql://fl_app:sup3r-s3cret@db:5432/fl_dev',
      LOG_LEVEL: 'info',
    });

    const logger = pino(
      buildLoggerOptions(config),
      captureLogOutput((line) => lines.push(line)),
    );

    const dbError = new Error(
      'connect ECONNREFUSED postgresql://fl_app:sup3r-s3cret@db:5432/fl_dev',
    );

    // Так ошибка попадает в лог из readiness-пробы.
    logger.error({ err: dbError }, 'readiness: база данных недоступна');
    // А так секрет мог бы попасть в лог через текст сообщения.
    logger.error(`не удалось подключиться: ${dbError.message}, телефон +79161234567`);

    const output = lines.join('\n');

    expect(output).toContain('readiness');
    expect(output).not.toContain('sup3r-s3cret');
    expect(output).not.toContain('79161234567');
  });

  it('фактический вывод логгера не содержит PIN, телефон, токены и cookies', () => {
    const lines: string[] = [];
    const config = loadConfig({
      ...TEST_SECRETS,
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      LOG_LEVEL: 'info',
    });

    const logger = pino(
      buildLoggerOptions(config),
      captureLogOutput((line) => lines.push(line)),
    );

    logger.info(
      {
        phone: '+79161234567',
        pin: '1234',
        code: '9137',
        refreshToken: 'refresh_token_value_abcdef',
        headers: {
          authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
          cookie: 'sid=abc123; Path=/',
        },
        action: 'USER_FROZEN',
      },
      'критическое действие',
    );

    const output = lines.join('\n');

    expect(output).toContain('USER_FROZEN');
    for (const secret of SECRET_VALUES) {
      expect(output).not.toContain(secret);
    }
  });
});
