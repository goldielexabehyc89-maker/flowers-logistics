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
  if (topic.startsWith('pickup.')) {
    // Выдача самовывоза меняет и карточку у прилавка, и список дня.
    return [['pickup-day']];
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
