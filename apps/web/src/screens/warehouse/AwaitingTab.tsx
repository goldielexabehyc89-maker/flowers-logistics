/**
 * Вкладка склада «Ожидают приёмки».
 *
 * Показывает собранные флористом заказы, которых ещё нет на полке: их склад
 * должен принять. Это ЭКРАН — он ничего не разрешает и статусов не заводит.
 * «Принять» переиспользует ту же физическую приёмку, что и вкладка «Склад»
 * (`POST /api/warehouse/placements`): заказ и ячейка проверяются на сервере,
 * второго пути приёмки здесь нет.
 *
 * Модуль самодостаточен и НЕ импортирует ничего из `WarehouseScreen`: общий
 * ввод ячейки описан здесь же маленьким полем. Это убирает круговую зависимость
 * между экраном и вкладкой.
 *
 * Группировка по дате доставки и полный счётчик приходят с сервера; экран лишь
 * раскладывает уже упорядоченный список по заголовкам дат.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatMinutesOfDay,
  formatMoscowDateTime,
  moscowToday,
  shiftCalendarDate,
} from '@fl/shared';
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
import { assembledDateLabel } from '../florist/florist';

interface AwaitingCard {
  orderId: string;
  orderNumber: string;
  deliveryDate: string | null;
  isPickup: boolean;
  startMinute: number | null;
  endMinute: number | null;
  intervalKind: string;
  assembledAt: string | null;
  floristName: string | null;
  positionCount: number;
}

interface AwaitingResponse {
  total: number;
  items: AwaitingCard[];
}

interface ManualEntryProps {
  manualEntry: boolean;
}

/** Интервал заказа словами: диапазон, «к времени» или прочерк. */
function intervalLabel(card: AwaitingCard): string {
  if (card.startMinute !== null && card.endMinute !== null) {
    return `${formatMinutesOfDay(card.startMinute)}–${formatMinutesOfDay(card.endMinute)}`;
  }
  if (card.startMinute !== null) {
    return `к ${formatMinutesOfDay(card.startMinute)}`;
  }
  return 'интервал не указан';
}

