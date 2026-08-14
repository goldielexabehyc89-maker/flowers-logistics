/**
 * Раздел «Печать» в настройках.
 *
 * Управление обработчиками печати доступно только администратору — как и весь
 * экран настроек. Флорист устройствами не управляет: он видит состояние своего
 * задания и причину отказа во вкладке «Печать» своего раздела, и этого ему
 * достаточно. Скрытая кнопка защитой не считается — решение принимает сервер.
 *
 * КОД ПРИВЯЗКИ ПОКАЗЫВАЕТСЯ ОДИН РАЗ. После закрытия окна он не восстановим:
 * сервер хранит только хеш. Поэтому окно не закрывается по клику мимо и не
 * исчезает само — администратор обязан успеть перенести код на другой компьютер.
 *
 * ПРИНТЕР ПО УМОЛЧАНИЮ ЗДЕСЬ НЕ НАСТРАИВАЕТСЯ. Показанное имя — отчёт
 * обработчика о том, что было выбрано в Windows при последней связи. Печатать
 * он будет в тот принтер, который окажется принтером по умолчанию
 * непосредственно перед печатью; смена принтера не требует ни перепривязки,
 * ни правки настроек.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatMoscowDateTime } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  StatusBadge,
} from '../../ui/components';
import {
  deviceActions,
  deviceStateLabel,
  deviceStateTone,
  formatMoment,
  printReadiness,
  type PairingCodeResponse,
  type PrintDevicesResponse,
  type PrintDeviceView,
} from './print-agent';

/**
 * Ключ идемпотентности одного нажатия.
 *
 * Создаётся ЗДЕСЬ, а не на сервере: смысл ключа именно в том, что повторная
 * отправка того же запроса — двойной клик, повтор при потерянном ответе —
 * приходит с тем же значением. Ключ, выданный сервером, у каждого запроса
 * был бы свой, и защищать было бы нечего.
 */
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function PrintAgent(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [issued, setIssued] = useState<PairingCodeResponse | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['print-agent-devices'],
    queryFn: () => client.get<PrintDevicesResponse>('/api/settings/print/devices'),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['print-agent-devices'] });
  };

  function reportError(error: unknown, fallback: string): void {
    showToast(error instanceof ApiError ? error.message : fallback, 'error');
  }

  const issueCode = useMutation({
    mutationFn: () => client.post<PairingCodeResponse>('/api/settings/print/pairing-code'),
    onSuccess: (result) => {
      setIssued(result);
    },
    onError: (error: unknown) => reportError(error, 'Не удалось создать код привязки.'),
  });

  const makePrimary = useMutation({
    mutationFn: (device: PrintDeviceView) =>
      client.post(`/api/settings/print/devices/${device.id}/primary`),
    onSuccess: async () => {
      await invalidate();
      showToast('Основной компьютер изменён', 'success');
    },
    onError: (error: unknown) => reportError(error, 'Не удалось назначить основной компьютер.'),
    onSettled: () => setPending(null),
  });

  const revoke = useMutation({
    mutationFn: (device: PrintDeviceView) =>
      client.post(`/api/settings/print/devices/${device.id}/revoke`),
    onSuccess: async () => {
      await invalidate();
      showToast('Устройство отключено', 'success');
    },
    onError: (error: unknown) => reportError(error, 'Не удалось отключить устройство.'),
    onSettled: () => setPending(null),
  });

  const testPrint = useMutation({
    mutationFn: () =>
      client.post('/api/settings/print/test', { idempotencyKey: newIdempotencyKey() }),
    onSuccess: async () => {
      await invalidate();
      // Задание поставлено в очередь, а не напечатано: подтвердить печать
      // может только сам принтер, и обещать бумагу сейчас было бы враньём.
      showToast('Тестовая страница поставлена в очередь печати', 'success');
    },
    onError: (error: unknown) => reportError(error, 'Не удалось отправить тестовую печать.'),
  });

  const devices = query.data?.items ?? [];
  const readiness = printReadiness(devices);

  return (
    <section className="card stack" data-testid="print-agent">
      <div>
        <h2>Печать</h2>
        <p className="muted text-sm">
          Программа на компьютере флориста забирает бланки из очереди и печатает их без диалогов.
          Принтер она берёт тот, который выбран в Windows принтером по умолчанию, и проверяет это
          перед каждой печатью — менять здесь ничего не нужно.
        </p>
      </div>

      {query.isLoading && <LoadingState title="Загружаем список компьютеров…" />}
      {query.isError && (
        <ErrorState
          description="Список компьютеров не загрузился."
          onRetry={() => void query.refetch()}
        />
      )}

      {query.data !== undefined && (
        <>
          <p className="text-sm" data-testid="print-agent-readiness">
            <StatusBadge tone={readiness.ready ? 'success' : 'warning'}>
              {readiness.ready ? 'Печать работает' : 'Требует внимания'}
            </StatusBadge>{' '}
            {readiness.message}
          </p>

          <div className="row">
            <Button
              variant="primary"
              data-testid="print-agent-pair"
              loading={issueCode.isPending}
              onClick={() => issueCode.mutate()}
            >
              Подключить компьютер
            </Button>
            <Button
              variant="secondary"
              data-testid="print-agent-test"
              loading={testPrint.isPending}
              onClick={() => testPrint.mutate()}
            >
              Тестовая печать
            </Button>
          </div>

          {devices.length === 0 ? (
            <EmptyState
              title="Компьютер для печати не подключён"
              description="Пока его нет, бланки печатаются через браузер вручную — это штатный запасной режим."
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Компьютер</th>
                    <th>Состояние</th>
                    <th>Принтер по умолчанию</th>
                    <th>Последняя связь</th>
                    <th>Версия</th>
                    <th>Последнее задание</th>
                    <th>Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((device) => {
                    const actions = deviceActions(device);
                    const busy = pending === device.id;

                    return (
                      <tr key={device.id} data-testid="print-agent-device">
                        <td>
                          {device.name}
                          {device.isPrimary && (
                            <>
                              {' '}
                              <StatusBadge tone="info">Основной</StatusBadge>
                            </>
                          )}
                          {device.os !== null && <div className="muted text-sm">{device.os}</div>}
                        </td>
                        <td>
                          <StatusBadge tone={deviceStateTone(device)}>
                            {deviceStateLabel(device.state)}
                          </StatusBadge>
                        </td>
                        <td>{device.defaultPrinterName ?? '—'}</td>
                        <td>{formatMoment(device.lastSeenAt, formatMoscowDateTime)}</td>
                        <td>{device.agentVersion ?? '—'}</td>
                        <td>
                          {device.lastSucceededAt !== null && (
                            <div className="text-sm">
                              Напечатано {formatMoscowDateTime(device.lastSucceededAt)}
                            </div>
                          )}
                          {device.lastErrorMessage !== null && (
                            <div className="text-sm" data-testid="print-agent-device-error">
                              {device.lastErrorMessage}
                              {device.lastErrorAt !== null && (
                                <span className="muted">
                                  {' '}
                                  ({formatMoscowDateTime(device.lastErrorAt)})
                                </span>
                              )}
                            </div>
                          )}
                          {device.lastSucceededAt === null && device.lastErrorMessage === null && (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          <div className="row">
                            {actions.canMakePrimary && (
                              <Button
                                variant="secondary"
                                data-testid="print-agent-make-primary"
                                loading={busy && makePrimary.isPending}
                                onClick={() => {
                                  setPending(device.id);
                                  makePrimary.mutate(device);
                                }}
                              >
                                Сделать основным
                              </Button>
                            )}
                            {actions.canRevoke && (
                              <Button
                                variant="danger"
                                data-testid="print-agent-revoke"
                                loading={busy && revoke.isPending}
                                onClick={() => {
                                  setPending(device.id);
                                  revoke.mutate(device);
                                }}
                              >
                                Отключить
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {issued !== null && (
        <Modal
          open
          title="Код привязки"
          testId="print-agent-code"
          // Ни закрытия по клику мимо, ни автоматического исчезновения:
          // код показывается один раз, и потерять его на полпути к другому
          // компьютеру означает выпускать новый.
          dismissOnBackdrop={false}
          onClose={() => setIssued(null)}
        >
          <div className="stack">
            <p className="text-sm">
              Введите этот код в программе печати на компьютере флориста. Код действует до{' '}
              {formatMoscowDateTime(issued.expiresAt)} и сработает один раз.
            </p>
            <p className="one-time-code">{issued.display}</p>
            <p className="muted text-sm">
              Мы храним только его отпечаток и показать код повторно не сможем. Если код потерян —
              создайте новый: прежний перестанет действовать.
            </p>
            <Button
              variant="primary"
              data-testid="print-agent-code-close"
              onClick={() => setIssued(null)}
            >
              Я перенёс код
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
