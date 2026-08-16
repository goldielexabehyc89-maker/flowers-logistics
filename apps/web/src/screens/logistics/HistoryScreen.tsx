/**
 * Вкладка «История».
 *
 * Только просмотр прошлого: что произошло с маршрутом и его заказами, кто это
 * сделал, когда и почему. Рабочих кнопок здесь нет ни одной — состояние
 * меняется в «Маршрутизации» и «Маршрутных листах», а не в журнале.
 *
 * Отбор и поиск считает сервер: страница показывает ровно то, что он вернул,
 * и фильтрация загруженных строк на клиенте не выполняется — иначе маршрут
 * со второй страницы исчезал бы из поиска.
 */

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatMoscowDateTime } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  StatusBadge,
  TextInput,
} from '../../ui/components';
import { formatDate, moscowToday, ROUTE_STATE_LABELS } from '../routing/routing';
import './history.css';

interface HistoryRouteRow {
  id: string;
  number: string;
  deliveryDate: string;
  state: keyof typeof ROUTE_STATE_LABELS;
  vehicleType: string;
  courier: { id: string; fullName: string } | null;
  orderCount: number;
  deliveredCount: number;
  failedCount: number;
  lastResultAt: string | null;
}

interface HistoryPage {
  days: { date: string; routes: HistoryRouteRow[] }[];
  total: number;
  hasMore: boolean;
}

interface HistoryDetails {
  route: HistoryRouteRow;
  orders: {
    routeOrderId: string;
    position: number;
    number: string;
    address: string | null;
    recipient: string | null;
    interval: string | null;
    outcome: string | null;
    outcomeAt: string | null;
    failureReason: string | null;
    removedAt: string | null;
  }[];
  events: {
    occurredAt: string;
    action: string;
    label: string;
    actor: { id: string; fullName: string } | null;
    reason: string | null;
  }[];
}

const PAGE_SIZE = 20;

