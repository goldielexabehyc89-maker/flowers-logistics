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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  StatusBadge,
  TextInput,
} from '../../ui/components';
import { ScannerScreen } from '../../scan/ScannerScreen';
import { routeCellHint } from '../../scan/scan-machine';
import { AssemblyTab } from './AssemblyTab';
import { IssueTab } from './IssueTab';
import type { ScanEvent, ScanIntent } from '../../scan/scan-machine';
import {
  CELL_KIND_LABELS,
  SCAN_HINTS,
  blockLabel,
  cellLabel,
  groupPlacements,
  type PlacedOrderView,
  type ScanContext,
} from './warehouse-flow';

type Tab = 'storage' | 'picking' | 'issue' | 'returns';

const TABS: readonly { key: Tab; title: string }[] = [
  { key: 'storage', title: 'Склад' },
  { key: 'picking', title: 'Сборка' },
  { key: 'issue', title: 'Выдача' },
  { key: 'returns', title: 'Возвраты' },
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
  const { client } = useAuth();
  const [tab, setTab] = useState<Tab>('storage');

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

  return (
    <section className="stack warehouse" data-testid="warehouse-screen">
      {/*
        Повторного заголовка и описания здесь нет намеренно.
        Раздел уже назван системной шапкой, а объяснение приёмки,
        комплектования и выдачи занимало треть экрана телефона у человека,
        который приходит сюда работать, а не читать.
      */}
      <nav className="wh-tabs" aria-label="Разделы склада" data-testid="wh-tabs">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={item.key === tab ? 'wh-tabs__item wh-tabs__item--active' : 'wh-tabs__item'}
            aria-current={item.key === tab ? 'page' : undefined}
            data-testid={`wh-tab-${item.key}`}
            onClick={() => setTab(item.key)}
          >
            {item.title}
          </button>
        ))}
      </nav>

      {tab === 'storage' && <StorageTab />}
      {tab === 'picking' && <AssemblyTab manualEntry={manualEntry} />}
      {tab === 'issue' && <IssueTab manualEntry={manualEntry} />}
      {tab === 'returns' && <ReturnsTab />}
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
function ReturnsTab(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const reportError = useApiError();

  const [orderInput, setOrderInput] = useState('');
  const [cellInput, setCellInput] = useState('');
  const [scannedOrder, setScannedOrder] = useState<string | null>(null);

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

  return (
    <>
      <div className="card stack">
        <h3>Приёмка возврата</h3>
        <p className="muted text-sm">
          Заказ, который курьер не смог доставить. Кладётся в обычную ячейку хранения — маршрутная
          означала бы «готов к выдаче».
        </p>

        {scannedOrder === null ? (
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
          </div>
        )}
      </div>

      <div className="card stack">
        <h3>Ждут приёмки</h3>
        {returns.isPending && <LoadingState title="Загружаем возвраты…" />}
        {returns.isError && (
          <ErrorState
            title="Не удалось загрузить возвраты"
            onRetry={() => void returns.refetch()}
          />
        )}
        {returns.data !== undefined &&
          (returns.data.pending.length === 0 ? (
            <EmptyState title="Возвратов нет" />
          ) : (
            <ReturnsTable items={returns.data.pending} showCell={false} />
          ))}
      </div>

      {returns.data !== undefined && returns.data.accepted.length > 0 && (
        <div className="card stack">
          <h3>Принятые возвраты</h3>
          <ReturnsTable items={returns.data.accepted} showCell />
        </div>
      )}
    </>
  );
}

