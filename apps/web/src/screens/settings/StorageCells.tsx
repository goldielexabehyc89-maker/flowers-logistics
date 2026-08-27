/**
 * Справочник складских ячеек в настройках.
 *
 * Раздел доступен только администратору — как и весь экран настроек. Кладовщик
 * ячейки читает через API, но заводить и выключать их не вправе.
 *
 * Здесь нет ни приёмки, ни комплектования, ни выдачи: этих операций в системе
 * пока не существует, и показывать их кнопки означало бы обещать работающий
 * склад. Есть ровно справочник и этикетка.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Select,
  StatusBadge,
  TextArea,
  TextInput,
} from '../../ui/components';
import {
  CELL_KIND_LABELS,
  MAX_BULK_CELLS,
  MAX_BULK_PAD,
  bulkEdges,
  cellCodeError,
  cellsPlural,
  codeWillChange,
  expandBulkRange,
  parseBulkRange,
  previewCellCode,
  splitBulkList,
  type BulkMode,
  type BulkPreviewResponse,
  type BulkRangeForm,
  type BulkResultResponse,
  type StorageCellKind,
  type StorageCellListResponse,
  type StorageCellView,
} from './storage-cells';

/** Начальный диапазон: полсотни полок одного стеллажа — обычный случай. */
const EMPTY_RANGE: BulkRangeForm = { prefix: '', from: '1', to: '10', pad: '3' };

