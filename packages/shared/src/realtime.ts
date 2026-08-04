/**
 * Модель адресации realtime-событий.
 *
 * Событие пишется в таблицу `RealtimeEvent` в одной транзакции с бизнес-изменением.
 * `LISTEN/NOTIFY` служит только ускорителем доставки; источник истины — таблица,
 * поэтому после перезапуска приложения пропущенные события восстанавливаются по `Last-Event-ID`.
 *
 * Правило видимости намеренно вынесено в чистую функцию: SSE-канал обязан фильтровать
 * события по конкретному пользователю и его ролям, а не рассылать всё всем подряд.
 */

import type { Role } from './roles.js';

export const REALTIME_TOPICS = [
  'user.created',
  'user.updated',
  'user.frozen',
  'user.unfrozen',
  'user.roles_changed',
  'session.revoked',
  'integration.status_changed',
  'outbox.message_failed',
] as const;

export type RealtimeTopic = (typeof REALTIME_TOPICS)[number];

export interface RealtimeAudience {
  /**
   * Персональный адресат. Если задан — событие видит только этот пользователь.
   * Используется для «ваши сессии отозваны», «ваши роли изменены» и т. п.
   */
  audienceUserId: string | null;
  /**
   * Роли-адресаты. Событие видят пользователи, имеющие хотя бы одну из перечисленных ролей.
   * Пустой список означает «по ролям событие никому не адресовано».
   */
  audienceRoles: readonly Role[];
}

export interface RealtimeEventEnvelope extends RealtimeAudience {
  id: string;
  topic: RealtimeTopic;
  occurredAt: string;
  payload: unknown;
}

export interface RealtimeViewer {
  userId: string;
  roles: readonly Role[];
}

/**
 * Единственное место, где решается, доставлять ли событие пользователю.
 *
 * Событие видно, если оно адресовано лично пользователю ИЛИ хотя бы одной из его ролей.
 * Событие без адресата не видно никому: это защищает от случайной широковещательной рассылки
 * административных данных курьерам.
 */
export function isEventVisibleTo(event: RealtimeAudience, viewer: RealtimeViewer): boolean {
  if (event.audienceUserId !== null) {
    return event.audienceUserId === viewer.userId;
  }
  if (event.audienceRoles.length === 0) {
    return false;
  }
  return event.audienceRoles.some((role) => viewer.roles.includes(role));
}

/** Событие, адресованное лично пользователю. */
export function personalAudience(userId: string): RealtimeAudience {
  return { audienceUserId: userId, audienceRoles: [] };
}

/** Событие, адресованное набору ролей. */
export function roleAudience(...roles: Role[]): RealtimeAudience {
  return { audienceUserId: null, audienceRoles: roles };
}
