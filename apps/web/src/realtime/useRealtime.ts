/**
 * Подключение к каналу realtime.
 *
 * Один канал на приложение: несколько параллельных подписок означали бы
 * несколько потоков и дублирующиеся обновления. Последний идентификатор события
 * хранится только в памяти — как и access-токен.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../lib/api-client';
import { invalidationKeysFor, parseEventBuffer, reconnectDelayMs } from './stream';

export type RealtimeState = 'connecting' | 'connected' | 'reconnecting' | 'stopped';

const STREAM_PATH = '/api/realtime/events';

export function useRealtime(): RealtimeState {
  const { status, client } = useAuth();
  const queryClient = useQueryClient();
  const [state, setState] = useState<RealtimeState>('stopped');
  const lastEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') {
      setState('stopped');
      return;
    }

    let stopped = false;
    let attempt = 0;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const handleEvent = (event: { event: string; data: string; id: string | null }): void => {
      if (event.id !== null) {
        lastEventIdRef.current = event.id;
      }

      if (event.event === 'session-closed') {
        // Сервер закрыл канал: сессия больше не действительна.
        stopped = true;
        controller?.abort();
        setState('stopped');
        return;
      }

      if (event.event === 'resync-required') {
        // Курсор устарел: перезапрашиваем данные, но страницу не перезагружаем.
        lastEventIdRef.current = null;
        void queryClient.invalidateQueries();
        return;
      }

      for (const key of invalidationKeysFor(event.event)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    };

    const connect = async (): Promise<void> => {
      if (stopped) {
        return;
      }

      controller = new AbortController();
      setState(attempt === 0 ? 'connecting' : 'reconnecting');

      try {
        const response = await client.openEventStream(
          STREAM_PATH,
          lastEventIdRef.current,
          controller.signal,
        );

        if (response.body === null) {
          throw new Error('поток недоступен');
        }

        attempt = 0;
        setState('connected');

        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done || stopped) {
            break;
          }
          buffer += value;
          const parsed = parseEventBuffer(buffer);
          buffer = parsed.rest;
          for (const event of parsed.events) {
            handleEvent(event);
          }
        }
      } catch (error) {
        // Окончательная потеря сессии обрабатывается клиентом API:
        // он очищает память и возвращает пользователя на вход.
        if (error instanceof ApiError && error.status === 401) {
          stopped = true;
          setState('stopped');
          return;
        }
      }

      if (stopped) {
        return;
      }

      attempt += 1;
      setState('reconnecting');
      retryTimer = setTimeout(() => void connect(), reconnectDelayMs(attempt));
    };

    void connect();

    return () => {
      stopped = true;
      controller?.abort();
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
    };
  }, [status, client, queryClient]);

  return state;
}
