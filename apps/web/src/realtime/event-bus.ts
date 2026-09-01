/**
 * Лёгкая шина живых realtime-событий.
 *
 * Инвалидация react-query покрывает списки и счётчики, но всплывающему окну
 * нужен САМ факт живого события с его идентификаторами. Шина отдаёт каждое
 * обработанное `useRealtime` событие подписчикам.
 *
 * Ключевое свойство — только ЖИВЫЕ события: после переподключения поток
 * начинается с головы журнала и старый архив не воспроизводится, поэтому окна
 * не всплывают повторно после reconnect или перезагрузки.
 */

export type RealtimeEventListener = (event: string, data: string) => void;

const listeners = new Set<RealtimeEventListener>();

/** Подписаться на живые события. Возвращает функцию отписки. */
export function subscribeRealtimeEvents(listener: RealtimeEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Разослать событие подписчикам. Ошибка одного не мешает остальным. */
export function dispatchRealtimeEvent(event: string, data: string): void {
  for (const listener of listeners) {
    try {
      listener(event, data);
    } catch {
      // Подписчик не должен ронять обработку realtime.
    }
  }
}
