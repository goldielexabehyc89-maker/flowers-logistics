/**
 * Постановка сообщений в транзакционный outbox.
 *
 * Сообщение создаётся В ТОЙ ЖЕ транзакции, что и бизнес-изменение: если она
 * откатится, сообщения не останется. Это единственный способ не получить
 * «отправили наружу то, чего в базе нет» и наоборот.
 */

import type { TransactionClient } from '../auth/sessions.js';

/** Разрешённые темы. Обработчик выбирается только из этого списка. */
export const OUTBOX_TOPICS = ['test.ping', 'moysklad.order_state', 'florist.dispatch'] as const;
export type OutboxTopic = (typeof OUTBOX_TOPICS)[number];

const FORBIDDEN_PAYLOAD_FIELDS =
  /^(pin|pin_?hash|code|code_?hash|token|token_?hash|access_?token|refresh_?token|successor_?token_?enc|password|secret|pepper|api_?key|credential|phone)$/i;

export class OutboxPayloadLeakError extends Error {
  constructor(field: string) {
    super(`Поле «${field}» не может попасть в outbox-сообщение`);
    this.name = 'OutboxPayloadLeakError';
  }
}

export type OutboxPayload = Record<string, string | number | boolean | null>;

export function assertOutboxPayloadIsSafe(payload: OutboxPayload): void {
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_PAYLOAD_FIELDS.test(key)) {
      throw new OutboxPayloadLeakError(key);
    }
  }
}

export interface EnqueueInput {
  topic: OutboxTopic;
  /** Ключ идемпотентности: повторная постановка того же события не создаёт дубликат. */
  idempotencyKey: string;
  payload: OutboxPayload;
  maxAttempts?: number;
}

export async function enqueueOutbox(
  tx: TransactionClient,
  input: EnqueueInput,
): Promise<{ created: boolean }> {
  assertOutboxPayloadIsSafe(input.payload);

  // Повторная постановка — не ошибка: продюсер мог выполниться дважды.
  //
  // Проверка «сначала найти, потом создать» здесь неприменима: две параллельные
  // транзакции не видят незафиксированных вставок друг друга, обе решают, что
  // ключа нет, и вторая падает на уникальном индексе. Вставка с пропуском
  // дубликатов выполняется одним запросом (`ON CONFLICT DO NOTHING`): при гонке
  // вторая транзакция дожидается первой и вставляет ноль строк, не поднимая ошибку.
  const inserted = await tx.outboxMessage.createMany({
    data: [
      {
        topic: input.topic,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
        ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
      },
    ],
    skipDuplicates: true,
  });

  return { created: inserted.count === 1 };
}
