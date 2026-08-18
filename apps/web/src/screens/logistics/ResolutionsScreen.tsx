/**
 * Вкладка «Требуют решения».
 *
 * Здесь заканчивается недоставка. Курьер вернул результат — и заказ повисает
 * между двумя мирами: клиенту он не отдан, а компании ещё не возвращён.
 * Пока логист не решит, что с ним делать, заказ не виден в «Сделках» и не
 * попадает ни в какой маршрут.
 *
 * Два ограничения экрана существенны и намеренны:
 *
 * 1. Счётчик в названии вкладки берётся у сервера, а не считается по видимым
 *    строкам: список постраничный, и «12» на второй странице означало бы
 *    другое число, чем на первой.
 * 2. «Повторно доставить» недоступно, пока склад не принял букет физически.
 *    Заказ, лежащий в машине курьера, нельзя поставить в новый маршрут — его
 *    там просто нет.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMoscowDateTime } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import { Button, EmptyState, ErrorState, LoadingState, StatusBadge } from '../../ui/components';
import './resolutions.css';

export interface ResolutionRow {
  id: string;
  orderId: string;
  orderNumber: string;
  address: string | null;
  routeNumber: string | null;
  courier: { id: string; fullName: string } | null;
  reasonName: string;
  failedAt: string;
  returnState: 'WITH_COURIER' | 'RETURNING' | 'ACCEPTED' | 'CANCELLED' | null;
  decision: 'CANCELLED' | 'REDELIVER' | null;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface ResolutionsPage {
  items: ResolutionRow[];
  total: number;
  unresolved: number;
}

/** Где сейчас букет. Формулировки владельца, без сокращений. */
export const RETURN_STATE_LABELS: Readonly<Record<string, string>> = {
  WITH_COURIER: 'У курьера',
  RETURNING: 'Возвращается на склад',
  ACCEPTED: 'Принят складом',
  CANCELLED: 'Отменён',
};

/**
 * Можно ли ставить заказ в новый маршрут.
 *
 * Ровно одно условие: букет физически на складе. Решение логиста этого
 * не заменяет — оно лишь называет намерение.
 */
export function readyForRedelivery(returnState: string | null): boolean {
  return returnState === 'ACCEPTED' || returnState === null;
}

export function ResolutionsScreen(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const list = useQuery({
    queryKey: ['logistics-resolutions'],
    queryFn: () => client.get<ResolutionsPage>('/api/logistics/resolutions?limit=100'),
  });

  const decide = useMutation({
    mutationFn: (input: { id: string; action: 'cancel-order' | 'redeliver' }) =>
      client.post<{ orderNumber: string; decision: string }>(
        `/api/logistics/resolutions/${input.id}/${input.action}`,
        {},
      ),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['logistics-resolutions'] });
      await queryClient.invalidateQueries({ queryKey: ['deal-cards'] });
      showToast(
        result.decision === 'CANCELLED'
          ? `Заказ ${result.orderNumber} отменён`
          : `Заказ ${result.orderNumber} вернулся в «Сделки»`,
        'success',
      );
    },
    onError: async (error: unknown) => {
      /*
       * Конфликт двух логистов: решение уже принято другим человеком.
       *
       * Список перечитывается сразу — иначе на экране осталась бы кнопка,
       * которая заведомо не сработает, и разговор пошёл бы о «глючащем»
       * интерфейсе вместо реального положения дел.
       */
      await queryClient.invalidateQueries({ queryKey: ['logistics-resolutions'] });
      showToast(
        error instanceof ApiError ? error.message : 'Не удалось применить решение.',
        'error',
      );
    },
  });

  if (list.isPending) {
    return <LoadingState title="Загружаем недоставленные заказы…" />;
  }
  if (list.isError) {
    return <ErrorState title="Не удалось загрузить список" onRetry={() => void list.refetch()} />;
  }

  const rows = list.data.items;

  return (
    <section className="stack">
      <div className="card stack">
        <div>
          <h2>Требуют решения</h2>
          <p className="muted text-sm">
            Заказы, которые курьер не смог доставить. Пока склад не принял букет обратно, повторная
            доставка недоступна: заказа физически нет на складе.
          </p>
        </div>
      </div>

      <div className="card stack">
        {rows.length === 0 ? (
          <EmptyState title="Нерешённых недоставок нет" />
        ) : (
          <div className="table-wrap">
            <table className="table resolutions">
              <thead>
                <tr>
                  <th>Заказ</th>
                  <th>Адрес</th>
                  <th>Курьер</th>
                  <th>Время</th>
                  <th>Причина</th>
                  <th>Возврат</th>
                  <th>Решение</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const ready = readyForRedelivery(row.returnState);
                  const busy = decide.isPending && decide.variables?.id === row.id;

                  return (
                    <tr
                      key={row.id}
                      data-order-number={row.orderNumber}
                      data-testid="resolution-row"
                    >
                      <td>
                        <strong>{row.orderNumber}</strong>
                        {row.routeNumber !== null && (
                          <div className="muted text-sm">маршрут {row.routeNumber}</div>
                        )}
                      </td>
                      <td className="resolutions__address">{row.address ?? '—'}</td>
                      <td>{row.courier?.fullName ?? '—'}</td>
                      <td>{formatMoscowDateTime(row.failedAt)}</td>
                      <td>{row.reasonName}</td>
                      <td>
                        <StatusBadge tone={ready ? 'success' : 'warning'}>
                          {RETURN_STATE_LABELS[row.returnState ?? ''] ?? '—'}
                        </StatusBadge>
                      </td>
                      <td>
                        {row.decision === null ? (
                          <div className="row resolutions__actions">
                            <Button
                              variant="ghost"
                              disabled={busy}
                              data-testid="resolution-cancel"
                              onClick={() => decide.mutate({ id: row.id, action: 'cancel-order' })}
                            >
                              Отменить заказ
                            </Button>
                            <Button
                              variant="primary"
                              disabled={busy || !ready}
                              data-testid="resolution-redeliver"
                              title={
                                ready
                                  ? undefined
                                  : 'Заказ ещё не принят складом: везти пока нечего.'
                              }
                              onClick={() => decide.mutate({ id: row.id, action: 'redeliver' })}
                            >
                              Повторно доставить
                            </Button>
                          </div>
                        ) : (
                          <span className="muted text-sm">
                            {row.decision === 'CANCELLED' ? 'Отменён' : 'Повторная доставка'}
                            {row.decidedBy === null ? '' : ` · ${row.decidedBy}`}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
