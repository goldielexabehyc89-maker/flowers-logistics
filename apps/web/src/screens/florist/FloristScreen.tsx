/**
 * Раздел флориста: очередь, свои заказы и печать.
 *
 * Экран рабочий, а не витринный: флорист смотрит его весь день со стола или
 * с планшета, поэтому строки плотные, а решения видны без наведения —
 * просрочка, маршрут и занятость заказа читаются сразу.
 *
 * СМЕНА ВВЕРХУ НЕ СЛУЧАЙНО. Без активной смены новый заказ взять нельзя,
 * и человек обязан видеть причину отказа до того, как нажмёт кнопку.
 *
 * ДЕНЬ СЧИТАЕТ СЕРВЕР. Переключатель посылает `today`/`tomorrow`, а не дату:
 * браузер к вычислению московского дня не допускается (`TZ-001`). Показанная
 * дата приходит ответом сервера.
 *
 * ОШИБКА НЕ ОСТАВЛЯЕТ ЛОЖНОГО СОСТОЯНИЯ. Списки не правятся «оптимистично»:
 * после каждого действия и каждого отказа данные перезапрашиваются, а realtime
 * обновляет ровно те запросы, которых касается событие.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatMoscowDateTime } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import { Button, EmptyState, ErrorState, LoadingState, StatusBadge } from '../../ui/components';
import { OrderCardPanel } from './OrderCardPanel';
import {
  formatDay,
  formatInterval,
  latestJob,
  printStateLabel,
  processLabel,
  routeLabel,
  type FloristOption,
  type FloristTab,
  type OrderCardView,
  type PrintJobView,
  type QueueDay,
  type QueueResponse,
  type ShiftView,
} from './florist';
import './florist.css';

const TABS: { key: FloristTab; title: string }[] = [
  { key: 'queue', title: 'Очередь' },
  { key: 'mine', title: 'Мои заказы' },
  { key: 'print', title: 'Печать' },
];

export function FloristScreen(): React.JSX.Element {
  const { client, user } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const isAdmin = user?.roles.includes('ADMIN') === true;
  const viewerId = user?.id ?? '';

  const [tab, setTab] = useState<FloristTab>('queue');
  const [day, setDay] = useState<QueueDay>('today');
  const [includeAssigned, setIncludeAssigned] = useState(false);
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  const [printFilter, setPrintFilter] = useState<'attention' | 'printed'>('attention');
  /** Причина принудительного завершения — своя у каждой смены в списке. */
  const [forceReason, setForceReason] = useState<Record<string, string>>({});

  const scope = tab === 'mine' ? 'mine' : 'general';

  const shiftQuery = useQuery({
    queryKey: ['florist-shift'],
    queryFn: () => client.get<{ shift: ShiftView | null }>('/api/florist/shift'),
  });

  const queueQuery = useQuery({
    queryKey: ['florist-queue', day, scope, includeAssigned],
    queryFn: () =>
      client.get<QueueResponse>(
        `/api/florist/queue?day=${day}&scope=${scope}&all=${includeAssigned ? 'true' : 'false'}`,
      ),
    enabled: tab !== 'print',
  });

  const printQuery = useQuery({
    queryKey: ['florist-print-jobs', printFilter],
    queryFn: () =>
      client.get<{ items: PrintJobView[] }>(`/api/florist/print-jobs?filter=${printFilter}`),
    enabled: tab === 'print',
  });

  const cardQuery = useQuery({
    queryKey: ['florist-card', openOrderId],
    queryFn: () => client.get<{ card: OrderCardView }>(`/api/florist/orders/${openOrderId ?? ''}`),
    enabled: openOrderId !== null,
  });

  const floristsQuery = useQuery({
    queryKey: ['florist-florists'],
    queryFn: () => client.get<{ items: FloristOption[] }>('/api/florist/florists'),
    enabled: isAdmin,
  });

  /** Кто сейчас на смене. Только администратору: это управление людьми. */
  const shiftsQuery = useQuery({
    queryKey: ['florist-shifts'],
    queryFn: () => client.get<{ items: ShiftView[] }>('/api/florist/shifts'),
    enabled: isAdmin,
  });

  const shift = shiftQuery.data?.shift ?? null;
  const hasActiveShift = shift !== null;

  /**
   * Общий перезапрос после любого действия.
   *
   * Точечное «поправим строку на месте» здесь было бы вредным: сервер мог
   * отказать, перевести заказ в другое состояние или отдать его другому
   * флористу, и локальная догадка разошлась бы с действительностью.
   */
  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['florist-queue'] }),
      queryClient.invalidateQueries({ queryKey: ['florist-card'] }),
      queryClient.invalidateQueries({ queryKey: ['florist-print-jobs'] }),
      queryClient.invalidateQueries({ queryKey: ['florist-shift'] }),
      queryClient.invalidateQueries({ queryKey: ['florist-shifts'] }),
      queryClient.invalidateQueries({ queryKey: ['florist-florists'] }),
    ]);
  }

  function reportError(error: unknown, fallback: string): void {
    showToast(error instanceof ApiError ? error.message : fallback, 'error');
  }

  const action = useMutation({
    mutationFn: async (input: { path: string; body?: unknown; success: string }) => {
      await client.post(input.path, input.body);
      return input.success;
    },
    onSuccess: async (message) => {
      await refresh();
      showToast(message, 'success');
    },
    onError: async (error: unknown) => {
      // Перезапрос ОБЯЗАТЕЛЕН и при отказе: заказ мог уйти другому флористу,
      // и экран не должен продолжать показывать его свободным.
      await refresh();
      reportError(error, 'Не удалось выполнить действие.');
    },
  });

  /** Скачивание документа: токен живёт в памяти, поэтому обычная ссылка не годится. */
  async function download(path: string, fileName: string): Promise<void> {
    try {
      const blob = await client.getBlob(path, 'application/pdf');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      reportError(error, 'Не удалось получить бланк.');
    }
  }

  /** Из карточки открывается ПОСЛЕДНИЙ бланк заказа: он относится к текущей сборке. */
  async function downloadOrderPdf(orderId: string, number: string): Promise<void> {
    await download(`/api/florist/orders/${orderId}/print-form.pdf`, `order-${number}.pdf`);
  }

  /**
   * Из вкладки «Печать» открывается документ КОНКРЕТНОГО задания.
   *
   * Это не то же самое, что последний бланк заказа: после пересборки у заказа
   * появляется новая форма, а старая попытка обязана отдавать ровно тот
   * документ, ради которого её создавали, — иначе к букету приложат бумагу
   * от другой сборки.
   */
  async function downloadJobPdf(job: PrintJobView): Promise<void> {
    await download(
      `/api/florist/print-jobs/${job.id}/document.pdf`,
      `order-${job.orderNumber}-attempt-${job.attempt}.pdf`,
    );
  }

  const card = cardQuery.data?.card ?? null;

  return (
    <section className="stack florist">
      <header className="florist__header card">
        <div>
          {/* Заголовок раздела рисует оболочка приложения: второй <h1> здесь
              создал бы два одинаковых заголовка первого уровня на одной странице. */}
          <h2>Рабочее место флориста</h2>
          <p className="muted text-sm">
            {hasActiveShift
              ? `Смена с ${formatMoscowDateTime(shift.startedAt)} · в сборке: ${shift.openAssignments}`
              : 'Смена не начата. Без неё новый заказ взять нельзя.'}
          </p>
        </div>
        <div className="row">
          {hasActiveShift ? (
            <Button
              variant="secondary"
              data-testid="shift-close"
              disabled={action.isPending}
              onClick={() =>
                action.mutate({ path: '/api/florist/shift/close', success: 'Смена завершена' })
              }
            >
              Завершить смену
            </Button>
          ) : (
            <Button
              variant="primary"
              data-testid="shift-start"
              disabled={action.isPending}
              onClick={() =>
                action.mutate({ path: '/api/florist/shift/start', success: 'Смена начата' })
              }
            >
              Начать смену
            </Button>
          )}
        </div>
      </header>

      {/*
       * Активные смены и принудительное завершение — только администратору.
       *
       * Незавершённые назначения при этом НЕ снимаются: наполовину собранный
       * заказ не должен молча вернуться в общую очередь. Их число показано
       * рядом с кнопкой, чтобы решение принималось осознанно.
       */}
      {isAdmin && shiftsQuery.isSuccess && shiftsQuery.data.items.length > 0 && (
        <section className="card stack" data-testid="florist-shifts">
          <h3>Смены на сегодня</h3>
          <ul className="florist__list">
            {shiftsQuery.data.items.map((item) => (
              <li key={item.id} className="florist__row" data-testid="shift-row">
                <div className="florist__row-main">
                  <strong>{item.userFullName}</strong>
                  <span className="muted text-sm">с {formatMoscowDateTime(item.startedAt)}</span>
                  <span className="muted text-sm">в сборке: {item.openAssignments}</span>
                </div>
                <div className="florist__row-side">
                  <input
                    className="input"
                    aria-label={`Причина завершения смены ${item.userFullName}`}
                    placeholder="Причина завершения"
                    value={forceReason[item.id] ?? ''}
                    onChange={(event) =>
                      setForceReason((current) => ({ ...current, [item.id]: event.target.value }))
                    }
                  />
                  <Button
                    variant="secondary"
                    data-testid="shift-force-close"
                    disabled={action.isPending || (forceReason[item.id] ?? '').trim().length < 3}
                    onClick={() =>
                      action.mutate({
                        path: `/api/florist/shifts/${item.id}/force-close`,
                        body: { reason: (forceReason[item.id] ?? '').trim() },
                        success: 'Смена завершена принудительно',
                      })
                    }
                  >
                    Завершить смену
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <p className="muted text-sm">
            Незавершённые заказы остаются за флористом и требуют решения: переназначьте их или
            верните в очередь из карточки.
          </p>
        </section>
      )}

      <nav className="florist__tabs" aria-label="Разделы флориста">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className="florist__tab"
            aria-pressed={tab === item.key}
            data-testid={`florist-tab-${item.key}`}
            onClick={() => setTab(item.key)}
          >
            {item.title}
          </button>
        ))}
      </nav>

      {tab !== 'print' && (
        <div className="florist__filters card">
          <div className="row" role="group" aria-label="День">
            {(['today', 'tomorrow'] as QueueDay[]).map((value) => (
              <button
                key={value}
                type="button"
                className="florist__day"
                aria-pressed={day === value}
                data-testid={`florist-day-${value}`}
                onClick={() => setDay(value)}
              >
                {value === 'today' ? 'Сегодня' : 'Завтра'}
              </button>
            ))}
            <span className="muted text-sm">
              {queueQuery.data === undefined ? '' : formatDay(queueQuery.data.deliveryDate)}
            </span>
          </div>

          {tab === 'queue' && (
            <label className="florist__checkbox">
              <input
                type="checkbox"
                checked={includeAssigned}
                data-testid="florist-all"
                onChange={(event) => setIncludeAssigned(event.target.checked)}
              />
              Все
            </label>
          )}
        </div>
      )}

      {tab !== 'print' && queueQuery.isPending && <LoadingState title="Загружаем очередь…" />}
      {tab !== 'print' && queueQuery.isError && (
        <ErrorState
          description="Очередь не загрузилась."
          onRetry={() => void queueQuery.refetch()}
        />
      )}
      {tab !== 'print' && queueQuery.isSuccess && queueQuery.data.items.length === 0 && (
        <EmptyState
          title={tab === 'mine' ? 'Заказов за вами нет' : 'Очередь пуста'}
          description={
            tab === 'mine'
              ? 'Возьмите заказ из общей очереди.'
              : 'На выбранный день свободных заказов с подтверждённым составом нет.'
          }
        />
      )}

      {tab !== 'print' && queueQuery.isSuccess && queueQuery.data.items.length > 0 && (
        <ul className="florist__list" data-testid="florist-queue">
          {queueQuery.data.items.map((item) => (
            <li
              key={item.id}
              className={`florist__row${item.overdue ? ' florist__row--overdue' : ''}`}
              data-testid="florist-row"
              data-order-number={item.number}
            >
              <div className="florist__row-main">
                <button
                  type="button"
                  className="florist__number"
                  onClick={() => setOpenOrderId(item.id)}
                >
                  {item.number}
                </button>
                <span className="florist__time">{formatInterval(item)}</span>
                {item.overdue && <StatusBadge tone="error">Просрочен</StatusBadge>}
                {routeLabel(item) !== null && (
                  <StatusBadge tone="info">{routeLabel(item)}</StatusBadge>
                )}
                {item.changedSinceClaim && <StatusBadge tone="warning">Заказ изменён</StatusBadge>}
              </div>

              <div className="florist__row-side">
                <span className="muted text-sm">{processLabel(item.processState)}</span>
                {item.assignee !== null && (
                  <span className="muted text-sm" data-testid="row-assignee">
                    {item.assignee.fullName}
                  </span>
                )}
                {item.processState === 'NEW' && (
                  <Button
                    variant="primary"
                    disabled={action.isPending || !hasActiveShift}
                    data-testid="row-claim"
                    onClick={() =>
                      action.mutate({
                        path: `/api/florist/orders/${item.id}/claim`,
                        success: `Заказ ${item.number} взят в работу`,
                      })
                    }
                  >
                    Взять в работу
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setOpenOrderId(item.id)}>
                  Открыть
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {tab === 'print' && (
        <div className="florist__filters card">
          <div className="row" role="group" aria-label="Фильтр заданий печати">
            {(['attention', 'printed'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="florist__day"
                aria-pressed={printFilter === value}
                data-testid={`print-filter-${value}`}
                onClick={() => setPrintFilter(value)}
              >
                {value === 'attention' ? 'Требуют внимания' : 'Напечатанные'}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'print' && printQuery.isPending && (
        <LoadingState title="Загружаем очередь печати…" />
      )}
      {tab === 'print' && printQuery.isError && (
        <ErrorState
          description="Очередь печати не загрузилась."
          onRetry={() => void printQuery.refetch()}
        />
      )}
      {tab === 'print' && printQuery.isSuccess && printQuery.data.items.length === 0 && (
        <EmptyState
          title="Заданий нет"
          description={
            printFilter === 'attention'
              ? 'Все бланки напечатаны.'
              : 'Напечатанных бланков пока нет.'
          }
        />
      )}

      {tab === 'print' && printQuery.isSuccess && printQuery.data.items.length > 0 && (
        <ul className="florist__list" data-testid="florist-print-list">
          {printQuery.data.items.map((job) => (
            <li key={job.id} className="florist__row" data-testid="print-row">
              <div className="florist__row-main">
                <button
                  type="button"
                  className="florist__number"
                  onClick={() => setOpenOrderId(job.orderId)}
                >
                  {job.orderNumber}
                </button>
                <span className="muted text-sm">{formatMoscowDateTime(job.createdAt)}</span>
                <StatusBadge
                  tone={
                    job.state === 'ERROR'
                      ? 'error'
                      : job.state === 'PRINTED'
                        ? 'success'
                        : 'warning'
                  }
                >
                  {printStateLabel(job.state)}
                </StatusBadge>
                <span className="muted text-sm">попытка {job.attempt}</span>
                {job.lastErrorCode !== null && (
                  <span className="muted text-sm">код {job.lastErrorCode}</span>
                )}
              </div>

              <div className="florist__row-side">
                <Button
                  variant="secondary"
                  data-testid="print-download"
                  onClick={() => void downloadJobPdf(job)}
                >
                  Скачать PDF
                </Button>
                <Button
                  variant="ghost"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({
                      path: `/api/florist/print-jobs/${job.id}/retry`,
                      success: 'Создана новая попытка печати',
                    })
                  }
                >
                  Повторить печать
                </Button>
                {job.state !== 'PRINTED' && (
                  <Button
                    variant="ghost"
                    disabled={action.isPending}
                    data-testid="print-mark"
                    onClick={() =>
                      action.mutate({
                        path: `/api/florist/print-jobs/${job.id}/printed`,
                        success: 'Отмечено напечатанным',
                      })
                    }
                  >
                    Напечатано вручную
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {openOrderId !== null && cardQuery.isPending && <LoadingState title="Открываем карточку…" />}
      {openOrderId !== null && cardQuery.isError && (
        <ErrorState
          description="Карточка не загрузилась."
          onRetry={() => void cardQuery.refetch()}
        />
      )}

      {card !== null && (
        <OrderCardPanel
          card={card}
          viewerId={viewerId}
          isAdmin={isAdmin}
          hasActiveShift={hasActiveShift}
          florists={floristsQuery.data?.items ?? []}
          busy={action.isPending}
          onClose={() => setOpenOrderId(null)}
          onClaim={() =>
            action.mutate({
              path: `/api/florist/orders/${card.id}/claim`,
              success: `Заказ ${card.number} взят в работу`,
            })
          }
          onRelease={() =>
            action.mutate({
              path: `/api/florist/orders/${card.id}/release`,
              success: 'Заказ возвращён в очередь',
            })
          }
          onAssemble={() =>
            action.mutate({
              path: `/api/florist/orders/${card.id}/assemble`,
              // Версия процесса та, которую видел человек: чужое изменение
              // обязано отказать, а не перезаписать чужую работу.
              body: { expectedProcessVersion: card.process.version },
              success: 'Заказ собран, бланк поставлен в очередь печати',
            })
          }
          onReopen={(reason) =>
            action.mutate({
              path: `/api/florist/orders/${card.id}/reopen`,
              body: { reason },
              success: 'Заказ возвращён в работу',
            })
          }
          onReassign={(floristId) =>
            action.mutate({
              path: `/api/florist/orders/${card.id}/assign`,
              body: { floristId },
              success: 'Заказ переназначен',
            })
          }
          onDownload={() => void downloadOrderPdf(card.id, card.number)}
          onRetry={() => {
            const job = latestJob(card);
            if (job !== null) {
              action.mutate({
                path: `/api/florist/print-jobs/${job.id}/retry`,
                success: 'Создана новая попытка печати',
              });
            }
          }}
          onMarkPrinted={() => {
            const job = latestJob(card);
            if (job !== null) {
              action.mutate({
                path: `/api/florist/print-jobs/${job.id}/printed`,
                success: 'Отмечено напечатанным',
              });
            }
          }}
        />
      )}
    </section>
  );
}
