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
import { mapOrder, type AddressSource } from './mapper.js';
import { RegionDirectory, regionHrefOf } from './regions.js';
import { acquireSyncLock, type LockDeps, type SyncLock } from './sync-lock.js';
import {
  CompositionError,
  CompositionSource,
  type FulfillmentTexts,
} from './composition-source.js';
import type { MoyskladOrderDto } from './dto.js';
import { parseMoscow } from './moscow-time.js';
import { applyFulfillmentSnapshot } from '../../fulfillment/service.js';
import type { FulfillmentSnapshot } from '../../fulfillment/composition.js';

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
  /** Откуда собирать запрос к геокодеру. Умолчание — отдельного запроса нет. */
  addressSource?: AddressSource;
  /**
   * Создавать ли ВПЕРВЫЕ появившиеся заказы по новому адресному контракту.
   *
   * Значение выключателя окружения. На существующие заказы не влияет никак:
   * их версия уже записана и синхронизацией не переписывается.
   */
  structuredAddressV2?: boolean;

  /**
   * Нижняя граница даты доставки для ВПЕРВЫЕ создаваемых заказов.
   *
   * Отсутствие значения означает «границы нет»: так работают local и staging.
   * Существующие заказы граница не трогает — они продолжают получать
   * обновления, иначе новый контур потерял бы отмену или смену интервала.
   */
  importDeliveryDateFrom?: string | undefined;
  /**
   * Идентификатор статуса «Отменен» этого аккаунта.
   *
   * Отсутствие значения означает выключенное распознавание отмен, а не
   * «отмен не бывает»: молча считать отменённым что-либо по догадке нельзя.
   */
  cancelledStateId?: string | null;
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
  /**
   * Создавать ли задание геокодирования при ПЕРВОМ импорте заказа.
   *
   * Это не разрешение обращаться к геокодеру: обработку включает отдельный
   * флаг. Здесь решается только, фиксировать ли событие.
   */
  enqueueOnImport?: boolean;
  /**
   * Сколько заказов дочитывает очередь состава за проход.
   *
   * Переопределяется только в проверках: сценарии логистического прохода
   * не должны зависеть от чужих заказов, оставшихся в общей тестовой базе.
   * В приложении значение не задаётся и берётся из `COMPOSITION_BACKFILL_LIMIT`.
   */
  compositionBackfillLimit?: number;
}

export interface PassResult {
  kind: 'initial' | 'delta' | 'reconciliation' | 'skipped';
  pages: number;
  processed: number;
  created: number;
  updated: number;
  skippedOutOfScope: number;
  /**
   * Заказов, не созданных из-за нижней границы даты доставки.
   *
   * Считается отдельно от «вне области»: это разные причины, и смешать их
   * значило бы потерять ответ на вопрос «сколько старых сделок мы не завели».
   * Сюда же попадают заказы без даты и с нераспознанной датой.
   */
  skippedBeforeCutoff: number;
  missing: number;
  /** Заказов, у которых производственный состав подтверждён в этом проходе. */
  compositionConfirmed: number;
  /** Заказов, у которых состав подтвердить не удалось: проекция не тронута. */
  compositionUnconfirmed: number;
  /** Заказов, дочитанных очередью состава независимо от изменения `updated`. */
  compositionBackfilled: number;
  /** Сетевых обращений за компонентами бандлов: показывает работу кэша прохода. */
  bundleRequests: number;
}

