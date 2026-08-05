/**
 * Индикатор состояния связи и интеграций.
 *
 * Показывает реальное положение дел: состояние канала realtime и состояние
 * внешних интеграций. Ложное «Подключено» при неработающем канале недопустимо —
 * пользователь решил бы, что списки обновляются сами.
 */

import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../lib/api-client';
import type { RealtimeState } from '../realtime/useRealtime';
import { StatusBadge, type StatusTone } from '../ui/components';

interface IntegrationStatus {
  provider: string;
  state: 'NOT_CONFIGURED' | 'CONFIGURED' | 'OK' | 'DEGRADED' | 'ERROR';
  pendingOperations: number;
}

interface StatusResponse {
  stage: number;
  integrations: IntegrationStatus[];
}

export interface ConnectionView {
  tone: StatusTone;
  label: string;
  title: string;
}

/** Правило отображения вынесено отдельно: его легко читать и проверять. */
export function describeConnection(
  data: StatusResponse | undefined,
  isError: boolean,
  realtime: RealtimeState,
): ConnectionView {
  if (isError || data === undefined) {
    return {
      tone: 'error',
      label: 'Нет связи',
      title: 'Сервис не отвечает. Рабочие действия сейчас недоступны.',
    };
  }

  if (realtime === 'reconnecting' || realtime === 'stopped') {
    return {
      tone: 'warning',
      label: 'Переподключение',
      title:
        'Канал обновлений разорван: данные могут отставать. Приложение восстанавливает соединение.',
    };
  }

  const broken = data.integrations.filter(
    (integration) => integration.state === 'ERROR' || integration.state === 'DEGRADED',
  );
  if (broken.length > 0) {
    return {
      tone: 'error',
      label: 'Нет связи',
      title: `Проблема связи с внешними сервисами: ${broken.map((item) => item.provider).join(', ')}.`,
    };
  }

  const notConfigured = data.integrations.filter(
    (integration) => integration.state === 'NOT_CONFIGURED',
  );
  if (notConfigured.length > 0) {
    return {
      tone: 'warning',
      label: 'Интеграция не настроена',
      title: `Не настроены: ${notConfigured.map((item) => item.provider).join(', ')}. Импорт заказов и карты пока недоступны.`,
    };
  }

  return {
    tone: 'success',
    label: 'Подключено',
    title: 'Сервис отвечает, канал обновлений активен, интеграции настроены.',
  };
}

export function ConnectionIndicator({
  client,
  realtime,
}: {
  client: ApiClient;
  realtime: RealtimeState;
}): React.JSX.Element {
  const { data, isError } = useQuery({
    queryKey: ['status'],
    queryFn: () => client.get<StatusResponse>('/api/status'),
    refetchInterval: 60_000,
    retry: 1,
  });

  const view = describeConnection(data, isError, realtime);

  return (
    <span title={view.title}>
      <StatusBadge tone={view.tone}>{view.label}</StatusBadge>
    </span>
  );
}
