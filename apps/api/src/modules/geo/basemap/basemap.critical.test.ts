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
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
import { basemapStatusOf, MAPS_PROVIDER } from './status.js';
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

  it('глифы в каталоге с пробелами отдаются, в том числе по percent-encoded адресу', async () => {
    // Настоящий набор держит 256 файлов глифов в каталоге «Noto Sans Regular».
    // Прежняя схема пути отвергала пробел, и подложка объявлялась ненастроенной
    // при совершенно исправных файлах — карта на staging не работала целиком.
    const manifest = await manifestOf();
    const glyphs = manifest.artifacts.find((artifact) => artifact.path.endsWith('.pbf'));

    expect(glyphs?.path).toBe('fonts/Noto Sans Regular/0-255.pbf');

    // Так путь выглядит в манифесте.
    const direct = await app.inject({ method: 'GET', url: `/maps/${glyphs?.path ?? ''}` });
    expect(direct.statusCode).toBe(200);
    expect(direct.headers['content-type']).toBe('application/x-protobuf');

    // А так его пришлёт браузер: MapLibre подставляет {fontstack} в адрес,
    // и пробел приезжает закодированным.
    const encoded = await app.inject({
      method: 'GET',
      url: '/maps/fonts/Noto%20Sans%20Regular/0-255.pbf',
    });
    expect(encoded.statusCode).toBe(200);
    expect(encoded.rawPayload.length).toBe(glyphs?.bytes);
    expect(encoded.rawPayload.equals(direct.rawPayload)).toBe(true);
  });

  it('percent-encoded обход каталога не отдаёт ни одного файла', async () => {
    for (const url of [
      '/maps/%2e%2e/%2e%2e/etc/passwd',
      '/maps/fonts/%2e%2e/%2e%2e/manifest.json',
      '/maps/..%2f..%2fetc%2fpasswd',
      '/maps/fonts/Noto%20Sans%20Regular/%2e%2e/%2e%2e/manifest.json',
    ]) {
      const response = await app.inject({ method: 'GET', url });

      // Часть таких адресов маршрутизатор сворачивает сам и до `/maps/*`
      // они не доходят — тогда отвечает оболочка приложения, как на любой
      // неизвестный адрес. Важно не то, каким кодом ответили, а то, что
      // содержимого файла наружу не ушло ни в одном случае.
      const type = String(response.headers['content-type'] ?? '');
      expect(type, url).not.toContain('application/octet-stream');
      expect(type, url).not.toContain('application/x-protobuf');
      expect(type, url).not.toContain('image/png');
      expect(response.body, url).not.toContain('flowers-logistics/basemap-manifest');
      expect(response.body, url).not.toContain('root:');

      if (response.statusCode === 200) {
        // Это оболочка SPA, а не артефакт.
        expect(type, url).toContain('text/html');
      } else {
        expect(response.statusCode, url).toBe(404);
      }
    }
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

describe('манифест и границы каталога набора', () => {
  it('набор с пробелами в путях загружается без MANIFEST_INVALID', async () => {
    // Тот самый случай, из-за которого карта на staging не работала:
    // файлы целы, суммы совпадают, а манифест отвергался схемой пути.
    const state = await loadBasemap(root);

    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.manifest.artifacts.some((artifact) => artifact.path.includes(' '))).toBe(true);
    }
  });

  it('символическая ссылка за пределы каталога отклоняется', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'fl-basemap-outside-'));
    const set = await mkdtemp(path.join(tmpdir(), 'fl-basemap-symlink-'));

    try {
      const secret = path.join(outside, 'secret.pbf');
      await writeFile(secret, 'посторонний файл', 'utf8');

      const linked = path.join(set, 'escape.pbf');
      await symlink(secret, linked);

      const bytes = (await stat(linked)).size;
      const sha = createHash('sha256')
        .update(await readFile(linked))
        .digest('hex');

      await writeFile(
        path.join(set, 'manifest.json'),
        JSON.stringify({
          format: 'flowers-logistics/basemap-manifest@1',
          revision: 'test0001',
          region: 'Тест',
          bbox: [0, 0, 1, 1],
          sourceDate: '2026-08-06',
          sourceSha256: 'a'.repeat(64),
          tools: { planetiler: 'test' },
          attribution: '© OpenStreetMap contributors',
          style: 'escape.pbf',
          artifacts: [
            { path: 'escape.pbf', bytes, sha256: sha, contentType: 'application/x-protobuf' },
          ],
        }),
        'utf8',
      );

      // Посегментной проверки мало: ссылка проходит её целиком, а ведёт наружу.
      const state = await loadBasemap(set);
      expect(state.ok).toBe(false);
      if (!state.ok) {
        expect(state.problem).toBe('ARTIFACT_OUTSIDE_ROOT');
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(set, { recursive: true, force: true });
    }
  });

  it('недопустимый путь в манифесте объявляет карту ненастроенной', async () => {
    const set = await mkdtemp(path.join(tmpdir(), 'fl-basemap-bad-path-'));

    try {
      await writeFile(
        path.join(set, 'manifest.json'),
        JSON.stringify({
          format: 'flowers-logistics/basemap-manifest@1',
          revision: 'test0001',
          region: 'Тест',
          bbox: [0, 0, 1, 1],
          sourceDate: '2026-08-06',
          sourceSha256: 'a'.repeat(64),
          tools: { planetiler: 'test' },
          attribution: '© OpenStreetMap contributors',
          style: '../outside.json',
          artifacts: [
            {
              path: '../outside.json',
              bytes: 1,
              sha256: 'b'.repeat(64),
              contentType: 'application/json',
            },
          ],
        }),
        'utf8',
      );

      const state = await loadBasemap(set);
      expect(state.ok).toBe(false);
      if (!state.ok) {
        expect(state.problem).toBe('MANIFEST_INVALID');
      }
    } finally {
      await rm(set, { recursive: true, force: true });
    }
  });
});

