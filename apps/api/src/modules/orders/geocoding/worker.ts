/**
 * Обработчик очереди геокодирования.
 *
 * Главное правило модуля: сетевой запрос выполняется СТРОГО вне транзакции.
 * Обращение к геокодеру длится сотни миллисекунд, а иногда секунды таймаута;
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
import { geocodingAddress, ORDER_ADDRESS_SELECT } from '../address.js';
import type { $Enums } from '../../../generated/prisma/client.js';
import type { Database } from '../../../platform/db.js';
import type { AppLogger } from '../../../platform/logging/logger.js';
import type { TransactionClient } from '../../auth/sessions.js';
import { writeAudit } from '../../audit/service.js';
import { publishRealtimeEvent } from '../../realtime/events.js';
import { acquireSyncLock, type LockDeps } from '../../integrations/moysklad/sync-lock.js';
import {
  isPermanentPhotonFailure,
  PhotonError,
  type PhotonAnswer,
  type PhotonErrorCode,
} from '../../integrations/photon/client.js';
import { readCache, writeCache, type GeocodeDecision } from './cache.js';
import { verifyPhotonMatch } from './verify.js';
import { MAX_LAT_MICRO, MAX_LON_MICRO, toMicro } from '../geo.js';
import { retryDelayMs } from './queue.js';
import { setGeocoderStatus } from './status.js';
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
 * Ключ session advisory-lock на обращения к геокодеру.
 *
 * Экземпляров приложения может быть несколько, а Photon один. Без единого замка
 * два процесса удвоили бы темп обращений к нему.
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
  /** Проход не состоялся: обращения к геокодеру уже выполняет другой процесс. */
  skippedBusy: boolean;
  /** Проход не состоялся: обращения остановлены до исправления конфигурации. */
  haltedReason: string | null;
  /** Проход не состоялся: действует общая пауза после отказа геокодера. */
  skippedCooldown: boolean;
}

/**
 * Геокодер очереди.
 *
 * Контракт нейтрален к провайдеру: очередь не должна знать, чей это ответ.
 * Сейчас его выполняет собственный Photon; DaData здесь нет вовсе —
 * её платный Clean API не вызывается ни одним фоновым проходом.
 */
