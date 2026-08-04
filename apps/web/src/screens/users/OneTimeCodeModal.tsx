/**
 * Показ одноразового кода.
 *
 * Код показывается ровно один раз и живёт только в state этого окна. Он не попадает
 * в кэш запросов, хранилище, URL, логи и service worker: восстановить его нельзя,
 * при утере выполняется перевыпуск.
 */

import { useState } from 'react';
import { Button, Modal } from '../../ui/components';

export interface OneTimeCode {
  code: string;
  expiresAt: string;
  personName: string;
  reason: 'created' | 'reissued' | 'pin-reset';
}

const REASON_TEXT: Record<OneTimeCode['reason'], string> = {
  created: 'Сотрудник создан. Передайте ему код для первого входа.',
  reissued: 'Код активации перевыпущен. Предыдущий код больше не действует.',
  'pin-reset': 'PIN сброшен. Сотрудник войдёт по новому коду и задаст новый PIN.',
};

export function OneTimeCodeModal({
  value,
  onClose,
}: {
  value: OneTimeCode | null;
  onClose: () => void;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    if (value === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value.code);
      setCopied(true);
    } catch {
      // Буфер обмена может быть недоступен: код виден на экране и его можно переписать.
      setCopied(false);
    }
  };

  const handleClose = (): void => {
    setCopied(false);
    onClose();
  };

  return (
    <Modal
      open={value !== null}
      title="Одноразовый код"
      onClose={handleClose}
      // Закрытие только явной кнопкой: случайный Escape потерял бы код безвозвратно.
      dismissible={false}
      footer={
        <Button variant="primary" onClick={handleClose}>
          Я сохранил код
        </Button>
      }
    >
      {value !== null && (
        <div className="stack">
          <p>{REASON_TEXT[value.reason]}</p>

          <div>
            <div className="field__label">Сотрудник</div>
            <div>{value.personName}</div>
          </div>

          <div>
            <div className="field__label">Код</div>
            <div className="one-time-code" aria-live="polite">
              {value.code}
            </div>
          </div>

          <div className="row">
            <Button onClick={() => void handleCopy()}>Скопировать</Button>
            {copied && <span className="text-sm muted">Скопировано</span>}
          </div>

          <p className="text-sm muted">
            Код действует 30 минут и показывается только сейчас. После закрытия окна он не будет
            доступен нигде — ни в списке, ни в истории. При утере выполните перевыпуск кода.
          </p>
        </div>
      )}
    </Modal>
  );
}
