/**
 * Канал realtime поверх Server-Sent Events.
 *
 * Токен передаётся только заголовком Authorization: в URL он попал бы в логи
 * прокси, историю браузера и заголовок Referer. Поэтому клиент читает поток
 * через fetch, а не через нативный EventSource, который заголовки не поддерживает.
 */

import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { readRoleAssignment } from '../../platform/role-assignments.js';
import { authenticate } from '../auth/guards.js';
import type { Notifier } from './notifier.js';
import { currentHeadEventId, parseLastEventId, readEventsForViewer } from './reader.js';

/** Периодичность heartbeat: комментарий SSE, не событие. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Резервный опрос базы на случай, если сигнал не дошёл. */
export const POLL_INTERVAL_MS = 2_000;

export interface RealtimeDeps {
  db: Database;
  config: AppConfig;
  notifier: Notifier;
}

/** Минимальный интерфейс приёмника: позволяет проверить логику без сети. */
export interface StreamWriter {
  write: (chunk: string) => void;
  end: () => void;
  onClose: (handler: () => void) => void;
}

function formatEvent(id: string, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface StreamHandle {
  stop: () => void;
}

/**
 * Запускает поток для одного клиента.
 *
 * Возвращает управление сразу: дальнейшая работа идёт по таймерам и сигналам,
 * пока клиент не отключится или сессия не перестанет быть действительной.
 */
export function startEventStream(
  deps: RealtimeDeps,
  viewer: {
    userId: string;
    familyId: string;
    sessionVersion: number;
  },
  lastEventId: bigint,
  writer: StreamWriter,
  intervals = {
    heartbeat: HEARTBEAT_INTERVAL_MS,
    poll: POLL_INTERVAL_MS,
  },
): StreamHandle {
  let cursor = lastEventId;
  let closed = false;
  let draining = false;

  const timers: NodeJS.Timeout[] = [];
  let unsubscribe: (() => void) | null = null;

  const stop = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const timer of timers) {
      clearInterval(timer);
    }
    unsubscribe?.();
    writer.end();
  };

  const closeAsInvalid = (): void => {
    writer.write(formatEvent('0', 'session-closed', { reason: 'session-invalid' }));
    stop();
  };

  /**
   * Проверяет сессию и читает очередную пачку — в одной транзакции.
   *
   * Проверка и чтение обязаны видеть одно и то же состояние базы. Если делать
   * их разными запросами, между ними успевает пройти смена ролей, и клиент
   * получит пачку по уже отобранным правам. Поэтому статус, `sessionVersion`,
   * семья и **актуальные роли** читаются в том же снимке, что и события,
   * а уровень изоляции repeatable read гарантирует, что снимок не сдвинется.
   *
   * Роли берутся из базы, а не из токена: токен был выдан раньше и мог
   * описывать доступ, которого у пользователя уже нет.
   */
  const drain = async (): Promise<void> => {
    // Пока идёт чтение, повторный вход не нужен: следующий сигнал прочитает остаток.
    if (closed || draining) {
      return;
    }
    draining = true;
    try {
      const outcome = await deps.db.$transaction(
        async (tx) => {
          const user = await tx.user.findUnique({
            where: { id: viewer.userId },
            select: {
              status: true,
              sessionVersion: true,
            },
          });

          const familyAlive = await tx.refreshSession.count({
            where: { familyId: viewer.familyId, revokedAt: null },
          });

          // Заморозка, сброс PIN и выход со всех устройств обязаны закрывать
          // уже открытый канал, а не ждать, пока клиент сам переподключится.
          if (
            user === null ||
            user.status !== 'ACTIVE' ||
            user.sessionVersion !== viewer.sessionVersion ||
            familyAlive === 0
          ) {
            return { valid: false as const };
          }

          // Роли читаются текстом: канал не должен обрываться из-за роли,
          // которой эта версия не знает. Права даёт только известная часть.
          const roles = (await readRoleAssignment(tx, viewer.userId)).known;

          const result = await readEventsForViewer(tx, { userId: viewer.userId, roles }, cursor);

          return { valid: true as const, result };
        },
        { isolationLevel: 'RepeatableRead' },
      );

      if (!outcome.valid) {
        // Ни одно новое событие не отправляется: канал закрывается раньше.
        closeAsInvalid();
        return;
      }

      const { result } = outcome;

      if (result.resyncRequired) {
        // Курсор старше окна хранения: клиент обязан перезапросить данные,
        // но перезагружать страницу не нужно.
        writer.write(
          formatEvent(cursor.toString(), 'resync-required', { reason: 'cursor-expired' }),
        );
        cursor = 0n;
        return;
      }

      for (const event of result.events) {
        writer.write(formatEvent(event.id, event.topic, event));
      }

      if (result.lastId !== null) {
        cursor = BigInt(result.lastId);
      }
    } catch {
      // Сбой базы не рвёт поток и не роняет процесс: следующий проход повторит
      // попытку. Ошибка проглатывается намеренно — это фоновый вызов без
      // владельца, необработанный rejection здесь остановил бы приложение.
    } finally {
      draining = false;
    }
  };

  writer.onClose(stop);
  // Ошибка внутри drain уже перехвачена, но обёртка защищает и от синхронного
  // исключения в самом планировщике.
  const safeDrain = (): void => {
    void drain().catch(() => undefined);
  };

  unsubscribe = deps.notifier.subscribe(safeDrain);

  // Отдельного таймера перепроверки сессии больше нет: каждый проход очереди
  // сам проверяет права, поэтому отзыв замечается не позже следующего опроса.
  timers.push(setInterval(safeDrain, intervals.poll));
  timers.push(setInterval(() => writer.write(': heartbeat\n\n'), intervals.heartbeat));

  // Первый проход выполняется сразу: клиент не должен ждать интервала.
  safeDrain();

  return { stop };
}

