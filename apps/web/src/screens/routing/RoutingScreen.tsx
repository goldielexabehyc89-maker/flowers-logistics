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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { VEHICLE_TYPE_LABELS } from '@fl/shared';
import { Plus } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { Button, EmptyState, ErrorState, LoadingState, TextInput } from '../../ui/components';
import { RouteCard } from './RouteCard';
import { DraftLeaseRow } from './DraftLeaseRow';
import { PreviewPanel } from './PreviewPanel';
import { DraftMapPanel } from './DraftMapPanel';
import { useWorkspace } from '../logistics/useWorkspace';
import { formatDate, type RouteListResponse } from './routing';
import './routing.css';

export function RoutingScreen(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { day, draftId, runId, setDay, setDraftId, closeRun } = useWorkspace();
  /*
   * Скрытие списка черновиков — только вид, состояние живёт здесь.
   *
   * Панель убирается из сетки, но не размонтируется: раскрытый черновик,
   * взятая аренда, выбранные заказы и положение прокрутки остаются на месте.
   * Кнопка возврата стоит в карте, которая при этом занимает весь экран.
   */
  const [draftsHidden, setDraftsHidden] = useState(false);

  const routes = useQuery({
    queryKey: ['routes', day],
    queryFn: () =>
      client.get<RouteListResponse>(`/api/routes?deliveryDate=${day}&state=DRAFT&limit=100`),
  });

  const drafts = routes.data?.items ?? [];

  /**
   * Пустой черновик выбранного дня.
   *
   * Отдельная доменная операция сервера, а не «создание маршрута с пустым
   * составом»: черновик из выбора по-прежнему требует хотя бы один заказ.
   * Ключ запроса рождается на нажатии — повторная отправка того же запроса
   * возвращает уже созданный черновик, а не заводит второй.
   */
  const createEmpty = useMutation({
    mutationFn: () =>
      client.post<{ id: string }>('/api/routes/empty', {
        deliveryDate: day,
        // Тип машины у пустого черновика — обычный: логист заводит его
        // заранее, а машину и курьера назначает потом.
        vehicleType: 'CAR',
        /*
         * Ключ рождается ЗДЕСЬ, на каждом вызове операции.
         *
         * Он принадлежит нажатию, а не дню и не экрану: один ключ на дату
         * означал бы, что второе осознанное нажатие молча возвращает первый
         * черновик, а логисту нужно столько черновиков, сколько машин.
         * Повторно ушедший тот же запрос ключ не меняет — потому повтор
         * и не создаёт второго маршрута.
         */
        creationKey: crypto.randomUUID(),
      }),
    onSuccess: async (created) => {
      // Список обновляется запросом, а не догадкой: номер выдаёт сервер.
      await queryClient.invalidateQueries({ queryKey: ['routes', day] });
      // Новый черновик сразу раскрыт и активен: логисту он и нужен открытым,
      // чтобы начать складывать в него заказы.
      setDraftId(created.id);
    },
  });

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

      <div className={`routes__workspace${draftsHidden ? ' routes__workspace--list-hidden' : ''}`}>
        <section className="routes__drafts" id="routing-drafts" data-testid="routing-drafts">
          {/*
            Компактная шапка внутри панели списка.

            День относится к черновикам, поэтому и стоит в их панели: отдельная
            полоса фильтров над рабочим местом разрывала бы поверхность и
            опускала список вместе с картой.
          */}
          <header className="routes__panel-head">
            <span className="routes__panel-title">Черновики дня</span>
            <span className="routes__panel-count">{drafts.length}</span>
            <TextInput
              type="date"
              aria-label="День"
              className="routes__day"
              value={day}
              data-testid="routing-day"
              onChange={(event) => setDay(event.target.value)}
            />
            {/*
              Пустой черновик заводится одним нажатием и без диалога: спрашивать
              нечего — день уже выбран рядом, заказов и курьера у него ещё нет.
              Кнопка стоит в шапке, потому что относится к этому дню и этому
              списку; внизу она жила в отдельной полосе, которая повторяла дату
              и отнимала у списка последнюю строку.
            */}
            <Button className="routes__refresh" onClick={() => void routes.refetch()}>
              Обновить
            </Button>
            <button
              type="button"
              className="routes__draft-add"
              data-testid="routing-add-draft"
              aria-label="Добавить пустой черновик"
              title="Добавить пустой черновик"
              disabled={createEmpty.isPending}
              onClick={() => createEmpty.mutate()}
            >
              <Plus size={15} aria-hidden="true" />
            </button>
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
                description="Черновики создаются в «Сделках» выбором заказов или автоматической разбивкой. Пустой черновик можно завести кнопкой «+» в шапке списка."
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
                        <span className="routes__draft-badge">Черновик</span>
                        <span className="routes__draft-meta">
                          {formatDate(draft.deliveryDate)} ·{' '}
                          {VEHICLE_TYPE_LABELS[draft.vehicleType]} · остановок {draft.orderCount}
                          {draft.conflictCount > 0 ? ` · расхождений: ${draft.conflictCount}` : ''}
                        </span>
                        <span className="routes__draft-toggle-text">
                          {expanded ? 'Свернуть' : 'Развернуть'}
                        </span>
                      </button>

                      {/* Аренда видна и у свёрнутой строки: занят маршрут или свободен. */}
                      {!expanded && <DraftLeaseRow routeId={draft.id} />}

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
        </section>

        <DraftMapPanel
          deliveryDate={day}
          activeRouteId={activeId}
          drafts={drafts}
          draftsHidden={draftsHidden}
          /*
            Скрытие — только вид: список не размонтируется, раскрытый черновик,
            аренда и прокрутка остаются нетронутыми.
          */
          onToggleDrafts={() => setDraftsHidden((current) => !current)}
        />
      </div>
    </section>
  );
}
