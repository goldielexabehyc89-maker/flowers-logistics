/**
 * Экран «Сделки» — рабочий список доставок выбранного дня.
 *
 * Плотный интерфейс без украшений: логист смотрит его весь день и ему нужны
 * факты, а не карточки с воздухом. Заказы, требующие внимания, всегда сверху
 * и выделены — иначе они теряются среди обычных.
 *
 * Черновики, маршруты и отгрузка здесь намеренно не изображаются: они появятся
 * на этапе 4, а нарисованные заранее выглядели бы как готовая функция.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Pagination,
  StatusBadge,
  TextInput,
} from '../../ui/components';
import { IntervalModal } from './IntervalModal';
import {
  attentionLabel,
  describeIntegration,
  effectiveInterval,
  EMPTY_VALUE,
  formatDate,
  formatMoney,
  groupOrders,
  moscowToday,
  SCOPE_EXIT_LABELS,
  type IntegrationState,
  type OrderListResponse,
  type OrderView,
} from './deals';
import './deals.css';

const PAGE_SIZE = 50;

interface StatusResponse {
  integrations: { provider: string; state: IntegrationState }[];
}

export function DealsScreen(): React.JSX.Element {
  const { client, user } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const isAdmin = user?.roles.includes('ADMIN') === true;

  const [date, setDate] = useState(moscowToday());
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<OrderView | null>(null);
  const [intervalError, setIntervalError] = useState<string | null>(null);

  // Поиск отменяет фильтр по дню: сервер ищет по всем датам, иначе найденный
  // заказ другого дня просто не показался бы.
  const searching = search !== '';

  const listKey = ['orders', date, search, offset] as const;

  const query = useQuery({
    queryKey: listKey,
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (searching) {
        params.set('search', search);
      } else {
        params.set('deliveryDate', date);
      }
      return client.get<OrderListResponse>(`/api/orders?${params.toString()}`);
    },
  });

  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => client.get<StatusResponse>('/api/status'),
  });

  const moysklad = status.data?.integrations.find(
    (integration) => integration.provider === 'moysklad',
  );
  const integration = describeIntegration(moysklad?.state);

  const setInterval = useMutation({
    mutationFn: (input: { order: OrderView; startMinute: number; endMinute: number }) =>
      client.put<{ orderId: string }>(`/api/orders/${input.order.id}/interval`, {
        startMinute: input.startMinute,
        endMinute: input.endMinute,
        version: input.order.version,
      }),
    onSuccess: async () => {
      setEditing(null);
      setIntervalError(null);
      showToast('Интервал сохранён', 'success');
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (error: unknown) => {
      setIntervalError(
        error instanceof ApiError
          ? error.message
          : 'Не удалось сохранить интервал. Повторите попытку.',
      );
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        void queryClient.invalidateQueries({ queryKey: ['orders'] });
      }
    },
  });

  // Смена дня и текста поиска возвращает на первую страницу: иначе на второй
  // странице нового фильтра оказался бы пустой список.
  useEffect(() => {
    setOffset(0);
  }, [date, search]);

  const items = query.data?.items ?? [];
  const groups = groupOrders(items);

  return (
    <section className="stack">
      <header className="deals__header">
        <div>
          <h2>Сделки</h2>
          <p className="muted text-sm">
            Доставки выбранного дня. Заказы без распознанной даты показываются всегда.
          </p>
        </div>
        <div className="deals__integration">
          <StatusBadge tone={integration.tone}>{integration.label}</StatusBadge>
          <span className="text-sm muted">{integration.hint}</span>
          {isAdmin && moysklad !== undefined && (
            // Администратору дополнительно видно техническое состояние. Счётчики
            // очереди живут на отдельном админском маршруте и показаны
            // в «Настройках»: сюда они не тянутся ради одной строки.
            <span className="text-sm muted">состояние интеграции: {moysklad.state}</span>
          )}
        </div>
      </header>

      <form
        className="deals__filters"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(searchInput.trim());
        }}
      >
        <Field label="Дата доставки">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              disabled={searching}
            />
          )}
        </Field>
        <Field label="Поиск по номеру, адресу или получателю">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Например: A-1024 или Ленина"
            />
          )}
        </Field>
        <div className="deals__filter-actions">
          <Button type="submit">Найти</Button>
          {searching && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSearchInput('');
                setSearch('');
              }}
            >
              Сбросить поиск
            </Button>
          )}
        </div>
      </form>

      {searching && (
        <p className="text-sm muted">
          Поиск идёт по всем датам, фильтр дня временно не применяется.
        </p>
      )}

      {query.isPending ? (
        <LoadingState title="Загружаем заказы…" />
      ) : query.isError ? (
        <ErrorState
          title="Не удалось загрузить заказы"
          description="Сервис не ответил. Данные могли остаться прежними."
          onRetry={() => void query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={searching ? 'Ничего не найдено' : 'На эту дату заказов нет'}
          description={
            searching
              ? 'Проверьте номер, адрес или получателя.'
              : 'Как только заказ появится в МоемСкладе, он окажется здесь автоматически.'
          }
        />
      ) : (
        <>
          {groups.attention.length > 0 && (
            <OrderGroup
              title="Требуют внимания"
              description="Эти заказы нельзя планировать, пока данные не приведены в порядок."
              tone="attention"
              orders={groups.attention}
              onEditInterval={(order) => {
                setIntervalError(null);
                setEditing(order);
              }}
            />
          )}

          {groups.unassigned.length > 0 && (
            <OrderGroup
              title="Нераспределённые"
              description="Заказы готовы к планированию. Маршруты появятся на этапе 4."
              tone="normal"
              orders={groups.unassigned}
              onEditInterval={(order) => {
                setIntervalError(null);
                setEditing(order);
              }}
            />
          )}

          <Pagination
            offset={offset}
            limit={PAGE_SIZE}
            total={query.data?.total ?? 0}
            onChange={setOffset}
          />
        </>
      )}

      {editing !== null && (
        <IntervalModal
          order={editing}
          error={intervalError}
          pending={setInterval.isPending}
          onCancel={() => {
            setEditing(null);
            setIntervalError(null);
          }}
          onSubmit={(values) => setInterval.mutate({ order: editing, ...values })}
        />
      )}
    </section>
  );
}

function OrderGroup({
  title,
  description,
  tone,
  orders,
  onEditInterval,
}: {
  title: string;
  description: string;
  tone: 'attention' | 'normal';
  orders: readonly OrderView[];
  onEditInterval: (order: OrderView) => void;
}): React.JSX.Element {
  return (
    <section className={`deals__group deals__group--${tone}`}>
      <header className="deals__group-header">
        <h3>
          {title} <span className="deals__count">{orders.length}</span>
        </h3>
        <p className="muted text-sm">{description}</p>
      </header>

      <ul className="deals__list">
        {orders.map((order) => (
          <OrderRow key={order.id} order={order} onEditInterval={onEditInterval} />
        ))}
      </ul>
    </section>
  );
}

function OrderRow({
  order,
  onEditInterval,
}: {
  order: OrderView;
  onEditInterval: (order: OrderView) => void;
}): React.JSX.Element {
  const interval = effectiveInterval(order.interval);

  return (
    <li className={`deals__row${order.needsAttention ? ' deals__row--attention' : ''}`}>
      <div className="deals__row-main">
        <div className="deals__row-head">
          <span className="deals__number">{order.number}</span>
          <span className="deals__date">{formatDate(order.deliveryDate)}</span>
          <span className="deals__interval">
            {interval.text}
            {interval.manual && <span className="deals__manual">исправлено вручную</span>}
          </span>
          {order.externalState.name !== null && (
            <StatusBadge tone="neutral">{order.externalState.name}</StatusBadge>
          )}
          {!order.scope.inScope && (
            <StatusBadge tone="warning">
              {order.scope.exitReason === null
                ? 'Вне нашей доставки'
                : (SCOPE_EXIT_LABELS[order.scope.exitReason] ?? 'Вне нашей доставки')}
            </StatusBadge>
          )}
        </div>

        <div className="deals__row-body">
          <span className="deals__address">{order.address ?? EMPTY_VALUE}</span>
          <span className="deals__recipient">{order.recipient ?? EMPTY_VALUE}</span>
          {order.comment !== null && <span className="deals__comment">{order.comment}</span>}
        </div>

        <div className="deals__row-meta">
          <span className="text-sm muted">
            В МоемСкладе: {order.interval.raw === null ? EMPTY_VALUE : order.interval.raw}
          </span>
          <span className="text-sm">
            Сумма: <strong>{formatMoney(order.money.sum)}</strong>
          </span>
          <span className="text-sm">
            {order.money.cashCollectable ? 'Курьер получает: ' : 'К получению: '}
            <strong>{formatMoney(order.money.cashToCollect)}</strong>
          </span>
          {order.money.anomaly && <StatusBadge tone="error">Переплата</StatusBadge>}
        </div>

        {order.attentionReasons.length > 0 && (
          <ul className="deals__reasons">
            {order.attentionReasons.map((reason) => (
              <li key={reason}>{attentionLabel(reason)}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="deals__row-actions">
        <Button
          onClick={() => onEditInterval(order)}
          disabled={!order.scope.inScope}
          title={
            order.scope.inScope ? 'Задать интервал вручную' : 'Заказ не относится к нашей доставке'
          }
        >
          Интервал
        </Button>
      </div>
    </li>
  );
}
