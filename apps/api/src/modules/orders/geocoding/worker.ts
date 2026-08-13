/**
 * Обработчик очереди геокодирования.
 *
 * Главное правило модуля: сетевой запрос выполняется СТРОГО вне транзакции.
 * Обращение к DaData длится сотни миллисекунд, а иногда секунды таймаута;
 * транзакция, открытая всё это время, держала бы соединение с базой и строку
 * заказа, и логист не смог бы поставить точку руками, пока провайдер думает.
 *
 * Отсюда и порядок работы одного задания:
 *   1) короткая транзакция: захват задания и чтение адреса заказа;
 *   2) HTTP-запрос — вне любой транзакции;
 *   3) короткая транзакция: заказ блокируется заново, результат проверяется
 *      на актуальность и только потом применяется.
 *
 * Между шагами 1 и 3 мир мог измениться: адрес сменился, заказ вышел из области
 * или человек поставил точку руками. Поэтому шаг 3 перепроверяет всё заново,
 * а несовпавший результат объявляется устаревшим и не меняет в заказе ничего.
 * Решение человека автоматика не перезаписывает никогда.
 *
 * Порядок блокировок при применении результата:
 *   DeliveryOrder → OrderGeocodeJob → OrderGeoHistory → AuditLog → RealtimeEvent.
 * Обратного порядка нет, поэтому взаимной блокировки с ручными операциями
 * и с импортом не возникает.
 */

import { randomUUID } from 'node:crypto';
import { effectiveAddress } from '../address.js';
import type { $Enums } from '../../../generated/prisma/client.js';
import type { Database } from '../../../platform/db.js';
import type { AppLogger } from '../../../platform/logging/logger.js';
import type { TransactionClient } from '../../auth/sessions.js';
import { writeAudit } from '../../audit/service.js';
import { publishRealtimeEvent } from '../../realtime/events.js';
import { acquireSyncLock, type LockDeps } from '../../integrations/moysklad/sync-lock.js';
import {
  DadataError,
  isPermanentDadataFailure,
  type DadataErrorCode,
} from '../../integrations/dadata/client.js';
import { parseQcGeo, QC_GEO_EXACT, type DadataAddress } from '../../integrations/dadata/dto.js';
import { MAX_LAT_MICRO, MAX_LON_MICRO, toMicro } from '../geo.js';
import { retryDelayMs } from './queue.js';
import { setDadataStatus } from './status.js';
import {
  DEFAULT_COOLDOWN_MS,
  haltProvider,
  MAX_INLINE_WAIT_MS,
  readProviderState,
  reserveRequestSlot,
  startCooldown,
  type SlotDeps,
} from './provider-state.js';
import type { Role } from '@fl/shared';

const ORDER_AUDIENCE: readonly Role[] = ['ADMIN', 'LOGISTICIAN'];

/**
 * Ключ session advisory-lock на обращения к DaData.
 *
 * Экземпляров приложения может быть несколько, а лимит и баланс у провайдера
 * общие. Без единого замка два процесса удвоили бы темп и счёт.
 * Ключ отличается от ключа синхронизации: это разные сервисы.
 */
export const GEOCODE_LOCK_KEY = 730_205n;

/** Сколько задание может находиться в PROCESSING, прежде чем считаться зависшим. */
export const LEASE_TIMEOUT_MS = 120_000;
/** Как часто продлевается аренда обрабатываемых заданий. Заметно меньше срока. */
export const LEASE_RENEW_INTERVAL_MS = 20_000;

/** Почему результат оказался неприменим. Только технические причины, без адресов. */
export type StaleReason =
  'GENERATION_CHANGED' | 'ADDRESS_CHANGED' | 'OUT_OF_SCOPE' | 'MANUAL_POINT_SET' | 'ORDER_GONE';

export interface GeocodePassResult {
  claimed: number;
  resolved: number;
  lowPrecision: number;
  failed: number;
  retried: number;
  stale: number;
  /** Задания, возвращённые в очередь без попытки и без запроса. */
  released: number;
  /** Сколько раз обращались к провайдеру за проход. */
  requests: number;
  /** Проход не состоялся: обращения к DaData уже выполняет другой процесс. */
  skippedBusy: boolean;
  /** Проход не состоялся: обращения остановлены до исправления конфигурации. */
  haltedReason: string | null;
  /** Проход не состоялся: действует общая пауза после 429. */
  skippedCooldown: boolean;
}

