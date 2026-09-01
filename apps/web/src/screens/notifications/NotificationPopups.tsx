/**
 * Всплывающие окна уведомлений у работающих логистов.
 *
 * Появляются поверх текущего экрана по ЖИВОМУ realtime-событию
 * `notification.created` (через шину событий), а не по инвалидации: после
 * переподключения и перезагрузки старый архив не воспроизводится, поэтому окна
 * изменений заказов не всплывают повторно. Одно и то же событие показывается
 * один раз (дедуп по id). Несколько уведомлений показываются ПОСЛЕДОВАТЕЛЬНО.
 *
 * ОТКАЗЫ — ИСКЛЮЧЕНИЕ, И ОНО ОСОЗНАННОЕ. Отказ ждёт решения руководителя, и
 * пропустить его нельзя. Живое событие видит только тот, кто был онлайн в
 * момент отказа; кто вошёл позже, получает НЕрешённые (`PENDING`) отказы
 * догоняющим запросом при входе и видит их окнами. Решённые в этот список не
 * попадают и повторно не всплывают. Живой и догоняющий пути делят один дедуп
 * по id, поэтому один отказ не покажется дважды. Решение из окна и из вкладки
 * идёт одним и тем же серверным обработчиком.
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
import { NotificationBody, ReassemblyDialog, RefusalDialog } from './NotificationParts';

export function NotificationPopups(): React.JSX.Element | null {
  const { client, user } = useAuth();
  const queryClient = useQueryClient();
  const [queue, setQueue] = useState<string[]>([]);
  const shownRef = useRef<Set<string>>(new Set());
  const [reassembly, setReassembly] = useState<NotificationView | null>(null);
  const [refusal, setRefusal] = useState<NotificationView | null>(null);
  const canDecideRefusal =
    user?.roles.includes('ADMIN') === true || user?.roles.includes('SUPERVISOR') === true;

  /** Ставит уведомление в очередь окон, если оно ещё не показывалось. */
  const enqueueOnce = (id: string): void => {
    if (shownRef.current.has(id)) {
      return;
    }
    shownRef.current.add(id);
    setQueue((current) => [...current, id]);
  };

  useEffect(() => {
    return subscribeRealtimeEvents((event, data) => {
      if (event !== 'notification.created') {
        return;
      }
      try {
        const parsed = JSON.parse(data) as { notificationId?: string };
        const id = parsed.notificationId;
        // Дедуп: одно событие — одно окно, даже если пришло повторно.
        if (typeof id === 'string') {
          enqueueOnce(id);
        }
      } catch {
        // Плохой payload не должен ломать поток.
      }
    });
  }, []);

  /**
   * Догоняющий список открытых отказов при входе.
   *
   * Кто был офлайн в момент отажа, не получил живого события — здесь он видит
   * все НЕрешённые отказы и показывает их окнами. Тот же дедуп, что и у живого
   * пути, не даёт показать отказ дважды. Обновляется по событиям отказов
   * (`florist.dispatch_changed` инвалидирует ключ `notifications`), поэтому
   * список догоняющих остаётся актуальным без перезагрузки.
   */
  const pendingRefusals = useQuery({
    queryKey: ['notifications', 'pending-refusals'],
    queryFn: () =>
      client.get<{ notificationIds: string[] }>('/api/logistics/notifications/pending-refusals'),
    enabled: canDecideRefusal,
  });

  useEffect(() => {
    for (const id of pendingRefusals.data?.notificationIds ?? []) {
      enqueueOnce(id);
    }
    // Зависимость — только данные догоняющего запроса; enqueueOnce дедупит.
  }, [pendingRefusals.data]);

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

  // Диалог решения по отказу — так же поверх окна и с переходом к следующему.
  if (refusal !== null) {
    return (
      <RefusalDialog
        item={refusal}
        onClose={() => {
          setRefusal(null);
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
  const offersRefusal =
    canDecideRefusal && item.kind === 'REFUSAL_REQUEST' && item.refusal?.state === 'PENDING';
  const isRefusal = item.kind === 'REFUSAL_REQUEST';

  return (
    <Modal
      open
      title={
        isRefusal ? `Отказ по заказу ${item.orderNumber}` : `Изменён заказ ${item.orderNumber}`
      }
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
          {offersRefusal && (
            <Button variant="primary" data-testid="popup-refusal" onClick={() => setRefusal(item)}>
              Решить по отказу
            </Button>
          )}
          <Button
            variant={offersReassembly || offersRefusal ? 'ghost' : 'primary'}
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
