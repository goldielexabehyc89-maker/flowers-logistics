/**
 * Экран «Маршрутные листы».
 *
 * Три раздела подряд отвечают на один вопрос логиста: что ещё не уехало, что
 * в пути и что закончено. Листы сгруппированы по московским дням; текущий день
 * раскрыт, прошлые сворачиваются — вся история сразу превратила бы экран
 * в бесконечную ленту.
 *
 * Отбор и поиск считает СЕРВЕР. Фильтровать загруженные строки нельзя: лист
 * со второй страницы иначе исчезал бы из поиска вовсе.
 *
 * Печать сделана обычным CSS `@media print`, без отдельного генератора PDF:
 * лист — это тот же список остановок, а второй движок вёрстки означал бы
 * вторую версию правды о порядке доставки.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  StatusBadge,
  TextInput,
} from '../../ui/components';
import type { CourierOption } from '../deals/courier-picker';
import { CourierCombobox } from '../logistics/CourierCombobox';
import { OrderWindow } from '../logistics/OrderWindow';
import {
  canShip,
  isDayOpen,
  needsCancelWarning,
  SECTION_TITLES,
  SHEET_SECTIONS,
  shipBlockedReason,
  toggleDay,
  type SheetSection,
  type SheetView,
} from './sheets-view';
import {
  conflictLabel,
  formatDate,
  moscowToday,
  ROUTE_STATE_LABELS,
  stopInterval,
  VEHICLE_LABELS,
  type RouteCardView,
} from './routing';
import './routing.css';

interface SheetsResponse {
  days: { date: string; sheets: SheetView[] }[];
  total: number;
  hasMore: boolean;
}

interface CancelResponse {
  createdSheet: { id: string; number: string } | null;
  restoredOrders: number;
  unchanged: boolean;
}

/** Сколько листов раздела грузить за раз. Продолжение — по кнопке. */
const PAGE_SIZE = 20;

/**
 * Состав раскрытого листа.
 *
 * Берёт тот же существующий read-only маршрут `GET /api/routes/:id`, что и
 * печатная форма, — своего контракта не заводит. Факт доставки не выдумывается:
 * он приходит номерами заказов в самом листе (`deliveredNumbers`).
 */
