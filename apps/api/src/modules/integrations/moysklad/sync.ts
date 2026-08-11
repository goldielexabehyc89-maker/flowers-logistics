/**
 * Проходы синхронизации заказов.
 *
 * Три режима: полная загрузка, delta-проход и суточная контрольная сверка.
 * Все три читают страницы строго последовательно через один и тот же клиент
 * с ограничением темпа — параллельных обращений к МоемуСкладу не бывает.
 *
 * Взаимное исключение проходов.
 * Единственный механизм — блокировка уровня сессии на отдельном соединении
 * (`sync-lock.ts`), удерживаемая весь проход. Транзакционного advisory-lock
 * здесь нет намеренно: он берётся из общего пространства ключей, поэтому
 * транзакция Prisma ждала бы ключ, уже удерживаемый соединением этого же
 * прохода, и проход зависал бы на самом себе.
 *
 * Аренда в курсоре решает другую задачу — планирование следующей попытки
 * и backoff, а не взаимное исключение.
 *
 * Порядок блокировок единый: сессионная блокировка прохода → строка
 * `DeliveryOrder` (`FOR UPDATE` по `externalId`) → вставки ревизии, аудита
 * и события.
 */

import type { Database } from '../../../platform/db.js';
import type { AppLogger } from '../../../platform/logging/logger.js';
import type { TransactionClient } from '../../auth/sessions.js';
import { writeAudit } from '../../audit/service.js';
import { publishRealtimeEvent } from '../../realtime/events.js';
import { MoyskladError, type MoyskladClient } from './client.js';
import type { MOYSKLAD_IDS } from './config.js';
import { approvedStoreFilter, deltaFilter } from './filters.js';
import { applyOrderSnapshot, markSourceMissing } from './import-service.js';
import { mapOrder } from './mapper.js';
import { acquireSyncLock, type LockDeps, type SyncLock } from './sync-lock.js';

export const PROVIDER = 'moysklad';
/** Размер страницы. Больше нельзя: `expand` разрешён для выборки не более 100. */
export const PAGE_SIZE = 100;
/** Сколько держится аренда прохода, если процесс умер и не снял её. */
const LEASE_MS = 10 * 60 * 1000;
/** Пауза, когда остаток лимита аккаунта почти исчерпан. */
const LOW_REMAINING_THRESHOLD = 5;
const LOW_REMAINING_PAUSE_MS = 3000;

export const BACKOFF_STEPS_MS = [30_000, 60_000, 120_000, 300_000] as const;
const RATE_LIMIT_FALLBACK_MS = 30_000;

export interface SyncDeps {
  db: Database;
  client: MoyskladClient;
  logger: AppLogger;
  ids: typeof MOYSKLAD_IDS;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Перекрытие окна delta. Стартовое значение — пять минут. */
  overlapSeconds?: number;
  /** Соединение для глобальной блокировки прохода. */
  lock: LockDeps;
  /**
   * Ставить ли адреса импортированных заказов в очередь геокодирования.
   * Включается только там, где очередь кто-то обрабатывает, — в production.
   */
  geocodingEnabled?: boolean;
}

export interface PassResult {
  kind: 'initial' | 'delta' | 'reconciliation' | 'skipped';
  pages: number;
  processed: number;
  created: number;
  updated: number;
  skippedOutOfScope: number;
  missing: number;
}

const emptyResult = (kind: PassResult['kind']): PassResult => ({
  kind,
  pages: 0,
  processed: 0,
  created: 0,
  updated: 0,
  skippedOutOfScope: 0,
  missing: 0,
});

// --- Аренда прохода --------------------------------------------------------

interface CursorState {
  id: string;
  updatedCursor: Date | null;
  initialLoadCompleted: boolean;
  /**
   * Завершена ли загрузка ПРОИЗВОДСТВЕННОЙ области.
   *
   * На базе, где узкий логистический initial уже завершён, этот признак остаётся
   * ложным, и первый же проход после обновления перечитывает всю выборку
   * утверждённого склада. Delta ходит по окну `updated` и сама заказы, которых
   * никогда не читала, не подберёт.
   */
  fulfillmentLoadCompleted: boolean;
  lastReconciliationAt: Date | null;
  consecutiveFailures: number;
}