export interface Geocoder {
  cleanAddress: (address: string) => Promise<DadataAddress>;
}

export interface GeocodeWorkerDeps {
  db: Database;
  logger: AppLogger;
  client: Geocoder;
  lock: LockDeps;
  workerId?: string;
  now?: () => Date;
  leaseTimeoutMs?: number;
  leaseRenewIntervalMs?: number;
  /** Сколько заданий берётся за один проход. Обрабатываются последовательно. */
  batchSize?: number;
  /** Часы и ожидание общего слота. Подменяются в тестах: реальных пауз там нет. */
  slot?: SlotDeps;
}

interface ClaimedJob {
  id: string;
  orderId: string;
  geoGeneration: number;
  attempts: number;
  maxAttempts: number;
}

/** Снимок заказа на момент отправки запроса. Адрес живёт только в памяти. */
interface OrderSnapshot {
  id: string;
  address: string | null;
  localAddress: string | null;
  inScope: boolean;
  sourceArchived: boolean;
  sourceMissing: boolean;
  geoState: $Enums.OrderGeoState;
  geoSource: $Enums.OrderGeoSource | null;
  geoGeneration: number;
  version: number;
}

function clockOf(deps: GeocodeWorkerDeps): Date {
  return (deps.now ?? ((): Date => new Date()))();
}

function workerIdOf(deps: GeocodeWorkerDeps): string {
  return deps.workerId ?? 'geocoder';
}

/**
 * Возвращает зависшие задания в очередь.
 *
 * Процесс мог быть убит между захватом и завершением: без этого задание
 * осталось бы в PROCESSING навсегда, а заказ — без точки.
 */
export async function recoverStaleJobs(deps: GeocodeWorkerDeps): Promise<number> {
  const threshold = new Date(clockOf(deps).getTime() - (deps.leaseTimeoutMs ?? LEASE_TIMEOUT_MS));

  const result = await deps.db.orderGeocodeJob.updateMany({
    where: { status: 'PROCESSING', lockedAt: { lt: threshold } },
    data: { status: 'PENDING', lockedAt: null, lockedBy: null },
  });

  return result.count;
}

/**
 * Атомарно захватывает пачку заданий.
 *
 * `FOR UPDATE SKIP LOCKED` с немедленным переводом в PROCESSING: два экземпляра
 * приложения не возьмут одно задание, а занятые строки просто пропускаются.
 */
async function claimJobs(deps: GeocodeWorkerDeps, limit: number): Promise<ClaimedJob[]> {
  const now = clockOf(deps);
  const workerId = workerIdOf(deps);

  return deps.db.$queryRaw<ClaimedJob[]>`
    WITH claimed AS (
      SELECT "id"
      FROM "OrderGeocodeJob"
      WHERE "status" = 'PENDING'
        AND "nextAttemptAt" <= ${now}
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "OrderGeocodeJob" AS j
    SET "status" = 'PROCESSING',
        "lockedAt" = ${now},
        "lockedBy" = ${workerId},
        "updatedAt" = ${now}
    FROM claimed
    WHERE j."id" = claimed."id"
    RETURNING j."id"::text AS "id",
              j."orderId"::text AS "orderId",
              j."geoGeneration",
              j."attempts",
              j."maxAttempts"
  `;
}

/** Продлевает аренду только своих заданий: чужую отодвигать нельзя. */
async function renewLeases(deps: GeocodeWorkerDeps, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await deps.db.orderGeocodeJob.updateMany({
    where: { id: { in: ids }, status: 'PROCESSING', lockedBy: workerIdOf(deps) },
    data: { lockedAt: clockOf(deps) },
  });
}

