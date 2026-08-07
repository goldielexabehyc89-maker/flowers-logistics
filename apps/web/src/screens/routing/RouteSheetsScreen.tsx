/**
 * Экран «Маршрутные листы»: подтверждённые маршруты выбранного дня и печать.
 *
 * Печать сделана обычным CSS `@media print`, без отдельного генератора PDF:
 * лист — это тот же список остановок, а второй движок вёрстки означал бы вторую
 * версию правды о порядке доставки.
 *
 * Карты, расстояний и расчётного времени в листе нет: этих данных не существует,
 * а курьер поедет по напечатанному и поверит любой цифре.
 */

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
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
import {
  conflictLabel,
  formatDate,
  moscowToday,
  stopInterval,
  VEHICLE_LABELS,
  type RouteCardView,
  type RouteListResponse,
} from './routing';
import './routing.css';

export function RouteSheetsScreen(): React.JSX.Element {
  const { client } = useAuth();
  const [date, setDate] = useState(moscowToday());
  const [openId, setOpenId] = useState<string | null>(null);

  const routes = useQuery({
    queryKey: ['routes', date, 'CONFIRMED'],
    queryFn: () =>
      client.get<RouteListResponse>(`/api/routes?deliveryDate=${date}&state=CONFIRMED&limit=100`),
  });

  const sheet = useQuery({
    queryKey: ['route', openId],
    queryFn: () => client.get<RouteCardView>(`/api/routes/${openId ?? ''}`),
    enabled: openId !== null,
  });

  const items = routes.data?.items ?? [];

  return (
    <section className="stack">
      <header className="routes__header no-print">
        <div>
          <h2>Маршрутные листы</h2>
          <p className="muted text-sm">
            Подтверждённые маршруты выбранного дня. Лист печатается как есть, без карты и расчётного
            времени.
          </p>
        </div>
      </header>

      <div className="routes__filters no-print">
        <Field label="Дата доставки">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                setOpenId(null);
              }}
            />
          )}
        </Field>
      </div>

      <div className="no-print">
        {routes.isPending ? (
          <LoadingState title="Загружаем маршруты…" />
        ) : routes.isError ? (
          <ErrorState title="Не удалось загрузить маршруты" onRetry={() => void routes.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title="Подтверждённых маршрутов на этот день нет"
            description="Подтвердите черновик в разделе «Маршрутизация», и он появится здесь."
          />
        ) : (
          <ul className="routes__list">
            {items.map((route) => (
              <li key={route.id} className="routes__list-item">
                <div>
                  <span className="routes__number">{route.number}</span>
                  <div className="muted text-sm">
                    {formatDate(route.deliveryDate)} · {VEHICLE_LABELS[route.vehicleType]} ·{' '}
                    заказов: {route.orderCount}
                  </div>
                  <div className="muted text-sm">
                    Курьер: {route.courier?.fullName ?? 'не назначен'}
                  </div>
                </div>
                <Button onClick={() => setOpenId(route.id)}>Открыть лист</Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {openId !== null && (
        <>
          {sheet.isPending ? (
            <LoadingState title="Готовим маршрутный лист…" />
          ) : sheet.isError || sheet.data === undefined ? (
            <ErrorState title="Не удалось загрузить лист" onRetry={() => void sheet.refetch()} />
          ) : (
            <article className="sheet">
              <header className="sheet__header">
                <div>
                  <h3>Маршрутный лист {sheet.data.number}</h3>
                  <p className="text-sm">
                    Дата: {formatDate(sheet.data.deliveryDate)} · Транспорт:{' '}
                    {VEHICLE_LABELS[sheet.data.vehicleType]} · Курьер:{' '}
                    {sheet.data.courier?.fullName ?? 'не назначен'}
                  </p>
                </div>
                <div className="no-print sheet__controls">
                  <Button variant="primary" onClick={() => window.print()}>
                    Печать
                  </Button>
                  <Button onClick={() => setOpenId(null)}>Закрыть</Button>
                </div>
              </header>

              <ol className="sheet__stops">
                {sheet.data.orders.map((item) => (
                  <li key={item.routeOrderId} className="sheet__stop">
                    <div className="sheet__stop-head">
                      <span className="sheet__position">{item.position}</span>
                      <span className="routes__number">{item.order.number}</span>
                      <span>{stopInterval(item.order.interval)}</span>
                    </div>
                    <div className="sheet__stop-line">
                      <strong>{item.order.address ?? '—'}</strong>
                    </div>
                    <div className="sheet__stop-line">{item.order.recipient ?? '—'}</div>
                    {item.order.comment !== null && (
                      <div className="sheet__stop-line">Комментарий: {item.order.comment}</div>
                    )}
                    <div className="sheet__stop-line">
                      {item.order.cashToCollect === null
                        ? 'Наличные не принимаются'
                        : `К получению: ${item.order.cashToCollect} ₽`}
                    </div>
                    {(item.order.needsAttention || item.conflicts.length > 0) && (
                      <div className="sheet__warnings">
                        {item.order.needsAttention && <span>Требует внимания</span>}
                        {item.conflicts.map((conflict) => (
                          <span key={conflict.kind}>{conflictLabel(conflict.kind)}</span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ol>

              {sheet.data.orders.length === 0 && <p className="text-sm">В маршруте нет заказов.</p>}

              <footer className="sheet__footer text-sm">
                Итого остановок: {sheet.data.orders.length}. Состояние маршрута:{' '}
                <StatusBadge tone="info">подтверждён</StatusBadge>
              </footer>
            </article>
          )}
        </>
      )}
    </section>
  );
}