/** Создаёт курсор при первом обращении и возвращает его состояние. */
async function ensureCursor(db: Database): Promise<CursorState> {
  const existing = await db.integrationCursor.findUnique({ where: { provider: PROVIDER } });
  if (existing !== null) {
    return existing;
  }
  return db.integrationCursor.create({ data: { provider: PROVIDER } });
}

/**
 * Читает курсор и проверяет, не действует ли ещё backoff.
 *
 * Взаимным исключением это НЕ является: его обеспечивает блокировка уровня сессии
 * на отдельном соединении (`sync-lock.ts`), удерживаемая весь проход. Здесь
 * проверяется только право начать проход по времени следующей попытки, поэтому
 * дополнительный advisory-lock не берётся: он ждал бы ключ, уже занятый
 * соединением этого же прохода.
 */
async function claimPass(deps: SyncDeps, now: Date): Promise<CursorState | null> {
  await ensureCursor(deps.db);

  return deps.db.$transaction(async (tx) => {
    const cursor = await tx.integrationCursor.findUniqueOrThrow({ where: { provider: PROVIDER } });
    if (cursor.nextAttemptAt !== null && cursor.nextAttemptAt > now) {
      return null;
    }

    await tx.integrationCursor.update({
      where: { provider: PROVIDER },
      data: { lastAttemptAt: now, nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
    });

    return cursor;
  });
}

/** Снимает аренду и планирует следующий проход. */
async function releasePass(
  deps: SyncDeps,
  outcome: { ok: boolean; retryAfterMs?: number | null },
  now: Date,
  intervalMs: number,
): Promise<void> {
  await deps.db.$transaction(async (tx) => {
    const cursor = await tx.integrationCursor.findUniqueOrThrow({ where: { provider: PROVIDER } });

    const failures = outcome.ok ? 0 : cursor.consecutiveFailures + 1;
    const delay = outcome.ok
      ? intervalMs
      : (outcome.retryAfterMs ?? backoffForAttempt(cursor.consecutiveFailures));

    await tx.integrationCursor.update({
      where: { provider: PROVIDER },
      data: {
        consecutiveFailures: failures,
        nextAttemptAt: new Date(now.getTime() + delay),
      },
    });
  });
}

/** 30 → 60 → 120 → 300 секунд, дальше — потолок. */
export function backoffForAttempt(previousFailures: number): number {
  const index = Math.min(previousFailures, BACKOFF_STEPS_MS.length - 1);
  return BACKOFF_STEPS_MS[index] ?? RATE_LIMIT_FALLBACK_MS;
}

/** Пауза после 429: значение заголовка, иначе консервативные 30 секунд. */
export function rateLimitDelay(error: MoyskladError): number {
  const value = error.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : RATE_LIMIT_FALLBACK_MS;
}

// --- Чтение страниц --------------------------------------------------------

interface PageReader {
  filter: string;
  order: string;
}

/**
 * Последовательно читает все страницы выборки.
 *
 * Количество страниц определяется по `meta.size` первой страницы. Пустая страница
 * до достижения этого количества — ошибка, а не повод продолжать: иначе изменение
 * поведения API превратилось бы в бесконечный цикл запросов.
 */
async function readAllPages(
  deps: SyncDeps,
  reader: PageReader,
  onPage: (rows: unknown[]) => Promise<void>,
): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let offset = 0;
  let pages = 0;
  let total: number | null = null;

  for (;;) {
    const page = await deps.client.listCustomerOrders({
      limit: PAGE_SIZE,
      offset,
      filter: reader.filter,
      order: reader.order,
    });

    total ??= page.size;
    pages += 1;

    if (page.rows.length === 0) {
      if (offset < (total ?? 0)) {
        throw new MoyskladError('BAD_RESPONSE');
      }
      break;
    }

    await onPage(page.rows);
    offset += page.rows.length;

    if (offset >= (total ?? 0)) {
      break;
    }

    // Лимит общий для всех приложений аккаунта: на исходе остатка притормаживаем.
    const remaining = page.rateLimit.remaining;
    if (remaining !== null && remaining <= LOW_REMAINING_THRESHOLD) {
      await sleep(LOW_REMAINING_PAUSE_MS);
    }
  }

  return pages;
}

