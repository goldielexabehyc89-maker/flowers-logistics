/**
 * Критическая проверка HTTP-слоя.
 *
 * Ошибка наружу не должна раскрывать техническую подноготную, а в записи лога
 * должны быть метод и путь запроса — без строки запроса, которая может содержать телефон.
 */

import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { loadConfig } from '../config.js';
import { TEST_SECRETS } from '../testing/secrets.js';
import { buildLoggerOptions } from '../logging/logger.js';
import { buildServer } from './server.js';
import type { Database } from '../db.js';

const config = loadConfig({
  ...TEST_SECRETS,
  DATABASE_URL: 'postgresql://user:sup3r-s3cret@localhost:5432/db',
  LOG_LEVEL: 'info',
});

function buildTestLogger(lines: string[]) {
  return pino(
    buildLoggerOptions(config),
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    }),
  );
}

/** Заглушка БД: HTTP-слой проверяется без реального подключения. */
function fakeDatabase(behaviour: { healthy: boolean }): Database {
  return {
    $queryRaw: async () => {
      if (!behaviour.healthy) {
        throw new Error(`подключение postgresql://user:sup3r-s3cret@localhost отклонено`);
      }
      return [{ '?column?': 1 }];
    },
    integrationStatus: { findMany: async () => [] },
  } as unknown as Database;
}

describe('HTTP-слой', () => {
  it('readiness отвечает 503 и не раскрывает строку подключения', async () => {
    const lines: string[] = [];
    const app = await buildServer({
      config,
      logger: buildTestLogger(lines),
      db: fakeDatabase({ healthy: false }),
    });

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('sup3r-s3cret');
    expect(JSON.parse(response.body)).toMatchObject({ checks: { database: 'error' } });

    await app.close();
  });

  it('health отвечает без обращения к базе', async () => {
    const app = await buildServer({
      config,
      logger: buildTestLogger([]),
      db: fakeDatabase({ healthy: false }),
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ok' });

    await app.close();
  });

  it('неизвестный путь API возвращает машинно-читаемую ошибку', async () => {
    const app = await buildServer({
      config,
      logger: buildTestLogger([]),
      db: fakeDatabase({ healthy: true }),
    });

    const response = await app.inject({ method: 'GET', url: '/api/unknown' });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it('в логе есть метод и путь, но нет строки запроса', async () => {
    const lines: string[] = [];
    const app = await buildServer({
      config,
      logger: buildTestLogger(lines),
      db: fakeDatabase({ healthy: true }),
    });

    await app.inject({ method: 'GET', url: '/health?phone=%2B79161234567' });
    await app.close();

    const output = lines.join('\n');

    expect(output).toContain('"method":"GET"');
    expect(output).toContain('"path":"/health?[redacted]"');
    expect(output).not.toContain('79161234567');
  });
});
