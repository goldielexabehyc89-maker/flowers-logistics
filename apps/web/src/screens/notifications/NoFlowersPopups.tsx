/**
 * Всплывающие окна карантина «Нет цветов» у ответственных (менеджер выдачи,
 * ADMIN, SUPERVISOR).
 *
 * Появляются по живому `notification.created` (kind `NO_FLOWERS_QUARANTINE`), а
 * не по инвалидации: после переподключения старые окна не воспроизводятся. Кто
 * был офлайн — получает не прочитанные ИМ карантины открытых задач догоняющим
 * запросом при входе и видит их окном один раз (показ помечает прочитанным).
 *
 * «Ок» только закрывает окно — задача остаётся во вкладке «Решения». «Вернуть в
 * очередь» выполняет серверную операцию возврата.
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../ui/ToastProvider';
import { Button, Modal } from '../../ui/components';
import { subscribeRealtimeEvents } from '../../realtime/event-bus';

const NO_FLOWERS_KIND = 'NO_FLOWERS_QUARANTINE';

interface QuarantineView {
  id: string;
  orderId: string;
  orderNumber: string;
  deliveryMethod: 'PICKUP' | 'DELIVERY' | null;
  deliveryDate: string | null;
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
  floristName: string;
  refusedAt: string;
  reason: string;
  comment: string | null;
  orderState: string;
}

function reasonLabel(reason: string): string {
  return reason === 'INSUFFICIENT_GOODS' ? 'Нет цветов' : reason;
}

const ORDER_STATE_LABEL: Readonly<Record<string, string>> = {
  NEW: 'Свободен (в карантине)',
  IN_ASSEMBLY: 'В сборке',
  NEEDS_REVIEW: 'Требует внимания',
  ASSEMBLED: 'Собран',
};

export function NoFlowersPopups(): React.JSX.Element | null {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [queue, setQueue] = useState<string[]>([]);
  const shownRef = useRef<Set<string>>(new Set());

  const enqueueOnce = (id: string): void => {
    if (shownRef.current.has(id)) {
      return;
    }
    shownRef.current.add(id);
    setQueue((current) => [...current, id]);
  };

  // Живое событие: новый отказ «Нет цветов».
  useEffect(() => {
    return subscribeRealtimeEvents((event, data) => {
      if (event !== 'notification.created') {
        return;
      }
      try {
        const parsed = JSON.parse(data) as { notificationId?: string; kind?: string };
        if (parsed.kind === NO_FLOWERS_KIND && typeof parsed.notificationId === 'string') {
          enqueueOnce(parsed.notificationId);
        }
      } catch {
        // Плохой payload не должен ломать поток.
      }
    });
  }, []);

  // Догоняющий список при входе — не прочитанные ИМ открытые карантины.
  const pending = useQuery({
    queryKey: ['no-flowers', 'pending'],
    queryFn: () =>
      client.get<{ notificationIds: string[] }>('/api/logistics/notifications/pending-no-flowers'),
  });
  useEffect(() => {
    for (const id of pending.data?.notificationIds ?? []) {
      enqueueOnce(id);
    }
  }, [pending.data]);

  const currentId = queue[0] ?? null;

  const detail = useQuery({
    queryKey: ['no-flowers', 'notification', currentId],
    queryFn: () =>
      client.get<{ quarantine: QuarantineView | null }>(
        `/api/logistics/no-flowers/notification/${currentId ?? ''}`,
      ),
    enabled: currentId !== null,
  });

  // Показ помечает прочитанным СРАЗУ — окно больше не всплывёт («один раз»).
  const readRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const shown = detail.data?.quarantine ?? null;
    if (currentId !== null && shown !== null && !readRef.current.has(currentId)) {
      readRef.current.add(currentId);
      void client
        .post(`/api/logistics/no-flowers/notification/${currentId}/read`, {})
        .catch(() => {});
    }
  }, [detail.data, currentId]);

  const advance = (): void => {
    setQueue((current) => current.slice(1));
  };

  if (currentId === null) {
    return null;
  }
  const q = detail.data?.quarantine ?? null;
  // Задача могла закрыться (заказ вернули/отменили) — просто пропускаем окно.
  if (detail.isError || (detail.isSuccess && q === null)) {
    advance();
    return null;
  }
  if (q === null) {
    return null;
  }

  const returnToQueue = async (): Promise<void> => {
    try {
      await client.post(`/api/logistics/no-flowers/quarantines/${q.id}/return`, {});
      showToast('Заказ возвращён в очередь', 'success');
    } catch (error) {
      showToast((error as { message?: string }).message ?? 'Не удалось вернуть заказ', 'error');
    }
    void queryClient.invalidateQueries({ queryKey: ['no-flowers'] });
    advance();
  };

  return (
    <Modal open title="Флорист: «Нет цветов»" onClose={advance}>
      <div className="stack" data-testid="no-flowers-popup" data-order-number={q.orderNumber}>
        <p className="text-sm">
          Заказ <strong>{q.orderNumber}</strong> снят с флориста <strong>{q.floristName}</strong>.
        </p>
        <p className="text-sm">
          Причина: {reasonLabel(q.reason)}.
          {q.comment === null || q.comment === '' ? '' : ` Комментарий: ${q.comment}.`} Состояние:{' '}
          {ORDER_STATE_LABEL[q.orderState] ?? q.orderState}.
        </p>
        <div className="row">
          <Button
            variant="primary"
            data-testid="no-flowers-return"
            onClick={() => void returnToQueue()}
          >
            Вернуть в очередь
          </Button>
          <Button variant="ghost" data-testid="no-flowers-ok" onClick={advance}>
            Ок
          </Button>
        </div>
      </div>
    </Modal>
  );
}
