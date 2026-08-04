/**
 * Критическая проверка политики кэширования service worker.
 *
 * Ответ API, попавший в кэш, переживает выход из системы и достаётся следующему
 * пользователю устройства. Запись, перехваченная service worker, создала бы
 * незаявленную офлайн-очередь.
 */

import { describe, expect, it } from 'vitest';
import { shouldCacheRequest, shouldCacheResponse } from './cache-policy';

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
