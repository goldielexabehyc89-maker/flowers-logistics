/**
 * Рабочий экран «Самовывоз» (этап 6.7).
 *
 * Менеджер работает у прилавка: покупатель уже пришёл, называет номер заказа,
 * менеджер находит коробку и отдаёт. Поэтому экран — это одно поле поиска,
 * одна карточка и одна кнопка, а не таблица с фильтрами.
 *
 * Поле работает и со сканером (он ведёт себя как клавиатура и заканчивает
 * ввод `Enter`), и с ручным вводом: сканер ломается чаще, чем заканчивается
 * рабочий день.
 *
 * Второго скана нет намеренно (`FUL-003` п.8): ни ячейки, ни документа
 * покупателя. Владелец решил, что номера заказа достаточно.
 *
 * Ни адреса, ни телефона, ни состава букета здесь нет — сервер их не отдаёт.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
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
import {
  assemblyLabel,
  blockerLabel,
  canIssue,
  cellLabel,
  primaryBlocker,
  printLabel,
  type PickupCard,
  type PickupDayView,
} from './pickup';

export function PickupScreen(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [numberInput, setNumberInput] = useState('');
  const [card, setCard] = useState<PickupCard | null>(null);

  function reportError(error: unknown, fallback: string): void {
    showToast(error instanceof ApiError ? error.message : fallback, 'error');
  }

  // Московский день считает сервер: параметр дня намеренно не передаётся.
  const day = useQuery({
    queryKey: ['pickup-day'],
    queryFn: () => client.get<PickupDayView>('/api/pickup/orders'),
  });

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
    mutationFn: (orderNumber: string) =>
      client.post<{ orderNumber: string; cellCode: string }>('/api/pickup/issues', { orderNumber }),
    onSuccess: async (result) => {
      setCard(null);
      await queryClient.invalidateQueries({ queryKey: ['pickup-day'] });
      showToast(`Заказ ${result.orderNumber} выдан покупателю`, 'success');
      inputRef.current?.focus();
    },
    onError: async (error: unknown) => {
      // Карточка перезапрашивается: причина отказа могла появиться прямо сейчас
      // (заказ выдал другой менеджер либо кладовщик забрал коробку с полки).
      reportError(error, 'Не удалось отметить выдачу.');
      if (card !== null) {
        lookup.mutate(card.orderNumber);
      }
      await queryClient.invalidateQueries({ queryKey: ['pickup-day'] });
    },
  });

  function submitNumber(): void {
    const value = numberInput.trim();
    if (value !== '') {
      lookup.mutate(value);
    }
  }

  return (
    <section className="stack">
      <div className="card stack">
        <div>
          <h2>Самовывоз</h2>
          <p className="muted text-sm">
            Выдача заказов покупателю по номеру. Скан ячейки и проверка документов не требуются.
          </p>
        </div>

        <Field label="Номер заказа" hint="Отсканируйте QR или введите номер и нажмите Enter">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              ref={inputRef}
              value={numberInput}
              autoFocus
              data-testid="pickup-search"
              disabled={lookup.isPending}
              onChange={(event) => setNumberInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitNumber();
                }
              }}
            />
          )}
        </Field>
        <div className="row">
          <Button
            variant="primary"
            data-testid="pickup-search-submit"
            disabled={lookup.isPending || numberInput.trim() === ''}
            onClick={submitNumber}
          >
            Найти
          </Button>
        </div>
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
              <span data-testid="pickup-card-day">{card.deliveryDate ?? 'не указан'}</span>
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
            <Button
              variant="ghost"
              data-testid="pickup-card-close"
              onClick={() => {
                setCard(null);
                inputRef.current?.focus();
              }}
            >
              Закрыть
            </Button>
          </div>

          {card.blockers.length > 0 && (
            <p className="field__error" role="alert" data-testid="pickup-card-blocked">
              {card.blockers.map(blockerLabel).join('; ')}.
            </p>
          )}

          {canIssue(card) ? (
            <div className="row">
              <Button
                variant="primary"
                data-testid="pickup-issue"
                disabled={issue.isPending}
                onClick={() => issue.mutate(card.orderNumber)}
              >
                Выдан покупателю
              </Button>
            </div>
          ) : (
            <p className="muted text-sm">{primaryBlocker(card)}: выдать нельзя.</p>
          )}
        </div>
      )}

      <div className="card stack">
        <h3>Ждут выдачи сегодня</h3>
        {day.isPending ? (
          <LoadingState title="Загружаем список…" />
        ) : day.isError ? (
          <ErrorState title="Не удалось загрузить список" onRetry={() => void day.refetch()} />
        ) : (day.data?.waiting.length ?? 0) === 0 ? (
          <EmptyState
            title="Готовых к выдаче самовывозов нет"
            description="Заказ появится здесь, когда кладовщик примет его на склад."
          />
        ) : (
          <ul className="routes__list">
            {(day.data?.waiting ?? []).map((item) => (
              <li key={item.orderId} className="routes__list-item" data-testid="pickup-waiting-row">
                <div>
                  <span className="routes__number">{item.orderNumber}</span>
                  <div className="muted text-sm">
                    Ячейка: {cellLabel(item)} · {assemblyLabel(item.assemblyState)} ·{' '}
                    {printLabel(item)}
                  </div>
                </div>
                <Button
                  onClick={() => {
                    setCard(item);
                  }}
                >
                  Открыть
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card stack">
        <h3>Выданы сегодня</h3>
        {(day.data?.issued.length ?? 0) === 0 ? (
          <p className="muted text-sm">Сегодня ещё ничего не выдавали.</p>
        ) : (
          <ul className="routes__list">
            {(day.data?.issued ?? []).map((item) => (
              <li key={item.orderId} className="routes__list-item" data-testid="pickup-issued-row">
                <div>
                  <span className="routes__number">{item.orderNumber}</span>
                  <div className="muted text-sm">Забран из ячейки {cellLabel(item)}</div>
                </div>
                <StatusBadge tone="success">Выдан</StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
