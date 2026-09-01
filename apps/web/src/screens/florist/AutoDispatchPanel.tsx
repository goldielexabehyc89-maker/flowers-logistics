/**
 * Панель авто-раздачи на рабочем месте флориста.
 *
 * В режиме AUTO свободной очереди у флориста нет — сервер её не отдаёт. Вместо
 * выбора заказа человек нажимает «Готов к заказам» и ждёт назначения. Панель
 * показывает ровно три вещи: готов ли он, что ему назначено сейчас и сколько
 * заказов ждёт раздачи.
 *
 * НИ ОДНА КНОПКА ЗДЕСЬ НЕ ЯВЛЯЕТСЯ ЗАЩИТОЙ. Право на «Готов», на отказ и на
 * «Закончить после текущего» проверяет сервер; подписи и блокировки кнопок
 * лишь показывают человеку, что сейчас имеет смысл, и повторяют серверные
 * причины, а не заменяют их.
 */

import { useState } from 'react';
import { Button, Field, Modal, Select, StatusBadge, TextArea } from '../../ui/components';
import {
  REFUSAL_REASONS,
  REFUSAL_REASON_LABELS,
  dispatchStateLabel,
  type FloristDispatchStatus,
  type RefusalReason,
} from './florist';

export interface AutoDispatchPanelProps {
  status: FloristDispatchStatus;
  /** Любое действие готовности/завершения выполняется — кнопки заблокированы. */
  pending: boolean;
  refusalPending: boolean;
  onToggleReady: (ready: boolean) => void;
  onToggleFinish: (value: boolean) => void;
  onOpenOrder: (orderId: string) => void;
  onRequestRefusal: (input: {
    orderId: string;
    reason: RefusalReason;
    comment: string | null;
  }) => void;
}

export function AutoDispatchPanel({
  status,
  pending,
  refusalPending,
  onToggleReady,
  onToggleFinish,
  onOpenOrder,
  onRequestRefusal,
}: AutoDispatchPanelProps): React.JSX.Element {
  const [refusalOpen, setRefusalOpen] = useState(false);
  const [reason, setReason] = useState<RefusalReason>('INSUFFICIENT_GOODS');
  const [comment, setComment] = useState('');

  const { activeOrder } = status;
  // «Другое» без пояснения сервер отклонит — не даём отправить и здесь.
  const commentRequired = reason === 'OTHER';
  const commentMissing = commentRequired && comment.trim() === '';

  function submitRefusal(): void {
    if (activeOrder === null || commentMissing) {
      return;
    }
    onRequestRefusal({
      orderId: activeOrder.id,
      reason,
      comment: comment.trim() === '' ? null : comment.trim(),
    });
    setRefusalOpen(false);
    setComment('');
    setReason('INSUFFICIENT_GOODS');
  }

  return (
    <section className="card stack florist-auto" data-testid="florist-auto">
      <div className="florist-auto__head">
        <div>
          <h3 className="florist-auto__title">Автоматическая раздача</h3>
          <p className="muted text-sm" data-testid="florist-auto-state">
            {dispatchStateLabel(status)}
          </p>
        </div>
        <StatusBadge tone={status.ready && status.activeOrder === null ? 'success' : 'neutral'}>
          {status.ready ? 'Готов' : 'Не готов'}
        </StatusBadge>
      </div>

      {/*
        Готовность.

        Требует активной смены — так же, как ручная сборка. Пока смены нет,
        кнопка показывает причину, а не молча отправляет запрос, который
        сервер отклонит.
      */}
      <div className="florist-auto__ready">
        <Button
          variant={status.ready ? 'secondary' : 'primary'}
          data-testid="florist-auto-ready"
          disabled={pending || !status.hasActiveShift}
          onClick={() => onToggleReady(!status.ready)}
        >
          {status.ready ? 'Не готов к заказам' : 'Готов к заказам'}
        </Button>
        <span className="florist-auto__waiting" data-testid="florist-auto-waiting">
          Ждут раздачи: <strong>{status.waitingCount}</strong>
        </span>
      </div>

      {/*
        «Закончить после текущего».

        Не обрывает работу: текущий заказ остаётся, новых автоназначений
        больше не будет. Показывается только когда есть что заканчивать —
        готов или уже собирает заказ.
      */}
      {(status.ready || activeOrder !== null) && (
        <label className="florist-auto__finish">
          <input
            type="checkbox"
            checked={status.finishAfterCurrent}
            disabled={pending}
            data-testid="florist-auto-finish"
            onChange={(event) => onToggleFinish(event.target.checked)}
          />
          <span>Закончить после текущего заказа</span>
        </label>
      )}

      {/* Текущее назначение: карточка открывается кнопкой, как в очереди. */}
      {activeOrder !== null && (
        <div className="florist-auto__order" data-testid="florist-auto-order">
          <div className="florist-auto__order-main">
            <span className="florist__number">{activeOrder.number}</span>
            {activeOrder.reassembly && <StatusBadge tone="warning">Пересборка</StatusBadge>}
            {status.pendingRefusal && <StatusBadge tone="info">Отказ на решении</StatusBadge>}
          </div>
          <div className="florist-auto__order-actions">
            <Button variant="secondary" onClick={() => onOpenOrder(activeOrder.id)}>
              Просмотр
            </Button>
            <Button
              variant="ghost"
              data-testid="florist-auto-refusal"
              disabled={status.pendingRefusal || refusalPending}
              onClick={() => setRefusalOpen(true)}
            >
              {status.pendingRefusal ? 'Отказ отправлен' : 'Отказаться'}
            </Button>
          </div>
        </div>
      )}

      <Modal
        open={refusalOpen}
        title="Отказ от заказа"
        testId="florist-refusal-modal"
        onClose={() => setRefusalOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRefusalOpen(false)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              data-testid="florist-refusal-submit"
              disabled={refusalPending || commentMissing}
              onClick={submitRefusal}
            >
              Отправить руководителю
            </Button>
          </>
        }
      >
        <div className="stack">
          <p className="muted text-sm">
            Заказ останется за вами, пока руководитель не примет решение. Причина обязательна.
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
    </section>
  );
}
