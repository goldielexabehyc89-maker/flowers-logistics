/**
 * История собственных результатов курьера.
 *
 * За текущий московский день видны все поля. СО СЛЕДУЮЩЕГО дня персональные
 * данные скрываются сервером: доставка закончена, и адрес с получателем
 * в кармане курьера больше не нужны. Клиент их не прячет и не восстанавливает —
 * он показывает то, что пришло.
 *
 * Логист и администратор видят чужие результаты и PII не теряют: это
 * административный просмотр, а не карман курьера.
 */

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { moscowToday, formatMoscowDateTime, shiftCalendarDate } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import {
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Select,
  StatusBadge,
} from '../../ui/components';
import type { HistoryItemView } from './delivery-flow';
import './delivery.css';

/** Сколько прошедших дней предлагать. История доставки живёт недолго. */
const DAYS = 7;

export function HistoryScreen(): React.JSX.Element {
  const { client } = useAuth();
  const today = moscowToday();
  const [date, setDate] = useState(today);

  const history = useQuery({
    queryKey: ['delivery-history', date],
    queryFn: () =>
      client.get<{ items: HistoryItemView[]; date: string; today: string }>(
        `/api/delivery/history?date=${date}`,
      ),
  });

  if (history.isPending) return <LoadingState />;
  if (history.isError) {
    return (
      <ErrorState title="Не удалось загрузить историю" onRetry={() => void history.refetch()} />
    );
  }

  const items = history.data?.items ?? [];
  const options = Array.from({ length: DAYS }, (_, index) => shiftCalendarDate(today, -index));

  return (
    <div className="delivery__history">
      <Field label="День">
        {(fieldProps) => (
          <Select {...fieldProps} value={date} onChange={(event) => setDate(event.target.value)}>
            {options.map((day) => (
              <option key={day} value={day}>
                {day === today ? `${day} — сегодня` : day}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {items.length === 0 ? (
        <EmptyState title="Результатов за этот день нет" />
      ) : (
        items.map((item) => (
          <article
            key={item.attemptId}
            data-testid="delivery-history-item"
            data-order-number={item.orderNumber}
            data-masked={item.masked ? 'yes' : 'no'}
            className={[
              'delivery__history-item',
              item.cancelled ? 'delivery__history-item--cancelled' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <div className="delivery__order-head">
              <span className="delivery__order-number">{item.orderNumber}</span>
              <StatusBadge tone={item.outcome === 'DELIVERED' ? 'success' : 'error'}>
                {item.outcome === 'DELIVERED' ? 'Доставлен' : 'Не доставлен'}
              </StatusBadge>
            </div>
            <div className="delivery__order-muted">
              {item.routeNumber} · {formatMoscowDateTime(item.occurredAt)}
              {item.cancelled ? ' · отменён' : ''}
            </div>
            {item.reasonName === null ? null : (
              <div className="delivery__order-line">{item.reasonName}</div>
            )}
            {item.masked ? (
              <div className="delivery__order-muted">
                Адрес и получатель скрыты: доставка завершена.
              </div>
            ) : (
              <>
                {item.address === null ? null : (
                  <div className="delivery__order-line">{item.address}</div>
                )}
                {item.addressDetails === null ? null : (
                  <div className="delivery__order-muted">{item.addressDetails}</div>
                )}
                {item.recipient === null ? null : (
                  <div className="delivery__order-muted">{item.recipient}</div>
                )}
                {item.comment === null ? null : (
                  <div className="delivery__order-muted">{item.comment}</div>
                )}
              </>
            )}
          </article>
        ))
      )}
    </div>
  );
}
