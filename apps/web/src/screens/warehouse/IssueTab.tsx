/**
 * Раздел «Выдача»: курьер → маршрутный лист → заказы.
 *
 * Три уровня, и все свёрнуты по умолчанию. Кладовщик работает с одним
 * курьером, который стоит перед ним: разворачивать ему весь склад незачем.
 *
 * Отгрузка относится РОВНО к одному листу. Общей кнопки «отгрузить всё»
 * здесь нет и быть не может: у листов разный состав и разная готовность,
 * а ошибка одного не должна мешать соседнему.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import { Button, EmptyState, ErrorState, LoadingState, StatusBadge } from '../../ui/components';
import { ScannerScreen } from '../../scan/ScannerScreen';
import type { ScanEvent, ScanIntent } from '../../scan/scan-machine';
import type { IssueBoard, IssueRouteView } from './warehouse-flow';
import './warehouse.css';

const BOARD_KEY = ['warehouse-issue-board'];

export function IssueTab({ manualEntry }: { manualEntry: boolean }): React.JSX.Element {
  const { client } = useAuth();
  const [openCourier, setOpenCourier] = useState<string | null>(null);
  const [openRoute, setOpenRoute] = useState<string | null>(null);
  const [shipping, setShipping] = useState<IssueRouteView | null>(null);

  const board = useQuery({
    queryKey: BOARD_KEY,
    queryFn: () => client.get<IssueBoard>('/api/warehouse/issue-board'),
  });

  if (board.isPending) {
    return <LoadingState title="Загружаем выдачу…" />;
  }
  if (board.isError) {
    return <ErrorState title="Не удалось загрузить выдачу" onRetry={() => void board.refetch()} />;
  }

  const couriers = board.data.couriers;

  return (
    <>
      {couriers.length === 0 && (
        <EmptyState
          title="Листов к выдаче нет"
          description="Лист появится здесь, когда логист назначит ему курьера."
        />
      )}

      <div className="stack" data-testid="issue-couriers">
        {couriers.map((courier) => (
          <article
            key={courier.courierUserId}
            className="card stack"
            data-testid="issue-courier"
            data-courier={courier.fullName}
          >
            <button
              type="button"
              className="wh-group__toggle"
              aria-expanded={courier.courierUserId === openCourier}
              data-testid="issue-courier-toggle"
              onClick={() =>
                setOpenCourier(courier.courierUserId === openCourier ? null : courier.courierUserId)
              }
            >
              <span>{courier.fullName}</span>
              <span className="muted text-sm">{courier.phone}</span>
              <span className="wh-group__count">{courier.routes.length}</span>
              <span aria-hidden="true">{courier.courierUserId === openCourier ? '▾' : '▸'}</span>
            </button>

            {courier.courierUserId === openCourier &&
              courier.routes.map((route) => (
                <div
                  key={route.routeId}
                  className="wh-route wh-issue__route"
                  data-testid="issue-route"
                  data-route-number={route.routeNumber}
                >
                  <header className="wh-route__head">
                    <div className="wh-route__main">
                      <strong>{route.routeNumber}</strong>
                      <div className="muted text-sm">
                        {route.deliveryDate} · {route.total} заказов · внесено {route.checked} из{' '}
                        {route.total}
                      </div>
                    </div>

                    <Button
                      variant="primary"
                      data-testid="issue-ship"
                      onClick={() => setShipping(route)}
                    >
                      Отгрузить
                    </Button>

                    <button
                      type="button"
                      className="wh-route__toggle"
                      aria-expanded={route.routeId === openRoute}
                      aria-label={
                        route.routeId === openRoute ? 'Свернуть заказы' : 'Показать заказы'
                      }
                      data-testid="issue-route-toggle"
                      onClick={() =>
                        setOpenRoute(route.routeId === openRoute ? null : route.routeId)
                      }
                    >
                      {route.routeId === openRoute ? '▾' : '▸'}
                    </button>
                  </header>

                  {route.routeId === openRoute && (
                    <ul className="wh-route__orders">
                      {route.orders.map((order) => (
                        <li
                          key={order.orderId}
                          className="wh-route__order"
                          data-order-number={order.orderNumber}
                        >
                          <span className="wh-route__position">{order.position}</span>
                          <span className="wh-route__order-number">{order.orderNumber}</span>
                          {/* Ячейки нет — такой лист отгрузить нельзя. */}
                          <span className="muted text-sm">{order.cellCode ?? '—'}</span>
                          <span className="wh-route__badges">
                            <StatusBadge tone={order.ready ? 'success' : 'warning'}>
                              {order.ready ? 'Готов' : 'Не готов'}
                            </StatusBadge>
                            {order.checked && <StatusBadge tone="info">Внесён</StatusBadge>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
          </article>
        ))}
      </div>

      {shipping !== null && (
        <ShipDialog
          route={shipping}
          courier={
            couriers.find((item) =>
              item.routes.some((route) => route.routeId === shipping.routeId),
            ) ?? null
          }
          manualEntry={manualEntry}
          onClose={() => setShipping(null)}
        />
      )}
    </>
  );
}

