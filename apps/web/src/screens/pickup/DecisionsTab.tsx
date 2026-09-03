/**
 * Вкладка «Решения» менеджера выдачи.
 *
 * Постоянный список заказов в карантине «Нет цветов»: флорист отказался, заказ
 * снят с него и ждёт решения менеджера. По кнопке «Вернуть в очередь» заказ
 * возвращается в общую очередь флористов (в конец). Право на операцию проверяет
 * сервер — вкладка лишь показывает то, что разрешено.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../ui/ToastProvider';
import { Button, EmptyState, ErrorState, LoadingState } from '../../ui/components';

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

const METHOD_LABEL: Readonly<Record<string, string>> = {
  PICKUP: 'Самовывоз',
  DELIVERY: 'Доставка',
};

const ORDER_STATE_LABEL: Readonly<Record<string, string>> = {
  NEW: 'Свободен (в карантине)',
  IN_ASSEMBLY: 'В сборке',
  NEEDS_REVIEW: 'Требует внимания',
  ASSEMBLED: 'Собран',
};

function reasonLabel(reason: string): string {
  return reason === 'INSUFFICIENT_GOODS' ? 'Нет цветов' : reason;
}

function minute(value: number | null): string {
  if (value === null) {
    return '—';
  }
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function dateLabel(iso: string | null): string {
  if (iso === null) {
    return 'без даты';
  }
  return iso.slice(0, 10);
}

function refusedLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}

export function DecisionsTab(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const list = useQuery({
    queryKey: ['no-flowers'],
    queryFn: () =>
      client.get<{ items: QuarantineView[]; total: number }>(
        '/api/logistics/no-flowers/quarantines',
      ),
  });

  const returnToQueue = useMutation({
    mutationFn: (quarantineId: string) =>
      client.post(`/api/logistics/no-flowers/quarantines/${quarantineId}/return`, {}),
    onSuccess: () => {
      showToast('Заказ возвращён в очередь', 'success');
      void queryClient.invalidateQueries({ queryKey: ['no-flowers'] });
      void queryClient.invalidateQueries({ queryKey: ['no-flowers-count'] });
    },
    onError: (error: unknown) =>
      showToast((error as { message?: string }).message ?? 'Не удалось вернуть заказ', 'error'),
  });

  if (list.isPending) {
    return <LoadingState title="Загружаем решения…" />;
  }
  if (list.isError) {
    return <ErrorState title="Не удалось загрузить" onRetry={() => void list.refetch()} />;
  }
  if (list.data.items.length === 0) {
    return (
      <EmptyState
        title="Нет открытых решений"
        description="Здесь появятся заказы, от которых флорист отказался с причиной «Нет цветов»."
      />
    );
  }

  return (
    <div className="stack" data-testid="decisions-list">
      {list.data.items.map((item) => (
        <div
          key={item.id}
          className="card stack"
          data-testid="decision-row"
          data-order-number={item.orderNumber}
        >
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <strong>{item.orderNumber}</strong>
            <span className="muted text-sm">
              {item.deliveryMethod === null ? '—' : (METHOD_LABEL[item.deliveryMethod] ?? '—')}
            </span>
          </div>
          <div className="text-sm">
            {dateLabel(item.deliveryDate)} · {minute(item.intervalStartMinute)}–
            {minute(item.intervalEndMinute)}
          </div>
          <div className="text-sm">
            Отказался: <strong>{item.floristName}</strong> · {refusedLabel(item.refusedAt)}
          </div>
          <div className="text-sm">
            Причина: {reasonLabel(item.reason)}
            {item.comment === null || item.comment === '' ? '' : ` · ${item.comment}`}
          </div>
          <div className="muted text-sm">
            Состояние: {ORDER_STATE_LABEL[item.orderState] ?? item.orderState}
          </div>
          <div className="row">
            <Button
              variant="primary"
              data-testid="decision-return"
              disabled={returnToQueue.isPending}
              onClick={() => returnToQueue.mutate(item.id)}
            >
              Вернуть в очередь
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
