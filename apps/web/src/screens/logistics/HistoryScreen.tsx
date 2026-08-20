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
import { formatMoscowDateTime, formatMoscowTime } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
  TextInput,
} from '../../ui/components';
import { formatDate, moscowToday, ROUTE_STATE_LABELS } from '../routing/routing';
import './history.css';
import { CourierCombobox } from './CourierCombobox';

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

interface HistoryPayment {
  id: string;
  occurredAt: string;
  kind: string;
  amountMinor: string;
  courierName: string;
  actorName: string | null;
  reason: string | null;
  reversed: boolean;
}

interface HistoryPage {
  days: { date: string; routes: HistoryRouteRow[]; payments: HistoryPayment[] }[];
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
    /** Подробности события. Для смены состояния — откуда и куда. */
    details?: { fromState?: string | null; toState?: string | null } | null;
  }[];
}

const PAGE_SIZE = 20;

/** Названия денежных операций в истории. */
const PAYMENT_LABELS: Record<string, string> = {
  EXPENSE_PARKING: 'Дополнительный расход',
  EXPENSE_TOLL: 'Дополнительный расход',
  EXPENSE_TRANSIT: 'Дополнительный расход',
  EXPENSE_REPAIR: 'Дополнительный расход',
  EXPENSE_LOADING: 'Дополнительный расход',
  EXPENSE_OTHER: 'Дополнительный расход',
  BONUS: 'Дополнительный расход',
  ATTEMPT_FEE: 'Дополнительный расход',
  CASH_HANDED_TO_LOGIST: 'Курьер сдал',
  CASH_ISSUED_TO_COURIER: 'Выдано курьеру',
  ADJUSTMENT: 'Обратная корректировка',
  DESK_RECEIVED_FROM_COURIER: 'Касса: получено от курьера',
  DESK_ISSUED_TO_COURIER: 'Касса: выдано курьеру',
  DESK_TAKEN_FROM_COMPANY: 'Касса: взято из компании',
  DESK_HANDED_TO_COMPANY: 'Касса: сдано в компанию',
  DESK_ADJUSTMENT: 'Касса: обратная корректировка',
};

/** Готовые периоды отбора: день, неделя, месяц назад от сегодняшнего дня. */
const HISTORY_PERIODS = [
  { key: 'day', title: 'День', days: 0 },
  { key: 'week', title: 'Неделя', days: 7 },
  { key: 'month', title: 'Месяц', days: 30 },
] as const;

/**
 * Границы периода в календарных днях Москвы.
 *
 * Считается от сегодняшнего дня назад: «неделя» — это последние семь дней
 * вместе с текущим, а не календарная неделя с понедельника. Логист спрашивает
 * историю именно так.
 */
function periodRange(days: number): { from: string; to: string } {
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const start = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: start.toISOString().slice(0, 10), to };
}

/**
 * Подпись события хронологии.
 *
 * Смена состояния приходит с сервера строкой из значений перечня —
 * «Состояние: ACTIVE → COMPLETED». Человеку это ничего не говорит, а сами
 * значения сервер уже отдаёт отдельными полями, так что называем их здесь,
 * теми же словами, что и плашка состояния на строке маршрута.
 */
function eventLabel(event: {
  label: string;
  details?: { fromState?: string | null; toState?: string | null } | null;
}): string {
  const from = event.details?.fromState;
  const to = event.details?.toState;
  if (typeof from !== 'string' || typeof to !== 'string') {
    return event.label;
  }
  const named = (state: string): string =>
    ROUTE_STATE_LABELS[state as keyof typeof ROUTE_STATE_LABELS] ?? state;
  return `Состояние: ${named(from)} → ${named(to)}`;
}

/** Доля заказов в процентах для полосы результата. Нулевой маршрут — пустая полоса. */
function barShare(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 100);
}

