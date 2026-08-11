/**
 * Экран «Склад» — рабочий список заказов дня и отметка готовности к отгрузке.
 *
 * Один экран, одно действие. Ни товаров, ни остатков, ни сканирования,
 * ни маршрутов, ни отгрузки: границы задаёт решение владельца `WH-001`.
 *
 * Адреса, получателя, комментария, денег и координат здесь нет и быть не может —
 * сервер их не отдаёт. Складу для решения «готов / не готов» нужен номер заказа,
 * день и текущее состояние.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { formatDate, moscowToday } from '../routing/routing';
import {
  actionLabel,
  EMPTY_VALUE,
  formatMoscowTime,
  nextReadiness,
  READINESS_FILTERS,
  READINESS_LABELS,
  readinessTone,
  type ReadinessFilter,
  type WarehouseListResponse,
  type WarehouseOrderView,
} from './warehouse';

const PAGE_SIZE = 100;

export function WarehouseScreen(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [date, setDate] = useState(moscowToday());
  const [readiness, setReadiness] = useState<ReadinessFilter>('ALL');
  const [offset, setOffset] = useState(0);
  /** Строка, по которой уже идёт запрос: повторный клик по ней запрещён. */
  const [pending, setPending] = useState<string | null>(null);

  const listKey = ['warehouse-orders', date, readiness, offset] as const;

  const query = useQuery({
    queryKey: listKey,
    queryFn: () =>
      client.get<WarehouseListResponse>(
        `/api/warehouse/orders?deliveryDate=${date}&readiness=${readiness}` +
          `&limit=${PAGE_SIZE}&offset=${offset}`,
      ),
  });

  const mutation = useMutation({
    mutationFn: (order: WarehouseOrderView) =>
      client.put<{ orderId: string; readiness: string; version: number; unchanged: boolean }>(
        `/api/warehouse/orders/${order.id}/readiness`,
        { readiness: nextReadiness(order.readiness), expectedVersion: order.version },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['warehouse-orders'] });
    },
    onError: async (error: unknown) => {
      // 409 означает, что список устарел: кто-то отметил заказ раньше. Молча
      // повторять запрос нельзя — это перетёрло бы чужое решение. Обновляем
      // данные и честно объясняем, что произошло.
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ['warehouse-orders'] });
        showToast(
          'Заказ изменён другим пользователем. Список обновлён — проверьте и повторите.',
          'error',
        );
        return;
      }
      showToast(
        error instanceof ApiError ? error.message : 'Не удалось изменить готовность.',
        'error',
      );
    },
    onSettled: () => setPending(null),
  });

  function toggle(order: WarehouseOrderView): void {
    if (pending !== null) {
      return;
    }
    setPending(order.id);
    mutation.mutate(order);
  }

  function changeDate(value: string): void {
    setDate(value);
    setOffset(0);
  }

  function changeFilter(value: ReadinessFilter): void {
    setReadiness(value);
    setOffset(0);
  }

  return (
    <section className="stack">
      <div className="card stack">
        <div>
          <h2>Склад</h2>
          <p className="muted text-sm">
            Готовность заказа к отгрузке. Это внутренняя отметка нашей системы: в МойСклад она не
            передаётся, а внешний статус показан рядом только как подсказка.
          </p>
        </div>

        <div className="row">
          <Field label="Дата доставки">
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                type="date"
                value={date}
                onChange={(event) => changeDate(event.target.value)}
              />
            )}
          </Field>
          <Field label="Готовность">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={readiness}
                onChange={(event) => changeFilter(event.target.value as ReadinessFilter)}
              >
                {READINESS_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </div>

      <div className="card stack">
        {query.isPending && <LoadingState title="Загружаем заказы дня…" />}

        {query.isError && (
          <ErrorState
            description="Список заказов склада не загрузился."
            onRetry={() => void query.refetch()}
          />
        )}

        {query.isSuccess && query.data.items.length === 0 && (
          <EmptyState
            title="На эту дату заказов нет"
            description="Выберите другой день или снимите фильтр готовности."
          />
        )}

        {query.isSuccess && query.data.items.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Заказ</th>
                    <th>Дата</th>
                    <th>Статус МоегоСклада</th>
                    <th>Готовность</th>
                    <th>Изменено</th>
                    <th aria-label="Действие" />
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((order) => (
                    <tr key={order.id} data-testid="warehouse-row" data-order-id={order.id}>
                      <td>{order.number}</td>
                      <td>{formatDate(order.deliveryDate)}</td>
                      <td className="muted">{order.externalStateName ?? EMPTY_VALUE}</td>
                      <td>
                        <StatusBadge tone={readinessTone(order.readiness)}>
                          {READINESS_LABELS[order.readiness]}
                        </StatusBadge>
                      </td>
                      <td className="muted text-sm">{formatMoscowTime(order.readinessSetAt)}</td>
                      <td>
                        <Button
                          variant={order.readiness === 'READY' ? 'ghost' : 'primary'}
                          disabled={pending !== null}
                          onClick={() => toggle(order)}
                        >
                          {pending === order.id ? 'Сохраняем…' : actionLabel(order.readiness)}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination
              offset={query.data.offset}
              limit={query.data.limit}
              total={query.data.total}
              onChange={setOffset}
            />
          </>
        )}
      </div>
    </section>
  );
}
