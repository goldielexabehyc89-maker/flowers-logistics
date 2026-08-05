/**
 * Запись realtime-событий.
 *
 * Событие пишется В ТОЙ ЖЕ транзакции, что и бизнес-изменение: иначе возможна
 * ситуация «изменение произошло, а никто о нём не узнал». Таблица `RealtimeEvent` —
 * источник истины; `LISTEN/NOTIFY` служит только сигналом «перечитай базу».
 *
 * В payload попадают исключительно идентификаторы и признаки изменения:
 * ни телефонов, ни PIN, ни кодов, ни токенов.
 */

import { personalAudience, roleAudience, type RealtimeTopic, type Role } from '@fl/shared';
import type { TransactionClient } from '../auth/sessions.js';

/** Срок хранения событий: за его пределами клиент получает resync-required. */
export const REALTIME_EVENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Канал PostgreSQL, по которому рассылается сигнал «появились события». */
export const REALTIME_NOTIFY_CHANNEL = 'fl_realtime';

/**
 * Поля, которые не должны попасть в payload события ни при каких обстоятельствах.
 * Проверка выполняется на записи: набор полей объекта со временем меняется.
 */
const FORBIDDEN_PAYLOAD_FIELDS =
  /^(pin|pin_?hash|code|code_?hash|token|token_?hash|access_?token|refresh_?token|successor_?token_?enc|password|secret|pepper|api_?key|credential|phone|full_?name|comment|user_?agent|ip)$/i;

export class RealtimePayloadLeakError extends Error {
  constructor(field: string) {
    super(`Поле «${field}» не может попасть в realtime-событие`);
    this.name = 'RealtimePayloadLeakError';
  }
}

/** Разрешённое содержимое payload: только идентификаторы, версии и признаки. */
export type RealtimePayload = Record<string, string | number | boolean | null>;

export function assertPayloadIsSafe(payload: RealtimePayload): void {
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_PAYLOAD_FIELDS.test(key)) {
      throw new RealtimePayloadLeakError(key);
    }
  }
}

export interface PublishInput {
  topic: RealtimeTopic;
  payload: RealtimePayload;
  /** Персональный адресат: событие получит только он. */
  audienceUserId?: string | null;
  /** Роли-адресаты: событие получат пользователи с любой из них. */
  audienceRoles?: readonly Role[];
}

/**
 * Записывает событие в рамках уже открытой транзакции и посылает сигнал слушателям.
 *
 * `NOTIFY` не несёт полезной нагрузки: подписчик обязан перечитать базу.
 * Так поломка канала уведомлений не приводит к потере данных — события всё равно
 * будут прочитаны периодическим опросом.
 */
export async function publishRealtimeEvent(
  tx: TransactionClient,
  input: PublishInput,
): Promise<void> {
  assertPayloadIsSafe(input.payload);

  const audience =
    input.audienceUserId !== undefined && input.audienceUserId !== null
      ? personalAudience(input.audienceUserId)
      : roleAudience(...(input.audienceRoles ?? []));

  await tx.realtimeEvent.create({
    data: {
      topic: input.topic,
      audienceUserId: audience.audienceUserId,
      audienceRoles: [...audience.audienceRoles],
      payload: input.payload,
      expiresAt: new Date(Date.now() + REALTIME_EVENT_TTL_MS),
    },
  });

  // Сигнал отправляется в той же транзакции: подписчики получат его только
  // после фиксации, поэтому «сигнал есть, а события ещё нет» невозможно.
  await tx.$executeRawUnsafe(`NOTIFY ${REALTIME_NOTIFY_CHANNEL}`);
}

/**
 * Кому адресовать изменение сотрудника.
 *
 * Администратор видит изменения всех, логист — только обычных курьеров.
 * Если сотруднику выдали привилегированную роль, логист обязан получить событие,
 * чтобы убрать запись из своего списка: иначе у него останется устаревшая карточка
 * пользователя, к которому он больше не имеет доступа.
 */
export function managementAudienceFor(roles: readonly Role[]): Role[] {
  const privileged = roles.some((role) => role !== 'COURIER');
  return privileged ? ['ADMIN'] : ['ADMIN', 'LOGISTICIAN'];
}
