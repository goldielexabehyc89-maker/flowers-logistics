/**
 * Разбор потока Server-Sent Events и расчёт задержки переподключения.
 *
 * Логика вынесена из React-компонента в чистые функции: её можно проверить
 * тестами, не поднимая браузер.
 */

import type { RealtimeTopic } from '@fl/shared';

/** Максимальная задержка между попытками переподключения. */
export const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 1_000;

export interface ParsedEvent {
  id: string | null;
  event: string;
  data: string;
}

/**
 * Экспоненциальная задержка с небольшим случайным разбросом.
 *
 * Разброс нужен, чтобы после перезапуска сервера все клиенты не пришли
 * одновременно и не устроили лавину подключений.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    RECONNECT_MAX_DELAY_MS,
  );
  const jitter = base * 0.2 * random();
  return Math.round(base + jitter);
}

/**
 * Разбирает накопленный буфер потока.
 * Возвращает готовые события и остаток, который ещё не завершён пустой строкой.
 */
export function parseEventBuffer(buffer: string): { events: ParsedEvent[]; rest: string } {
  const events: ParsedEvent[] = [];
  const chunks = buffer.split('\n\n');
  const rest = chunks.pop() ?? '';

  for (const chunk of chunks) {
    let id: string | null = null;
    let event = 'message';
    const dataLines: string[] = [];

    for (const line of chunk.split('\n')) {
      // Строка, начинающаяся с двоеточия, — комментарий. Так приходит heartbeat.
      if (line === '' || line.startsWith(':')) {
        continue;
      }
      if (line.startsWith('id:')) {
        id = line.slice(3).trim();
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length > 0) {
      events.push({ id, event, data: dataLines.join('\n') });
    }
  }

  return { events, rest };
}

/**
 * Сброс накопленных страниц списка до первой.
 *
 * Списки с продолжением («Загрузить ещё») хранят страницы стопкой. Обычный
 * перезапрос такого списка запросил бы ВСЕ накопленные страницы заново — то
 * есть после каждого чужого действия клиент тянул бы весь день целиком, ради
 * чего страницы и вводились.
 *
 * Хуже другое: очередь между страницами меняется. Заказ, взятый коллегой,
 * исчезает из выборки, смещения сдвигаются, и перезапрошенные страницы дают
 * либо повтор строки, либо пропуск. Единственный честный ответ на изменение —
 * вернуться к первой странице: она всегда согласована сама с собой.
 *
 * Функция чистая и намеренно терпима к чужой форме данных: под тот же ключ
 * может попасть обычный запрос без страниц, и его надо вернуть нетронутым.
 */
export function collapseToFirstPage<T>(data: T): T {
  if (data === null || typeof data !== 'object') {
    return data;
  }
  const candidate = data as { pages?: unknown; pageParams?: unknown };
  if (!Array.isArray(candidate.pages) || !Array.isArray(candidate.pageParams)) {
    return data;
  }
  if (candidate.pages.length <= 1) {
    return data;
  }
  return {
    ...data,
    pages: candidate.pages.slice(0, 1),
    pageParams: candidate.pageParams.slice(0, 1),
  };
}

/**
 * Таблица «событие → экраны, которые оно затрагивает».
 *
 * Раньше здесь была цепочка `startsWith`, и она молча теряла целые разделы:
 * `route_plan.`, `depot.`, `storage_cell.` и `delivery.` не совпадали ни с одним
 * префиксом и падали в общий `return [['status']]`. Экран расчёта, настройки
 * складов, справочник ячеек и курьерские списки не обновлялись вообще, а
 * `order.*` обновлял ключи `orders` и `unassigned-orders`, которых на живых
 * экранах уже не существует, — «Сделки» не видели ни чужой правки, ни своей.
 *
 * Поэтому таблица явная и ПОЛНАЯ: тип `Record<RealtimeTopic, ...>` превращает
 * новое событие в ошибку компиляции, а не в тихо необновляемый экран.
 *
 * Ключи перечисляются корнями: `invalidateQueries` сопоставляет префикс,
 * поэтому `['deals']` покрывает `['deals', scope, page]`.
 */
const DEALS_SCREEN: string[][] = [['deals'], ['deals-map']];
const ROUTING_SCREEN: string[][] = [
  ['routes'],
  ['route'],
  ['route-history'],
  ['map-points'],
  // Экран маршрутных листов слушает те же события: назначение курьера,
  // отгрузка и отмена обязаны появляться во втором сеансе без перезагрузки.
  ['route-sheets'],
];
const WAREHOUSE_SCREEN: string[][] = [
  ['warehouse-placements'],
  ['warehouse-routes'],
  ['warehouse-route'],
  // Доска сборки: подтверждённый лист, назначенная ячейка и переставленная
  // коробка обязаны появляться у кладовщика сами. Без этого ключа экран
  // показывал бы вчерашнюю картину до перезагрузки.
  ['warehouse-assembly'],
  // Доска выдачи: общий прогресс проверки, смена курьера и отгрузка соседнего
  // листа обязаны появляться у второго кладовщика сами. Прогресс здесь общий
  // и серверный — расходиться двум телефонам нельзя.
  ['warehouse-issue-board'],
  ['warehouse-returns'],
];
const FLORIST_SCREEN: string[][] = [
  ['florist-queue'],
  ['florist-card'],
  ['florist-print-jobs'],
  ['florist-shift'],
];
const DELIVERY_SCREEN: string[][] = [
  ['delivery-active'],
  ['delivery-history'],
  ['delivery-reasons'],
  // Обязательство вернуть букет живёт дольше маршрута и обновляется отдельно.
  ['delivery-returns'],
];
/*
 * Экран выдачи самовывоза.
 *
 * Очередь и справочный список выданных перечитываются вместе: заказ уходит
 * из одного ровно тогда, когда появляется в другом.
 */
const PICKUP_SCREEN: string[][] = [['pickup-day'], ['pickup-issued']];

const USERS_SCREEN: string[][] = [
  ['users'],
  ['user-history'],
  ['couriers-active'],
  ['couriers-for-routes'],
  ['florist-florists'],
];

const TOPIC_KEYS: Record<RealtimeTopic, string[][]> = {
  'user.created': USERS_SCREEN,
  'user.updated': USERS_SCREEN,
  'user.frozen': USERS_SCREEN,
  'user.unfrozen': USERS_SCREEN,
  'user.roles_changed': USERS_SCREEN,
  // Сеанс закрывается целиком: перезапрашивать нечего.
  'session.revoked': [],

  /*
   * Заказ меняется — меняются и список «Сделок», и его карта.
   *
   * `deals-map` здесь обязателен: адрес и точка живут именно там, и без этого
   * ключа исправленный заказ появлялся на карте только после F5.
   */
  'order.created': [...DEALS_SCREEN, ...FLORIST_SCREEN, ['status']],
  /*
   * Правка заказа доходит до ВСЕХ, кто его показывает.
   *
   * Интервал и адрес живут не только в «Сделках»: их печатает маршрутный лист,
   * состав маршрута и список активных доставок курьера. Пока здесь стояли одни
   * «Сделки», второй сеанс — и особенно курьер в дороге — видел старый адрес
   * и старое время до перезагрузки страницы.
   */
  'order.updated': [
    ...DEALS_SCREEN,
    ...ROUTING_SCREEN,
    ...DELIVERY_SCREEN,
    // Интервал задаёт порядок очереди флориста, поэтому и она перечитывается.
    ...FLORIST_SCREEN,
    ['order-window'],
    ['status'],
  ],
  /*
   * Выход из области — это и блокировка выдачи самовывоза: архивный или
   * пропавший заказ обязан покраснеть у менеджера до того, как он отдаст
   * коробку.
   */
  'order.scope_changed': [
    ...DEALS_SCREEN,
    ...ROUTING_SCREEN,
    ...FLORIST_SCREEN,
    ...PICKUP_SCREEN,
    ['status'],
  ],
  'order.geo_changed': [...DEALS_SCREEN, ...DELIVERY_SCREEN, ['map-points'], ['order-window']],
  'order.address_changed': [
    ...DEALS_SCREEN,
    ...ROUTING_SCREEN,
    ...DELIVERY_SCREEN,
    ['map-points'],
    ['address-history'],
    ['order-window'],
  ],

  /*
   * Производственные события трогают очередь флориста И «Сделки»: признак
   * «Собран» логист видит в своём списке и на карте.
   */
  /*
   * Недоставленный заказ: задача логиста и физический возврат букета.
   *
   * Ключи трёх ролей сразу: логист видит задачу, курьер — обязательство
   * вернуть, склад — очередь приёмки. Экран решает сам, что перечитать.
   */
  'order.resolution_changed': [
    ['logistics-resolutions'],
    ...DEALS_SCREEN,
    ...DELIVERY_SCREEN,
    ...WAREHOUSE_SCREEN,
  ],
  'order.return_changed': [
    ['logistics-resolutions'],
    ['warehouse-returns'],
    ...DEALS_SCREEN,
    ...DELIVERY_SCREEN,
    ...WAREHOUSE_SCREEN,
  ],
  /* Отмена в МоемСкладе меняет работу всех, кто держит заказ в руках. */
  'order.cancellation_changed': [
    ...DEALS_SCREEN,
    ...ROUTING_SCREEN,
    ...FLORIST_SCREEN,
    ...WAREHOUSE_SCREEN,
    ...DELIVERY_SCREEN,
    // Отменённый заказ уходит из очереди выдачи, снятая отмена возвращает его.
    ...PICKUP_SCREEN,
    ['logistics-resolutions'],
  ],

  'order.fulfillment_changed': [...FLORIST_SCREEN, ...DEALS_SCREEN, ...WAREHOUSE_SCREEN],
  'order.fulfillment_process_changed': [
    ...FLORIST_SCREEN,
    ...DEALS_SCREEN,
    // Склад принимает собранное: готовность обязана появляться у него сама.
    ...WAREHOUSE_SCREEN,
  ],
  'florist.shift_changed': [['florist-shift'], ['florist-shifts'], ['florist-queue']],
  'print_job.changed': [['florist-print-jobs'], ['florist-card']],

  // Маршруты: состав, жизненный цикл и блокировка редактора.
  'route.created': [...ROUTING_SCREEN, ...DEALS_SCREEN],
  /*
   * Состав и порядок листа — это работа склада и флориста.
   *
   * Подтверждённый лист задаёт приоритет очереди сборки и содержимое
   * комплектования: пока эти ключи сюда не входили, обе роли узнавали
   * об изменении состава только перезагрузкой и собирали снятые заказы.
   *
   * Черновик очередь не трогает намеренно — он ещё меняется, собирать под него
   * нечего. Событие `route.updated` приходит и на черновик, но перечитанный
   * ответ сервера остаётся прежним: неподтверждённого листа в производстве нет.
   */
  'route.updated': [
    ...ROUTING_SCREEN,
    ...DEALS_SCREEN,
    ...FLORIST_SCREEN,
    ...WAREHOUSE_SCREEN,
    // Отгруженный лист появляется у курьера в «Доставках» сам.
    ...DELIVERY_SCREEN,
  ],
  'route.conflict_detected': ROUTING_SCREEN,
  'route.confirmed': [...ROUTING_SCREEN, ...DEALS_SCREEN, ...FLORIST_SCREEN, ...WAREHOUSE_SCREEN],
  'route.returned_to_draft': [
    ...ROUTING_SCREEN,
    ...DEALS_SCREEN,
    ...FLORIST_SCREEN,
    ...WAREHOUSE_SCREEN,
  ],
  'route.cancelled': [...ROUTING_SCREEN, ...DEALS_SCREEN, ...FLORIST_SCREEN, ...WAREHOUSE_SCREEN],
  'route.edit_lock_changed': [['route']],
  'route.edit_lock_taken_over': [['route']],
  'route.completed': [
    ...ROUTING_SCREEN,
    ...DELIVERY_SCREEN,
    ...WAREHOUSE_SCREEN,
    ['settlements'],
    ['operations-report'],
  ],
  // Ход расчёта: без этого ключа превью не узнавало о собственном завершении.
  'route_plan.updated': [['route-plan'], ['route-plans']],
  // Склад планирования: и список складов, и условия расчёта.
  'depot.changed': [['depots'], ['planning-settings'], ['map-config']],

  // Складские экраны. Размещение меняет и «Собран» в «Сделках».
  'storage_cell.changed': [['storage-cells'], ...WAREHOUSE_SCREEN],
  /*
   * Размещение коробки видно и менеджеру самовывоза.
   *
   * Самовывозный заказ появляется у него в дне ровно тогда, когда склад
   * положил букет в ячейку: до этого выдавать нечего. Без ключа `pickup-day`
   * менеджер узнавал бы о готовом заказе только перезагрузкой.
   */
  'warehouse.placement_changed': [
    ...WAREHOUSE_SCREEN,
    ...DEALS_SCREEN,
    ...FLORIST_SCREEN,
    ...PICKUP_SCREEN,
  ],
  /*
   * Ход комплектования и отгрузки. Курьер здесь обязателен: отгруженный лист
   * появляется у него в «Доставках» сразу, а не после перезагрузки в машине.
   */
  'warehouse.route_flow_changed': [
    ...WAREHOUSE_SCREEN,
    ...DELIVERY_SCREEN,
    ['routes'],
    ['route'],
    ['route-sheets'],
  ],

  /*
   * Результат доставки — это ещё и деньги: наличные и начисления попадают
   * в учёт в той же транзакции, поэтому открытый отчёт обязан обновиться
   * без перезагрузки страницы.
   */
  'delivery.result_recorded': [
    ...DELIVERY_SCREEN,
    ['routes'],
    ['route'],
    ['settlements'],
    ['operations-report'],
    ['logistics-history'],
  ],
  'delivery.result_cancelled': [
    ...DELIVERY_SCREEN,
    ['routes'],
    ['route'],
    ['settlements'],
    ['operations-report'],
    ['logistics-history'],
  ],
  'pickup.issued': [...PICKUP_SCREEN, ['warehouse-placements']],
  /*
   * Настройка ручного ввода меняет оба рабочих места сразу: у кладовщика
   * появляется поле номера, у менеджера — ручная выдача.
   */
  'settings.manual_entry_changed': [
    ...PICKUP_SCREEN,
    ['warehouse-settings'],
    ...WAREHOUSE_SCREEN,
    // И сам экран настроек: переключатель у второго администратора обязан
    // показывать то же значение, что и у первого.
    ['planning-settings'],
  ],

  /*
   * Учёт изменился — перечитываются отчёты и балансы.
   *
   * Само событие сумм не несёт: экран идёт за цифрами своим запросом,
   * и в потоке денег не появляется.
   */
  'finance.ledger_changed': [['settlements'], ['operations-report'], ['logistics-history']],
  'integration.status_changed': [['status']],
  'outbox.message_failed': [['outbox-failures']],
};

/**
 * События, после которых открытая история заказа обязана перечитаться.
 *
 * История собирается из десятка источников, и почти любое действие над
 * заказом добавляет в неё строку. Перечислять для каждого топика свой ключ
 * значило бы однажды забыть один и получить ленту, которая молча отстаёт.
 *
 * В само событие при этом ничего не добавляется: экран идёт за строками
 * своим запросом, а в потоке остаются прежние идентификаторы.
 */
const ORDER_TIMELINE_TOPICS = new Set<string>([
  'order.created',
  'order.updated',
  'order.scope_changed',
  'order.geo_changed',
  'order.address_changed',
  'order.cancellation_changed',
  'order.resolution_changed',
  'order.return_changed',
  'order.fulfillment_changed',
  'order.fulfillment_process_changed',
  'print_job.changed',
  'route.created',
  'route.updated',
  'route.confirmed',
  'route.returned_to_draft',
  'route.cancelled',
  'route.completed',
  'warehouse.placement_changed',
  'warehouse.route_flow_changed',
  'delivery.result_recorded',
  'delivery.result_cancelled',
  'pickup.issued',
]);

const ORDER_TIMELINE_KEY: string[] = ['order-timeline'];

/*
 * Результаты поиска истории показывают краткое состояние заказа и время
 * последнего события — значит, они устаревают ровно тогда же, когда лента.
 */
const ORDER_HISTORY_SEARCH_KEY: string[] = ['order-history-search'];

/**
 * Какие ключи запросов обновить при событии.
 *
 * Незнакомое событие обновляет только общий признак состояния: молча
 * не обновить ничего опаснее, чем лишний запрос, но и перезапрашивать
 * весь клиент на неизвестное имя нельзя.
 */
export function invalidationKeysFor(topic: string): string[][] {
  const keys = TOPIC_KEYS[topic as RealtimeTopic] ?? [['status']];
  return ORDER_TIMELINE_TOPICS.has(topic)
    ? [...keys, ORDER_TIMELINE_KEY, ORDER_HISTORY_SEARCH_KEY]
    : keys;
}
