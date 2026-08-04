/**
 * Служебная страница ветки feat/stage1-foundation.
 *
 * Это НЕ интерфейс продукта: единый UI shell, экраны входа и разделы логистики
 * создаются в ветке feat/stage1-ui-shell. Здесь проверяется только то, что собранный
 * клиент отдаётся тем же Node-процессом и видит API.
 */

import { useEffect, useState } from 'react';

interface IntegrationStatus {
  provider: string;
  state: string;
  pendingOperations: number;
}

interface StatusResponse {
  stage: number;
  integrations: IntegrationStatus[];
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: StatusResponse }
  | { kind: 'error'; message: string };

const INTEGRATION_LABELS: Record<string, string> = {
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

const REQUEST_TIMEOUT_MS = 10_000;

export function App(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    // Запрос без предела ожидания оставил бы страницу в вечной загрузке.
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    fetch('/api/status', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Сервис ответил кодом ${response.status}`);
        }
        return (await response.json()) as StatusResponse;
      })
      .then((data) => setState({ kind: 'ready', data }))
      .catch((error: unknown) => {
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Нет связи с сервисом',
        });
      })
      .finally(() => clearTimeout(timer));

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return (
    <main className="page">
      <h1>Логистика — служебная сборка</h1>
      <p className="note">
        Этап 1, ветка <code>feat/stage1-foundation</code>. Рабочий интерфейс ещё не реализован:
        экраны входа, навигация и разделы логистики создаются в ветке{' '}
        <code>feat/stage1-ui-shell</code>.
      </p>

      <section>
        <h2>Состояние интеграций</h2>
        {state.kind === 'loading' && <p className="note">Загрузка…</p>}
        {state.kind === 'error' && <p className="error">Нет связи с сервисом: {state.message}</p>}
        {state.kind === 'ready' && (
          <table>
            <thead>
              <tr>
                <th>Интеграция</th>
                <th>Состояние</th>
                <th>Ожидают отправки</th>
              </tr>
            </thead>
            <tbody>
              {state.data.integrations.map((integration) => (
                <tr key={integration.provider}>
                  <td>{INTEGRATION_LABELS[integration.provider] ?? integration.provider}</td>
                  <td>{STATE_LABELS[integration.state] ?? integration.state}</td>
                  <td>{integration.pendingOperations}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