/** Деньги в истории показываются так же, как в отчётах. */
function money(minor: string): string {
  // Величина без знака: направление операции названо её видом.
  const value = BigInt(minor);
  const positive = value < 0n ? -value : value;
  return `${(Number(positive) / 100).toFixed(2).replace('.', ',')} ₽`;
}

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
              {/*
                Порядок остановки: номер, время, исход, адрес. Исход стоит
                до адреса — по нему разбирают день, а адрес только уточняет,
                о какой именно остановке речь.
              */}
              <span className="history__position">{order.position}</span>
              <span className="history__order-number">{order.number}</span>
              <span className="history__order-interval">{order.interval ?? '—'}</span>
              {order.removedAt !== null && (
                <StatusBadge tone="neutral">выведен из маршрута</StatusBadge>
              )}
              {order.outcome === 'DELIVERED' && <StatusBadge tone="success">Доставлен</StatusBadge>}
              {order.outcome === 'NOT_DELIVERED' && (
                <StatusBadge tone="error">
                  Не доставлен{order.failureReason === null ? '' : `: ${order.failureReason}`}
                </StatusBadge>
              )}
              {/* Адрес идёт последним и забирает остаток строки: он длиннее всех. */}
              <span className="history__order-address" title={order.address ?? undefined}>
                {order.address ?? '—'}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="history__block">
        <h4 className="history__block-title">Хронология</h4>
        <ul className="history__events" data-testid="history-events">
          {details.data.events.map((event, index) => (
            <li key={`${event.occurredAt}-${event.action}-${index}`} className="history__event">
              {/*
                Только время: день уже назван заголовком выше, и повторять
                дату в каждой строке значило бы отдать ей треть ширины.
              */}
              <span className="history__event-time">{formatMoscowTime(event.occurredAt)}</span>
              <span className="history__event-label">{eventLabel(event)}</span>
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
      client.get<{ items: { id: string; fullName: string; phone: string | null }[] }>(
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
        {/*
          Готовые периоды вместо счёта дней в уме.

          «Последняя неделя» — самый частый вопрос к истории, и набирать
          под него две даты руками приходилось каждый раз. Кнопки только
          подставляют границы: сами поля остаются, и любой другой период
          по-прежнему набирается вручную.
        */}
        <div className="history__periods" role="group" aria-label="Период">
          {HISTORY_PERIODS.map((period) => {
            const range = periodRange(period.days);
            const active = from === range.from && to === range.to;
            return (
              <button
                key={period.key}
                type="button"
                className={active ? 'history__period history__period--on' : 'history__period'}
                aria-pressed={active}
                data-testid={`history-period-${period.key}`}
                onClick={() => {
                  setFrom(range.from);
                  setTo(range.to);
                }}
              >
                {period.title}
              </button>
            );
          })}
        </div>

        <div className="history__range">
          <TextInput
            type="date"
            value={from}
            aria-label="С"
            data-testid="history-from"
            onChange={(event) => setFrom(event.target.value)}
          />
          <span className="history__range-dash" aria-hidden="true">
            –
          </span>
          <TextInput
            type="date"
            value={to}
            aria-label="По"
            data-testid="history-to"
            onChange={(event) => setTo(event.target.value)}
          />
        </div>

        {/*
          Курьер выбирается вводом с подсказками, а не длинным списком:
          курьеров десятки, и искать нужного прокруткой дольше, чем набрать
          три буквы имени или цифры телефона. Контрол тот же, что и на других
          экранах, — привыкать заново не приходится.
        */}
        <div className="history__courier" data-testid="history-courier">
          <CourierCombobox
            options={couriers.data?.items ?? []}
            value={(couriers.data?.items ?? []).find((item) => item.id === courierUserId) ?? null}
            label="Курьер"
            emptyLabel="Любой курьер"
            testId="history-courier-combobox"
            onChange={(courier) => setCourierUserId(courier === null ? '' : courier.id)}
          />
        </div>

        <select
          className="history__select"
          value={state}
          aria-label="Состояние"
          data-testid="history-state"
          onChange={(event) => setState(event.target.value)}
        >
          <option value="">Любое состояние</option>
          {Object.entries(ROUTE_STATE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>

        <TextInput
          className="history__search"
          value={search}
          aria-label="Поиск"
          placeholder="Номер листа, номер заказа или курьер"
          data-testid="history-search"
          onChange={(event) => setSearch(event.target.value)}
        />
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
              {/*
                Сводка стоит рядом с датой: сколько маршрутов было и чем
                кончились. Без неё день приходилось пересчитывать глазами
                по строкам.
              */}
              <div className="history__day-head">
                <h3 className="history__day-title">{formatDate(day.date)}</h3>
                <span className="history__day-summary">
                  маршрутов {day.routes.length} · доставлено{' '}
                  {day.routes.reduce((sum, route) => sum + route.deliveredCount, 0)}
                  {day.routes.some((route) => route.failedCount > 0)
                    ? ` · не доставлено ${day.routes.reduce((sum, route) => sum + route.failedCount, 0)}`
                    : ''}
                </span>
              </div>

              {/*
                Денежные операции дня: сдача, выдача и дополнительные расходы.
                Это тоже прошлое, и «Историю» о нём обязаны спрашивать здесь,
                а не в отчётах.
              */}
              {day.payments.length > 0 && (
                <div className="history__money">
                  <span className="history__money-title">Деньги за день</span>
                  <ul className="history__payments" data-testid="history-payments">
                    {day.payments.map((payment) => (
                      <li
                        key={payment.id}
                        className="history__payment"
                        data-payment-kind={payment.kind}
                      >
                        {/*
                          Только время: день назван заголовком выше. Полная дата
                          не помещалась в узкую колонку и наезжала на название
                          операции.
                        */}
                        <span className="history__event-time">
                          {formatMoscowTime(payment.occurredAt)}
                        </span>
                        <span className="history__event-label">
                          {PAYMENT_LABELS[payment.kind] ?? payment.kind}
                        </span>
                        <span className="history__payment-amount">
                          {money(payment.amountMinor)}
                        </span>
                        <span className="history__event-actor">
                          {payment.courierName} · {payment.actorName ?? 'автор неизвестен'}
                        </span>
                        {payment.reason !== null && (
                          <span className="history__event-reason">{payment.reason}</span>
                        )}
                        {payment.reversed && <span className="history__tag">отменена</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/*
                Лоток вдавлен, маршруты внутри подняты — как в «Листах»
                и «Требуют решения»: одна и та же мысль об одном и том же.
              */}
              <div className="history__tray" role="table" aria-label={`Маршруты ${day.date}`}>
                <div className="history__head" role="row">
                  <span role="columnheader">Маршрут</span>
                  <span role="columnheader">Курьер</span>
                  <span role="columnheader">Результат</span>
                  <span role="columnheader" className="history__head-last">
                    Последний результат
                  </span>
                </div>
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
                        <span className="history__cell history__cell--route">
                          <span className="history__number">{route.number}</span>
                          <StatusBadge tone={route.state === 'CANCELLED' ? 'neutral' : 'info'}>
                            {ROUTE_STATE_LABELS[route.state]}
                          </StatusBadge>
                        </span>

                        <span className="history__cell muted">
                          {route.courier?.fullName ?? 'курьер не назначен'}
                        </span>

                        {/*
                        Полоса показывает исход маршрута раньше, чем прочитаны
                        числа: зелёное — доставлено, красное — нет, пустое —
                        результатов ещё не было.
                      */}
                        <span className="history__cell history__cell--result">
                          <span className="history__bar" aria-hidden="true">
                            <span
                              className="history__bar-ok"
                              style={{
                                width: `${barShare(route.deliveredCount, route.orderCount)}%`,
                              }}
                            />
                            <span
                              className="history__bar-fail"
                              style={{ width: `${barShare(route.failedCount, route.orderCount)}%` }}
                            />
                          </span>
                          <span className="muted">
                            {route.deliveredCount} из {route.orderCount}
                            {route.failedCount > 0 ? ` · не доставлено ${route.failedCount}` : ''}
                          </span>
                        </span>

                        <span className="history__cell history__cell--last">
                          <span className="muted history__time">
                            {route.lastResultAt === null
                              ? 'без результатов'
                              : formatMoscowDateTime(route.lastResultAt)}
                          </span>
                          <span className="history__chevron" aria-hidden="true">
                            {openId === route.id ? '▲' : '▼'}
                          </span>
                        </span>
                      </button>

                      {openId === route.id && <RouteDetails routeId={route.id} />}
                    </li>
                  ))}
                </ul>
              </div>
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
