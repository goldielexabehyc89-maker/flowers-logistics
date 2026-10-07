/**
 * Перечитывает запрос со счётчиком «В сборке», когда сдвигается граница дня.
 *
 * Тонкая обёртка над `assembly-day.ts`: срок считается из окна последнего
 * ответа, таймер переставляется после каждого нового ответа и снимается при
 * уходе с экрана. Почему срок задаёт сервер и зачем сторож — там же.
 */

import { useEffect, useRef } from 'react';
import {
  assemblyRefreshDeadline,
  scheduleAssemblyRefresh,
  type AssemblyCounterWindow,
} from './assembly-day';

export function useAssemblyDayRefresh(
  counter: AssemblyCounterWindow | undefined,
  /** `dataUpdatedAt` запроса: когда получен ответ с этим окном. */
  receivedAt: number,
  refresh: () => unknown,
): void {
  // Ссылка на колбэк: иначе каждая отрисовка переставляла бы таймер.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const deadline = assemblyRefreshDeadline(counter, receivedAt);

  useEffect(() => {
    if (deadline === null) {
      return undefined;
    }
    return scheduleAssemblyRefresh(deadline, () => {
      void refreshRef.current();
    });
  }, [deadline]);
}
