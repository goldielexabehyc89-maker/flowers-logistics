/**
 * Рабочее пространство «Сделки».
 *
 * Слева список заказов дня, справа карта того же множества. Это одно рабочее
 * место, а не два экрана: дата, поиск, фильтр времени, переключатель черновиков
 * и выбор общие. Множества не расходятся, потому что и список, и карта, и
 * «выбрать все» спрашивают ОДИН серверный отбор — правило живёт на сервере,
 * а не дублируется здесь.
 *
 * Из выбора логист либо создаёт один черновик в своём порядке, либо запускает
 * автоматический расчёт ровно по выбранным заказам. Ни то, ни другое ничего
 * не подтверждает.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { moscowToday } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  StatusBadge,
  TextInput,
} from '../../ui/components';
import { attentionLabel, formatMinutes } from './deals';
import { DealsMap } from './DealsMap';
import { AddressDialog } from './AddressDialog';
import {
  dropUnavailable,
  intervalProblem,
  parseTimeFilter,
  selectAll,
  selectionNumber,
  summarize,
  toggleSelection,
  unselectableReason,
  UNSELECTABLE_LABELS,
  type DealCard,
} from './selection';
import './deals-workspace.css';

interface DealsResponse {
  items: DealCard[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  deliveryDate: string;
}

const PAGE_SIZE = 50;

/** Минуты от полуночи в строку `ЧЧ:ММ` для поля формы. */
function minutesToText(minute: number | null): string {
  if (minute === null) {
    return '';
  }
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export function DealsWorkspace(): React.JSX.Element {
  const { client } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [date, setDate] = useState(() => moscowToday());
  const [search, setSearch] = useState('');
  const [fromTime, setFromTime] = useState('');
  const [toTime, setToTime] = useState('');
  const [includeDrafts, setIncludeDrafts] = useState(false);
  /** Накопленные страницы: список продолжается, а не перезагружается целиком. */
  const [pages, setPages] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<DealCard | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Заказ, у которого сейчас правят интервал, и черновик значений. */
  const [intervalFor, setIntervalFor] = useState<DealCard | null>(null);
  const [intervalFrom, setIntervalFrom] = useState('');
  const [intervalTo, setIntervalTo] = useState('');
  const [intervalError, setIntervalError] = useState<string | null>(null);

  /** Ровно те параметры, которыми пользуются список, карта и «выбрать все». */
  const scope = useMemo(() => {
    const params = new URLSearchParams({ deliveryDate: date });
    if (search.trim() !== '') {
      params.set('search', search.trim());
    }
    const from = parseTimeFilter(fromTime);
    const to = parseTimeFilter(toTime);
    if (from !== null) {
      params.set('fromMinute', String(from));
    }
    if (to !== null) {
      params.set('toMinute', String(to));
    }
    if (includeDrafts) {
      params.set('includeDrafts', 'true');
    }
    return params;
  }, [date, search, fromTime, toTime, includeDrafts]);

  const scopeKey = scope.toString();

  const list = useQuery({
    queryKey: ['deals', scopeKey, pages],
    queryFn: () => {
      const params = new URLSearchParams(scopeKey);
      params.set('limit', String(PAGE_SIZE * pages));
      params.set('offset', '0');
      return client.get<DealsResponse>(`/api/deals?${params.toString()}`);
    },
  });

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const visibleIds = useMemo(() => items.map((item) => item.id), [items]);
  const summary = summarize(selected, visibleIds);

  /**
   * Realtime: чужое действие могло сделать выбранный заказ недоступным.
   * Такой заказ снимается с явным сообщением — тихо исчезнувший номер
   * выглядит как сбой, а не как чужое действие.
   */
  const unavailable = useMemo(
    () => items.filter((item) => unselectableReason(item) !== null).map((item) => item.id),
    [items],
  );
  useEffect(() => {
    const next = dropUnavailable(selected, unavailable);
    if (next.removed.length === 0) {
      return;
    }
    setSelected(next.selected);
    setNotice(`Из выбора снято заказов: ${next.removed.length}. Их уже нельзя распределить.`);
    // Зависимость только от пришедших данных: собственное изменение выбора
    // этот эффект не перезапускает, иначе он никогда бы не сошёлся.
  }, [unavailable, selected]);

  const selectAllMutation = useMutation({
    mutationFn: () => client.get<{ orderIds: string[] }>(`/api/deals/selectable?${scopeKey}`),
    onSuccess: (result) => {
      setSelected((current) => selectAll(current, result.orderIds));
      setNotice(null);
    },
  });

  const manualDraft = useMutation({
    mutationFn: () =>
      client.post<{ id: string; number: string; repeated: boolean }>('/api/routes/from-selection', {
        deliveryDate: date,
        vehicleType: 'CAR',
        orderIds: selected,
      }),
    onSuccess: (route) => {
      setSelected([]);
      void queryClient.invalidateQueries({ queryKey: ['deals'] });
      // Успех ведёт в созданный черновик, а не «куда-нибудь в маршрутизацию».
      void navigate(`/logistics/routing?route=${route.id}`);
    },
    onError: (error: unknown) => {
      const conflict = (error as { conflict?: { orderIds?: string[] } }).conflict;
      const changed = conflict?.orderIds ?? [];
      if (changed.length > 0) {
        // Остальные пригодные заказы из выбора не теряются: снимаются только
        // те, что действительно изменились.
        setSelected((current) => dropUnavailable(current, changed).selected);
      }
      setNotice(
        (error as { message?: string }).message ??
          'Часть заказов изменилась. Список обновлён, проверьте выбор.',
      );
      void queryClient.invalidateQueries({ queryKey: ['deals'] });
    },
  });

  /**
   * Ручной интервал доставки.
   *
   * Тот же серверный контракт, что и раньше: проверка, аудит, событие и
   * сохранение правки при синхронизации живут на сервере. Здесь только форма
   * и честный показ отказа — оптимистически «успех» не рисуется.
   */
  const saveInterval = useMutation({
    mutationFn: (order: DealCard) =>
      client.put(`/api/orders/${order.id}/interval`, {
        startMinute: parseTimeFilter(intervalFrom) ?? 0,
        endMinute: parseTimeFilter(intervalTo) ?? 0,
        version: order.version,
      }),
    onSuccess: () => {
      setIntervalFor(null);
      setIntervalError(null);
      // Обновляются карточка, «Требует внимания», карта и selectable —
      // все они питаются одним отбором, поэтому достаточно его перечитать.
      void queryClient.invalidateQueries({ queryKey: ['deals'] });
      void queryClient.invalidateQueries({ queryKey: ['deals-map'] });
    },
    onError: (error: unknown) => {
      setIntervalError((error as { message?: string }).message ?? 'Не удалось сохранить интервал.');
    },
  });

  const autoPlan = useMutation({
    mutationFn: () =>
      client.post<{ id: string }>('/api/planning/runs', {
        deliveryDate: date,
        orderIds: selected,
        slots: [{ vehicleType: 'CAR', capacity: selected.length }],
      }),
    onSuccess: (run) => {
      setSelected([]);
      // Превью открывается по конкретному запуску: обновление страницы
      // и прямая ссылка возвращают тот же расчёт.
      void navigate(`/logistics/routing?run=${run.id}`);
    },
    onError: (error: unknown) => {
      setNotice(
        (error as { message?: string }).message ??
          'Расчёт не запущен: проверьте выбор и настройки.',
      );
    },
  });

  if (list.isPending) {
    return <LoadingState title="Загружаем сделки…" />;
  }
  if (list.isError) {
    return <ErrorState title="Не удалось загрузить сделки" onRetry={() => void list.refetch()} />;
  }

  const total = list.data?.total ?? 0;
  const hasMore = list.data?.hasMore ?? false;

  return (
    <section className="deals" data-testid="deals-workspace">
      <div className="deals__filters">
        <Field label="День">
          {(props) => (
            <TextInput
              {...props}
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                setPages(1);
              }}
            />
          )}
        </Field>
        <Field label="Поиск в этом дне" hint="Номер, адрес, получатель или комментарий">
          {(props) => (
            <TextInput
              {...props}
              value={search}
              placeholder="Например, номер заказа"
              onChange={(event) => {
                setSearch(event.target.value);
                setPages(1);
              }}
            />
          )}
        </Field>
        <Field label="Интервал от">
          {(props) => (
            <TextInput
              {...props}
              placeholder="10:00"
              value={fromTime}
              onChange={(event) => {
                setFromTime(event.target.value);
                setPages(1);
              }}
            />
          )}
        </Field>
        <Field label="Интервал до">
          {(props) => (
            <TextInput
              {...props}
              placeholder="18:00"
              value={toTime}
              onChange={(event) => {
                setToTime(event.target.value);
                setPages(1);
              }}
            />
          )}
        </Field>
        <label className="deals__toggle">
          <input
            type="checkbox"
            checked={includeDrafts}
            data-testid="deals-include-drafts"
            onChange={(event) => {
              setIncludeDrafts(event.target.checked);
              setPages(1);
            }}
          />
          Показать заказы из черновиков
        </label>
      </div>

      {notice !== null && (
        <p className="deals__notice" role="status" data-testid="deals-notice">
          {notice}
        </p>
      )}

      <div className="deals__body">
        <div className="deals__list" data-testid="deals-list">
          <div className="deals__list-head">
            <span data-testid="deals-total">Заказов: {total}</span>
            <Button
              onClick={() => selectAllMutation.mutate()}
              disabled={selectAllMutation.isPending}
              data-testid="deals-select-all"
            >
              Выбрать все
            </Button>
          </div>

          {items.length === 0 ? (
            <EmptyState title="На этот день заказов нет" />
          ) : (
            <ul className="deals__cards">
              {items.map((item) => {
                const blocked = unselectableReason(item);
                const number = selectionNumber(selected, item.id);
                return (
                  <li
                    key={item.id}
                    className={
                      number === null ? 'deals__card' : 'deals__card deals__card--selected'
                    }
                    data-testid="deal-card"
                    data-order-number={item.number}
                    data-selected={number === null ? 'no' : String(number)}
                    data-selectable={blocked === null ? 'yes' : 'no'}
                  >
                    <div className="deals__card-head">
                      <button
                        type="button"
                        className="deals__pick"
                        disabled={blocked !== null && number === null}
                        data-testid="deal-pick"
                        onClick={() => setSelected((current) => toggleSelection(current, item))}
                      >
                        {number ?? '+'}
                      </button>
                      <span className="deals__number">{item.number}</span>
                      {item.addressConflict && (
                        <StatusBadge tone="error">Конфликт адреса</StatusBadge>
                      )}
                      {item.addressCorrected && !item.addressConflict && (
                        <StatusBadge tone="info">Исправлено логистом</StatusBadge>
                      )}
                    </div>

                    <div className="deals__line">{item.address ?? 'Адрес не указан'}</div>
                    <div className="deals__muted">
                      {item.deliveryDate ?? '—'} · {formatMinutes(item.startMinute)}–
                      {formatMinutes(item.endMinute)}
                      {item.intervalCorrected ? ' · интервал задан вручную' : ''}
                    </div>
                    {item.recipient !== null && (
                      <div className="deals__muted">{item.recipient}</div>
                    )}

                    {/* Пустой комментарий не занимает места вовсе. */}
                    {item.comment !== null && (
                      <div className="deals__comment" data-testid="deal-comment">
                        <span className="deals__comment-label">Комментарий по доставке</span>
                        <p
                          className={
                            expanded === item.id ? 'deals__comment-full' : 'deals__comment-short'
                          }
                        >
                          {item.comment}
                        </p>
                        <button
                          type="button"
                          className="deals__link"
                          data-testid="deal-comment-toggle"
                          onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                        >
                          {expanded === item.id ? 'Свернуть' : 'Показать полностью'}
                        </button>
                      </div>
                    )}

                    {item.attentionReasons.length > 0 && (
                      <ul className="deals__attention" data-testid="deal-attention">
                        {item.attentionReasons.map((reason) => (
                          <li key={reason}>{attentionLabel(reason)}</li>
                        ))}
                      </ul>
                    )}

                    {blocked !== null && (
                      <p className="deals__blocked" data-testid="deal-blocked">
                        {UNSELECTABLE_LABELS[blocked]}
                        {item.draftRouteId !== null && (
                          <>
                            {' · '}
                            <button
                              type="button"
                              className="deals__link"
                              onClick={() =>
                                void navigate(`/logistics/routing?route=${item.draftRouteId}`)
                              }
                            >
                              {item.draftRouteNumber ?? 'Открыть черновик'}
                            </button>
                          </>
                        )}
                      </p>
                    )}

                    {/* Исходный интервал показывается рядом: правку принимают сравнением. */}
                    {item.intervalCorrected && (
                      <div className="deals__muted" data-testid="deal-source-interval">
                        В МоемСкладе: {item.sourceIntervalRaw ?? '—'}
                      </div>
                    )}

                    <div className="deals__actions">
                      <Button variant="ghost" onClick={() => setEditing(item)}>
                        Исправить адрес
                      </Button>
                      <Button
                        variant="ghost"
                        data-testid="deal-edit-interval"
                        onClick={() => {
                          setIntervalFor(item);
                          setIntervalFrom(minutesToText(item.startMinute));
                          setIntervalTo(minutesToText(item.endMinute));
                          setIntervalError(null);
                        }}
                      >
                        Задать интервал
                      </Button>
                    </div>

                    {intervalFor?.id === item.id && (
                      <div className="deals__interval-form" data-testid="deal-interval-form">
                        <Field label="С">
                          {(props) => (
                            <TextInput
                              {...props}
                              value={intervalFrom}
                              placeholder="10:00"
                              data-testid="deal-interval-from"
                              onChange={(event) => setIntervalFrom(event.target.value)}
                            />
                          )}
                        </Field>
                        <Field label="По">
                          {(props) => (
                            <TextInput
                              {...props}
                              value={intervalTo}
                              placeholder="14:00"
                              data-testid="deal-interval-to"
                              onChange={(event) => setIntervalTo(event.target.value)}
                            />
                          )}
                        </Field>
                        <Button
                          variant="primary"
                          data-testid="deal-interval-save"
                          disabled={saveInterval.isPending}
                          onClick={() => {
                            const problem = intervalProblem(intervalFrom, intervalTo);
                            if (problem !== null) {
                              setIntervalError(problem);
                              return;
                            }
                            saveInterval.mutate(item);
                          }}
                        >
                          Сохранить
                        </Button>
                        <Button variant="ghost" onClick={() => setIntervalFor(null)}>
                          Отмена
                        </Button>
                        {intervalError !== null && (
                          <p className="deals__blocked" data-testid="deal-interval-error">
                            {intervalError}
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {hasMore && (
            <Button onClick={() => setPages((value) => value + 1)} data-testid="deals-more">
              Загрузить ещё
            </Button>
          )}
        </div>

        <div className="deals__map">
          <DealsMap
            scopeKey={scopeKey}
            selected={selected}
            onToggle={(orderId) => {
              const order = items.find((item) => item.id === orderId);
              if (order !== undefined) {
                setSelected((current) => toggleSelection(current, order));
              }
            }}
          />
        </div>
      </div>

      {/*
        Закреплённая сводка показывает ВЕСЬ выбор, включая скрытые фильтром
        элементы: иначе заказ уехал бы в расчёт незаметно для человека.
      */}
      {selected.length > 0 && (
        <div className="deals__summary" data-testid="deals-summary">
          <span data-testid="deals-selected-count">Выбрано: {summary.total}</span>
          {summary.hiddenCount > 0 && (
            <span className="deals__muted" data-testid="deals-hidden-count">
              скрыто фильтром: {summary.hiddenCount}
            </span>
          )}
          <Button onClick={() => setSelected([])} data-testid="deals-clear">
            Очистить выбор
          </Button>
          <Button
            variant="primary"
            data-testid="deals-manual-draft"
            disabled={manualDraft.isPending}
            onClick={() => manualDraft.mutate()}
          >
            Создать маршрут вручную
          </Button>
          <Button
            data-testid="deals-auto-plan"
            disabled={autoPlan.isPending}
            onClick={() => autoPlan.mutate()}
          >
            Распределить автоматически
          </Button>
        </div>
      )}

      {editing !== null && (
        <AddressDialog
          order={editing}
          onClose={() => setEditing(null)}
          onChanged={() => {
            setEditing(null);
            void queryClient.invalidateQueries({ queryKey: ['deals'] });
          }}
        />
      )}
    </section>
  );
}
