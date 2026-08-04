/**
 * Политика кэширования service worker.
 *
 * Кэшируются только оболочка приложения и статические ресурсы. Ответы API,
 * пробы состояния и любые запросы с авторизацией не попадают в кэш никогда:
 * иначе персональные данные и признаки сессии пережили бы выход из системы
 * и остались бы доступны следующему пользователю устройства.
 *
 * Клиентской очереди записей нет: без сети рабочие действия честно сообщают
 * «Нет связи», а не притворяются выполненными.
 *
 * Этот модуль — источник истины правил. Файл `public/sw.js` повторяет их
 * без сборщика, потому что service worker подключается как отдельный скрипт.
 */

/** Префиксы, которые не кэшируются ни при каких условиях. */
export const NEVER_CACHED_PREFIXES = ['/api', '/health', '/ready'] as const;

export interface CacheDecisionInput {
  method: string;
  url: string;
  /** Заголовки запроса: наличие Authorization запрещает кэширование. */
  requestHeaders?: Record<string, string> | undefined;
}

function pathnameOf(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url;
  }
}

/** Можно ли вообще рассматривать запрос как кандидата на кэширование. */
export function shouldCacheRequest(input: CacheDecisionInput): boolean {
  // Записи не кэшируются и не перехватываются: очереди офлайн-действий нет.
  if (input.method.toUpperCase() !== 'GET') {
    return false;
  }

  const pathname = pathnameOf(input.url);
  if (
    NEVER_CACHED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  ) {
    return false;
  }

  const headers = input.requestHeaders ?? {};
  const hasAuthorization = Object.keys(headers).some(
    (name) => name.toLowerCase() === 'authorization',
  );

  return !hasAuthorization;
}

/** Можно ли положить в кэш конкретный ответ. */
export function shouldCacheResponse(status: number, headers: Record<string, string>): boolean {
  if (status !== 200) {
    return false;
  }

  const cacheControl = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'cache-control',
  )?.[1];

  if (cacheControl !== undefined && /no-store/i.test(cacheControl)) {
    return false;
  }

  return true;
}