/** Поле ввода кода ячейки: сканер-клавиатура вводит и подтверждает по Enter. */
function CellField({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!disabled) {
      ref.current?.focus();
    }
  }, [disabled]);
  return (
    <Field label="Ячейка хранения" hint="Отсканируйте или введите код ячейки">
      {(props) => (
        <TextInput
          {...props}
          ref={ref}
          value={value}
          disabled={disabled}
          autoComplete="off"
          data-testid="wh-awaiting-cell"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
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

interface DateGroup {
  key: string;
  label: string;
  items: AwaitingCard[];
}

/**
 * Раскладывает уже упорядоченный сервером список по датам доставки.
 *
 * Порядок групп сохраняется тем, что список пришёл отсортированным (даты по
 * возрастанию, без даты — в конце), поэтому группы строятся подряд и пустых
 * среди них не бывает.
 */
function groupByDate(items: AwaitingCard[], now: Date): DateGroup[] {
  const today = moscowToday(now);
  const tomorrow = shiftCalendarDate(today, 1);
  const groups: DateGroup[] = [];
  for (const card of items) {
    const key = card.deliveryDate ?? '—';
    const last = groups.at(-1);
    if (last !== undefined && last.key === key) {
      last.items.push(card);
    } else {
      groups.push({
        key,
        label: assembledDateLabel(card.deliveryDate, today, tomorrow),
        items: [card],
      });
    }
  }
  return groups;
}

export function AwaitingTab({ manualEntry }: ManualEntryProps): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [search, setSearch] = useState('');
  /** Заказ, который сейчас принимают: показывается поле ячейки. */
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [cellInput, setCellInput] = useState('');

  const term = search.trim();
  const awaiting = useQuery({
    queryKey: ['warehouse-awaiting', term],
    queryFn: () =>
      client.get<AwaitingResponse>(
        `/api/warehouse/awaiting${term === '' ? '' : `?search=${encodeURIComponent(term)}`}`,
      ),
  });

  const accept = useMutation({
    mutationFn: (input: { orderNumber: string; cellCode: string }) =>
      client.post<{ orderNumber: string; cellCode: string }>('/api/warehouse/placements', input),
    onSuccess: async (result) => {
      setAcceptingId(null);
      setCellInput('');
      await queryClient.invalidateQueries({ queryKey: ['warehouse-awaiting'] });
      await queryClient.invalidateQueries({ queryKey: ['warehouse-placements'] });
      showToast(`Заказ ${result.orderNumber} принят в ячейку ${result.cellCode}`, 'success');
    },
    onError: (error: unknown) => {
      // Заказ остаётся в списке: повторяется только ввод ячейки.
      setCellInput('');
      const message =
        error instanceof ApiError ? error.message : 'Не удалось принять заказ на склад.';
      showToast(message, 'error');
    },
  });

  const groups = useMemo(
    () => groupByDate(awaiting.data?.items ?? [], new Date()),
    [awaiting.data],
  );

  const submitCell = (orderNumber: string): void => {
    if (cellInput.trim() !== '') {
      accept.mutate({ orderNumber, cellCode: cellInput });
    }
  };

  return (
    <div className="stack" data-testid="wh-awaiting">
      <div className="card stack">
        <div>
          <h3>Ожидают приёмки</h3>
          <p className="muted text-sm">
            Собранные заказы, которых ещё нет на полке. «Принять» ставит заказ в ячейку тем же
            путём, что и «Склад».
          </p>
        </div>

        <input
          className="wh-search"
          type="search"
          inputMode="search"
          placeholder="Поиск по номеру заказа"
          aria-label="Поиск по номеру заказа"
          data-testid="wh-awaiting-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {awaiting.isPending ? (
        <LoadingState title="Загружаем список…" />
      ) : awaiting.isError ? (
        <ErrorState title="Не удалось загрузить список" onRetry={() => void awaiting.refetch()} />
      ) : (awaiting.data?.total ?? 0) === 0 ? (
        <EmptyState
          title="Пусто"
          description={
            term === ''
              ? 'Нет собранных заказов, ожидающих приёмки.'
              : 'По этому номеру ничего не найдено.'
          }
        />
      ) : (
        <div className="stack" data-testid="wh-awaiting-list">
          <p className="muted text-sm" data-testid="wh-awaiting-total">
            Всего: {awaiting.data.total}
          </p>
          {groups.map((group) => (
            <section key={group.key} className="card stack" data-awaiting-group={group.key}>
              <h4 className="wh-awaiting__date">{group.label}</h4>
              {group.items.map((card) => (
                <article
                  key={card.orderId}
                  className="wh-awaiting__card"
                  data-testid="wh-awaiting-card"
                  data-order-number={card.orderNumber}
                >
                  <div className="row">
                    <div className="stack stack--tight">
                      <strong>{card.orderNumber}</strong>
                      <div className="muted text-sm">
                        <StatusBadge tone={card.isPickup ? 'info' : 'neutral'}>
                          {card.isPickup ? 'Самовывоз' : 'Доставка'}
                        </StatusBadge>{' '}
                        · {intervalLabel(card)} · {card.positionCount} поз.
                      </div>
                      <div className="muted text-sm">
                        Собран:{' '}
                        {card.assembledAt === null ? '—' : formatMoscowDateTime(card.assembledAt)}
                        {card.floristName === null ? '' : ` · ${card.floristName}`}
                      </div>
                    </div>
                    {acceptingId !== card.orderId && (
                      <Button
                        variant="primary"
                        data-testid="wh-awaiting-accept"
                        disabled={accept.isPending}
                        onClick={() => {
                          setAcceptingId(card.orderId);
                          setCellInput('');
                        }}
                      >
                        Принять
                      </Button>
                    )}
                  </div>

                  {acceptingId === card.orderId && (
                    <div className="stack stack--tight">
                      {!manualEntry && (
                        <p className="muted text-sm" data-testid="wh-awaiting-scan-hint">
                          Ручной ввод выключен администратором — отсканируйте ячейку сканером.
                        </p>
                      )}
                      <CellField
                        value={cellInput}
                        onChange={setCellInput}
                        onSubmit={() => submitCell(card.orderNumber)}
                        disabled={accept.isPending}
                      />
                      <div className="row">
                        <Button
                          variant="primary"
                          data-testid="wh-awaiting-accept-confirm"
                          disabled={accept.isPending || cellInput.trim() === ''}
                          onClick={() => submitCell(card.orderNumber)}
                        >
                          Принять в ячейку
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setAcceptingId(null);
                            setCellInput('');
                          }}
                        >
                          Отмена
                        </Button>
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
