/**
 * Всплывающие окна уведомлений у работающих логистов.
 *
 * Появляются поверх текущего экрана по ЖИВОМУ realtime-событию
 * `notification.created` (через шину событий), а не по инвалидации: после
 * переподключения и перезагрузки старый архив не воспроизводится, поэтому окна
 * не всплывают повторно. Одно и то же событие показывается один раз (дедуп по
 * id). Несколько уведомлений показываются ПОСЛЕДОВАТЕЛЬНО, а не стопкой.
 *
 * «Ок» закрывает окно и отмечает уведомление прочитанным ТОЛЬКО у текущего
 * пользователя. Для изменения состава после сборки есть «На пересборку».
 * Непрочитанное остаётся во вкладке; после перезагрузки снова доступно там.
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { Button, Modal } from '../../ui/components';
import { subscribeRealtimeEvents } from '../../realtime/event-bus';
import { type NotificationView } from './notifications';
import { NotificationBody, ReassemblyDialog } from './NotificationParts';

export function NotificationPopups(): React.JSX.Element | null {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const [queue, setQueue] = useState<string[]>([]);
  const shownRef = useRef<Set<string>>(new Set());
  const [reassembly, setReassembly] = useState<NotificationView | null>(null);

  useEffect(() => {
    return subscribeRealtimeEvents((event, data) => {
      if (event !== 'notification.created') {
        return;
      }
      try {
        const parsed = JSON.parse(data) as { notificationId?: string };
        const id = parsed.notificationId;
        // Дедуп: одно событие — одно окно, даже если пришло повторно.
        if (typeof id !== 'string' || shownRef.current.has(id)) {
          return;
        }
        shownRef.current.add(id);
        setQueue((current) => [...current, id]);
      } catch {
        // Плохой payload не должен ломать поток.
      }
    });
  }, []);

  const currentId = queue[0] ?? null;

  const detail = useQuery({
    queryKey: ['notification', currentId],
    queryFn: () =>
      client.get<{ notification: NotificationView | null }>(
        `/api/logistics/notifications/${currentId ?? ''}`,
      ),
    enabled: currentId !== null,
  });

  const advance = (): void => {
    setQueue((current) => current.slice(1));
  };

  const dismiss = async (): Promise<void> => {
    if (currentId !== null) {
      // «Ок» отмечает прочитанным только у текущего пользователя.
      await client.post(`/api/logistics/notifications/${currentId}/read`, {}).catch(() => {});
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications-count'] });
    }
    advance();
  };

  if (currentId === null) {
    return null;
  }

  const item = detail.data?.notification ?? null;

  // Открыт диалог пересборки поверх окна: по его закрытию идём к следующему.
  if (reassembly !== null) {
    return (
      <ReassemblyDialog
        item={reassembly}
        onClose={() => {
          setReassembly(null);
          advance();
        }}
      />
    );
  }

  // Уведомление могло исчезнуть (например, удалено в тестах) — просто пропускаем.
  if (detail.isError || (detail.isSuccess && item === null)) {
    advance();
    return null;
  }
  if (item === null) {
    return null;
  }

  const offersReassembly = item.kind === 'COMPOSITION_AFTER_ASSEMBLY' && item.decision === null;

  return (
    <Modal
      open
      title={`Изменён заказ ${item.orderNumber}`}
      onClose={() => {
        void dismiss();
      }}
    >
      <div className="stack" data-testid="notification-popup" data-order-number={item.orderNumber}>
        <NotificationBody item={item} />
        <div className="row">
          {offersReassembly && (
            <Button
              variant="primary"
              data-testid="popup-reassembly"
              onClick={() => setReassembly(item)}
            >
              На пересборку
            </Button>
          )}
          <Button
            variant={offersReassembly ? 'ghost' : 'primary'}
            data-testid="popup-ok"
            onClick={() => void dismiss()}
          >
            Ок
          </Button>
        </div>
      </div>
    </Modal>
  );
}
