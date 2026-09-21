/**
 * Импорт выплат курьерам из Excel-выписки ПланФакта.
 *
 * Три шага в одном окне: выбрать файл → увидеть, что распознано → провести.
 * Предпросмотр считает сервер и ничего не пишет. Проводится только то, что он
 * назвал готовым, плюс возможные повторы, которые администратор отметил явно —
 * строка за строкой, а не «провести всё».
 *
 * Ключ подтверждения рождается вместе с выбранным файлом: двойное нажатие и
 * повтор сети возвращают тот же импорт, а не второй. Новый файл — новый ключ.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../ui/ToastProvider';
import { Button, ConfirmDialog, Modal } from '../../ui/components';
import { formatDate } from '../routing/routing';
import { formatMoney } from './money';

type RowState = 'ready' | 'error' | 'already_imported' | 'possible_duplicate' | 'ignored';

interface PreviewRow {
  rowNo: number;
  parentRowNo: number | null;
  counterparty: string | null;
  phone: string | null;
  courier: { id: string; fullName: string } | null;
  operationDate: string | null;
  amountMinor: string | null;
  state: RowState;
  reason: string | null;
  existingEntryId: string | null;
  duplicates: {
    entryId: string;
    operationDate: string;
    amountMinor: string;
    source: 'import' | 'manual';
    fileName: string | null;
  }[];
}

interface Preview {
  fileName: string;
  fileSha256: string;
  sheetName: string;
  lineCount: number;
  containers: number[];
  rows: PreviewRow[];
  summary: {
    total: number;
    ready: number;
    readyTotalMinor: string;
    possibleDuplicates: number;
    possibleDuplicatesTotalMinor: string;
    alreadyImported: number;
    errors: number;
    ignored: number;
  };
}

interface ImportResult {
  import: {
    id: string;
    fileName: string;
    postedCount: number;
    skippedCount: number;
    postedTotalMinor: string;
  } | null;
  posted: {
    rowNo: number;
    courier: { id: string; fullName: string } | null;
    operationDate: string;
    amountMinor: string;
    entryId: string;
  }[];
  skipped: { rowNo: number; state: RowState; reason: string | null }[];
}

const STATE_LABELS: Record<RowState, string> = {
  ready: 'Готово',
  error: 'Ошибка',
  already_imported: 'Уже проведено',
  possible_duplicate: 'Возможный повтор',
  ignored: 'Пропущено',
};

/** Файл в base64 для JSON-запроса: у приложения нет разбора multipart. */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function sumMinor(rows: readonly PreviewRow[]): bigint {
  return rows.reduce((total, row) => total + BigInt(row.amountMinor ?? '0'), 0n);
}

function messageOf(error: unknown, fallback: string): string {
  return (error as { message?: string }).message ?? fallback;
}