// --- Проходы ---------------------------------------------------------------

/** Начало текущего дня Europe/Moscow минус три календарных дня. */
export function initialLoadSince(now: Date): Date {
  // Москва — UTC+3 круглый год, перевода часов нет.
  const moscow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const startOfDayUtc = Date.UTC(
    moscow.getUTCFullYear(),
    moscow.getUTCMonth(),
    moscow.getUTCDate() - 3,
  );
  // Обратно в абсолютное время: полночь Москвы наступает на три часа раньше UTC.
  return new Date(startOfDayUtc - 3 * 60 * 60 * 1000);
}

async function applyRows(deps: SyncDeps, rows: unknown[], result: PassResult): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();

  for (const row of rows) {
    const { snapshot } = mapOrder(row as never, deps.ids);

    const applied = await deps.db.$transaction((tx: TransactionClient) =>
      applyOrderSnapshot(tx, snapshot, now, { geocoding: deps.geocodingEnabled === true }),
    );

    result.processed += 1;
    if (applied.outcome === 'CREATED') result.created += 1;
    if (applied.outcome === 'UPDATED' || applied.outcome === 'SCOPE_ENTERED') result.updated += 1;
    if (applied.outcome === 'SCOPE_EXITED') result.updated += 1;
    if (applied.outcome === 'SKIPPED_OUT_OF_SCOPE') result.skippedOutOfScope += 1;
  }
}

/**
 * Полная загрузка выборки утверждённого склада.
 *
 * Курсор сдвигается только после успешной обработки ВСЕХ страниц: при ошибке
 * середины уже сохранённые карточки остаются, но загрузка не считается
 * завершённой, и повторный запуск перечитает страницы идемпотентно.
 *
 * Одна и та же функция закрывает два случая:
 *  * чистая база — оба признака закрываются ОДНИМ проходом, второй полной
 *    загрузки не бывает;
 *  * база, где узкий логистический initial уже завершён, — проход дочитывает
 *    заказы утверждённого склада с любым способом получения.
 *
 * Во втором случае `updatedCursor` намеренно НЕ сдвигается: он уже идёт по
 * потоку изменений, и перестановка его вперёд пропустила бы всё, что менялось
 * между прежним значением курсора и этим проходом.
 */
export async function runInitialLoad(deps: SyncDeps, cursor?: CursorState): Promise<PassResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result = emptyResult('initial');
  // Срез фиксируется ДО чтения: изменения, случившиеся во время загрузки,
  // должен перечитать следующий delta-проход со своим перекрытием.
  const snapshotAt = now;
  const firstEver = cursor === undefined || !cursor.initialLoadCompleted;

  result.pages = await readAllPages(
    deps,
    { filter: approvedStoreFilter(deps.ids, initialLoadSince(now)), order: 'updated,asc' },
    (rows) => applyRows(deps, rows, result),
  );

  await deps.db.integrationCursor.update({
    where: { provider: PROVIDER },
    data: {
      initialLoadCompleted: true,
      fulfillmentLoadCompleted: true,
      fulfillmentLoadCompletedAt: now,
      ...(firstEver ? { initialLoadCompletedAt: now, updatedCursor: snapshotAt } : {}),
    },
  });

  return result;
}

/**
 * Delta-проход.
 *
 * Окно конечно: нижняя граница — курсор минус перекрытие, верхняя — момент начала
 * прохода. Фильтра по складу, способу доставки и статусу здесь нет намеренно:
 * заказ, перенесённый на другой склад, обязан попасть в выборку, иначе система
 * никогда не узнает, что он вышел из нашей области.
 */
