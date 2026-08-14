/**
 * Ручная установка точки заказа.
 *
 * Живёт рядом с исправлением адреса во вкладке «Сделки»: точка и адрес — одна
 * проблема одного заказа, и чинить их в разных вкладках значило бы гонять
 * логиста между экранами. «Маршрутизация» работает только с заказами,
 * у которых пригодные координаты уже есть.
 *
 * Это перенос рабочей логики прежней панели карты «Маршрутизации», а не второй
 * способ делать то же самое: тот же серверный вызов, та же обязательная
 * причина, то же отдельное подтверждение и та же карта.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../ui/ToastProvider';
import { Button, EmptyState, Field, LoadingState, Modal, TextInput } from '../../ui/components';
import { describeMap, roundCoordinate, type MapConfig } from '../routing/geo';
import { pointPayload, saveFailure, savedMessage, validateReason } from './geo-point';

const OrdersMap = lazy(() =>
  import('../routing/OrdersMap').then((module) => ({ default: module.OrdersMap })),
);

export interface GeoPointDialogProps {
  order: { id: string; number: string; version: number; address: string | null };
  onClose: () => void;
  /** Точка сохранена: список и карта обязаны перечитаться. */
  onSaved: () => void;
}

export function GeoPointDialog({
  order,
  onClose,
  onSaved,
}: GeoPointDialogProps): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [picked, setPicked] = useState<{ lat: number; lon: number } | null>(null);
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [basemapFailed, setBasemapFailed] = useState(false);

  const config = useQuery({
    queryKey: ['map-config'],
    queryFn: () => client.get<MapConfig>('/api/map/config'),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const status = describeMap(config.data);

  const setPoint = useMutation({
    mutationFn: (input: { lat: number; lon: number; reason: string }) =>
      client.put<{ orderId: string; unchanged: boolean }>(
        `/api/orders/${order.id}/geo-point`,
        pointPayload({ ...input, version: order.version }),
      ),
    onSuccess: (result) => {
      showToast(savedMessage(result.unchanged), 'success');
      // Заказ выходит из «Требует внимания» и становится пригодным
      // для создания черновика: перечитываются оба отбора и карта.
      void queryClient.invalidateQueries({ queryKey: ['deals'] });
      void queryClient.invalidateQueries({ queryKey: ['deals-map'] });
      void queryClient.invalidateQueries({ queryKey: ['map-points'] });
      onSaved();
    },
    // Отказ оставляет окно открытым: логист исправляет причину или повторяет,
    // не начиная выбор точки заново.
    onError: (error: unknown) => setFormError(saveFailure(error)),
  });

  return (
    <Modal
      open
      title={`Точка заказа ${order.number}`}
      onClose={onClose}
      dismissible={!setPoint.isPending}
    >
      <div className="stack">
        <p className="text-sm muted">{order.address ?? 'Адрес не указан'}</p>

        {!status.ready ? (
          <EmptyState title="Карта не настроена" description={status.message ?? ''} />
        ) : basemapFailed ? (
          <EmptyState
            title="Подложка карты не загрузилась"
            description="Внешние карты не используются намеренно. Точку можно поставить позже."
          />
        ) : (
          <Suspense fallback={<LoadingState title="Готовим карту…" />}>
            <OrdersMap
              styleUrl={config.data?.styleUrl ?? ''}
              attribution={config.data?.attribution ?? null}
              // Точек дня здесь нет намеренно: окно про один заказ, и чужие
              // маркеры только мешали бы попасть по нужному дому.
              points={[]}
              selectedOrderId={null}
              onSelect={() => undefined}
              picking
              onPick={(coordinates) => {
                setPicked(coordinates);
                setFormError(null);
              }}
              onLoadError={() => setBasemapFailed(true)}
            />
          </Suspense>
        )}

        <p className="text-sm" data-testid="geo-point-picked">
          {picked === null
            ? 'Укажите точку на карте.'
            : `Выбрано: ${roundCoordinate(picked.lat)}, ${roundCoordinate(picked.lon)}`}
        </p>

        <Field label="Причина" error={formError ?? undefined}>
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              data-testid="geo-point-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
            />
          )}
        </Field>

        <div className="modal__footer">
          <Button onClick={onClose} disabled={setPoint.isPending}>
            Отмена
          </Button>
          <Button
            variant="primary"
            data-testid="geo-point-save"
            disabled={picked === null || setPoint.isPending}
            onClick={() => {
              if (picked === null) {
                return;
              }
              const checked = validateReason(reason);
              if (!checked.ok) {
                setFormError(checked.error);
                return;
              }
              setPoint.mutate({ lat: picked.lat, lon: picked.lon, reason: checked.reason });
            }}
          >
            Сохранить точку
          </Button>
        </div>
      </div>
    </Modal>
  );
}
