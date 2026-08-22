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
import {
  ISSUE_READINESS_LABELS,
  issueCellLabel,
  type IssueBoard,
  type IssueRouteView,
} from './warehouse-flow';
import './warehouse.css';

const BOARD_KEY = ['warehouse-issue-board'];

/**
 * Стрелка состояния группы.
 *
 * Она не кнопка: нажимается вся строка заголовка, а стрелка лишь показывает,
 * раскрыт список или свёрнут. Поворот делает CSS — чтобы состояние читалось
 * одним значком, а не двумя разными символами.
 */
function GroupChevron({ open }: { open: boolean }): React.JSX.Element {
  return (
    <span className="wh-group__chevron" data-open={open ? 'true' : 'false'} aria-hidden="true">
      <svg
        width="12"
        height="8"
        viewBox="0 0 12 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M1 1.5 6 6.5l5-5" />
      </svg>
    </span>
  );
}

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
            className="wh-issue__courier"
            data-testid="issue-courier"
            data-courier={courier.fullName}
          >
            {/*
              Шапка курьера отвечает на один вопрос: подходить ли к нему сейчас.
              Поэтому справа стоят два числа — сколько листов готово к выдаче
              и сколько их всего, — а имя и телефон занимают левую колонку.
            */}
            <button
              type="button"
              className="wh-group__toggle wh-courier__head"
              aria-expanded={courier.courierUserId === openCourier}
              data-testid="issue-courier-toggle"
              onClick={() =>
                setOpenCourier(courier.courierUserId === openCourier ? null : courier.courierUserId)
              }
            >
              <span className="wh-courier__main">
                <span className="wh-courier__name">{courier.fullName}</span>
                <span className="muted text-sm">{courier.phone}</span>
              </span>
              <span className="wh-courier__ready" data-testid="issue-courier-ready">
                ({courier.readyRoutes})
              </span>
              <span className="wh-group__count wh-group__count--sunken">
                {courier.routes.length}
              </span>
              <GroupChevron open={courier.courierUserId === openCourier} />
            </button>

            {courier.courierUserId === openCourier && (
              /* Список листов лежит в углублении, как таблицы на «Складе». */
              <div className="wh-well">
                {courier.routes.map((route) => (
                  <div
                    key={route.routeId}
                    className="wh-route wh-issue__route"
                    data-testid="issue-route"
                    data-route-number={route.routeNumber}
                  >
                    {/*
                    Шапка раскрывает карточку целиком.

                    Стрелка остаётся указателем состояния, но целиться в неё
                    пальцем на телефоне неудобно, а свободного места в шапке
                    много. Роль и клавиши заданы явно: шапка — это не кнопка
                    по разметке, и без них она осталась бы недоступной с
                    клавиатуры.
                  */}
                    <header
                      className="wh-route__head wh-route__head--clickable"
                      role="button"
                      tabIndex={0}
                      aria-expanded={route.routeId === openRoute}
                      data-testid="issue-route-head"
                      onClick={() =>
                        setOpenRoute(route.routeId === openRoute ? null : route.routeId)
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setOpenRoute(route.routeId === openRoute ? null : route.routeId);
                        }
                      }}
                    >
                      {/*
                        Четыре угла, как в «Сборке»: номер, готовность, счёт
                        заказов и действие. Одна длинная строка на телефоне
                        читалась по слогам, углы — двумя движениями глаз.
                      */}
                      <strong className="wh-route__number-text">{route.routeNumber}</strong>

                      {route.readiness !== 'NOT_READY' && (
                        <span
                          className="wh-route__readiness"
                          data-testid="issue-route-readiness"
                          data-readiness={route.readiness}
                        >
                          <StatusBadge tone={route.readiness === 'ASSEMBLED' ? 'success' : 'info'}>
                            {ISSUE_READINESS_LABELS[route.readiness]}
                          </StatusBadge>
                        </span>
                      )}

                      {/*
                        Короткая строка вместо перечисления: дата листа уже
                        стоит в его номере, а «внесено» читается из скобок.
                      */}
                      <span className="wh-route__counts" data-testid="issue-route-counts">
                        {route.total} ({route.checked} из {route.total})
                      </span>

                      {/*
                      Самостоятельные кнопки внутри шапки не переключают
                      раскрытие: нажатие «Отгрузить» — это отгрузка, а не
                      просьба показать состав.
                    */}
                      <Button
                        variant="primary"
                        className="wh-route__ship"
                        data-testid="issue-ship"
                        onClick={(event) => {
                          event.stopPropagation();
                          setShipping(route);
                        }}
                      >
                        Отгрузить
                      </Button>
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
                            {/*
                            Фактическая полка коробки: маршрутная или хранения.
                            Прочерк — только когда размещения нет вовсе, и тогда
                            же лист отгрузить нельзя.
                          */}
                            {/*
                            Ячейка стоит вплотную к статусу и в скобках: вместе
                            они и есть ответ «где коробка и можно ли её брать».
                          */}
                            <span
                              className={
                                order.cellCode === null
                                  ? 'wh-route__cellnum wh-route__cellnum--none'
                                  : 'wh-route__cellnum'
                              }
                              data-testid="issue-order-cell"
                            >
                              {order.cellCode ?? 'без ячейки'}
                            </span>
                            <span className="wh-route__badges">
                              <StatusBadge tone={order.ready ? 'success' : 'warning'}>
                                {order.ready ? 'Готов' : 'Не готов'}
                              </StatusBadge>
                            </span>

                            {/* Добавочный статус — третьей строкой, как в «Сборке». */}
                            {order.checked && (
                              <span className="wh-route__extra">
                                <StatusBadge tone="info">Внесён</StatusBadge>
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
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
        {/* Полная полоса зеленеет: «внесено всё» видно раньше, чем прочитано. */}
        <div
          className={allChecked ? 'wh-check__bar wh-check__bar--done' : 'wh-check__bar'}
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
          /*
            Когда внесены все заказы, сканировать больше нечего: кнопка гаснет,
            и единственным доступным действием остаётся отгрузка. Живая кнопка
            здесь предлагала бы работу, которой нет.
          */
          <Button
            variant="primary"
            className="wh-scan__button"
            data-testid="issue-scan"
            disabled={allChecked}
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
              <span className="wh-check__cell" data-testid="issue-check-cell">
                {issueCellLabel(order)}
              </span>
              <span className="wh-route__badges">
                <StatusBadge tone={order.checked ? 'success' : 'neutral'}>
                  {order.checked ? 'Проверен' : 'Ожидает'}
                </StatusBadge>
              </span>
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
            resultWindow
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
                  /*
                   * Заказ проверен — окно сканирования закрывается.
                   *
                   * Возврат к списку обязателен: человек должен увидеть
                   * обновлённый прогресс и новое состояние строки, а не гадать,
                   * засчиталась ли проверка. Следующий заказ сканируется
                   * отдельным нажатием — камера сама не открывается.
                   */
                  final: true,
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