/**
 * Окно отгрузки одного листа.
 *
 * Прогресс живёт на сервере: два кладовщика видят одно и то же число,
 * закрытие окна его не теряет, а повторный скан не увеличивает счётчик.
 * «Сбросить» очищает только прогресс — полки и маршрут остаются как были.
 */
function ShipDialog({
  route,
  courier,
  manualEntry,
  onClose,
}: {
  route: IssueRouteView;
  courier: IssueBoard['couriers'][number] | null;
  manualEntry: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState('');

  const board = useQuery({
    queryKey: BOARD_KEY,
    queryFn: () => client.get<IssueBoard>('/api/warehouse/issue-board'),
  });

  const current =
    board.data?.couriers
      .flatMap((item) => item.routes)
      .find((item) => item.routeId === route.routeId) ?? route;

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: BOARD_KEY });
    await queryClient.invalidateQueries({ queryKey: ['warehouse-assembly'] });
  };

  const confirmCourier = useMutation({
    mutationFn: () =>
      client.post(`/api/warehouse/routes/${route.routeId}/courier`, {
        courierUserId: courier?.courierUserId ?? '',
      }),
    onSuccess: refresh,
  });

  const check = useMutation({
    mutationFn: (orderNumber: string) =>
      client.post<{ orderNumber: string; checked: number; total: number; unchanged: boolean }>(
        `/api/warehouse/routes/${route.routeId}/issue/check`,
        { orderNumber },
      ),
    onSuccess: async (result) => {
      setManual('');
      await refresh();
      showToast(
        result.unchanged
          ? `Заказ ${result.orderNumber} уже внесён`
          : `Заказ ${result.orderNumber} внесён: ${result.checked} из ${result.total}`,
        'success',
      );
    },
    onError: (error: unknown) =>
      showToast(error instanceof ApiError ? error.message : 'Не удалось внести заказ.', 'error'),
  });

  const reset = useMutation({
    mutationFn: () => client.post(`/api/warehouse/routes/${route.routeId}/issue/checks/reset`, {}),
    onSuccess: async () => {
      await refresh();
      showToast('Проверка сброшена: размещения не изменились', 'success');
    },
  });

  const ship = useMutation({
    mutationFn: () =>
      client.post<{ routeNumber: string; issued: number; unchanged: boolean }>(
        `/api/warehouse/routes/${route.routeId}/ship`,
        {},
      ),
    onSuccess: async (result) => {
      await refresh();
      showToast(
        result.unchanged
          ? `Лист ${result.routeNumber} уже отгружен`
          : `Лист ${result.routeNumber} отгружен курьеру: ${result.issued} заказов`,
        'success',
      );
      onClose();
    },
    onError: (error: unknown) =>
      showToast(error instanceof ApiError ? error.message : 'Не удалось отгрузить лист.', 'error'),
  });

  const allChecked = current.total > 0 && current.checked >= current.total;

  return (
    <div className="scanner-backdrop" role="presentation" onClick={onClose}>
      <section
        className="wh-check"
        role="dialog"
        aria-modal="true"
        aria-label={`Отгрузка ${current.routeNumber}`}
        data-testid="issue-ship-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="wh-check__head">
          <strong>Отгрузка {current.routeNumber}</strong>
          <Button variant="ghost" data-testid="issue-reset" onClick={() => reset.mutate()}>
            Сбросить
          </Button>
          <button
            type="button"
            className="wh-check__close"
            aria-label="Закрыть отгрузку"
            data-testid="issue-ship-close"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <p className="muted text-sm">
          {courier?.fullName ?? 'курьер не назначен'}
          {courier === null ? '' : ` · ${courier.phone}`}
        </p>

        {!current.sessionOpen && (
          <Button
            variant="secondary"
            data-testid="issue-confirm-courier"
            disabled={confirmCourier.isPending}
            onClick={() => confirmCourier.mutate()}
          >
            Подтвердить курьера
          </Button>
        )}

        <p className="wh-check__progress" data-testid="issue-progress">
          Внесено: {current.checked} из {current.total}
        </p>
        <div
          className="wh-check__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={current.total}
          aria-valuenow={current.checked}
        >
          <span
            style={{
              width: `${current.total === 0 ? 0 : (current.checked / current.total) * 100}%`,
            }}
          />
        </div>

        {current.sessionOpen && (
          <Button
            variant="primary"
            className="wh-scan__button"
            data-testid="issue-scan"
            onClick={() => setScanning(true)}
          >
            Сканировать заказ
          </Button>
        )}

        {current.sessionOpen && manualEntry && (
          <form
            className="stack"
            data-testid="issue-manual"
            onSubmit={(event) => {
              event.preventDefault();
              if (manual.trim() !== '') {
                check.mutate(manual);
              }
            }}
          >
            <input
              className="input"
              placeholder="Номер заказа"
              aria-label="Номер заказа"
              data-testid="issue-manual-order"
              value={manual}
              onChange={(event) => setManual(event.target.value)}
            />
            <Button type="submit" disabled={check.isPending}>
              Внести
            </Button>
          </form>
        )}

        <ul className="wh-check__list">
          {current.orders.map((order) => (
            <li
              key={order.orderId}
              className="wh-check__item"
              data-order-number={order.orderNumber}
              data-checked={order.checked ? 'yes' : 'no'}
            >
              <span className="wh-route__position">{order.position}</span>
              <span className="wh-route__order-number">{order.orderNumber}</span>
              <span className="muted text-sm">{order.cellCode ?? '—'}</span>
              <StatusBadge tone={order.checked ? 'success' : 'neutral'}>
                {order.checked ? 'Проверен' : 'Ожидает'}
              </StatusBadge>
            </li>
          ))}
        </ul>

        {/*
          Отгрузка доступна только после последнего заказа: сервер всё равно
          проверит состав заново, но предлагать заведомо отказную кнопку
          значит обещать то, чего не будет.
        */}
        <Button
          variant="primary"
          className="wh-scan__button"
          data-testid="issue-ship-submit"
          disabled={!allChecked || !current.shippable || ship.isPending}
          onClick={() => ship.mutate()}
        >
          Отгрузить лист ({current.checked} из {current.total})
        </Button>

        {scanning && (
          <ScannerScreen
            chain="ISSUE"
            operation={`Отгрузка ${current.routeNumber}`}
            onIntent={async (intent: ScanIntent): Promise<ScanEvent> => {
              if (intent.kind !== 'issueOrder') {
                return { type: 'failed', text: 'Неподдерживаемый шаг сканирования.' };
              }
              try {
                /*
                 * Прямой запрос, а не общая мутация: у камеры свой способ
                 * показать исход, и второе всплывающее сообщение поверх окна
                 * сканирования только мешает.
                 */
                const result = await client.post<{
                  orderNumber: string;
                  checked: number;
                  total: number;
                  unchanged: boolean;
                }>(`/api/warehouse/routes/${route.routeId}/issue/check`, {
                  orderNumber: intent.orderNumber,
                });
                await refresh();
                return {
                  type: 'succeeded',
                  text: result.unchanged
                    ? `Заказ ${result.orderNumber} уже внесён`
                    : `Заказ ${result.orderNumber} внесён`,
                  progress: { done: result.checked, total: result.total },
                  final: false,
                };
              } catch (error: unknown) {
                return {
                  type: 'failed',
                  text: error instanceof ApiError ? error.message : 'Не удалось внести заказ.',
                };
              }
            }}
            onClose={() => setScanning(false)}
          />
        )}
      </section>
    </div>
  );
}
