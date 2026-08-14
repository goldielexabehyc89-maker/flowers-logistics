/**
 * Ожидание, которое не мешает остановке.
 *
 * Обработчик спит между опросами очереди. Если бы сон нельзя было прервать,
 * закрытие окна и остановка задачи планировщика ждали бы полного интервала —
 * а установщик, снимающий задачу перед обновлением, ждал бы вместе с ними.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal !== undefined && signal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Задержка перед повтором: удвоение с потолком.
 *
 * Потолок обязателен. Ночью сервер бывает недоступен часами, и без него
 * пауза выросла бы до суток: утром флорист включил бы принтер и ждал бы
 * первого бланка неизвестно сколько.
 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}