export async function runDeltaPass(deps: SyncDeps, cursor: CursorState): Promise<PassResult> {
  const now = (deps.now ?? (() => new Date()))();
  const overlapMs = (deps.overlapSeconds ?? 300) * 1000;
  const from = new Date((cursor.updatedCursor?.getTime() ?? now.getTime()) - overlapMs);
  const result = emptyResult('delta');

  const seen = new Set<string>();

  result.pages = await readAllPages(
    deps,
    { filter: deltaFilter(from, now), order: 'updated,asc' },
    async (rows) => {
      // Перекрытие окна и страничная выдача могут вернуть один заказ дважды.
      const unique = rows.filter((row) => {
        const id = (row as { id?: string }).id;
        if (typeof id !== 'string' || seen.has(id)) {
          return false;
        }
        seen.add(id);
        return true;
      });
      await applyRows(deps, unique, result);
    },
  );

  // Курсор двигается только после полностью успешного окна.
  await deps.db.integrationCursor.update({
    where: { provider: PROVIDER },
    data: { updatedCursor: now },
  });

  return result;
}

/**
 * Суточная контрольная сверка.
 *
 * Единственный способ заметить физически удалённый документ: опрос по `updated`
 * удалённую запись не возвращает вовсе. Поэтому сравнение допускается ТОЛЬКО
 * после полностью успешного чтения всех страниц — при любой ошибке никто
 * не помечается отсутствующим.
 */
export async function runReconciliation(deps: SyncDeps): Promise<PassResult> {
  const now = (deps.now ?? (() => new Date()))();
  const since = initialLoadSince(now);
  const result = emptyResult('reconciliation');
  const present = new Set<string>();

  result.pages = await readAllPages(
    deps,
    { filter: approvedStoreFilter(deps.ids, since), order: 'updated,asc' },
    async (rows) => {
      for (const row of rows) {
        const id = (row as { id?: string }).id;
        if (typeof id === 'string') {
          present.add(id);
        }
      }
      await applyRows(deps, rows, result);
    },
  );

  // Кандидаты — только активные заказы, реально попадающие в проверенное окно.
  // Заказ без распознанной даты серверный фильтр по дате не вернул бы никогда,
  // поэтому объявлять его удалённым нельзя.
  // Кандидатами считаются заказы ЛЮБОЙ из двух областей: выборка сверки теперь
  // широкая, поэтому самовывоз в ней присутствует и не может быть объявлен
  // пропавшим только из-за прежнего логистического фильтра.
  const candidates = await deps.db.deliveryOrder.findMany({
    where: {
      OR: [{ inScope: true }, { fulfillmentInScope: true }],
      sourceMissing: false,
      deliveryDate: { not: null, gte: since },
    },
    select: { id: true, externalId: true },
  });

  for (const candidate of candidates) {
    if (present.has(candidate.externalId)) {
      continue;
    }
    await deps.db.$transaction((tx: TransactionClient) => markSourceMissing(tx, candidate.id, now));
    result.missing += 1;
  }

  await deps.db.integrationCursor.update({
    where: { provider: PROVIDER },
    data: { lastReconciliationAt: now },
  });

  return result;
}

// --- Один логический проход -------------------------------------------------

export interface RunOnceOptions {
  /** Интервал планирования следующего прохода при успехе. */
  intervalMs?: number;
  /** Выполнить контрольную сверку, если сутки прошли. */
  allowReconciliation?: boolean;
}

/**
 * Один проход: первоначальная загрузка, если она ещё не завершена, иначе delta.
 * Раз в сутки дополнительно выполняется контрольная сверка.
 */
export async function runSyncOnce(
  deps: SyncDeps,
  options: RunOnceOptions = {},
): Promise<PassResult> {
  const clock = deps.now ?? (() => new Date());
  const now = clock();
  const intervalMs = options.intervalMs ?? 30_000;

  // Блокировка берётся ДО чтения курсора и держится весь проход. Второй worker
  // или ручной запуск немедленно получают «занято» и в сеть не идут.
  const lock: SyncLock | null = await acquireSyncLock(deps.lock);
  if (lock === null) {
    return emptyResult('skipped');
  }

  try {
    const cursor = await claimPass(deps, now);
    if (cursor === null) {
      return emptyResult('skipped');
    }
    return await runClaimedPass(deps, cursor, options, now, intervalMs, clock);
  } finally {
    // Освобождение обязательно: иначе замок жил бы до конца процесса.
    await lock.release();
  }
}

