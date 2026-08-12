/**
 * Ошибки очереди интеграции — компактный блок в настройках.
 *
 * Отдельного большого раздела не создаётся: администратору нужно видеть,
 * что застряло, и уметь повторить. Исходный payload сервер не отдаёт.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMoscowDateTime } from '@fl/shared';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../lib/api-client';
import { useToast } from '../ui/ToastProvider';
import { Button, EmptyState, ErrorState, LoadingState, StatusBadge } from '../ui/components';

interface OutboxFailure {
  id: string;
  topic: string;
  status: 'ERROR' | 'DEAD';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  updatedAt: string;
}

function formatDate(value: string): string {
  return formatMoscowDateTime(value);
}

export function OutboxFailures(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const query = useQuery({
    queryKey: ['outbox-failures'],
    queryFn: () => client.get<{ items: OutboxFailure[] }>('/api/outbox/failures'),
  });

  const retry = useMutation({
    mutationFn: (id: string) => client.post(`/api/outbox/failures/${id}/retry`),
    onSuccess: async () => {
      showToast('Сообщение поставлено в очередь повторно', 'success');
      await queryClient.invalidateQueries({ queryKey: ['outbox-failures'] });
    },
    onError: (error) => {
      showToast(
        error instanceof ApiError ? error.message : 'Не удалось повторить отправку',
        'error',
      );
    },
  });

  const items = query.data?.items ?? [];

  return (
    <section className="card stack">
      <div>
        <h2>Очередь интеграции</h2>
        <p className="muted text-sm">
          Сообщения, которые не удалось отправить. Содержимое сообщения не показывается — оно
          предназначено внешней системе.
        </p>
      </div>

      {query.isLoading && <LoadingState />}
      {query.isError && <ErrorState onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState title="Ошибок нет" description="Все сообщения отправлены." />
      )}

      {items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Событие</th>
                <th>Состояние</th>
                <th>Попытки</th>
                <th>Ошибка</th>
                <th>Обновлено</th>
                <th>Действие</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.topic}</td>
                  <td>
                    <StatusBadge tone={item.status === 'DEAD' ? 'error' : 'warning'}>
                      {item.status === 'DEAD' ? 'Исчерпаны попытки' : 'Ошибка'}
                    </StatusBadge>
                  </td>
                  <td className="nowrap">
                    {item.attempts} из {item.maxAttempts}
                  </td>
                  <td>{item.lastError ?? '—'}</td>
                  <td className="nowrap">{formatDate(item.updatedAt)}</td>
                  <td>
                    <Button loading={retry.isPending} onClick={() => retry.mutate(item.id)}>
                      Повторить
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