function SheetOrders({
  routeId,
  deliveredNumbers,
  onOpenOrder,
}: {
  routeId: string;
  deliveredNumbers: readonly string[];
  onOpenOrder: (orderId: string) => void;
}): React.JSX.Element {
  const { client } = useAuth();
  const card = useQuery({
    queryKey: ['route', routeId],
    queryFn: () => client.get<RouteCardView>(`/api/routes/${routeId}`),
  });

  if (card.isPending) {
    return <LoadingState title="Загружаем состав…" />;
  }
  if (card.isError) {
    return <ErrorState title="Не удалось загрузить состав" onRetry={() => void card.refetch()} />;
  }

  const delivered = new Set(deliveredNumbers);
  return (
    <ul className="sheets__orders" data-testid="sheet-orders">
      {card.data.orders.map((item) => (
        <li
          key={item.routeOrderId}
          className="sheets__order"
          data-testid="sheet-order"
          data-order-number={item.order.number}
        >
          <span className="sheets__order-position">{item.position}</span>
          {/* Номер — вход в окно заказа: там вся информация и правки. */}
          <button
            type="button"
            className="sheets__order-number order-number-button"
            data-testid="order-number"
            onClick={() => onOpenOrder(item.order.id)}
          >
            {item.order.number}
          </button>
          <span className="sheets__order-address">{item.order.address ?? '—'}</span>
          <span className="sheets__order-interval muted">{stopInterval(item.order.interval)}</span>
          {delivered.has(item.order.number) && (
            <span className="sheets__order-state">Доставлен</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function RouteSheetsScreen(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const today = moscowToday();

  const [date, setDate] = useState('');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Заказ, открытый в окне: логист правит его адрес, интервал и точку. */
  const [orderWindowId, setOrderWindowId] = useState<string | null>(null);
  const [openedDays, setOpenedDays] = useState<ReadonlySet<string>>(new Set());
  const [pages, setPages] = useState<Record<SheetSection, number>>({
    UNSHIPPED: 1,
    SHIPPED: 1,
    DELIVERED: 1,
  });
  /** Лист, созданный отменой незавершённых: о нём сообщается отдельно. */
  const [createdSheet, setCreatedSheet] = useState<{ id: string; number: string } | null>(null);
  const [cancelFor, setCancelFor] = useState<SheetView | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);

  const couriers = useQuery({
    queryKey: ['couriers-for-routes'],
    queryFn: () =>
      client.get<{ items: CourierOption[] }>('/api/users?role=COURIER&status=ACTIVE&limit=100'),
  });

  /** Ручную отгрузку включает администратор; логист только видит состояние. */
  const settings = useQuery({
    queryKey: ['planning-settings'],
    queryFn: () =>
      client.get<{ manualIssue: { value: { enabled: boolean } } }>('/api/settings/planning'),
  });
  const manualIssueEnabled = settings.data?.manualIssue.value.enabled ?? false;

  /*
   * Отдельный запрос на раздел, объявленный явно.
   *
   * Хуки нельзя создавать в цикле или помощнике: их число и порядок обязаны
   * совпадать от рендера к рендеру, иначе React снимает приложение целиком.
   */
  const queryFor = (section: SheetSection, page: number) => ({
    queryKey: ['route-sheets', section, date, search, page] as const,
    queryFn: () => {
      const params = new URLSearchParams({
        section,
        limit: String(PAGE_SIZE * page),
        offset: '0',
      });
      if (date !== '') {
        params.set('deliveryDate', date);
      }
      if (search.trim() !== '') {
        params.set('search', search.trim());
      }
      return client.get<SheetsResponse>(`/api/route-sheets?${params.toString()}`);
    },
  });

  const unshipped = useQuery(queryFor('UNSHIPPED', pages.UNSHIPPED));
  const shipped = useQuery(queryFor('SHIPPED', pages.SHIPPED));
  const delivered = useQuery(queryFor('DELIVERED', pages.DELIVERED));

  const sections = { UNSHIPPED: unshipped, SHIPPED: shipped, DELIVERED: delivered };

  const refreshAll = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['route-sheets'] });
    void queryClient.invalidateQueries({ queryKey: ['routes'] });
  };

  const assignCourier = useMutation({
    mutationFn: (input: { sheet: SheetView; courierUserId: string | null }) =>
      client.put(`/api/routes/${input.sheet.id}/courier`, {
        courierUserId: input.courierUserId,
        expectedVersion: input.sheet.version,
      }),
    onSuccess: () => {
      showToast('Курьер сохранён', 'success');
      refreshAll();
    },
    onError: (error: unknown) => {
      /*
       * Чужая правка — не ошибка человека: данные обновляются, а сообщение
       * объясняет, почему его выбор не сохранился.
       */
      showToast(
        (error as { message?: string }).message ??
          'Лист изменён другим пользователем. Данные обновлены, повторите выбор.',
        'error',
      );
      refreshAll();
    },
  });

  const ship = useMutation({
    mutationFn: (sheet: SheetView) =>
      client.post(`/api/routes/${sheet.id}/ship`, { expectedVersion: sheet.version }),
    onSuccess: () => {
      showToast('Маршрутный лист отгружен', 'success');
      refreshAll();
    },
    onError: (error: unknown) =>
      showToast((error as { message?: string }).message ?? 'Не удалось отгрузить лист', 'error'),
  });

  const returnToDraft = useMutation({
    mutationFn: (sheet: SheetView) =>
      client.post(`/api/routes/${sheet.id}/return-to-draft`, {
        expectedVersion: sheet.version,
        reason: 'Возврат в черновик из маршрутных листов',
      }),
    onSuccess: () => {
      showToast('Лист вернулся в «Маршрутизацию» без потери состава', 'success');
      refreshAll();
    },
    onError: (error: unknown) =>
      showToast((error as { message?: string }).message ?? 'Не удалось вернуть лист', 'error'),
  });

  const cancelShipment = useMutation({
    mutationFn: (input: { sheet: SheetView; mode: 'UNFINISHED' | 'ALL' }) =>
      client.post<CancelResponse>(`/api/routes/${input.sheet.id}/cancel-shipment`, {
        expectedVersion: input.sheet.version,
        mode: input.mode,
        ...(input.mode === 'ALL' ? { reason: cancelReason.trim() } : {}),
      }),
    onSuccess: (result) => {
      setCancelFor(null);
      setConfirmAll(false);
      setCancelReason('');
      refreshAll();
      /*
       * Номер нового листа приходит с сервера и показывается ТОЛЬКО после
       * успешной операции: браузеру его вычислять неоткуда, а при ошибке
       * показывать нечего.
       */
      if (result.createdSheet !== null) {
        setCreatedSheet(result.createdSheet);
      } else {
        showToast('Отгрузка отменена', 'success');
      }
    },
    onError: (error: unknown) =>
      showToast((error as { message?: string }).message ?? 'Не удалось отменить отгрузку', 'error'),
  });

  const busy =
    ship.isPending ||
    returnToDraft.isPending ||
    cancelShipment.isPending ||
    assignCourier.isPending;

  const sheetCard = useQuery({
    queryKey: ['route', openId],
    queryFn: () => client.get<RouteCardView>(`/api/routes/${openId ?? ''}`),
    enabled: openId !== null,
  });

  return (
    <section className="stack">
      <div className="no-print routes__sheet-filters">
        <Field label="День" hint="Пусто — все дни">
          {(props) => (
            <TextInput
              {...props}
              type="date"
              value={date}
              data-testid="sheets-date"
              onChange={(event) => setDate(event.target.value)}
            />
          )}
        </Field>
        <Field label="Поиск" hint="Номер листа, номер заказа, имя или телефон курьера">
          {(props) => (
            <TextInput
              {...props}
              value={search}
              placeholder="Например, R-12 или Иванов"
              data-testid="sheets-search"
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </Field>
      </div>

      {/*
        Уведомление о созданном листе.

        Появляется только после успешного разделения и ведёт ровно в тот лист,
        который создан. Персональных данных здесь нет — только номер.
      */}
      {createdSheet !== null && (
        <p className="routes__hint no-print" role="status" data-testid="sheets-created-notice">
          Незавершённые заказы перенесены в новый маршрутный лист {createdSheet.number}.{' '}
          <button
            type="button"
            className="deals__link"
            data-testid="sheets-open-created"
            onClick={() => {
              setOpenId(createdSheet.id);
              setCreatedSheet(null);
            }}
          >
            Открыть МЛ {createdSheet.number}
          </button>
        </p>
      )}

      {SHEET_SECTIONS.map((section) => {
        const query = sections[section];
        const days = query.data?.days ?? [];
        return (
          <section key={section} className="routes__section" data-testid={`sheets-${section}`}>
            <h3 className="routes__section-title">
              {SECTION_TITLES[section]}{' '}
              <span className="muted text-sm">({query.data?.total ?? 0})</span>
            </h3>

            {query.isPending ? (
              <LoadingState title="Загружаем листы…" />
            ) : query.isError ? (
              <ErrorState title="Не удалось загрузить листы" onRetry={() => void query.refetch()} />
            ) : days.length === 0 ? (
              <EmptyState title="Листов в этом разделе нет" />
            ) : (
              days.map((day) => {
                const open = isDayOpen(day.date, today, openedDays);
                return (
                  <div key={day.date} className="routes__day" data-testid="sheets-day">
                    <button
                      type="button"
                      className="routes__day-toggle"
                      aria-expanded={open}
                      data-testid="sheets-day-toggle"
                      data-day={day.date}
                      onClick={() => setOpenedDays((current) => toggleDay(current, day.date))}
                    >
                      {formatDate(day.date)}
                      <span className="muted text-sm"> · листов: {day.sheets.length}</span>
                    </button>

                    {open && (
                      <ul className="routes__list">
                        {day.sheets.map((sheet) => (
                          <li
                            key={sheet.id}
                            className="routes__list-item sheets__item"
                            data-testid="sheet-row"
                            data-sheet-number={sheet.number}
                            data-expanded={expandedId === sheet.id ? 'true' : 'false'}
                          >
                            <div className="sheets__item-head">
                              <div className="sheets__item-main">
                                {/*
                                  Свёрнутый лист — ровно одна строка: номер,
                                  состояние и счётчики. Скрытого пустого тела
                                  под ней нет, состав грузится только при
                                  раскрытии.
                                */}
                                <button
                                  type="button"
                                  className="sheets__item-toggle"
                                  aria-expanded={expandedId === sheet.id}
                                  data-testid="sheet-expand"
                                  onClick={() =>
                                    setExpandedId((current) =>
                                      current === sheet.id ? null : sheet.id,
                                    )
                                  }
                                >
                                  <span className="routes__number">{sheet.number}</span>
                                  <StatusBadge tone="info">
                                    {
                                      ROUTE_STATE_LABELS[
                                        sheet.state as keyof typeof ROUTE_STATE_LABELS
                                      ]
                                    }
                                  </StatusBadge>
                                  <span className="muted text-sm">
                                    заказов: {sheet.totalOrders}
                                    {sheet.deliveredOrders > 0
                                      ? ` · доставлено: ${sheet.deliveredOrders}`
                                      : ''}
                                  </span>
                                  <span className="sheets__item-chevron" aria-hidden="true" />
                                </button>
                                {/*
                                Курьер выбирается прямо в листе тем же контролом,
                                что и на других вкладках: нажатие в поле открывает
                                список, ввод его сужает. Список рисуется поверх
                                содержимого и карточку не растягивает.
                              */}
                                {section === 'UNSHIPPED' ? (
                                  <div
                                    className="routes__sheet-courier"
                                    data-testid="sheet-courier"
                                  >
                                    <CourierCombobox
                                      options={couriers.data?.items ?? []}
                                      value={
                                        sheet.courier === null
                                          ? null
                                          : ((couriers.data?.items ?? []).find(
                                              (item) => item.id === sheet.courier?.id,
                                            ) ?? {
                                              id: sheet.courier.id,
                                              fullName: sheet.courier.fullName,
                                              phone: null,
                                            })
                                      }
                                      disabled={busy}
                                      testId="sheet-courier-combobox"
                                      onChange={(courier) =>
                                        assignCourier.mutate({
                                          sheet,
                                          courierUserId: courier === null ? null : courier.id,
                                        })
                                      }
                                    />
                                  </div>
                                ) : (
                                  <div className="muted text-sm" data-testid="sheet-courier">
                                    Курьер: {sheet.courier?.fullName ?? 'не назначен'}
                                  </div>
                                )}
                              </div>

                              <div className="routes__actions">
                                {section === 'UNSHIPPED' && (
                                  <>
                                    <Button
                                      variant="primary"
                                      disabled={busy || !canShip(sheet, manualIssueEnabled)}
                                      title={
                                        shipBlockedReason(sheet, manualIssueEnabled) ?? undefined
                                      }
                                      data-testid="sheet-ship"
                                      onClick={() => ship.mutate(sheet)}
                                    >
                                      Отгрузить
                                    </Button>
                                    <Button
                                      disabled={busy}
                                      data-testid="sheet-return-to-draft"
                                      onClick={() => returnToDraft.mutate(sheet)}
                                    >
                                      Вернуть в черновик
                                    </Button>
                                  </>
                                )}
                                {section === 'SHIPPED' && (
                                  <Button
                                    disabled={busy}
                                    data-testid="sheet-cancel-shipment"
                                    onClick={() => {
                                      setCancelFor(sheet);
                                      setCancelReason('');
                                      setConfirmAll(false);
                                    }}
                                  >
                                    Отменить отгрузку
                                  </Button>
                                )}
                                <Button
                                  data-testid="sheet-open"
                                  onClick={() => setOpenId(sheet.id)}
                                >
                                  Открыть лист
                                </Button>
                              </div>
                            </div>

                            {expandedId === sheet.id && (
                              <SheetOrders
                                routeId={sheet.id}
                                deliveredNumbers={sheet.deliveredNumbers}
                                onOpenOrder={setOrderWindowId}
                              />
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })
            )}

            {(query.data?.hasMore ?? false) && (
              <Button
                data-testid="sheets-more"
                onClick={() =>
                  setPages((current) => ({ ...current, [section]: current[section] + 1 }))
                }
              >
                Показать ещё
              </Button>
            )}
          </section>
        );
      })}

      {/*
        Отмена отгрузки.

        Без доставленных заказов это обычное подтверждение. С доставленными —
        предупреждение с их номерами и тремя разными исходами: закрыть, вернуть
        только незавершённые или вернуть всё административной коррекцией.
      */}
      <Modal
        open={cancelFor !== null}
        title={
          cancelFor !== null && needsCancelWarning(cancelFor)
            ? 'В листе есть доставленные заказы'
            : 'Отменить отгрузку'
        }
        onClose={() => setCancelFor(null)}
        dismissible={!cancelShipment.isPending}
        testId="cancel-shipment-dialog"
      >
        {cancelFor !== null && (
          <div className="stack">
            {needsCancelWarning(cancelFor) ? (
              <>
                <p className="text-sm">
                  Уже доставлены заказы: {cancelFor.deliveredNumbers.join(', ')}. Выберите, что с
                  ними делать.
                </p>

                <Field label="Причина" hint="Обязательна для возврата доставленных заказов">
                  {(props) => (
                    <TextInput
                      {...props}
                      value={cancelReason}
                      data-testid="cancel-reason"
                      disabled={cancelShipment.isPending}
                      onChange={(event) => setCancelReason(event.target.value)}
                    />
                  )}
                </Field>

                {confirmAll && (
                  <p className="text-sm" data-testid="cancel-all-confirm">
                    Доставленные заказы снова станут неотгруженными. Прежние факты доставки
                    останутся в истории отменёнными. Подтвердите ещё раз.
                  </p>
                )}

                <div className="modal__footer">
                  <Button
                    onClick={() => setCancelFor(null)}
                    disabled={cancelShipment.isPending}
                    data-testid="cancel-dismiss"
                  >
                    Отмена
                  </Button>
                  <Button
                    disabled={cancelShipment.isPending}
                    data-testid="cancel-unfinished"
                    onClick={() => cancelShipment.mutate({ sheet: cancelFor, mode: 'UNFINISHED' })}
                  >
                    Отменить отгрузку незавершённых
                  </Button>
                  <Button
                    variant="danger"
                    disabled={cancelShipment.isPending || cancelReason.trim().length < 3}
                    data-testid="cancel-all"
                    onClick={() => {
                      if (!confirmAll) {
                        setConfirmAll(true);
                        return;
                      }
                      cancelShipment.mutate({ sheet: cancelFor, mode: 'ALL' });
                    }}
                  >
                    {confirmAll ? 'Подтвердить: отменить все' : 'Отменить все'}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm">
                  Лист {cancelFor.number} вернётся в неотгруженные. Состав и порядок сохранятся.
                </p>
                <div className="modal__footer">
                  <Button onClick={() => setCancelFor(null)} data-testid="cancel-dismiss">
                    Отмена
                  </Button>
                  <Button
                    variant="primary"
                    disabled={cancelShipment.isPending}
                    data-testid="cancel-confirm"
                    onClick={() => cancelShipment.mutate({ sheet: cancelFor, mode: 'UNFINISHED' })}
                  >
                    Отменить отгрузку
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {openId !== null && (
        <>
          {sheetCard.isPending ? (
            <LoadingState title="Готовим маршрутный лист…" />
          ) : sheetCard.isError || sheetCard.data === undefined ? (
            <ErrorState
              title="Не удалось загрузить лист"
              onRetry={() => void sheetCard.refetch()}
            />
          ) : (
            <article className="sheet">
              <header className="sheet__header">
                <div>
                  <h3>Маршрутный лист {sheetCard.data.number}</h3>
                  <p className="text-sm">
                    Дата: {formatDate(sheetCard.data.deliveryDate)} · Транспорт:{' '}
                    {VEHICLE_LABELS[sheetCard.data.vehicleType]} · Курьер:{' '}
                    {sheetCard.data.courier?.fullName ?? 'не назначен'}
                  </p>
                </div>
                <div className="no-print sheet__controls">
                  <Button variant="primary" onClick={() => window.print()}>
                    Печать
                  </Button>
                  <Button onClick={() => setOpenId(null)}>Закрыть</Button>
                </div>
              </header>

              <ol className="sheet__stops">
                {sheetCard.data.orders.map((item) => (
                  <li key={item.routeOrderId} className="sheet__stop">
                    <div className="sheet__stop-head">
                      <span className="sheet__position">{item.position}</span>
                      <span className="routes__number">{item.order.number}</span>
                      <span>{stopInterval(item.order.interval)}</span>
                    </div>
                    <div className="sheet__stop-line">
                      <strong>{item.order.address ?? '—'}</strong>
                    </div>
                    <div className="sheet__stop-line">{item.order.recipient ?? '—'}</div>
                    {item.order.comment !== null && (
                      <div className="sheet__stop-line">Комментарий: {item.order.comment}</div>
                    )}
                    <div className="sheet__stop-line">
                      {item.order.cashToCollect === null
                        ? 'Наличные не принимаются'
                        : `К получению: ${item.order.cashToCollect} ₽`}
                    </div>
                    {(item.order.needsAttention || item.conflicts.length > 0) && (
                      <div className="sheet__warnings">
                        {item.order.needsAttention && <span>Требует внимания</span>}
                        {item.conflicts.map((conflict) => (
                          <span key={conflict.kind}>{conflictLabel(conflict.kind)}</span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ol>

              {sheetCard.data.orders.length === 0 && (
                <p className="text-sm">В маршруте нет заказов.</p>
              )}

              <footer className="sheet__footer text-sm">
                Итого остановок: {sheetCard.data.orders.length}. Состояние маршрута:{' '}
                <StatusBadge tone="info">
                  {ROUTE_STATE_LABELS[sheetCard.data.state].toLocaleLowerCase('ru')}
                </StatusBadge>
              </footer>
            </article>
          )}
        </>
      )}

      {/* Окно заказа: одно и то же на всех вкладках. */}
      {orderWindowId !== null && (
        <OrderWindow orderId={orderWindowId} onClose={() => setOrderWindowId(null)} />
      )}
    </section>
  );
}
