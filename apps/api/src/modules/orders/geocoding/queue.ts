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
  if (order.address === null || order.address.trim() === '') {
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
}

/**
 * Разовое наполнение очереди уже импортированными заказами.
 *
 * Нужно после включения геокодирования: заказы, пришедшие до него, остались
 * в `UNRESOLVED` и сами в очередь не попадут — постановка происходит только
 * при импорте и смене адреса.
 *
 * Пачки маленькие и с явным пределом: разом отправить в платный сервис всю
 * историю заказов означало бы неожиданный счёт и часы работы на предельном
 * темпе. Берутся только `UNRESOLVED` — заказ, ждущий человека (`NEEDS_REVIEW`)
 * или признанный неразрешимым (`FAILED`), автоматика не трогает.
 *
 * Каждая пачка — отдельная короткая транзакция: длинная транзакция на тысячи
 * заказов держала бы блокировки всё время наполнения.
 */
export async function backfillGeocoding(
  db: Database,
  options: { batchSize?: number; maxBatches?: number; now?: () => Date } = {},
): Promise<BackfillResult> {
  const batchSize = Math.min(Math.max(1, options.batchSize ?? 50), 200);
  const maxBatches = Math.max(1, options.maxBatches ?? 10);
  const clock = options.now ?? ((): Date => new Date());

  const result: BackfillResult = { scanned: 0, enqueued: 0 };

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const candidates = await db.deliveryOrder.findMany({
      where: {
        geoState: 'UNRESOLVED',
        inScope: true,
        sourceArchived: false,
        sourceMissing: false,
        address: { not: null },
        // Заказ с уже существующим незавершённым заданием пропускается:
        // повторная постановка увеличила бы поколение и обесценила бы
        // результат, который прямо сейчас летит от провайдера.
        geocodeJobs: { none: { status: { in: ['PENDING', 'PROCESSING'] } } },
      },
      orderBy: [{ deliveryDate: 'asc' }, { id: 'asc' }],
      take: batchSize,
      select: {
        id: true,
        address: true,
        inScope: true,
        sourceArchived: true,
        sourceMissing: true,
        geoState: true,
        geoSource: true,
        geoGeneration: true,
      },
    });

    if (candidates.length === 0) {
      break;
    }

    result.scanned += candidates.length;

    for (const candidate of candidates) {
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