export function StorageCells(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [code, setCode] = useState('');
  const [kind, setKind] = useState<StorageCellKind>('STORAGE');
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkMode, setBulkMode] = useState<BulkMode>('RANGE');
  const [bulkKind, setBulkKind] = useState<StorageCellKind>('STORAGE');
  const [range, setRange] = useState<BulkRangeForm>(EMPTY_RANGE);
  const [list, setList] = useState('');
  const [preview, setPreview] = useState<BulkPreviewResponse | null>(null);

  const query = useQuery({
    queryKey: ['storage-cells'],
    queryFn: () => client.get<StorageCellListResponse>('/api/storage-cells?limit=500'),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['storage-cells'] });
  };

  function reportError(error: unknown, fallback: string): void {
    showToast(error instanceof ApiError ? error.message : fallback, 'error');
  }

  /**
   * Любое изменение ввода отменяет показанный предпросмотр.
   *
   * Иначе человек увидел бы разбор одного диапазона, поправил бы последний
   * номер и нажал «Создать», получив совсем другую партию, чем на экране.
   * Предпросмотр обязан описывать ровно то, что уйдёт на сервер.
   */
  function changeBulk(apply: () => void): void {
    setPreview(null);
    apply();
  }

  /**
   * Панель закрывается пустой — и открывается пустой.
   *
   * Сброшены и способ ввода, и тип: следующая партия почти всегда про другой
   * стеллаж, а сохранённый с прошлого раза тип «Маршрутная» человек не
   * перечитывает — он помнит, что заводит полки хранения, и получил бы
   * сотню ячеек не того назначения.
   */
  function closeBulk(): void {
    setBulkOpen(false);
    setPreview(null);
    setBulkMode('RANGE');
    setBulkKind('STORAGE');
    setRange(EMPTY_RANGE);
    setList('');
  }

  const create = useMutation({
    mutationFn: () => client.post<StorageCellView>('/api/storage-cells', { code, kind }),
    onSuccess: async (created) => {
      setCode('');
      setTouched(false);
      await invalidate();
      showToast(`Ячейка ${created.normalizedCode} создана`, 'success');
    },
    onError: (error: unknown) => reportError(error, 'Не удалось создать ячейку.'),
  });

  /*
   * Партия: два запроса, а не один.
   *
   * Предпросмотр — отдельная операция чтения. Ячейку нельзя удалить, её можно
   * только выключить, поэтому сотня ошибочных кодов остаётся в справочнике
   * навсегда — человек обязан увидеть последствия до того, как они наступят.
   */
  const previewBatch = useMutation({
    mutationFn: () =>
      client.post<BulkPreviewResponse>('/api/storage-cells/bulk/preview', bulkBody()),
    onSuccess: (result) => setPreview(result),
    onError: (error: unknown) => {
      setPreview(null);
      reportError(error, 'Не удалось проверить список.');
    },
  });

  const createBatch = useMutation({
    mutationFn: () => client.post<BulkResultResponse>('/api/storage-cells/bulk', bulkBody()),
    onSuccess: async (result) => {
      closeBulk();
      await invalidate();
      showToast(
        result.skippedExisting === 0
          ? `Создано ${cellsPlural(result.created)}`
          : `Создано ${cellsPlural(result.created)}, пропущено существующих: ${result.skippedExisting}`,
        'success',
      );
    },
    onError: (error: unknown) => reportError(error, 'Не удалось создать партию.'),
  });

  const setActive = useMutation({
    mutationFn: (input: { cell: StorageCellView; isActive: boolean }) =>
      client.put<StorageCellView>(`/api/storage-cells/${input.cell.id}/active`, {
        isActive: input.isActive,
        expectedVersion: input.cell.version,
      }),
    onSuccess: async () => {
      await invalidate();
    },
    onError: async (error: unknown) => {
      // Конфликт версии означает, что справочник устарел: кто-то изменил ячейку
      // раньше. Молча повторять запрос нельзя — это перетёрло бы чужое решение.
      if (error instanceof ApiError && error.status === 409) {
        await invalidate();
        showToast('Ячейка изменена другим пользователем. Список обновлён — повторите.', 'error');
        return;
      }
      reportError(error, 'Не удалось изменить ячейку.');
    },
    onSettled: () => setPending(null),
  });

  /**
   * Скачивание этикетки.
   *
   * Документ забирается запросом с токеном и сохраняется как файл: обычная
   * ссылка ушла бы без заголовка авторизации и получила 401. Ссылка на объект
   * освобождается сразу — иначе вкладка копила бы их до перезагрузки.
   */
  async function openLabel(cell: StorageCellView): Promise<void> {
    try {
      const svg = await client.getText(`/api/storage-cells/${cell.id}/label.svg`, 'image/svg+xml');
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `cell-${cell.normalizedCode}.svg`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      reportError(error, 'Не удалось получить этикетку.');
    }
  }

  const codeError = touched ? cellCodeError(code) : null;
  const codePreview = previewCellCode(code);
  const canCreate = cellCodeError(code) === null && !create.isPending;

  const parsedRange = parseBulkRange(range);
  const listCodes = splitBulkList(list);

  /**
   * Причина, по которой партию нельзя даже отправить на проверку.
   *
   * Клиентские правила защитой не являются — решение принимает сервер. Они
   * нужны, чтобы отказ по слишком большому диапазону пришёл сразу, а не после
   * ожидания: «от 1 до 5000» набирается за секунду.
   */
  const bulkError: string | null =
    bulkMode === 'RANGE'
      ? 'error' in parsedRange
        ? parsedRange.error
        : null
      : listCodes.length === 0
        ? 'Вставьте список кодов'
        : listCodes.length > MAX_BULK_CELLS
          ? `За один раз — не больше ${MAX_BULK_CELLS} ячеек, а в списке ${listCodes.length}`
          : null;

  /** Коды, которые уйдут на сервер: тот же разбор, что и там. */
  const bulkCodes =
    bulkMode === 'RANGE'
      ? 'range' in parsedRange
        ? expandBulkRange(parsedRange.range)
        : []
      : listCodes;

  function bulkBody(): Record<string, unknown> {
    if (bulkMode === 'LIST') {
      return { kind: bulkKind, list };
    }
    return 'range' in parsedRange
      ? { kind: bulkKind, range: parsedRange.range }
      : { kind: bulkKind };
  }

  const bulkBusy = previewBatch.isPending || createBatch.isPending;

  return (
    <section className="card stack">
      <div>
        <h3>Складские ячейки</h3>
        <p className="muted text-sm">
          Полки, на которых физически лежат собранные заказы. Это не склад маршрутизации: координат
          и точек отсчёта маршрута у ячейки нет.
        </p>
      </div>

      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (cellCodeError(code) === null) {
            create.mutate();
          }
        }}
      >
        <div className="row">
          <Field
            label="Код ячейки"
            hint="Печатается на этикетке. После создания не изменяется."
            error={codeError ?? undefined}
          >
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                data-testid="cell-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                onBlur={() => setTouched(true)}
                placeholder="A-01"
              />
            )}
          </Field>

          <Field label="Тип">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                data-testid="cell-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as StorageCellKind)}
              >
                {(['STORAGE', 'ROUTE'] as const).map((value) => (
                  <option key={value} value={value}>
                    {CELL_KIND_LABELS[value]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Button type="submit" variant="primary" disabled={!canCreate} data-testid="cell-create">
            {create.isPending ? 'Создаём…' : 'Создать'}
          </Button>

          <Button
            type="button"
            variant="secondary"
            data-testid="cell-bulk-open"
            aria-expanded={bulkOpen}
            onClick={() => (bulkOpen ? closeBulk() : setBulkOpen(true))}
          >
            {bulkOpen ? 'Свернуть' : 'Создать несколько'}
          </Button>
        </div>

        {codeWillChange(code) && codeError === null && (
          <p className="muted text-sm">
            Для сравнения и сканирования код будет приведён к виду{' '}
            <strong>{codePreview.normalizedCode}</strong>.
          </p>
        )}
      </form>

      {bulkOpen && (
        <form
          className="stack cell-bulk"
          data-testid="cell-bulk"
          onSubmit={(event) => {
            event.preventDefault();
            if (bulkError === null && !bulkBusy) {
              previewBatch.mutate();
            }
          }}
        >
          <div>
            <h4>Создать несколько</h4>
            <p className="muted text-sm">
              Стеллаж заводится диапазоном, разрозненные полки — вставленным списком. За один раз —
              не больше {MAX_BULK_CELLS} ячеек: партию крупнее человек уже не проверит глазами.
            </p>
          </div>

          <div className="row">
            <Field label="Как задать коды">
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  data-testid="cell-bulk-mode"
                  value={bulkMode}
                  onChange={(event) =>
                    changeBulk(() => setBulkMode(event.target.value as BulkMode))
                  }
                >
                  <option value="RANGE">Диапазон</option>
                  <option value="LIST">Готовый список</option>
                </Select>
              )}
            </Field>

            <Field label="Тип">
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  data-testid="cell-bulk-kind"
                  value={bulkKind}
                  onChange={(event) =>
                    changeBulk(() => setBulkKind(event.target.value as StorageCellKind))
                  }
                >
                  {(['STORAGE', 'ROUTE'] as const).map((value) => (
                    <option key={value} value={value}>
                      {CELL_KIND_LABELS[value]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          {bulkMode === 'RANGE' ? (
            <div className="row">
              <Field label="Префикс" hint="Например, A- или Стеллаж-1-">
                {(fieldProps) => (
                  <TextInput
                    {...fieldProps}
                    data-testid="cell-bulk-prefix"
                    value={range.prefix}
                    onChange={(event) =>
                      changeBulk(() => setRange({ ...range, prefix: event.target.value }))
                    }
                    placeholder="A-"
                  />
                )}
              </Field>
              <Field label="От">
                {(fieldProps) => (
                  <TextInput
                    {...fieldProps}
                    data-testid="cell-bulk-from"
                    inputMode="numeric"
                    value={range.from}
                    onChange={(event) =>
                      changeBulk(() => setRange({ ...range, from: event.target.value }))
                    }
                  />
                )}
              </Field>
              <Field label="До" hint="Включительно">
                {(fieldProps) => (
                  <TextInput
                    {...fieldProps}
                    data-testid="cell-bulk-to"
                    inputMode="numeric"
                    value={range.to}
                    onChange={(event) =>
                      changeBulk(() => setRange({ ...range, to: event.target.value }))
                    }
                  />
                )}
              </Field>
              <Field label="Знаков в номере" hint={`От 1 до ${MAX_BULK_PAD}`}>
                {(fieldProps) => (
                  <TextInput
                    {...fieldProps}
                    data-testid="cell-bulk-pad"
                    inputMode="numeric"
                    value={range.pad}
                    onChange={(event) =>
                      changeBulk(() => setRange({ ...range, pad: event.target.value }))
                    }
                  />
                )}
              </Field>
            </div>
          ) : (
            <Field
              label="Список кодов"
              hint="По одному в строке; запятая и точка с запятой тоже разделяют."
            >
              {(fieldProps) => (
                <TextArea
                  {...fieldProps}
                  data-testid="cell-bulk-list"
                  rows={6}
                  value={list}
                  onChange={(event) => changeBulk(() => setList(event.target.value))}
                  placeholder={'A-01\nA-02\nБ-07'}
                />
              )}
            </Field>
          )}

          {bulkError !== null && (
            <p className="text-sm cell-bulk__error" role="alert" data-testid="cell-bulk-error">
              {bulkError}
            </p>
          )}

          {bulkError === null && bulkCodes.length > 0 && preview === null && (
            <p className="muted text-sm" data-testid="cell-bulk-plan">
              Будет проверено {cellsPlural(bulkCodes.length)}: {bulkEdges(bulkCodes)}
            </p>
          )}

          {preview !== null && (
            <div className="stack cell-bulk__preview" data-testid="cell-bulk-summary">
              <p data-testid="cell-bulk-will-create">
                <strong>
                  {preview.willCreate.length === 0
                    ? 'Создавать нечего'
                    : `Будет создано ${cellsPlural(preview.willCreate.length)}`}
                </strong>
                {preview.willCreate.length > 0 && (
                  <span className="muted">
                    {' '}
                    — {bulkEdges(preview.willCreate.map((item) => item.normalizedCode))}
                  </span>
                )}
              </p>
              <ul className="muted text-sm cell-bulk__facts">
                <li data-testid="cell-bulk-total">Всего кодов в партии: {preview.total}</li>
                <li data-testid="cell-bulk-existing">
                  Уже существуют: {preview.existing.length}
                  {preview.existing.length > 0 && (
                    <> — {bulkEdges(preview.existing.map((item) => item.normalizedCode))}</>
                  )}
                </li>
                <li data-testid="cell-bulk-duplicates">
                  Повторов внутри списка: {preview.duplicates.length}
                </li>
                <li data-testid="cell-bulk-invalid">Негодных строк: {preview.invalid.length}</li>
              </ul>
              {preview.invalid.length > 0 && (
                <ul className="text-sm cell-bulk__invalid">
                  {preview.invalid.slice(0, 10).map((item, index) => (
                    <li key={`${item.input}-${index}`}>
                      <code>{item.input.slice(0, 60)}</code> — {item.reason}
                    </li>
                  ))}
                  {preview.invalid.length > 10 && (
                    <li className="muted">…и ещё {preview.invalid.length - 10}</li>
                  )}
                </ul>
              )}
              <p className="muted text-sm">
                Существующие ячейки не изменятся: на полке уже висит наклейка, и её тип менять
                заодно нельзя.
              </p>
            </div>
          )}

          <div className="row">
            <Button
              type="submit"
              variant="secondary"
              disabled={bulkError !== null || bulkBusy}
              data-testid="cell-bulk-preview"
            >
              {previewBatch.isPending ? 'Проверяем…' : 'Проверить'}
            </Button>

            {/*
              Создание доступно только после проверки: партию нельзя завести
              вслепую, а любое изменение ввода предпросмотр отменяет.
            */}
            <Button
              type="button"
              variant="primary"
              disabled={preview === null || preview.willCreate.length === 0 || bulkBusy}
              data-testid="cell-bulk-submit"
              onClick={() => createBatch.mutate()}
            >
              {createBatch.isPending
                ? 'Создаём…'
                : preview === null
                  ? 'Создать'
                  : `Создать ${cellsPlural(preview.willCreate.length)}`}
            </Button>

            <Button
              type="button"
              variant="ghost"
              disabled={bulkBusy}
              data-testid="cell-bulk-cancel"
              onClick={closeBulk}
            >
              Отмена
            </Button>
          </div>
        </form>
      )}

      {query.isPending && <LoadingState title="Загружаем справочник ячеек…" />}

      {query.isError && (
        <ErrorState
          description="Справочник ячеек не загрузился."
          onRetry={() => void query.refetch()}
        />
      )}

      {query.isSuccess && query.data.items.length === 0 && (
        <EmptyState
          title="Ячеек ещё нет"
          description="Заведите первую полку: без ячеек приёмка заказов работать не сможет."
        />
      )}

      {query.isSuccess && query.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Код</th>
                <th>Тип</th>
                <th>Состояние</th>
                <th>Версия</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((cell) => (
                <tr key={cell.id} data-testid="cell-row" data-cell-code={cell.normalizedCode}>
                  <td>
                    <strong>{cell.code}</strong>
                    {cell.code !== cell.normalizedCode && (
                      <div className="muted text-sm">скан: {cell.normalizedCode}</div>
                    )}
                  </td>
                  <td>{CELL_KIND_LABELS[cell.kind]}</td>
                  <td>
                    <StatusBadge tone={cell.isActive ? 'success' : 'neutral'}>
                      {cell.isActive ? 'Активна' : 'Выключена'}
                    </StatusBadge>
                  </td>
                  <td className="muted text-sm">{cell.version}</td>
                  <td>
                    <div className="row">
                      <Button
                        variant="secondary"
                        data-testid="cell-label"
                        onClick={() => void openLabel(cell)}
                      >
                        Этикетка
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={pending !== null}
                        data-testid="cell-toggle"
                        onClick={() => {
                          setPending(cell.id);
                          setActive.mutate({ cell, isActive: !cell.isActive });
                        }}
                      >
                        {cell.isActive ? 'Выключить' : 'Включить'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted text-sm">
        Ячейки не удаляются: использованная полка остаётся в истории перемещений, поэтому вместо
        удаления её выключают. Ошибочный код исправляется выключением ячейки и созданием новой —
        напечатанная этикетка не должна начать указывать на другую полку.
      </p>
      <p className="muted text-sm">
        Тип ячейки после создания пока не меняется: менять его допустимо только у пустой полки, а
        учёта размещённых заказов ещё нет — подтвердить пустоту нечем. Ошибочный тип исправляется
        так же, как ошибочный код: выключением ячейки и созданием корректной. Смена типа станет
        доступна вместе с приёмкой заказов в ячейки.
      </p>
    </section>
  );
}
