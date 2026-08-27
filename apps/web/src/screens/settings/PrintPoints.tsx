/**
 * Точки печати в настройках.
 *
 * Точка — это компьютер с подключённым принтером. Раздел отвечает на три
 * вопроса администратора: есть ли связь, что печатается сейчас и как
 * подключить новый компьютер.
 *
 * Код подключения показывается ОДИН раз и только после явного нажатия:
 * на сервере его нет — есть только хеш, — и повторить показ невозможно
 * даже намеренно.
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
  StatusBadge,
  TextInput,
} from '../../ui/components';
import {
  POINT_STATE_LABELS,
  lastSeenLabel,
  pointHint,
  pointTone,
  type PrintPointView,
} from './print-points';

interface PointsResponse {
  items: PrintPointView[];
}

interface IssuedCode {
  pointId: string;
  code: string;
  expiresAt: string;
}

export function PrintPoints(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [name, setName] = useState('');
  const [issued, setIssued] = useState<IssuedCode | null>(null);

  const query = useQuery({
    queryKey: ['print-points'],
    queryFn: () => client.get<PointsResponse>('/api/print-points'),
    /*
     * Периодический перезапрос — не украшение.
     *
     * «Онлайн» вычисляется из момента последнего отклика агента, и точка,
     * замолчавшая минуту назад, обязана стать «нет связи» сама. Без опроса
     * администратор смотрел бы на давно неверное состояние.
     */
    refetchInterval: 15_000,
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['print-points'] });
  };

  function reportError(error: unknown, fallback: string): void {
    showToast(error instanceof ApiError ? error.message : fallback, 'error');
  }

  const create = useMutation({
    mutationFn: () => client.post<{ point: PrintPointView }>('/api/print-points', { name }),
    onSuccess: async () => {
      setName('');
      await invalidate();
      showToast('Точка печати создана', 'success');
    },
    onError: (error: unknown) => reportError(error, 'Не удалось создать точку печати.'),
  });

  const issueCode = useMutation({
    mutationFn: (pointId: string) =>
      client
        .post<{ code: string; expiresAt: string }>(`/api/print-points/${pointId}/pairing-code`)
        .then((result) => ({ ...result, pointId })),
    onSuccess: async (result) => {
      setIssued(result);
      await invalidate();
    },
    onError: (error: unknown) => reportError(error, 'Не удалось выпустить код подключения.'),
  });

  const testPrint = useMutation({
    mutationFn: (pointId: string) => client.post(`/api/print-points/${pointId}/test`),
    onSuccess: async () => {
      await invalidate();
      // Формулировка честная: сервер отдаёт отпечаток агенту, а вышла ли
      // бумага, не знает ни он, ни Windows.
      showToast('Отпечаток отправлен: посмотрите на принтер', 'success');
    },
    onError: (error: unknown) => reportError(error, 'Не удалось запросить отпечаток.'),
  });

  const disconnect = useMutation({
    mutationFn: (pointId: string) => client.post(`/api/print-points/${pointId}/disconnect`),
    onSuccess: async () => {
      await invalidate();
      showToast('Точка отключена', 'success');
    },
    onError: (error: unknown) => reportError(error, 'Не удалось отключить точку.'),
  });

  const canCreate = name.trim() !== '' && !create.isPending;

  return (
    <section className="card stack">
      <div>
        <h3>Печать</h3>
        <p className="muted text-sm">
          Точка печати — это компьютер с подключённым термопринтером. Флорист выбирает точку в
          начале смены, и наклейки собранных заказов уходят на неё сами.
        </p>
      </div>

      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (canCreate) {
            create.mutate();
          }
        }}
      >
        <Field label="Название точки" hint="Например, «Флористы — стол 1»">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              data-testid="print-point-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Флористы — стол 1"
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="primary"
          disabled={!canCreate}
          data-testid="print-point-create"
        >
          {create.isPending ? 'Создаём…' : 'Добавить точку'}
        </Button>
      </form>

      {issued !== null && (
        <div className="stack print-point__code" data-testid="print-point-code">
          <p>
            Код подключения: <strong className="one-time-code">{issued.code}</strong>
          </p>
          <p className="muted text-sm">
            Введите его в агенте на том компьютере, к которому подключён принтер. Код действует до{' '}
            {new Date(issued.expiresAt).toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            и показывается один раз: на сервере его нет.
          </p>
          <div className="row">
            <Button variant="secondary" onClick={() => setIssued(null)}>
              Я записал код
            </Button>
          </div>
        </div>
      )}

      {query.isPending && <LoadingState title="Загружаем точки печати…" />}

      {query.isError && (
        <ErrorState
          description="Точки печати не загрузились."
          onRetry={() => void query.refetch()}
        />
      )}

      {query.isSuccess && query.data.items.length === 0 && (
        <EmptyState
          title="Точек печати нет"
          description="Заведите точку и подключите к ней компьютер с термопринтером. Пока точек нет, наклейки печатаются вручную из карточки заказа."
        />
      )}

      {query.isSuccess && query.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Точка</th>
                <th>Состояние</th>
                <th>Компьютер и принтер</th>
                <th>Очередь</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((point) => (
                <tr key={point.id} data-testid="print-point-row" data-point-name={point.name}>
                  <td>
                    <strong>{point.name}</strong>
                    <div className="muted text-sm">{pointHint(point)}</div>
                  </td>
                  <td>
                    <StatusBadge tone={point.isActive ? pointTone(point.state) : 'neutral'}>
                      {point.isActive ? POINT_STATE_LABELS[point.state] : 'Отключена'}
                    </StatusBadge>
                    <div className="muted text-sm">Связь: {lastSeenLabel(point.lastSeenAt)}</div>
                  </td>
                  <td className="text-sm">
                    {point.computerName ?? '—'}
                    <div className="muted">{point.printerName ?? 'принтер не выбран'}</div>
                  </td>
                  <td data-testid="print-point-queue">{point.queued}</td>
                  <td>
                    <div className="row">
                      {point.isActive && (
                        <Button
                          variant="secondary"
                          disabled={issueCode.isPending}
                          data-testid="print-point-pair"
                          onClick={() => issueCode.mutate(point.id)}
                        >
                          Код подключения
                        </Button>
                      )}
                      {point.isActive && point.paired && (
                        <Button
                          variant="secondary"
                          disabled={testPrint.isPending}
                          data-testid="print-point-test"
                          onClick={() => testPrint.mutate(point.id)}
                        >
                          Тестовая печать
                        </Button>
                      )}
                      {point.isActive && (
                        <Button
                          variant="ghost"
                          disabled={disconnect.isPending}
                          data-testid="print-point-disconnect"
                          onClick={() => disconnect.mutate(point.id)}
                        >
                          Отключить
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted text-sm">
        «Передано принтеру» — предел того, что известно системе: Windows не сообщает, вышла ли
        наклейка из принтера. Если бумаги нет, повторите печать из карточки заказа.
      </p>
      <p className="muted text-sm">
        Печать не задерживает работу: заказ отмечается собранным, даже когда компьютер выключен.
        Наклейка в этом случае остаётся в очереди, а напечатать её можно вручную.
      </p>
    </section>
  );
}
