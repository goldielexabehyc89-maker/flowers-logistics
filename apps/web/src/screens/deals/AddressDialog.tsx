/**
 * Правка адреса заказа.
 *
 * Показывает оба значения сразу — исходное из МоегоСклада и рабочее — потому
 * что решение о правке принимается именно их сравнением. Подсказки приходят
 * с нашего сервера: браузер не знает ни ключа DaData, ни её адреса.
 *
 * Отсутствие подсказок не ломает работу: логист вводит адрес руками, заказ
 * уходит на разрешение точки и остаётся в «Требует внимания», пока точки нет.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { formatMoscowDateTime } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { Button, Field, Modal, StatusBadge, TextInput } from '../../ui/components';
import type { DealCard } from './selection';

interface Suggestion {
  value: string;
  latMicro: number | null;
  lonMicro: number | null;
  exact: boolean;
}

interface SuggestResponse {
  suggestions: Suggestion[];
  available: boolean;
}

interface HistoryItem {
  id: string;
  action: string;
  occurredAt: string;
  oldAddress: string | null;
  newAddress: string | null;
  sourceAddress: string | null;
  actor: { id: string; fullName: string } | null;
}

const ACTION_LABELS: Record<string, string> = {
  LOCAL_ADDRESS_SET: 'Адрес исправлен',
  LOCAL_ADDRESS_CLEARED: 'Правка снята',
  SOURCE_CONFLICT_DETECTED: 'Источник изменился',
  CONFLICT_RESOLVED_KEEP_LOCAL: 'Оставлен локальный адрес',
  CONFLICT_RESOLVED_USE_SOURCE: 'Принят адрес МоегоСклада',
};

/** Короче трёх символов подсказка бессмысленна: столько же требует сервер. */
const MIN_QUERY = 3;
const DEBOUNCE_MS = 350;

interface AddressDialogProps {
  order: DealCard;
  onClose: () => void;
  onChanged: () => void;
}

export function AddressDialog({
  order,
  onClose,
  onChanged,
}: AddressDialogProps): React.JSX.Element {
  const { client } = useAuth();
  const [draft, setDraft] = useState(order.address ?? '');
  const [chosen, setChosen] = useState<Suggestion | null>(null);
  const [query, setQuery] = useState('');

  // Подсказки стоят денег на каждый символ, поэтому запрос уходит не на каждое
  // нажатие: пауза после ввода — это экономия квоты, а не украшение.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(draft), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  const suggestions = useQuery({
    queryKey: ['address-suggestions', query],
    enabled: query.trim().length >= MIN_QUERY,
    queryFn: () =>
      client.get<SuggestResponse>(
        `/api/orders/address-suggestions?query=${encodeURIComponent(query.trim())}`,
      ),
  });

  const history = useQuery({
    queryKey: ['address-history', order.id],
    queryFn: () => client.get<{ items: HistoryItem[] }>(`/api/orders/${order.id}/address-history`),
  });

  const save = useMutation({
    mutationFn: () =>
      client.put(`/api/orders/${order.id}/address`, {
        address: chosen?.value ?? draft.trim(),
        // Точка принимается только из точной подсказки: неточная привязка
        // в автоматику не допускается и уходит на проверку.
        point:
          chosen !== null && chosen.exact && chosen.latMicro !== null && chosen.lonMicro !== null
            ? { latMicro: chosen.latMicro, lonMicro: chosen.lonMicro }
            : null,
      }),
    onSuccess: onChanged,
  });

  const clear = useMutation({
    mutationFn: () => client.post(`/api/orders/${order.id}/address/clear`, {}),
    onSuccess: onChanged,
  });

  const resolve = useMutation({
    mutationFn: (decision: 'KEEP_LOCAL' | 'USE_SOURCE') =>
      client.post(`/api/orders/${order.id}/address/resolve-conflict`, { decision }),
    onSuccess: onChanged,
  });

  const available = suggestions.data?.available ?? true;

  return (
    <Modal open title={`Адрес заказа ${order.number}`} onClose={onClose}>
      <div className="stack" data-testid="address-dialog">
        <div>
          <div className="field__label">Адрес МоегоСклада</div>
          <div data-testid="address-source">{order.sourceAddress ?? '—'}</div>
        </div>
        <div>
          <div className="field__label">Рабочий адрес</div>
          <div data-testid="address-effective">{order.address ?? '—'}</div>
          {order.addressCorrected && <StatusBadge tone="info">Исправлено логистом</StatusBadge>}
        </div>

        {order.addressConflict && (
          <div className="stack" data-testid="address-conflict">
            <p>
              Адрес в МоемСкладе изменился, а локальная правка осталась. Выберите, какое значение
              рабочее: автоматически это решить нельзя — верными могут быть оба.
            </p>
            <div className="row">
              <Button onClick={() => resolve.mutate('KEEP_LOCAL')} data-testid="address-keep-local">
                Оставить локальный
              </Button>
              <Button onClick={() => resolve.mutate('USE_SOURCE')} data-testid="address-use-source">
                Использовать новый из МоегоСклада
              </Button>
            </div>
          </div>
        )}

        <Field
          label="Новый адрес"
          hint={
            available
              ? 'Выберите подсказку, чтобы сохранить точку сразу'
              : 'Подсказки недоступны: адрес сохранится, точка будет запрошена позже'
          }
        >
          {(props) => (
            <TextInput
              {...props}
              value={draft}
              data-testid="address-input"
              onChange={(event) => {
                setDraft(event.target.value);
                setChosen(null);
              }}
            />
          )}
        </Field>

        {suggestions.data !== undefined && suggestions.data.suggestions.length > 0 && (
          <ul className="stack" data-testid="address-suggestions">
            {suggestions.data.suggestions.map((item) => (
              <li key={item.value}>
                <button
                  type="button"
                  className="deals__link"
                  onClick={() => {
                    setChosen(item);
                    setDraft(item.value);
                  }}
                >
                  {item.value}
                  {item.exact ? ' · точка найдена' : ' · без точной привязки'}
                </button>
              </li>
            ))}
          </ul>
        )}

        {chosen !== null && chosen.exact && (
          <p className="muted text-sm" data-testid="address-preview">
            Предварительная точка: {(chosen.latMicro ?? 0) / 1_000_000},{' '}
            {(chosen.lonMicro ?? 0) / 1_000_000}
          </p>
        )}

        <div className="row">
          <Button
            variant="primary"
            data-testid="address-save"
            disabled={draft.trim() === '' || save.isPending}
            onClick={() => save.mutate()}
          >
            Сохранить адрес
          </Button>
          {order.addressCorrected && (
            <Button data-testid="address-clear" onClick={() => clear.mutate()}>
              Снять правку
            </Button>
          )}
        </div>

        <div>
          <div className="field__label">История адреса</div>
          <ul data-testid="address-history">
            {(history.data?.items ?? []).map((item) => (
              <li key={item.id} className="muted text-sm">
                {ACTION_LABELS[item.action] ?? item.action} ·{' '}
                {formatMoscowDateTime(item.occurredAt)}
                {item.actor !== null ? ` · ${item.actor.fullName}` : ' · синхронизация'}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
