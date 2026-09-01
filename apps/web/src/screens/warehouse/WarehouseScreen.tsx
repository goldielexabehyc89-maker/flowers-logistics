/**
 * Рабочий экран склада: «Склад», «Сборка», «Выдача».
 *
 * Интерфейс рассчитан на сканер, который работает как клавиатура: поле ввода
 * само получает фокус и очищается после успешного шага, а `Enter` подтверждает
 * значение. Ручной ввод остаётся доступным везде — сканер ломается чаще, чем
 * заканчивается рабочий день.
 *
 * Ошибка не теряет уже подтверждённый прогресс: неудачный второй скан
 * возвращает к сканированию ячейки, а не сбрасывает заказ.
 *
 * Ни адреса, ни получателя, ни состава заказа здесь нет — сервер их не отдаёт.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
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
  StatusBadge,
  TextInput,
} from '../../ui/components';
import { ScannerScreen } from '../../scan/ScannerScreen';
import { routeCellHint } from '../../scan/scan-machine';
import { AssemblyTab } from './AssemblyTab';
import { AwaitingTab } from './AwaitingTab';
import { IssueTab } from './IssueTab';
import { createReceiveIntent } from './receive-intent';
import type { Role } from '@fl/shared';
import type { ScanEvent, ScanIntent } from '../../scan/scan-machine';
import {
  CELL_KIND_LABELS,
  SCAN_HINTS,
  blockLabel,
  cellLabel,
  groupPlacements,
  mergePlacementPages,
  nextPlacementOffset,
  type PlacedOrderView,
  type PlacementGroupTotals,
  type ScanContext,
} from './warehouse-flow';

/**
 * Размер страницы складского списка.
 *
 * Совпадает с прежним единственным запросом: разница не в размере страницы,
 * а в том, что за первой страницей теперь идут следующие.
 */
const PLACEMENTS_PAGE_SIZE = 100;

interface PlacementsPage {
  items: PlacedOrderView[];
  total: number;
  limit: number;
  offset: number;
  groupTotals: PlacementGroupTotals;
}

type Tab = 'storage' | 'awaiting' | 'picking' | 'issue' | 'returns';

/**
 * Вкладки склада и роли, которым каждая видна.
 *
 * «Ожидают приёмки» видит и менеджер выдачи (`MANAGER`) — ему нужно знать, что
 * собрано и ждёт полки. Остальные вкладки — рабочие места кладовщика, поэтому
 * менеджеру не показываются. Право на API всё равно проверяет сервер.
 */
const TABS: readonly { key: Tab; title: string; roles: readonly Role[] }[] = [
  { key: 'storage', title: 'Склад', roles: ['ADMIN', 'WAREHOUSE', 'SUPERVISOR'] },
  {
    key: 'awaiting',
    title: 'Ожидают приёмки',
    roles: ['ADMIN', 'WAREHOUSE', 'SUPERVISOR', 'MANAGER'],
  },
  { key: 'picking', title: 'Сборка', roles: ['ADMIN', 'WAREHOUSE', 'SUPERVISOR'] },
  { key: 'issue', title: 'Выдача', roles: ['ADMIN', 'WAREHOUSE', 'SUPERVISOR'] },
  { key: 'returns', title: 'Возвраты', roles: ['ADMIN', 'WAREHOUSE', 'SUPERVISOR'] },
];

/** Что сейчас с букетом, который не доставили. */
const RETURN_STATE_LABELS: Readonly<Record<string, string>> = {
  WITH_COURIER: 'У курьера',
  RETURNING: 'Возвращается на склад',
  ACCEPTED: 'Принят складом',
  CANCELLED: 'Отменён',
};

interface WarehouseReturnView {
  orderId: string;
  orderNumber: string;
  displayNumber: string;
  state: keyof typeof RETURN_STATE_LABELS;
  courier: string | null;
  reasonName: string;
  decision: 'CANCELLED' | 'REDELIVER' | null;
  cancelled: boolean;
  cellCode: string | null;
  acceptedAt: string | null;
}