/** Начало периода по умолчанию: неделя назад — обычный горизонт разбора. */
function weekAgo(today: string): string {
  const instant = new Date(`${today}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() - 7);
  return instant.toISOString().slice(0, 10);
}

function RouteDetails({ routeId }: { routeId: string }): React.JSX.Element {
  const { client } = useAuth();
  const details = useQuery({
    queryKey: ['history-route', routeId],
    queryFn: () => client.get<HistoryDetails>(`/api/logistics/history/routes/${routeId}`),
  });

  if (details.isPending) {
    return <LoadingState title="Загружаем историю маршрута…" />;
  }
  if (details.isError) {
    return (
      <ErrorState title="Не удалось загрузить историю" onRetry={() => void details.refetch()} />
    );
  }

  return (
    <div className="history__details">
      <div className="history__block">
        <h4 className="history__block-title">Итоговый состав</h4>
        <ul className="history__orders">
          {details.data.orders.map((order) => (
            <li
              key={order.routeOrderId}
              className="history__order"
              data-order-number={order.number}
            >
              <span className="history__position">{order.position}</span>
              <span className="history__order-number">{order.number}</span>
              <span className="history__order-address" title={order.address ?? undefined}>
                {order.address ?? '—'}
              </span>
              <span className="history__order-recipient">{order.recipient ?? '—'}</span>
              <span className="history__order-interval">{order.interval ?? '—'}</span>
              {order.removedAt !== null && (
                <span className="history__tag">выведен из маршрута</span>
              )}
              {order.outcome === 'DELIVERED' && <span className="history__ok">Доставлен</span>}
              {order.outcome === 'NOT_DELIVERED' && (
                <span className="history__fail">
                  Не доставлен{order.failureReason === null ? '' : `: ${order.failureReason}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="history__block">
        <h4 className="history__block-title">Хронология</h4>
        <ul className="history__events" data-testid="history-events">
          {details.data.events.map((event, index) => (
            <li key={`${event.occurredAt}-${event.action}-${index}`} className="history__event">
              <span className="history__event-time">{formatMoscowDateTime(event.occurredAt)}</span>
              <span className="history__event-label">{event.label}</span>
              <span className="history__event-actor">{event.actor?.fullName ?? 'система'}</span>
              {event.reason !== null && (
                <span className="history__event-reason">Причина: {event.reason}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function HistoryScreen(): React.JSX.Element {
  const { client } = useAuth();
  const today = moscowToday();

  const [from, setFrom] = useState(weekAgo(today));
  const [to, setTo] = useState(today);
  const [search, setSearch] = useState('');
  const [courierUserId, setCourierUserId] = useState('');
  const [state, setState] = useState('');
  const [pages, setPages] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const couriers = useQuery({
    queryKey: ['couriers-for-routes'],
    queryFn: () =>
      client.get<{ items: { id: string; fullName: string }[] }>(
        '/api/users?role=COURIER&status=ACTIVE&limit=100',
      ),
  });

  const history = useQuery({
    queryKey: ['logistics-history', from, to, search, courierUserId, state, pages],
    queryFn: () => {
      const params = new URLSearchParams({
        from,
        to,
        limit: String(PAGE_SIZE * pages),
        offset: '0',
      });
      if (search.trim() !== '') {
        params.set('search', search.trim());
      }
      if (courierUserId !== '') {
        params.set('courierUserId', courierUserId);
      }
      if (state !== '') {
        params.set('state', state);
      }
      return client.get<HistoryPage>(`/api/logistics/history?${params.toString()}`);
    },
  });

  return (
    <section className="history" data-testid="history-screen">
      <div className="history__filters">
        <Field label="С">
          {(props) => (
            <TextInput
              {...props}
              type="date"
              value={from}
              data-testid="history-from"
              onChange={(event) => setFrom(event.target.value)}
            />
          )}
        </Field>
        <Field label="По">
          {(props) => (
            <TextInput
              {...props}
              type="date"
              value={to}
              data-testid="history-to"
              onChange={(event) => setTo(event.target.value)}
            />
          )}
        </Field>
        <Field label="Курьер">
          {(props) => (
            <select
              {...props}
              className="history__select"
              value={courierUserId}
              data-testid="history-courier"
              onChange={(event) => setCourierUserId(event.target.value)}
            >
              <option value="">Любой</option>
              {(couriers.data?.items ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.fullName}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Состояние">
          {(props) => (
            <select
              {...props}
              className="history__select"
              value={state}
              data-testid="history-state"
              onChange={(event) => setState(event.target.value)}
            >
              <option value="">Любое</option>
              {Object.entries(ROUTE_STATE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Поиск" hint="Номер листа, номер заказа, курьер">
          {(props) => (
            <TextInput
              {...props}
              value={search}
              placeholder="Например, R-12 или 212109"
              data-testid="history-search"
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </Field>
      </div>

      {history.isPending ? (
        <LoadingState title="Загружаем историю…" />
      ) : history.isError ? (
        <ErrorState title="Не удалось загрузить историю" onRetry={() => void history.refetch()} />
      ) : history.data.days.length === 0 ? (
        <EmptyState
          title="За выбранный период записей нет"
          description="Измените период или условия отбора."
        />
      ) : (
        <>
          {history.data.days.map((day) => (
            <section key={day.date} className="history__day" data-testid="history-day">
              <h3 className="history__day-title">{formatDate(day.date)}</h3>
              <ul className="history__list">
                {day.routes.map((route) => (
                  <li
                    key={route.id}
                    className="history__row"
                    data-testid="history-route"
                    data-route-number={route.number}
                    data-expanded={openId === route.id ? 'true' : 'false'}
                  >
                    <button
                      type="button"
                      className="history__row-head"
                      aria-expanded={openId === route.id}
                      data-testid="history-expand"
                      onClick={() => setOpenId(openId === route.id ? null : route.id)}
                    >
                      <span className="history__number">{route.number}</span>
                      <StatusBadge tone={route.state === 'CANCELLED' ? 'neutral' : 'info'}>
                        {ROUTE_STATE_LABELS[route.state]}
                      </StatusBadge>
                      <span className="muted">
                        {route.courier?.fullName ?? 'курьер не назначен'}
                      </span>
                      <span className="muted">
                        заказов: {route.orderCount} · доставлено: {route.deliveredCount}
                        {route.failedCount > 0 ? ` · не доставлено: ${route.failedCount}` : ''}
                      </span>
                      <span className="muted history__time">
                        {route.lastResultAt === null
                          ? 'результатов нет'
                          : formatMoscowDateTime(route.lastResultAt)}
                      </span>
                      <span className="history__chevron" aria-hidden="true">
                        {openId === route.id ? '▲' : '▼'}
                      </span>
                    </button>

                    {openId === route.id && <RouteDetails routeId={route.id} />}
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {history.data.hasMore && (
            <Button data-testid="history-more" onClick={() => setPages((current) => current + 1)}>
              Показать ещё
            </Button>
          )}
        </>
      )}
    </section>
  );
}
