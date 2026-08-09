/**
 * Критическая проверка политики кэширования service worker.
 *
 * Ответ API, попавший в кэш, переживает выход из системы и достаётся следующему
 * пользователю устройства. Запись, перехваченная service worker, создала бы
 * незаявленную офлайн-очередь.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { NEVER_CACHED_EXTENSIONS, shouldCacheRequest, shouldCacheResponse } from './cache-policy';

describe('что не кэшируется никогда', () => {
  it('любые запросы к API, health и ready', () => {
    const paths = [
      '/api/status',
      '/api/users',
      '/api/users/123/history',
      '/api/auth/me',
      '/health',
      '/ready',
    ];

    for (const path of paths) {
      expect(shouldCacheRequest({ method: 'GET', url: `https://app.example${path}` })).toBe(false);
    }
  });

  it('запросы записи не кэшируются и не перехватываются', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']) {
      expect(shouldCacheRequest({ method, url: 'https://app.example/index.html' })).toBe(false);
    }
  });

  it('запрос с заголовком Authorization не кэшируется', () => {
    expect(
      shouldCacheRequest({
        method: 'GET',
        url: 'https://app.example/assets/index-abc123.js',
        requestHeaders: { Authorization: 'Bearer secret' },
      }),
    ).toBe(false);

    // Регистр имени заголовка значения не имеет.
    expect(
      shouldCacheRequest({
        method: 'GET',
        url: 'https://app.example/assets/index-abc123.js',
        requestHeaders: { authorization: 'Bearer secret' },
      }),
    ).toBe(false);
  });

  it('картографические архивы не кэшируются ни при каких условиях', () => {
    const archives = [
      'https://app.example/maps/moscow.pmtiles',
      'https://app.example/maps/moscow.mbtiles',
      'https://app.example/maps/russia.osm.pbf',
      'https://app.example/tiles/12/2048/1024.pbf',
      // Регистр расширения роли не играет.
      'https://app.example/maps/MOSCOW.PMTILES',
      // Параметры запроса не должны обманывать проверку.
      'https://app.example/maps/moscow.pmtiles?v=2',
    ];

    for (const url of archives) {
      expect(shouldCacheRequest({ method: 'GET', url }), url).toBe(false);
    }
  });

  it('диапазонный запрос не кэшируется: это кусок файла, а не ресурс', () => {
    expect(
      shouldCacheRequest({
        method: 'GET',
        url: 'https://app.example/assets/index-abc123.js',
        requestHeaders: { Range: 'bytes=0-1023' },
      }),
    ).toBe(false);

    expect(
      shouldCacheRequest({
        method: 'GET',
        url: 'https://app.example/assets/index-abc123.js',
        requestHeaders: { range: 'bytes=1024-2047' },
      }),
    ).toBe(false);
  });

  it('частичный ответ в кэш не попадает', () => {
    expect(shouldCacheResponse(206, {})).toBe(false);
    expect(shouldCacheResponse(200, { 'Content-Range': 'bytes 0-1023/9999999' })).toBe(false);
    expect(shouldCacheResponse(200, { 'content-range': 'bytes 0-1023/9999999' })).toBe(false);
  });

  it('ответ с Cache-Control: no-store не кладётся в кэш', () => {
    expect(shouldCacheResponse(200, { 'Cache-Control': 'no-store' })).toBe(false);
    expect(shouldCacheResponse(200, { 'cache-control': 'private, no-store' })).toBe(false);
    expect(shouldCacheResponse(401, {})).toBe(false);
    expect(shouldCacheResponse(500, {})).toBe(false);
  });
});

describe('что кэшируется', () => {
  it('оболочка приложения и статические ресурсы', () => {
    const cacheable = [
      'https://app.example/',
      'https://app.example/index.html',
      'https://app.example/assets/index-abc123.js',
      'https://app.example/assets/index-abc123.css',
      'https://app.example/icons/icon-192.svg',
      'https://app.example/manifest.webmanifest',
    ];

    for (const url of cacheable) {
      expect(shouldCacheRequest({ method: 'GET', url })).toBe(true);
    }

    expect(shouldCacheResponse(200, { 'Cache-Control': 'public, max-age=31536000' })).toBe(true);
    expect(shouldCacheResponse(200, {})).toBe(true);
  });

  it('путь, лишь начинающийся похоже на api, не исключается по ошибке', () => {
    // «/apidocs» не является API-маршрутом приложения.
    expect(shouldCacheRequest({ method: 'GET', url: 'https://app.example/apidocs' })).toBe(true);
  });
});

describe('service worker повторяет правила модуля', () => {
  it('public/sw.js исключает те же расширения и диапазонные запросы', async () => {
    // Дублирование существует намеренно: sw.js подключается без сборщика.
    // Проверка держит обе копии в согласии.
    const code = await readFile(new URL('../../public/sw.js', import.meta.url), 'utf8');

    for (const extension of NEVER_CACHED_EXTENSIONS) {
      expect(code, extension).toContain(`'${extension}'`);
    }
    expect(code).toContain("headers.has('Range')");
    expect(code).toContain("headers.has('Content-Range')");
  });
});