export function WarehouseScreen(): React.JSX.Element {
  const { client, user } = useAuth();

  // Вкладки фильтруются по роли на клиенте, но это лишь удобство: каждый
  // складской API сервер закрывает своей проверкой ролей отдельно.
  const roles = user?.roles ?? [];
  const visibleTabs = TABS.filter((item) => item.roles.some((role) => roles.includes(role)));
  const [tab, setTab] = useState<Tab>(() => visibleTabs[0]?.key ?? 'awaiting');

  /*
   * Ручной ввод разрешает администратор, а не экран.
   *
   * Значение приходит с сервера и обновляется вместе с остальными
   * запросами: перезапуск приложения для смены настройки не нужен.
   */
  const settings = useQuery({
    queryKey: ['warehouse-settings'],
    queryFn: () => client.get<{ manualEntry: boolean }>('/api/warehouse/settings'),
  });
  const manualEntry = settings.data?.manualEntry ?? false;

  /*
   * Счётчик вкладки «Ожидают приёмки».
   *
   * Полное число по всему отбору, а не по загруженной странице и не по строке
   * поиска: запрос идёт с `countOnly` и без поиска, поэтому счётчик не зависит
   * от того, что набрал кладовщик в поиске. Ключ начинается с
   * `warehouse-awaiting`, и те же складские и производственные события, что
   * обновляют список, обновляют и его — сборка добавляет, приёмка, возврат,
   * отмена и списание убавляют, всё без перезагрузки. Список и счётчик считает
   * одно бизнес-условие на сервере, поэтому они не расходятся.
   */
  const awaitingVisible = visibleTabs.some((item) => item.key === 'awaiting');
  const awaitingCount = useQuery({
    queryKey: ['warehouse-awaiting', 'count'],
    queryFn: () => client.get<{ fullTotal: number }>('/api/warehouse/awaiting?countOnly=1'),
    enabled: awaitingVisible,
  });
  const awaitingBadge = awaitingCount.data?.fullTotal ?? null;

  return (
    <section className="stack warehouse" data-testid="warehouse-screen">
      {/*
        Повторного заголовка и описания здесь нет намеренно.
        Раздел уже назван системной шапкой, а объяснение приёмки,
        комплектования и выдачи занимало треть экрана телефона у человека,
        который приходит сюда работать, а не читать.
      */}
      <nav className="wh-tabs" aria-label="Разделы склада" data-testid="wh-tabs">
        {visibleTabs.map((item) => (
          <button
            key={item.key}
            type="button"
            className={item.key === tab ? 'wh-tabs__item wh-tabs__item--active' : 'wh-tabs__item'}
            aria-current={item.key === tab ? 'page' : undefined}
            data-testid={`wh-tab-${item.key}`}
            onClick={() => setTab(item.key)}
          >
            {item.title}
            {item.key === 'awaiting' && awaitingBadge !== null && awaitingBadge > 0 && (
              <span className="wh-tabs__badge" data-testid="wh-tab-awaiting-count">
                {awaitingBadge}
              </span>
            )}
          </button>
        ))}
      </nav>

      {tab === 'storage' && <StorageTab manualEntry={manualEntry} />}
      {tab === 'awaiting' && <AwaitingTab manualEntry={manualEntry} />}
      {tab === 'picking' && <AssemblyTab manualEntry={manualEntry} />}
      {tab === 'issue' && <IssueTab manualEntry={manualEntry} />}
      {tab === 'returns' && <ReturnsTab manualEntry={manualEntry} />}
    </section>
  );
}

/**
 * Режим «Возвраты»: приёмка недоставленного букета обратно на склад.
 *
 * Отдельно от обычной приёмки намеренно. Обычная приёмка принимает СОБРАННЫЙ
 * заказ от флориста, а здесь физически возвращается тот, что уже уезжал:
 * пока склад его не принял, он числится в машине курьера, и логист не может
 * ни отправить его повторно, ни считать вопрос закрытым.
 *
 * Пара «заказ + ячейка» уходит одним запросом: приёмки без ячейки не бывает.
 */
function ReturnsTab({ manualEntry }: ManualEntryProps): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const reportError = useApiError();

  const [orderInput, setOrderInput] = useState('');
  const [cellInput, setCellInput] = useState('');
  const [scannedOrder, setScannedOrder] = useState<string | null>(null);
  /** Открыто ли окно сканирования возврата. */
  const [scanning, setScanning] = useState(false);
  // Обе группы открыты: возвратов за смену немного, и прятать их незачем.
  const [pendingOpen, setPendingOpen] = useState(true);
  const [acceptedOpen, setAcceptedOpen] = useState(true);

  const returns = useQuery({
    queryKey: ['warehouse-returns'],
    queryFn: () =>
      client.get<{ pending: WarehouseReturnView[]; accepted: WarehouseReturnView[] }>(
        '/api/warehouse/returns',
      ),
  });

  const accept = useMutation({
    mutationFn: (input: { orderNumber: string; cellCode: string }) =>
      client.post<{
        orderNumber: string;
        cellCode: string;
        cancelled: boolean;
        unchanged: boolean;
      }>('/api/warehouse/returns/accept', input),
    onSuccess: async (result) => {
      setScannedOrder(null);
      setCellInput('');
      setOrderInput('');
      await queryClient.invalidateQueries({ queryKey: ['warehouse-returns'] });
      await queryClient.invalidateQueries({ queryKey: ['warehouse-placements'] });
      showToast(
        result.unchanged
          ? `Возврат ${result.orderNumber} уже принят в ячейку ${result.cellCode}`
          : `Возврат ${result.orderNumber} принят в ячейку ${result.cellCode}`,
        'success',
      );
      if (result.cancelled) {
        // Отменённый заказ выдавать нельзя, и узнать об этом надо сразу.
        showToast(`Заказ ${result.orderNumber} отменён — не выдавать`, 'error');
      }
    },
    onError: (error: unknown) => {
      // Заказ остаётся подтверждённым: повторяется только скан ячейки.
      setCellInput('');
      reportError(error, 'Не удалось принять возврат.');
    },
  });

  if (scanning) {
    return (
      <ScannerScreen
        resultWindow
        chain="RECEIVE"
        operation="Приёмка возврата"
        onIntent={returnIntentHandler(client, async () => {
          await queryClient.invalidateQueries({ queryKey: ['warehouse-returns'] });
          await queryClient.invalidateQueries({ queryKey: ['warehouse-placements'] });
        })}
        onClose={() => setScanning(false)}
      />
    );
  }

  return (
    <>
      <div className="card stack">
        <h3>Приёмка возврата</h3>
        <p className="muted text-sm">
          Заказ, который курьер не смог доставить. Кладётся в обычную ячейку хранения — маршрутная
          означала бы «готов к выдаче».
        </p>

        {/* Камера — такой же способ ввода, как и в приёмке: кнопка во всю
            ширину карточки, целиться в неё не нужно. */}
        <div className="wh-scan">
          <Button
            variant="primary"
            className="wh-scan__button"
            data-testid="wh-return-camera"
            onClick={() => {
              setScannedOrder(null);
              setCellInput('');
              setOrderInput('');
              setScanning(true);
            }}
          >
            Сканировать заказ
          </Button>
        </div>

        {scannedOrder === null ? (
          manualEntry ? (
            <ScanField
              label="Заказ"
              hint={SCAN_HINTS.ORDER}
              value={orderInput}
              onChange={setOrderInput}
              onSubmit={() => {
                const number = orderInput.trim();
                if (number !== '') {
                  setScannedOrder(number);
                }
              }}
              autoFocus
              testId="wh-return-order"
              disabled={accept.isPending}
            />
          ) : (
            <p className="muted text-sm" data-testid="wh-return-manual-off">
              Ручной ввод выключен администратором. Отсканируйте заказ.
            </p>
          )
        ) : (
          <div className="stack">
            <div className="row">
              <div>
                <div className="field__label">Заказ</div>
                <strong data-testid="wh-return-scanned">{scannedOrder}</strong>
              </div>
              <Button
                variant="ghost"
                onClick={() => {
                  setScannedOrder(null);
                  setCellInput('');
                }}
              >
                Другой заказ
              </Button>
            </div>
            {manualEntry && (
              <ScanField
                label="Ячейка хранения"
                hint={SCAN_HINTS.CELL}
                value={cellInput}
                onChange={setCellInput}
                onSubmit={() => {
                  if (cellInput.trim() !== '') {
                    accept.mutate({ orderNumber: scannedOrder, cellCode: cellInput });
                  }
                }}
                autoFocus
                testId="wh-return-cell"
                disabled={accept.isPending}
              />
            )}
          </div>
        )}
      </div>

      {returns.isPending && <LoadingState title="Загружаем возвраты…" />}
      {returns.isError && (
        <ErrorState title="Не удалось загрузить возвраты" onRetry={() => void returns.refetch()} />
      )}

      {/*
        Возвраты собраны в такие же вдавленные группы, что и складские
        размещения: тот же заголовок с точкой, счётчиком и стрелкой, те же
        карточки по четырём углам. Разделы склада кладовщик перебирает
        подряд, и разная разметка в них стоила бы лишнего взгляда.
      */}
      {returns.data !== undefined && returns.data.pending.length === 0 && (
        <EmptyState title="Возвратов нет" />
      )}

      {returns.data !== undefined && returns.data.pending.length > 0 && (
        <ReturnGroup
          id="pending"
          title="Ждут приёмки"
          tone="relocation"
          items={returns.data.pending}
          showCell={false}
          open={pendingOpen}
          onToggle={() => setPendingOpen((open) => !open)}
        />
      )}

      {returns.data !== undefined && returns.data.accepted.length > 0 && (
        <ReturnGroup
          id="accepted"
          title="Принятые возвраты"
          tone="route"
          items={returns.data.accepted}
          showCell
          open={acceptedOpen}
          onToggle={() => setAcceptedOpen((open) => !open)}
        />
      )}
    </>
  );
}

