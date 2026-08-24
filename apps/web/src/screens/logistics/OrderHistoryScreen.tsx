/**
 * Экран «История заказа»: что с букетом было и кто это сделал.
 *
 * Экран ТОЛЬКО читает. Ни одной кнопки, меняющей заказ, здесь нет намеренно:
 * история — это место, где разбираются в случившемся, и правка из него
 * породила бы событие о самом разборе.
 *
 * Порядок строк, их названия, авторы и московские даты приходят с сервера
 * готовыми. Считать день в браузере нельзя: часовой пояс рабочего компьютера
 * к делу не относится, а «вчера» и «сегодня» у истории обязаны совпадать
 * с остальным приложением.
 *
 * Отменённые действия со строки не исчезают — они получают пометку. История,
 * из которой пропадают ошибочные шаги, отвечает на вопрос «что осталось»,
 * а нужен ответ «что происходило».
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { Button, ErrorState, LoadingState, StatusBadge } from '../../ui/components';
import { formatMoscowTime, formatMoscowDay } from './order-history';
import {
  GROUP_LABELS,
  PROCESS_LABELS,
  ROUTE_STATE_LABELS,
  RETURN_STATE_LABELS,
  actorLine,
  groupByDay,
  intervalLine,
  type TimelinePage,
} from './order-history';
import './order-history.css';

const PAGE_SIZE = 100;

export function OrderHistoryScreen(): React.JSX.Element {
  const { orderId = '' } = useParams<{ orderId: string }>();
  const { client } = useAuth();
  const navigate = useNavigate();

  /*
   * Страницы истории.
   *
   * Ключ содержит идентификатор заказа: две истории рядом не смешиваются,
   * а realtime обновляет ровно открытую. Догруженные страницы при обновлении
   * остаются на месте — прокрутка не прыгает к началу.
   */
  const query = useInfiniteQuery({
    queryKey: ['order-timeline', orderId],
    queryFn: ({ pageParam }) =>
      client.get<TimelinePage>(
        `/api/orders/${orderId}/timeline?limit=${PAGE_SIZE}` +
          (pageParam === null ? '' : `&cursor=${encodeURIComponent(pageParam)}`),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: TimelinePage) => last.nextCursor,
    enabled: orderId !== '',
  });

  const pages = query.data?.pages ?? [];
  const header = pages[0]?.header ?? null;
  const events = pages.flatMap((page) => page.events);
  const days = groupByDay(events);

  return (
    <section className="stack order-history" data-testid="order-history">
      <header className="order-history__top">
        <Button
          variant="secondary"
          data-testid="order-history-back"
          onClick={() => void navigate(-1)}
        >
          ← Назад
        </Button>
        <h1 className="order-history__title">
          История заказа {header === null ? '' : header.number}
        </h1>
      </header>

      {query.isPending && <LoadingState title="Загружаем историю…" />}
      {query.isError && (
        <ErrorState
          title="Не удалось загрузить историю заказа"
          onRetry={() => void query.refetch()}
        />
      )}

      {header !== null && (
        /*
          Шапка компактная: она отвечает «что с заказом сейчас», а подробности
          живут в ленте. Пустые поля не показываются вовсе — пустая подпись
          выглядит как потерянное значение.
        */
        <div className="card order-history__header" data-testid="order-history-header">
          <div className="order-history__facts">
            <Fact label="Номер" value={header.number} testId="order-history-number" />
            <Fact
              label="Стадия сборки"
              value={PROCESS_LABELS[header.processState] ?? header.processState}
            />
            <Fact label="Состояние в МоёмСкладе" value={header.externalState} />
            <Fact label="Способ получения" value={header.pickup ? 'Самовывоз' : 'Доставка'} />
            <Fact label="Дата доставки" value={formatMoscowDay(header.deliveryDate)} />
            <Fact label="Интервал" value={intervalLine(header.interval)} />
            <Fact label="Рабочий адрес" value={header.address} wide />
            <Fact label="Флорист" value={header.florist?.fullName ?? null} />
            <Fact
              label="Маршрутный лист"
              value={
                header.route === null
                  ? null
                  : `${header.route.number} · ${ROUTE_STATE_LABELS[header.route.state] ?? header.route.state}`
              }
            />
            <Fact label="Курьер" value={header.courier?.fullName ?? null} />
            <Fact
              label="Ячейка"
              value={header.cell === null ? null : `${header.cell.code} · ${header.cell.kind}`}
            />
            <Fact
              label="Результат доставки"
              value={
                header.delivery === null
                  ? null
                  : header.delivery.outcome === 'DELIVERED'
                    ? 'Доставлен'
                    : `Не доставлен${header.delivery.reason === null ? '' : ` · ${header.delivery.reason}`}`
              }
            />
            <Fact
              label="Возврат"
              value={
                header.returnObligation === null
                  ? null
                  : `${header.returnObligation.displayNumber} · ${
                      RETURN_STATE_LABELS[header.returnObligation.state] ??
                      header.returnObligation.state
                    }`
              }
            />
          </div>

          {header.cancellation !== null && (
            <p className="order-history__cancelled" data-testid="order-history-cancelled">
              <StatusBadge tone="error">
                {header.cancellation.source ? 'Отменён в МоёмСкладе' : 'Отменён логистом'}
              </StatusBadge>
            </p>
          )}
        </div>
      )}

      {query.isSuccess && events.length === 0 && (
        <p className="muted text-sm" data-testid="order-history-empty">
          Событий по этому заказу пока нет.
        </p>
      )}

      {days.map((day) => (
        <section key={day.date} className="order-history__day" data-testid="order-history-day">
          <h2 className="order-history__date">{formatMoscowDay(day.date)}</h2>
          <ol className="order-history__list">
            {day.events.map((entry) => (
              <li
                key={entry.key}
                className="order-history__event"
                data-testid="order-history-event"
                data-kind={entry.kind}
                data-group={entry.group}
                data-reverted={entry.reverted ? 'true' : 'false'}
              >
                <span className="order-history__time">{formatMoscowTime(entry.occurredAt)}</span>
                <span className="order-history__dot" aria-hidden="true" />
                <div className="order-history__body">
                  <p className="order-history__event-title">
                    {entry.title}
                    {entry.reverted && <StatusBadge tone="warning">отменено позже</StatusBadge>}
                  </p>
                  <p className="order-history__actor">
                    <span className="order-history__stage">{GROUP_LABELS[entry.group]}</span>
                    {actorLine(entry.actor)}
                  </p>
                  {entry.details.length > 0 && (
                    <dl className="order-history__details">
                      {entry.details.map((detail) => (
                        <div key={`${entry.key}:${detail.label}`}>
                          <dt>{detail.label}</dt>
                          <dd>{detail.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {entry.route !== null && (
                    <p className="order-history__link">Маршрутный лист {entry.route.number}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}

      {query.hasNextPage && (
        <Button
          variant="secondary"
          data-testid="order-history-more"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Загружаем…' : 'Показать продолжение'}
        </Button>
      )}
    </section>
  );
}

/** Поле шапки. Пустое значение не показывается: его отсутствие — тоже ответ. */
function Fact({
  label,
  value,
  wide,
  testId,
}: {
  label: string;
  value: string | null;
  wide?: boolean;
  testId?: string;
}): React.JSX.Element | null {
  if (value === null || value === '') {
    return null;
  }
  return (
    <div
      className={
        wide === true ? 'order-history__fact order-history__fact--wide' : 'order-history__fact'
      }
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      <span className="order-history__label">{label}</span>
      <span className="order-history__value">{value}</span>
    </div>
  );
}
