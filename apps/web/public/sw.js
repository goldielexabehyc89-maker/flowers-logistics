/*
 * Service worker.
 *
 * Кэшируются только оболочка приложения и статические ресурсы с версионированными
 * именами. Ответы API, пробы состояния, запросы с авторизацией и любые записи
 * не кэшируются и не перехватываются: персональные данные не должны переживать
 * выход из системы, а офлайн-очереди действий в проекте нет намеренно.
 *
 * Правила повторяют модуль src/pwa/cache-policy.ts, который покрыт критическими
 * тестами. Дублирование существует потому, что service worker подключается
 * отдельным скриптом, без сборщика. При изменении правил меняются оба файла.
 */

const CACHE_VERSION = 'fl-shell-v1';
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest'];
const NEVER_CACHED_PREFIXES = ['/api', '/health', '/ready'];

/*
 * Картографические архивы не кэшируются никогда: PMTiles и MBTiles — единые файлы
 * на сотни мегабайт, из которых карта читает небольшие куски диапазонными запросами.
 * Положить такой файл в кэш означало бы забить хранилище устройства ради одного экрана,
 * а сохранить кусок под адресом целого файла — однажды отдать карте обрывок.
 */
const NEVER_CACHED_EXTENSIONS = ['.pmtiles', '.mbtiles', '.osm.pbf', '.pbf'];

function isNeverCached(pathname) {
  return NEVER_CACHED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + '/'),
  );
}

function isCacheableRequest(request) {
  if (request.method !== 'GET') {
    return false;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return false;
  }
  if (isNeverCached(url.pathname)) {
    return false;
  }

  if (NEVER_CACHED_EXTENSIONS.some((extension) => url.pathname.toLowerCase().endsWith(extension))) {
    return false;
  }

  // Диапазонный запрос — это кусок файла, а не ресурс.
  if (request.headers.has('Range')) {
    return false;
  }

  return !request.headers.has('Authorization');
}

function isCacheableResponse(response) {
  if (!response || response.status !== 200 || response.type === 'opaque') {
    return false;
  }
  // 206 отсечён проверкой статуса; Content-Range страхует нестандартные ответы.
  if (response.headers.has('Content-Range')) {
    return false;
  }
  const cacheControl = response.headers.get('Cache-Control') || '';
  return !/no-store/i.test(cacheControl);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  // Записи и запросы к API проходят мимо service worker целиком.
  if (!isCacheableRequest(event.request)) {
    return;
  }

  const request = event.request;

  // Навигация: сеть в приоритете, кэш — запасной вариант, чтобы оболочка
  // открывалась без связи.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (isCacheableResponse(response)) {
            const copy = response.clone();
            void caches.open(CACHE_VERSION).then((cache) => cache.put('/index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('/index.html').then((cached) => cached || Response.error())),
    );
    return;
  }

  // Статические ресурсы: сначала кэш, затем сеть.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(request).then((response) => {
        if (isCacheableResponse(response)) {
          const copy = response.clone();
          void caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