export async function registerRealtimeRoutes(app: AppServer, deps: RealtimeDeps): Promise<void> {
  const streams = new Set<StreamHandle>();

  app.addHook('onClose', async () => {
    for (const stream of streams) {
      stream.stop();
    }
    streams.clear();
  });

  app.get('/api/realtime/events', async (request, reply) => {
    const actor = await authenticate(request, deps);

    const user = await deps.db.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { sessionVersion: true },
    });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Отключает буферизацию у обратных прокси: иначе события копятся в буфере.
      'X-Accel-Buffering': 'no',
    });

    // Fastify больше не управляет этим ответом: пишем в сокет сами.
    reply.hijack();

    /*
     * Точка старта курсора.
     *
     * Действительный `Last-Event-ID` — это переподключение: догоняем ровно
     * пропущенное. Заголовка нет или он мусорный — свежее подключение: стартуем
     * с ГОЛОВЫ журнала, чтобы не воспроизводить накопленный архив (шторм
     * перезапросов) и не доставлять исторические служебные события.
     */
    const rawLastEventId =
      typeof request.headers['last-event-id'] === 'string'
        ? request.headers['last-event-id']
        : undefined;
    const startCursor =
      rawLastEventId !== undefined && /^\d+$/.test(rawLastEventId)
        ? parseLastEventId(rawLastEventId)
        : await currentHeadEventId(deps.db);

    const writer: StreamWriter = {
      write: (chunk) => {
        if (!reply.raw.writableEnded) {
          reply.raw.write(chunk);
        }
      },
      end: () => {
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      },
      onClose: (handler) => {
        request.raw.on('close', handler);
      },
    };

    const handle = startEventStream(
      deps,
      {
        userId: actor.userId,
        familyId: actor.familyId,
        sessionVersion: user.sessionVersion,
      },
      startCursor,
      writer,
    );

    streams.add(handle);
    request.raw.on('close', () => streams.delete(handle));
  });
}
