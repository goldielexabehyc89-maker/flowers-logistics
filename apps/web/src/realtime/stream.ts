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
];
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
  'order.scope_changed': [...DEALS_SCREEN, ...ROUTING_SCREEN, ...FLORIST_SCREEN, ['status']],
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
  'route.updated': [...ROUTING_SCREEN, ...DEALS_SCREEN, ...FLORIST_SCREEN, ...WAREHOUSE_SCREEN],
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
  'warehouse.placement_changed': [...WAREHOUSE_SCREEN, ...DEALS_SCREEN, ...FLORIST_SCREEN],
  'warehouse.route_flow_changed': [...WAREHOUSE_SCREEN, ['routes'], ['route'], ['route-sheets']],

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
  'pickup.issued': [['pickup-day'], ['warehouse-placements']],

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
 * Какие ключи запросов обновить при событии.
 *
 * Незнакомое событие обновляет только общий признак состояния: молча
 * не обновить ничего опаснее, чем лишний запрос, но и перезапрашивать
 * весь клиент на неизвестное имя нельзя.
 */
export function invalidationKeysFor(topic: string): string[][] {
  return TOPIC_KEYS[topic as RealtimeTopic] ?? [['status']];
}
