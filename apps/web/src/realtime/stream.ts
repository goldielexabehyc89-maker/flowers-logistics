/**
 * Разбор потока Server-Sent Events и расчёт задержки переподключения.
 *
 * Логика вынесена из React-компонента в чистые функции: её можно проверить
 * тестами, не поднимая браузер.
 */

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
 * Какие ключи запросов обновить при событии.
 * Списки сотрудников перезапрашиваются, история конкретного пользователя — тоже.
 */
export function invalidationKeysFor(topic: string): string[][] {
  if (topic.startsWith('user.')) {
    return [['users'], ['user-history']];
  }
  if (topic === 'session.revoked') {
    return [];
  }
  if (topic.startsWith('warehouse.')) {
    // Складские экраны и карточка маршрутного листа. Событие не несёт данных:
    // клиент перезапрашивает нужный список сам.
    return [['warehouse-placements'], ['warehouse-routes'], ['warehouse-route']];
  }
  // Производственные события проверяются ДО общего правила `order.*`:
  // логистический список от изменения состава не зависит, а очередь флориста
  // обязана обновиться точечно, а не перезапросить всё подряд.
  if (topic.startsWith('order.fulfillment')) {
    return [['florist-queue'], ['florist-card'], ['florist-print-jobs']];
  }
  if (topic === 'florist.shift_changed') {
    return [['florist-shift'], ['florist-shifts'], ['florist-queue']];
  }
  if (topic.startsWith('print_job.')) {
    return [['florist-print-jobs'], ['florist-card']];
  }
  if (topic.startsWith('order.')) {
    // Событие не несёт данных заказа: список перезапрашивается целиком.
    // Ни звука, ни всплывающего уведомления — обычный новый заказ рутина.
    return [['orders'], ['status'], ['unassigned-orders']];
  }
  if (topic.startsWith('route.')) {
    // Сюда попадают и изменения состава, и жизненный цикл, и блокировка редактора.
    // Карточка перезапрашивается целиком: событие намеренно не несёт содержимого,
    // а перехват блокировки обязан немедленно перевести прежнего редактора
    // в режим просмотра.
    return [['routes'], ['route'], ['route-history'], ['unassigned-orders']];
  }
  return [['status']];
}