function ReturnsTable({
  items,
  showCell,
}: {
  items: readonly WarehouseReturnView[];
  showCell: boolean;
}): React.JSX.Element {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Возврат</th>
            <th>Курьер</th>
            <th>Причина</th>
            <th>Состояние</th>
            {showCell && <th>Ячейка</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.orderId}
              data-order-number={item.orderNumber}
              data-return-number={item.displayNumber}
            >
              <td>
                <strong>{item.displayNumber}</strong>
                <div className="muted text-sm">заказ {item.orderNumber}</div>
                {item.cancelled && (
                  <div data-testid="wh-return-cancelled">
                    <StatusBadge tone="error">Отменён — не выдавать</StatusBadge>
                  </div>
                )}
              </td>
              <td>{item.courier ?? '—'}</td>
              <td>{item.reasonName}</td>
              <td>{RETURN_STATE_LABELS[item.state] ?? item.state}</td>
              {showCell && <td>{item.cellCode ?? '—'}</td>}
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

function conflictKind(error: unknown): string | null {
  return error instanceof ApiError ? (error.conflict?.kind ?? null) : null;
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
function receiveIntentHandler(
  client: ReturnType<typeof useAuth>['client'],
  onPlaced: () => Promise<void>,
): (intent: ScanIntent) => Promise<ScanEvent> {
  let consentedCell: string | null = null;
  let routeNumber: string | null = null;

  return async (intent) => {
    try {
      if (intent.kind === 'resolveOrder') {
        const context = await client.get<ScanContext>(
          `/api/warehouse/scan/order?number=${encodeURIComponent(intent.code)}`,
        );
        if (context.route !== null) {
          routeNumber = context.route.number;
          return {
            type: 'routeChoiceRequired',
            orderNumber: context.orderNumber,
            route: {
              routeId: context.route.id,
              routeNumber: context.route.number,
              cells: context.route.routeCells,
            },
          };
        }
        routeNumber = null;
        return { type: 'orderResolved', orderNumber: context.orderNumber };
      }

      if (intent.kind === 'submitPair' && intent.target === 'ROUTE') {
        /*
         * «В сборку»: назначение полки и перенос коробки — одна транзакция.
         *
         * Раздельные шаги оставляли бы лист с занятой полкой, на которой
         * ничего не стоит, если кладовщика позвали между ними.
         */
        const result = await client.post<{
          orderNumber: string;
          cellCode: string;
          picked: number;
          total: number;
        }>(`/api/warehouse/routes/${intent.routeId ?? ''}/pick`, {
          orderNumber: intent.orderNumber,
          cellCode: intent.cellCode,
          ...(intent.allowNewCell ? { bindIfFree: true } : {}),
        });
        await onPlaced();
        return {
          type: 'succeeded',
          text: `Заказ ${result.orderNumber} перемещён в ячейку ${result.cellCode} для МЛ ${routeNumber ?? ''}`.trim(),
          progress: { done: result.picked, total: result.total },
          final: true,
        };
      }

      if (intent.kind === 'submitPair') {
        const agreed = consentedCell === intent.cellCode;
        const result = await client.post<{ orderNumber: string; cellCode: string }>(
          '/api/warehouse/placements',
          {
            orderNumber: intent.orderNumber,
            cellCode: intent.cellCode,
            ...(agreed ? { allowRouteCell: true } : {}),
          },
        );
        consentedCell = null;
        await onPlaced();
        return {
          type: 'succeeded',
          text: `Заказ ${result.orderNumber} помещён в ячейку ${result.cellCode}`,
          final: true,
        };
      }
      return { type: 'failed', text: 'Неподдерживаемый шаг сканирования.' };
    } catch (error) {
      if (
        intent.kind === 'submitPair' &&
        intent.target === 'STORAGE' &&
        conflictKind(error) === 'ROUTE_CELL_REQUIRES_CHOICE'
      ) {
        consentedCell = intent.cellCode;
        return { type: 'consentRequired', cellCode: intent.cellCode };
      }
      return { type: 'failed', text: failureText(error, 'Не удалось разместить заказ.') };
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

function StorageTab(): React.JSX.Element {
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

  const placements = useQuery({
    queryKey: ['warehouse-placements'],
    queryFn: () =>
      client.get<{ items: PlacedOrderView[]; total: number }>(
        '/api/warehouse/placements?limit=100',
      ),
  });

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
        chain="RECEIVE"
        operation="Приёмка на склад"
        onIntent={receiveIntentHandler(client, async () => {
          await queryClient.invalidateQueries({ queryKey: ['warehouse-placements'] });
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
            и ручной ввод ниже остаются рабочими. */}
        <div className="row">
          <Button
            variant="primary"
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
        {placements.isSuccess && placements.data.items.length === 0 && (
          <EmptyState
            title="На складе пусто"
            description="Отсканируйте заказ и ячейку, чтобы принять его."
          />
        )}
        {placements.isSuccess && placements.data.items.length > 0 && (
          <PlacementGroups items={placements.data.items} />
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
function PlacementGroups({ items }: { items: PlacedOrderView[] }): React.JSX.Element {
  const groups = groupPlacements(items);
  const { showToast } = useToast();
  const reportError = useApiError();
  const queryClient = useQueryClient();
  const { client } = useAuth();
  // Отменённые свёрнуты по умолчанию: их бывает много, и разворачивать ими
  // весь экран при каждом открытии склада незачем.
  const [cancelledOpen, setCancelledOpen] = useState(false);

  const withdraw = useMutation({
    mutationFn: (input: { orderNumber: string; reason: 'REASSEMBLY' | 'WRITE_OFF' }) =>
      client.post<{ orderNumber: string; withdrawn: boolean }>(
        '/api/warehouse/placements/withdraw',
        input,
      ),
    onSuccess: async (result) => {
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
      {groups.relocation.length > 0 && (
        <div className="stack" data-testid="wh-group-relocation">
          <h4 className="wh-group__title">Требуется перемещение · {groups.relocation.length}</h4>
          <PlacementTable items={groups.relocation} />
        </div>
      )}

      {groups.cancelled.length > 0 && (
        <div className="stack" data-testid="wh-group-cancelled">
          {/*
            Одна строка высотой с обычную: свёрнутая группа не должна
            выглядеть весомее самих заказов.
          */}
          <button
            type="button"
            className="wh-group__toggle"
            data-testid="wh-group-cancelled-toggle"
            aria-expanded={cancelledOpen}
            onClick={() => setCancelledOpen((open) => !open)}
          >
            <span>Отменённые</span>
            <span className="wh-group__count" data-testid="wh-group-cancelled-count">
              {groups.cancelled.length}
            </span>
            <span aria-hidden="true">{cancelledOpen ? '▾' : '▸'}</span>
          </button>

          {cancelledOpen && (
            <PlacementTable
              items={groups.cancelled}
              onWithdraw={(orderNumber, reason) => withdraw.mutate({ orderNumber, reason })}
              busy={withdraw.isPending}
            />
          )}
        </div>
      )}

      {groups.rest.length > 0 && <PlacementTable items={groups.rest} />}
    </div>
  );
}

function PlacementTable({
  items,
  onWithdraw,
  busy,
}: {
  items: PlacedOrderView[];
  onWithdraw?: (orderNumber: string, reason: 'REASSEMBLY' | 'WRITE_OFF') => void;
  busy?: boolean;
}): React.JSX.Element {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Заказ</th>
            <th>Ячейка</th>
            <th>Тип</th>
            <th>Маршрут</th>
            <th>Пометки</th>
            {onWithdraw !== undefined && <th>Снять с хранения</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.orderId} data-testid="wh-placement-row">
              <td>
                <strong>{item.orderNumber}</strong>
              </td>
              <td>{cellLabel(item)}</td>
              <td className="muted">
                {item.cellKind === null ? '—' : CELL_KIND_LABELS[item.cellKind]}
              </td>
              <td className="muted">{item.routeNumber ?? '—'}</td>
              <td>
                {item.requiresRelocation && <StatusBadge tone="warning">Переместить</StatusBadge>}
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
                  <div className="row resolutions__actions">
                    <Button
                      variant="ghost"
                      disabled={busy === true}
                      data-testid="wh-withdraw-reassembly"
                      onClick={() => onWithdraw(item.orderNumber, 'REASSEMBLY')}
                    >
                      Передать на пересборку
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy === true}
                      data-testid="wh-withdraw-write-off"
                      onClick={() => onWithdraw(item.orderNumber, 'WRITE_OFF')}
                    >
                      Списать
                    </Button>
                  </div>
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
