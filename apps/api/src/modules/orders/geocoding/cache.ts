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
 */

import type { $Enums } from '../../../generated/prisma/client.js';
import type { Database } from '../../../platform/db.js';
import type { TransactionClient } from '../../auth/sessions.js';
import type { PhotonAnswer } from '../../integrations/photon/client.js';
import { MAX_LAT_MICRO, MAX_LON_MICRO, toMicro } from '../geo.js';
import { normalizeAddress } from './normalize.js';

/** Микроградусы обратно в градусы: в кэше координата хранится целой. */
const MICRO = 1_000_000;

type Client = Database | TransactionClient;

/**
 * Ответ из кэша.
 *
 * `undefined` — записи нет, нужно спрашивать геокодер. `null` внутри
 * `PhotonAnswer | null` означает «геокодер уже отвечал, что не нашёл».
 */
export async function readCache(
  db: Client,
  address: string,
): Promise<PhotonAnswer | null | undefined> {
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
    return null;
  }
  return {
    lat: entry.latMicro / MICRO,
    lon: entry.lonMicro / MICRO,
    precision: 'HOUSE',
  };
}

/** Исход поиска в терминах кэша. */
export function outcomeOf(answer: PhotonAnswer | null): $Enums.GeocodeOutcome {
  if (answer === null) {
    return 'NOT_FOUND';
  }
  return answer.precision === 'HOUSE' ? 'HOUSE' : 'AMBIGUOUS';
}

/**
 * Записывает ответ геокодера.
 *
 * Строка заменяется целиком: это кэш, а не история. Доказательством
 * изменений служат `OrderGeoHistory` и `OrderAddressHistory`, где записи
 * неизменяемы.
 */
export async function writeCache(
  db: Client,
  address: string,
  answer: PhotonAnswer | null,
): Promise<void> {
  const key = normalizeAddress(address);
  if (key === '') {
    return;
  }

  const outcome = outcomeOf(answer);
  // Координаты сохраняются ТОЛЬКО у точного дома — это же правило закреплено
  // ограничением базы, поэтому неточная привязка не может выглядеть пригодной.
  let point: { latMicro: number; lonMicro: number } | null = null;
  if (outcome === 'HOUSE' && answer !== null) {
    try {
      point = {
        latMicro: toMicro(answer.lat, MAX_LAT_MICRO, 'lat'),
        lonMicro: toMicro(answer.lon, MAX_LON_MICRO, 'lon'),
      };
    } catch {
      // Координата вне планеты кэшируется как «не найдено»: хранить заведомо
      // непригодную точку опаснее, чем не хранить ничего.
      point = null;
    }
  }

  const data = {
    outcome: point === null && outcome === 'HOUSE' ? ('NOT_FOUND' as const) : outcome,
    latMicro: point?.latMicro ?? null,
    lonMicro: point?.lonMicro ?? null,
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
