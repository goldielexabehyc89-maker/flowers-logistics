/**
 * Хранение ПРИМЕНЁННОГО фильтра времени карты «Сделок» — раздельно по userId.
 *
 * Сохраняется только применённое значение (не черновик во время ввода), поэтому
 * фильтр переживает переходы между разделами, перезагрузку, закрытие браузера и
 * повторный вход того же пользователя. Ключ содержит userId, чтобы сотрудники на
 * общем компьютере не получали фильтры друг друга. Некорректное сохранённое
 * значение молча игнорируется — оно не должно ломать экран.
 *
 * Чистые функции над `localStorage`: любой доступ обёрнут в try/catch (приватное
 * окно, запрет хранилища, недоступность в превью), и при любой неудаче фильтр
 * просто считается пустым.
 */

export interface StoredTimeFilter {
  from: string;
  to: string;
}

const PREFIX = 'deals-map-time-filter';
/** Пусто или настоящее время `ЧЧ:ММ` (00–23:00–59). Прочее — «игнорируем». */
const TIME = /^(([01]\d|2[0-3]):[0-5]\d)?$/;

export function timeFilterStorageKey(userId: string | null | undefined): string {
  return `${PREFIX}:${userId ?? 'anon'}`;
}

/** Разбор сохранённой строки. Любая порча значения даёт пустой фильтр. */
export function parseTimeFilter(raw: string | null): StoredTimeFilter {
  if (raw === null) {
    return { from: '', to: '' };
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) {
      return { from: '', to: '' };
    }
    const record = value as { from?: unknown; to?: unknown };
    const from = typeof record.from === 'string' && TIME.test(record.from) ? record.from : '';
    const to = typeof record.to === 'string' && TIME.test(record.to) ? record.to : '';
    return { from, to };
  } catch {
    return { from: '', to: '' };
  }
}

export function readTimeFilter(userId: string | null | undefined): StoredTimeFilter {
  try {
    return parseTimeFilter(window.localStorage.getItem(timeFilterStorageKey(userId)));
  } catch {
    return { from: '', to: '' };
  }
}

export function writeTimeFilter(userId: string | null | undefined, value: StoredTimeFilter): void {
  try {
    if (value.from === '' && value.to === '') {
      // Пустой фильтр не храним: «нет фильтра» — это отсутствие записи.
      window.localStorage.removeItem(timeFilterStorageKey(userId));
      return;
    }
    window.localStorage.setItem(timeFilterStorageKey(userId), JSON.stringify(value));
  } catch {
    // Хранилище недоступно — фильтр останется только в памяти вкладки.
  }
}

export function clearTimeFilter(userId: string | null | undefined): void {
  try {
    window.localStorage.removeItem(timeFilterStorageKey(userId));
  } catch {
    // Ничего: очистка недоступного хранилища — не ошибка.
  }
}
