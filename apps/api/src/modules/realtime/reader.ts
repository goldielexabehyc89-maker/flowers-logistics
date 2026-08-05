/**
 * Чтение realtime-событий для конкретного получателя.
 *
 * Идентификатор события — `bigserial`, а порядок фиксации транзакций не обязан
 * совпадать с порядком выданных идентификаторов: транзакция с меньшим id может
 * зафиксироваться позже. Если отдать клиенту событие 10, пока 9 ещё не
 * зафиксировано, курсор уйдёт вперёд и событие 9 будет потеряно навсегда.
 *
 * Поэтому выдаются только события, «отстоявшиеся» дольше окна видимости.
 * Ограничение подхода: транзакция, начавшаяся давно и зафиксировавшаяся спустя
 * минуты, всё равно может опоздать. При нашей длительности транзакций (доли
 * секунды) окна достаточно; полное решение потребовало бы хранить время фиксации.
 */

import { isEventVisibleTo, type Role } from '@fl/shared';
import type { Database } from '../../platform/db.js';

/** Окно видимости: событие выдаётся, только когда стало старше этого срока. */
export const VISIBILITY_LAG_MS = 300;

/** Сколько событий отдавать за один проход. */
export const EVENT_BATCH_SIZE = 200;

export interface EventViewer {
  userId: string;
  roles: Role[];
}

export interface DeliverableEvent {
  /** Строкой: BigInt не сериализуется в JSON и теряет точность в JavaScript. */
  id: string;
  topic: string;
  occurredAt: string;
  payload: unknown;
}

export interface ReadResult {
  events: DeliverableEvent[];
  /** Курсор устарел: события за его пределами уже удалены по сроку хранения. */
  resyncRequired: boolean;
  /** Последний выданный идентификатор; `null`, если ничего не выдано. */
  lastId: string | null;
}

/**
 * Проверяет, не отстал ли курсор от окна хранения.
 * Если самое старое сохранённое событие новее курсора более чем на одну позицию,
 * между ними были события, которые уже удалены.
 */
async function isCursorStale(db: Database, afterId: bigint): Promise<boolean> {
  if (afterId === 0n) {
    return false;
  }

  const oldest = await db.realtimeEvent.findFirst({
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  if (oldest === null) {
    return false;
  }

  return afterId + 1n < oldest.id;
}

export async function readEventsForViewer(
  db: Database,
  viewer: EventViewer,
  afterId: bigint,
  now: Date = new Date(),
): Promise<ReadResult> {
  if (await isCursorStale(db, afterId)) {
    return { events: [], resyncRequired: true, lastId: null };
  }

  const visibleUntil = new Date(now.getTime() - VISIBILITY_LAG_MS);

  const rows = await db.realtimeEvent.findMany({
    where: {
      id: { gt: afterId },
      occurredAt: { lte: visibleUntil },
      OR: [
        { audienceUserId: viewer.userId },
        { audienceUserId: null, audienceRoles: { hasSome: [...viewer.roles] } },
      ],
    },
    orderBy: { id: 'asc' },
    take: EVENT_BATCH_SIZE,
    select: {
      id: true,
      topic: true,
      occurredAt: true,
      payload: true,
      audienceUserId: true,
      audienceRoles: true,
    },
  });

  // Повторная проверка правила видимости на прикладном уровне: запрос и правило
  // должны совпадать, и расхождение между ними не должно приводить к утечке.
  const events = rows
    .filter((row) =>
      isEventVisibleTo(
        { audienceUserId: row.audienceUserId, audienceRoles: row.audienceRoles },
        viewer,
      ),
    )
    .map((row) => ({
      id: row.id.toString(),
      topic: row.topic,
      occurredAt: row.occurredAt.toISOString(),
      payload: row.payload,
    }));

  // Курсор двигается по последней прочитанной строке, даже если она была
  // отфильтрована: иначе один невидимый пользователю элемент останавливал бы поток.
  const lastRow = rows[rows.length - 1];

  return {
    events,
    resyncRequired: false,
    lastId: lastRow === undefined ? null : lastRow.id.toString(),
  };
}

/** Разбирает заголовок Last-Event-ID. Некорректное значение считается началом. */
export function parseLastEventId(raw: string | undefined): bigint {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return 0n;
  }
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}
