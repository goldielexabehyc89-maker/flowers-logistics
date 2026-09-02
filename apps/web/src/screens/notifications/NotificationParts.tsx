/**
 * Общие части вкладки «Уведомления»: тело уведомления и диалог пересборки.
 *
 * Используются и в списке вкладки, и во всплывающем окне, чтобы одно и то же
 * уведомление показывалось одинаково.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMoscowDateTime } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import { Button, Modal } from '../../ui/components';
import {
  hasCompositionChange,
  orderStateLabel,
  refusalReasonLabel,
  refusalStateLabel,
  resolutionKindLabel,
  sourceLabel,
  LOGIST_TASK_ESCALATION_KIND,
  type NotificationView,
} from './notifications';
import './notifications.css';

/** Тело уведомления: что изменилось (старое → новое) и где заказ сейчас. */
export function NotificationBody({ item }: { item: NotificationView }): React.JSX.Element {
  /*
   * Эскалация задачи логиста: логист не отреагировал более 30 минут. Своя форма
   * (нет полей/состава); показывается раньше остального.
   */
  if (item.kind === LOGIST_TASK_ESCALATION_KIND) {
    const payload = item.payload as unknown as { taskKind?: string };
    const taskKind = typeof payload.taskKind === 'string' ? payload.taskKind : '';
    return (
      <div className="stack stack--tight" data-testid="notif-escalation">
        <div className="notif__field-label">Реакция логиста просрочена</div>
        <p>
          Логист не реагирует на задачу «{resolutionKindLabel(taskKind)}» по заказу{' '}
          <strong>{item.orderNumber}</strong> более 30 минут.
        </p>
        <div className="notif__state" data-testid="notif-state">
          <span className="notif__field-label">Сейчас</span> {orderStateLabel(item.currentState)}
        </div>
      </div>
    );
  }
  /*
   * Запрос отказа — не изменение полей заказа, а обращение флориста. У него
   * своя форма: кто отказывается, по какой причине, с каким комментарием и чем
   * закончилось. Поэтому рисуется отдельно и раньше, чем поля/состав: их у
   * такого уведомления нет вовсе.
   */
  if (item.refusal !== null) {
    const refusal = item.refusal;
    return (
      <div className="stack stack--tight" data-testid="notif-refusal">
        <div className="muted text-sm">
          {sourceLabel(item.source)} · {formatMoscowDateTime(item.occurredAt)}
        </div>
        <div className="notif__field">
          <span className="notif__field-label">Флорист</span>
          <span>{refusal.floristName}</span>
        </div>
        <div className="notif__field">
          <span className="notif__field-label">Причина</span>
          <span>{refusalReasonLabel(refusal.reason)}</span>
        </div>
        {refusal.comment !== null && refusal.comment.trim() !== '' && (
          <div className="notif__field">
            <span className="notif__field-label">Комментарий</span>
            <span>{refusal.comment}</span>
          </div>
        )}
        <div className="notif__state" data-testid="notif-state">
          <span className="notif__field-label">Сейчас</span> {orderStateLabel(item.currentState)}
        </div>
        {refusal.state !== 'PENDING' && (
          <div className="notif__decision" data-testid="notif-refusal-decision">
            {refusalStateLabel(refusal.state)}
            {refusal.decidedByName === null ? '' : ` (решение: ${refusal.decidedByName})`}
          </div>
        )}
      </div>
    );
  }

  const composition = item.payload.composition;
  return (
    <div className="stack stack--tight">
      <div className="muted text-sm">
        {sourceLabel(item.source)} · {formatMoscowDateTime(item.occurredAt)}
      </div>

      {item.payload.fields.length > 0 && (
        <ul className="notif__fields">
          {item.payload.fields.map((field) => (
            <li key={field.category} className="notif__field">
              <span className="notif__field-label">{field.label}</span>
              <span className="notif__field-change">
                <span className="notif__old">{field.old ?? '—'}</span>
                {' → '}
                <span className="notif__new">{field.new ?? '—'}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {hasCompositionChange(composition) && composition !== null && (
        <div className="notif__composition" data-testid="notif-composition">
          <span className="notif__field-label">Состав заказа</span>
          <ul className="notif__diff">
            {composition.added.map((line) => (
              <li key={`a-${line.name}`} className="notif__diff-add">
                + {line.name} · {line.quantity}
              </li>
            ))}
            {composition.removed.map((line) => (
              <li key={`r-${line.name}`} className="notif__diff-remove">
                − {line.name} · {line.quantity}
              </li>
            ))}
            {composition.quantityChanged.map((line) => (
              <li key={`q-${line.name}`}>
                {line.name}: {line.old} → {line.new}
              </li>
            ))}
            {composition.parameterChanged.map((line) => (
              <li key={`p-${line.name}`}>{line.name}: изменена характеристика</li>
            ))}
          </ul>
        </div>
      )}

      <div className="notif__state" data-testid="notif-state">
        <span className="notif__field-label">Сейчас</span> {orderStateLabel(item.currentState)}
      </div>

      {item.decision !== null && (
        <div className="notif__decision" data-testid="notif-decision">
          На пересборку: {item.decision.assignedFloristName} (решение: {item.decision.decidedByName}
          )
        </div>
      )}
    </div>
  );
}

interface Florist {
  id: string;
  fullName: string;
  openAssignments: number;
}

/**
 * Диалог назначения пересборки: выбор флориста и подтверждение с номером
 * заказа, выбранным флористом и текущим физическим состоянием заказа.
 */
export function ReassemblyDialog({
  item,
  onClose,
}: {
  item: NotificationView;
  onClose: () => void;
}): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [floristId, setFloristId] = useState<string>('');

  const florists = useQuery({
    queryKey: ['notifications-florists'],
    queryFn: () => client.get<{ items: Florist[] }>('/api/logistics/notifications/florists'),
  });

  const chosen = florists.data?.items.find((florist) => florist.id === floristId) ?? null;

  const assign = useMutation({
    mutationFn: () =>
      client.post<{ assignedFloristName: string; assemblyRound: number }>(
        `/api/logistics/notifications/${item.id}/reassembly`,
        { floristId },
      ),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications-count'] });
      showToast(
        `Пересборка ${item.orderNumber} назначена: ${result.assignedFloristName}`,
        'success',
      );
      onClose();
    },
    onError: (error: unknown) => {
      showToast(
        error instanceof ApiError ? error.message : 'Не удалось назначить пересборку.',
        'error',
      );
    },
  });

  return (
    <Modal open title={`Пересборка заказа ${item.orderNumber}`} onClose={onClose}>
      <div className="stack">
        <p className="muted text-sm">
          Заказ сейчас: {orderStateLabel(item.currentState)}. Назначение пересборки не снимает заказ
          с ячейки, из маршрута и от курьера — физическое состояние не меняется.
        </p>

        {florists.isError ? (
          <p className="field__error">Не удалось загрузить флористов.</p>
        ) : (
          <label className="stack stack--tight">
            <span className="field__label">Флорист</span>
            <select
              className="input"
              data-testid="reassembly-florist"
              value={floristId}
              onChange={(event) => setFloristId(event.target.value)}
            >
              <option value="">— выберите флориста на смене —</option>
              {(florists.data?.items ?? []).map((florist) => (
                <option key={florist.id} value={florist.id}>
                  {florist.fullName} · в работе: {florist.openAssignments}
                </option>
              ))}
            </select>
          </label>
        )}

        {chosen !== null && (
          <p className="text-sm" data-testid="reassembly-confirm">
            Пересобрать заказ <strong>{item.orderNumber}</strong> — назначить{' '}
            <strong>{chosen.fullName}</strong>.
          </p>
        )}

        <div className="row">
          <Button
            variant="primary"
            data-testid="reassembly-assign"
            disabled={floristId === '' || assign.isPending}
            onClick={() => assign.mutate()}
          >
            Назначить пересборку
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Диалог решения по запросу отказа: Отклонить / Подтвердить отказ / Передать.
 *
 * Решают только ADMIN и SUPERVISOR — сервер проверяет роль, кнопка её не
 * заменяет. Решение глобальное и идемпотентное: первый решивший фиксирует
 * итог, второй руководитель увидит его уже принятым.
 *
 *  * «Отклонить» — заказ остаётся у флориста;
 *  * «Подтвердить отказ» — заказ возвращается в раздачу, тому же флористу
 *    в этой попытке не выдаётся;
 *  * «Передать другому» — заказ атомарно назначается выбранному флористу
 *    (появляется выбор со списком смен).
 */
export function RefusalDialog({
  item,
  onClose,
}: {
  item: NotificationView;
  onClose: () => void;
}): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [transferOpen, setTransferOpen] = useState(false);
  const [floristId, setFloristId] = useState<string>('');

  const florists = useQuery({
    queryKey: ['notifications-florists'],
    queryFn: () => client.get<{ items: Florist[] }>('/api/logistics/notifications/florists'),
    enabled: transferOpen,
  });

  const decide = useMutation({
    mutationFn: (input: { action: 'REJECT' | 'APPROVE' | 'TRANSFER'; floristId?: string }) =>
      client.post<{ state: string; alreadyDecided: boolean }>(
        `/api/logistics/notifications/${item.id}/refusal-decision`,
        input,
      ),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications-count'] });
      const message = result.alreadyDecided
        ? `Решение уже было принято: заказ ${item.orderNumber}`
        : `Решение по заказу ${item.orderNumber} сохранено`;
      showToast(message, 'success');
      onClose();
    },
    onError: (error: unknown) => {
      showToast(
        error instanceof ApiError ? error.message : 'Не удалось сохранить решение.',
        'error',
      );
    },
  });

  return (
    <Modal
      open
      title={`Отказ по заказу ${item.orderNumber}`}
      onClose={onClose}
      testId="refusal-dialog"
    >
      <div className="stack">
        <NotificationBody item={item} />

        {transferOpen ? (
          <>
            {florists.isError ? (
              <p className="field__error">Не удалось загрузить флористов.</p>
            ) : (
              <label className="stack stack--tight">
                <span className="field__label">Кому передать</span>
                <select
                  className="input"
                  data-testid="refusal-transfer-florist"
                  value={floristId}
                  onChange={(event) => setFloristId(event.target.value)}
                >
                  <option value="">— выберите флориста на смене —</option>
                  {(florists.data?.items ?? []).map((florist) => (
                    <option key={florist.id} value={florist.id}>
                      {florist.fullName} · в работе: {florist.openAssignments}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="row">
              <Button
                variant="primary"
                data-testid="refusal-transfer-confirm"
                disabled={floristId === '' || decide.isPending}
                onClick={() => decide.mutate({ action: 'TRANSFER', floristId })}
              >
                Передать
              </Button>
              <Button variant="ghost" onClick={() => setTransferOpen(false)}>
                Назад
              </Button>
            </div>
          </>
        ) : (
          <div className="row">
            <Button
              variant="secondary"
              data-testid="refusal-reject"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ action: 'REJECT' })}
            >
              Отклонить
            </Button>
            <Button
              variant="danger"
              data-testid="refusal-approve"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ action: 'APPROVE' })}
            >
              Подтвердить отказ
            </Button>
            <Button
              variant="primary"
              data-testid="refusal-transfer"
              disabled={decide.isPending}
              onClick={() => setTransferOpen(true)}
            >
              Передать другому
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
