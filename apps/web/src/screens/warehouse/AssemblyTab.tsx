/**
 * Раздел «Сборка»: маршрутные листы, которым нужна складская работа.
 *
 * Порядок листов, разделение на активные и собранные и стадия каждого
 * заказа приходят с сервера готовыми. Считать это на клиенте нельзя:
 * страница загружает часть набора, и «самый ранний лист» оказался бы самым
 * ранним из загруженного, а не из существующего.
 *
 * Все карточки свёрнуты по умолчанию. Развёрнутый список из пятнадцати
 * заказов на телефоне прячет соседние листы, а кладовщику нужен именно
 * выбор листа, а не чтение одного.
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
  CELL_KIND_LABELS,
  STAGE_LABELS,
  STAGE_TONES,
  issueCellLabel,
  type AssemblyBoard,
  type AssemblyRouteView,
} from './warehouse-flow';
import './warehouse.css';

interface Props {
  /** Разрешён ли ручной ввод. Решение администратора, не экрана. */
  manualEntry: boolean;
}

const BOARD_KEY = ['warehouse-assembly'];

export function AssemblyTab({ manualEntry }: Props): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [openRouteId, setOpenRouteId] = useState<string | null>(null);
  const [assembledOpen, setAssembledOpen] = useState(false);
  // Очередь готовой работы открыта сразу; собранные листы — нет, их только
  // сверяют. Разное значение по умолчанию здесь и есть смысл групп.
  const [relocatableOpen, setRelocatableOpen] = useState(true);
  // Листы, которым чего-то не хватает, тоже открыты: это основная работа дня.
  const [activeOpen, setActiveOpen] = useState(true);
  /** Лист, для которого открыто окно последовательной проверки. */
  const [checkingRouteId, setCheckingRouteId] = useState<string | null>(null);
  /** Что сейчас сканируется: быстрый заказ или дополнительная ячейка листа. */
  const [scanning, setScanning] = useState<
    { kind: 'quick' } | { kind: 'cell'; routeId: string; routeNumber: string } | null
  >(null);

  const board = useQuery({
    queryKey: BOARD_KEY,
    queryFn: () => client.get<AssemblyBoard>('/api/warehouse/assembly'),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: BOARD_KEY });
    await queryClient.invalidateQueries({ queryKey: ['warehouse-placements'] });
  };

  const bindCell = useMutation({
    mutationFn: (input: { routeId: string; cellCode: string }) =>
      client.put<{ cellCode: string; unchanged: boolean }>(
        `/api/warehouse/routes/${input.routeId}/cell`,
        { cellCode: input.cellCode },
      ),
    onSuccess: async (result) => {
      await refresh();
      showToast(
        result.unchanged
          ? `Ячейка ${result.cellCode} уже назначена листу`
          : `Ячейка ${result.cellCode} назначена листу`,
        'success',
      );
    },
  });

  if (board.isPending) {
    return <LoadingState title="Загружаем маршрутные листы…" />;
  }
  if (board.isError) {
    return <ErrorState title="Не удалось загрузить листы" onRetry={() => void board.refetch()} />;
  }

  const { active, relocatable, assembled } = board.data;

  return (
    <>
      {/* Быстрый скан: тот же путь, что и в «Складе», без вопроса «куда». */}
      <div className="card wh-scan">
        <Button
          variant="primary"
          className="wh-scan__button"
          data-testid="assembly-scan"
          onClick={() => setScanning({ kind: 'quick' })}
        >
          Сканировать заказ
        </Button>
      </div>

      {active.length === 0 && relocatable.length === 0 && assembled.length === 0 && (
        <EmptyState
          title="Листов для сборки нет"
          description="Подтверждённые маршрутные листы появятся здесь автоматически."
        />
      )}

      {/*
        Три группы в одном порядке и с одинаковым устройством.

        Сверху — «Можно переносить»: в таких листах ничего не ждут, все коробки
        уже на складе, и остаётся отнести их на маршрутную полку. Это очередь
        готовой работы, поэтому она раскрыта. Ниже — листы, которым чего-то не
        хватает, и в самом низу собранные: их только сверяют.
      */}
      <RouteGroup
        id="relocatable"
        title="Можно переносить"
        tone="ready"
        routes={relocatable}
        open={relocatableOpen}
        onToggle={() => setRelocatableOpen((open) => !open)}
        openRouteId={openRouteId}
        onToggleRoute={setOpenRouteId}
        onCheck={setCheckingRouteId}
        onAddCell={setScanning}
      />

      <RouteGroup
        id="active"
        title="Не всё собрано"
        tone="waiting"
        routes={active}
        open={activeOpen}
        onToggle={() => setActiveOpen((open) => !open)}
        openRouteId={openRouteId}
        onToggleRoute={setOpenRouteId}
        onCheck={setCheckingRouteId}
        onAddCell={setScanning}
      />

      <RouteGroup
        id="assembled"
        title="Собранные"
        tone="done"
        routes={assembled}
        open={assembledOpen}
        onToggle={() => setAssembledOpen((open) => !open)}
        openRouteId={openRouteId}
        onToggleRoute={setOpenRouteId}
        onCheck={setCheckingRouteId}
        onAddCell={setScanning}
      />

      {checkingRouteId !== null && (
        <RouteCheckDialog
          routeId={checkingRouteId}
          manualEntry={manualEntry}
          onClose={() => {
            setCheckingRouteId(null);
            void refresh();
          }}
        />
      )}

      {scanning?.kind === 'quick' && (
        <ScannerScreen
          resultWindow
          chain="PICK"
          operation="Сборка"
          onIntent={quickPickHandler(client, refresh)}
          onClose={() => {
            setScanning(null);
            void refresh();
          }}
        />
      )}

      {scanning?.kind === 'cell' && (
        <ScannerScreen
          resultWindow
          chain="CELL_ONLY"
          operation={`Лист ${scanning.routeNumber}`}
          onIntent={async (intent: ScanIntent): Promise<ScanEvent> => {
            if (intent.kind !== 'submitCell') {
              return { type: 'frameEmpty' };
            }
            try {
              const result = await bindCell.mutateAsync({
                routeId: scanning.routeId,
                cellCode: intent.cellCode,
              });
              return {
                type: 'succeeded',
                text: `Ячейка ${result.cellCode} назначена листу`,
                final: true,
              };
            } catch (error: unknown) {
              return {
                type: 'failed',
                text: error instanceof ApiError ? error.message : 'Не удалось назначить ячейку.',
              };
            }
          }}
          onClose={() => {
            setScanning(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}

/**
 * Свёрнутая карточка листа.
 *
 * Нажатие на НОМЕР открывает окно последовательной проверки, стрелка —
 * раскрывает состав. Разные действия у разных мест намеренно: иначе
 * попытка посмотреть состав каждый раз запускала бы проверку.
 */
/** `2026-08-17` → `17.08`: в таблетке нужен день, а не машинный формат. */
function routeDay(date: string): string {
  const parts = date.split('-');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}` : date;
}

/** Цвет точки группы: он же и есть её смысл. */
type GroupTone = 'ready' | 'waiting' | 'done';

/**
 * Группа маршрутных листов на доске сборки.
 *
 * Три группы устроены одинаково и различаются только заголовком, цветом
 * точки и тем, раскрыты ли по умолчанию. Пока каждая была написана отдельно,
 * правка одной молча расходилась с двумя другими.
 *
 * Пустая группа не показывается: заголовок с нулём занимает строку и обещает
 * работу, которой нет.
 */
function RouteGroup({
  id,
  title,
  tone,
  routes,
  open,
  onToggle,
  openRouteId,
  onToggleRoute,
  onCheck,
  onAddCell,
}: {
  id: string;
  title: string;
  tone: GroupTone;
  routes: AssemblyRouteView[];
  open: boolean;
  onToggle: () => void;
  openRouteId: string | null;
  onToggleRoute: (routeId: string | null) => void;
  onCheck: (routeId: string) => void;
  onAddCell: (input: { kind: 'cell'; routeId: string; routeNumber: string }) => void;
}): React.JSX.Element | null {
  if (routes.length === 0) {
    return null;
  }

  return (
    /* Утопленная панель: заголовок и приподнятые листы внутри неё. */
    <div className="wh-group" data-testid={`assembly-${id}`}>
      <button
        type="button"
        className="wh-group__toggle"
        aria-expanded={open}
        data-testid={`assembly-${id}-toggle`}
        onClick={onToggle}
      >
        <span className={`wh-group__dot wh-group__dot--${tone}`} aria-hidden="true" />
        <span className="wh-group__title">{title}</span>
        <span
          className="wh-group__count wh-group__count--sunken"
          data-testid={`assembly-${id}-count`}
        >
          {routes.length}
        </span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        /* Список лежит в углублении, как таблицы на вкладке «Склад». */
        <div className="wh-well">
          {routes.map((route) => (
            <RouteCard
              key={route.routeId}
              route={route}
              tone={tone}
              expanded={route.routeId === openRouteId}
              onToggle={() => onToggleRoute(route.routeId === openRouteId ? null : route.routeId)}
              onCheck={() => onCheck(route.routeId)}
              onAddCell={() =>
                onAddCell({ kind: 'cell', routeId: route.routeId, routeNumber: route.routeNumber })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RouteCard({
  route,
  tone,
  expanded,
  onToggle,
  onCheck,
  onAddCell,
}: {
  route: AssemblyBoard['active'][number];
  tone: GroupTone;
  expanded: boolean;
  onToggle: () => void;
  onCheck: () => void;
  onAddCell: () => void;
}): React.JSX.Element {
  return (
    <article
      className="card wh-route"
      data-testid="assembly-route"
      data-tone={tone}
      data-route-number={route.routeNumber}
      data-expanded={expanded ? 'true' : 'false'}
    >
      {/*
        Шапка раскрывает карточку целиком — как и в «Выдаче».

        Стрелка остаётся указателем состояния: целиться в неё пальцем неудобно,
        а свободного места в шапке много. Номер листа и «+ Ячейка» — свои
        действия, и раскрытие они не переключают.
      */}
      <header
        className="wh-route__head wh-route__head--clickable"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        data-testid="assembly-route-head"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <button
          type="button"
          className="wh-route__number"
          data-testid="assembly-route-number"
          onClick={(event) => {
            event.stopPropagation();
            onCheck();
          }}
        >
          {route.routeNumber}
        </button>

        {/*
          День и время листа — таблеткой справа сверху: в номере стоит дата
          постановки, а работать кладовщику по дню доставки.
        */}
        <span className="wh-route__date" data-testid="assembly-route-date">
          {routeDay(route.deliveryDate)}
          {route.earliestMinute === null ? '' : ` · ${minutes(route.earliestMinute)}`}
        </span>

        {/* Сколько заказов в листе и сколько из них готово. */}
        <span className="wh-route__counts" data-testid="assembly-route-counts">
          {route.total} ({route.ready} из {route.total})
        </span>

        {/* Полки листа — справа снизу, на месте номера ячейки у заказа. */}
        <span className="wh-route__cells" data-testid="assembly-route-cells">
          {route.cells.length === 0 ? (
            <span className="wh-route__cells-none">без ячейки</span>
          ) : (
            route.cells.map((cell) => (
              <span key={cell.id} className="wh-route__cell">
                {cell.code}
              </span>
            ))
          )}
        </span>
      </header>

      {expanded && (
        /*
          «+ Ячейка» живёт в раскрытой карточке: свёрнутая остаётся ровно двумя
          строками, как в макете, и кнопка не отнимает у них место.
        */
        <Button
          variant="ghost"
          className="wh-route__add-cell"
          data-testid="assembly-add-cell"
          onClick={(event) => {
            event.stopPropagation();
            onAddCell();
          }}
        >
          + Ячейка
        </Button>
      )}
      {expanded && (
        <ul className="wh-route__orders">
          {route.orders.map((order) => (
            <li
              key={order.orderId}
              className="wh-route__order"
              data-order-number={order.orderNumber}
              data-stage={order.stage}
            >
              <span className="wh-route__position">{order.position}</span>
              <span className="wh-route__order-number">{order.orderNumber}</span>
              <span className="muted text-sm">
                {order.startMinute === null || order.endMinute === null
                  ? 'время не задано'
                  : `${minutes(order.startMinute)}–${minutes(order.endMinute)}`}
              </span>
              {/*
                Ячейка вплотную к статусу и в скобках — тот же вид, что
                в «Выдаче»: вместе они отвечают, где коробка и что с ней.
              */}
              {/*
                Вид полки и её номер стоят раздельно: слева внизу «Хранение»
                или «Маршрутная», справа — сам номер, как в макете.
              */}
              <span className="wh-route__note" data-testid="assembly-order-note">
                {order.cellKind === null ? 'Не собран' : CELL_KIND_LABELS[order.cellKind]}
              </span>
              <span
                className={
                  order.cellCode === null
                    ? 'wh-route__cellnum wh-route__cellnum--none'
                    : 'wh-route__cellnum'
                }
                data-testid="assembly-order-cell"
              >
                {order.cellCode ?? 'без ячейки'}
              </span>
              <span className="wh-route__badges">
                <StatusBadge tone={STAGE_TONES[order.stage]}>
                  {STAGE_LABELS[order.stage]}
                </StatusBadge>
                {/*
                  Отдельной пометки «требуется перемещение» больше нет: про
                  коробку в хранении уже сказали и ячейка, и стадия, а третья
                  подпись о том же занимала строку и спорила с ними за взгляд.
                */}
                {order.cancelled && <StatusBadge tone="error">Отменён — не выдавать</StatusBadge>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/**
 * Окно последовательной проверки листа.
 *
 * Прогресс не хранится в окне: «проверено» — это заказы, которые физически
 * стоят в маршрутных ячейках листа. Поэтому он общий для всех кладовщиков,
 * переживает закрытие окна и не может быть увеличен дважды одним заказом.
 */
function RouteCheckDialog({
  routeId,
  manualEntry,
  onClose,
}: {
  routeId: string;
  manualEntry: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState({ order: '', cell: '' });

  const board = useQuery({
    queryKey: BOARD_KEY,
    queryFn: () => client.get<AssemblyBoard>('/api/warehouse/assembly'),
  });

  /*
   * Лист ищется во ВСЕХ группах доски.
   *
   * Групп три, и перечислять их по памяти опасно: стоит появиться новой,
   * как окно проверки молча перестаёт находить лист и открывается пустым.
   * Поэтому список собирается из всех значений ответа, а не из выбранных
   * вручную полей.
   */
  const route =
    board.data === undefined
      ? null
      : ((Object.values(board.data) as AssemblyRouteView[][])
          .flat()
          .find((item) => item.routeId === routeId) ?? null);

  const pick = useMutation({
    mutationFn: (input: { orderNumber: string; cellCode: string }) =>
      client.post<{ orderNumber: string; cellCode: string; picked: number; total: number }>(
        `/api/warehouse/routes/${routeId}/pick`,
        { ...input, bindIfFree: true },
      ),
    onSuccess: async (result) => {
      setManual({ order: '', cell: '' });
      await queryClient.invalidateQueries({ queryKey: BOARD_KEY });
      showToast(
        `Заказ ${result.orderNumber} в ячейке ${result.cellCode}: ${result.picked} из ${result.total}`,
        'success',
      );
    },
    onError: (error: unknown) =>
      showToast(error instanceof ApiError ? error.message : 'Не удалось внести заказ.', 'error'),
  });

  if (route === null) {
    return <LoadingState title="Загружаем лист…" />;
  }

  const checked = route.ready;
  const allChecked = route.total > 0 && checked >= route.total;

  return (
    <div className="scanner-backdrop" role="presentation" onClick={onClose}>
      <section
        className="wh-check"
        role="dialog"
        aria-modal="true"
        aria-label={`Проверка листа ${route.routeNumber}`}
        data-testid="assembly-check"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="wh-check__head">
          <strong>{route.routeNumber}</strong>
          <button
            type="button"
            className="scanner__close"
            aria-label="Закрыть проверку"
            data-testid="assembly-check-close"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <p className="wh-check__progress" data-testid="assembly-check-progress">
          Проверено: {checked} из {route.total}
        </p>
        {/* Полная полоса зеленеет: «проверено всё» видно раньше, чем прочитано. */}
        <div
          className={allChecked ? 'wh-check__bar wh-check__bar--done' : 'wh-check__bar'}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={route.total}
          aria-valuenow={checked}
        >
          <span style={{ width: `${route.total === 0 ? 0 : (checked / route.total) * 100}%` }} />
        </div>

        {/*
          Все коробки на своих полках — сканировать нечего, и кнопка гаснет.
          Живая кнопка здесь предлагала бы работу, которой не осталось.
        */}
        <Button
          variant="primary"
          className="wh-scan__button"
          data-testid="assembly-check-scan"
          disabled={allChecked}
          onClick={() => setScanning(true)}
        >
          Сканировать заказ
        </Button>

        {manualEntry && (
          <form
            className="stack"
            data-testid="assembly-check-manual"
            onSubmit={(event) => {
              event.preventDefault();
              if (manual.order.trim() !== '' && manual.cell.trim() !== '') {
                pick.mutate({ orderNumber: manual.order, cellCode: manual.cell });
              }
            }}
          >
            <input
              className="input"
              placeholder="Номер заказа"
              aria-label="Номер заказа"
              data-testid="assembly-check-manual-order"
              value={manual.order}
              onChange={(event) =>
                setManual((current) => ({ ...current, order: event.target.value }))
              }
            />
            <input
              className="input"
              placeholder="Код ячейки"
              aria-label="Код ячейки"
              data-testid="assembly-check-manual-cell"
              value={manual.cell}
              onChange={(event) =>
                setManual((current) => ({ ...current, cell: event.target.value }))
              }
            />
            <Button type="submit" disabled={pick.isPending}>
              Внести
            </Button>
          </form>
        )}

        <ul className="wh-check__list">
          {route.orders.map((order) => (
            <li
              key={order.orderId}
              className="wh-check__item"
              data-order-number={order.orderNumber}
              data-checked={order.stage === 'READY' ? 'yes' : 'no'}
            >
              <span className="wh-route__position">{order.position}</span>
              <span className="wh-route__order-number">{order.orderNumber}</span>
              <span className="wh-route__cell-note" data-testid="assembly-check-cell">
                {issueCellLabel(order)}
              </span>
              <StatusBadge tone={order.stage === 'READY' ? 'success' : 'neutral'}>
                {order.stage === 'READY' ? 'Проверен' : 'Ожидает'}
              </StatusBadge>
            </li>
          ))}
        </ul>

        {/*
          «Готово» закрывает окно и ничего не объявляет собранным.
          Лист считается собранным только по факту: все действующие заказы
          стоят в его маршрутных ячейках.
        */}
        <Button className="scanner__cancel" data-testid="assembly-check-done" onClick={onClose}>
          Готово ({checked} проверено)
        </Button>

        {scanning && (
          <ScannerScreen
            resultWindow
            chain="PICK"
            operation={`Лист ${route.routeNumber}`}
            expectedCell={route.cells[0]?.code ?? null}
            onIntent={routePickHandler(client, routeId, async () => {
              await queryClient.invalidateQueries({ queryKey: BOARD_KEY });
            })}
            onClose={() => setScanning(false)}
          />
        )}
      </section>
    </div>
  );
}

/** Минуты от полуночи в привычное время. */
function minutes(value: number): string {
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * Быстрый скан «Сборки»: сервер сам находит лист заказа.
 *
 * Вопрос «в сборку или в хранение» здесь не задаётся: на него уже ответил
 * раздел, в котором стоит человек.
 */
function quickPickHandler(
  client: ReturnType<typeof useAuth>['client'],
  refresh: () => Promise<void>,
): (intent: ScanIntent) => Promise<ScanEvent> {
  let routeId: string | null = null;

  return async (intent) => {
    if (intent.kind === 'resolveOrder') {
      try {
        const context = await client.get<{
          orderNumber: string;
          route: { id: string; number: string; routeCells: { code: string }[] } | null;
        }>(`/api/warehouse/scan/order?number=${encodeURIComponent(intent.code)}`);

        if (context.route === null) {
          return {
            type: 'failed',
            text: 'Заказ не входит ни в один подтверждённый маршрутный лист.',
          };
        }
        routeId = context.route.id;
        return { type: 'orderResolved', orderNumber: context.orderNumber };
      } catch (error: unknown) {
        return {
          type: 'failed',
          text: error instanceof ApiError ? error.message : 'Заказ не распознан.',
        };
      }
    }

    if (intent.kind === 'submitPair' && routeId !== null) {
      try {
        const result = await client.post<{ orderNumber: string; cellCode: string }>(
          `/api/warehouse/routes/${routeId}/pick`,
          { orderNumber: intent.orderNumber, cellCode: intent.cellCode, bindIfFree: true },
        );
        await refresh();
        return {
          type: 'succeeded',
          text: `Заказ ${result.orderNumber} перемещён в ячейку ${result.cellCode}`,
          final: false,
        };
      } catch (error: unknown) {
        return {
          type: 'failed',
          text: error instanceof ApiError ? error.message : 'Не удалось переместить заказ.',
        };
      }
    }

    return { type: 'frameEmpty' };
  };
}

/** Проверка конкретного листа: заказ и ячейка уходят парой. */
function routePickHandler(
  client: ReturnType<typeof useAuth>['client'],
  routeId: string,
  refresh: () => Promise<void>,
): (intent: ScanIntent) => Promise<ScanEvent> {
  return async (intent) => {
    if (intent.kind === 'resolveOrder') {
      try {
        const context = await client.get<{ orderNumber: string }>(
          `/api/warehouse/scan/order?number=${encodeURIComponent(intent.code)}`,
        );
        return { type: 'orderResolved', orderNumber: context.orderNumber };
      } catch (error: unknown) {
        return {
          type: 'failed',
          text: error instanceof ApiError ? error.message : 'Заказ не распознан.',
        };
      }
    }

    if (intent.kind === 'submitPair') {
      try {
        const result = await client.post<{
          orderNumber: string;
          cellCode: string;
          picked: number;
          total: number;
        }>(`/api/warehouse/routes/${routeId}/pick`, {
          orderNumber: intent.orderNumber,
          cellCode: intent.cellCode,
          bindIfFree: true,
        });
        await refresh();
        return {
          type: 'succeeded',
          text: `Заказ ${result.orderNumber} в ячейке ${result.cellCode}: ${result.picked} из ${result.total}`,
          progress: { done: result.picked, total: result.total },
          /*
           * Заказ перенесён — окно сканирования закрывается.
           *
           * Список с прогрессом остаётся под ним и виден сразу: он не
           * размонтируется, поэтому прокрутка сохраняется. Следующий заказ
           * сканируется новым нажатием «Сканировать заказ».
           */
          final: true,
        };
      } catch (error: unknown) {
        return {
          type: 'failed',
          text: error instanceof ApiError ? error.message : 'Не удалось внести заказ.',
        };
      }
    }

    return { type: 'frameEmpty' };
  };
}
