/**
 * Настройки — честная заглушка, а не редактор.
 *
 * Реального редактирования нет намеренно: набор полей интеграции определяется
 * только после read-only исследования МоегоСклада, а провайдер карт выбирает
 * владелец. Сохранять настройки «только на клиенте» нельзя — это создало бы
 * видимость работы.
 */

import { useQuery } from '@tanstack/react-query';
import { OutboxFailures } from './OutboxFailures';
import { useAuth } from '../auth/AuthContext';
import { ErrorState, LoadingState, StatusBadge, type StatusTone } from '../ui/components';

interface IntegrationStatus {
  provider: string;
  state: string;
  pendingOperations: number;
  updatedAt: string;
}

interface StatusResponse {
  stage: number;
  integrations: IntegrationStatus[];
}

const PROVIDER_LABELS: Record<string, string> = {
  moysklad: 'МойСклад',
  maps: 'Карты',
};

const STATE_LABELS: Record<string, string> = {
  NOT_CONFIGURED: 'Не настроена',
  CONFIGURED: 'Настроена',
  OK: 'Работает',
  DEGRADED: 'Работает с ошибками',
  ERROR: 'Ошибка',
};

function toneFor(state: string): StatusTone {
  if (state === 'OK') return 'success';
  if (state === 'ERROR' || state === 'DEGRADED') return 'error';
  if (state === 'CONFIGURED') return 'info';
  return 'warning';
}

const REQUIRED_SETTINGS = [
  'Адрес склада',
  'Обычный тариф: ставка за заказ и за километр за МКАД',
  'Вместимость и максимальная длительность автомобильного и пешего маршрута',
  'Сервисное время на заказ и резерв времени',
  'Подключение МоегоСклада',
  'Подключение карт',
];

export function SettingsScreen(): React.JSX.Element {
  const { client } = useAuth();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['status', 'integrations'],
    // Экран доступен только администратору, поэтому берутся технические
    // подробности: публичный /api/status их намеренно не отдаёт.
    queryFn: () => client.get<StatusResponse>('/api/status/integrations'),
  });

  return (
    <div className="stack">
      <section className="card stack">
        <div>
          <h2>Состояние интеграций</h2>
          <p className="muted text-sm">
            Значения только для чтения. Ключи и токены вводит владелец, они хранятся на сервере и
            никогда не передаются в браузер.
          </p>
        </div>

        {isLoading && <LoadingState />}
        {isError && <ErrorState onRetry={() => void refetch()} />}

        {data !== undefined && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Интеграция</th>
                  <th>Состояние</th>
                  <th>Ожидают отправки</th>
                </tr>
              </thead>
              <tbody>
                {data.integrations.map((integration) => (
                  <tr key={integration.provider}>
                    <td>{PROVIDER_LABELS[integration.provider] ?? integration.provider}</td>
                    <td>
                      <StatusBadge tone={toneFor(integration.state)}>
                        {STATE_LABELS[integration.state] ?? integration.state}
                      </StatusBadge>
                    </td>
                    <td>{integration.pendingOperations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <OutboxFailures />

      <section className="card stack">
        <div>
          <h2>Обязательные настройки до начала работы</h2>
          <p className="muted text-sm">
            Пока эти настройки не заполнены, данные можно просматривать, но подтверждение и отгрузка
            маршрутов будут заблокированы.
          </p>
        </div>
        <ul className="text-sm">
          {REQUIRED_SETTINGS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-sm muted">
          Редактирование появится после read-only исследования МоегоСклада и выбора владельцем
          картографического провайдера: до этого набор полей неизвестен, и придумывать его означало
          бы гарантированную переделку.
        </p>
      </section>
    </div>
  );
}