export function PayoutImportModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  /** Импорт что-то записал: экрану пора перечитать расчёты. */
  onImported: () => void;
}): React.JSX.Element {
  const { client } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [file, setFile] = useState<{ name: string; content: string; nonce: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  /** Возможные повторы, которые администратор решил провести, — номерами строк файла. */
  const [accepted, setAccepted] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const reset = (): void => {
    setFile(null);
    setPreview(null);
    setAccepted(new Set());
    setError(null);
    setConfirmOpen(false);
    setResult(null);
  };
  const close = (): void => {
    reset();
    onClose();
  };

  const previewMutation = useMutation({
    mutationFn: (input: { name: string; content: string }) =>
      client.post<Preview>('/api/logistics/payout-imports/preview', {
        fileName: input.name,
        content: input.content,
      }),
    onSuccess: (data) => {
      setPreview(data);
      setAccepted(new Set());
    },
    onError: (failure: unknown) => setError(messageOf(failure, 'Не удалось прочитать выписку')),
  });

  const confirmMutation = useMutation({
    mutationFn: () =>
      client.post<ImportResult>('/api/logistics/payout-imports', {
        fileName: file?.name ?? '',
        content: file?.content ?? '',
        idempotencyKey: `payout-import:${file?.nonce ?? ''}`,
        acceptRows: [...accepted],
      }),
    onSuccess: (data) => {
      setConfirmOpen(false);
      setResult(data);
      if (data.import === null) {
        showToast('Проводить было нечего: новых выплат в файле нет', 'info');
      } else {
        showToast(`Проведено выплат: ${data.import.postedCount}`, 'success');
        void queryClient.invalidateQueries({ queryKey: ['payout-imports'] });
        onImported();
      }
    },
    onError: (failure: unknown) => {
      setConfirmOpen(false);
      setError(messageOf(failure, 'Не удалось провести выплаты'));
    },
  });

  const pickFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const picked = event.target.files?.[0];
    if (picked === undefined) {
      return;
    }
    setError(null);
    setPreview(null);
    setResult(null);
    setAccepted(new Set());
    const next = {
      name: picked.name,
      content: await toBase64(picked),
      nonce: globalThis.crypto.randomUUID(),
    };
    setFile(next);
    previewMutation.mutate(next);
  };

  const toggleAccepted = (rowNo: number): void =>
    setAccepted((current) => {
      const next = new Set(current);
      if (next.has(rowNo)) {
        next.delete(rowNo);
      } else {
        next.add(rowNo);
      }
      return next;
    });

  const readyRows = preview?.rows.filter((row) => row.state === 'ready') ?? [];
  const acceptedRows =
    preview?.rows.filter((row) => row.state === 'possible_duplicate' && accepted.has(row.rowNo)) ??
    [];
  const toPostCount = readyRows.length + acceptedRows.length;
  const toPostTotal = (sumMinor(readyRows) + sumMinor(acceptedRows)).toString();
  const visibleRows = preview?.rows.filter((row) => row.state !== 'ignored') ?? [];
  const ignoredRows = preview?.rows.filter((row) => row.state === 'ignored') ?? [];
  const busy = previewMutation.isPending || confirmMutation.isPending;

  return (
    <>
      <Modal
        open={open && !confirmOpen}
        title="Импорт выплат из ПланФакта"
        onClose={close}
        className="payout-import"
        testId="payout-import-modal"
      >
        <div className="stack" data-testid="payout-import-form">
          <p className="muted text-sm">
            Выписка ПланФакта в формате .xlsx. Проводятся только подтверждённые рублёвые выплаты по
            статье «Заработная плата курьеров»; курьер определяется по телефону в поле «Контрагент».
            Каждая выплата записывается как «Логист выдал курьеру» днём оплаты с источником
            «ПланФакт». Кассы логистов не меняются.
          </p>

          {result === null && (
            <label className="payout-import__file">
              <span>Файл выписки</span>
              <input
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                data-testid="payout-import-file"
                disabled={busy}
                onChange={(event) => void pickFile(event)}
              />
            </label>
          )}

          {previewMutation.isPending && (
            <p className="muted text-sm" role="status">
              Читаем выписку…
            </p>
          )}

          {error !== null && (
            <p className="reports__error" role="alert" data-testid="payout-import-error">
              {error}
            </p>
          )}

          {preview !== null && result === null && (
            <>
              {/*
                Итог виден до таблицы: человек сначала узнаёт, сколько строк
                готово и на какую сумму, а потом разбирается со строками.
              */}
              <div
                className="payout-import__summary"
                role="status"
                data-testid="payout-import-summary"
              >
                <span>
                  Готово к проведению:{' '}
                  <strong data-testid="payout-import-ready-count">{preview.summary.ready}</strong>{' '}
                  на{' '}
                  <strong data-testid="payout-import-ready-total">
                    {formatMoney(preview.summary.readyTotalMinor)}
                  </strong>
                </span>
                <span data-testid="payout-import-duplicates-count">
                  Возможных повторов: {preview.summary.possibleDuplicates}
                </span>
                <span data-testid="payout-import-imported-count">
                  Уже проведено: {preview.summary.alreadyImported}
                </span>
                <span data-testid="payout-import-errors-count">
                  Ошибок: {preview.summary.errors}
                </span>
                <span>Пропущено: {preview.summary.ignored}</span>
              </div>

              {preview.containers.length > 0 && (
                <p className="muted text-sm" data-testid="payout-import-containers">
                  Выплаты, разбитые на части (строки {preview.containers.join(', ')}), проводятся
                  частями — по телефону каждой части.
                </p>
              )}

              {visibleRows.length === 0 ? (
                <p className="reports__notice" role="status">
                  В файле нет выплат зарплаты курьерам, которые можно провести.
                </p>
              ) : (
                <div className="payout-import__table-wrap">
                  <table className="reports__table" data-testid="payout-import-preview">
                    <thead>
                      <tr>
                        <th>Строка</th>
                        <th>Контрагент в файле</th>
                        <th>Телефон</th>
                        <th>Курьер</th>
                        <th>Дата оплаты</th>
                        <th>Сумма</th>
                        <th>Состояние</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((row) => (
                        <tr
                          key={row.rowNo}
                          data-testid="payout-import-row"
                          data-row-no={row.rowNo}
                          data-state={row.state}
                        >
                          <td>
                            {row.rowNo}
                            {row.parentRowNo !== null && (
                              <span className="muted text-sm"> (часть {row.parentRowNo})</span>
                            )}
                          </td>
                          <td
                            className="reports__detail-reason"
                            title={row.counterparty ?? undefined}
                          >
                            {row.counterparty ?? '—'}
                          </td>
                          <td>{row.phone ?? '—'}</td>
                          <td>{row.courier?.fullName ?? '—'}</td>
                          <td>
                            {row.operationDate === null ? '—' : formatDate(row.operationDate)}
                          </td>
                          <td>{row.amountMinor === null ? '—' : formatMoney(row.amountMinor)}</td>
                          <td>
                            <span
                              className={`payout-import__state payout-import__state--${row.state}`}
                            >
                              {STATE_LABELS[row.state]}
                            </span>
                            {row.reason !== null && (
                              <div className="payout-import__reason">{row.reason}</div>
                            )}
                            {row.state === 'possible_duplicate' && (
                              <>
                                <ul className="payout-import__duplicates">
                                  {row.duplicates.map((duplicate) => (
                                    <li key={duplicate.entryId}>
                                      уже есть: {formatDate(duplicate.operationDate)} ·{' '}
                                      {formatMoney(duplicate.amountMinor)} ·{' '}
                                      {duplicate.source === 'import'
                                        ? `выписка «${duplicate.fileName ?? '—'}»`
                                        : 'заведена вручную'}
                                    </li>
                                  ))}
                                </ul>
                                <label className="payout-import__accept">
                                  <input
                                    type="checkbox"
                                    data-testid="payout-import-accept"
                                    checked={accepted.has(row.rowNo)}
                                    onChange={() => toggleAccepted(row.rowNo)}
                                  />{' '}
                                  Это другая выплата — провести
                                </label>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {ignoredRows.length > 0 && (
                <details className="payout-import__ignored" data-testid="payout-import-ignored">
                  <summary>
                    Пропущено строк: {ignoredRows.length} — не выплаты зарплаты курьерам или не
                    подтверждены
                  </summary>
                  <ul>
                    {ignoredRows.map((row) => (
                      <li key={row.rowNo}>
                        строка {row.rowNo}: {row.reason ?? 'пропущена'}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}

          {result !== null && (
            <div className="stack" data-testid="payout-import-result">
              {result.import === null ? (
                <p className="reports__notice" role="status">
                  Проводить было нечего: все строки уже проведены раньше или содержат ошибки.
                </p>
              ) : (
                <p className="reports__notice" role="status">
                  Проведено выплат:{' '}
                  <strong data-testid="payout-import-posted-count">
                    {result.import.postedCount}
                  </strong>{' '}
                  на{' '}
                  <strong data-testid="payout-import-posted-total">
                    {formatMoney(result.import.postedTotalMinor)}
                  </strong>
                  . Записи видны в журнале как «Логист выдал курьеру» с источником «ПланФакт».
                </p>
              )}
              {result.skipped.length > 0 && (
                <details open data-testid="payout-import-skipped">
                  <summary>Не проведено строк: {result.skipped.length}</summary>
                  <ul>
                    {result.skipped.map((row) => (
                      <li key={row.rowNo}>
                        строка {row.rowNo}: {STATE_LABELS[row.state].toLowerCase()}
                        {row.reason === null ? '' : ` — ${row.reason}`}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          <div className="reports__actions">
            <Button data-testid="payout-import-close" onClick={close}>
              {result === null ? 'Отмена' : 'Готово'}
            </Button>
            {preview !== null && result === null && (
              <Button
                variant="primary"
                disabled={busy || toPostCount === 0}
                data-testid="payout-import-submit"
                onClick={() => setConfirmOpen(true)}
              >
                Провести {toPostCount} {toPostCount === 1 ? 'выплату' : 'выплат'} на{' '}
                {formatMoney(toPostTotal)}
              </Button>
            )}
          </div>
        </div>
      </Modal>

      {/*
        Подтверждение называет число, сумму и то, чем именно станут строки:
        деньги записываются в долг курьеров по внешнему документу.
      */}
      <ConfirmDialog
        open={open && confirmOpen}
        title="Провести выплаты?"
        description={`В журнал расчётов будет записано ${toPostCount} выплат на ${formatMoney(toPostTotal)} как «Логист выдал курьеру» с источником «ПланФакт». Долг каждого курьера перед компанией вырастет на сумму его выплат; кассы логистов не изменятся.`}
        confirmLabel="Провести"
        busy={confirmMutation.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => confirmMutation.mutate()}
      />
    </>
  );
}