async function readOrder(db: Database, orderId: string): Promise<OrderSnapshot | null> {
  return db.deliveryOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      address: true,
      localAddress: true,
      inScope: true,
      sourceArchived: true,
      sourceMissing: true,
      geoState: true,
      geoSource: true,
      geoGeneration: true,
      version: true,
    },
  });
}

async function lockOrder(tx: TransactionClient, orderId: string): Promise<OrderSnapshot | null> {
  const rows = await tx.$queryRaw<OrderSnapshot[]>`
    SELECT "id", "address", "localAddress", "inScope", "sourceArchived", "sourceMissing",
           "geoState", "geoSource", "geoGeneration", "version"
    FROM "DeliveryOrder"
    WHERE "id" = ${orderId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Можно ли применить результат к заказу.
 *
 * Проверяется всё, что могло измениться, пока шёл запрос. Отдельно и в первую
 * очередь — ручная точка: человек не должен обнаружить, что его решение
 * молча переписал автомат, ответ которого относится к прежнему состоянию.
 */
export function staleReason(
  order: OrderSnapshot | null,
  job: { geoGeneration: number },
  addressAtRequest: string,
): StaleReason | null {
  if (order === null) {
    return 'ORDER_GONE';
  }
  if (order.geoState === 'RESOLVED' && order.geoSource === 'MANUAL') {
    return 'MANUAL_POINT_SET';
  }
  if (order.geoGeneration !== job.geoGeneration) {
    return 'GENERATION_CHANGED';
  }
  // Сравнивается РАБОЧИЙ адрес: локальная правка меняет то, что отправляли,
  // ровно так же, как изменение источника.
  if ((effectiveAddress(order) ?? '') !== addressAtRequest) {
    return 'ADDRESS_CHANGED';
  }
  if (!order.inScope || order.sourceArchived || order.sourceMissing) {
    return 'OUT_OF_SCOPE';
  }
  return null;
}

/**
 * Переводит ответ провайдера в решение.
 *
 * Точкой доставки считается только `qc_geo = 0`. Любое другое значение,
 * отсутствие координат или координата, которую не удалось разобрать, — повод
 * позвать человека, а не сохранить «примерно верную» точку: она выглядела бы
 * как обычная и увела бы курьера, ничем себя не выдав.
 */
export function decideResult(
  answer: DadataAddress,
): { kind: 'RESOLVED'; latMicro: number; lonMicro: number } | { kind: 'LOW_PRECISION' } {
  if (parseQcGeo(answer.qc_geo) !== QC_GEO_EXACT) {
    return { kind: 'LOW_PRECISION' };
  }

  const lat = answer.geo_lat;
  const lon = answer.geo_lon;
  if (lat === null || lat === undefined || lon === null || lon === undefined) {
    return { kind: 'LOW_PRECISION' };
  }

  try {
    return {
      kind: 'RESOLVED',
      latMicro: toMicro(lat, MAX_LAT_MICRO, 'lat'),
      lonMicro: toMicro(lon, MAX_LON_MICRO, 'lon'),
    };
  } catch {
    // Координата вне планеты или в неожиданном формате — это не точка.
    return { kind: 'LOW_PRECISION' };
  }
}

interface JobOutcome {
  resolved: boolean;
  lowPrecision: boolean;
  failed: boolean;
  retried: boolean;
  stale: boolean;
  /** Запрос к провайдеру действительно выполнялся. */
  requested: boolean;
  /** Код последней ошибки провайдера. Нужен для состояния интеграции. */
  errorCode: DadataErrorCode | null;
  /** Проход обязан прекратиться: отказ относится ко всему провайдеру. */
  stop: PassStop | null;
}

const EMPTY_OUTCOME: JobOutcome = {
  resolved: false,
  lowPrecision: false,
  failed: false,
  retried: false,
  stale: false,
  requested: false,
  errorCode: null,
  stop: null,
};

/**
 * Почему проход прекращён досрочно.
 *
 * Отказ ключа и лимит относятся ко всему провайдеру, а не к одному заданию:
 * продолжать пачку после них значит гарантированно получить тот же ответ
 * ещё девять раз, потратив обращения и время.
 */
type PassStop = { kind: 'HALT'; reason: DadataErrorCode } | { kind: 'COOLDOWN'; until: Date };

/**
 * Один проход очереди.
 *
 * Обращения к DaData защищены session advisory-lock: если проход уже идёт
 * в другом экземпляре приложения, этот честно ничего не делает, а не удваивает
 * темп и счёт.
 *
 * Проход прекращается досрочно при отказе ключа и при 429. В обоих случаях
 * оставшиеся захваченные задания возвращаются в очередь БЕЗ расходования
 * попыток: они ни в чём не виноваты и ни одного запроса не получили.
 */
export async function processGeocodingOnce(deps: GeocodeWorkerDeps): Promise<GeocodePassResult> {
  const result: GeocodePassResult = {
    claimed: 0,
    resolved: 0,
    lowPrecision: 0,
    failed: 0,
    retried: 0,
    stale: 0,
    released: 0,
    requests: 0,
    skippedBusy: false,
    haltedReason: null,
    skippedCooldown: false,
  };

  // Состояние провайдера проверяется ДО захвата замка и заданий: остановленный
  // ключ не должен приводить даже к обращению к очереди.
  const state = await readProviderState(deps.db);
  if (state.haltedReason !== null) {
    result.haltedReason = state.haltedReason;
    return result;
  }
  if (state.nextRequestAllowedAt.getTime() - clockOf(deps).getTime() > MAX_INLINE_WAIT_MS) {
    result.skippedCooldown = true;
    return result;
  }

  const lock = await acquireSyncLock({ ...deps.lock, key: deps.lock.key ?? GEOCODE_LOCK_KEY });
  if (lock === null) {
    result.skippedBusy = true;
    return result;
  }

  try {
    await recoverStaleJobs(deps);

    const jobs = await claimJobs(deps, deps.batchSize ?? 10);
    result.claimed = jobs.length;
    if (jobs.length === 0) {
      return result;
    }

    const pending = new Set(jobs.map((job) => job.id));
    const keeper = setInterval(() => {
      void renewLeases(deps, [...pending]).catch(() => undefined);
    }, deps.leaseRenewIntervalMs ?? LEASE_RENEW_INTERVAL_MS);
    keeper.unref();

    let lastError: DadataErrorCode | null = null;
    let anySuccess = false;
    let stop: PassStop | null = null;

    try {
      // Строго последовательно: параллельная обработка нарушила бы и общий
      // темп обращений, и обещание «один запрос одновременно».
      for (const job of jobs) {
        const outcome = await processJob(deps, job);
        result.resolved += outcome.resolved ? 1 : 0;
        result.lowPrecision += outcome.lowPrecision ? 1 : 0;
        result.failed += outcome.failed ? 1 : 0;
        result.retried += outcome.retried ? 1 : 0;
        result.stale += outcome.stale ? 1 : 0;
        result.requests += outcome.requested ? 1 : 0;
        anySuccess ||= outcome.resolved || outcome.lowPrecision;
        lastError = outcome.errorCode ?? lastError;
        pending.delete(job.id);

        if (outcome.stop !== null) {
          stop = outcome.stop;
          break;
        }
      }
    } finally {
      clearInterval(keeper);
    }

    if (stop !== null) {
      const now = clockOf(deps);
      if (stop.kind === 'HALT') {
        await haltProvider(deps.db, stop.reason, now);
        result.haltedReason = stop.reason;
        deps.logger.error(
          { geocode: { reason: stop.reason, released: pending.size } },
          'обращения к геокодеру остановлены до исправления конфигурации',
        );
      } else {
        await startCooldown(deps.db, stop.until, now);
        result.skippedCooldown = true;
        deps.logger.warn(
          { geocode: { cooldownUntil: stop.until.toISOString(), released: pending.size } },
          'проход геокодирования прекращён: действует общая пауза провайдера',
        );
      }

      // Оставшиеся задания не сделали ни одного запроса: попытки им
      // не засчитываются, иначе чужой отказ съел бы их право на повтор.
      result.released = await releaseJobs(deps, [...pending]);
    }

    await reportPassStatus(deps, { anySuccess, lastError });

    return result;
  } finally {
    await lock.release();
  }
}

/** Возвращает захваченные задания в очередь, не трогая счётчик попыток. */
async function releaseJobs(deps: GeocodeWorkerDeps, ids: string[]): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }

  const updated = await deps.db.orderGeocodeJob.updateMany({
    where: { id: { in: ids }, status: 'PROCESSING', lockedBy: workerIdOf(deps) },
    data: { status: 'PENDING', lockedAt: null, lockedBy: null },
  });
  return updated.count;
}

async function processJob(deps: GeocodeWorkerDeps, job: ClaimedJob): Promise<JobOutcome> {
  const order = await readOrder(deps.db, job.orderId);

  // Заказ мог измениться ещё до запроса — незачем тратить платное обращение.
  // Адрес сравнивается сам с собой намеренно: здесь проверяются поколение,
  // область и ручная точка, а «прежнего» адреса ещё не существует.
  const address = order === null ? '' : (effectiveAddress(order) ?? '');
  const before = staleReason(order, job, address);
  if (before !== null || address.trim() === '') {
    await finishStale(deps, job, before ?? 'OUT_OF_SCOPE');
    return { ...EMPTY_OUTCOME, stale: true };
  }

  // Общий на все экземпляры слот: минимальный интервал между началами
  // запросов не может держаться полем внутри одного объекта клиента.
  const slot = await reserveRequestSlot(deps.db, deps.slot);
  if (!slot.granted) {
    // Слот не выдан — значит, пока мы работали, соседний экземпляр объявил
    // паузу или остановил обращения. Ни одного запроса не сделано, задание
    // возвращается нетронутым.
    await releaseJobs(deps, [job.id]);

    if (!Number.isFinite(slot.waitMs)) {
      // Бесконечное ожидание означает остановку, а не паузу: причину знает
      // общее состояние, выдумывать её здесь нельзя.
      const state = await readProviderState(deps.db);
      return {
        ...EMPTY_OUTCOME,
        stop: {
          kind: 'HALT',
          reason: (state.haltedReason ?? 'NOT_CONFIGURED') as DadataErrorCode,
        },
      };
    }

    return {
      ...EMPTY_OUTCOME,
      stop: { kind: 'COOLDOWN', until: new Date(clockOf(deps).getTime() + slot.waitMs) },
    };
  }

  let answer: DadataAddress;
  try {
    // Никакой транзакции здесь нет и быть не может: запрос длится сотни
    // миллисекунд, а строка заказа всё это время должна оставаться свободной.
    answer = await deps.client.cleanAddress(address);
  } catch (error) {
    return handleFailure(deps, job, error);
  }

  const decision = decideResult(answer);
  try {
    const outcome = await applyResult(deps, job, address, decision);
    return { ...outcome, requested: true };
  } catch (error) {
    if (error instanceof LeaseLostError) {
      // Задание уже довёл до конца другой владелец: наша транзакция откачена,
      // и правильное поведение — молча уступить, а не уронить весь проход.
      deps.logger.warn(
        { geocode: { jobId: job.id, orderId: job.orderId } },
        'аренда задания геокодирования потеряна, результат не записан',
      );
      return { ...EMPTY_OUTCOME, stale: true, requested: true };
    }
    throw error;
  }
}

/**
 * Применяет результат к заказу.
 *
 * Заказ блокируется заново и перепроверяется целиком: между запросом и ответом
 * мог измениться адрес, заказ мог выйти из области, а человек — поставить точку.
 */
async function applyResult(
  deps: GeocodeWorkerDeps,
  job: ClaimedJob,
  addressAtRequest: string,
  decision: ReturnType<typeof decideResult>,
): Promise<JobOutcome> {
  const now = clockOf(deps);

  return deps.db.$transaction(async (tx) => {
    const order = await lockOrder(tx, job.orderId);
    const stale = staleReason(order, job, addressAtRequest);

    if (stale !== null) {
      await markStale(tx, deps, job, stale, now);
      return { ...EMPTY_OUTCOME, stale: true };
    }

    if (decision.kind === 'RESOLVED') {
      await tx.deliveryOrder.update({
        where: { id: job.orderId },
        data: {
          geoState: 'RESOLVED',
          geoSource: 'DADATA',
          geoPrecision: 'EXACT_HOUSE',
          geoLatMicro: decision.latMicro,
          geoLonMicro: decision.lonMicro,
          geoResolvedAt: now,
          geoReviewReason: null,
          version: { increment: 1 },
        },
      });

      await tx.orderGeoHistory.create({
        data: {
          orderId: job.orderId,
          kind: 'GEOCODE_RESOLVED',
          occurredAt: now,
          state: 'RESOLVED',
          source: 'DADATA',
          precision: 'EXACT_HOUSE',
          latMicro: decision.latMicro,
          lonMicro: decision.lonMicro,
        },
      });
    } else {
      await tx.deliveryOrder.update({
        where: { id: job.orderId },
        data: {
          geoState: 'NEEDS_REVIEW',
          geoReviewReason: 'LOW_PRECISION',
          geoSource: null,
          geoPrecision: null,
          geoLatMicro: null,
          geoLonMicro: null,
          geoResolvedAt: null,
          version: { increment: 1 },
        },
      });

      await tx.orderGeoHistory.create({
        data: {
          orderId: job.orderId,
          kind: 'GEOCODE_LOW_PRECISION',
          occurredAt: now,
          state: 'NEEDS_REVIEW',
          reviewReason: 'LOW_PRECISION',
        },
      });
    }

    const owned = await finishJob(tx, deps, job.id, {
      status: 'DONE',
      attempts: job.attempts + 1,
      finishedAt: now,
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: null,
    });

    if (!owned) {
      // Аренду перехватили: результат уже применён новым владельцем, а наша
      // запись перезаписала бы чужой. Транзакция откатывается целиком.
      throw new LeaseLostError();
    }

    const version = (order?.version ?? 0) + 1;
    await writeAudit(tx, {
      action: decision.kind === 'RESOLVED' ? 'ORDER_GEO_RESOLVED' : 'ORDER_GEO_LOW_PRECISION',
      entityType: 'DeliveryOrder',
      entityId: job.orderId,
      actorUserId: null,
      source: 'worker',
      // Ни адреса, ни координат: они живут в заказе и его защищённой истории.
      newValue:
        decision.kind === 'RESOLVED'
          ? { geoState: 'RESOLVED', geoSource: 'DADATA', version }
          : { geoState: 'NEEDS_REVIEW', geoReviewReason: 'LOW_PRECISION', version },
    });

    await publishRealtimeEvent(tx, {
      topic: 'order.geo_changed',
      payload:
        decision.kind === 'RESOLVED'
          ? { orderId: job.orderId, geoState: 'RESOLVED', geoSource: 'DADATA' }
          : { orderId: job.orderId, geoState: 'NEEDS_REVIEW', reviewReason: 'LOW_PRECISION' },
      audienceRoles: [...ORDER_AUDIENCE],
    });

    return {
      ...EMPTY_OUTCOME,
      resolved: decision.kind === 'RESOLVED',
      lowPrecision: decision.kind === 'LOW_PRECISION',
    };
  });
}

class LeaseLostError extends Error {
  constructor() {
    super('аренда задания геокодирования потеряна');
    this.name = 'LeaseLostError';
  }
}

/** Помечает задание завершённым без изменения заказа: результат устарел. */
async function markStale(
  tx: TransactionClient,
  deps: GeocodeWorkerDeps,
  job: ClaimedJob,
  reason: StaleReason,
  now: Date,
): Promise<void> {
  await tx.orderGeocodeJob.updateMany({
    where: { id: job.id, status: 'PROCESSING', lockedBy: workerIdOf(deps) },
    data: {
      status: 'DONE',
      attempts: job.attempts + 1,
      staleResults: { increment: 1 },
      finishedAt: now,
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: reason,
    },
  });

  deps.logger.info(
    { geocode: { jobId: job.id, orderId: job.orderId, reason } },
    'результат геокодирования устарел и не применён',
  );
}

async function finishStale(
  deps: GeocodeWorkerDeps,
  job: ClaimedJob,
  reason: StaleReason,
): Promise<void> {
  await markStale(deps.db, deps, job, reason, clockOf(deps));
}

async function finishJob(
  tx: TransactionClient,
  deps: GeocodeWorkerDeps,
  id: string,
  data: {
    status: $Enums.GeocodeJobStatus;
    attempts: number;
    finishedAt: Date | null;
    lockedAt: Date | null;
    lockedBy: string | null;
    lastErrorCode: string | null;
    nextAttemptAt?: Date;
  },
): Promise<boolean> {
  // Условие на аренду обязательно: воркер, у которого аренду перехватили,
  // не имеет права переписать результат нового владельца.
  const updated = await tx.orderGeocodeJob.updateMany({
    where: { id, status: 'PROCESSING', lockedBy: workerIdOf(deps) },
    data,
  });
  return updated.count === 1;
}

/**
 * Обрабатывает отказ провайдера.
 *
 * Отказ авторизации и прав сам не пройдёт: повторять его бессмысленно, задание
 * возвращается в очередь с длинной паузой и не тратит попытки — виновата
 * конфигурация, а не адрес. Остальные отказы считаются попытками; когда они
 * исчерпаны, заказ переходит в FAILED и ждёт человека.
 */
async function handleFailure(
  deps: GeocodeWorkerDeps,
  job: ClaimedJob,
  error: unknown,
): Promise<JobOutcome> {
  const now = clockOf(deps);
  const code: DadataErrorCode = error instanceof DadataError ? error.code : 'TRANSPORT_ERROR';

  // Неверный ключ, отозванные права, отсутствие ключей.
  //
  // Отказ относится ко всему провайдеру, а не к адресу: попытка не тратится,
  // задание возвращается нетронутым, а проход прекращается. Продолжать пачку
  // здесь означало бы получить тот же ответ ещё девять раз — и повторять это
  // каждые несколько минут до вмешательства человека.
  if (isPermanentDadataFailure(code)) {
    await releaseJobs(deps, [job.id]);
    return {
      ...EMPTY_OUTCOME,
      requested: true,
      errorCode: code,
      stop: { kind: 'HALT', reason: code },
    };
  }

  const retryAfter = error instanceof DadataError ? error.retryAfterMs : null;

  // Превышение лимита. Попытку тратит только тот заказ, который получил 429;
  // пауза при этом общая, потому что лимит относится к ключу целиком.
  if (code === 'RATE_LIMITED') {
    const cooldownMs = retryAfter ?? DEFAULT_COOLDOWN_MS;
    const attempts = job.attempts + 1;
    const exhausted = attempts >= job.maxAttempts;
    const until = new Date(now.getTime() + cooldownMs);

    if (exhausted) {
      const outcome = await failOrder(deps, job, code, attempts, now);
      return { ...outcome, requested: true, stop: { kind: 'COOLDOWN', until } };
    }

    await finishJob(deps.db, deps, job.id, {
      status: 'PENDING',
      attempts,
      finishedAt: null,
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: code,
      nextAttemptAt: until,
    });

    return {
      ...EMPTY_OUTCOME,
      retried: true,
      requested: true,
      errorCode: code,
      stop: { kind: 'COOLDOWN', until },
    };
  }

  const attempts = job.attempts + 1;
  const exhausted = attempts >= job.maxAttempts;

  if (!exhausted) {
    await finishJob(deps.db, deps, job.id, {
      status: 'PENDING',
      attempts,
      finishedAt: null,
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: code,
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
    });
    return { ...EMPTY_OUTCOME, retried: true, requested: true, errorCode: code };
  }

  const outcome = await failOrder(deps, job, code, attempts, now);
  return { ...outcome, requested: true };
}

/**
 * Повторы исчерпаны: заказ признаётся неразрешимым автоматически.
 *
 * Это не потеря заказа. Он остаётся в списке, попадает в «Требует внимания»,
 * и логист ставит точку руками — ручная операция доступна при любом отказе.
 */
async function failOrder(
  deps: GeocodeWorkerDeps,
  job: ClaimedJob,
  code: DadataErrorCode,
  attempts: number,
  now: Date,
): Promise<JobOutcome> {
  return deps.db.$transaction(async (tx) => {
    const order = await lockOrder(tx, job.orderId);
    const stale = staleReason(order, job, order?.address ?? '');

    // Заказ мог измениться, пока шли повторы: тогда отказ относится к прежнему
    // состоянию заказа, и переводить в FAILED текущее было бы неправдой.
    if (stale !== null) {
      await markStale(tx, deps, job, stale, now);
      return { ...EMPTY_OUTCOME, stale: true, errorCode: code };
    }

    await tx.deliveryOrder.update({
      where: { id: job.orderId },
      data: {
        geoState: 'FAILED',
        geoReviewReason: 'PROVIDER_FAILED',
        geoSource: null,
        geoPrecision: null,
        geoLatMicro: null,
        geoLonMicro: null,
        geoResolvedAt: null,
        version: { increment: 1 },
      },
    });

    await tx.orderGeoHistory.create({
      data: {
        orderId: job.orderId,
        kind: 'GEOCODE_FAILED',
        occurredAt: now,
        state: 'FAILED',
        reviewReason: 'PROVIDER_FAILED',
      },
    });

    const owned = await finishJob(tx, deps, job.id, {
      status: 'FAILED',
      attempts,
      finishedAt: now,
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: code,
    });
    if (!owned) {
      throw new LeaseLostError();
    }

    await writeAudit(tx, {
      action: 'ORDER_GEO_FAILED',
      entityType: 'DeliveryOrder',
      entityId: job.orderId,
      actorUserId: null,
      source: 'worker',
      // Код отказа технический и адреса не содержит.
      newValue: {
        geoState: 'FAILED',
        geoReviewReason: 'PROVIDER_FAILED',
        errorCode: code,
        version: (order?.version ?? 0) + 1,
      },
    });

    await publishRealtimeEvent(tx, {
      topic: 'order.geo_changed',
      payload: { orderId: job.orderId, geoState: 'FAILED', reviewReason: 'PROVIDER_FAILED' },
      audienceRoles: [...ORDER_AUDIENCE],
    });

    return { ...EMPTY_OUTCOME, failed: true, errorCode: code };
  });
}

/** Отражает итог прохода в состоянии интеграции. Ключей и адресов там нет. */
async function reportPassStatus(
  deps: GeocodeWorkerDeps,
  outcome: { anySuccess: boolean; lastError: DadataErrorCode | null },
): Promise<void> {
  if (outcome.lastError !== null) {
    await setDadataStatus(
      deps.db,
      isPermanentDadataFailure(outcome.lastError) ? 'ERROR' : 'DEGRADED',
      { code: outcome.lastError },
      clockOf(deps),
    );
    return;
  }

  if (outcome.anySuccess) {
    await setDadataStatus(deps.db, 'OK', {}, clockOf(deps));
  }
}

export interface GeocodeWorker {
  start: () => void;
  stop: () => Promise<void>;
  runOnce: () => Promise<GeocodePassResult>;
}

/**
 * Планировщик проходов.
 *
 * `setInterval` не используется: проход с сетевыми запросами может длиться
 * дольше интервала, и наложение проходов удвоило бы темп обращений.
 */
export function createGeocodeWorker(deps: GeocodeWorkerDeps, intervalMs = 5000): GeocodeWorker {
  const workerDeps: GeocodeWorkerDeps = { ...deps, workerId: deps.workerId ?? randomUUID() };
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const scheduleNext = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    if (stopped || inFlight !== null) {
      return;
    }

    const pass = (async () => {
      try {
        await processGeocodingOnce(workerDeps);
      } catch (error) {
        workerDeps.logger.error({ err: error }, 'проход геокодирования завершился ошибкой');
      }
    })();

    inFlight = pass;
    try {
      await pass;
    } finally {
      inFlight = null;
      scheduleNext(intervalMs);
    }
  };

  return {
    start() {
      if (timer !== null) {
        return;
      }
      stopped = false;
      scheduleNext(intervalMs);
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight !== null) {
        await inFlight;
      }
    },
    runOnce: () => processGeocodingOnce(workerDeps),
  };
}
