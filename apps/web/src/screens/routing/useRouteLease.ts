/**
 * Клиент мягкой блокировки редактора.
 *
 * Открыли карточку — берём маршрут в работу; пока карточка открыта, раз в 30 секунд
 * подтверждаем присутствие; закрыли — освобождаем. Сердцебиение намеренно не трогает
 * ни кэш запросов, ни состояние компонента: иначе экран перерисовывался бы дважды
 * в минуту, а всплывающие сообщения появлялись бы у логиста весь день.
 *
 * Потеря блокировки — не ошибка, а нормальная ситуация: маршрут могли перехватить.
 * Поэтому карточка просто переходит в режим просмотра, а данные перезапрашиваются.
 */

import { useEffect, useRef } from 'react';
import type { ApiClient } from '../../lib/api-client';

/** Совпадает с серверным: аренда живёт 90 секунд, подтверждаем втрое чаще. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface LeaseOptions {
  client: ApiClient;
  routeId: string | null;
  /** Аренда нужна только черновику: подтверждённый маршрут не редактируется. */
  enabled: boolean;
  /** Вызывается после захвата и после потери аренды: карточку нужно перечитать. */
  onChanged: () => void;
}

/**
 * Удерживает аренду, пока открыта карточка черновика.
 *
 * Захват при открытии выполняется молча: занятый маршрут — обычное дело, и его
 * состояние карточка покажет сама, без сообщения об ошибке.
 */
export function useRouteLease({ client, routeId, enabled, onChanged }: LeaseOptions): void {
  // Ссылка на колбэк: иначе каждое обновление карточки перезапускало бы таймер
  // и сердцебиение уходило бы чаще, чем нужно.
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  useEffect(() => {
    if (routeId === null || !enabled) {
      return;
    }

    let stopped = false;

    const acquire = async (): Promise<void> => {
      try {
        await client.post(`/api/routes/${routeId}/edit-lock/acquire`, {});
      } catch {
        // Маршрут занят или уже не черновик — это состояние, а не сбой.
        // Карточка покажет держателя и предложит перехват.
      }
      if (!stopped) {
        changedRef.current();
      }
    };

    void acquire();

    const timer = setInterval(() => {
      void (async () => {
        try {
          await client.post(`/api/routes/${routeId}/edit-lock/heartbeat`, {});
        } catch {
          // Аренду перехватили или она истекла. Тихо сообщаем карточке: она
          // перечитает состояние и перейдёт в режим просмотра.
          if (!stopped) {
            changedRef.current();
          }
        }
      })();
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      stopped = true;
      clearInterval(timer);
      // Освобождение best-effort: закрытие вкладки не должно ничего ломать,
      // а забытую аренду всё равно снимет истечение.
      void client.post(`/api/routes/${routeId}/edit-lock/release`, {}).catch(() => undefined);
    };
  }, [client, routeId, enabled]);
}
