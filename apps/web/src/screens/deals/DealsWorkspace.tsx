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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  StatusBadge,
  TextInput,
} from '../../ui/components';
import { attentionLabel, formatMinutes } from './deals';
import { DealsMap } from './DealsMap';
import { AddressDialog } from './AddressDialog';
import {
  capacityShortfall,
  firstDraftId,
  parseSplitParams,
  runAutoSplit,
  splitFailure,
  type PlanRunView,
  type SplitClient,
  type SplitClock,
  type SplitParams,
} from './auto-split';
import { useWorkspace } from '../logistics/useWorkspace';
import { GeoPointDialog } from '../logistics/GeoPointDialog';
import { workspaceHref } from '../logistics/workspace-url';
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

  // День общий с «Маршрутизацией» и живёт в адресе: два независимых значения
  // на одном рабочем месте расходились молча.
  const { day: date, setDay: setDate } = useWorkspace();
  const [search, setSearch] = useState('');
  const [fromTime, setFromTime] = useState('');
  const [toTime, setToTime] = useState('');
  const [includeDrafts, setIncludeDrafts] = useState(false);
  /** Накопленные страницы: список продолжается, а не перезагружается целиком. */
  const [pages, setPages] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<DealCard | null>(null);
  /** Заказ, которому ставят точку вручную. */
  const [pointFor, setPointFor] = useState<DealCard | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Заказ, у которого сейчас правят интервал, и черновик значений. */
  const [intervalFor, setIntervalFor] = useState<DealCard | null>(null);
  const [intervalFrom, setIntervalFrom] = useState('');
  const [intervalTo, setIntervalTo] = useState('');
  const [intervalError, setIntervalError] = useState<string | null>(null);
  /** Готовое превью, ожидающее согласия на неразмещённые заказы. */
  const [pendingSplit, setPendingSplit] = useState<{
    run: PlanRunView;
    unassignedCount: number;
  } | null>(null);
  /**
   * Параметры разбивки, которые логист вводит перед запуском.
   *
   * Пустые по умолчанию намеренно. Сохранённых значений в настройках
   * планирования нет — там живут только смена и время обслуживания, — а
   * подставить «сколько-нибудь» значило бы принять бизнес-решение за человека.
   */
  const [splitOpen, setSplitOpen] = useState(false);
  const [vehiclesInput, setVehiclesInput] = useState('');
  const [capacityInput, setCapacityInput] = useState('');
  const [splitErrors, setSplitErrors] = useState<{
    vehicles: string | null;
    capacityOrders: string | null;
  }>({ vehicles: null, capacityOrders: null });

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
      // Успех ведёт в созданный черновик, а не «куда-нибудь в маршрутизацию»:
      // «Маршрутизация» раскрывает именно его и на тот же день.
      void navigate(workspaceHref('/logistics/routing', { day: date, draftId: route.id }));
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

  /**
   * Обращения разбивки к серверу.
   *
   * Сам ход разбивки живёт в `auto-split.ts` и проверяется без браузера:
   * отказ решателя, ограниченное ожидание и согласие на частичный результат —
   * это правила, а не разметка. Здесь остаётся только связывание с клиентом.
   */
  const splitClient: SplitClient = useMemo(
    () => ({
      start: (body) => client.post<PlanRunView>('/api/route-plans', body),
      read: (runId) => client.get<PlanRunView>(`/api/route-plans/${runId}`),
      apply: (runId, body) => client.post<PlanRunView>(`/api/route-plans/${runId}/apply`, body),
    }),
    [client],
  );

  const splitClock: SplitClock = useMemo(
    () => ({
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
    }),
    [],
  );

  /**
   * Автоматическая разбивка выбора на несколько черновиков.
   *
   * Логист ждёт здесь и уходит в «Маршрутизацию» с готовыми черновиками:
   * технический запуск, очередь и превью в интерфейс не всплывают. Двухфазность
   * сохраняется на сервере, но стадией рабочего места она больше не является.
   *
   * Прежнее обращение шло на `/api/planning/runs` — такого адреса на сервере
   * нет — и слало `capacity` вместо `capacityOrders`. Оба отказа скрывал мок
   * браузерной проверки, поэтому кнопка не работала, а проверки были зелёными.
   */
  const finishApplied = useCallback(
    (run: PlanRunView): void => {
      setPendingSplit(null);
      setSelected([]);
      void queryClient.invalidateQueries({ queryKey: ['deals'] });

      const first = firstDraftId(run);
      if (first === null) {
        setNotice('Расчёт применён, но ни одного черновика не создано.');
        return;
      }
      // Раскрывается первый созданный черновик: логист попадает в работу,
      // а не в общий список, где свой результат пришлось бы искать.
      void navigate(workspaceHref('/logistics/routing', { day: date, draftId: first }));
    },
    [date, navigate, queryClient],
  );

  /**
   * Предупреждение о нехватке мест, пока логист ещё вводит параметры.
   *
   * Это не запрет: лишние заказы решатель отправит в неразмещённые, и согласие
   * на них спрашивается отдельно. Но сказать об этом до ожидания расчёта
   * честнее, чем после.
   */
  const splitPreview = useMemo(() => {
    const parsed = parseSplitParams({ vehicles: vehiclesInput, capacityOrders: capacityInput });
    return parsed.ok ? { shortfall: capacityShortfall(selected.length, parsed.value) } : null;
  }, [vehiclesInput, capacityInput, selected.length]);

  /**
   * Отказ разбивки.
   *
   * Правило целиком в `splitFailure`: выбор остаётся за логистом, перехода
   * в «Маршрутизацию» не происходит, ожидание снимается. Здесь только
   * применение готового решения — иначе каждую из этих частей легко нарушить
   * незаметно.
   */
  const splitFailed = useCallback((error: unknown): void => {
    const effect = splitFailure(error);
    setPendingSplit(null);
    setNotice(effect.message);
  }, []);

  const autoPlan = useMutation({
    mutationFn: (params: SplitParams) =>
      runAutoSplit(
        splitClient,
        // Ровно столько машин, сколько указал логист. Число не выводится
        // из размера выбора: это было бы решение, принятое за человека.
        { deliveryDate: date, orderIds: selected, params, vehicleType: 'CAR' },
        splitClock,
      ),
    onSuccess: (result) => {
      if (result.kind === 'CONSENT') {
        // Заказ, который никто не повезёт, логист обязан увидеть ДО создания
        // черновиков. Выбор при этом не сбрасывается: отказавшись, он остаётся
        // ровно с тем множеством, с которого начал.
        setPendingSplit({ run: result.run, unassignedCount: result.unassignedCount });
        return;
      }
      finishApplied(result.run);
    },
    onError: splitFailed,
  });

  /**
   * Применение уже посчитанного превью после согласия.
   *
   * Отдельная операция, а не повтор всей разбивки: расчёт уже выполнен, и
   * второй запуск того же дня упёрся бы в уникальный `activeDateKey` — день
   * занят собственным готовым превью.
   */
  const applyPending = useMutation({
    mutationFn: (run: PlanRunView) =>
      client.post<PlanRunView>(`/api/route-plans/${run.id}/apply`, {
        expectedVersion: run.version,
        allowUnassigned: true,
      }),
    onSuccess: finishApplied,
    onError: splitFailed,
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
                                void navigate(
                                  workspaceHref('/logistics/routing', {
                                    day: date,
                                    draftId: item.draftRouteId,
                                  }),
                                )
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
                      {/*
                        Точка и адрес — одна проблема одного заказа, поэтому
                        действия стоят рядом. Заказу с пригодной точкой кнопка
                        не нужна: он уже готов к распределению.
                      */}
                      {item.geoState !== 'RESOLVED' && (
                        <Button
                          variant="ghost"
                          data-testid="deal-set-point"
                          onClick={() => setPointFor(item)}
                        >
                          Указать точку на карте
                        </Button>
                      )}
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
            loading={autoPlan.isPending}
            disabled={autoPlan.isPending}
            onClick={() => {
              // Тот же единственный сценарий: кнопка спрашивает параметры
              // и запускает тот же расчёт. Второго входа в разбивку нет.
              setSplitErrors({ vehicles: null, capacityOrders: null });
              setSplitOpen(true);
            }}
          >
            {autoPlan.isPending ? 'Считаем маршруты…' : 'Распределить автоматически'}
          </Button>
        </div>
      )}

      {/*
        Параметры разбивки.

        Оба значения обязательны и вводятся логистом. Значения по умолчанию
        здесь нет: план, собранный из подставленного числа машин, выглядел бы
        как решение системы, которого никто не принимал.
      */}
      <Modal
        open={splitOpen}
        title="Автоматическая разбивка"
        onClose={() => setSplitOpen(false)}
        dismissible={!autoPlan.isPending}
      >
        <div className="stack">
          <p className="text-sm muted">
            Выбрано заказов: {selected.length}. Укажите, сколько машин выйдет на маршруты и сколько
            заказов помещается в одну.
          </p>

          <Field label="Количество машин" error={splitErrors.vehicles ?? undefined}>
            {(props) => (
              <TextInput
                {...props}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                data-testid="split-vehicles"
                value={vehiclesInput}
                disabled={autoPlan.isPending}
                onChange={(event) => setVehiclesInput(event.target.value)}
              />
            )}
          </Field>

          <Field label="Заказов на одну машину" error={splitErrors.capacityOrders ?? undefined}>
            {(props) => (
              <TextInput
                {...props}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                data-testid="split-capacity"
                value={capacityInput}
                disabled={autoPlan.isPending}
                onChange={(event) => setCapacityInput(event.target.value)}
              />
            )}
          </Field>

          {splitPreview !== null && splitPreview.shortfall > 0 && (
            <p className="text-sm" data-testid="split-shortfall">
              Мест хватит не всем: {splitPreview.shortfall} заказ(ов) останутся неразмещёнными.
              Согласие на них будет запрошено отдельно.
            </p>
          )}

          <div className="modal__footer">
            <Button onClick={() => setSplitOpen(false)} disabled={autoPlan.isPending}>
              Отмена
            </Button>
            <Button
              variant="primary"
              data-testid="split-submit"
              disabled={autoPlan.isPending}
              onClick={() => {
                const parsed = parseSplitParams({
                  vehicles: vehiclesInput,
                  capacityOrders: capacityInput,
                });
                if (!parsed.ok) {
                  setSplitErrors({
                    vehicles: parsed.vehicles,
                    capacityOrders: parsed.capacityOrders,
                  });
                  return;
                }
                setSplitErrors({ vehicles: null, capacityOrders: null });
                setSplitOpen(false);
                autoPlan.mutate(parsed.value);
              }}
            >
              Рассчитать
            </Button>
          </div>
        </div>
      </Modal>

      {/*
        Согласие на неразмещённые заказы.

        Спрашивается ДО создания черновиков: заказ, который никто не повезёт,
        не должен уехать в работу молча. Отказ оставляет выбор нетронутым —
        логист меняет состав или число машин и повторяет.
      */}
      <ConfirmDialog
        open={pendingSplit !== null}
        title="Часть заказов не размещена"
        description={
          `Решатель не смог разместить заказов: ${pendingSplit?.unassignedCount ?? 0}. ` +
          'Их никто не повезёт — они останутся нераспределёнными и будут видны ' +
          'в «Маршрутизации». Создать черновики для остальных?'
        }
        confirmLabel="Создать черновики"
        busy={applyPending.isPending}
        onConfirm={() => {
          if (pendingSplit !== null) {
            applyPending.mutate(pendingSplit.run);
          }
        }}
        onCancel={() => setPendingSplit(null)}
      />

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

      {/*
        Отмена ничего не записывает: окно просто закрывается, и заказ остаётся
        в «Требует внимания» ровно в прежнем состоянии.
      */}
      {pointFor !== null && (
        <GeoPointDialog
          order={{
            id: pointFor.id,
            number: pointFor.number,
            version: pointFor.version,
            address: pointFor.address,
          }}
          onClose={() => setPointFor(null)}
          onSaved={() => setPointFor(null)}
        />
      )}
    </section>
  );
}
