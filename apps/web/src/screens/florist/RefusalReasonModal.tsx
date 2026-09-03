/**
 * Единое окно выбора причины отказа флориста.
 *
 * Одна форма и один вызов на все точки входа: и кнопка «Отказаться» в панели
 * «Моя работа», и та же кнопка в открытой карточке заказа используют этот
 * компонент и отправляют отказ в один серверный endpoint `/refusal`. Второго
 * диалога и второго сценария отказа быть не должно.
 *
 * НЕ ЯВЛЯЕТСЯ ЗАЩИТОЙ. Право на отказ и его последствия решает сервер: «Нет
 * цветов» снимает заказ сразу (карантин «Решения»), остальные причины уходят на
 * согласование руководителю. Подписи здесь лишь показывают человеку, что будет.
 */

import { useState } from 'react';
import { Button, Field, Modal, Select, TextArea } from '../../ui/components';
import { REFUSAL_REASONS, REFUSAL_REASON_LABELS, type RefusalReason } from './florist';

export interface RefusalReasonModalProps {
  open: boolean;
  /** Идёт отправка отказа — кнопка заблокирована. */
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: { reason: RefusalReason; comment: string | null }) => void;
}

export function RefusalReasonModal({
  open,
  pending,
  onClose,
  onSubmit,
}: RefusalReasonModalProps): React.JSX.Element {
  const [reason, setReason] = useState<RefusalReason>('INSUFFICIENT_GOODS');
  const [comment, setComment] = useState('');

  // «Другое» без пояснения сервер отклонит — не даём отправить и здесь.
  const commentRequired = reason === 'OTHER';
  const commentMissing = commentRequired && comment.trim() === '';
  const noFlowers = reason === 'INSUFFICIENT_GOODS';

  function submit(): void {
    if (commentMissing) {
      return;
    }
    onSubmit({ reason, comment: comment.trim() === '' ? null : comment.trim() });
    setComment('');
    setReason('INSUFFICIENT_GOODS');
  }

  return (
    <Modal
      open={open}
      title="Отказ от заказа"
      testId="florist-refusal-modal"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            data-testid="florist-refusal-submit"
            disabled={pending || commentMissing}
            onClick={submit}
          >
            Отправить
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted text-sm" data-testid="florist-refusal-hint">
          {noFlowers
            ? 'Заказ будет сразу снят с вас и передан в «Самовывоз → Решения». Вы освободитесь и сможете получить следующий заказ.'
            : 'Заказ останется за вами, пока руководитель не примет решение. Причина обязательна.'}
        </p>
        <Field label="Причина">
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={reason}
              data-testid="florist-refusal-reason"
              onChange={(event) => setReason(event.target.value as RefusalReason)}
            >
              {REFUSAL_REASONS.map((value) => (
                <option key={value} value={value}>
                  {REFUSAL_REASON_LABELS[value]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Комментарий"
          hint={commentRequired ? 'Для причины «Другое» обязателен' : 'Необязательно'}
          error={commentMissing ? 'Опишите причину отказа' : undefined}
        >
          {(fieldProps) => (
            <TextArea
              {...fieldProps}
              rows={3}
              value={comment}
              data-testid="florist-refusal-comment"
              onChange={(event) => setComment(event.target.value)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}
