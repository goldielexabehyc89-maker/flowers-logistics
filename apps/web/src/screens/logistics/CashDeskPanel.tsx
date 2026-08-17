/**
 * «Касса логистов»: фактические наличные у конкретных людей.
 *
 * Экран отвечает на два вопроса: сколько денег у каждого логиста прямо сейчас
 * и как они там оказались. Всё, что показано в свёрнутой строке, считает
 * сервер по полному отбору — суммы, зависящие от прокрутки, итогом не являются.
 *
 * Логист видит только свою кассу; администратор видит все и обязан выбрать,
 * от имени какой кассы действует. Автор операции хранится отдельно от
 * владельца кассы: у владельца системы собственных наличных нет.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatMoscowDateTime } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  TextInput,
} from '../../ui/components';
import { formatDate } from '../routing/routing';
import { evaluateMoney, previewOf } from './money-calculator';

interface CashEntry {
  id: string;
  logistUserId: string;
  kind: string;
  amountMinor: string;
  operationDate: string;
  occurredAt: string;
  actorName: string | null;
  courierName: string | null;
  reason: string | null;
  reversed: boolean;
}

interface CashGroup {
  logistUserId: string;
  fullName: string;
  phone: string | null;
  openingMinor: string;
  receivedMinor: string;
  takenMinor: string;
  issuedMinor: string;
  handedMinor: string;
  closingMinor: string;
  entries: CashEntry[];
}

interface CashReport {
  summary: {
    cashOnHandMinor: string;
    expectedFromCouriersMinor: string;
    receivedMinor: string;
    takenMinor: string;
    issuedMinor: string;
    handedMinor: string;
    closingMinor: string;
  };
  days: { date: string; logists: CashGroup[] }[];
  totalGroups: number;
  hasMore: boolean;
  desks: { id: string; fullName: string; phone: string | null; balanceMinor: string }[];
}

const KIND_LABELS: Record<string, string> = {
  RECEIVED_FROM_COURIER: 'Получено от курьера',
  ISSUED_TO_COURIER: 'Выдано курьеру',
  TAKEN_FROM_COMPANY: 'Взято из компании',
  HANDED_TO_COMPANY: 'Сдано в компанию',
  ADJUSTMENT: 'Обратная корректировка',
};

/** Сколько групп «день + логист» показывать за раз. */
const GROUPS_PER_PAGE = 25;

/** Деньги показываются одинаково во всех разделах отчётов. */
function money(minor: string): string {
  const value = BigInt(minor);
  const positive = value < 0n ? -value : value;
  return `${(Number(positive) / 100).toFixed(2).replace('.', ',')} ₽`;
}

export interface CashDeskPanelProps {
  from: string;
  to: string;
}

