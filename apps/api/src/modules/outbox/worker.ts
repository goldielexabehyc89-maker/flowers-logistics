/**
 * Обработчик очереди outbox.
 *
 * Работает в том же процессе приложения: Redis и отдельного сервиса в проекте нет
 * намеренно. Несколько экземпляров приложения могут работать одновременно —
 * захват сообщений выполняется через `FOR UPDATE SKIP LOCKED`, поэтому одно
 * сообщение не достанется двум обработчикам.
 */

import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AppLogger } from '../../platform/logging/logger.js';
import { redactString } from '../../platform/logging/redact.js';
import { OUTBOX_TOPICS, type OutboxTopic } from './producer.js';

/** Длина, до которой обрезается текст ошибки перед сохранением. */
const MAX_ERROR_LENGTH = 500;
/** Сколько сообщение может находиться в PROCESSING, прежде чем считаться зависшим. */
export const LEASE_TIMEOUT_MS = 60_000;
/**
 * Как часто продлевается аренда захваченных сообщений.
 *
 * Заметно меньше срока аренды: продление обязано успеть даже при задержке
 * таймера или медленной базе. Пока процесс жив, захваченное им сообщение
 * не будет считаться зависшим, сколько бы ни работал обработчик. Если процесс
 * умер, таймер умер вместе с ним и аренда честно истекает.
 */
export const LEASE_RENEW_INTERVAL_MS = 15_000;
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

/**
 * Обработчик темы.
 *
 * Второй аргумент — транзакция, в которой воркер уже держит сообщение: обработчик
 * с внешней записью (например, синхронизация состояния в МойСклад) выполняет своё
 * изменение в ней же, а не открывает вложенную. Обработчики без базы аргумент
 * игнорируют. Сетевой вызов внутри этой транзакции допускается, поэтому её предел
 * времени намеренно больше обычного (`DEFAULT_HANDLER_TIMEOUT_MS`).
 */
export type OutboxHandler = (message: OutboxMessageView, tx?: TransactionClient) => Promise<void>;

/**
 * Предел времени транзакции обработки одного сообщения.
 *
 * Обработчик может обращаться к внешней системе прямо в этой транзакции, а
 * лимитер МоегоСклада способен выдержать паузу на `429`. Пять секунд Prisma
 * по умолчанию для этого малы, поэтому предел поднят.
 */
export const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

/**
 * Ошибка, повторять которую бессмысленно: причина не исчезнет со временем.
 *
 * Обработчик бросает её там, где внешняя система ответила окончательным
 * отказом — например, отклонила авторизацию (401) или доступ (403). Такой
 * ответ не «позже станет лучше»: повтор с заведомо негодным ключом только
 * молотил бы по общему лимиту. Сообщение сразу уходит в DEAD, а не изнашивает
 * попытки часами.
 */
export class PermanentOutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentOutboxError';
  }
}

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
  /** Срок аренды и период её продления. Переопределяются только в тестах. */
  leaseTimeoutMs?: number;
  leaseRenewIntervalMs?: number;
  /** Предел времени транзакции обработчика: у обработчиков с сетью он больше. */
  handlerTimeoutMs?: number;
}

export interface ProcessResult {
  processed: number;
  failed: number;
  dead: number;
  /** Сообщения, аренда которых была потеряна: их результат не записывался. */
  lost: number;
}

/**
 * Возвращает зависшие сообщения в очередь.
 *
 * Процесс мог быть убит между захватом и завершением обработки; без этого
 * сообщение осталось бы в PROCESSING навсегда.
 */