/**
 * Группа возвратов.
 *
 * Устроена как складская: утопленная панель, заголовок с точкой, счётчиком
 * и стрелкой, внутри — карточки. Свернуть можно любую.
 */
function ReturnGroup({
  id,
  title,
  tone,
  items,
  showCell,
  open,
  onToggle,
}: {
  id: string;
  title: string;
  tone: string;
  items: readonly WarehouseReturnView[];
  showCell: boolean;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <div className="stack wh-plate" data-testid={`wh-returns-${id}`}>
      <button
        type="button"
        className="wh-group__toggle"
        aria-expanded={open}
        data-testid={`wh-returns-${id}-toggle`}
        onClick={onToggle}
      >
        <span className={`wh-group__dot wh-group__dot--${tone}`} aria-hidden="true" />
        <span className="wh-group__title">{title}</span>
        <span
          className="wh-group__count wh-group__count--sunken"
          data-testid={`wh-returns-${id}-count`}
        >
          {items.length}
        </span>
        <GroupChevron open={open} />
      </button>

      {open && <ReturnsTable items={items} showCell={showCell} kind={id} />}
    </div>
  );
}

function ReturnsTable({
  items,
  showCell,
  kind,
}: {
  items: readonly WarehouseReturnView[];
  showCell: boolean;
  /** Смысл группы: от него зависит цвет карточки, как и на «Складе». */
  kind?: string;
}): React.JSX.Element {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Возврат</th>
            <th>Состояние</th>
            <th>Заказ</th>
            <th>Ячейка</th>
            <th>Причина</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.orderId}
              data-kind={item.cancelled ? 'cancelled' : kind}
              data-order-number={item.orderNumber}
              data-return-number={item.displayNumber}
            >
              <td className="wh-placement__order">
                <strong>{item.displayNumber}</strong>
              </td>
              <td className="wh-placement__kind muted">
                {RETURN_STATE_LABELS[item.state] ?? item.state}
              </td>
              <td className="wh-placement__route muted">заказ {item.orderNumber}</td>
              <td
                className={
                  showCell && item.cellCode !== null
                    ? 'wh-placement__cell'
                    : 'wh-placement__cell wh-placement__cell--none'
                }
              >
                {showCell && item.cellCode !== null ? item.cellCode : 'без ячейки'}
              </td>
              {/*
                Причина и курьер — третья строка: на вопрос «что это за
                коробка» отвечают углы, а это уже подробности.
              */}
              <td className="wh-placement__flags">
                <span className="wh-return__reason">
                  {item.reasonName}
                  {item.courier === null ? '' : ` · ${item.courier}`}
                </span>
                {item.cancelled && (
                  <span data-testid="wh-return-cancelled">
                    <StatusBadge tone="error">Отменён — не выдавать</StatusBadge>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Поле, которое ведёт себя как приёмник сканера. */
function ScanField({
  label,
  hint,
  value,
  onChange,
  onSubmit,
  autoFocus,
  testId,
  disabled,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  autoFocus: boolean;
  testId: string;
  disabled: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (autoFocus && !disabled) {
      ref.current?.focus();
    }
  }, [autoFocus, disabled]);

  return (
    <Field label={label} hint={hint}>
      {(fieldProps) => (
        <TextInput
          {...fieldProps}
          ref={ref}
          data-testid={testId}
          value={value}
          disabled={disabled}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Сканер завершает ввод переводом строки: это и есть подтверждение.
            if (event.key === 'Enter') {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
      )}
    </Field>
  );
}

/**
 * Безопасный текст отказа для окна сканера.
 *
 * Наружу идёт только публичное сообщение сервера: ни стека, ни внутреннего
 * кода, ни адреса с получателем.
 */
function failureText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function useApiError(): (error: unknown, fallback: string) => void {
  const { showToast } = useToast();
  return (error: unknown, fallback: string) => {
    showToast(error instanceof ApiError ? error.message : fallback, 'error');
  };
}

/**
 * Приёмка: заказ → ячейка.
 *
 * Пара отправляется одним существующим запросом, поэтому прерванная цепочка
 * не оставляет «приёмки без ячейки».
 *
 * Развилка одна и её выбирает человек: заказ, уже входящий в подтверждённый
 * лист, можно отнести сразу в сборку или всё равно положить в хранение.
 * Догадываться по коду ячейки нельзя — обе дороги законны, и решает их
 * тот, кто держит коробку.
 */
/**
 * Сканирование приёмки возврата: заказ, затем ячейка хранения.
 *
 * Цепочка та же, что у обычной приёмки, — различается только операция,
 * которой пара отправляется на сервер. Маршрутная ячейка возврату не нужна:
 * она означала бы «готов к выдаче», а вернувшийся букет к выдаче не готов.
 */
function returnIntentHandler(
  client: ReturnType<typeof useAuth>['client'],
  onAccepted: () => Promise<void>,
): (intent: ScanIntent) => Promise<ScanEvent> {
  return async (intent) => {
    try {
      if (intent.kind === 'resolveOrder') {
        const context = await client.get<ScanContext>(
          `/api/warehouse/scan/order?number=${encodeURIComponent(intent.code)}`,
        );
        return { type: 'orderResolved', orderNumber: context.orderNumber };
      }

      if (intent.kind === 'submitPair') {
        const result = await client.post<{
          orderNumber: string;
          cellCode: string;
          cancelled: boolean;
          unchanged: boolean;
        }>('/api/warehouse/returns/accept', {
          orderNumber: intent.orderNumber,
          cellCode: intent.cellCode,
        });
        await onAccepted();
        return {
          type: 'succeeded',
          text: result.cancelled
            ? `Возврат ${result.orderNumber} принят в ячейку ${result.cellCode}. Заказ отменён — не выдавать`
            : `Возврат ${result.orderNumber} принят в ячейку ${result.cellCode}`,
          final: true,
        };
      }
      return { type: 'failed', text: 'Неподдерживаемый шаг сканирования.' };
    } catch (error) {
      return { type: 'failed', text: failureText(error, 'Не удалось принять возврат.') };
    }
  };
}

/*
 * Обработчики сканирования для комплектования и выдачи живут теперь рядом
 * со своими экранами: `AssemblyTab` — пара «заказ → маршрутная ячейка»,
 * `IssueTab` — внесение заказа в проверку перед отгрузкой. Прежняя выдача
 * по одному заказу через `POST /api/warehouse/routes/:id/issue` удалена
 * вместе с эндпоинтом: лист уходит курьеру целиком или не уходит вовсе.
 */

// --- Вкладка «Склад» ---------------------------------------------------------

/** Разрешён ли ручной ввод. Решение администратора, не экрана. */
interface ManualEntryProps {
  manualEntry: boolean;
}

function StorageTab({ manualEntry }: ManualEntryProps): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const reportError = useApiError();

  const [orderInput, setOrderInput] = useState('');
  const [cellInput, setCellInput] = useState('');
  const [scanned, setScanned] = useState<ScanContext | null>(null);
  const [scanning, setScanning] = useState(false);
  /*
   * Ответ человека на вопрос «этот заказ уже в листе».
   *
   * До ответа поле ячейки не показывается вовсе: обе дороги законны, и
   * подставленная по умолчанию увела бы коробку не туда молча.
   */
  const [choice, setChoice] = useState<'ASSEMBLY' | 'STORAGE' | null>(null);
  const [newCell, setNewCell] = useState(false);

  /*
   * Склад читается страницами и дочитывается кнопкой.
   *
   * Раньше запрашивалась одна страница в сто строк и на этом всё: сто первая
   * коробка и все, что стояли дольше, просто исчезали из списка, хотя
   * физически продолжали числиться на складе. Ограничение по возрасту здесь
   * не годится — на полке лежит то, что лежит, независимо от даты.
   *
   * `useInfiniteQuery`, а не своё накопление в состоянии: после складской
   * операции или события реального времени обновляются ВСЕ дочитанные
   * страницы разом, и список не расходится сам с собой.
   */
  const placements = useInfiniteQuery({
    queryKey: ['warehouse-placements'],
    queryFn: ({ pageParam }) =>
      client.get<PlacementsPage>(
        `/api/warehouse/placements?limit=${PLACEMENTS_PAGE_SIZE}&offset=${pageParam}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (last: PlacementsPage) => nextPlacementOffset(last) ?? undefined,
  });

  const placementPages = placements.data?.pages ?? [];
  const placementItems = mergePlacementPages(placementPages);
  const placementTotals = placementPages[0]?.groupTotals ?? null;

  const lookup = useMutation({
    mutationFn: (number: string) =>
      client.get<ScanContext>(`/api/warehouse/scan/order?number=${encodeURIComponent(number)}`),
    onSuccess: (context) => {
      setScanned(context);
      setOrderInput('');
      // Заказ вне листов спрашивать не о чем: он едет в хранение.
      setChoice(context.route === null ? 'STORAGE' : null);
      setNewCell(false);
    },
    onError: (error: unknown) => reportError(error, 'Не удалось распознать заказ.'),
  });

  const receive = useMutation({
    mutationFn: (input: { orderNumber: string; cellCode: string; allowRouteCell?: boolean }) =>
      client.post<{ orderNumber: string; cellCode: string; unchanged: boolean }>(
        '/api/warehouse/placements',
        input,
      ),
    onSuccess: async (result) => {
      // Прогресс подтверждён: сбрасываем оба поля и возвращаемся к первому шагу.
      setScanned(null);
      setCellInput('');
      setChoice(null);
      setNewCell(false);
      await queryClient.invalidateQueries({ queryKey: ['warehouse-placements'] });
      showToast(
        result.unchanged
          ? `Заказ ${result.orderNumber} уже лежит в ячейке ${result.cellCode}`
          : `Заказ ${result.orderNumber} принят в ячейку ${result.cellCode}`,
        'success',
      );
    },
    onError: (error: unknown) => {
      // Заказ остаётся подтверждённым: человек повторяет только скан ячейки.
      setCellInput('');
      reportError(error, 'Не удалось разместить заказ.');
    },
  });

  /**
   * «В сборку»: полка листа и перенос коробки — одной транзакцией.
   *
   * Тот же запрос, что и у камеры: раздельные шаги оставляли бы листу
   * занятую полку, на которой ничего не стоит.
   */
  const pick = useMutation({
    mutationFn: (input: { routeId: string; orderNumber: string; cellCode: string }) =>
      client.post<{ orderNumber: string; cellCode: string; picked: number; total: number }>(
        `/api/warehouse/routes/${input.routeId}/pick`,
        {
          orderNumber: input.orderNumber,
          cellCode: input.cellCode,
          ...(newCell ? { bindIfFree: true } : {}),
        },
      ),
    onSuccess: async (result) => {
      const routeNumber = scanned?.route?.number ?? '';
      setScanned(null);
      setCellInput('');
      setChoice(null);
      setNewCell(false);
      await queryClient.invalidateQueries({ queryKey: ['warehouse-placements'] });
      await queryClient.invalidateQueries({ queryKey: ['warehouse-assembly'] });
      showToast(
        `Заказ ${result.orderNumber} перемещён в ячейку ${result.cellCode} для МЛ ${routeNumber}`,
        'success',
      );
    },
    onError: (error: unknown) => {
      setCellInput('');
      reportError(error, 'Не удалось перенести заказ в маршрутную ячейку.');
    },
  });

  function resetScan(): void {
    setScanned(null);
    setCellInput('');
    setChoice(null);
    setNewCell(false);
  }

  function submitCell(allowRouteCell?: boolean): void {
    if (scanned === null || cellInput.trim() === '') {
      return;
    }
    if (choice === 'ASSEMBLY' && scanned.route !== null) {
      pick.mutate({
        routeId: scanned.route.id,
        orderNumber: scanned.orderNumber,
        cellCode: cellInput,
      });
      return;
    }
    receive.mutate({
      orderNumber: scanned.orderNumber,
      cellCode: cellInput,
      ...(allowRouteCell === undefined ? {} : { allowRouteCell }),
    });
  }

  if (scanning) {
    return (
      <ScannerScreen
        resultWindow
        chain="RECEIVE"
        operation="Приёмка на склад"
        onIntent={createReceiveIntent({
          client,
          onPlaced: async () => {
            await queryClient.invalidateQueries({ queryKey: ['warehouse-placements'] });
          },
        })}
        onClose={() => setScanning(false)}
      />
    );
  }

  return (
    <>
      <div className="card stack">
        <h3>Приёмка</h3>

        {/* Камера — третий способ ввода, а не замена: аппаратный сканер
            и ручной ввод ниже остаются рабочими. Кнопка во всю ширину
            карточки: целиться в неё не нужно. */}
        <div className="wh-scan">
          <Button
            variant="primary"
            className="wh-scan__button"
            data-testid="wh-scan-camera"
            onClick={() => {
              setScanned(null);
              setCellInput('');
              setScanning(true);
            }}
          >
            Сканировать заказ
          </Button>
        </div>

        {scanned === null ? (
          /*
           * Ручной ввод убран администратором — остаётся сканирование.
           *
           * Поле не выключается, а исчезает: выключенное поле обещает работу,
           * которой в этом контуре нет, и кладовщик пробует в него набирать.
           */
          manualEntry ? (
            <ScanField
              label="Заказ"
              hint={SCAN_HINTS.ORDER}
              value={orderInput}
              onChange={setOrderInput}
              onSubmit={() => orderInput.trim() !== '' && lookup.mutate(orderInput)}
              autoFocus
              testId="wh-scan-order"
              disabled={lookup.isPending}
            />
          ) : (
            <p className="muted text-sm" data-testid="wh-manual-off">
              Ручной ввод выключен администратором. Отсканируйте заказ.
            </p>
          )
        ) : (
          <div className="stack">
            <div className="row">
              <div>
                <div className="field__label">Заказ</div>
                <strong data-testid="wh-scanned-order">{scanned.orderNumber}</strong>
              </div>
              {scanned.currentCell !== null && (
                <div>
                  <div className="field__label">Сейчас лежит</div>
                  <span>{scanned.currentCell.code}</span>
                </div>
              )}
              <Button variant="ghost" data-testid="wh-scan-reset" onClick={resetScan}>
                Отменить
              </Button>
            </div>

            {scanned.blockedBy.length > 0 && (
              <p className="field__error" role="alert" data-testid="wh-order-blocked">
                {scanned.blockedBy.map(blockLabel).join('; ')}. Разместить заказ можно, но
                комплектование и выдача заблокированы.
              </p>
            )}

            {/*
              Заказ уже в листе — развилку выбирает человек.
              Кладовщик видит номер листа и решает: нести сразу в сборку
              или всё равно оставить в хранении. Догадка за него означала бы
              коробку не на той полке.
            */}
            {scanned.route !== null && choice === null && (
              <div className="stack" data-testid="wh-route-choice">
                <p>
                  Заказ {scanned.orderNumber} уже входит в МЛ {scanned.route.number}
                </p>
                <div className="row">
                  <Button
                    variant="primary"
                    data-testid="wh-choice-assembly"
                    onClick={() => {
                      setChoice('ASSEMBLY');
                      // Первая полка листа назначается тем же сканом.
                      setNewCell((scanned.route?.routeCells.length ?? 0) === 0);
                    }}
                  >
                    В сборку
                  </Button>
                  <Button data-testid="wh-choice-storage" onClick={() => setChoice('STORAGE')}>
                    Всё равно в хранение
                  </Button>
                  <Button variant="ghost" data-testid="wh-choice-cancel" onClick={resetScan}>
                    Отмена
                  </Button>
                </div>
              </div>
            )}

            {choice !== null && (
              <>
                {choice === 'ASSEMBLY' && scanned.route !== null && (
                  <p className="muted text-sm" data-testid="wh-route-cell-hint">
                    {/* Полок у листа нет — зовём назначить первую, а не искать
                        «свободную»: выбора у человека всё равно нет. */}
                    {newCell && scanned.route.routeCells.length > 0
                      ? 'Отсканируйте свободную маршрутную ячейку'
                      : routeCellHint(scanned.route.routeCells)}
                  </p>
                )}

                {manualEntry ? (
                  <ScanField
                    label="Ячейка"
                    hint={choice === 'ASSEMBLY' ? SCAN_HINTS.ROUTE_CELL : SCAN_HINTS.CELL}
                    value={cellInput}
                    onChange={setCellInput}
                    onSubmit={() => submitCell()}
                    autoFocus
                    testId="wh-scan-cell"
                    disabled={receive.isPending || pick.isPending}
                  />
                ) : (
                  <p className="muted text-sm">
                    Ручной ввод выключен администратором. Отсканируйте ячейку.
                  </p>
                )}

                <div className="row">
                  <Button
                    variant="primary"
                    data-testid="wh-place"
                    disabled={receive.isPending || pick.isPending || cellInput.trim() === ''}
                    onClick={() => submitCell()}
                  >
                    {receive.isPending || pick.isPending
                      ? 'Сохраняем…'
                      : choice === 'ASSEMBLY'
                        ? 'В маршрутную ячейку'
                        : 'Положить в ячейку'}
                  </Button>

                  {choice === 'ASSEMBLY' && (scanned.route?.routeCells.length ?? 0) > 0 && (
                    <Button
                      variant="secondary"
                      data-testid="wh-add-cell"
                      disabled={newCell}
                      onClick={() => setNewCell(true)}
                    >
                      + Доп. ячейка
                    </Button>
                  )}

                  {choice === 'STORAGE' && scanned.route !== null && (
                    <Button
                      variant="secondary"
                      data-testid="wh-place-route"
                      disabled={receive.isPending || cellInput.trim() === ''}
                      onClick={() => submitCell(true)}
                    >
                      Это маршрутная ячейка
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="card stack">
        <h3>Сейчас на складе</h3>
        {placements.isPending && <LoadingState title="Загружаем размещения…" />}
        {placements.isError && (
          <ErrorState
            description="Список размещений не загрузился."
            onRetry={() => void placements.refetch()}
          />
        )}
        {placements.isSuccess && placementItems.length === 0 && (
          <EmptyState
            title="На складе пусто"
            description="Отсканируйте заказ и ячейку, чтобы принять его."
          />
        )}
        {placements.isSuccess && placementItems.length > 0 && (
          <PlacementGroups
            items={placementItems}
            totals={placementTotals}
            /*
              Кнопка стоит ПОСЛЕ групп и одна на весь список: внутри группы
              она пропадала бы вместе со свёрнутыми отменёнными, и дочитать
              склад стало бы нечем.
            */
            more={
              placements.hasNextPage ? (
                <Button
                  variant="ghost"
                  className="wh-more"
                  disabled={placements.isFetchingNextPage}
                  data-testid="wh-placements-more"
                  onClick={() => void placements.fetchNextPage()}
                >
                  {placements.isFetchingNextPage
                    ? 'Загружаем…'
                    : `Показать ещё · загружено ${placementItems.length} из ${placementPages[0]?.total ?? 0}`}
                </Button>
              ) : null
            }
          />
        )}
      </div>
    </>
  );
}

/**
 * Складской список группами.
 *
 * Порядок задан правилом в `warehouse-flow.ts`: сначала то, что мешает
 * работе прямо сейчас, потом мёртвый груз, потом обычное хранение.
 */
function PlacementGroups({
  items,
  totals,
  more,
}: {
  items: PlacedOrderView[];
  /** Полные размеры групп по всему складу; `null`, пока страница не пришла. */
  totals: PlacementGroupTotals | null;
  /** Кнопка дочитывания. Стоит после всех групп и от них не зависит. */
  more: React.ReactNode;
}): React.JSX.Element {
  const groups = groupPlacements(items);
  const { showToast } = useToast();
  const reportError = useApiError();
  const queryClient = useQueryClient();
  const { client } = useAuth();
  /*
   * Свернуть можно любую группу.
   *
   * Отменённые закрыты сразу: их бывает много, и разворачивать ими весь экран
   * при каждом открытии склада незачем. Остальные открыты, но кладовщик
   * убирает лишнее сам — на телефоне четыре списка подряд не помещаются.
   */
  const [closed, setClosed] = useState<Record<string, boolean>>({ cancelled: true });
  const toggle = (id: string): void => setClosed((prev) => ({ ...prev, [id]: prev[id] !== true }));

  /*
   * Коробка, которую собираются снять с хранения, — до подтверждения.
   *
   * Снятие с полки необратимо для места: ячейка тут же освобождается, и в неё
   * может встать другой заказ. Поэтому сначала окно с номером заказа и ячейки,
   * а не действие по одному нажатию.
   */
  const [removing, setRemoving] = useState<{ orderNumber: string; cellCode: string } | null>(null);

  const withdraw = useMutation({
    // Причина есть только у изъятия отменённого букета. У простого снятия
    // с хранения её нет — сервер это отличает и по-разному пишет в историю.
    mutationFn: (input: { orderNumber: string; reason?: 'REASSEMBLY' | 'WRITE_OFF' }) =>
      client.post<{ orderNumber: string; withdrawn: boolean }>(
        '/api/warehouse/placements/withdraw',
        input,
      ),
    onSuccess: async (result) => {
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: ['warehouse-placements'] });
      showToast(
        result.withdrawn
          ? `Заказ ${result.orderNumber} снят с хранения`
          : `Заказ ${result.orderNumber} на складе уже не числится`,
        'success',
      );
    },
    onError: (error: unknown) => reportError(error, 'Не удалось снять заказ с хранения.'),
  });

  return (
    <div className="stack">
      {/*
        Четыре группы одного склада, каждая со своим смыслом:
        что мешает работе, что ждёт решения, что просто лежит и что уже
        собрано под курьера. Раньше две последние шли одним безымянным
        списком, и тип полки приходилось читать у каждой строки.
      */}
      <PlacementGroup
        id="relocation"
        title="Требует перемещения"
        count={totals?.relocation ?? groups.relocation.length}
        items={groups.relocation}
        open={closed.relocation !== true}
        onToggle={() => toggle('relocation')}
      />

      <PlacementGroup
        id="cancelled"
        title="Отменённые"
        count={totals?.cancelled ?? groups.cancelled.length}
        items={groups.cancelled}
        open={closed.cancelled !== true}
        onToggle={() => toggle('cancelled')}
        onWithdraw={(orderNumber, reason) => withdraw.mutate({ orderNumber, reason })}
        busy={withdraw.isPending}
      />

      <PlacementGroup
        id="storage"
        title="В хранении"
        count={totals?.storage ?? groups.storage.length}
        items={groups.storage}
        open={closed.storage !== true}
        onToggle={() => toggle('storage')}
        onRemove={(orderNumber, cellCode) => setRemoving({ orderNumber, cellCode })}
        busy={withdraw.isPending}
      />

      <PlacementGroup
        id="route"
        title="В маршрутных ячейках"
        count={totals?.route ?? groups.route.length}
        items={groups.route}
        open={closed.route !== true}
        onToggle={() => toggle('route')}
      />

      {more}

      {/*
        Подтверждение снятия с хранения.

        В окне ровно то, что человек проверяет перед необратимым действием:
        какой заказ и из какой ячейки уходит. Повторное нажатие безопасно —
        сервер идемпотентен, — но спросить всё равно нужно: место освобождается
        сразу, и ошибку уже не отменить.
      */}
      <Modal
        open={removing !== null}
        title="Снять с хранения"
        onClose={() => setRemoving(null)}
        testId="wh-remove-confirm"
        footer={
          removing !== null ? (
            <div className="row">
              <Button
                variant="primary"
                disabled={withdraw.isPending}
                data-testid="wh-remove-confirm-submit"
                onClick={() => withdraw.mutate({ orderNumber: removing.orderNumber })}
              >
                {withdraw.isPending ? 'Снимаем…' : 'Снять с хранения'}
              </Button>
              <Button
                variant="secondary"
                disabled={withdraw.isPending}
                onClick={() => setRemoving(null)}
              >
                Отмена
              </Button>
            </div>
          ) : undefined
        }
      >
        {removing !== null && (
          <p>
            Снять заказ <strong>{removing.orderNumber}</strong> с хранения из ячейки{' '}
            <strong>{removing.cellCode}</strong>? Ячейка сразу освободится, а заказ и история
            останутся.
          </p>
        )}
      </Modal>
    </div>
  );
}

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

/**
 * Группа складского списка.
 *
 * Заголовок лежит в углублении и держит счётчик: он отвечает на вопрос
 * «сколько таких коробок на складе», а не «сколько их видно сейчас».
 * Пустая группа не показывается — заголовок с нулём обещает работу,
 * которой нет.
 */
function PlacementGroup({
  id,
  title,
  count,
  items,
  open = true,
  onToggle,
  onWithdraw,
  onRemove,
  busy,
}: {
  id: string;
  title: string;
  count: number;
  items: PlacedOrderView[];
  open?: boolean;
  onToggle?: () => void;
  onWithdraw?: (orderNumber: string, reason: 'REASSEMBLY' | 'WRITE_OFF') => void;
  /** Простое снятие с хранения: одна кнопка и подтверждение с номером и ячейкой. */
  onRemove?: (orderNumber: string, cellCode: string) => void;
  busy?: boolean;
}): React.JSX.Element | null {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="stack wh-plate" data-testid={`wh-group-${id}`}>
      <button
        type="button"
        className="wh-group__toggle"
        aria-expanded={open}
        data-testid={`wh-group-${id}-toggle`}
        onClick={onToggle}
      >
        <span className={`wh-group__dot wh-group__dot--${id}`} aria-hidden="true" />
        <span className="wh-group__title">{title}</span>
        <span
          className="wh-group__count wh-group__count--sunken"
          data-testid={`wh-group-${id}-count`}
        >
          {count}
        </span>
        <GroupChevron open={open} />
      </button>

      {open && (
        <PlacementTable
          items={items}
          kind={id}
          {...(onWithdraw === undefined ? {} : { onWithdraw })}
          {...(onRemove === undefined ? {} : { onRemove })}
          {...(busy === undefined ? {} : { busy })}
        />
      )}
    </div>
  );
}

function PlacementTable({
  items,
  kind,
  onWithdraw,
  onRemove,
  busy,
}: {
  items: PlacedOrderView[];
  /** Вид группы: на телефоне он задаёт поверхность карточки. */
  kind: string;
  onWithdraw?: (orderNumber: string, reason: 'REASSEMBLY' | 'WRITE_OFF') => void;
  onRemove?: (orderNumber: string, cellCode: string) => void;
  busy?: boolean;
}): React.JSX.Element {
  const hasAction = onWithdraw !== undefined || onRemove !== undefined;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Заказ</th>
            <th>Тип</th>
            <th>Маршрут</th>
            <th>Ячейка</th>
            <th>Пометки</th>
            {hasAction && <th>Снять с хранения</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            /*
              Порядок ячеек здесь же задаёт раскладку на телефоне: строка
              превращается в карточку с четырьмя углами — заказ и вид полки
              сверху, маршрутный лист и номер ячейки снизу. Значения по углам
              читаются одним взглядом, а столбиком их пришлось бы перебирать.
            */
            <tr key={item.orderId} data-testid="wh-placement-row" data-kind={kind}>
              <td className="wh-placement__order">
                <strong>{item.orderNumber}</strong>
              </td>
              <td className="wh-placement__kind muted">
                {item.cellKind === null ? '—' : CELL_KIND_LABELS[item.cellKind]}
              </td>
              <td className="wh-placement__route muted">{item.routeNumber ?? '—'}</td>
              {/*
                Полка показана таблеткой только когда она есть. «Не принят» —
                это отсутствие полки, а не её номер, и заливка приравнивала бы
                одно к другому.
              */}
              <td
                className={
                  item.cellCode === null
                    ? 'wh-placement__cell wh-placement__cell--none'
                    : 'wh-placement__cell'
                }
              >
                {cellLabel(item)}
              </td>
              {/*
                Пометки — настоящие предупреждения и живут отдельной ячейкой:
                на телефоне она становится третьей строкой и только тогда,
                когда предупреждение есть.

                Значка «Переместить» здесь больше нет: про перенос уже сказали
                заголовок группы, её точка и тёплый цвет карточки, а четвёртое
                повторение отнимало строку у того, что говорится один раз.
              */}
              <td className="wh-placement__flags">
                {item.blockedBy.map((flag) => (
                  <StatusBadge key={flag} tone="error">
                    {blockLabel(flag)}
                  </StatusBadge>
                ))}
              </td>
              {onWithdraw !== undefined && (
                <td>
                  {/*
                    Ровно два выхода у отменённого букета: обратно к флористам
                    или в списание. Третьего смысла нет, а свободный текст
                    потом нельзя посчитать.
                  */}
                  {/*
                    Обычные кнопки, а не текст: на цветной карточке призрачная
                    кнопка неотличима от подписи, и нажать её никто не пробует.
                  */}
                  <div className="row wh-placement__actions">
                    <Button
                      variant="secondary"
                      disabled={busy === true}
                      data-testid="wh-withdraw-reassembly"
                      onClick={() => onWithdraw(item.orderNumber, 'REASSEMBLY')}
                    >
                      Передать на пересборку
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy === true}
                      data-testid="wh-withdraw-write-off"
                      onClick={() => onWithdraw(item.orderNumber, 'WRITE_OFF')}
                    >
                      Списать
                    </Button>
                  </div>
                </td>
              )}
              {onRemove !== undefined && (
                <td>
                  {/*
                    Явная кнопка, а не клик по строке: снятие с полки необратимо
                    для места, и случайно задеть его нельзя. Подтверждение
                    с номером и ячейкой — в окне выше.
                  */}
                  <Button
                    variant="secondary"
                    disabled={busy === true}
                    data-testid="wh-remove-from-storage"
                    onClick={() => onRemove(item.orderNumber, item.cellCode ?? '')}
                  >
                    Снять с хранения
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Прежний общий `RouteTab` -----------------------------------------------
//
// Удалён вместе с поштучной выдачей. Он обслуживал сразу комплектование и
// выдачу одним списком листов; теперь у каждого раздела своя структура:
// «Сборка» — доска листов с проверкой (`AssemblyTab`), «Выдача» — курьер,
// его листы и отгрузка целиком (`IssueTab`). Общий компонент пришлось бы
// ветвить по режиму в каждой второй строке.
