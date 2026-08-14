/**
 * Очередь геокодирования: постановка заданий и разовое наполнение.
 *
 * Задание ставится в ТОЙ ЖЕ транзакции, что и бизнес-изменение заказа. Иначе
 * возможны состояния «адрес обновлён, задания нет» и «задание есть, адреса ещё
 * нет»: первое навсегда оставило бы заказ без точки, второе отправило бы
 * провайдеру предыдущий адрес.
 *
 * В самой очереди адреса нет. Хранится только ссылка на заказ и поколение
 * адреса; текст читается из заказа непосредственно перед запросом. Так очередь
 * не становится второй копией персональных данных, а ответ, вернувшийся после
 * смены адреса, невозможно применить к новому адресу по ошибке.
 */

import { geocodingAddress } from '../address.js';
import type { $Enums } from '../../../generated/prisma/client.js';
import type { TransactionClient } from '../../auth/sessions.js';
import type { Database } from '../../../platform/db.js';

/** Сколько раз задание повторяется, прежде чем заказ признаётся неразрешимым. */
export const MAX_ATTEMPTS = 5;

/**
 * Ограниченный backoff: 30 → 60 → 120 → 300 → 900 секунд.
 *
 * Экспонента без потолка после нескольких неудач отодвинула бы повтор
 * на сутки, а заказ доставляется сегодня. Последний интервал — четверть часа:
 * этого достаточно, чтобы пережить перезапуск чужого сервиса, и мало,
 * чтобы потерять рабочий день.
 */
export const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 900_000] as const;

export function retryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(0, attempts - 1), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 900_000;
}

/** Состояние заказа, по которому решается, нужна ли постановка в очередь. */
export interface EnqueueCandidate {
  id: string;
  address: string | null;
  /// Запрос к геокодеру, собранный из разобранного адреса.
  /// Необязателен: пусто означает «отдельного запроса нет», берётся `address`.
  geocodeAddress?: string | null;
  /// Локальная правка логиста: рабочим считается именно она.
  /// Необязательна: прежний код её не передаёт, и это значит «правки нет».
  localAddress?: string | null;
  inScope: boolean;
  sourceArchived: boolean;
  sourceMissing: boolean;
  geoState: $Enums.OrderGeoState;
  geoSource: $Enums.OrderGeoSource | null;
  geoGeneration: number;
}

/**
 * Можно ли отправлять адрес заказа провайдеру.
 *
 * Пустой адрес наружу не уходит: платный запрос по пустой строке бессмыслен,
 * а заказ и так попадает в «Требует внимания». Заказ вне нашей области, архивный
 * или пропавший мы не везём — тратить на него деньги и отправлять его адрес
 * стороннему сервису оснований нет. Уже подтверждённая человеком точка тоже
 * не переспрашивается: решение человека автоматика не пересматривает.
 */
export function isGeocodable(order: EnqueueCandidate): boolean {
  // Провайдеру уходит ЗАПРОС, а не показываемый адрес: правка логиста сильнее
  // всего, затем разобранный запрос, затем адрес заказа.
  const address = geocodingAddress(order);
  if (address === null) {
    return false;
  }
  if (!order.inScope || order.sourceArchived || order.sourceMissing) {
    return false;
  }
  return !(order.geoState === 'RESOLVED' && order.geoSource === 'MANUAL');
}

export interface EnqueueResult {
  enqueued: boolean;
  generation: number;
}

/**
 * Ставит адрес заказа в очередь геокодирования.
 *
 * Поколение увеличивается ровно здесь и только здесь: оно означает «эта версия
 * адреса отправлена на разрешение». Пара (orderId, geoGeneration) уникальна
 * в базе, поэтому повтор того же снимка дубликат не создаёт.
 *
 * Вызывается внутри уже открытой бизнес-транзакции, строка заказа к этому
 * моменту заблокирована вызывающей стороной.
 */
export async function enqueueGeocoding(
  tx: TransactionClient,
  order: EnqueueCandidate,
  now: Date,
): Promise<EnqueueResult> {
  if (!isGeocodable(order)) {
    return { enqueued: false, generation: order.geoGeneration };
  }

  const generation = order.geoGeneration + 1;

  await tx.deliveryOrder.update({
    where: { id: order.id },
    data: {
      geoGeneration: generation,
      geoState: 'PENDING',
      // Прежняя точка к этому моменту уже снята: PENDING без координат —
      // требование инварианта базы, а не соглашение кода.
      geoSource: null,
      geoPrecision: null,
      geoLatMicro: null,
      geoLonMicro: null,
      geoResolvedAt: null,
      geoReviewReason: null,
    },
  });

  await tx.orderGeocodeJob.create({
    data: {
      orderId: order.id,
      geoGeneration: generation,
      status: 'PENDING',
      maxAttempts: MAX_ATTEMPTS,
      nextAttemptAt: now,
    },
  });

  await tx.orderGeoHistory.create({
    data: {
      orderId: order.id,
      kind: 'GEOCODE_REQUESTED',
      occurredAt: now,
      state: 'PENDING',
    },
  });

  return { enqueued: true, generation };
}

