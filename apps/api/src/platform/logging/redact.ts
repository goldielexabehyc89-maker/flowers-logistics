/**
 * Глубокая редакция чувствительных значений перед записью в лог.
 *
 * Правило проекта: в логах не должно быть PIN-кодов, временных кодов активации, токенов,
 * cookies, заголовков авторизации, секретов и телефонов. Редакция выполняется по имени поля
 * на любой глубине, потому что объекты ошибок и запросов приходят произвольной формы.
 */

export const REDACTED = '[redacted]';

/** Имена полей, значение которых не должно попадать в лог ни в каком виде. */
const SENSITIVE_KEY_PATTERN =
  /^(pin|pin_?hash|code|code_?hash|activation_?code|token|access_?token|refresh_?token|token_?hash|authorization|cookie|set-cookie|password|passwd|secret|pepper|api_?key|apikey|credential|credentials|private_?key|phone|phone_?number|msisdn|tel|telephone)$/i;

const MAX_DEPTH = 8;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Возвращает копию значения, в которой все чувствительные поля заменены на `[redacted]`.
 * Циклические ссылки заменяются на `[circular]`, слишком глубокие ветки — на `[truncated]`.
 */
export function redactDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return '[truncated]';
  }

  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1, seen));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  // Экземпляры классов (объекты запроса и ответа Fastify) возвращаются как есть.
  // Их поля живут в прототипе, и обход через Object.entries превратил бы объект
  // в пустой, из-за чего сериализаторы pino потеряли бы метод и путь запроса.
  // Такие объекты обрабатываются сериализаторами со строгим белым списком полей.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactDeep(item, depth + 1, seen);
  }
  return result;
}

/**
 * Оставляет от URL только путь. Строка запроса может содержать телефон или код,
 * поэтому целиком в лог не пишется.
 */
export function safePath(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : `${url.slice(0, queryIndex)}?[redacted]`;
}
