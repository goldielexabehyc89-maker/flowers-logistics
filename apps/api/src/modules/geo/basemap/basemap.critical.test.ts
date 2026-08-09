/**
 * Критические проверки собственной подложки.
 *
 * Проверяется то, нарушение чего опасно: браузер обязан получать всё с нашего
 * origin и не ходить на публичные картографические серверы; диапазонные запросы
 * обязаны работать по спецификации; несовпадение контрольной суммы обязано
 * означать «карта не настроена», а не попытку продолжить.
 *
 * Гигабайтные наборы здесь не нужны: временный набор создаётся генератором
 * вне Git и весит несколько килобайт.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { buildServer } from '../../../platform/http/server.js';
import { createDatabase } from '../../../platform/db.js';
import { loadConfig } from '../../../platform/config.js';
import { resolveTestDatabaseUrl } from '../../../platform/testing/test-database.js';
import { TEST_SECRETS } from '../../../platform/testing/secrets.js';
import { seedUser } from '../../auth/testing/harness.js';
import type { AppServer } from '../../../platform/http/types.js';
import type { Database } from '../../../platform/db.js';
import { loadBasemap, type BasemapManifest } from './manifest.js';
import { contentRange, parseRange } from './range.js';

const run = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const generator = path.resolve(here, '../../../../../../tools/geo/make-test-pmtiles.mjs');

let root: string;
let db: Database;
let app: AppServer;

const logger = pino({ level: 'silent' });

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: resolveTestDatabaseUrl(),
    APP_ENV: 'local',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...TEST_SECRETS,
    ...overrides,
  });
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'fl-basemap-'));
  // Настоящий, но крошечный набор: ни одного сетевого обращения.
  await run(process.execPath, [generator, root]);

  const config = testConfig({ MAP_ARTIFACTS_PATH: root });
  db = createDatabase(config, logger);
  app = await buildServer({
    config,
    logger,
    db,
    notifier: {
      subscribe: () => () => undefined,
      start: () => undefined,
      stop: async () => undefined,
    },
  });
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
});

async function manifestOf(): Promise<BasemapManifest> {
  return JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as BasemapManifest;
}

async function tokenFor(): Promise<string> {
  const { hashSecretCode } = await import('../../auth/crypto.js');
  const { login } = await import('../../auth/service.js');
  const pin = '1234';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(db, { roles: ['LOGISTICIAN'], status: 'ACTIVE', pinHash });
  const session = await login(
    { db, config: testConfig() },
    { phone: user.phone, pin },
    { ip: null, userAgent: 'vitest', deviceLabel: null },
  );
  return session.accessToken;
}

describe('манифест и проверка целостности', () => {
  it('корректный набор проходит проверку целиком', async () => {
    const state = await loadBasemap(root);
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.manifest.artifacts.length).toBeGreaterThanOrEqual(5);
      expect(state.artifacts.has(state.manifest.style)).toBe(true);
    }
  });

  it('отсутствие каталога и манифеста — это «карта не настроена»', async () => {
    expect(await loadBasemap(undefined)).toMatchObject({ problem: 'NOT_CONFIGURED' });
    expect(await loadBasemap('')).toMatchObject({ problem: 'NOT_CONFIGURED' });

    const empty = await mkdtemp(path.join(tmpdir(), 'fl-basemap-empty-'));
    try {
      expect(await loadBasemap(empty)).toMatchObject({ problem: 'MANIFEST_MISSING' });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('подменённый файл отвергается по контрольной сумме', async () => {
    const copy = await mkdtemp(path.join(tmpdir(), 'fl-basemap-bad-'));
    try {
      await run(process.execPath, [generator, copy]);
      const manifest = JSON.parse(
        await readFile(path.join(copy, 'manifest.json'), 'utf8'),
      ) as BasemapManifest;

      const tiles = manifest.artifacts.find((artifact) => artifact.path.endsWith('.pmtiles'));
      expect(tiles).toBeDefined();

      // Тот же размер, другое содержимое: подмена архива не должна выглядеть
      // как обычная работа.
      await writeFile(path.join(copy, tiles?.path ?? ''), Buffer.alloc(tiles?.bytes ?? 0, 0x7f));

      expect(await loadBasemap(copy)).toMatchObject({ problem: 'CHECKSUM_MISMATCH' });
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('другой размер файла отвергается до пересчёта суммы', async () => {
    const copy = await mkdtemp(path.join(tmpdir(), 'fl-basemap-size-'));
    try {
      await run(process.execPath, [generator, copy]);
      const manifest = JSON.parse(
        await readFile(path.join(copy, 'manifest.json'), 'utf8'),
      ) as BasemapManifest;
      const style = manifest.style;

      await writeFile(path.join(copy, style), '{}');
      expect(await loadBasemap(copy)).toMatchObject({ problem: 'SIZE_MISMATCH' });
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('манифест чужого формата не принимается', async () => {
    const copy = await mkdtemp(path.join(tmpdir(), 'fl-basemap-format-'));
    try {
      await run(process.execPath, [generator, copy]);
      await writeFile(
        path.join(copy, 'manifest.json'),
        JSON.stringify({ format: 'someone-else/manifest@9' }),
      );
      expect(await loadBasemap(copy)).toMatchObject({ problem: 'MANIFEST_INVALID' });
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('манифест с суммами вспомогательных источников принимается', async () => {
    const copy = await mkdtemp(path.join(tmpdir(), 'fl-basemap-inputs-'));
    try {
      await run(process.execPath, [generator, copy]);
      const manifest = JSON.parse(
        await readFile(path.join(copy, 'manifest.json'), 'utf8'),
      ) as BasemapManifest & { inputs?: Record<string, string> };

      // Вспомогательные наборы влияют на результат так же, как исходный
      // .osm.pbf: другая версия береговой линии — другие тайлы.
      manifest.inputs = {
        'lake_centerline.shp.zip': 'a'.repeat(64),
        'water-polygons-split-3857.zip': 'b'.repeat(64),
        'natural_earth_vector.sqlite.zip': 'c'.repeat(64),
      };
      await writeFile(path.join(copy, 'manifest.json'), JSON.stringify(manifest));

      const state = await loadBasemap(copy);
      expect(state.ok).toBe(true);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('набор без поля вспомогательных источников остаётся пригодным', async () => {
    // Наборы, собранные до появления поля, не должны внезапно стать
    // «ненастроенной картой»: подложка от этого не портится.
    const state = await loadBasemap(root);
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.manifest.inputs).toBeUndefined();
    }
  });

  it('мусор вместо контрольной суммы источника отвергается', async () => {
    const copy = await mkdtemp(path.join(tmpdir(), 'fl-basemap-badinput-'));
    try {
      await run(process.execPath, [generator, copy]);
      const manifest = JSON.parse(
        await readFile(path.join(copy, 'manifest.json'), 'utf8'),
      ) as BasemapManifest & { inputs?: Record<string, string> };

      manifest.inputs = { 'water-polygons-split-3857.zip': 'не-сумма' };
      await writeFile(path.join(copy, 'manifest.json'), JSON.stringify(manifest));

      expect(await loadBasemap(copy)).toMatchObject({ problem: 'MANIFEST_INVALID' });
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('путь с выходом за каталог отвергается схемой', async () => {
    const copy = await mkdtemp(path.join(tmpdir(), 'fl-basemap-escape-'));
    try {
      await run(process.execPath, [generator, copy]);
      const manifest = JSON.parse(
        await readFile(path.join(copy, 'manifest.json'), 'utf8'),
      ) as BasemapManifest;

      manifest.artifacts.push({
        path: '../../etc/passwd',
        bytes: 1,
        sha256: 'a'.repeat(64),
        contentType: 'application/octet-stream',
      });
      await writeFile(path.join(copy, 'manifest.json'), JSON.stringify(manifest));

      expect(await loadBasemap(copy)).toMatchObject({ problem: 'MANIFEST_INVALID' });
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });
});

describe('стиль ссылается только на наш origin', () => {
  it('ни одного адреса публичного картографического сервера', async () => {
    const manifest = await manifestOf();
    const style = await readFile(path.join(root, manifest.style), 'utf8');

    for (const forbidden of [
      'tile.openstreetmap.org',
      'demotiles.maplibre.org',
      'api.maptiler.com',
      'basemaps.protomaps.com',
      'tiles.protomaps.com',
      'openmaptiles.com',
      'mapbox.com',
    ]) {
      expect(style, forbidden).not.toContain(forbidden);
    }

    // Абсолютных адресов в стиле нет вовсе: только относительные пути.
    expect(style).not.toMatch(/https?:\/\//);
  });

  it('атрибуция OpenStreetMap присутствует', async () => {
    const manifest = await manifestOf();
    const style = await readFile(path.join(root, manifest.style), 'utf8');

    expect(manifest.attribution).toContain('OpenStreetMap');
    expect(style).toContain('OpenStreetMap');
  });
});

describe('разбор Range', () => {
  it('обычный диапазон, открытый конец и суффикс', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({
      kind: 'PARTIAL',
      start: 0,
      end: 99,
      length: 100,
    });
    expect(parseRange('bytes=500-', 1000)).toEqual({
      kind: 'PARTIAL',
      start: 500,
      end: 999,
      length: 500,
    });
    expect(parseRange('bytes=-100', 1000)).toEqual({
      kind: 'PARTIAL',
      start: 900,
      end: 999,
      length: 100,
    });
    // Конец за пределами файла обрезается по размеру.
    expect(parseRange('bytes=900-5000', 1000)).toEqual({
      kind: 'PARTIAL',
      start: 900,
      end: 999,
      length: 100,
    });
  });

  it('отсутствие и нераспознанный заголовок означают полный файл', () => {
    expect(parseRange(undefined, 1000)).toEqual({ kind: 'FULL' });
    expect(parseRange('', 1000)).toEqual({ kind: 'FULL' });
    // Составной диапазон требует multipart-ответа, которого мы не отдаём:
    // безопаснее вернуть файл целиком, чем первый кусок под видом всего.
    expect(parseRange('bytes=0-10,20-30', 1000)).toEqual({ kind: 'FULL' });
    expect(parseRange('items=0-10', 1000)).toEqual({ kind: 'FULL' });
  });

  it('неудовлетворимый диапазон распознаётся отдельно', () => {
    expect(parseRange('bytes=1000-', 1000)).toEqual({ kind: 'UNSATISFIABLE' });
    expect(parseRange('bytes=900-800', 1000)).toEqual({ kind: 'UNSATISFIABLE' });
    expect(parseRange('bytes=0-10', 0)).toEqual({ kind: 'UNSATISFIABLE' });
  });

  it('заголовок Content-Range собирается по спецификации', () => {
    expect(contentRange(0, 99, 1000)).toBe('bytes 0-99/1000');
  });
});

describe('раздача артефактов', () => {
  it('файл отдаётся целиком с бессрочным кэшированием', async () => {
    const manifest = await manifestOf();
    const tiles = manifest.artifacts.find((artifact) => artifact.path.endsWith('.pmtiles'));

    const response = await app.inject({ method: 'GET', url: `/maps/${tiles?.path ?? ''}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['cache-control']).toContain('immutable');
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.rawPayload.length).toBe(tiles?.bytes);
  });

  it('диапазонный запрос отдаёт 206 и корректный Content-Range', async () => {
    const manifest = await manifestOf();
    const tiles = manifest.artifacts.find((artifact) => artifact.path.endsWith('.pmtiles'));
    const size = tiles?.bytes ?? 0;

    const response = await app.inject({
      method: 'GET',
      url: `/maps/${tiles?.path ?? ''}`,
      headers: { range: 'bytes=0-126' },
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 0-126/${size}`);
    expect(response.headers['content-length']).toBe('127');
    expect(response.rawPayload.length).toBe(127);
    // Первые байты архива — заголовок PMTiles v3.
    expect(response.rawPayload.subarray(0, 7).toString('ascii')).toBe('PMTiles');
    expect(response.rawPayload[7]).toBe(3);
  });

  it('неудовлетворимый диапазон даёт 416 с размером файла', async () => {
    const manifest = await manifestOf();
    const tiles = manifest.artifacts.find((artifact) => artifact.path.endsWith('.pmtiles'));
    const size = tiles?.bytes ?? 0;

    const response = await app.inject({
      method: 'GET',
      url: `/maps/${tiles?.path ?? ''}`,
      headers: { range: `bytes=${size + 10}-` },
    });

    expect(response.statusCode).toBe(416);
    expect(response.headers['content-range']).toBe(`bytes */${size}`);
  });

  it('файл вне манифеста не отдаётся, даже если лежит в каталоге', async () => {
    await writeFile(path.join(root, 'secret.json'), '{"token":"должен остаться внутри"}');

    const response = await app.inject({ method: 'GET', url: '/maps/secret.json' });
    expect(response.statusCode).toBe(404);
  });

  it('манифест наружу не отдаётся ни одним написанием пути', async () => {
    // Сам манифест в белый список не входит: он описывает набор, а не является
    // его частью. Проверяется главное — его содержимое не уходит наружу
    // ни прямым запросом, ни попыткой выйти за каталог.
    const urls = [
      '/maps/manifest.json',
      '/maps/%2e%2e/manifest.json',
      '/maps/sprite/%2e%2e/%2e%2e/manifest.json',
      '/maps/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    ];

    for (const url of urls) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.body, url).not.toContain('flowers-logistics/basemap-manifest');
      expect(response.body, url).not.toContain('sourceSha256');
    }

    // Прямой запрос отвергается маршрутом: файла нет в белом списке.
    expect((await app.inject({ method: 'GET', url: '/maps/manifest.json' })).statusCode).toBe(404);
  });
});

describe('конфигурация карты для браузера', () => {
  it('отдаёт адрес нашего origin, атрибуцию и честный режим пробок', async () => {
    const token = await tokenFor();
    const response = await app.inject({
      method: 'GET',
      url: '/api/map/config',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      configured: boolean;
      source: string;
      styleUrl: string;
      attribution: string;
      trafficMode: string;
      routingAvailable: boolean;
    };

    expect(body.configured).toBe(true);
    expect(body.source).toBe('SELF_HOSTED');
    // Относительный адрес нашего origin: внешних хостов в конфигурации нет.
    expect(body.styleUrl.startsWith('/maps/')).toBe(true);
    expect(body.attribution).toContain('OpenStreetMap');
    // Живых пробок в собственном стеке нет, и интерфейс обязан это знать.
    expect(body.trafficMode).toBe('STATIC');
    expect(body.routingAvailable).toBe(false);
  });

  it('внешний стиль допустим только в локальной разработке', async () => {
    // Каталог без манифеста: собственная подложка неисправна.
    const broken = await mkdtemp(path.join(tmpdir(), 'fl-basemap-broken-'));

    try {
      for (const env of ['staging', 'production'] as const) {
        const config = loadConfig({
          DATABASE_URL: resolveTestDatabaseUrl(),
          APP_ENV: env,
          APP_ENVIRONMENT_MARKER: env,
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
          MAP_ARTIFACTS_PATH: broken,
          MAP_STYLE_URL: 'https://tiles.example.invalid/style.json',
          MAP_ATTRIBUTION: '© Кто-то посторонний',
          ...TEST_SECRETS,
        });

        const server = await buildServer({
          config,
          logger,
          db,
          notifier: {
            subscribe: () => () => undefined,
            start: () => undefined,
            stop: async () => undefined,
          },
        });

        try {
          const response = await server.inject({
            method: 'GET',
            url: '/api/map/config',
            headers: { authorization: `Bearer ${await tokenFor()}` },
          });

          const body = response.json() as { configured: boolean; styleUrl: string | null };

          // Подмена неисправной подложки чужим сервером — это тот самый
          // молчаливый внешний запрос, который запрещён.
          expect(body.configured, env).toBe(false);
          expect(body.styleUrl, env).toBeNull();
          expect(response.body, env).not.toContain('tiles.example.invalid');
        } finally {
          await server.close();
        }
      }

      // В локальной разработке заранее заданный адрес по-прежнему разрешён.
      const localConfig = loadConfig({
        DATABASE_URL: resolveTestDatabaseUrl(),
        APP_ENV: 'local',
        APP_ENVIRONMENT_MARKER: 'local',
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        MAP_ARTIFACTS_PATH: broken,
        MAP_STYLE_URL: 'http://127.0.0.1:8080/style.json',
        ...TEST_SECRETS,
      });

      const localServer = await buildServer({
        config: localConfig,
        logger,
        db,
        notifier: {
          subscribe: () => () => undefined,
          start: () => undefined,
          stop: async () => undefined,
        },
      });

      try {
        const response = await localServer.inject({
          method: 'GET',
          url: '/api/map/config',
          headers: { authorization: `Bearer ${await tokenFor()}` },
        });
        const body = response.json() as { configured: boolean; source: string };
        expect(body.configured).toBe(true);
        expect(body.source).toBe('EXTERNAL_STYLE');
      } finally {
        await localServer.close();
      }
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  it('расчёт обещается только после подтверждения маршрутизатора', async () => {
    const token = await tokenFor();

    // Маршрутизатор не подтверждён: состояние интеграции не OK.
    await db.integrationStatus.upsert({
      where: { provider: 'valhalla' },
      create: { provider: 'valhalla', state: 'ERROR' },
      update: { state: 'ERROR' },
    });

    const denied = await app.inject({
      method: 'GET',
      url: '/api/map/config',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((denied.json() as { routingAvailable: boolean }).routingAvailable).toBe(false);

    // И даже при OK — только если адрес сервиса задан.
    await db.integrationStatus.update({
      where: { provider: 'valhalla' },
      data: { state: 'OK' },
    });

    const stillDenied = await app.inject({
      method: 'GET',
      url: '/api/map/config',
      headers: { authorization: `Bearer ${token}` },
    });
    // В этой сборке VALHALLA_URL не задан, поэтому обещать нечего.
    expect((stillDenied.json() as { routingAvailable: boolean }).routingAvailable).toBe(false);
  });

  it('адрес маршрутизатора в браузер не попадает', async () => {
    const token = await tokenFor();
    const response = await app.inject({
      method: 'GET',
      url: '/api/map/config',
      headers: { authorization: `Bearer ${token}` },
    });

    const text = response.body;
    expect(text).not.toContain('valhalla');
    expect(text).not.toContain('8002');
    expect(Object.keys(response.json() as Record<string, unknown>)).not.toContain('valhallaUrl');
  });
});
