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
  const { status, client, endSession } = useAuth();
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

    /**
     * Единая точка потери сессии.
     *
     * Канал закрывается, а состояние приложения приводится в порядок общим
     * механизмом AuthContext: токен, пользователь и кэш запросов очищаются,
     * после чего маршрутизация сама показывает экран входа. Перезагрузка
     * страницы не нужна и не выполняется.
     */
    const loseSession = (): void => {
      stopped = true;
      controller?.abort();
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      setState('stopped');
      endSession();
    };

    const handleEvent = (event: { event: string; data: string; id: string | null }): void => {
      if (event.id !== null) {
        lastEventIdRef.current = event.id;
      }

      // session-closed приходит от сервера, session.revoked — из журнала событий
      // и адресовано лично этому пользователю. Смысл один: доступа больше нет.
      if (event.event === 'session-closed' || event.event === 'session.revoked') {
        loseSession();
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
        // 401 здесь означает, что обновить сессию уже не удалось: клиент API
        // выполняет single-flight refresh и ровно один повтор до того,
        // как отдать эту ошибку.
        if (error instanceof ApiError && error.status === 401) {
          loseSession();
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
  }, [status, client, queryClient, endSession]);

  return state;
}
