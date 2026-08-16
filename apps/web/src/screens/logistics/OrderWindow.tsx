/**
 * Окно заказа: вся известная о нём информация в одном месте.
 *
 * Открывается нажатием на номер заказа везде, где этот номер виден — в
 * «Сделках», в составе черновика и в маршрутном листе. Раньше сведения были
 * размазаны по трём экранам: адрес правился в одном месте, интервал — в
 * другом, а из маршрутного листа не было видно вообще ничего.
 *
 * Правится ровно то, что переживает синхронизацию с МоимСкладом: адрес,
 * интервал и точка на карте. У них для этого заведены собственные поля.
 * Получатель, комментарий и состояние источника показываются, но не правятся:
 * ближайший импорт вернул бы значение источника, и человек считал бы
 * исправленным то, что исправленным не является.
 *
 * Деньги не правятся никогда и ни при каких условиях — только МойСклад.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatMoscowDateTime } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../ui/ToastProvider';
import { Button, ErrorState, LoadingState, Modal, StatusBadge } from '../../ui/components';
import { AddressDialog } from '../deals/AddressDialog';
import { IntervalModal } from '../deals/IntervalModal';
import { GeoPointDialog } from './GeoPointDialog';
import type { DealCard } from '../deals/selection';
import { formatMinutes, type OrderView } from '../deals/deals';
import './order-window.css';

/** Ответ существующего read-only контракта одного заказа. */
export interface OrderWindowView {
  order: OrderView & {
    sourceAddress: string | null;
    addressCorrected: boolean;
    addressConflict: boolean;
    geo: {
      state: string;
      source: string | null;
      precision: string | null;
      reviewReason: string | null;
      lat: string | null;
      lon: string | null;
    };
  };
  revisions: {
    receivedAt: string;
    externalUpdated: string;
    reason: string;
    changedFields: string[];
  }[];
}

const GEO_STATE_LABELS: Record<string, string> = {
  UNRESOLVED: 'точка не определена',
  RESOLVED: 'точка подтверждена',
  NEEDS_REVIEW: 'точка требует проверки',
  FAILED: 'точку определить не удалось',
};

/** Интервал одной строкой: рабочий, а рядом — исходный, если они разошлись. */
export function intervalLine(interval: OrderWindowView['order']['interval']): string {
  const start = interval.manualStartMinute ?? interval.startMinute;
  const end = interval.manualEndMinute ?? interval.endMinute;
  if (start === null || end === null) {
    return interval.raw ?? 'не распознан';
  }
  return `${formatMinutes(start)}–${formatMinutes(end)}`;
}

/** Показывать ли исходный интервал отдельной строкой. */
export function intervalCorrected(interval: OrderWindowView['order']['interval']): boolean {
  return interval.manualStartMinute !== null || interval.manualEndMinute !== null;
}

export interface OrderWindowProps {
  orderId: string;
  onClose: () => void;
}