async function runClaimedPass(
  deps: SyncDeps,
  cursor: CursorState,
  options: RunOnceOptions,
  now: Date,
  intervalMs: number,
  clock: () => Date,
): Promise<PassResult> {
  try {
    // Расширенная загрузка обязана пройти раньше сверки: сверка по широкой
    // выборке при непрочитанной производственной области сначала создала бы
    // самовывозы и лишь потом сравнивала бы — это то же самое чтение, но без
    // сохранённого признака завершения.
    const needsFullLoad = !cursor.initialLoadCompleted || !cursor.fulfillmentLoadCompleted;

    const needsReconciliation =
      options.allowReconciliation === true &&
      !needsFullLoad &&
      (cursor.lastReconciliationAt === null ||
        now.getTime() - cursor.lastReconciliationAt.getTime() >= 24 * 60 * 60 * 1000);

    const result = needsReconciliation
      ? await runReconciliation(deps)
      : needsFullLoad
        ? await runInitialLoad(deps, cursor)
        : await runDeltaPass(deps, cursor);

    await setIntegrationStatus(deps, 'OK', { pass: result.kind, processed: result.processed });
    // Следующая попытка отсчитывается от ФАКТИЧЕСКОГО завершения: у долгого
    // прохода пауза, отсчитанная от старта, истекла бы ещё до его конца.
    await releasePass(deps, { ok: true }, clock(), intervalMs);
    return result;
  } catch (error) {
    const failure = classify(error);
    await setIntegrationStatus(deps, failure.state, {
      code: failure.code,
      attempt: cursor.consecutiveFailures + 1,
      backoffMs: failure.retryAfterMs ?? backoffForAttempt(cursor.consecutiveFailures),
    });
    await releasePass(deps, { ok: false, retryAfterMs: failure.retryAfterMs }, clock(), intervalMs);
    throw error;
  }
}

function classify(error: unknown): {
  state: 'DEGRADED' | 'ERROR';
  code: string;
  retryAfterMs: number | null;
} {
  if (error instanceof MoyskladError) {
    if (error.code === 'RATE_LIMITED') {
      return { state: 'DEGRADED', code: error.code, retryAfterMs: rateLimitDelay(error) };
    }
    // Отказ авторизации и прав сам не пройдёт: это состояние требует человека.
    if (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN') {
      return { state: 'ERROR', code: error.code, retryAfterMs: null };
    }
    return { state: 'DEGRADED', code: error.code, retryAfterMs: null };
  }
  return { state: 'DEGRADED', code: 'UNKNOWN', retryAfterMs: null };
}

/**
 * Обновляет состояние интеграции вместе с безопасным realtime-событием.
 * В `details` попадают только коды и числа: ни токена, ни адресов, ни тел ответов.
 */
export async function setIntegrationStatus(
  deps: SyncDeps,
  state: 'NOT_CONFIGURED' | 'CONFIGURED' | 'OK' | 'DEGRADED' | 'ERROR',
  details: Record<string, string | number | boolean | null>,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();

  await deps.db.$transaction(async (tx) => {
    await tx.integrationStatus.upsert({
      where: { provider: PROVIDER },
      create: {
        provider: PROVIDER,
        state,
        details,
        ...(state === 'OK' ? { lastOkAt: now } : { lastErrorAt: now }),
      },
      update: {
        state,
        details,
        ...(state === 'OK' ? { lastOkAt: now } : { lastErrorAt: now }),
      },
    });

    await publishRealtimeEvent(tx, {
      topic: 'integration.status_changed',
      payload: { provider: PROVIDER, state },
      audienceRoles: ['ADMIN', 'LOGISTICIAN'],
    });
  });
}

/** Аудит запуска ручного прохода: он выполняется человеком, а не расписанием. */
export async function auditManualPass(deps: SyncDeps, outcome: string): Promise<void> {
  await deps.db.$transaction((tx: TransactionClient) =>
    writeAudit(tx, {
      action: 'ORDER_SYNCED',
      entityType: 'IntegrationCursor',
      entityId: null,
      actorUserId: null,
      source: 'worker',
      newValue: { manual: true, outcome },
    }),
  );
}