export interface Geocoder {
  search: (address: string) => Promise<PhotonAnswer | null>;
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
  /** Запрос к геокодеру. Пусто — берётся адрес заказа. */
  geocodeAddress: string | null;
  localAddress: string | null;
  /**
   * Рабочий адрес нового контракта и его версия.
   *
   * Читаются вместе с остальными: без них `geocodingAddress` посчитал бы
   * заказ версии 2 старым и отправил бы провайдеру операционную строку —
   * ровно ту, ради замены которой контракт и вводился.
   */
  structuredAddress: string | null;
  addressDetails: string | null;
  addressContractVersion: number | null;
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
      ...ORDER_ADDRESS_SELECT,
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
    SELECT "id", "address", "geocodeAddress", "localAddress",
           "structuredAddress", "addressDetails", "addressContractVersion",
           "inScope", "sourceArchived", "sourceMissing",
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
  if ((geocodingAddress(order) ?? '') !== addressAtRequest) {
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
 * Признака «Photon вернул дом» НЕДОСТАТОЧНО. Геокодер не отказывается, а
 * подбирает ближайшее по звучанию: измеренный пример — «Санкт-Петербург,
 * Невский проспект, 1» возвращает дом «Ленинградский проспект, 74к1» в Москве.
 * Точность там «дом», координаты выглядят обычными, и без сверки заказ уехал бы
 * в другой город молча. Поэтому ответ дополнительно сверяется с исходным
 * адресом (`verify.ts`), и любое противоречие означает «позвать человека».
 *
 * Отсутствие координат, координата вне планеты и найденное «примерно» — то же
 * самое: точки нет. Везти по улице без дома нельзя.
 */
export function decideResult(answer: PhotonAnswer | null, address: string): GeocodeDecision {
  if (answer === null || answer.precision !== 'HOUSE') {
    return { kind: 'LOW_PRECISION' };
  }

  // Сверка запроса и ответа. Строгость здесь намеренно избыточна: сомнительный
  // адрес стоит минуты логиста, а принятая неверная точка — несостоявшейся
  // доставки и поездки курьера в другой конец города.
  if (!verifyPhotonMatch(address, answer).accepted) {
    return { kind: 'LOW_PRECISION' };
  }

  try {
    return {
      kind: 'RESOLVED',
      latMicro: toMicro(answer.lat, MAX_LAT_MICRO, 'lat'),
      lonMicro: toMicro(answer.lon, MAX_LON_MICRO, 'lon'),
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
  errorCode: PhotonErrorCode | null;
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
 * Неверная настройка и недоступность относятся ко всему провайдеру, а не к одному заданию:
 * продолжать пачку после них значит гарантированно получить тот же ответ
 * ещё девять раз, потратив обращения и время.
 */
type PassStop = { kind: 'HALT'; reason: PhotonErrorCode } | { kind: 'COOLDOWN'; until: Date };

/**
 * Один проход очереди.
 *
 * Обращения к Photon защищены session advisory-lock: если проход уже идёт
 * в другом экземпляре приложения, этот честно ничего не делает, а не удваивает
 * темп и нагрузку на геокодер.
 *
 * Проход прекращается досрочно при неверной настройке и при отказе сервиса.
 * В обоих случаях
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

    let lastError: PhotonErrorCode | null = null;
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
  const address = order === null ? '' : (geocodingAddress(order) ?? '');
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
          reason: (state.haltedReason ?? 'NOT_CONFIGURED') as PhotonErrorCode,
        },
      };
    }

    return {
      ...EMPTY_OUTCOME,
      stop: { kind: 'COOLDOWN', until: new Date(clockOf(deps).getTime() + slot.waitMs) },
    };
  }

  // Кэш по нормализованному адресу проверяется ДО сети: один и тот же адрес
  // приходит десятками заказов, и платить обращением за каждое повторение
  // незачем. Попадание в кэш не считается запросом к провайдеру.
  const cached = await readCache(deps.db, address);
  let decision: GeocodeDecision;
  let fromCache = false;

  if (cached !== undefined) {
    // В кэше лежит уже сверенное решение: повторно проверять нечего, а обходить
    // сверку кэшем — нельзя.
    decision = cached;
    fromCache = true;
  } else {
    let answer: PhotonAnswer | null;
    try {
      // Никакой транзакции здесь нет и быть не может: запрос длится сотни
      // миллисекунд, а строка заказа всё это время должна оставаться свободной.
      answer = await deps.client.search(address);
    } catch (error) {
      return handleFailure(deps, job, error, address);
    }
    decision = decideResult(answer, address);
    await writeCache(deps.db, address, decision, answer);
  }

  try {
    const outcome = await applyResult(deps, job, address, decision);
    // Ответ из кэша запросом не считается: отчёт о расходе обязан показывать
    // фактическое число обращений к геокодеру, а не число заказов.
    return { ...outcome, requested: !fromCache };
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
          geoSource: 'PHOTON',
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
          ? { geoState: 'RESOLVED', geoSource: 'PHOTON', version }
          : { geoState: 'NEEDS_REVIEW', geoReviewReason: 'LOW_PRECISION', version },
    });

    await publishRealtimeEvent(tx, {
      topic: 'order.geo_changed',
      payload:
        decision.kind === 'RESOLVED'
          ? { orderId: job.orderId, geoState: 'RESOLVED', geoSource: 'PHOTON' }
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
 * Отказ настройки сам не пройдёт: повторять его бессмысленно, задание
 * возвращается в очередь с длинной паузой и не тратит попытки — виновата
 * конфигурация, а не адрес. Остальные отказы считаются попытками; когда они
 * исчерпаны, заказ переходит в FAILED и ждёт человека.
 */
async function handleFailure(
  deps: GeocodeWorkerDeps,
  job: ClaimedJob,
  error: unknown,
  addressAtRequest: string,
): Promise<JobOutcome> {
  const now = clockOf(deps);
  const code: PhotonErrorCode = error instanceof PhotonError ? error.code : 'TRANSPORT_ERROR';

  // Геокодер не настроен либо настроен на публичный сервер.
  //
  // Отказ относится ко всему провайдеру, а не к адресу: попытка не тратится,
  // задание возвращается нетронутым, а проход прекращается. Продолжать пачку
  // здесь означало бы получить тот же ответ ещё девять раз — и повторять это
  // каждые несколько минут до вмешательства человека.
  if (isPermanentPhotonFailure(code)) {
    await releaseJobs(deps, [job.id]);
    return {
      ...EMPTY_OUTCOME,
      requested: true,
      errorCode: code,
      stop: { kind: 'HALT', reason: code },
    };
  }

  // Photon недоступен или отвечает ошибкой.
  //
  // Это отказ сервиса, а не адреса: остальные задания пачки получили бы ровно
  // тот же ответ. Попытку тратит только заказ, наткнувшийся на отказ, а пауза
  // общая — она даёт своему же контейнеру подняться. Продолжать пачку значило
  // бы за минуту израсходовать попытки десятка заказов из-за одного перезапуска.
  if (code === 'SERVER_ERROR' || code === 'TRANSPORT_ERROR' || code === 'BAD_RESPONSE') {
    const attempts = job.attempts + 1;
    const exhausted = attempts >= job.maxAttempts;
    // Общая пауза не короче обычной, но с каждой попыткой растёт: короткий сбой
    // проходит быстро, а долгая недоступность не превращается в непрерывный
    // опрос мёртвого сервиса.
    const cooldownMs = Math.max(DEFAULT_COOLDOWN_MS, retryDelayMs(attempts));
    const until = new Date(now.getTime() + cooldownMs);

    if (exhausted) {
      const outcome = await failOrder(deps, job, code, attempts, now, addressAtRequest);
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

  const outcome = await failOrder(deps, job, code, attempts, now, addressAtRequest);
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
  code: PhotonErrorCode,
  attempts: number,
  now: Date,
  addressAtRequest: string,
): Promise<JobOutcome> {
  return deps.db.$transaction(async (tx) => {
    const order = await lockOrder(tx, job.orderId);
    // Сверяется адрес, с которым УХОДИЛ запрос, а не операционный адрес
    // заказа. Это разные строки: в геокодер уходит собранный запрос, а курьеру
    // показывается полный адрес с квартирой. Подстановка операционного делала
    // бы любой отказ «устаревшим» — заказ никогда не доходил бы до FAILED.
    const stale = staleReason(order, job, addressAtRequest);

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
  outcome: { anySuccess: boolean; lastError: PhotonErrorCode | null },
): Promise<void> {
  if (outcome.lastError !== null) {
    await setGeocoderStatus(
      deps.db,
      isPermanentPhotonFailure(outcome.lastError) ? 'ERROR' : 'DEGRADED',
      { code: outcome.lastError },
      clockOf(deps),
    );
    return;
  }

  if (outcome.anySuccess) {
    await setGeocoderStatus(deps.db, 'OK', {}, clockOf(deps));
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
