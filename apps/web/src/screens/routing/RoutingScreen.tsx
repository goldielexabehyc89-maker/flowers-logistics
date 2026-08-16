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
import { Button, EmptyState, ErrorState, LoadingState, TextInput } from '../../ui/components';
import { RouteCard } from './RouteCard';
import { PreviewPanel } from './PreviewPanel';
import { DraftMapPanel } from './DraftMapPanel';
import { useWorkspace } from '../logistics/useWorkspace';
import { formatDate, type RouteListResponse } from './routing';
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
    <section className="routes" data-testid="routing-workspace">
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
        <section className="routes__drafts" data-testid="routing-drafts">
          {/*
            Компактная шапка внутри панели списка.

            День относится к черновикам, поэтому и стоит в их панели: отдельная
            полоса фильтров над рабочим местом разрывала бы поверхность и
            опускала список вместе с картой.
          */}
          <header className="routes__panel-head">
            <span className="routes__panel-title">Черновики дня</span>
            <span className="muted text-sm">{drafts.length}</span>
            <TextInput
              type="date"
              aria-label="День"
              value={day}
              data-testid="routing-day"
              onChange={(event) => setDay(event.target.value)}
            />
          </header>

          {/* Прокручивается только середина: шапка и действия остаются на месте. */}
          <div className="routes__drafts-body">
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
                        {/*
                          Свёрнутая строка несёт только опознавательные
                          признаки: состояние — цветом точки, объём —
                          счётчиком. Курьер и тип машины стоят сразу под ней
                          в раскрытом виде; повторять их здесь значило бы
                          занять вторую строку ради уже видимого.
                        */}
                        <span
                          className={`routes__draft-dot${
                            draft.state === 'CONFIRMED' ? ' routes__draft-dot--confirmed' : ''
                          }`}
                          aria-hidden="true"
                        />
                        <span className="routes__number">{draft.number}</span>
                        <span className="routes__draft-count">
                          {draft.orderCount} зак.
                          {draft.conflictCount > 0 ? ` · расхождений: ${draft.conflictCount}` : ''}
                        </span>
                        <span className="routes__draft-chevron" aria-hidden="true">
                          {expanded ? '▲' : '▼'}
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
          </div>

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
