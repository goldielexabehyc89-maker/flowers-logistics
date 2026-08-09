/**
 * Панель карты на экране маршрутизации.
 *
 * Отвечает за три вещи: показать карту, если она настроена; честно сказать,
 * если нет; дать логисту поставить точку заказу вручную.
 *
 * Установка точки требует причины и подтверждения: точка определяет, куда
 * поедет курьер, и молчаливый клик по карте такой ответственности не несёт.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  TextInput,
} from '../../ui/components';
import { conflictMessage } from './routing';
import { describeMap, roundCoordinate, type MapConfig, type MapPointsResponse } from './geo';

/**
 * Карта грузится отдельным куском.
 *
 * MapLibre весит заметно больше остального интерфейса, а разделу «Сделки»
 * и маршрутным листам он не нужен: незачем заставлять всех скачивать его
 * при первом входе.
 */
const OrdersMap = lazy(() =>
  import('./OrdersMap').then((module) => ({ default: module.OrdersMap })),
);

export interface MapPanelProps {
  deliveryDate: string;
  selectedOrderId: string | null;
  onSelect: (orderId: string) => void;
}

export function MapPanel({
  deliveryDate,
  selectedOrderId,
  onSelect,
}: MapPanelProps): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [picking, setPicking] = useState<{ orderId: string; version: number } | null>(null);
  const [picked, setPicked] = useState<{ lat: number; lon: number } | null>(null);
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const config = useQuery({
    queryKey: ['map-config'],
    queryFn: () => client.get<MapConfig>('/api/map/config'),
    // Настройка карты не меняется в течение сеанса.
    staleTime: Number.POSITIVE_INFINITY,
  });

  const status = describeMap(config.data);

  const points = useQuery({
    queryKey: ['map-points', deliveryDate],
    queryFn: () => client.get<MapPointsResponse>(`/api/orders/map?deliveryDate=${deliveryDate}`),
    enabled: status.ready,
  });

  const setPoint = useMutation({
    mutationFn: (input: {
      orderId: string;
      version: number;
      lat: number;
      lon: number;
      reason: string;
    }) =>
      client.put<{ orderId: string; unchanged: boolean }>(
        `/api/orders/${input.orderId}/geo-point`,
        {
          lat: roundCoordinate(input.lat),
          lon: roundCoordinate(input.lon),
          reason: input.reason,
          expectedVersion: input.version,
        },
      ),
    onSuccess: (result) => {
      closePicker();
      showToast(result.unchanged ? 'Точка уже стояла здесь' : 'Точка сохранена', 'success');
      void queryClient.invalidateQueries({ queryKey: ['map-points'] });
      void queryClient.invalidateQueries({ queryKey: ['unassigned-orders'] });
      void queryClient.invalidateQueries({ queryKey: ['route'] });
    },
    onError: (error: unknown) => {
      const kind = error instanceof ApiError ? (error.conflict?.kind ?? undefined) : undefined;
      setFormError(
        error instanceof ApiError
          ? conflictMessage(kind, error.message)
          : 'Не удалось сохранить точку. Повторите попытку.',
      );
      void queryClient.invalidateQueries({ queryKey: ['unassigned-orders'] });
    },
  });

  // Список заказов живёт в соседней колонке и просит карту начать установку
  // точки через событие окна: общий стор ради одной кнопки был бы дороже.
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ orderId: string; version: number }>).detail;
      if (detail !== undefined) {
        setPicking(detail);
        setPicked(null);
        setReason('');
        setFormError(null);
      }
    };

    window.addEventListener(MAP_PICK_EVENT, handler);
    return () => window.removeEventListener(MAP_PICK_EVENT, handler);
  }, []);

  const closePicker = (): void => {
    setPicking(null);
    setPicked(null);
    setReason('');
    setFormError(null);
  };

  if (!status.ready) {
    return (
      <section className="routes__panel">
        <header className="routes__panel-header">
          <h3>Карта</h3>
        </header>
        <EmptyState title="Карта не настроена" description={status.message ?? ''} />
      </section>
    );
  }

  const items = points.data?.points ?? [];

  return (
    <section className="routes__panel">
      <header className="routes__panel-header">
        <h3>Карта</h3>
        <span className="muted text-sm">точек: {items.length}</span>
      </header>

      {points.isPending ? (
        <LoadingState title="Загружаем точки…" />
      ) : points.isError ? (
        <ErrorState title="Не удалось загрузить точки" onRetry={() => void points.refetch()} />
      ) : (
        <Suspense fallback={<LoadingState title="Готовим карту…" />}>
          <OrdersMap
            styleUrl={config.data?.styleUrl ?? ''}
            attribution={config.data?.attribution ?? null}
            points={items}
            selectedOrderId={selectedOrderId}
            onSelect={onSelect}
            picking={picking !== null}
            onPick={(coordinates) => setPicked(coordinates)}
          />
        </Suspense>
      )}

      {picking !== null && (
        <p className="routes__hint" role="status">
          {picked === null
            ? 'Укажите точку на карте.'
            : `Выбрано: ${roundCoordinate(picked.lat)}, ${roundCoordinate(picked.lon)}`}
          <Button variant="ghost" onClick={closePicker}>
            Отмена
          </Button>
        </p>
      )}

      <Modal
        open={picking !== null && picked !== null}
        title="Подтвердите точку заказа"
        onClose={closePicker}
      >
        <div className="stack">
          <p className="text-sm muted">
            Точка определяет, куда поедет курьер. Причина сохраняется в неизменяемой истории заказа.
          </p>
          <Field label="Причина" error={formError ?? undefined}>
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                autoFocus
              />
            )}
          </Field>
          <div className="modal__footer">
            <Button onClick={closePicker}>Отмена</Button>
            <Button
              variant="primary"
              disabled={setPoint.isPending}
              onClick={() => {
                if (picking === null || picked === null) {
                  return;
                }
                if (reason.trim().length < 3) {
                  setFormError('Опишите причину: не меньше трёх символов.');
                  return;
                }
                setPoint.mutate({
                  orderId: picking.orderId,
                  version: picking.version,
                  lat: picked.lat,
                  lon: picked.lon,
                  reason: reason.trim(),
                });
              }}
            >
              Сохранить точку
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

/** Событие запроса установки точки: список просит карту перейти в режим выбора. */
export const MAP_PICK_EVENT = 'fl:map-pick-request';

export function requestMapPick(order: { orderId: string; version: number }): void {
  window.dispatchEvent(new CustomEvent(MAP_PICK_EVENT, { detail: order }));
}
