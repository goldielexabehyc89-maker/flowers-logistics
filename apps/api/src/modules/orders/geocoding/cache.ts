/**
 * Кэш геокодирования по нормализованному адресу.
 *
 * Смысл один: не платить обращением к геокодеру за адрес, который уже искали.
 * Один и тот же адрес приходит десятками заказов и в десятке написаний,
 * поэтому ключом служит нормализованная форма, а не исходная строка.
 *
 * Кэш хранит и отрицательные ответы. «Не найдено» — такой же результат, как
 * и найденный дом: повторять безнадёжный поиск на каждом проходе значит
 * тратить время и нагружать сервис ради того же самого ответа. Исправляет
 * такой адрес человек, и его правка меняет строку, а значит и ключ.
 *
 * В кэше лежит РЕШЕНИЕ, а не сырой ответ геокодера. Иначе попадание в кэш
 * обходило бы сверку ответа с адресом (`verify.ts`), и однажды принятая
 * по ошибке точка возвращалась бы снова и снова, уже без всякой проверки.
 */

import type { $Enums } from '../../../generated/prisma/client.js';
import type { Database } from '../../../platform/db.js';
import type { TransactionClient } from '../../auth/sessions.js';
import type { PhotonAnswer } from '../../integrations/photon/client.js';
import { normalizeAddress } from './normalize.js';

type Client = Database | TransactionClient;

/** Решение по адресу — то же самое, что применяется к заказу. */
export type GeocodeDecision =
  { kind: 'RESOLVED'; latMicro: number; lonMicro: number } | { kind: 'LOW_PRECISION' };

/**
 * Решение из кэша.
 *
 * `undefined` — записи нет, нужно спрашивать геокодер.
 */
export async function readCache(db: Client, address: string): Promise<GeocodeDecision | undefined> {
  const key = normalizeAddress(address);
  if (key === '') {
    return undefined;
  }

  const entry = await db.geocodeCacheEntry.findUnique({
    where: { normalizedAddress: key },
    select: { outcome: true, latMicro: true, lonMicro: true },
  });
  if (entry === null) {
    return undefined;
  }

  // Счётчик попаданий нужен отчёту о расходе: он показывает, сколько
  // обращений к геокодеру кэш сэкономил.
  await db.geocodeCacheEntry.update({
    where: { normalizedAddress: key },
    data: { hits: { increment: 1 } },
  });

  if (entry.outcome !== 'HOUSE' || entry.latMicro === null || entry.lonMicro === null) {
    return { kind: 'LOW_PRECISION' };
  }
  return { kind: 'RESOLVED', latMicro: entry.latMicro, lonMicro: entry.lonMicro };
}

/**
 * Исход в терминах кэша.
 *
 * «Не найдено» и «найдено, но не принято» различаются намеренно: это разные
 * проблемы. Первую решает исправление адреса, вторую — человек, который смотрит
 * на несоответствие между запросом и ответом.
 */
export function outcomeOf(
  decision: GeocodeDecision,
  answer: PhotonAnswer | null,
): $Enums.GeocodeOutcome {
  if (decision.kind === 'RESOLVED') {
    return 'HOUSE';
  }
  return answer === null ? 'NOT_FOUND' : 'AMBIGUOUS';
}

/**
 * Записывает принятое решение.
 *
 * Строка заменяется целиком: это кэш, а не история. Доказательством изменений
 * служат `OrderGeoHistory` и `OrderAddressHistory`, где записи неизменяемы.
 *
 * Координаты сохраняются только у ПРИНЯТОГО дома — то же правило закреплено
 * ограничением базы, поэтому непринятая привязка не может выглядеть пригодной.
 */
export async function writeCache(
  db: Client,
  address: string,
  decision: GeocodeDecision,
  answer: PhotonAnswer | null,
): Promise<void> {
  const key = normalizeAddress(address);
  if (key === '') {
    return;
  }

  const data =
    decision.kind === 'RESOLVED'
      ? {
          outcome: 'HOUSE' as const,
          latMicro: decision.latMicro,
          lonMicro: decision.lonMicro,
          source: 'PHOTON' as const,
        }
      : {
          outcome: outcomeOf(decision, answer),
          latMicro: null,
          lonMicro: null,
          source: 'PHOTON' as const,
        };

  await db.geocodeCacheEntry.upsert({
    where: { normalizedAddress: key },
    create: { normalizedAddress: key, ...data },
    update: data,
  });
}

export interface CacheStats {
  entries: number;
  house: number;
  ambiguous: number;
  notFound: number;
  /** Сколько обращений к геокодеру кэш сэкономил за всё время. */
  savedRequests: number;
}

/** Сводка кэша. Адресов не показывает: наружу идут только числа. */
export async function cacheStats(db: Database): Promise<CacheStats> {
  const grouped = await db.geocodeCacheEntry.groupBy({
    by: ['outcome'],
    _count: { _all: true },
    _sum: { hits: true },
  });

  const count = (outcome: $Enums.GeocodeOutcome): number =>
    grouped.find((row) => row.outcome === outcome)?._count._all ?? 0;

  return {
    entries: grouped.reduce((total, row) => total + row._count._all, 0),
    house: count('HOUSE'),
    ambiguous: count('AMBIGUOUS'),
    notFound: count('NOT_FOUND'),
    savedRequests: grouped.reduce((total, row) => total + (row._sum.hits ?? 0), 0),
  };
}
