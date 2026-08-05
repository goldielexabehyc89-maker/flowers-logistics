/**
 * Обработчик очереди outbox.
 *
 * Работает в том же процессе приложения: Redis и отдельного сервиса в проекте нет
 * намеренно. Несколько экземпляров приложения могут работать одновременно —
 * захват сообщений выполняется через `FOR UPDATE SKIP LOCKED`, поэтому одно
 * сообщение не достанется двум обработчикам.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../../platform/db.js';
import type { AppLogger } from '../../platform/logging/logger.js';
import { redactString } from '../../platform/logging/redact.js';
import { OUTBOX_TOPICS, type OutboxTopic } from './producer.js';

/** Длина, до которой обрезается текст ошибки перед сохранением. */
const MAX_ERROR_LENGTH = 500;
/** Сколько сообщение может находиться в PROCESSING, прежде чем считаться зависшим. */
export const LEASE_TIMEOUT_MS = 60_000;
/** Базовая задержка повтора; растёт экспоненциально с ограничением. */
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 15 * 60 * 1000;

export interface OutboxMessageView {
  id: string;
  topic: string;
  idempotencyKey: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export type OutboxHandler = (message: OutboxMessageView) => Promise<void>;

/**
 * Реестр обработчиков. Тема, которой нет в реестре, не выполняется:
 * иначе запись в базе могла бы заставить приложение выполнить произвольное действие.
 */
export type OutboxHandlers = Partial<Record<OutboxTopic, OutboxHandler>>;

export function backoffDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

/** Готовит текст ошибки: без секретов и без бесконечной длины. */
export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactString(raw).slice(0, MAX_ERROR_LENGTH);
}

export interface WorkerDeps {
  db: Database;
  logger: AppLogger;
  handlers: OutboxHandlers;
  /** Идентификатор экземпляра: попадает в lockedBy и помогает при разборе. */
  workerId?: string;
  now?: () => Date;
}

export interface ProcessResult {
  processed: number;
  failed: number;
  dead: number;
}

/**
 * Возвращает зависшие сообщения в очередь.
 *
 * Процесс мог быть убит между захватом и завершением обработки; без этого
 * сообщение осталось бы в PROCESSING навсегда.
 */
export async function recoverStaleMessages(deps: WorkerDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const threshold = new Date(now.getTime() - LEASE_TIMEOUT_MS);

  const result = await deps.db.outboxMessage.updateMany({
    where: { status: 'PROCESSING', lockedAt: { lt: threshold } },
    data: { status: 'PENDING', lockedAt: null, lockedBy: null },
  });

  return result.count;
}

interface ClaimedRow {
  id: string;
  topic: string;
  idempotencyKey: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

/**
 * Атомарно захватывает пачку сообщений: выбирает готовые к обработке
 * с `SKIP LOCKED` и сразу переводит их в PROCESSING одним запросом.
 */
async function claimBatch(deps: WorkerDeps, limit: number): Promise<ClaimedRow[]> {
  const workerId = deps.workerId ?? 'worker';
  const now = (deps.now ?? (() => new Date()))();

  return deps.db.$queryRaw<ClaimedRow[]>`
    WITH claimed AS (
      SELECT "id"
      FROM "OutboxMessage"
      WHERE "status" IN ('PENDING', 'ERROR')
        AND "nextAttemptAt" <= ${now}
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "OutboxMessage" AS m
    SET "status" = 'PROCESSING',
        "lockedAt" = ${now},
        "lockedBy" = ${workerId},
        "updatedAt" = ${now}
    FROM claimed
    WHERE m."id" = claimed."id"
    RETURNING m."id"::text AS "id",
              m."topic",
              m."idempotencyKey",
              m."payload",
              m."attempts",
              m."maxAttempts"
  `;
}

/** Один проход очереди. Возвращает статистику для наблюдения и тестов. */
export async function processOutboxOnce(deps: WorkerDeps, limit = 20): Promise<ProcessResult> {
  await recoverStaleMessages(deps);

  const claimed = await claimBatch(deps, limit);
  const result: ProcessResult = { processed: 0, failed: 0, dead: 0 };
  const now = (deps.now ?? (() => new Date()))();

  for (const message of claimed) {
    const topic = message.topic as OutboxTopic;
    const handler = OUTBOX_TOPICS.includes(topic) ? deps.handlers[topic] : undefined;

    if (handler === undefined) {
      await failMessage(deps, message, `нет обработчика для темы «${message.topic}»`, now, result);
      continue;
    }

    try {
      // Идемпотентность: повторная доставка того же сообщения не выполняет
      // обработчик второй раз. Отметка ставится в одной транзакции с успехом.
      await deps.db.$transaction(async (tx) => {
        const already = await tx.outboxProcessedMessage.findUnique({
          where: {
            handlerName_idempotencyKey: {
              handlerName: message.topic,
              idempotencyKey: message.idempotencyKey,
            },
          },
          select: { id: true },
        });

        if (already === null) {
          await handler({
            id: message.id,
            topic: message.topic,
            idempotencyKey: message.idempotencyKey,
            payload: message.payload,
            attempts: message.attempts,
            maxAttempts: message.maxAttempts,
          });

          await tx.outboxProcessedMessage.create({
            data: { handlerName: message.topic, idempotencyKey: message.idempotencyKey },
          });
        }

        await tx.outboxMessage.update({
          where: { id: message.id },
          data: {
            status: 'DONE',
            processedAt: now,
            attempts: message.attempts + 1,
            lockedAt: null,
            lockedBy: null,
            lastError: null,
          },
        });
      });

      result.processed += 1;
    } catch (error) {
      await failMessage(deps, message, sanitizeError(error), now, result);
    }
  }

  return result;
}

async function failMessage(
  deps: WorkerDeps,
  message: ClaimedRow,
  reason: string,
  now: Date,
  result: ProcessResult,
): Promise<void> {
  const attempts = message.attempts + 1;
  const exhausted = attempts >= message.maxAttempts;

  await deps.db.outboxMessage.update({
    where: { id: message.id },
    data: {
      status: exhausted ? 'DEAD' : 'ERROR',
      attempts,
      lastError: reason,
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt: new Date(now.getTime() + backoffDelayMs(attempts)),
    },
  });

  if (exhausted) {
    result.dead += 1;
    deps.logger.error(
      { outbox: { id: message.id, topic: message.topic } },
      'сообщение outbox исчерпало попытки',
    );
  } else {
    result.failed += 1;
  }
}

export interface OutboxWorker {
  start: () => void;
  stop: () => void;
  runOnce: () => Promise<ProcessResult>;
}

/** Запускает периодическую обработку очереди в текущем процессе. */
export function createOutboxWorker(deps: WorkerDeps, intervalMs = 1000): OutboxWorker {
  const workerDeps: WorkerDeps = { ...deps, workerId: deps.workerId ?? randomUUID() };
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tick = async (): Promise<void> => {
    // Проходы не накладываются друг на друга: иначе одно и то же сообщение
    // обрабатывалось бы параллельно самим собой при медленном обработчике.
    if (running) {
      return;
    }
    running = true;
    try {
      await processOutboxOnce(workerDeps);
    } catch (error) {
      workerDeps.logger.error({ err: error }, 'проход очереди outbox завершился ошибкой');
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer !== null) {
        return;
      }
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce: () => processOutboxOnce(workerDeps),
  };
}
