/**
 * Ручное исправление интервала доставки.
 *
 * Редактируется ровно одно — время. Дата, адрес, получатель и комментарий
 * показаны только для того, чтобы логист видел, о каком заказе речь: их источник —
 * МойСклад, и менять их здесь нельзя.
 */

import { useState } from 'react';
import { Button, Field, Modal, TextInput } from '../../ui/components';
import {
  EMPTY_VALUE,
  effectiveInterval,
  formatDate,
  formatMinutes,
  parseMinutes,
  type OrderView,
} from './deals';

export interface IntervalModalProps {
  order: OrderView;
  error: string | null;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (values: { startMinute: number; endMinute: number }) => void;
}

export function IntervalModal({
  order,
  error,
  pending,
  onCancel,
  onSubmit,
}: IntervalModalProps): React.JSX.Element {
  const current = effectiveInterval(order.interval);
  const [start, setStart] = useState(
    order.interval.manualStartMinute === null
      ? ''
      : formatMinutes(order.interval.manualStartMinute),
  );
  const [end, setEnd] = useState(
    order.interval.manualEndMinute === null ? '' : formatMinutes(order.interval.manualEndMinute),
  );
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const startMinute = parseMinutes(start);
    const endMinute = parseMinutes(end);

    if (startMinute === null || endMinute === null) {
      setLocalError('Время указывается в формате ЧЧ:ММ, например 10:00.');
      return;
    }
    if (endMinute <= startMinute) {
      setLocalError('Окончание интервала должно быть позже начала.');
      return;
    }

    setLocalError(null);
    onSubmit({ startMinute, endMinute });
  };

  return (
    <Modal open title={`Интервал доставки · заказ ${order.number}`} onClose={onCancel}>
      <form className="stack" onSubmit={submit}>
        <dl className="deals__facts">
          <div>
            <dt>Дата</dt>
            <dd>{formatDate(order.deliveryDate)}</dd>
          </div>
          <div>
            <dt>В МоемСкладе</dt>
            <dd>{order.interval.raw ?? EMPTY_VALUE}</dd>
          </div>
          <div>
            <dt>Сейчас используется</dt>
            <dd>
              {current.text}
              {current.manual ? ' (исправлено вручную)' : ''}
            </dd>
          </div>
          <div>
            <dt>Адрес</dt>
            <dd>{order.address ?? EMPTY_VALUE}</dd>
          </div>
        </dl>

        <p className="text-sm muted">
          Исправление сохраняется только у нас и не отправляется в МойСклад. Следующая синхронизация
          его не затирает. Повторное исправление заменяет предыдущее.
        </p>

        <div className="deals__interval-inputs">
          <Field label="Начало">
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                value={start}
                onChange={(event) => setStart(event.target.value)}
                placeholder="10:00"
                inputMode="numeric"
                autoFocus
                required
              />
            )}
          </Field>
          <Field label="Окончание">
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                value={end}
                onChange={(event) => setEnd(event.target.value)}
                placeholder="14:00"
                inputMode="numeric"
                required
              />
            )}
          </Field>
        </div>

        {(localError ?? error) === null ? null : (
          <p className="field__error" role="alert">
            {localError ?? error}
          </p>
        )}

        <div className="modal__footer">
          <Button type="button" onClick={onCancel}>
            Отмена
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Сохраняем…' : 'Сохранить интервал'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
