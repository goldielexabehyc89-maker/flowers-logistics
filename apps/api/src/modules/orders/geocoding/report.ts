/**
 * Сводка геокодирования: чистые числа и ничего больше.
 *
 * Эта сводка попадает в отчёт владельцу, поэтому здесь принципиально нет ни
 * одного адреса, ни одной координаты и ни одного идентификатора заказа. Всё,
 * что уходит наружу, — счётчики.
 *
 * Числа считаются запросами к базе, а не накапливаются в памяти: приложение
 * перезапускается, а вопрос «сколько адресов мы так и не разрешили» переживает
 * любой перезапуск.
 */

import type { Database } from '../../../platform/db.js';

export interface GeocodingReport {
  /** Всего адресов у заказов, которые вообще подлежат геокодированию. */
  totalAddresses: number;
  /** Точно найдено собственным Photon: дом, пригодный для маршрута. */
  exactByPhoton: number;
  /** Неоднозначно: геокодер нашёл улицу или район, но не дом. */
  ambiguous: number;
  /** Не найдено вовсе. */
  notFound: number;
  /** Отказ геокодера: адрес ни разу не получил ответа. */
  providerFailed: number;
  /** Исправлено человеком через подсказку DaData. */
  correctedViaDadata: number;
  /** Точка поставлена человеком руками по карте. */
  correctedManually: number;
  /** Ещё в очереди: ответа пока нет. */
  pending: number;
  /** Записей в кэше — это же и число адресов, за которые спрашивали Photon. */
  cachedAddresses: number;
  /** Сколько обращений к Photon кэш сэкономил за всё время. */
  requestsSavedByCache: number;
}

/**
 * Заказы, которые вообще подлежат геокодированию.
 *
 * Те же условия, что и у постановки в очередь: архивные, пропавшие и не наши
 * заказы адреса не разрешают, и включать их в знаменатель значило бы занижать
 * долю найденного без всякой на то причины.
 */
const GEOCODABLE = {
  inScope: true,
  sourceArchived: false,
  sourceMissing: false,
} as const;

export async function geocodingReport(db: Database): Promise<GeocodingReport> {
  const [total, byState, bySource, cache] = await Promise.all([
    db.deliveryOrder.count({
      where: {
        ...GEOCODABLE,
        OR: [{ address: { not: null } }, { localAddress: { not: null } }],
      },
    }),
    db.deliveryOrder.groupBy({
      by: ['geoState', 'geoReviewReason'],
      where: GEOCODABLE,
      _count: { _all: true },
    }),
    db.deliveryOrder.groupBy({
      by: ['geoSource'],
      where: { ...GEOCODABLE, geoState: 'RESOLVED' },
      _count: { _all: true },
    }),
    db.geocodeCacheEntry.groupBy({
      by: ['outcome'],
      _count: { _all: true },
      _sum: { hits: true },
    }),
  ]);

  const states = (
    state: string,
    reason?: string,
  ): number =>
    byState
      .filter((row) => row.geoState === state && (reason === undefined || row.geoReviewReason === reason))
      .reduce((sum, row) => sum + row._count._all, 0);

  const sources = (source: string): number =>
    bySource.find((row) => row.geoSource === source)?._count._all ?? 0;

  return {
    totalAddresses: total,
    exactByPhoton: sources('PHOTON'),
    // Неоднозначность видна и по заказу, и по кэшу. Берётся заказ: вопрос
    // «сколько адресов требуют человека» — про заказы, а не про строки кэша.
    ambiguous: states('NEEDS_REVIEW', 'LOW_PRECISION'),
    notFound: cache.find((row) => row.outcome === 'NOT_FOUND')?._count._all ?? 0,
    providerFailed: states('FAILED'),
    correctedViaDadata: sources('DADATA'),
    correctedManually: sources('MANUAL'),
    pending: states('PENDING'),
    cachedAddresses: cache.reduce((sum, row) => sum + row._count._all, 0),
    requestsSavedByCache: cache.reduce((sum, row) => sum + (row._sum.hits ?? 0), 0),
  };
}
