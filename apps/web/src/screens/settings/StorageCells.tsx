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
  TextInput,
} from '../../ui/components';
import {
  CELL_KIND_LABELS,
  cellCodeError,
  codeWillChange,
  previewCellCode,
  type StorageCellKind,
  type StorageCellListResponse,
  type StorageCellView,
} from './storage-cells';

export function StorageCells(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [code, setCode] = useState('');
  const [kind, setKind] = useState<StorageCellKind>('STORAGE');
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

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
  const preview = previewCellCode(code);
  const canCreate = cellCodeError(code) === null && !create.isPending;

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
        </div>

        {codeWillChange(code) && codeError === null && (
          <p className="muted text-sm">
            Для сравнения и сканирования код будет приведён к виду{' '}
            <strong>{preview.normalizedCode}</strong>.
          </p>
        )}
      </form>

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
