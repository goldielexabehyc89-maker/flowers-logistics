/**
 * Клиент мягкой блокировки редактора.
 *
 * Открыли карточку черновика — один раз пробуем взять маршрут в работу. Дальше
 * сердцебиение идёт ТОЛЬКО пока свежая карточка подтверждает, что аренду держит
 * именно эта вкладка: чужая карточка не должна каждые тридцать секунд отправлять
 * заведомо отказной запрос и заставлять интерфейс перечитывать данные.
 *
 * Освобождение при закрытии выполняется только если вкладка действительно
 * держала аренду: иначе закрытие чужой карточки пыталось бы снять чужую
 * блокировку.
 *
 * Потеря аренды — не ошибка, а нормальная ситуация: маршрут могли перехватить.
 * Карточка просто переходит в режим просмотра.
 */

import { useEffect, useRef } from 'react';
import type { ApiClient } from '../../lib/api-client';
import { createHeartbeatController } from './lease-controller';

/** Совпадает с серверным: аренда живёт 90 секунд, подтверждаем втрое чаще. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface LeaseOptions {
  client: ApiClient;
  routeId: string | null;
  /** Аренда нужна только черновику: подтверждённый маршрут не редактируется. */
  enabled: boolean;
  /** Держит ли аренду именно эта вкладка. Берётся из свежей карточки. */
  heldByCurrentSession: boolean;
  /** Вызывается после захвата и после потери аренды: карточку нужно перечитать. */
  onChanged: () => void;
}

export function useRouteLease({
  client,
  routeId,
  enabled,
  heldByCurrentSession,
  onChanged,
}: LeaseOptions): void {
  // Ссылка на колбэк: иначе каждое обновление карточки перезапускало бы эффект.
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  // Признак «эта вкладка держала аренду» переживает переходы состояния:
  // по нему решается, освобождать ли её при закрытии.
  const heldEverRef = useRef(false);

  // Однократная попытка захвата при открытии черновика.
  useEffect(() => {
    if (routeId === null || !enabled) {
      return;
    }

    let stopped = false;

    void (async () => {
      try {
        await client.post(`/api/routes/${routeId}/edit-lock/acquire`, {});
      } catch {
        // Маршрут занят или уже не черновик — это состояние, а не сбой.
        // Карточка покажет держателя и предложит перехват.
      }
      if (!stopped) {
        changedRef.current();
      }
    })();

    return () => {
      stopped = true;
      if (heldEverRef.current) {
        // Best-effort: закрытие вкладки не должно ничего ломать, а забытую
        // аренду всё равно снимет истечение.
        void client.post(`/api/routes/${routeId}/edit-lock/release`, {}).catch(() => undefined);
        heldEverRef.current = false;
      }
    };
  }, [client, routeId, enabled]);

  // Сердцебиение живёт ровно столько, сколько аренда принадлежит этой вкладке.
  useEffect(() => {
    if (routeId === null || !enabled) {
      return;
    }

    const controller = createHeartbeatController({
      intervalMs: HEARTBEAT_INTERVAL_MS,
      setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
      clearInterval: (handle) => globalThis.clearInterval(handle as number),
      send: async () => {
        await client.post(`/api/routes/${routeId}/edit-lock/heartbeat`, {});
      },
      onLost: () => changedRef.current(),
    });

    if (heldByCurrentSession) {
      heldEverRef.current = true;
    }
    controller.setHeld(heldByCurrentSession);

    return () => controller.stop();
  }, [client, routeId, enabled, heldByCurrentSession]);
}