export function CashDeskPanel({ from, to }: CashDeskPanelProps): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [logistUserId, setLogistUserId] = useState('');
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [pages, setPages] = useState(1);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  /** Открытый редактор движения между кассой и компанией. */
  const [editor, setEditor] = useState<{
    direction: 'TAKE' | 'HAND';
    deskId: string;
    /** Ключ открытого окна: повтор нажатия не удваивает движение кассы. */
    nonce: string;
  } | null>(null);
  const [amount, setAmount] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const desks = useQuery({
    queryKey: ['cash-desks'],
    queryFn: () => client.get<{ items: CashReport['desks'] }>('/api/logistics/cash/desks'),
  });

  const report = useQuery({
    queryKey: ['cash-report', from, to, logistUserId, kind, search, pages],
    queryFn: () => {
      const params = new URLSearchParams({
        from,
        to,
        limit: String(GROUPS_PER_PAGE * pages),
        offset: '0',
      });
      if (logistUserId !== '') {
        params.set('logistUserId', logistUserId);
      }
      if (kind !== '') {
        params.set('kind', kind);
      }
      if (search.trim() !== '') {
        params.set('search', search.trim());
      }
      return client.get<CashReport>(`/api/logistics/cash?${params.toString()}`);
    },
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['cash-report'] });
    void queryClient.invalidateQueries({ queryKey: ['cash-desks'] });
    void queryClient.invalidateQueries({ queryKey: ['settlements'] });
  };

  const move = useMutation({
    mutationFn: (input: { minor: bigint; idempotencyKey: string }) =>
      client.post('/api/logistics/cash/company', {
        direction: editor?.direction ?? 'TAKE',
        amountMinor: input.minor.toString(),
        operationDate: to,
        logistUserId: editor?.deskId,
        idempotencyKey: input.idempotencyKey,
      }),
    onSuccess: () => {
      setEditor(null);
      setAmount('');
      showToast('Операция кассы записана', 'success');
      refresh();
    },
    onError: (error: unknown) =>
      setFormError((error as { message?: string }).message ?? 'Не удалось провести операцию'),
  });

  const reverse = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      client.post(`/api/logistics/cash/${input.id}/reverse`, { reason: input.reason }),
    onSuccess: () => {
      showToast('Обратная корректировка записана', 'success');
      refresh();
    },
    onError: (error: unknown) =>
      showToast((error as { message?: string }).message ?? 'Не удалось отменить операцию', 'error'),
  });

  const toggle = (key: string): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  const openEditor = (direction: 'TAKE' | 'HAND'): void => {
    setFormError(null);
    setAmount('');
    // У логиста касса одна: она и подставляется. Администратор выбирает сам.
    const deskId = logistUserId !== '' ? logistUserId : (desks.data?.items[0]?.id ?? '');
    setEditor({ direction, deskId, nonce: globalThis.crypto.randomUUID() });
  };

  if (report.isPending) {
    return <LoadingState title="Считаем кассу…" />;
  }
  if (report.isError) {
    return <ErrorState title="Не удалось загрузить кассу" onRetry={() => void report.refetch()} />;
  }

  return (
    <div className="stack" data-testid="cash-panel">
      <div className="reports__summary" data-testid="cash-summary">
        {[
          ['Наличные в кассах', report.data.summary.cashOnHandMinor],
          ['Ожидается к сдаче', report.data.summary.expectedFromCouriersMinor],
          ['Получено от курьеров', report.data.summary.receivedMinor],
          ['Взято из компании', report.data.summary.takenMinor],
          ['Выдано курьерам', report.data.summary.issuedMinor],
          ['Сдано в компанию', report.data.summary.handedMinor],
        ].map(([label, value]) => (
          <div key={label} className="reports__cell">
            <span className="reports__cell-label">{label}</span>
            <span className="reports__cell-value">{money(value ?? '0')}</span>
          </div>
        ))}
        <div className="reports__cell reports__cell--total">
          <span className="reports__cell-label">Остаток на конец</span>
          <span className="reports__cell-value" data-testid="cash-closing">
            {money(report.data.summary.closingMinor)}
          </span>
          <span className="reports__cell-words">«Ожидается к сдаче» — расчёт, кассу не меняет</span>
        </div>
      </div>

      <div className="reports__filters">
        <Field label="Логист">
          {(props) => (
            <select
              {...props}
              className="reports__select"
              value={logistUserId}
              data-testid="cash-logist"
              onChange={(event) => setLogistUserId(event.target.value)}
            >
              <option value="">Все кассы</option>
              {(desks.data?.items ?? []).map((desk) => (
                <option key={desk.id} value={desk.id}>
                  {desk.fullName}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Вид операции">
          {(props) => (
            <select
              {...props}
              className="reports__select"
              value={kind}
              data-testid="cash-kind"
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="">Любой</option>
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Поиск" hint="Имя или телефон логиста и курьера">
          {(props) => (
            <TextInput
              {...props}
              value={search}
              data-testid="cash-search"
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </Field>
      </div>

      <div className="reports__actions">
        <Button variant="primary" data-testid="cash-take" onClick={() => openEditor('TAKE')}>
          Взять наличные из компании
        </Button>
        <Button data-testid="cash-hand" onClick={() => openEditor('HAND')}>
          Сдать наличные в компанию
        </Button>
        <a
          className="reports__link"
          href={`/api/logistics/reports/cash.xlsx?from=${from}&to=${to}`}
          data-testid="cash-xlsx"
        >
          Выгрузить XLSX
        </a>
        <a
          className="reports__link"
          href={`/api/logistics/reports/cash.pdf?from=${from}&to=${to}`}
          data-testid="cash-pdf"
        >
          Итог в PDF
        </a>
      </div>

      {report.data.days.length === 0 ? (
        <EmptyState
          title="За период движений кассы не было"
          description="Касса каждого логиста начинается с нуля с даты включения учёта."
        />
      ) : (
        <div className="reports__table-wrap">
          <table className="reports__table" data-testid="cash-rows">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Логист</th>
                <th>Остаток на начало</th>
                <th>Получено от курьеров</th>
                <th>Взято из компании</th>
                <th>Выдано курьерам</th>
                <th>Сдано в компанию</th>
                <th>Остаток на конец</th>
              </tr>
            </thead>
            <tbody>
              {report.data.days.flatMap((day) =>
                day.logists.flatMap((group) => {
                  const key = `${day.date}:${group.logistUserId}`;
                  const open = expanded.has(key);

                  const rows = [
                    <tr
                      key={key}
                      className="reports__group"
                      data-testid="cash-group"
                      data-group-date={day.date}
                      data-expanded={open ? 'true' : 'false'}
                    >
                      <td>{formatDate(day.date)}</td>
                      <td>
                        <button
                          type="button"
                          className="reports__group-toggle"
                          aria-expanded={open}
                          data-testid="cash-group-toggle"
                          onClick={() => toggle(key)}
                        >
                          <span className="reports__group-chevron" aria-hidden="true">
                            {open ? '▲' : '▼'}
                          </span>
                          <span className="reports__group-name">
                            <span>{group.fullName}</span>
                            <span className="reports__group-phone">
                              {group.phone ?? 'телефон не указан'}
                            </span>
                          </span>
                        </button>
                      </td>
                      <td>{money(group.openingMinor)}</td>
                      <td>{money(group.receivedMinor)}</td>
                      <td>{money(group.takenMinor)}</td>
                      <td>{money(group.issuedMinor)}</td>
                      <td>{money(group.handedMinor)}</td>
                      <td>{money(group.closingMinor)}</td>
                    </tr>,
                  ];

                  if (!open) {
                    return rows;
                  }

                  for (const entry of group.entries) {
                    rows.push(
                      <tr
                        key={entry.id}
                        className="reports__detail reports__payment"
                        data-entry-kind={entry.kind}
                        data-testid="cash-entry"
                      >
                        <td>{formatMoscowDateTime(entry.occurredAt)}</td>
                        <td className="reports__detail-order">
                          {KIND_LABELS[entry.kind] ?? entry.kind}
                        </td>
                        {/* Курьер показывается только там, где он участвовал. */}
                        <td colSpan={2}>{entry.courierName ?? ''}</td>
                        <td>{money(entry.amountMinor)}</td>
                        <td colSpan={2}>{entry.actorName ?? 'автор неизвестен'}</td>
                        <td>
                          {entry.reversed ? (
                            <span className="muted text-sm">отменена</span>
                          ) : (
                            entry.kind !== 'ADJUSTMENT' && (
                              <button
                                type="button"
                                className="reports__reverse"
                                data-testid="cash-reverse"
                                onClick={() => {
                                  const value = globalThis.prompt('Причина обратной корректировки');
                                  if (value !== null && value.trim().length >= 3) {
                                    reverse.mutate({ id: entry.id, reason: value.trim() });
                                  }
                                }}
                              >
                                Отменить
                              </button>
                            )
                          )}
                        </td>
                      </tr>,
                    );
                  }

                  return rows;
                }),
              )}
            </tbody>
          </table>
        </div>
      )}

      {report.data.hasMore && (
        <Button data-testid="cash-more" onClick={() => setPages((current) => current + 1)}>
          Показать ещё
        </Button>
      )}

      {editor !== null && (
        <Modal
          open
          title={
            editor.direction === 'TAKE' ? 'Взять наличные из компании' : 'Сдать наличные в компанию'
          }
          onClose={() => setEditor(null)}
        >
          <div className="stack" data-testid="cash-editor">
            {(desks.data?.items ?? []).length > 1 && (
              <Field label="Касса" hint="Операция проводится от имени выбранного логиста">
                {(props) => (
                  <select
                    {...props}
                    className="reports__select"
                    value={editor.deskId}
                    data-testid="cash-editor-desk"
                    onChange={(event) => setEditor({ ...editor, deskId: event.target.value })}
                  >
                    {(desks.data?.items ?? []).map((desk) => (
                      <option key={desk.id} value={desk.id}>
                        {desk.fullName} · {money(desk.balanceMinor)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}

            <Field label="Сумма, ₽" hint="Можно считать прямо здесь: 1000+500 даст 1500">
              {(props) => (
                <TextInput
                  {...props}
                  value={amount}
                  autoFocus
                  data-testid="cash-amount"
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setFormError(null);
                  }}
                />
              )}
            </Field>

            {previewOf(amount) !== null && (
              <p className="muted text-sm" data-testid="cash-preview">
                Получится {previewOf(amount)}
              </p>
            )}

            {formError !== null && (
              <p className="reports__error" role="alert" data-testid="cash-error">
                {formError}
              </p>
            )}

            <div className="reports__actions">
              <Button data-testid="cash-cancel" onClick={() => setEditor(null)}>
                Отмена
              </Button>
              <Button
                variant="primary"
                disabled={move.isPending}
                data-testid="cash-submit"
                onClick={() => {
                  const value = evaluateMoney(amount);
                  if (value.minor === null) {
                    setFormError(value.error ?? 'Введите сумму.');
                    return;
                  }
                  move.mutate({
                    minor: value.minor,
                    idempotencyKey: `desk:${editor.nonce}`,
                  });
                }}
              >
                {editor.direction === 'TAKE' ? 'Взять' : 'Сдать'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