describe('индикатор интеграции «карта»', () => {
  it('исправная подложка переводит индикатор в OK', async () => {
    const status = await db.integrationStatus.findUnique({
      where: { provider: MAPS_PROVIDER },
    });

    // Запись появилась заглушкой на этапе 1 и не обновлялась: интерфейс
    // показывал «Интеграция не настроена» при полностью работающей карте.
    expect(status?.state).toBe('OK');
    expect(JSON.stringify(status?.details)).toContain('test0001');
  });

  it('состояние выводится из той же проверки, что решает судьбу /maps', () => {
    expect(basemapStatusOf({ ok: false, problem: 'NOT_CONFIGURED' })).toEqual({
      state: 'NOT_CONFIGURED',
      details: { reason: 'no-artifacts-path' },
    });

    // «Не настроена» и «настроена, но не сошлась» — разные вещи: второе отказ.
    expect(
      basemapStatusOf({ ok: false, problem: 'CHECKSUM_MISMATCH', artifact: 'tiles.pmtiles' }),
    ).toEqual({
      state: 'ERROR',
      details: { reason: 'CHECKSUM_MISMATCH', artifact: 'tiles.pmtiles' },
    });
    expect(basemapStatusOf({ ok: false, problem: 'MANIFEST_INVALID' })).toEqual({
      state: 'ERROR',
      details: { reason: 'MANIFEST_INVALID', artifact: null },
    });
  });

  it('в индикатор не уходят пути, суммы и содержимое манифеста', async () => {
    const status = await db.integrationStatus.findUniqueOrThrow({
      where: { provider: MAPS_PROVIDER },
    });
    const details = JSON.stringify(status.details);

    expect(details).not.toContain('/');
    expect(details).not.toContain('sha256');
    expect(details).not.toMatch(/[0-9a-f]{64}/);
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
