/**
 * Индикатор состояния связи и интеграций.
 *
 * Realtime-канал ещё не реализован (ветка 1.4), поэтому состояние «Подключено»
 * означает только доступность API. Показывать здесь ложное «realtime подключён»
 * нельзя: пользователь решил бы, что списки обновляются сами.
 */

import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../lib/api-client';
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
): ConnectionView {
  if (isError || data === undefined) {
    return {
      tone: 'error',
      label: 'Нет связи',
      title: 'Сервис не отвечает. Рабочие действия сейчас недоступны.',
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
    title: 'Сервис отвечает, интеграции настроены.',
  };
}

export function ConnectionIndicator({ client }: { client: ApiClient }): React.JSX.Element {
  const { data, isError } = useQuery({
    queryKey: ['status'],
    queryFn: () => client.get<StatusResponse>('/api/status'),
    // Realtime ещё нет: состояние обновляется периодическим опросом.
    refetchInterval: 60_000,
    retry: 1,
  });

  const view = describeConnection(data, isError);

  return (
    <span title={view.title}>
      <StatusBadge tone={view.tone}>{view.label}</StatusBadge>
    </span>
  );
}