export function OrderWindow({ orderId, onClose }: OrderWindowProps): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [editing, setEditing] = useState<'ADDRESS' | 'INTERVAL' | 'POINT' | null>(null);
  const [intervalError, setIntervalError] = useState<string | null>(null);

  const order = useQuery({
    queryKey: ['order-window', orderId],
    queryFn: () => client.get<OrderWindowView>(`/api/orders/${orderId}`),
  });

  /**
   * После правки перечитывается ВСЁ, что показывает заказ.
   *
   * Список сделок, карта, состав маршрута и сам маршрутный лист питаются
   * разными запросами: обновив только окно, мы оставили бы на экране старый
   * адрес рядом с новым.
   */
  const refreshEverything = (): void => {
    void order.refetch();
    for (const key of ['deals', 'deals-map', 'route', 'routes', 'route-sheets', 'map-points']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };

  if (order.isPending) {
    return (
      <Modal open title="Заказ" onClose={onClose}>
        <LoadingState title="Загружаем заказ…" />
      </Modal>
    );
  }

  if (order.isError) {
    return (
      <Modal open title="Заказ" onClose={onClose}>
        <ErrorState title="Не удалось загрузить заказ" onRetry={() => void order.refetch()} />
      </Modal>
    );
  }

  const view = order.data.order;

  /*
   * Существующие окна правки ждут карточку «Сделок».
   *
   * Она собирается из тех же полей заказа: заводить второй набор диалогов
   * ради другого экрана значило бы иметь две версии правды об адресе.
   */
  const asCard: DealCard = {
    id: view.id,
    number: view.number,
    address: view.address,
    sourceAddress: view.sourceAddress,
    addressCorrected: view.addressCorrected,
    addressConflict: view.addressConflict,
    recipient: view.recipient,
    comment: view.comment,
    deliveryDate: view.deliveryDate,
    startMinute: view.interval.manualStartMinute ?? view.interval.startMinute,
    endMinute: view.interval.manualEndMinute ?? view.interval.endMinute,
    intervalCorrected: intervalCorrected(view.interval),
    needsAttention: view.needsAttention,
    attentionReasons: view.attentionReasons,
    geoState: view.geo.state,
    draftRouteId: null,
    draftRouteNumber: null,
    selectable: false,
    sourceStartMinute: view.interval.startMinute,
    sourceEndMinute: view.interval.endMinute,
    sourceIntervalRaw: view.interval.raw,
    version: view.version,
    assembled: false,
  };

  return (
    <>
      <Modal open title={`Заказ ${view.number}`} onClose={onClose}>
        <div className="order-window" data-testid="order-window">
          <div className="order-window__row">
            <span className="order-window__label">Состояние в МоёмСкладе</span>
            <span className="order-window__value">{view.externalState.name ?? '—'}</span>
          </div>

          <div className="order-window__row">
            <span className="order-window__label">Дата доставки</span>
            <span className="order-window__value">
              {view.deliveryDate ?? view.deliveryDateRaw ?? '—'}
            </span>
          </div>

          {/* Адрес: рабочий крупно, исходный — рядом, когда они разошлись. */}
          <div className="order-window__row">
            <span className="order-window__label">Адрес</span>
            <span className="order-window__value">
              {view.address ?? 'не указан'}
              {view.addressCorrected && (
                <span className="order-window__note">исправлен вручную</span>
              )}
              {view.addressConflict && (
                <StatusBadge tone="warning">Источник изменил адрес</StatusBadge>
              )}
              {view.addressCorrected && view.sourceAddress !== null && (
                <span className="order-window__source">В источнике: {view.sourceAddress}</span>
              )}
            </span>
            <Button data-testid="order-window-address" onClick={() => setEditing('ADDRESS')}>
              Изменить
            </Button>
          </div>

          <div className="order-window__row">
            <span className="order-window__label">Интервал</span>
            <span className="order-window__value">
              {intervalLine(view.interval)}
              {intervalCorrected(view.interval) && (
                <span className="order-window__note">исправлен вручную</span>
              )}
              {view.interval.raw !== null && (
                <span className="order-window__source">В источнике: {view.interval.raw}</span>
              )}
            </span>
            <Button
              data-testid="order-window-interval"
              onClick={() => {
                setIntervalError(null);
                setEditing('INTERVAL');
              }}
            >
              Изменить
            </Button>
          </div>

          <div className="order-window__row">
            <span className="order-window__label">Точка на карте</span>
            <span className="order-window__value">
              {GEO_STATE_LABELS[view.geo.state] ?? view.geo.state}
              {view.geo.lat !== null && view.geo.lon !== null && (
                <span className="order-window__source">
                  {view.geo.lat}, {view.geo.lon}
                </span>
              )}
            </span>
            <Button data-testid="order-window-point" onClick={() => setEditing('POINT')}>
              Указать
            </Button>
          </div>

          {/*
            Получатель и комментарий приходят из МоегоСклада и локального поля
            не имеют: правка здесь дожила бы только до ближайшего импорта.
          */}
          <div className="order-window__row">
            <span className="order-window__label">Получатель</span>
            <span className="order-window__value">{view.recipient ?? '—'}</span>
            <span className="order-window__hint">меняется в МоёмСкладе</span>
          </div>

          <div className="order-window__row">
            <span className="order-window__label">Комментарий</span>
            <span className="order-window__value">{view.comment ?? '—'}</span>
            <span className="order-window__hint">меняется в МоёмСкладе</span>
          </div>

          {/* Деньги — только чтение по решению владельца. */}
          <div className="order-window__row">
            <span className="order-window__label">Сумма</span>
            <span className="order-window__value">
              {view.money.sum} ₽
              <span className="order-window__source">оплачено: {view.money.payed} ₽</span>
              {view.money.cashCollectable && (
                <span className="order-window__source">
                  наличными к сбору: {view.money.cashToCollect} ₽
                </span>
              )}
              {view.money.anomaly && <StatusBadge tone="error">Расхождение по оплате</StatusBadge>}
            </span>
            <span className="order-window__hint">меняется в МоёмСкладе</span>
          </div>

          {view.needsAttention && view.attentionReasons.length > 0 && (
            <div className="order-window__row">
              <span className="order-window__label">Требует внимания</span>
              <span className="order-window__value">{view.attentionReasons.join(', ')}</span>
            </div>
          )}

          <p className="order-window__updated">
            Обновлён из источника: {formatMoscowDateTime(view.updatedAt)}
          </p>
        </div>
      </Modal>

      {editing === 'ADDRESS' && (
        <AddressDialog
          order={asCard}
          onClose={() => setEditing(null)}
          onChanged={() => {
            setEditing(null);
            refreshEverything();
          }}
        />
      )}

      {editing === 'INTERVAL' && (
        <IntervalModal
          order={view}
          error={intervalError}
          pending={false}
          onCancel={() => setEditing(null)}
          onSubmit={(values) => {
            void client
              .put(`/api/orders/${view.id}/interval`, {
                startMinute: values.startMinute,
                endMinute: values.endMinute,
                expectedVersion: view.version,
              })
              .then(() => {
                setEditing(null);
                showToast('Интервал сохранён', 'success');
                refreshEverything();
              })
              .catch((error: unknown) => {
                setIntervalError(
                  (error as { message?: string }).message ?? 'Не удалось сохранить интервал',
                );
              });
          }}
        />
      )}

      {editing === 'POINT' && (
        <GeoPointDialog
          order={{
            id: view.id,
            number: view.number,
            version: view.version,
            address: view.address,
          }}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refreshEverything();
          }}
        />
      )}
    </>
  );
}
