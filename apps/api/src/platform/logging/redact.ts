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

/**
 * Правила очистки произвольных строк.
 *
 * Редакции по имени поля недостаточно: секрет может оказаться внутри текста ошибки.
 * Так, ошибка подключения к PostgreSQL содержит строку подключения с паролем,
 * а ошибка HTTP-клиента — заголовок с токеном.
 */
const STRING_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // Учётные данные внутри URI: postgresql://user:password@host/db
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi,
    replacement: `$1${'[redacted]'}:${'[redacted]'}@`,
  },
  // JWT
  {
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/g,
    replacement: '[redacted]',
  },
  // Схемы авторизации
  { pattern: /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: '$1 [redacted]' },
  // Пары «имя = значение» для секретных имён, в том числе в параметрах строки подключения
  {
    pattern:
      /\b(password|passwd|pwd|token|secret|pepper|api[_-]?key|apikey|credential|pin|code)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&)]+)/gi,
    replacement: '$1=[redacted]',
  },
  // Телефоны в российском формате
  {
    pattern: /(?<!\d)(?:\+7|\b8|\b7)[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g,
    replacement: '[redacted]',
  },
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Очищает произвольную строку от секретов и телефонов.
 * Применяется к каждому строковому значению, к тексту сообщения и к стеку ошибки.
 */
export function redactString(text: string): string {
  let result = text;
  for (const rule of STRING_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

/**
 * Возвращает копию значения, в которой все чувствительные поля заменены на `[redacted]`.
 * Циклические ссылки заменяются на `[circular]`, слишком глубокие ветки — на `[truncated]`.
 */
export function redactDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

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
    // Текст и стек ошибки очищаются: ошибка подключения к базе содержит пароль,
    // ошибка внешнего вызова — токен, ошибка валидации — телефон.
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack === undefined ? {} : { stack: redactString(value.stack) }),
      ...(value.cause === undefined ? {} : { cause: redactDeep(value.cause, depth + 1, seen) }),
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