const emptyResult = (kind: PassResult['kind']): PassResult => ({
  kind,
  pages: 0,
  processed: 0,
  created: 0,
  updated: 0,
  skippedOutOfScope: 0,
  skippedBeforeCutoff: 0,
  missing: 0,
  compositionConfirmed: 0,
  compositionUnconfirmed: 0,
  compositionBackfilled: 0,
  bundleRequests: 0,
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
      // Состав запрашивается на КАЖДОМ пути чтения заказов — полная загрузка,
      // delta и контрольная сверка идут через эту функцию. Отключить его для
      // одного из путей означало бы, что заказ, изменившийся именно там,
      // сохранится без состава и никем не будет замечен.
      withPositions: true,
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

/**
 * Применяет страницу заказов вместе с производственным составом.
 *
 * Порядок действий важен. Сеть выполняется ДО открытия транзакции: держать
 * соединение с базой открытым на время HTTP нельзя, иначе медленный внешний
 * ответ занимал бы соединение и блокировал строку заказа.
 *
 * Отказ состава одного заказа не роняет ни страницу, ни проход: заказ
 * сохраняется, его подтверждённая проекция остаётся нетронутой, а состояние
 * состава уходит в `PENDING`/`FAILED`, откуда его заберёт очередь дозагрузки.
 */
async function applyRows(
  deps: SyncDeps,
  rows: unknown[],
  result: PassResult,
  source: CompositionSource,
  regions: RegionDirectory,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();

  /*
   * Названия регионов дочитываются ОДИН раз на страницу и до транзакций.
   *
   * Регион приходит ссылкой без названия, а деталям адреса нужно название.
   * Спрашивать справочник внутри транзакции нельзя — соединение с базой
   * висело бы на время HTTP; спрашивать на каждый заказ незачем — страница
   * одного города даёт один запрос.
   */
  await regions.resolve(
    rows
      .map((row) => regionHrefOf((row as MoyskladOrderDto).shipmentAddressFull))
      .filter((href): href is string => href !== null),
  );

  for (const row of rows) {
    const { snapshot } = mapOrder(row as never, deps.ids, deps.addressSource, regions.snapshot);
    const order = row as MoyskladOrderDto;

    // Состав нужен только производственной области. Заказ чужого склада
    // не сохраняется вовсе, и разбирать его состав незачем.
    //
    // Сети здесь нет: используется только состав, пришедший вместе со
    // страницей. Единственные возможные обращения — компоненты бандлов,
    // и те с кэшем на проход.
    const composition = snapshot.fulfillmentInScope ? await buildComposition(source, order) : null;

    const applied = await deps.db.$transaction(async (tx: TransactionClient) => {
      const orderResult = await applyOrderSnapshot(tx, snapshot, now, {
        geocoding: deps.enqueueOnImport === true,
        cancelledStateId: deps.cancelledStateId ?? null,
        structuredAddressV2: deps.structuredAddressV2 === true,
        importDeliveryDateFrom: deps.importDeliveryDateFrom,
      });

      if (composition === null) {
        return { orderResult, fulfillment: null };
      }

      const fulfillment = await applyFulfillmentSnapshot(
        tx,
        {
          externalId: snapshot.externalId,
          externalUpdated: parseMoscow(snapshot.externalUpdated),
          texts: composition.texts,
          snapshot: composition.snapshot,
          failure: composition.failure,
        },
        now,
      );
      return { orderResult, fulfillment };
    });

    result.processed += 1;
    if (applied.orderResult.outcome === 'CREATED') result.created += 1;
    if (
      applied.orderResult.outcome === 'UPDATED' ||
      applied.orderResult.outcome === 'SCOPE_ENTERED'
    )
      result.updated += 1;
    if (applied.orderResult.outcome === 'SCOPE_EXITED') result.updated += 1;
    if (applied.orderResult.outcome === 'SKIPPED_OUT_OF_SCOPE') result.skippedOutOfScope += 1;
    if (applied.orderResult.outcome === 'SKIPPED_BEFORE_CUTOFF') result.skippedBeforeCutoff += 1;

    if (applied.fulfillment !== null) {
      if (applied.fulfillment.outcome === 'UNCONFIRMED') {
        result.compositionUnconfirmed += 1;
      } else if (
        applied.fulfillment.outcome !== 'SKIPPED' &&
        applied.fulfillment.outcome !== 'STALE'
      ) {
        result.compositionConfirmed += 1;
      }
    }
  }

  result.bundleRequests = source.bundleRequests;
}

interface BuiltComposition {
  texts: FulfillmentTexts;
  snapshot: FulfillmentSnapshot | null;
  failure: string | null;
}

/**
 * Собирает состав из страницы, превращая отказ в данные, а не в исключение.
 *
 * Исключение здесь уронило бы всю страницу: один заказ с испорченным составом
 * остановил бы импорт остальных девяноста девяти. Отказ обязан быть локальным
 * и заметным, а не заразным.
 */
async function buildComposition(
  source: CompositionSource,
  order: MoyskladOrderDto,
): Promise<BuiltComposition> {
  const texts = source.texts(order);
  try {
    return { texts, snapshot: await source.fromEmbedded(order), failure: null };
  } catch (error) {
    if (error instanceof CompositionError) {
      return { texts, snapshot: null, failure: error.reason };
    }
    // Неизвестная ошибка тоже не должна валить страницу, но и молчать о ней
    // нельзя: безопасный код отказа остаётся в строке заказа.
    return { texts, snapshot: null, failure: 'UNKNOWN' };
  }
}

/**
 * Сколько заказов дочитывается за один проход.
 *
 * Потолок нужен с двух сторон. Без него первый проход после миграции попытался
 * бы дочитать тысячу заказов подряд при темпе один запрос в секунду и занял бы
 * общий лимит аккаунта на двадцать минут. С другой стороны, очередь обязана
 * рассасываться: после полной загрузки в ней остаются единицы, потому что
 * состав приходит вместе со страницей заказов.
 */
export const COMPOSITION_BACKFILL_LIMIT = 25;

/**
 * Дозагрузка производственного состава.
 *
 * ЭТО ГЛАВНАЯ ГАРАНТИЯ СРЕЗА, и она существует ради одного конкретного отказа.
 * Заказ пришёл delta-проходом, состав получить не удалось, курсор ушёл вперёд.
 * Delta приносит только изменившиеся документы — а этот больше не изменится.
 * Без очереди такой заказ навсегда остался бы без состава, причём выглядел бы
 * как обычный заказ с пустым составом.
 *
 * Поэтому очередь живёт в базе, в колонке состояния самого заказа, и работает
 * НЕЗАВИСИМО от `customerorder.updated`. Она не зависит ни от курсора, ни от
 * окна перекрытия, ни от того, менялся ли заказ в МоемСкладе.
 *
 * Порядок выборки — по числу неудач, затем по дате доставки: один неисправимый
 * заказ не должен занимать всю квоту прохода и задерживать свежие.
 *
 * Отказ дозагрузки не роняет проход: он уже сохранил заказы, и терять эту
 * работу из-за недоступного состава нельзя.
 */
export async function runCompositionBackfill(
  deps: SyncDeps,
  source: CompositionSource,
  result: PassResult,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();

  const limit = deps.compositionBackfillLimit ?? COMPOSITION_BACKFILL_LIMIT;
  if (limit <= 0) {
    return;
  }

  const pending = await deps.db.deliveryOrder.findMany({
    where: {
      fulfillmentInScope: true,
      sourceMissing: false,
      fulfillmentCompositionState: { in: ['PENDING', 'FAILED'] },
      // Тексты снимка приходят только вместе с документом заказа. Заказ,
      // документа которого этот код ещё не видел, ожидающей версии не имеет,
      // и брать его в очередь нельзя: она читает лишь позиции и подтвердила бы
      // снимок с пустыми текстами, то есть записала бы в неизменяемую историю
      // неправду. Такие строки дочитывает полная загрузка — признак её
      // завершения сброшен миграцией `20260820090500`.
      fulfillmentPendingExternalUpdated: { not: null },
    },
    orderBy: [
      { fulfillmentCompositionAttempts: 'asc' },
      { deliveryDate: 'asc' },
      { externalId: 'asc' },
    ],
    take: limit,
    select: {
      externalId: true,
      fulfillmentPendingDescription: true,
      fulfillmentPendingCardText: true,
      fulfillmentPendingExternalUpdated: true,
    },
  });

  for (const order of pending) {
    // Тексты берутся из ОЖИДАЮЩЕЙ версии, а не из подтверждённой: подтверждать
    // надо ровно ту версию, ради которой заказ попал в очередь. Повторное
    // чтение документа стоило бы лишнего обращения ради данных, которые есть.
    const version = order.fulfillmentPendingExternalUpdated;
    const texts = {
      externalId: order.externalId,
      description: order.fulfillmentPendingDescription,
      cardText: order.fulfillmentPendingCardText,
    };

    let snapshot: FulfillmentSnapshot | null = null;
    let failure: string | null = null;
    try {
      snapshot = await source.fromApi(texts);
    } catch (error) {
      // Отказ одного заказа не прекращает очередь: следующий может читаться
      // нормально, и терять из-за него остальную квоту прохода нельзя.
      failure = error instanceof CompositionError ? error.reason : 'UNKNOWN';
    }

    const applied = await deps.db.$transaction((tx: TransactionClient) =>
      applyFulfillmentSnapshot(
        tx,
        {
          externalId: order.externalId,
          externalUpdated: version ?? now,
          texts: { description: texts.description, cardText: texts.cardText },
          snapshot,
          failure,
          // Пока шло чтение позиций, delta могла записать более новую версию.
          // Тогда этот результат устарел: подтверждать его как новую версию
          // и затирать её ожидающие поля нельзя.
          expectedPendingVersion: version,
        },
        now,
      ),
    );

    if (applied.outcome === 'UNCONFIRMED') {
      result.compositionUnconfirmed += 1;
    } else if (applied.outcome !== 'SKIPPED' && applied.outcome !== 'STALE') {
      result.compositionBackfilled += 1;
    }
  }

  result.bundleRequests = source.bundleRequests;
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
  // Кэш бандлов живёт ровно проход: один различный бандл загружается один раз,
  // даже если встретился в сотне заказов.
  const source = new CompositionSource(deps.client, deps.ids);
  // Справочник регионов живёт ровно проход: названия не меняются, а память
  // между проходами держать незачем.
  const regions = new RegionDirectory(deps.client);

  result.pages = await readAllPages(
    deps,
    {
      filter: approvedStoreFilter(deps.ids, initialLoadSince(now), deps.importDeliveryDateFrom),
      order: 'updated,asc',
    },
    (rows) => applyRows(deps, rows, result, source, regions),
  );

  // Дозагрузка выполняется ДО объявления загрузки завершённой. Заказы, состав
  // которых не подтвердился на страницах, обязаны получить свою попытку в том же
  // проходе — а те, что не получили, уже стоят в очереди состояния и придут
  // следующим проходом независимо от изменения `updated`.
  await runCompositionBackfill(deps, source, result);

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
  const source = new CompositionSource(deps.client, deps.ids);
  const regions = new RegionDirectory(deps.client);

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
      await applyRows(deps, unique, result, source, regions);
    },
  );

  // Дозагрузка состава выполняется ДО сдвига курсора.
  //
  // Это и есть защита от главного риска: заказ пришёл сюда один раз, состав
  // получить не удалось, и после сдвига курсора delta его больше не принесёт —
  // он просто не изменится. Очередь состояния в базе делает повтор
  // гарантированным независимо от `updated`, а её работа до сдвига курсора
  // означает, что подтверждение состава не откладывается на сутки вперёд.
  await runCompositionBackfill(deps, source, result);

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
  const source = new CompositionSource(deps.client, deps.ids);
  const regions = new RegionDirectory(deps.client);

  result.pages = await readAllPages(
    deps,
    {
      filter: approvedStoreFilter(deps.ids, since, deps.importDeliveryDateFrom),
      order: 'updated,asc',
    },
    async (rows) => {
      for (const row of rows) {
        const id = (row as { id?: string }).id;
        if (typeof id === 'string') {
          present.add(id);
        }
      }
      await applyRows(deps, rows, result, source, regions);
    },
  );

  await runCompositionBackfill(deps, source, result);

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
