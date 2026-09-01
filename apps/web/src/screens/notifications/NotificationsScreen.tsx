/**
 * Вкладка «Логистика → Уведомления».
 *
 * Список изменений заказов: что изменилось (старое → новое), понятный diff
 * состава, текущее состояние заказа и — для изменений состава после сборки —
 * решение «На пересборку». Прочтение персональное: отметка одного логиста не
 * скрывает уведомление у остальных, во вкладке оно остаётся в истории.
 *
 * Доступ проверяет сервер (LOGISTICIAN/SUPERVISOR/ADMIN → 403 остальным);
 * список и счётчик обновляются realtime.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { Button, EmptyState, ErrorState, LoadingState, StatusBadge } from '../../ui/components';
import { type NotificationView, type NotificationsResponse } from './notifications';
import { NotificationBody, ReassemblyDialog, RefusalDialog } from './NotificationParts';

export function NotificationsScreen(): React.JSX.Element {
  const { client, user } = useAuth();
  const queryClient = useQueryClient();
  const [reassembly, setReassembly] = useState<NotificationView | null>(null);
  const [refusal, setRefusal] = useState<NotificationView | null>(null);
  // Решения по отказам — только руководителю. Сервер тоже проверяет роль;
  // здесь решается лишь, показывать ли кнопку.
  const canDecideRefusal =
    user?.roles.includes('ADMIN') === true || user?.roles.includes('SUPERVISOR') === true;

  const list = useQuery({
    queryKey: ['notifications'],
    queryFn: () => client.get<NotificationsResponse>('/api/logistics/notifications'),
  });

  const markRead = useMutation({
    mutationFn: (id: string) => client.post(`/api/logistics/notifications/${id}/read`, {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications-count'] });
    },
  });

  return (
    <section className="stack" data-testid="notifications-screen">
      <div className="card stack">
        <div>
          <h3>Уведомления</h3>
          <p className="muted text-sm">
            Изменения заказов от источника: адрес, детали, дата, интервал и состав. Прочтение
            персональное — уведомление остаётся в истории.
          </p>
        </div>
      </div>

      {list.isPending ? (
        <LoadingState title="Загружаем уведомления…" />
      ) : list.isError ? (
        <ErrorState title="Не удалось загрузить уведомления" onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState title="Пусто" description="Изменений заказов пока не было." />
      ) : (
        <div className="stack" data-testid="notifications-list">
          {list.data.items.map((item) => {
            const offersReassembly =
              item.kind === 'COMPOSITION_AFTER_ASSEMBLY' && item.decision === null;
            const offersRefusal =
              canDecideRefusal &&
              item.kind === 'REFUSAL_REQUEST' &&
              item.refusal?.state === 'PENDING';
            return (
              <article
                key={item.id}
                className={item.read ? 'card stack notif notif--read' : 'card stack notif'}
                data-testid="notification-card"
                data-order-number={item.orderNumber}
              >
                <div className="row">
                  <strong>{item.orderNumber}</strong>
                  <div className="row row--tight">
                    {item.categories.map((category) => (
                      <StatusBadge key={category} tone="info">
                        {category}
                      </StatusBadge>
                    ))}
                    {!item.read && (
                      <StatusBadge tone="warning" data-testid="notif-unread">
                        новое
                      </StatusBadge>
                    )}
                  </div>
                </div>

                <NotificationBody item={item} />

                <div className="row">
                  {offersReassembly && (
                    <Button
                      variant="primary"
                      data-testid="notif-reassembly"
                      onClick={() => setReassembly(item)}
                    >
                      На пересборку
                    </Button>
                  )}
                  {offersRefusal && (
                    <Button
                      variant="primary"
                      data-testid="notif-refusal"
                      onClick={() => setRefusal(item)}
                    >
                      Решить по отказу
                    </Button>
                  )}
                  {!item.read && (
                    <Button
                      variant="ghost"
                      data-testid="notif-mark-read"
                      disabled={markRead.isPending}
                      onClick={() => markRead.mutate(item.id)}
                    >
                      Прочитано
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {reassembly !== null && (
        <ReassemblyDialog item={reassembly} onClose={() => setReassembly(null)} />
      )}

      {refusal !== null && <RefusalDialog item={refusal} onClose={() => setRefusal(null)} />}
    </section>
  );
}
