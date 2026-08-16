/**
 * Вкладка «Маршрутизация» — рабочее место редактирования готовых черновиков.
 *
 * Слева вертикальный список черновиков дня, справа карта. Черновики приходят
 * из «Сделок» уже созданными: ручным действием или автоматической разбивкой.
 * Технического запуска расчёта, очереди и превью здесь нет намеренно — это
 * стадии сервера, а не рабочего места. Раньше расчёт занимал половину экрана
 * и показывал заказы обрезанными UUID, по которым план нельзя было проверить.
 *
 * Раскрыт одновременно ровно один черновик. Раскрытие другого сворачивает
 * предыдущий, ничего не теряя: состав живёт на сервере, а не в браузере, и
 * каждая операция сохраняется сразу.
 *
 * День и активный черновик живут в адресе, поэтому обновление страницы
 * и прямая ссылка возвращают тот же экран.
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  StatusBadge,
  TextInput,
} from '../../ui/components';
import { RouteCard } from './RouteCard';
import { PreviewPanel } from './PreviewPanel';
import { DraftMapPanel } from './DraftMapPanel';
import { useWorkspace } from '../logistics/useWorkspace';
import { formatDate, ROUTE_STATE_LABELS, VEHICLE_LABELS, type RouteListResponse } from './routing';
import './routing.css';

export function RoutingScreen(): React.JSX.Element {
  const { client } = useAuth();
  const { day, draftId, runId, setDay, setDraftId, closeRun } = useWorkspace();

  const routes = useQuery({
    queryKey: ['routes', day],
    queryFn: () =>
      client.get<RouteListResponse>(`/api/routes?deliveryDate=${day}&state=DRAFT&limit=100`),
  });

  const drafts = routes.data?.items ?? [];

  /**
   * Активный черновик проверяется по пришедшему списку.
   *
   * Ссылка могла указывать на черновик другого дня или на уже подтверждённый:
   * молча раскрыть «ничего» значило бы показать пустое место без объяснения.
   */
  const activeId = drafts.some((item) => item.id === draftId) ? draftId : null;
  const missingDraft = draftId !== null && activeId === null && !routes.isPending;

  return (
    <section className="stack routes" data-testid="routing-workspace">
      <header className="routes__header">
        <div>
          <h2>Маршрутизация</h2>
          <p className="muted text-sm">
            Черновики выбранного дня. Состав, порядок остановок и курьер меняются здесь;
            подтверждённый черновик уходит в «Маршрутные листы».
          </p>
        </div>
        <Field label="День">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="date"
              value={day}
              onChange={(event) => setDay(event.target.value)}
            />
          )}
        </Field>
      </header>

      {/*
        Предложенный расчёт.

        Показывается ВМЕСТО работы с черновиками: пока предложение не принято,
        черновиков из него не существует, и править нечего. Применение
        раскрывает первый созданный черновик, отклонение просто возвращает
        к списку.
      */}
      {runId !== null && (
        <PreviewPanel
          runId={runId}
          onApplied={(firstDraftId) => {
            closeRun();
            setDraftId(firstDraftId);
          }}
          onDismissed={closeRun}
        />
      )}

      {missingDraft && (
        <p className="routes__hint" role="status">
          Черновик из ссылки не найден среди черновиков этого дня: он мог быть подтверждён, отменён
          или относиться к другой дате.
        </p>
      )}

      <div className="routes__workspace">
        <section className="routes__panel routes__drafts" data-testid="routing-drafts">
          <header className="routes__panel-header">
            <h3>Черновики дня</h3>
            <span className="muted text-sm">{drafts.length}</span>
          </header>

          {routes.isPending ? (
            <LoadingState title="Загружаем черновики…" />
          ) : routes.isError ? (
            <ErrorState
              title="Не удалось загрузить черновики"
              onRetry={() => void routes.refetch()}
            />
          ) : drafts.length === 0 ? (
            <EmptyState
              title="Черновиков на этот день нет"
              description="Черновики создаются в «Сделках»: выбором заказов вручную или автоматической разбивкой."
            />
          ) : (
            <ul className="routes__draft-list">
              {drafts.map((draft) => {
                const expanded = draft.id === activeId;
                return (
                  <li
                    key={draft.id}
                    className={`routes__draft${expanded ? ' routes__draft--open' : ''}`}
                    data-draft-number={draft.number}
                    data-expanded={expanded ? 'true' : 'false'}
                  >
                    <button
                      type="button"
                      className="routes__draft-head routes__number-button"
                      aria-expanded={expanded}
                      // Повторное нажатие сворачивает: раскрытым остаётся
                      // ровно один черновик или ни одного.
                      onClick={() => setDraftId(expanded ? null : draft.id)}
                    >
                      <span className="routes__number">{draft.number}</span>
                      <StatusBadge tone="info">{ROUTE_STATE_LABELS[draft.state]}</StatusBadge>
                      <span className="muted text-sm">
                        {VEHICLE_LABELS[draft.vehicleType]} · заказов: {draft.orderCount}
                        {draft.conflictCount > 0 ? ` · расхождений: ${draft.conflictCount}` : ''}
                      </span>
                      <span className="muted text-sm">
                        Курьер: {draft.courier?.fullName ?? 'не назначен'}
                      </span>
                    </button>

                    {expanded && (
                      <RouteCard
                        routeId={draft.id}
                        embedded
                        onClose={() => setDraftId(null)}
                        // Подтверждённый черновик перестаёт быть черновиком
                        // и обязан исчезнуть отсюда, а не остаться раскрытым.
                        onConfirmed={() => setDraftId(null)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="routes__panel-actions">
            <Button onClick={() => void routes.refetch()}>Обновить список</Button>
            <span className="muted text-sm">{formatDate(day)}</span>
          </div>
        </section>

        <DraftMapPanel deliveryDate={day} activeRouteId={activeId} drafts={drafts} />
      </div>
    </section>
  );
}
