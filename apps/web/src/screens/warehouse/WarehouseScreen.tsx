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
import { moscowToday } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  SegmentedControl,
  Select,
  StatusBadge,
  TextInput,
} from '../../ui/components';
import { ScannerScreen } from '../../scan/ScannerScreen';
import type { ScanEvent, ScanIntent } from '../../scan/scan-machine';
import {
  CELL_KIND_LABELS,
  SCAN_HINTS,
  blockLabel,
  cellLabel,
  issueBlocker,
  issueProgress,
  pickProgress,
  type PlacedOrderView,
  type RouteFlowView,
  type RouteSummary,
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
  state: keyof typeof RETURN_STATE_LABELS;
  courier: string | null;
  reasonName: string;
  decision: 'CANCELLED' | 'REDELIVER' | null;
  cancelled: boolean;
  cellCode: string | null;
  acceptedAt: string | null;
}

export function WarehouseScreen(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('storage');

  return (
    <section className="stack">
      <div className="card stack">
        <div>
          <h2>Склад</h2>
          <p className="muted text-sm">
            Приёмка собранных заказов в ячейки, комплектование подтверждённых маршрутных листов и
            выдача курьеру. Поля работают со сканером и с ручным вводом.
          </p>
        </div>
        {/*
          Переключатель режимов — тот же общий компонент, что у флориста.
          Раньше это был ряд обычных кнопок: основная заливка на выбранной
          и призрачная на остальных. Выглядело оно как три самостоятельных
          действия, а не как выбор одного режима из трёх, и не совпадало
          с соседним рабочим местом ни рамкой, ни высотой.
        */}
        <SegmentedControl
          label="Разделы склада"
          value={tab}
          onChange={setTab}
          options={TABS.map((item) => ({
            value: item.key,
            label: item.title,
            testId: `wh-tab-${item.key}`,
          }))}
        />
      </div>

      {tab === 'storage' && <StorageTab />}
      {tab === 'picking' && <RouteTab mode="picking" />}
      {tab === 'issue' && <RouteTab mode="issue" />}
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
            <th>Заказ</th>
            <th>Курьер</th>
            <th>Причина</th>
            <th>Состояние</th>
            {showCell && <th>Ячейка</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.orderId} data-order-number={item.orderNumber}>
              <td>
                <strong>{item.orderNumber}</strong>
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
 * Приёмка: заказ → ячейка хранения.
 *
 * Пара отправляется одним существующим запросом, поэтому прерванная цепочка
 * не оставляет «приёмки без ячейки». Маршрутная ячейка не подставляется молча:
 * сервер отвечает отдельным конфликтом, а человек отвечает согласием.
 */
function receiveIntentHandler(
  client: ReturnType<typeof useAuth>['client'],
  onPlaced: () => Promise<void>,
): (intent: ScanIntent) => Promise<ScanEvent> {
  let consentedCell: string | null = null;

  return async (intent) => {
    try {
      if (intent.kind === 'resolveOrder') {
        const context = await client.get<ScanContext>(
          `/api/warehouse/scan/order?number=${encodeURIComponent(intent.code)}`,
        );
        return { type: 'orderResolved', orderNumber: context.orderNumber };
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
          text: `Заказ ${result.orderNumber} принят в ячейку ${result.cellCode}`,
          final: true,
        };
      }
      return { type: 'failed', text: 'Неподдерживаемый шаг сканирования.' };
    } catch (error) {
      if (intent.kind === 'submitPair' && conflictKind(error) === 'ROUTE_CELL_REQUIRES_CHOICE') {
        consentedCell = intent.cellCode;
        return { type: 'consentRequired', cellCode: intent.cellCode };
      }
      return { type: 'failed', text: failureText(error, 'Не удалось разместить заказ.') };
    }
  };
}

/**
 * Комплектование: для КАЖДОГО заказа своя пара «заказ → маршрутная ячейка».
 *
 * Код ячейки берётся из второго скана, а не из загруженной карточки листа:
 * подставленный код доказывал бы только то, что карточка открыта, а физический
 * QR доказывает, что кладовщик действительно принёс коробку к нужной полке.
 */
function pickIntentHandler(
  client: ReturnType<typeof useAuth>['client'],
  routeId: string,
  onPicked: () => Promise<void>,
): (intent: ScanIntent) => Promise<ScanEvent> {
  return async (intent) => {
    try {
      if (intent.kind === 'resolveOrder') {
        const context = await client.get<ScanContext>(
          `/api/warehouse/scan/order?number=${encodeURIComponent(intent.code)}`,
        );
        if (context.route === null || context.route.id !== routeId) {
          return { type: 'failed', text: 'Этот заказ не входит в выбранный маршрутный лист.' };
        }
        return { type: 'orderResolved', orderNumber: context.orderNumber };
      }
      if (intent.kind === 'submitPair') {
        const result = await client.post<{ orderNumber: string; picked: number; total: number }>(
          `/api/warehouse/routes/${routeId}/pick`,
          { orderNumber: intent.orderNumber, cellCode: intent.cellCode },
        );
        await onPicked();
        return {
          type: 'succeeded',
          text: `Заказ ${result.orderNumber} перенесён`,
          progress: { done: result.picked, total: result.total },
          final: true,
        };
      }
      return { type: 'failed', text: 'Неподдерживаемый шаг сканирования.' };
    } catch (error) {
      return { type: 'failed', text: failureText(error, 'Не удалось перенести заказ.') };
    }
  };
}

/**
 * Выдача: одна сессия на весь оставшийся лист.
 *
 * Камера не закрывается между заказами — курьер стоит рядом, и открывать
 * её заново на каждую коробку значит терять время на пустом месте. Повтор
 * уже выданного заказа называется честно и прогресс второй раз не двигает.
 */
function issueIntentHandler(
  client: ReturnType<typeof useAuth>['client'],
  routeId: string,
  onIssued: () => Promise<void>,
): (intent: ScanIntent) => Promise<ScanEvent> {
  return async (intent) => {
    if (intent.kind !== 'issueOrder') {
      return { type: 'failed', text: 'Неподдерживаемый шаг сканирования.' };
    }
    try {
      const result = await client.post<{
        orderNumber: string;
        issued: number;
        total: number;
        unchanged: boolean;
        routeActivated: boolean;
      }>(`/api/warehouse/routes/${routeId}/issue`, { orderNumber: intent.orderNumber });
      await onIssued();
      return {
        type: 'succeeded',
        text: result.unchanged
          ? `Заказ ${result.orderNumber} уже был выдан: ${result.issued} из ${result.total}`
          : `Заказ ${result.orderNumber} выдан: ${result.issued} из ${result.total}`,
        progress: { done: result.issued, total: result.total },
        final: result.routeActivated,
      };
    } catch (error) {
      return { type: 'failed', text: failureText(error, 'Не удалось выдать заказ.') };
    }
  };
}

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

  function submitCell(allowRouteCell?: boolean): void {
    if (scanned === null || cellInput.trim() === '') {
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
              <Button
                variant="ghost"
                data-testid="wh-scan-reset"
                onClick={() => {
                  setScanned(null);
                  setCellInput('');
                }}
              >
                Отменить
              </Button>
            </div>

            {scanned.blockedBy.length > 0 && (
              <p className="field__error" role="alert" data-testid="wh-order-blocked">
                {scanned.blockedBy.map(blockLabel).join('; ')}. Разместить заказ можно, но
                комплектование и выдача заблокированы.
              </p>
            )}

            {scanned.route !== null && (
              <p className="muted text-sm" data-testid="wh-order-route">
                Заказ входит в подтверждённый лист {scanned.route.number}
                {scanned.route.routeCell === null
                  ? '. Маршрутная ячейка ещё не привязана.'
                  : `. Маршрутная ячейка: ${scanned.route.routeCell.code}.`}
              </p>
            )}

            <ScanField
              label="Ячейка"
              hint={SCAN_HINTS.CELL}
              value={cellInput}
              onChange={setCellInput}
              onSubmit={() => submitCell()}
              autoFocus
              testId="wh-scan-cell"
              disabled={receive.isPending}
            />

            <div className="row">
              <Button
                variant="primary"
                data-testid="wh-place"
                disabled={receive.isPending || cellInput.trim() === ''}
                onClick={() => submitCell()}
              >
                {receive.isPending ? 'Сохраняем…' : 'Положить в ячейку'}
              </Button>
              {scanned.route !== null && (
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
          <PlacementTable items={placements.data.items} />
        )}
      </div>
    </>
  );
}

function PlacementTable({ items }: { items: PlacedOrderView[] }): React.JSX.Element {
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Вкладки «Сборка» и «Выдача» ---------------------------------------------

interface CourierOption {
  id: string;
  fullName: string;
}

function RouteTab({ mode }: { mode: 'picking' | 'issue' }): React.JSX.Element {
  const { client, user } = useAuth();
  // Отмена выдачи — операция администратора (`FUL-003`). Кладовщик её не видит:
  // скрытая кнопка не защита, но и предлагать заведомо запрещённое незачем.
  const isAdmin = user?.roles.includes('ADMIN') === true;
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const reportError = useApiError();

  const [date, setDate] = useState(moscowToday());
  const [routeId, setRouteId] = useState<string | null>(null);
  const [cellInput, setCellInput] = useState('');
  const [orderInput, setOrderInput] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [nextCourier, setNextCourier] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  /**
   * Подтверждённый заказ незавершённой пары комплектования.
   *
   * Ручной и аппаратный путь обязаны требовать ту же пару «заказ → ячейка»,
   * что и камера: иначе автоподстановка кода ячейки из карточки обошла бы
   * физическое подтверждение, ради которого пара и введена.
   */
  const [pickOrder, setPickOrder] = useState<string | null>(null);
  const [pickCellInput, setPickCellInput] = useState('');
  const [scanning, setScanning] = useState(false);

  const routes = useQuery({
    queryKey: ['warehouse-routes', date],
    queryFn: () =>
      client.get<{ items: RouteSummary[] }>(`/api/warehouse/routes?deliveryDate=${date}`),
  });

  const route = useQuery({
    queryKey: ['warehouse-route', routeId],
    queryFn: () => client.get<RouteFlowView>(`/api/warehouse/routes/${routeId ?? ''}`),
    enabled: routeId !== null,
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['warehouse-route'] });
    await queryClient.invalidateQueries({ queryKey: ['warehouse-routes'] });
    await queryClient.invalidateQueries({ queryKey: ['warehouse-placements'] });
  };

  const bindCell = useMutation({
    mutationFn: () =>
      client.put<{ cellCode: string }>(`/api/warehouse/routes/${routeId ?? ''}/cell`, {
        cellCode: cellInput,
      }),
    onSuccess: async (result) => {
      setCellInput('');
      await refresh();
      showToast(`Маршрутная ячейка ${result.cellCode} привязана`, 'success');
    },
    onError: (error: unknown) => reportError(error, 'Не удалось привязать ячейку.'),
  });

  /** Подтверждение первого скана: заказ обязан входить в выбранный лист. */
  const resolvePickOrder = useMutation({
    mutationFn: (number: string) =>
      client.get<ScanContext>(`/api/warehouse/scan/order?number=${encodeURIComponent(number)}`),
    onSuccess: (context) => {
      if (context.route === null || context.route.id !== routeId) {
        setOrderInput('');
        showToast('Этот заказ не входит в выбранный маршрутный лист.', 'error');
        return;
      }
      setPickOrder(context.orderNumber);
      setOrderInput('');
    },
    onError: (error: unknown) => {
      setOrderInput('');
      reportError(error, 'Не удалось распознать заказ.');
    },
  });

  const pick = useMutation({
    mutationFn: (pair: { orderNumber: string; cellCode: string }) =>
      client.post<{ orderNumber: string; picked: number; total: number }>(
        `/api/warehouse/routes/${routeId ?? ''}/pick`,
        pair,
      ),
    onSuccess: async (result) => {
      setPickOrder(null);
      setPickCellInput('');
      await refresh();
      showToast(`Заказ ${result.orderNumber}: ${result.picked} из ${result.total}`, 'success');
    },
    onError: (error: unknown) => {
      // Подтверждённый заказ остаётся: человек повторяет только скан ячейки.
      setPickCellInput('');
      reportError(error, 'Не удалось перенести заказ.');
    },
  });

  const confirmCourier = useMutation({
    mutationFn: (courierUserId: string) =>
      client.post(`/api/warehouse/routes/${routeId ?? ''}/courier`, { courierUserId }),
    onSuccess: async () => {
      await refresh();
      showToast('Курьер подтверждён', 'success');
    },
    onError: (error: unknown) => reportError(error, 'Не удалось подтвердить курьера.'),
  });

  const couriers = useQuery({
    queryKey: ['couriers-active'],
    queryFn: () =>
      client.get<{ items: CourierOption[] }>('/api/users?role=COURIER&status=ACTIVE&limit=100'),
    enabled: isAdmin && mode === 'issue',
  });

  const cancelIssue = useMutation({
    mutationFn: () =>
      client.post(`/api/warehouse/routes/${routeId ?? ''}/issue/cancel`, {
        reason: cancelReason,
        ...(nextCourier === '' ? {} : { nextCourierUserId: nextCourier }),
      }),
    onSuccess: async () => {
      setCancelOpen(false);
      setCancelReason('');
      setNextCourier('');
      await refresh();
      showToast('Выдача отменена', 'success');
    },
    onError: (error: unknown) => reportError(error, 'Не удалось отменить выдачу.'),
  });

  const issue = useMutation({
    mutationFn: () =>
      client.post<{ orderNumber: string; issued: number; total: number; routeActivated: boolean }>(
        `/api/warehouse/routes/${routeId ?? ''}/issue`,
        { orderNumber: orderInput },
      ),
    onSuccess: async (result) => {
      setOrderInput('');
      await refresh();
      showToast(
        result.routeActivated
          ? `Выдан последний заказ: маршрут передан курьеру`
          : `Заказ ${result.orderNumber} выдан: ${result.issued} из ${result.total}`,
        'success',
      );
    },
    onError: (error: unknown) => {
      setOrderInput('');
      reportError(error, 'Не удалось выдать заказ.');
    },
  });

  const view = route.data ?? null;

  if (scanning && routeId !== null && view !== null) {
    return (
      <ScannerScreen
        chain={mode === 'picking' ? 'PICK' : 'ISSUE'}
        operation={
          mode === 'picking'
            ? `Комплектование листа ${view.routeNumber}`
            : `Выдача листа ${view.routeNumber}`
        }
        onIntent={
          mode === 'picking'
            ? pickIntentHandler(client, routeId, refresh)
            : issueIntentHandler(client, routeId, refresh)
        }
        onClose={() => setScanning(false)}
      />
    );
  }

  return (
    <>
      <div className="card stack">
        <div className="row">
          <Field label="Дата доставки">
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                type="date"
                value={date}
                data-testid="wh-route-date"
                onChange={(event) => {
                  setDate(event.target.value);
                  setRouteId(null);
                }}
              />
            )}
          </Field>
        </div>

        {routes.isPending && <LoadingState title="Загружаем маршрутные листы…" />}
        {routes.isError && (
          <ErrorState
            description="Маршрутные листы не загрузились."
            onRetry={() => void routes.refetch()}
          />
        )}
        {routes.isSuccess && routes.data.items.length === 0 && (
          <EmptyState
            title="Подтверждённых листов на эту дату нет"
            description="Комплектование начинается после подтверждения маршрута логистом."
          />
        )}
        {routes.isSuccess && routes.data.items.length > 0 && (
          <div className="row">
            {routes.data.items.map((summary) => (
              <Button
                key={summary.routeId}
                variant={routeId === summary.routeId ? 'primary' : 'ghost'}
                data-testid="wh-route-button"
                data-route-number={summary.routeNumber}
                onClick={() => setRouteId(summary.routeId)}
              >
                {summary.routeNumber} ·{' '}
                {mode === 'picking'
                  ? `${summary.inRouteCell}/${summary.total}`
                  : `${summary.issued}/${summary.total}`}
                {summary.state === 'ACTIVE' ? ' · передан' : ''}
              </Button>
            ))}
          </div>
        )}
      </div>

      {view !== null && (
        <div className="card stack" data-testid="wh-route-card" data-route-state={view.state}>
          <div className="row">
            <div>
              <div className="field__label">Маршрутный лист</div>
              <strong>{view.routeNumber}</strong>
            </div>
            <div>
              <div className="field__label">Курьер</div>
              <span data-testid="wh-route-courier">{view.courier?.fullName ?? 'не назначен'}</span>
            </div>
            <div>
              <div className="field__label">Маршрутная ячейка</div>
              <span data-testid="wh-route-cell">{view.routeCell?.code ?? 'не привязана'}</span>
            </div>
            <div>
              <div className="field__label">{mode === 'picking' ? 'Скомплектовано' : 'Выдано'}</div>
              <span data-testid="wh-route-progress">
                {mode === 'picking'
                  ? `${pickProgress(view).picked} из ${pickProgress(view).total}`
                  : `${issueProgress(view).issued} из ${issueProgress(view).total}`}
              </span>
            </div>
          </div>

          {mode === 'picking' && view.state === 'CONFIRMED' && (
            <>
              {view.routeCell === null ? (
                <div className="stack">
                  <ScanField
                    label="Маршрутная ячейка"
                    hint="Отсканируйте QR маршрутной ячейки для этого листа"
                    value={cellInput}
                    onChange={setCellInput}
                    onSubmit={() => cellInput.trim() !== '' && bindCell.mutate()}
                    autoFocus
                    testId="wh-bind-cell"
                    disabled={bindCell.isPending}
                  />
                  <Button
                    variant="primary"
                    data-testid="wh-bind-submit"
                    disabled={bindCell.isPending || cellInput.trim() === ''}
                    onClick={() => bindCell.mutate()}
                  >
                    Привязать ячейку
                  </Button>
                </div>
              ) : (
                <div className="stack">
                  {/* Камера ведёт ту же пару, что и поля ниже. */}
                  <div className="row">
                    <Button
                      variant="primary"
                      data-testid="wh-pick-camera"
                      onClick={() => {
                        setPickOrder(null);
                        setPickCellInput('');
                        setScanning(true);
                      }}
                    >
                      Сканировать заказ
                    </Button>
                  </div>

                  {pickOrder === null ? (
                    <ScanField
                      label="Заказ"
                      hint="Отсканируйте заказ, затем — маршрутную ячейку"
                      value={orderInput}
                      onChange={setOrderInput}
                      onSubmit={() =>
                        orderInput.trim() !== '' && resolvePickOrder.mutate(orderInput)
                      }
                      autoFocus
                      testId="wh-pick-order"
                      disabled={resolvePickOrder.isPending}
                    />
                  ) : (
                    <div className="stack">
                      <div className="row">
                        <div>
                          <div className="field__label">Заказ</div>
                          <strong data-testid="wh-pick-scanned">{pickOrder}</strong>
                        </div>
                        <Button
                          variant="ghost"
                          data-testid="wh-pick-reset"
                          onClick={() => {
                            setPickOrder(null);
                            setPickCellInput('');
                          }}
                        >
                          Отменить
                        </Button>
                      </div>

                      {/* Код ячейки вводится или сканируется заново, а не
                          подставляется из карточки листа. */}
                      <ScanField
                        label="Маршрутная ячейка"
                        hint="Отсканируйте QR маршрутной ячейки этого листа"
                        value={pickCellInput}
                        onChange={setPickCellInput}
                        onSubmit={() =>
                          pickCellInput.trim() !== '' &&
                          pick.mutate({ orderNumber: pickOrder, cellCode: pickCellInput })
                        }
                        autoFocus
                        testId="wh-pick-cell"
                        disabled={pick.isPending}
                      />
                      <Button
                        variant="primary"
                        data-testid="wh-pick-submit"
                        disabled={pick.isPending || pickCellInput.trim() === ''}
                        onClick={() =>
                          pick.mutate({ orderNumber: pickOrder, cellCode: pickCellInput })
                        }
                      >
                        Перенести в маршрутную ячейку
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {mode === 'issue' && view.state === 'CONFIRMED' && (
            <>
              {view.issueSession === null ? (
                <div className="stack">
                  <p className="muted text-sm">
                    Подтвердите назначенного курьера: без подтверждения выдать заказы нельзя.
                  </p>
                  <Button
                    variant="primary"
                    data-testid="wh-confirm-courier"
                    disabled={view.courier === null || confirmCourier.isPending}
                    onClick={() => view.courier !== null && confirmCourier.mutate(view.courier.id)}
                  >
                    Курьер {view.courier?.fullName ?? '—'} подтверждён
                  </Button>
                </div>
              ) : (
                <div className="stack">
                  {/* Одна сессия на весь оставшийся лист: камера не закрывается
                      между заказами, курьер стоит рядом. */}
                  <div className="row">
                    <Button
                      variant="primary"
                      data-testid="wh-issue-camera"
                      onClick={() => setScanning(true)}
                    >
                      Начать сканирование заказов
                    </Button>
                  </div>

                  <ScanField
                    label="Заказ"
                    hint="Сканируйте заказы по одному"
                    value={orderInput}
                    onChange={setOrderInput}
                    onSubmit={() => orderInput.trim() !== '' && issue.mutate()}
                    autoFocus
                    testId="wh-issue-order"
                    disabled={issue.isPending}
                  />
                  <Button
                    variant="primary"
                    data-testid="wh-issue-submit"
                    disabled={issue.isPending || orderInput.trim() === ''}
                    onClick={() => issue.mutate()}
                  >
                    Выдать заказ
                  </Button>

                  {isAdmin && !cancelOpen && (
                    <Button
                      variant="ghost"
                      data-testid="wh-cancel-issue"
                      onClick={() => setCancelOpen(true)}
                    >
                      Отменить выдачу
                    </Button>
                  )}

                  {isAdmin && cancelOpen && (
                    <div className="stack">
                      <p className="muted text-sm">
                        Уже выданные заказы остаются в истории и у прежнего курьера. Невыданные
                        останутся лежать там, где лежат: система не переносит их сама.
                      </p>
                      <Field label="Причина отмены" hint="От 3 до 500 символов">
                        {(fieldProps) => (
                          <TextInput
                            {...fieldProps}
                            data-testid="wh-cancel-reason"
                            value={cancelReason}
                            onChange={(event) => setCancelReason(event.target.value)}
                          />
                        )}
                      </Field>
                      <Field
                        label="Передать остаток курьеру"
                        hint="Необязательно: без выбора назначение маршрута не меняется"
                      >
                        {(fieldProps) => (
                          <Select
                            {...fieldProps}
                            data-testid="wh-cancel-courier"
                            value={nextCourier}
                            onChange={(event) => setNextCourier(event.target.value)}
                          >
                            <option value="">Оставить прежнего</option>
                            {(couriers.data?.items ?? []).map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.fullName}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <div className="row">
                        <Button
                          variant="primary"
                          data-testid="wh-cancel-submit"
                          disabled={cancelIssue.isPending || cancelReason.trim().length < 3}
                          onClick={() => cancelIssue.mutate()}
                        >
                          Подтвердить отмену
                        </Button>
                        <Button variant="ghost" onClick={() => setCancelOpen(false)}>
                          Не отменять
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {view.state === 'ACTIVE' && (
            <p className="muted text-sm" data-testid="wh-route-active">
              Маршрут передан курьеру и стал активным. Маршрутная ячейка освобождена.
            </p>
          )}

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>№</th>
                  <th>Заказ</th>
                  <th>Ячейка</th>
                  <th>Состояние</th>
                </tr>
              </thead>
              <tbody>
                {view.orders.map((order) => (
                  <tr
                    key={order.orderId}
                    data-testid="wh-route-order"
                    data-order={order.orderNumber}
                  >
                    <td className="muted">{order.position}</td>
                    <td>
                      <strong>{order.orderNumber}</strong>
                    </td>
                    <td>{cellLabel(order)}</td>
                    <td>
                      {order.issued ? (
                        <StatusBadge tone="success">Выдан</StatusBadge>
                      ) : order.inRouteCell ? (
                        <StatusBadge tone="info">В маршрутной ячейке</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">
                          {issueBlocker(order) ?? 'В хранении'}
                        </StatusBadge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
