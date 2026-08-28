/**
 * Раздел флориста: очередь, свои заказы и печать.
 *
 * Экран рабочий, а не витринный: флорист смотрит его весь день со стола или
 * с планшета, поэтому строки плотные, а решения видны без наведения —
 * просрочка, маршрут и занятость заказа читаются сразу.
 *
 * СМЕНА ВВЕРХУ НЕ СЛУЧАЙНО. Без активной смены новый заказ взять нельзя,
 * и человек обязан видеть причину отказа до того, как нажмёт кнопку.
 *
 * ДЕНЬ СЧИТАЕТ СЕРВЕР. Переключатель посылает `today`/`tomorrow`, а не дату:
 * браузер к вычислению московского дня не допускается (`TZ-001`). Показанная
 * дата приходит ответом сервера.
 *
 * ОШИБКА НЕ ОСТАВЛЯЕТ ЛОЖНОГО СОСТОЯНИЯ. Списки не правятся «оптимистично»:
 * после каждого действия и каждого отказа данные перезапрашиваются, а realtime
 * обновляет ровно те запросы, которых касается событие.
 *
 * СПИСКИ ГРУЗЯТСЯ СТРАНИЦАМИ. День мастерской — сотня с лишним заказов, и
 * показывать их разом незачем: человек смотрит десяток. Сервер отдаёт первые
 * 50 УЖЕ упорядоченных строк вместе с общим количеством, «Загрузить ещё»
 * добавляет следующие.
 *
 * ЛЮБОЕ ИЗМЕНЕНИЕ ВОЗВРАЩАЕТ К ПЕРВОЙ СТРАНИЦЕ. Накопленные страницы
 * сбрасываются и после собственного действия, и по событию realtime: очередь
 * живёт, смещения сдвигаются, и дозагрузка поверх устаревшей стопки дала бы
 * либо повтор строки, либо пропуск. Пиксель прокрутки при этом не сохраняется —
 * и не обязан: сохранять положение в списке, который перестроился, значило бы
 * показывать человеку не то место, на которое он смотрел.
 *
 * КАРТОЧКА — МОДАЛЬНОЕ ОКНО. Раньше она рисовалась обычным блоком ПОСЛЕ всего
 * списка: на первой странице из пятидесяти заказов человек нажимал кнопку и не
 * видел ничего — карточка появлялась экранами ниже. Теперь она открывается
 * поверх списка, а список под ней остаётся ровно там, где был: день, вкладка,
 * поиск, догруженные страницы и прокрутка переживают открытие и закрытие,
 * потому что ничего из этого не размонтируется.
 *
 * ОТКРЫВАЕТ ТОЛЬКО КНОПКА `Просмотр`. Кликабельный номер и кликабельная строка
 * убраны: в плотном списке они срабатывали при попытке выделить номер или
 * прокрутить страницу пальцем.
 *
 * «МОИ ЗАКАЗЫ» — ДВЕ ГРУППЫ. Работа раскрыта, собранные свёрнуты и загружаются
 * только после раскрытия. Обе группы считает и отдаёт сервер: фильтровать
 * загруженную страницу в браузере значило бы врать в счётчике.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { formatMoscowDateTime } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { collapseToFirstPage } from '../../realtime/stream';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  SegmentedControl,
  StatusBadge,
} from '../../ui/components';
import { OrderCardPanel } from './OrderCardPanel';
import {
  QUEUE_PAGE_SIZE,
  QUEUE_POLL_MS,
  formatDay,
  formatInterval,
  latestJob,
  mergePages,
  nextPageOffset,
  pageSummary,
  printStateLabel,
  groupQueueByRoute,
  queueGroupTitle,
  processLabel,
  routeLabel,
  safeFileName,
  type FloristOption,
  type PrintPointOption,
  type FloristTab,
  type OrderCardView,
  type PrintJobsResponse,
  type PrintJobView,
  type QueueDay,
  type QueueItemView,
  type QueueResponse,
  type ShiftResponse,
  type ShiftView,
} from './florist';
import './florist.css';

/**
 * Пауза перед серверным поиском.
 *
 * Запрос на каждое нажатие клавиши означал бы десяток запросов на один номер
 * заказа, и ответы возвращались бы вперемешку. Задержка небольшая: поиск
 * обязан ощущаться мгновенным.
 */
const SEARCH_DEBOUNCE_MS = 250;

const TABS: { key: FloristTab; title: string }[] = [
  { key: 'queue', title: 'Очередь' },
  { key: 'mine', title: 'Мои заказы' },
  { key: 'print', title: 'Печать' },
];