export async function recoverStaleMessages(deps: WorkerDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const threshold = new Date(now.getTime() - (deps.leaseTimeoutMs ?? LEASE_TIMEOUT_MS));

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

/**
 * Продлевает аренду ещё не обработанных сообщений пачки.
 *
 * Условие `lockedBy = workerId` обязательно: если аренду уже перехватил другой
 * экземпляр, продлевать её нельзя — иначе два воркера по очереди отодвигали бы
 * срок друг у друга.
 */
async function renewLeases(deps: WorkerDeps, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const now = (deps.now ?? (() => new Date()))();
  await deps.db.outboxMessage.updateMany({
    where: { id: { in: ids }, status: 'PROCESSING', lockedBy: deps.workerId ?? 'worker' },
    data: { lockedAt: now },
  });
}

/**
 * Один проход очереди. Возвращает статистику для наблюдения и тестов.
 *
 * Сообщения пачки обрабатываются последовательно, поэтому у последних аренда
 * истекла бы ещё до начала работы. Пока идёт проход, фоновый таймер продлевает
 * аренду всех оставшихся сообщений — включая то, которое обрабатывается прямо
 * сейчас, даже если обработчик длится дольше срока аренды.
 */
export async function processOutboxOnce(deps: WorkerDeps, limit = 20): Promise<ProcessResult> {
  await recoverStaleMessages(deps);

  const claimed = await claimBatch(deps, limit);
  const result: ProcessResult = { processed: 0, failed: 0, dead: 0, lost: 0 };

  if (claimed.length === 0) {
    return result;
  }

  const pending = new Set(claimed.map((message) => message.id));
  const keeper = setInterval(() => {
    void renewLeases(deps, [...pending]).catch(() => undefined);
  }, deps.leaseRenewIntervalMs ?? LEASE_RENEW_INTERVAL_MS);
  keeper.unref();

  try {
    for (const message of claimed) {
      const now = (deps.now ?? (() => new Date()))();
      const topic = message.topic as OutboxTopic;
      const handler = OUTBOX_TOPICS.includes(topic) ? deps.handlers[topic] : undefined;

      try {
        if (handler === undefined) {
          await failMessage(
            deps,
            message,
            `нет обработчика для темы «${message.topic}»`,
            now,
            result,
          );
          continue;
        }

        // Идемпотентность: повторная доставка того же сообщения не выполняет
        // обработчик второй раз. Отметка ставится в одной транзакции с успехом.
        const owned = await deps.db.$transaction(
          async (tx) => {
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
              await handler(
                {
                  id: message.id,
                  topic: message.topic,
                  idempotencyKey: message.idempotencyKey,
                  payload: message.payload,
                  attempts: message.attempts,
                  maxAttempts: message.maxAttempts,
                },
                tx,
              );

              // Отметка остаётся, даже если аренда потеряна: она и есть защита
              // от повторного выполнения обработчика новым владельцем.
              await tx.outboxProcessedMessage.create({
                data: { handlerName: message.topic, idempotencyKey: message.idempotencyKey },
              });
            }

            return finalizeMessage(tx, deps, message.id, {
              status: 'DONE',
              processedAt: now,
              attempts: message.attempts + 1,
              lockedAt: null,
              lockedBy: null,
              lastError: null,
            });
          },
          { timeout: deps.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS },
        );

        if (owned) {
          result.processed += 1;
        } else {
          reportLostLease(deps, message, result);
        }
      } catch (error) {
        await failMessage(
          deps,
          message,
          sanitizeError(error),
          now,
          result,
          error instanceof PermanentOutboxError,
        );
      } finally {
        pending.delete(message.id);
      }
    }
  } finally {
    clearInterval(keeper);
  }

  return result;
}

/**
 * Записывает финальное состояние сообщения только при действующей аренде.
 *
 * Условие `status = PROCESSING AND lockedBy = <этот воркер>` — точка отсечения:
 * воркер, у которого аренду уже перехватили, не имеет права переписать
 * результат нового владельца. Без него старый обработчик, закончивший работу
 * с опозданием, затирал бы чужой DONE или чужую ошибку.
 */
async function finalizeMessage(
  tx: TransactionClient,
  deps: WorkerDeps,
  id: string,
  data: Prisma.OutboxMessageUncheckedUpdateManyInput,
): Promise<boolean> {
  const updated = await tx.outboxMessage.updateMany({
    where: { id, status: 'PROCESSING', lockedBy: deps.workerId ?? 'worker' },
    data,
  });

  return updated.count === 1;
}

function reportLostLease(deps: WorkerDeps, message: ClaimedRow, result: ProcessResult): void {
  result.lost += 1;
  deps.logger.warn(
    { outbox: { id: message.id, topic: message.topic } },
    'аренда сообщения outbox потеряна, результат не записан',
  );
}

async function failMessage(
  deps: WorkerDeps,
  message: ClaimedRow,
  reason: string,
  now: Date,
  result: ProcessResult,
  permanent = false,
): Promise<void> {
  const attempts = message.attempts + 1;
  // Окончательный отказ исчерпывает сообщение немедленно: повторять его нечем.
  const exhausted = permanent || attempts >= message.maxAttempts;

  const owned = await finalizeMessage(deps.db, deps, message.id, {
    status: exhausted ? 'DEAD' : 'ERROR',
    attempts,
    lastError: reason,
    lockedAt: null,
    lockedBy: null,
    nextAttemptAt: new Date(now.getTime() + backoffDelayMs(attempts)),
  });

  if (!owned) {
    reportLostLease(deps, message, result);
    return;
  }

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
  /** Запрещает новые проходы и дожидается выполняющегося. */
  stop: () => Promise<void>;
  runOnce: () => Promise<ProcessResult>;
}

/** Запускает периодическую обработку очереди в текущем процессе. */
export function createOutboxWorker(deps: WorkerDeps, intervalMs = 1000): OutboxWorker {
  const workerDeps: WorkerDeps = { ...deps, workerId: deps.workerId ?? randomUUID() };
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    // Проходы не накладываются друг на друга: иначе одно и то же сообщение
    // обрабатывалось бы параллельно самим собой при медленном обработчике.
    if (inFlight !== null || stopped) {
      return;
    }
    const pass = (async () => {
      try {
        await processOutboxOnce(workerDeps);
      } catch (error) {
        workerDeps.logger.error({ err: error }, 'проход очереди outbox завершился ошибкой');
      }
    })();
    inFlight = pass;
    try {
      await pass;
    } finally {
      inFlight = null;
    }
  };

  return {
    start() {
      if (timer !== null) {
        return;
      }
      stopped = false;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
    },
    /**
     * Останавливает очередь корректно.
     *
     * Просто снять таймер недостаточно: начатый проход продолжил бы работать
     * с базой, которую вызывающая сторона тут же закрывает. Поэтому новые
     * проходы запрещаются, а выполняющийся дожидается завершения.
     */
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      await inFlight;
    },
    runOnce: () => processOutboxOnce(workerDeps),
  };
}
