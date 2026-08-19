/**
 * Строка аренды свёрнутого черновика.
 *
 * Список черновиков состояния блокировки не отдаёт — только карточка одного
 * маршрута. Поэтому строка читает ту же карточку тем же ключом кэша, что и
 * раскрытый черновик: раскрытие после этого не стоит ни одного лишнего
 * запроса, а свёрнутая строка честно говорит, свободен маршрут или занят.
 *
 * Пока ответа нет, строки нет вовсе: показать «свободен» до ответа значило бы
 * предложить взять в работу маршрут, который уже кем-то правится.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../ui/ToastProvider';
import { Button } from '../../ui/components';
import { type RouteCardView } from './routing';

export interface DraftLeaseRowProps {
  routeId: string;
}

export function DraftLeaseRow({ routeId }: DraftLeaseRowProps): React.JSX.Element | null {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const route = useQuery({
    queryKey: ['route', routeId],
    queryFn: () => client.get<RouteCardView>(`/api/routes/${routeId}`),
  });

  const acquire = useMutation({
    mutationFn: () => client.post(`/api/routes/${routeId}/edit-lock/acquire`, {}),
    onSuccess: () => {
      showToast('Маршрут взят в работу', 'success');
      void queryClient.invalidateQueries({ queryKey: ['route', routeId] });
    },
    onError: () => showToast('Не удалось взять маршрут в работу', 'error'),
  });

  const release = useMutation({
    mutationFn: () => client.post(`/api/routes/${routeId}/edit-lock/release`, {}),
    onSuccess: () => {
      showToast('Маршрут освобождён', 'success');
      void queryClient.invalidateQueries({ queryKey: ['route', routeId] });
    },
    onError: () => showToast('Не удалось освободить маршрут', 'error'),
  });

  const lock = route.data?.editLock;
  if (lock === undefined || route.data?.state !== 'DRAFT') {
    return null;
  }

  if (lock.locked && lock.heldByCurrentSession) {
    return (
      <div className="routes__lease" role="status">
        <span className="routes__lease-badge">Вы редактируете</span>
        <Button
          variant="ghost"
          disabled={release.isPending}
          data-testid="draft-lease-release"
          onClick={() => release.mutate()}
        >
          Освободить
        </Button>
      </div>
    );
  }

  if (lock.locked) {
    const holder = lock.holder?.fullName ?? 'другой пользователь';
    return (
      <div className="routes__lease" role="status">
        <span className="routes__lease-text">Редактирует {holder}</span>
      </div>
    );
  }

  return (
    <div className="routes__lease" role="status">
      <span className="routes__lease-text">Возьмите в работу, чтобы менять состав</span>
      <Button
        variant="primary"
        disabled={acquire.isPending}
        data-testid="draft-lease-acquire"
        onClick={() => acquire.mutate()}
      >
        Взять в работу
      </Button>
    </div>
  );
}
