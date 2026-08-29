/**
 * Администратор задаёт или меняет PIN сотрудника напрямую.
 *
 * Два поля: новый PIN и его повтор. Оба должны быть ровно четырьмя цифрами и
 * совпадать — это проверяется здесь, до отправки. Сам PIN не показывается после
 * сохранения и никуда, кроме тела запроса, не уходит: он живёт только в
 * состоянии этого окна и стирается при закрытии. В localStorage не пишется.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Field, Modal, TextInput } from '../../ui/components';

const FOUR_DIGITS = /^\d{4}$/;

export function SetPinModal({
  open,
  mode,
  employeeName,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  /** Задаём впервые или меняем существующий. */
  mode: 'set' | 'change';
  employeeName: string;
  busy: boolean;
  error: string | null;
  onSubmit: (pin: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  // При каждом открытии поля пусты: прежний ввод не переживает закрытие окна.
  useEffect(() => {
    if (open) {
      setPin('');
      setRepeat('');
      setLocalError(null);
    }
  }, [open]);

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (!FOUR_DIGITS.test(pin)) {
      setLocalError('PIN должен состоять ровно из четырёх цифр.');
      return;
    }
    if (pin !== repeat) {
      setLocalError('PIN и его повтор не совпадают.');
      return;
    }
    setLocalError(null);
    onSubmit(pin);
  };

  const shownError = localError ?? error;

  return (
    <Modal
      open={open}
      title={mode === 'set' ? 'Задать PIN' : 'Изменить PIN'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            form="set-pin-form"
            type="submit"
            data-testid="set-pin-submit"
          >
            Сохранить
          </Button>
        </>
      }
    >
      <form
        id="set-pin-form"
        className="stack"
        onSubmit={handleSubmit}
        noValidate
        data-testid="set-pin-modal"
      >
        <p className="text-muted">
          {mode === 'set' ? 'Новый PIN для' : 'Новый PIN заменит прежний у'} {employeeName}. Код
          сотруднику передавать не нужно.
        </p>
        <Field label="Новый PIN">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
              data-testid="set-pin-new"
              required
            />
          )}
        </Field>
        <Field label="Повторите PIN">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={repeat}
              onChange={(event) => setRepeat(event.target.value.replace(/\D/g, ''))}
              data-testid="set-pin-repeat"
              required
            />
          )}
        </Field>
        {shownError !== null && (
          <p className="form-error" role="alert" data-testid="set-pin-error">
            {shownError}
          </p>
        )}
      </form>
    </Modal>
  );
}
