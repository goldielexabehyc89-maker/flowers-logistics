/**
 * Рабочий экран «Самовывоз».
 *
 * Менеджер стоит у прилавка: покупатель пришёл, показал QR-код заказа со
 * своего телефона, менеджер сканирует его и отдаёт коробку. Поэтому главное
 * действие экрана одно и крупное — «Сканировать заказ», а очередь ниже
 * отвечает на второй вопрос дня: что вообще ждёт выдачи.
 *
 * Очередь НЕ привязана к дню: покупатель приходит когда придёт, и вчерашняя
 * коробка стоит на той же полке, что и завтрашняя. День — подпись и порядок,
 * а не отбор.
 *
 * Ручной ввод номера — исключение на случай нечитаемого кода, и разрешает его
 * администратор общей настройкой. Ни адреса, ни телефона, ни состава букета
 * здесь нет: сервер их не отдаёт, а покупатель уже стоит перед менеджером.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import type { ScanEvent, ScanIntent } from '../../scan/scan-machine';
import {
  assemblyLabel,
  blockerLabel,
  canIssue,
  cellLabel,
  dayLabel,
  primaryBlocker,
  printLabel,
  type PickupCard,
  type PickupIssuedView,
  type PickupQueueView,
} from './pickup';
import './pickup.css';

const QUEUE_KEY = ['pickup-day'];
const ISSUED_KEY = ['pickup-issued'];

export function PickupScreen(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [scanning, setScanning] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [numberInput, setNumberInput] = useState('');
  const [card, setCard] = useState<PickupCard | null>(null);
  /** Сколько страниц очереди уже показано. Продолжение, а не «все сразу». */
  const [cursors, setCursors] = useState<string[]>([]);

  function reportError(error: unknown, fallback: string): void {
    showToast(error instanceof ApiError ? error.message : fallback, 'error');
  }

  const queue = useQuery({
    queryKey: [...QUEUE_KEY, cursors.length],
    queryFn: () => {
      const cursor = cursors.at(-1);
      return client.get<PickupQueueView>(
        cursor === undefined
          ? '/api/pickup/orders'
          : `/api/pickup/orders?cursor=${encodeURIComponent(cursor)}`,
      );
    },
  });

  const issued = useQuery({
    queryKey: ISSUED_KEY,
    queryFn: () => client.get<PickupIssuedView>('/api/pickup/issued'),
  });

  const manualEntry = queue.data?.manualEntry ?? false;

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
    await queryClient.invalidateQueries({ queryKey: ISSUED_KEY });
  };

  const lookup = useMutation({
    mutationFn: (value: string) =>
      client.get<PickupCard>(`/api/pickup/scan?number=${encodeURIComponent(value)}`),
    onSuccess: (found) => {
      setCard(found);
      setNumberInput('');
    },
    onError: (error: unknown) => {
      setNumberInput('');
      reportError(error, 'Не удалось найти заказ.');
    },
  });

  const issue = useMutation({
    mutationFn: (input: { orderNumber: string; source: 'SCAN' | 'MANUAL' }) =>
      client.post<{ orderNumber: string; cellCode: string }>('/api/pickup/issues', input),
    onSuccess: async (result) => {
      setCard(null);
      setManualOpen(false);
      await refresh();
      showToast(`Заказ ${result.orderNumber} выдан покупателю`, 'success');
    },
    onError: async (error: unknown) => {
      // Карточка перезапрашивается: причина отказа могла появиться прямо сейчас
      // (заказ выдал другой менеджер, пришла отмена, коробку сняли с полки).
      reportError(error, 'Не удалось отметить выдачу.');
      if (card !== null) {
        lookup.mutate(card.orderNumber);
      }
      await refresh();
    },
  });

  return (
    <section className="stack">
      {/*
        Одно крупное действие вместо поля поиска: обычная работа за прилавком —
        это скан кода с телефона покупателя, а не набор номера руками.
      */}
      <div className="card stack">
        <Button
          variant="primary"
          className="pickup-scan"
          data-testid="pickup-scan"
          onClick={() => setScanning(true)}
        >
          Сканировать заказ
        </Button>

        {manualEntry && (
          <Button
            variant="ghost"
            data-testid="pickup-manual-open"
            onClick={() => setManualOpen((open) => !open)}
          >
            Ввести вручную
          </Button>
        )}

        {manualEntry && manualOpen && (
          <div className="stack" data-testid="pickup-manual">
            <Field label="Номер заказа" hint="Найдите заказ и подтвердите выдачу отдельной кнопкой">
              {(fieldProps) => (
                <TextInput
                  {...fieldProps}
                  value={numberInput}
                  autoFocus
                  data-testid="pickup-search"
                  disabled={lookup.isPending}
                  onChange={(event) => setNumberInput(event.target.value)}
                  onKeyDown={(event) => {
                    /*
                     * Enter ищет заказ и только. Выдача — отдельное нажатие:
                     * случайный Enter в поле не должен отдавать коробку.
                     */
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      if (numberInput.trim() !== '') {
                        lookup.mutate(numberInput);
                      }
                    }
                  }}
                />
              )}
            </Field>
            <Button
              data-testid="pickup-search-submit"
              disabled={lookup.isPending || numberInput.trim() === ''}
              onClick={() => lookup.mutate(numberInput)}
            >
              Найти
            </Button>
          </div>
        )}
      </div>

      {card !== null && (
        <div className="card stack" data-testid="pickup-card">
          <div className="row">
            <div>
              <div className="field__label">Заказ</div>
              <strong data-testid="pickup-card-number">{card.orderNumber}</strong>
            </div>
            <div>
              <div className="field__label">День</div>
              <span data-testid="pickup-card-day">{dayLabel(card)}</span>
            </div>
            <div>
              <div className="field__label">Ячейка</div>
              <strong data-testid="pickup-card-cell">{cellLabel(card)}</strong>
            </div>
            <div>
              <div className="field__label">Сборка</div>
              <StatusBadge tone="info">{assemblyLabel(card.assemblyState)}</StatusBadge>
            </div>
            <div>
              <div className="field__label">Печать</div>
              <span>{printLabel(card)}</span>
            </div>
            <Button variant="ghost" data-testid="pickup-card-close" onClick={() => setCard(null)}>
              Закрыть
            </Button>
          </div>

          {card.blockers.length > 0 && (
            <p className="field__error" role="alert" data-testid="pickup-card-blocked">
              {card.blockers.map(blockerLabel).join('; ')}.
            </p>
          )}

          {/*
            Ручная выдача существует только при разрешённом ручном вводе:
            обычный путь — скан, который выдаёт заказ сам.
          */}
          {canIssue(card) && manualEntry ? (
            <div className="row">
              <Button
                variant="primary"
                data-testid="pickup-issue"
                disabled={issue.isPending}
                onClick={() => issue.mutate({ orderNumber: card.orderNumber, source: 'MANUAL' })}
              >
                Выдать покупателю
              </Button>
            </div>
          ) : (
            <p className="muted text-sm">
              {canIssue(card)
                ? 'Отсканируйте QR-код заказа: ручная выдача выключена.'
                : `${primaryBlocker(card) ?? ''}: выдать нельзя.`}
            </p>
          )}
        </div>
      )}

      <div className="card stack">
        <div className="row">
          <h3>Ожидают выдачи</h3>
          <StatusBadge tone="info">
            <span data-testid="pickup-waiting-count">{queue.data?.total ?? 0}</span>
          </StatusBadge>
        </div>

        {queue.isPending ? (
          <LoadingState title="Загружаем очередь…" />
        ) : queue.isError ? (
          <ErrorState title="Не удалось загрузить очередь" onRetry={() => void queue.refetch()} />
        ) : queue.data.items.length === 0 ? (
          <EmptyState
            title="Очередь пуста"
            description="Самовывозный заказ появится здесь сразу после импорта, ещё до приёмки на склад."
          />
        ) : (
          <ul className="pickup-queue">
            {queue.data.items.map((item) => (
              <li key={item.orderId}>
                {/*
                  Вся строка нажимается: за прилавком целятся в кнопку одной
                  рукой, держа коробку другой.
                */}
                <button
                  type="button"
                  className="pickup-row"
                  data-testid="pickup-waiting-row"
                  data-order-number={item.orderNumber}
                  onClick={() => setCard(item)}
                >
                  <span className="pickup-row__main">
                    <strong>{item.orderNumber}</strong>
                    <span className="muted text-sm">
                      {dayLabel(item)} · {cellLabel(item)}
                    </span>
                  </span>
                  <span className="pickup-row__badges">
                    <StatusBadge tone="info">{assemblyLabel(item.assemblyState)}</StatusBadge>
                    <StatusBadge tone={item.printedJobs > 0 ? 'success' : 'neutral'}>
                      {printLabel(item)}
                    </StatusBadge>
                    {item.blockers.length > 0 && (
                      <StatusBadge tone="warning">{primaryBlocker(item)}</StatusBadge>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {(() => {
          const next = queue.data?.nextCursor ?? null;
          return next === null ? null : (
            <Button data-testid="pickup-more" onClick={() => setCursors((all) => [...all, next])}>
              Показать ещё
            </Button>
          );
        })()}
        {cursors.length > 0 && (
          <Button variant="ghost" data-testid="pickup-first-page" onClick={() => setCursors([])}>
            В начало очереди
          </Button>
        )}
      </div>

      <div className="card stack">
        <h3>Выданы сегодня</h3>
        {(issued.data?.issued.length ?? 0) === 0 ? (
          <p className="muted text-sm">Сегодня ещё ничего не выдавали.</p>
        ) : (
          <ul className="pickup-queue">
            {(issued.data?.issued ?? []).map((item) => (
              <li key={item.orderId} className="pickup-row" data-testid="pickup-issued-row">
                <span className="pickup-row__main">
                  <strong>{item.orderNumber}</strong>
                  <span className="muted text-sm">Забран из ячейки {cellLabel(item)}</span>
                </span>
                <StatusBadge tone="success">Выдан</StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </div>

      {scanning && (
        <ScannerScreen
          chain="ISSUE"
          operation="Выдача покупателю"
          onIntent={async (intent: ScanIntent): Promise<ScanEvent> => {
            if (intent.kind !== 'issueOrder') {
              return { type: 'failed', text: 'Ожидался QR-код заказа.' };
            }
            try {
              /*
               * Скан САМ выдаёт заказ: отдельного подтверждения нет.
               *
               * Покупатель уже стоит перед менеджером, а сервер всё равно
               * проверяет отмену, способ получения и ячейку заново.
               */
              const result = await client.post<{ orderNumber: string }>('/api/pickup/issues', {
                orderNumber: intent.orderNumber,
                source: 'SCAN',
              });
              await refresh();
              return {
                type: 'succeeded',
                text: `Заказ ${result.orderNumber} выдан покупателю`,
                final: true,
              };
            } catch (error: unknown) {
              /*
               * Неизвестный номер — это чужой QR, а не сломанный заказ.
               *
               * «Заказ не найден» отправляет менеджера искать заказ, которого
               * не существует: к камере поднесли не тот код.
               */
              if (error instanceof ApiError && error.status === 404) {
                return { type: 'failed', text: 'Ожидался QR-код заказа.' };
              }
              return {
                type: 'failed',
                text: error instanceof ApiError ? error.message : 'Не удалось выдать заказ.',
              };
            }
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </section>
  );
}
