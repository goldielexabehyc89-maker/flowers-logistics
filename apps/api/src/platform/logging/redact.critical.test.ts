/**
 * Критическая проверка: секреты и PII не попадают в лог.
 *
 * Проверяется не только вспомогательная функция, но и фактический вывод pino
 * с боевыми настройками — именно он уходит в файлы логов и в систему сбора.
 */

import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Writable } from 'node:stream';
import { redactDeep, safePath, REDACTED } from './redact.js';
import { buildLoggerOptions } from './logger.js';
import { loadConfig } from '../config.js';

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

  it('фактический вывод логгера не содержит PIN, телефон, токены и cookies', () => {
    const lines: string[] = [];
    const config = loadConfig({
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