export function FloristScreen(): React.JSX.Element {
  const { client, user } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // Административные возможности флориста (смены, назначение, переоткрытие)
  // доступны и управляющему: он — операционный администратор. Сервер
  // подтверждает это тем же `FLORIST_ADMIN_ROLES`.
  const isAdmin =
    user?.roles.includes('ADMIN') === true || user?.roles.includes('SUPERVISOR') === true;
  const viewerId = user?.id ?? '';

  const [tab, setTab] = useState<FloristTab>('queue');
  const [day, setDay] = useState<QueueDay>('today');
  const [includeAssigned, setIncludeAssigned] = useState(false);
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  /**
   * Раскрыта ли группа «Собранные».
   *
   * Состояние только в памяти экрана: ни в БД, ни в browser storage. При
   * каждом входе во вкладку и при смене дня группа снова свёрнута — собранный
   * заказ работой не является, и открытая стопка вчерашних успехов закрывала
   * бы то, что нужно собрать сейчас.
   */
  const [assembledOpen, setAssembledOpen] = useState(false);
  const [printFilter, setPrintFilter] = useState<'attention' | 'printed'>('attention');
  /**
   * «Общие»: задания всех флористов за последние двое суток.
   *
   * Выключено — свои: разбирать чужую печать вместо своей флорист не должен.
   * Окно и отбор считает сервер, поэтому счётчик и продолжение списка
   * говорят об одном и том же множестве.
   */
  const [printGeneral, setPrintGeneral] = useState(false);
  /** Причина принудительного завершения — своя у каждой смены в списке. */
  /** Что человек набрал, и что из этого уже ушло на сервер. */
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const scope = tab === 'mine' ? 'mine' : 'general';

  /**
   * Смена и счётчик активных заказов.
   *
   * Запрос без `enabled`: он нужен на всех трёх вкладках. Именно поэтому число
   * активных заказов приходит здесь, а не в ответе очереди, — на «Печати»
   * очередь не запрашивается вовсе, а счётчик обязан остаться на виду.
   */
  const shiftQuery = useQuery({
    queryKey: ['florist-shift'],
    queryFn: () => client.get<ShiftResponse>('/api/florist/shift'),
  });

  /** Адрес страницы списка. Один на обе группы: условия у них общие. */
  function queueUrl(group: 'work' | 'assembled', offset: number): string {
    return (
      `/api/florist/queue?day=${day}&scope=${scope}&group=${group}` +
      `&all=${includeAssigned ? 'true' : 'false'}` +
      `&limit=${QUEUE_PAGE_SIZE}&offset=${offset}` +
      (search === '' ? '' : `&search=${encodeURIComponent(search)}`)
    );
  }

  /**
   * Рабочий список страницами.
   *
   * День, область, группа, галочка «Все» и строка поиска входят в ключ запроса,
   * поэтому смена любого из них — это другой список: накопленные страницы
   * отбрасываются сами, и первая страница нового набора запрашивается заново.
   * Смешать «Сегодня» с «Завтра», работу с собранным или чужой поиск со своим
   * здесь физически нечем.
   */
  const queueQuery = useInfiniteQuery({
    queryKey: ['florist-queue', day, scope, 'work', includeAssigned, search],
    queryFn: ({ pageParam }) => client.get<QueueResponse>(queueUrl('work', pageParam)),
    initialPageParam: 0,
    getNextPageParam: (last: QueueResponse) => nextPageOffset(last) ?? undefined,
    enabled: tab !== 'print',
    /*
     * Короткий опрос очереди — из-за хода времени, а не из-за событий.
     *
     * Момент «до самовывоза осталось меньше часа» не сопровождается ничьим
     * действием: никто ничего не менял, менять нечего, и realtime молчит по
     * существу. Обновляется ровно этот запрос: страница не перезагружается,
     * раскрытые группы и введённые фильтры живут в состоянии экрана и опросом
     * не затрагиваются, а догруженные страницы обновляются на месте.
     */
    refetchInterval: QUEUE_POLL_MS,
    // В фоновой вкладке опрос не идёт: смотреть на неё некому, а при возврате
    // react-query перезапросит список сам.
    refetchIntervalInBackground: false,
  });

  const printQuery = useInfiniteQuery({
    queryKey: ['florist-print-jobs', printFilter, printGeneral],
    queryFn: ({ pageParam }) =>
      client.get<PrintJobsResponse>(
        `/api/florist/print-jobs?filter=${printFilter}&general=${String(printGeneral)}` +
          `&limit=${QUEUE_PAGE_SIZE}&offset=${pageParam}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (last: PrintJobsResponse) => nextPageOffset(last) ?? undefined,
    enabled: tab === 'print',
  });

  /**
   * Смена фильтра сбрасывает накопленные страницы ВСЕХ представлений очереди.
   *
   * Каждое сочетание дня, области, галочки «Все» и поиска — свой запрос со
   * своим кэшем, поэтому смешаться они не могут и сами по себе. Но кэш прежнего
   * представления помнит и вторую, и третью догруженные страницы, и возврат
   * к нему показал бы стопку, набранную неизвестно когда: за это время заказы
   * успели уйти в работу, а новые — появиться. Честнее начать с первой
   * страницы, чем восстановить вид, которого больше нет.
   */
  useEffect(() => {
    queryClient.setQueriesData<unknown>({ queryKey: ['florist-queue'] }, collapseToFirstPage);
  }, [day, scope, includeAssigned, search, queryClient]);

  /**
   * Вход во вкладку и смена дня сворачивают группу собранных.
   *
   * Именно вход, а не первое построение экрана: человек возвращается в «Мои
   * заказы» за работой, и раскрытая стопка собранного отодвигала бы её вниз.
   */
  useEffect(() => {
    setAssembledOpen(false);
  }, [tab, day]);

  useEffect(() => {
    queryClient.setQueriesData<unknown>({ queryKey: ['florist-print-jobs'] }, collapseToFirstPage);
  }, [printFilter, printGeneral, queryClient]);

  const queuePages = queueQuery.data?.pages ?? [];
  const queueItems = mergePages(queuePages);
  /** Общее число берётся из ПЕРВОЙ страницы: она самая свежая после сброса. */
  const queueTotal = queuePages[0]?.total ?? 0;
  const queueDate = queuePages[0]?.deliveryDate;

  /**
   * Сколько собранных заказов в этом дне. Считает сервер.
   *
   * Число приходит вместе с рабочим списком, поэтому оно известно и тогда,
   * когда группа свёрнута и её строки не запрашивались.
   */
  const assembledTotal = queuePages[0]?.assembledTotal ?? 0;

  /**
   * Поиск временно раскрывает группу собранных.
   *
   * Иначе человек, ищущий номер уже собранного заказа, получил бы пустой
   * рабочий список и решил, что заказа нет вовсе. Раскрытие именно временное:
   * снятие поиска возвращает обычное свёрнутое состояние, потому что оно
   * вычисляется, а не запоминается.
   */
  const foundInAssembled = tab === 'mine' && search !== '' && assembledTotal > 0;
  const assembledExpanded = tab === 'mine' && (assembledOpen || foundInAssembled);

  /**
   * Собранные загружаются ТОЛЬКО после раскрытия.
   *
   * Свёрнутая группа не строит ни одной строки DOM и не занимает ни одного
   * запроса: у флориста к концу дня их шестьдесят, и держать их в памяти ради
   * заголовка со счётчиком незачем.
   */
  const assembledQuery = useInfiniteQuery({
    queryKey: ['florist-queue', day, scope, 'assembled', includeAssigned, search],
    queryFn: ({ pageParam }) => client.get<QueueResponse>(queueUrl('assembled', pageParam)),
    initialPageParam: 0,
    getNextPageParam: (last: QueueResponse) => nextPageOffset(last) ?? undefined,
    enabled: assembledExpanded,
  });

  const assembledPages = assembledQuery.data?.pages ?? [];
  const assembledItems = assembledExpanded ? mergePages(assembledPages) : [];
  const assembledShownTotal = assembledPages[0]?.total ?? assembledTotal;

  const printPages = printQuery.data?.pages ?? [];
  const printItems = mergePages(printPages);
  const printTotal = printPages[0]?.total ?? 0;

  const cardQuery = useQuery({
    queryKey: ['florist-card', openOrderId],
    queryFn: () => client.get<{ card: OrderCardView }>(`/api/florist/orders/${openOrderId ?? ''}`),
    enabled: openOrderId !== null,
  });

  const floristsQuery = useQuery({
    queryKey: ['florist-florists'],
    queryFn: () => client.get<{ items: FloristOption[] }>('/api/florist/florists'),
    enabled: isAdmin,
  });

  /** Кто сейчас на смене. Только администратору: это управление людьми. */
  const shiftsQuery = useQuery({
    queryKey: ['florist-shifts'],
    queryFn: () => client.get<{ items: ShiftView[] }>('/api/florist/shifts'),
    enabled: isAdmin,
  });

  const shift = shiftQuery.data?.shift ?? null;
  const hasActiveShift = shift !== null;

  /**
   * Сколько заказов сейчас за флористом. Считает сервер, и только он.
   *
   * Ни длина загруженной страницы, ни выбранный день, ни строка поиска, ни
   * содержимое DOM в это число не входят: все они дают разный ответ на один
   * вопрос. До первого ответа сервера показывается `null` — счётчик просто
   * отсутствует, а не показывает выдуманный ноль.
   */
  const activeOrders = shiftQuery.data?.activeOrders ?? null;

  /**
   * Общий перезапрос после любого действия.
   *
   * Точечное «поправим строку на месте» здесь было бы вредным: сервер мог
   * отказать, перевести заказ в другое состояние или отдать его другому
   * флористу, и локальная догадка разошлась бы с действительностью.
   */
  async function refresh(): Promise<void> {
    // Списки с продолжением возвращаются к первой странице ДО перезапроса.
    // Иначе перезапрашивались бы все накопленные страницы — то есть весь
    // день целиком, ради чего страницы и вводились, — да ещё и поверх
    // сместившейся выборки.
    queryClient.setQueriesData<unknown>({ queryKey: ['florist-queue'] }, collapseToFirstPage);
    queryClient.setQueriesData<unknown>({ queryKey: ['florist-print-jobs'] }, collapseToFirstPage);

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['florist-queue'] }),
      queryClient.invalidateQueries({ queryKey: ['florist-card'] }),
      queryClient.invalidateQueries({ queryKey: ['florist-print-jobs'] }),
      queryClient.invalidateQueries({ queryKey: ['florist-shift'] }),
      queryClient.invalidateQueries({ queryKey: ['florist-shifts'] }),
      queryClient.invalidateQueries({ queryKey: ['florist-florists'] }),
    ]);
  }

  function reportError(error: unknown, fallback: string): void {
    showToast(error instanceof ApiError ? error.message : fallback, 'error');
  }

  /**
   * Точки печати, доступные флористу.
   *
   * Запрашиваются всегда, а не только при открытом выборе: пока их ноль,
   * ни строки о печати не показывается вовсе — в мастерской без принтера
   * лишних слов быть не должно.
   */
  const printPointsQuery = useQuery({
    queryKey: ['florist-print-points'],
    queryFn: () => client.get<{ items: PrintPointOption[] }>('/api/florist/print-points'),
  });

  const printPoints = printPointsQuery.data?.items ?? [];

  /** Открыт ли выбор точки и что делать после выбора. */
  const [pointPicker, setPointPicker] = useState<{ afterOrderId: string | null } | null>(null);

  const action = useMutation({
    mutationFn: async (input: { path: string; body?: unknown; success: string }) => {
      await client.post(input.path, input.body);
      return input.success;
    },
    onSuccess: async (message) => {
      await refresh();
      showToast(message, 'success');
    },
    onError: async (error: unknown) => {
      // Перезапрос ОБЯЗАТЕЛЕН и при отказе: заказ мог уйти другому флористу,
      // и экран не должен продолжать показывать его свободным.
      await refresh();
      reportError(error, 'Не удалось выполнить действие.');
    },
  });

  /**
   * Выбор точки печати на текущую смену.
   *
   * После выбора работа ПРОДОЛЖАЕТСЯ сама: если выбор открылся из-за нажатия
   * «Собран», сборка выполняется тут же. Заставлять человека нажимать дважды
   * значило бы наказывать его за то, что мы спросили не вовремя.
   */
  const choosePoint = useMutation({
    mutationFn: async (input: { printPointId: string; afterOrderId: string | null }) => {
      await client.post('/api/florist/shift/print-point', { printPointId: input.printPointId });
      return input;
    },
    onSuccess: async (input) => {
      setPointPicker(null);
      await refresh();
      if (input.afterOrderId !== null) {
        assemble(input.afterOrderId);
      }
    },
    onError: (error: unknown) => reportError(error, 'Не удалось выбрать точку печати.'),
  });

  /**
   * «Собран».
   *
   * Точка печати спрашивается ДО отправки, но не запрещает работу: отказаться
   * от выбора можно, и тогда заказ всё равно соберётся, а наклейку напечатают
   * вручную. Печать не имеет права останавливать цех.
   */
  function assemble(orderId: string): void {
    // Версия процесса та, которую видел человек: чужое изменение обязано
    // отказать, а не перезаписать чужую работу.
    const open = cardQuery.data?.card ?? null;
    const version = open?.id === orderId ? open.process.version : null;

    action.mutate({
      path: `/api/florist/orders/${orderId}/assemble`,
      ...(version === null ? {} : { body: { expectedProcessVersion: version } }),
      success: 'Заказ собран, бланк поставлен в очередь печати',
    });
  }

  function assembleWithPoint(orderId: string): void {
    const needsPoint = shift !== null && shift.printPointId === null && printPoints.length > 0;
    if (needsPoint) {
      setPointPicker({ afterOrderId: orderId });
      return;
    }
    assemble(orderId);
  }

  /** Скачивание документа: токен живёт в памяти, поэтому обычная ссылка не годится. */
  async function download(path: string, fileName: string): Promise<void> {
    try {
      const blob = await client.getBlob(path, 'application/pdf');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      reportError(error, 'Не удалось получить бланк.');
    }
  }

  /** Из карточки открывается ПОСЛЕДНИЙ бланк заказа: он относится к текущей сборке. */
  async function downloadOrderPdf(orderId: string, number: string): Promise<void> {
    await download(`/api/florist/orders/${orderId}/print-form.pdf`, `order-${number}.pdf`);
  }

  /**
   * Термоэтикетка того же заказа.
   *
   * Отдельная кнопка, а не замена бланка: к букету едут оба — бланк для
   * человека и наклейка 58×40 мм на коробку. Имя файла повторяет серверное,
   * иначе в папке загрузок этикетка и бланк выглядели бы одним документом.
   */
  async function downloadOrderLabel(orderId: string, number: string): Promise<void> {
    await download(`/api/florist/orders/${orderId}/label.pdf`, `label-${safeFileName(number)}.pdf`);
  }

  async function downloadJobLabel(job: PrintJobView): Promise<void> {
    await download(
      `/api/florist/print-jobs/${job.id}/label.pdf`,
      `label-${safeFileName(job.orderNumber)}.pdf`,
    );
  }

  /**
   * Из вкладки «Печать» открывается документ КОНКРЕТНОГО задания.
   *
   * Это не то же самое, что последний бланк заказа: после пересборки у заказа
   * появляется новая форма, а старая попытка обязана отдавать ровно тот
   * документ, ради которого её создавали, — иначе к букету приложат бумагу
   * от другой сборки.
   */
  async function downloadJobPdf(job: PrintJobView): Promise<void> {
    await download(
      `/api/florist/print-jobs/${job.id}/document.pdf`,
      `order-${job.orderNumber}-attempt-${job.attempt}.pdf`,
    );
  }

  const card = cardQuery.data?.card ?? null;

  /**
   * Строка списка. Одна и та же в работе и в собранных.
   *
   * Номер — обычный текст. Кликабельным он был раньше и в плотном списке
   * срабатывал при попытке выделить номер или прокрутить страницу пальцем;
   * открыть карточку теперь можно только явной кнопкой `Просмотр`.
   */
  function queueRow(item: QueueItemView): React.JSX.Element {
    return (
      <li
        key={item.id}
        className={`florist__row${item.overdue ? ' florist__row--overdue' : ''}`}
        data-testid="florist-row"
        data-order-number={item.number}
      >
        <div className="florist__row-main">
          <span className="florist__number">{item.number}</span>
          <span className="florist__time">{formatInterval(item)}</span>
          {item.overdue && <StatusBadge tone="error">Просрочен</StatusBadge>}
          {routeLabel(item) !== null && <StatusBadge tone="info">{routeLabel(item)}</StatusBadge>}
          {item.changedSinceClaim && <StatusBadge tone="warning">Заказ изменён</StatusBadge>}
          {/*
            Отменённый заказ остаётся в списке видимым и помеченным.
            Исчезнувший заказ флорист ищет, а помеченный — пропускает.
          */}
          {item.cancelled === true && <StatusBadge tone="error">Отменён — не собирать</StatusBadge>}
        </div>

        <div className="florist__row-side">
          <span className="muted text-sm">{processLabel(item.processState)}</span>
          {item.assignee !== null && (
            <span className="muted text-sm" data-testid="row-assignee">
              {item.assignee.fullName}
            </span>
          )}
          {item.processState === 'NEW' && (
            <Button
              variant="primary"
              disabled={action.isPending || !hasActiveShift || item.cancelled === true}
              data-testid="row-claim"
              onClick={() =>
                action.mutate({
                  path: `/api/florist/orders/${item.id}/claim`,
                  success: `Заказ ${item.number} взят в работу`,
                })
              }
            >
              Взять в работу
            </Button>
          )}
          <Button variant="ghost" data-testid="row-open" onClick={() => setOpenOrderId(item.id)}>
            Просмотр
          </Button>
        </div>
      </li>
    );
  }

  return (
    <section className="stack florist">
      <header className="florist__header card">
        <div>
          {/* Заголовок раздела рисует оболочка приложения: второй <h1> здесь
              создал бы два одинаковых заголовка первого уровня на одной странице. */}
          <h2>Рабочее место флориста</h2>
          <p className="muted text-sm">
            {hasActiveShift
              ? `Смена с ${formatMoscowDateTime(shift.startedAt)} · в сборке: ${shift.openAssignments}`
              : 'Смена не начата. Без неё новый заказ взять нельзя.'}
          </p>
        </div>
        <div className="row">
          {hasActiveShift ? (
            <Button
              variant="secondary"
              data-testid="shift-close"
              disabled={action.isPending}
              onClick={() =>
                action.mutate({ path: '/api/florist/shift/close', success: 'Смена завершена' })
              }
            >
              Завершить смену
            </Button>
          ) : (
            <Button
              variant="primary"
              data-testid="shift-start"
              disabled={action.isPending}
              onClick={() =>
                action.mutate({ path: '/api/florist/shift/start', success: 'Смена начата' })
              }
            >
              Начать смену
            </Button>
          )}
        </div>
      </header>

      {/*
        Точка печати смены.

        Одна строка, а не раздел: выбор делается раз за смену и дальше только
        читается. Пока точек нет ни одной, строка не показывается вовсе —
        в мастерской без принтера лишних слов быть не должно.
      */}
      {hasActiveShift && printPoints.length > 0 && (
        <div className="card row florist__print-point" data-testid="florist-print-point">
          <div>
            <span className="muted text-sm">Точка печати: </span>
            <strong data-testid="florist-print-point-name">
              {shift.printPointName ?? 'не выбрана'}
            </strong>
            {shift.printPointId === null && (
              <div className="muted text-sm">
                Наклейки собранных заказов печатаются вручную, пока точка не выбрана.
              </div>
            )}
          </div>
          <Button
            variant="secondary"
            data-testid="florist-print-point-change"
            disabled={choosePoint.isPending}
            onClick={() => setPointPicker({ afterOrderId: null })}
          >
            {shift.printPointId === null ? 'Выбрать' : 'Изменить'}
          </Button>
        </div>
      )}

      {pointPicker !== null && (
        <Modal
          open
          title="Куда печатать наклейки"
          onClose={() => setPointPicker(null)}
          testId="florist-point-picker"
        >
          <div className="stack">
            <p className="muted text-sm">
              Выберите компьютер с принтером, за которым работаете. Выбор сохранится до конца смены.
            </p>
            <ul className="florist__list">
              {printPoints.map((point) => (
                <li key={point.id} className="florist__row">
                  <span>{point.name}</span>
                  <Button
                    variant="primary"
                    data-testid="florist-point-choose"
                    disabled={choosePoint.isPending}
                    onClick={() =>
                      choosePoint.mutate({
                        printPointId: point.id,
                        afterOrderId: pointPicker.afterOrderId,
                      })
                    }
                  >
                    Выбрать
                  </Button>
                </li>
              ))}
            </ul>
            {/*
              Отказ от выбора не отменяет работу.
              Печать не имеет права останавливать сборку: заказ соберётся,
              а наклейку напечатают вручную из карточки.
            */}
            {pointPicker.afterOrderId !== null && (
              <Button
                variant="ghost"
                data-testid="florist-point-skip"
                disabled={action.isPending}
                onClick={() => {
                  const orderId = pointPicker.afterOrderId;
                  setPointPicker(null);
                  if (orderId !== null) {
                    assemble(orderId);
                  }
                }}
              >
                Собрать без печати
              </Button>
            )}
          </div>
        </Modal>
      )}

      {/*
       * Активные смены и принудительное завершение — только администратору.
       *
       * Незавершённые назначения при этом НЕ снимаются: наполовину собранный
       * заказ не должен молча вернуться в общую очередь. Их число показано
       * рядом с кнопкой, чтобы решение принималось осознанно.
       */}
      {isAdmin && shiftsQuery.isSuccess && shiftsQuery.data.items.length > 0 && (
        <section className="card stack" data-testid="florist-shifts">
          <h3>Смены на сегодня</h3>
          <ul className="florist__list">
            {shiftsQuery.data.items.map((item) => (
              /*
                Одна смена — одна строка.

                Список читают сверху вниз, выбирая нужного человека: карточки
                в три экрана превращали пять флористов в прокрутку. Поле
                причины и кнопка стоят в той же строке, а не под ней.
              */
              <li key={item.id} className="florist__shift" data-testid="shift-row">
                <strong className="florist__shift-name">{item.userFullName}</strong>
                {/*
                  Два факта смены — карточками с подписью над значением.
                  Строкой «с 18.08.2026, 12:44 в сборке: 1» они сливались
                  в сплошной текст и рвались переносом в произвольном месте:
                  прочитать, где кончается время и начинается количество,
                  можно было только вглядываясь.
                */}
                <span className="florist__shift-fact">
                  <span className="florist__shift-fact-label">Смена с</span>
                  <span className="florist__shift-fact-value">
                    {formatMoscowDateTime(item.startedAt)}
                  </span>
                </span>
                <span className="florist__shift-fact">
                  <span className="florist__shift-fact-label">В сборке</span>
                  <span className="florist__shift-fact-value">{item.openAssignments}</span>
                </span>
                <span className="florist__shift-spacer" />
                <Button
                  variant="secondary"
                  data-testid="shift-force-close"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({
                      path: `/api/florist/shifts/${item.id}/force-close`,
                      body: {},
                      success: 'Смена завершена принудительно',
                    })
                  }
                >
                  Завершить смену
                </Button>
              </li>
            ))}
          </ul>
          <p className="muted text-sm">
            Незавершённые заказы остаются за флористом и требуют решения: переназначьте их или
            верните в очередь из карточки.
          </p>
        </section>
      )}

      {/*
       * Счётчик активных заказов стоит на самой вкладке «Мои заказы».
       *
       * Место выбрано не ради красоты: вкладки видны на всех трёх разделах,
       * поэтому число не исчезает ни на «Очереди», ни на «Печати». Заголовок
       * раздела для этого не годится — там счётчик относится к смене, а работа
       * остаётся за человеком и после её закрытия.
       *
       * В счёте только незавершённое: `IN_ASSEMBLY` и `NEEDS_REVIEW`. Собранные
       * заказы в него не входят — у них своя свёрнутая группа со своим числом,
       * и сложить их вместе значило бы показывать «10» тому, кому осталось
       * собрать один букет.
       */}
      <SegmentedControl
        label="Разделы флориста"
        value={tab}
        onChange={setTab}
        options={TABS.map((item) => ({
          value: item.key,
          label: item.title,
          testId: `florist-tab-${item.key}`,
          ...(item.key === 'mine' && activeOrders !== null
            ? {
                badge: activeOrders,
                badgeTestId: 'florist-active-count',
                badgeLabel: `активных заказов: ${activeOrders}`,
              }
            : {}),
        }))}
      />

      {tab !== 'print' && (
        <div className="florist__filters card">
          {/*
            День выбирается только в «Очереди».

            За флористом числится РАБОТА, а не день: заказ, взятый вчера и не
            собранный, обязан оставаться перед глазами, а взятый на завтра —
            не прятаться до полуночи. Границу дня в «Моих заказах» снимает
            сервер; переключатель здесь означал бы выбор, которого нет.
          */}
          {tab === 'queue' && (
            <div className="row">
              <SegmentedControl
                label="День"
                value={day}
                onChange={setDay}
                options={[
                  { value: 'today', label: 'Сегодня', testId: 'florist-day-today' },
                  { value: 'tomorrow', label: 'Завтра', testId: 'florist-day-tomorrow' },
                ]}
              />
              <span className="muted text-sm">
                {queueDate === undefined ? '' : formatDay(queueDate)}
              </span>
            </div>
          )}

          {/*
           * Поиск СЕРВЕРНЫЙ и внутри выбранных дня и области.
           *
           * Искать по загруженным страницам было бы обманом: заказ, не попавший
           * в первые пятьдесят, не нашёлся бы вовсе, а человек решил бы, что
           * его нет. Поэтому номер уходит на сервер, и день со scope остаются
           * условием выборки.
           */}
          <input
            className="input florist__search"
            type="search"
            aria-label="Поиск по номеру заказа"
            placeholder="Номер заказа"
            data-testid="florist-search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />

          {tab === 'queue' && (
            <label className="florist__checkbox">
              <input
                type="checkbox"
                checked={includeAssigned}
                data-testid="florist-all"
                onChange={(event) => setIncludeAssigned(event.target.checked)}
              />
              Все
            </label>
          )}
        </div>
      )}

      {tab !== 'print' && queueQuery.isPending && <LoadingState title="Загружаем очередь…" />}
      {tab !== 'print' && queueQuery.isError && (
        <ErrorState
          description="Очередь не загрузилась."
          onRetry={() => void queueQuery.refetch()}
        />
      )}
      {tab !== 'print' && queueQuery.isSuccess && queueItems.length === 0 && (
        <EmptyState
          title={
            search !== ''
              ? 'Ничего не найдено'
              : tab === 'mine'
                ? 'Заказов за вами нет'
                : 'Очередь пуста'
          }
          description={
            search !== ''
              ? // Поиск не выходит за пределы выбранных дня и раздела, и человек
                // обязан понимать, где именно искали.
                'В выбранных дне и разделе заказа с таким номером нет.'
              : tab === 'mine'
                ? assembledTotal > 0
                  ? // Пустая работа при непустой группе — не «заказов нет»:
                    // человек собрал всё и обязан это понимать.
                    'Всё, что было за вами на этот день, собрано.'
                  : 'Возьмите заказ из общей очереди.'
                : 'На выбранный день свободных заказов с подтверждённым составом нет.'
          }
        />
      )}

      {/*
        Очередь разбита по листам.

        Заказ подтверждённого листа собирают не сам по себе: пока не собран
        последний, лист не уедет. Общий список этого не показывал — заказы
        одного листа стояли подряд, но ничем не были связаны, и флорист
        не видел, сколько ему осталось до отгрузки. Порядок групп задаёт
        сервер: раньше время первой остановки — выше лист.
      */}
      {tab !== 'print' &&
        queueQuery.isSuccess &&
        queueItems.length > 0 &&
        groupQueueByRoute(queueItems).map((group) => (
          <section
            key={group.key}
            className="florist__group"
            data-testid="florist-queue-group"
            data-group-kind={group.kind}
            data-route-number={group.route?.number}
          >
            <div className="florist__group-head">
              <h3 className="florist__group-title">{queueGroupTitle(group)}</h3>
              <span className="florist__group-count">{group.items.length}</span>
            </div>
            <ul className="florist__list" data-testid="florist-queue">
              {group.items.map((item) => queueRow(item))}
            </ul>
          </section>
        ))}

      {/*
       * Продолжение показывается ЧИСЛАМИ, а не намёком.
       *
       * «Показано 50 из 111» отвечает сразу на два вопроса: сколько человек уже
       * видит и сколько всего есть. Без общего числа список выглядит полным,
       * и заказ, оставшийся за границей страницы, просто не существует для того,
       * кто на него смотрит.
       */}
      {tab !== 'print' && queueQuery.isSuccess && queueItems.length > 0 && (
        <div className="florist__more">
          <span className="muted text-sm" data-testid="florist-queue-count">
            {pageSummary(queueItems.length, queueTotal)}
          </span>
          {queueQuery.hasNextPage && (
            <Button
              variant="secondary"
              data-testid="florist-load-more"
              disabled={queueQuery.isFetchingNextPage}
              onClick={() => void queueQuery.fetchNextPage()}
            >
              {queueQuery.isFetchingNextPage ? 'Загружаем…' : 'Загрузить ещё'}
            </Button>
          )}
        </div>
      )}

      {/*
       * Собранные заказы выбранного дня.
       *
       * Группа существует всегда, даже пустой: без неё исчезновение заказа из
       * рабочего списка после «Собран» выглядело бы как потеря. Число в
       * заголовке серверное и видно СВЁРНУТЫМ — именно оно отвечает на вопрос
       * «а где он теперь».
       */}
      {tab === 'mine' && queueQuery.isSuccess && (
        <section className="florist__group" data-testid="florist-assembled-group">
          <button
            type="button"
            className="florist__group-head"
            aria-expanded={assembledExpanded}
            aria-controls="florist-assembled-list"
            data-testid="florist-assembled-toggle"
            onClick={() => setAssembledOpen((current) => !current)}
          >
            <span data-testid="florist-assembled-title">Собранные — {assembledTotal}</span>
            <span aria-hidden="true">{assembledExpanded ? '▲' : '▼'}</span>
          </button>

          {foundInAssembled && !assembledOpen && (
            <p className="muted text-sm" data-testid="florist-assembled-found">
              Совпадение найдено среди собранных: группа раскрыта на время поиска.
            </p>
          )}

          {assembledExpanded && (
            <div id="florist-assembled-list" className="stack">
              {assembledQuery.isPending && <LoadingState title="Загружаем собранные…" />}
              {assembledQuery.isError && (
                <ErrorState
                  description="Собранные заказы не загрузились."
                  onRetry={() => void assembledQuery.refetch()}
                />
              )}
              {assembledQuery.isSuccess && assembledItems.length === 0 && (
                <EmptyState
                  title="Собранных заказов нет"
                  description="В выбранном дне вы пока ничего не собрали."
                />
              )}
              {assembledQuery.isSuccess && assembledItems.length > 0 && (
                <>
                  <ul className="florist__list" data-testid="florist-assembled">
                    {assembledItems.map((item) => queueRow(item))}
                  </ul>
                  <div className="florist__more">
                    <span className="muted text-sm" data-testid="florist-assembled-count">
                      {pageSummary(assembledItems.length, assembledShownTotal)}
                    </span>
                    {assembledQuery.hasNextPage && (
                      <Button
                        variant="secondary"
                        data-testid="florist-assembled-load-more"
                        disabled={assembledQuery.isFetchingNextPage}
                        onClick={() => void assembledQuery.fetchNextPage()}
                      >
                        {assembledQuery.isFetchingNextPage ? 'Загружаем…' : 'Загрузить ещё'}
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {tab === 'print' && (
        <div className="florist__filters card">
          <SegmentedControl
            label="Фильтр заданий печати"
            value={printFilter}
            onChange={setPrintFilter}
            options={[
              { value: 'attention', label: 'Требуют внимания', testId: 'print-filter-attention' },
              { value: 'printed', label: 'Напечатанные', testId: 'print-filter-printed' },
            ]}
          />

          {/*
            «Общие» — не фильтр, а расширение: свои задания сменяются
            заданиями всей мастерской за последние двое суток. Поэтому
            переключатель стоит рядом, а не среди разделов.
          */}
          <label className="toggle" data-testid="print-general">
            <input
              type="checkbox"
              checked={printGeneral}
              onChange={(event) => setPrintGeneral(event.target.checked)}
            />
            Общие (48 часов)
          </label>
        </div>
      )}

      {tab === 'print' && printQuery.isPending && (
        <LoadingState title="Загружаем очередь печати…" />
      )}
      {tab === 'print' && printQuery.isError && (
        <ErrorState
          description="Очередь печати не загрузилась."
          onRetry={() => void printQuery.refetch()}
        />
      )}
      {tab === 'print' && printQuery.isSuccess && printItems.length === 0 && (
        <EmptyState
          title="Заданий нет"
          description={
            printGeneral
              ? 'За последние двое суток в этом разделе заданий нет.'
              : printFilter === 'attention'
                ? 'Все ваши бланки напечатаны.'
                : 'Ваших напечатанных бланков пока нет.'
          }
        />
      )}

      {tab === 'print' && printQuery.isSuccess && printItems.length > 0 && (
        <ul className="florist__list" data-testid="florist-print-list">
          {printItems.map((job) => (
            <li key={job.id} className="florist__row" data-testid="print-row">
              <div className="florist__row-main">
                {/* Номер — текст. Карточку открывает кнопка `Просмотр` ниже:
                    во всех списках флориста это одно и то же действие. */}
                <span className="florist__number">{job.orderNumber}</span>
                <span className="muted text-sm">{formatMoscowDateTime(job.createdAt)}</span>
                <StatusBadge
                  tone={
                    job.state === 'ERROR'
                      ? 'error'
                      : job.state === 'PRINTED'
                        ? 'success'
                        : 'warning'
                  }
                >
                  {printStateLabel(job.state)}
                </StatusBadge>
                <span className="muted text-sm">попытка {job.attempt}</span>
                {job.lastErrorCode !== null && (
                  <span className="muted text-sm">код {job.lastErrorCode}</span>
                )}
              </div>

              <div className="florist__row-side">
                <Button
                  variant="ghost"
                  data-testid="print-open"
                  onClick={() => setOpenOrderId(job.orderId)}
                >
                  Просмотр
                </Button>
                <Button
                  variant="secondary"
                  data-testid="print-download"
                  onClick={() => void downloadJobPdf(job)}
                >
                  Скачать PDF
                </Button>
                <Button
                  variant="secondary"
                  data-testid="print-label"
                  onClick={() => void downloadJobLabel(job)}
                >
                  Этикетка
                </Button>
                <Button
                  variant="ghost"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({
                      path: `/api/florist/print-jobs/${job.id}/retry`,
                      success: 'Создана новая попытка печати',
                    })
                  }
                >
                  Повторить печать
                </Button>
                {job.state !== 'PRINTED' && (
                  <Button
                    variant="ghost"
                    disabled={action.isPending}
                    data-testid="print-mark"
                    onClick={() =>
                      action.mutate({
                        path: `/api/florist/print-jobs/${job.id}/printed`,
                        success: 'Отмечено напечатанным',
                      })
                    }
                  >
                    Напечатано вручную
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/*
       * Продолжение очереди печати — не удобство, а доступность действия.
       *
       * Ошибка печати, случившаяся раньше сотни других заданий, без него
       * недостижима: ни повторить, ни отметить вручную её нельзя, потому что
       * строки просто нет на экране.
       */}
      {tab === 'print' && printQuery.isSuccess && printItems.length > 0 && (
        <div className="florist__more">
          <span className="muted text-sm" data-testid="print-count">
            {pageSummary(printItems.length, printTotal)}
          </span>
          {printQuery.hasNextPage && (
            <Button
              variant="secondary"
              data-testid="print-load-more"
              disabled={printQuery.isFetchingNextPage}
              onClick={() => void printQuery.fetchNextPage()}
            >
              {printQuery.isFetchingNextPage ? 'Загружаем…' : 'Загрузить ещё'}
            </Button>
          )}
        </div>
      )}

      {/*
       * Карточка ПОВЕРХ списка, а не после него.
       *
       * Окно появляется сразу после нажатия — вместе с состоянием загрузки и
       * ошибкой внутри него же. Повтор запроса тоже здесь: человек не должен
       * закрывать окно, чтобы понять, что случилось.
       *
       * Список под окном не размонтируется, поэтому день, вкладка, поиск,
       * догруженные страницы и позиция прокрутки переживают открытие. Фокус
       * после закрытия возвращается на ту кнопку `Просмотр`, которая окно
       * открыла, — этим занимается общий `Modal`.
       */}
      <Modal
        open={openOrderId !== null}
        title={card?.number ?? 'Карточка заказа'}
        onClose={() => setOpenOrderId(null)}
        dismissOnBackdrop
        className="modal--wide"
        testId="florist-card-dialog"
      >
        {cardQuery.isPending && <LoadingState title="Открываем карточку…" />}
        {cardQuery.isError && (
          <ErrorState
            description="Карточка не загрузилась."
            onRetry={() => void cardQuery.refetch()}
          />
        )}

        {card !== null && (
          <OrderCardPanel
            card={card}
            viewerId={viewerId}
            isAdmin={isAdmin}
            hasActiveShift={hasActiveShift}
            florists={floristsQuery.data?.items ?? []}
            busy={action.isPending}
            onClaim={() =>
              action.mutate({
                path: `/api/florist/orders/${card.id}/claim`,
                success: `Заказ ${card.number} взят в работу`,
              })
            }
            onRelease={() =>
              action.mutate({
                path: `/api/florist/orders/${card.id}/release`,
                success: 'Заказ возвращён в очередь',
              })
            }
            onAssemble={() => assembleWithPoint(card.id)}
            onReopen={(reason) =>
              action.mutate({
                path: `/api/florist/orders/${card.id}/reopen`,
                body: { reason },
                success: 'Заказ возвращён в работу',
              })
            }
            onReassign={(floristId) =>
              action.mutate({
                path: `/api/florist/orders/${card.id}/assign`,
                body: { floristId },
                success: 'Заказ переназначен',
              })
            }
            onDownload={() => void downloadOrderPdf(card.id, card.number)}
            onDownloadLabel={() => void downloadOrderLabel(card.id, card.number)}
            onRetry={() => {
              const job = latestJob(card);
              if (job !== null) {
                action.mutate({
                  path: `/api/florist/print-jobs/${job.id}/retry`,
                  success: 'Создана новая попытка печати',
                });
              }
            }}
            onMarkPrinted={() => {
              const job = latestJob(card);
              if (job !== null) {
                action.mutate({
                  path: `/api/florist/print-jobs/${job.id}/printed`,
                  success: 'Отмечено напечатанным',
                });
              }
            }}
          />
        )}
      </Modal>
    </section>
  );
}
