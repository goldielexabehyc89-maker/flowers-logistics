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
  if (topic === 'order.shipment_readiness_changed') {
    // Готовность к отгрузке видит только склад, и на списки логиста она пока
    // не влияет вовсе: неготовность не меняет ни пригодность заказа, ни маршрут.
    // Перезапрашивать из-за неё «Сделки» и маршрутизацию значило бы гонять
    // чужие тяжёлые списки без единой причины.
    return [['warehouse-orders']];
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
