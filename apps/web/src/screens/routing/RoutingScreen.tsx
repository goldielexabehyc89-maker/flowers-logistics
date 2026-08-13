/**
 * Экран «Маршрутизация»: нераспределённые заказы слева, черновики дня справа.
 *
 * Карты, расстояний и расчётного времени здесь нет намеренно: этих данных
 * в системе не существует, и нарисованные цифры выглядели бы как факт.
 *
 * Перетаскивание не используется: состав меняется отметками и кнопками, поэтому
 * экран одинаково работает мышью, с клавиатуры и пальцем на телефоне, а лишняя
 * библиотека в проект не попадает.
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
  Select,
  StatusBadge,
  TextInput,
} from '../../ui/components';
import { RouteCard } from './RouteCard';
import { PlanningScreen } from '../planning/PlanningScreen';
import { MapPanel, requestMapPick } from './MapPanel';
import { geoHint, isMappable, type OrderGeo } from './geo';
import {
  conflictMessage,
  formatDate,
  moscowToday,
  ROUTE_STATE_LABELS,
  stopInterval,
  VEHICLE_LABELS,
  type RouteListResponse,
  type VehicleType,
} from './routing';
import './routing.css';

const PAGE_SIZE = 25;

interface UnassignedOrder {
  id: string;
  number: string;
  deliveryDate: string | null;
  interval: {
    raw: string | null;
    kind: string;
    startMinute: number | null;
    endMinute: number | null;
    manualStartMinute: number | null;
    manualEndMinute: number | null;
  };
  address: string | null;
  recipient: string | null;
  needsAttention: boolean;
  geo: OrderGeo;
  version: number;
}

interface UnassignedResponse {
  items: UnassignedOrder[];
  total: number;
}

export function RoutingScreen(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [date, setDate] = useState(moscowToday());
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [vehicleType, setVehicleType] = useState<VehicleType>('CAR');
  const [openRouteId, setOpenRouteId] = useState<string | null>(null);
  const [selectedOnMap, setSelectedOnMap] = useState<string | null>(null);
  const [targetRouteId, setTargetRouteId] = useState<string>('');

  useEffect(() => {
    setOffset(0);
    setSelected([]);
  }, [date, search]);

  const orders = useQuery({
    queryKey: ['unassigned-orders', date, search, offset],
    queryFn: () => {
      const params = new URLSearchParams({
        unassigned: 'true',
        deliveryDate: date,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (search !== '') {
        params.set('search', search);
      }
      return client.get<UnassignedResponse>(`/api/orders?${params.toString()}`);
    },
  });

  const routes = useQuery({
    queryKey: ['routes', date],
    queryFn: () =>
      client.get<RouteListResponse>(`/api/routes?deliveryDate=${date}&state=DRAFT&limit=100`),
  });

  const failure = (error: unknown): void => {
    const kind = error instanceof ApiError ? (error.conflict?.kind ?? undefined) : undefined;
    showToast(
      error instanceof ApiError
        ? conflictMessage(kind, error.message)
        : 'Не удалось выполнить операцию. Повторите попытку.',
      'error',
    );
    setSelected([]);
    void queryClient.invalidateQueries({ queryKey: ['routes'] });
    void queryClient.invalidateQueries({ queryKey: ['unassigned-orders'] });
    void queryClient.invalidateQueries({ queryKey: ['route'] });
  };

  const success = (message: string): void => {
    showToast(message, 'success');
    setSelected([]);
    void queryClient.invalidateQueries({ queryKey: ['routes'] });
    void queryClient.invalidateQueries({ queryKey: ['unassigned-orders'] });
    void queryClient.invalidateQueries({ queryKey: ['route'] });
  };

  const createRoute = useMutation({
    mutationFn: () =>
      client.post<{ id: string }>('/api/routes', { deliveryDate: date, vehicleType }),
    onSuccess: (created) => {
      setOpenRouteId(created.id);
      success('Черновик создан и открыт для редактирования');
    },
    onError: failure,
  });

  const addOrders = useMutation({
    mutationFn: (input: { routeId: string; version: number; orderIds: string[] }) =>
      client.post<{ id: string }>(`/api/routes/${input.routeId}/orders`, {
        orderIds: input.orderIds,
        expectedVersion: input.version,
      }),
    onSuccess: (card) => {
      // Сервер вернул свежую карточку: кладём её сразу, чтобы следующая операция
      // не отправила устаревшую версию и не получила 409 на ровном месте.
      queryClient.setQueryData(['route', card.id], card);
      success('Заказы добавлены в маршрут');
    },
    onError: failure,
  });

  const items = orders.data?.items ?? [];
  const draftRoutes = routes.data?.items ?? [];

  return (
    <section className="stack">
      <header className="routes__header">
        <div>
          <h2>Маршрутизация</h2>
          <p className="muted text-sm">
            Заказы выбранного дня, черновики маршрутов и карта. Расчёт времени в пути и
            автоматическое построение появятся позже.
          </p>
        </div>
      </header>

      <form
        className="routes__filters"
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
            />
          )}
        </Field>
        <Field label="Поиск по номеру, адресу или получателю">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Например: A-1024"
            />
          )}
        </Field>
        <Field label="Транспорт нового черновика">
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={vehicleType}
              onChange={(event) => setVehicleType(event.target.value as VehicleType)}
            >
              <option value="CAR">Автомобиль</option>
              <option value="FOOT">Пеший</option>
            </Select>
          )}
        </Field>
        <div className="routes__filter-actions">
          <Button type="submit">Найти</Button>
          <Button
            type="button"
            variant="primary"
            disabled={createRoute.isPending}
            onClick={() => createRoute.mutate()}
          >
            Создать черновик
          </Button>
        </div>
      </form>

      <div className="routes__layout">
        <section className="routes__panel">
          <header className="routes__panel-header">
            <h3>Нераспределённые</h3>
            <span className="muted text-sm">всего {orders.data?.total ?? 0}</span>
          </header>

          {orders.isPending ? (
            <LoadingState title="Загружаем заказы…" />
          ) : orders.isError ? (
            <ErrorState title="Не удалось загрузить заказы" onRetry={() => void orders.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              title="Нераспределённых заказов нет"
              description="Все заказы этого дня уже в маршрутах либо требуют внимания в разделе «Сделки»."
            />
          ) : (
            <>
              <ul className="routes__orders">
                {items.map((order) => (
                  <li
                    key={order.id}
                    className={`routes__order${selectedOnMap === order.id ? ' routes__order--selected' : ''}`}
                  >
                    <label className="routes__order-select">
                      <input
                        type="checkbox"
                        checked={selected.includes(order.id)}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, order.id]
                              : current.filter((id) => id !== order.id),
                          )
                        }
                        aria-label={`Выбрать заказ ${order.number}`}
                      />
                    </label>
                    <div className="routes__order-body">
                      <div className="routes__order-head">
                        {/*
                         * Номер — кнопка, а не просто текст: выбор строки
                         * подсвечивает маркер, и делать это должно быть
                         * возможно с клавиатуры, а не только мышью.
                         */}
                        <button
                          type="button"
                          className="routes__number routes__number-button"
                          aria-pressed={selectedOnMap === order.id}
                          onClick={() => setSelectedOnMap(order.id)}
                        >
                          {order.number}
                        </button>
                        <span>{stopInterval(order.interval)}</span>
                        {order.needsAttention && (
                          <StatusBadge tone="warning">Требует внимания</StatusBadge>
                        )}
                      </div>
                      <span>{order.address ?? '—'}</span>
                      <span className="muted text-sm">{order.recipient ?? '—'}</span>
                      <span className="routes__order-geo text-sm">
                        {isMappable(order.geo) ? (
                          <span className="muted">Точка на карте есть</span>
                        ) : (
                          // Заказ без точки не исчезает из работы: он остаётся
                          // в списке с объяснением, что именно не так.
                          <span className="routes__geo-hint">{geoHint(order.geo)}</span>
                        )}
                        <Button
                          onClick={() => {
                            setSelectedOnMap(order.id);
                            requestMapPick({ orderId: order.id, version: order.version });
                          }}
                        >
                          Указать точку
                        </Button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="routes__panel-actions">
                <Field label="Маршрут для добавления">
                  {(fieldProps) => (
                    <Select
                      {...fieldProps}
                      value={targetRouteId}
                      onChange={(event) => setTargetRouteId(event.target.value)}
                    >
                      <option value="">Выберите черновик</option>
                      {draftRoutes.map((route) => (
                        <option key={route.id} value={route.id}>
                          {route.number} · {VEHICLE_LABELS[route.vehicleType]} · {route.orderCount}{' '}
                          зак.
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Button
                  variant="primary"
                  disabled={selected.length === 0 || targetRouteId === '' || addOrders.isPending}
                  onClick={() => {
                    const route = draftRoutes.find((item) => item.id === targetRouteId);
                    if (route !== undefined) {
                      addOrders.mutate({
                        routeId: route.id,
                        version: route.version,
                        orderIds: selected,
                      });
                    }
                  }}
                >
                  Добавить выбранные ({selected.length})
                </Button>
              </div>

              <Pagination
                offset={offset}
                limit={PAGE_SIZE}
                total={orders.data?.total ?? 0}
                onChange={setOffset}
              />
            </>
          )}
        </section>

        <section className="routes__panel">
          <header className="routes__panel-header">
            <h3>Черновики дня</h3>
            <span className="muted text-sm">{draftRoutes.length}</span>
          </header>

          {routes.isPending ? (
            <LoadingState title="Загружаем маршруты…" />
          ) : routes.isError ? (
            <ErrorState
              title="Не удалось загрузить маршруты"
              onRetry={() => void routes.refetch()}
            />
          ) : draftRoutes.length === 0 ? (
            <EmptyState
              title="Черновиков на этот день нет"
              description="Создайте черновик и добавьте в него заказы."
            />
          ) : (
            <ul className="routes__list">
              {draftRoutes.map((route) => (
                <li key={route.id} className="routes__list-item">
                  <div>
                    <span className="routes__number">{route.number}</span>{' '}
                    <StatusBadge tone="info">{ROUTE_STATE_LABELS[route.state]}</StatusBadge>
                    <div className="muted text-sm">
                      {formatDate(route.deliveryDate)} · {VEHICLE_LABELS[route.vehicleType]} ·{' '}
                      заказов: {route.orderCount}
                      {route.conflictCount > 0 ? ` · расхождений: ${route.conflictCount}` : ''}
                    </div>
                    <div className="muted text-sm">
                      Курьер: {route.courier?.fullName ?? 'не назначен'}
                    </div>
                  </div>
                  <Button onClick={() => setOpenRouteId(route.id)}>Открыть</Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <MapPanel
        deliveryDate={date}
        selectedOrderId={selectedOnMap}
        onSelect={(orderId) => setSelectedOnMap(orderId)}
      />

      {openRouteId !== null && (
        <RouteCard routeId={openRouteId} onClose={() => setOpenRouteId(null)} />
      )}

      {/*
        Автоматический расчёт живёт здесь же, а не отдельной вкладкой:
        рядом карта, нераспределённые заказы и ручное редактирование маршрутов.
        Отдельный пункт «Планирование» из навигации убран, но ни доменные
        модели, ни история расчётов не тронуты — это тот же экран расчёта.
      */}
      <PlanningScreen />
    </section>
  );
}