export interface BackfillResult {
  scanned: number;
  enqueued: number;
  /** Наполнение остановлено запросом извне: процесс завершается. */
  stopped: boolean;
  /** Сработал аварийный предел числа пачек. Молчаливого обрыва не бывает. */
  exhaustedBatches: boolean;
}

export interface BackfillOptions {
  batchSize?: number;
  /**
   * Аварийный предел числа пачек.
   *
   * Это не рабочее ограничение объёма, а защита от бесконечного цикла:
   * обычный проход заканчивается, когда подходящих заказов не осталось.
   * Достижение предела попадает в результат и в журнал — заказы не могут
   * молча остаться без геокодирования.
   */
  maxBatches?: number;
  now?: () => Date;
  /** Проверка запроса на остановку. Опрашивается между пачками. */
  shouldStop?: () => boolean;
}

/**
 * Разовое наполнение очереди уже импортированными заказами.
 *
 * Нужно после включения геокодирования: заказы, пришедшие до него, остались
 * в `UNRESOLVED` и сами в очередь не попадут — постановка происходит только
 * при импорте и смене адреса.
 *
 * Проход идёт небольшими пачками ДО ИСЧЕРПАНИЯ, а не до фиксированного числа
 * записей: остановиться на первых пятистах значило бы молча оставить остальные
 * заказы без точки навсегда, потому что второй раз наполнение не запускается.
 *
 * Курсор по идентификатору обязателен. Без него заказ, который выбрался
 * кандидатом, но не прошёл проверку под блокировкой, попадал бы в каждую
 * следующую пачку и не пускал бы к остальным — проход крутился бы на месте.
 *
 * Каждая пачка — отдельная короткая транзакция: длинная транзакция на тысячи
 * заказов держала бы блокировки всё время наполнения.
 */
export async function backfillGeocoding(
  db: Database,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const batchSize = Math.min(Math.max(1, options.batchSize ?? 50), 200);
  const maxBatches = Math.max(1, options.maxBatches ?? 100_000);
  const clock = options.now ?? ((): Date => new Date());
  const shouldStop = options.shouldStop ?? ((): boolean => false);

  const result: BackfillResult = {
    scanned: 0,
    enqueued: 0,
    stopped: false,
    exhaustedBatches: false,
  };

  // Курсор по идентификатору: он двигается всегда, независимо от того,
  // удалось ли поставить конкретный заказ в очередь.
  let cursor = '00000000-0000-0000-0000-000000000000';

  for (let batch = 0; batch < maxBatches; batch += 1) {
    if (shouldStop()) {
      result.stopped = true;
      return result;
    }

    // Выборка сырым запросом: пустой и состоящий из пробелов адрес отсекается
    // прямо здесь. Такой заказ не годится для отправки, и оставлять его
    // кандидатом значило бы каждый раз тратить на него место в пачке.
    const candidates = await db.$queryRaw<{ id: string }[]>`
      SELECT o."id"::text AS "id"
      FROM "DeliveryOrder" AS o
      WHERE o."geoState" = 'UNRESOLVED'
        AND o."inScope" = TRUE
        AND o."sourceArchived" = FALSE
        AND o."sourceMissing" = FALSE
        AND o."address" IS NOT NULL
        AND btrim(o."address") <> ''
        AND o."id" > ${cursor}::uuid
        AND NOT EXISTS (
          SELECT 1
          FROM "OrderGeocodeJob" AS j
          WHERE j."orderId" = o."id"
            AND j."status" IN ('PENDING', 'PROCESSING')
        )
      ORDER BY o."id" ASC
      LIMIT ${batchSize}
    `;

    if (candidates.length === 0) {
      return result;
    }

    result.scanned += candidates.length;

    for (const candidate of candidates) {
      cursor = candidate.id;

      const enqueued = await db.$transaction(async (tx) => {
        // Строка перечитывается под блокировкой: между выборкой и постановкой
        // заказ мог сменить адрес, выйти из области или получить ручную точку.
        const locked = await lockCandidate(tx, candidate.id);
        if (locked === null || locked.geoState !== 'UNRESOLVED' || !isGeocodable(locked)) {
          return false;
        }
        const outcome = await enqueueGeocoding(tx, locked, clock());
        return outcome.enqueued;
      });

      if (enqueued) {
        result.enqueued += 1;
      }
    }
  }

  // Предел достигнут: об этом обязаны узнать и вызывающая сторона, и журнал.
  result.exhaustedBatches = true;
  return result;
}

async function lockCandidate(
  tx: TransactionClient,
  orderId: string,
): Promise<EnqueueCandidate | null> {
  const rows = await tx.$queryRaw<EnqueueCandidate[]>`
    SELECT "id", "address", "inScope", "sourceArchived", "sourceMissing",
           "geoState", "geoSource", "geoGeneration"
    FROM "DeliveryOrder"
    WHERE "id" = ${orderId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}
