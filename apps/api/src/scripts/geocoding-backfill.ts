/**
 * Ограниченный backfill геокодирования и статистика по нему.
 *
 * Наполнение очереди и обработка запускаются вручную и с явным потолком числа
 * ОБРАЩЕНИЙ к геокодеру. Потолок считается именно по обращениям, а не по
 * заказам: заказы, чей адрес уже есть в кэше, стоят ноль запросов, и ограничивать
 * их бессмысленно, а вот нагрузку на свой Photon ограничивать нужно.
 *
 * Ничего не выкатывает и ничего не включает: если `PHOTON_URL` не задан,
 * команда честно отказывается работать, а не идёт в чужой публичный сервис.
 *
 * Наружу выводятся ТОЛЬКО числа. Ни адресов, ни координат, ни идентификаторов
 * заказов здесь нет и быть не может — вывод попадает в отчёт владельцу.
 *
 * Запуск:
 *   npm run geocode:backfill -- --limit 200
 *   npm run geocode:backfill -- --report-only
 */

import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { PhotonClient } from '../modules/integrations/photon/client.js';
import { isPhotonConfigured } from '../modules/orders/geocoding/enabled.js';
import { backfillGeocoding } from '../modules/orders/geocoding/queue.js';
import { geocodingReport, type GeocodingReport } from '../modules/orders/geocoding/report.js';
import {
  GEOCODE_LOCK_KEY,
  processGeocodingOnce,
  type GeocodeWorkerDeps,
} from '../modules/orders/geocoding/worker.js';

/** Сколько заданий берётся за один проход. Обрабатываются последовательно. */
const BATCH_SIZE = 10;

/**
 * Защита от бесконечного цикла.
 *
 * Проход, который не сделал ни одного обращения и ничего не захватил, второй
 * раз результата не даст: очередь либо пуста, либо остановлена. Считать такие
 * проходы и останавливаться — честнее, чем крутиться до таймаута.
 */
const MAX_IDLE_PASSES = 3;

interface Options {
  limit: number;
  reportOnly: boolean;
}

function parseOptions(argv: readonly string[]): Options | string {
  let limit = 0;
  let reportOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report-only') {
      reportOnly = true;
      continue;
    }
    if (arg === '--limit') {
      const raw = argv[i + 1];
      i += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100_000) {
        return `--limit ожидает целое число от 1 до 100000, получено: ${String(raw)}`;
      }
      limit = parsed;
      continue;
    }
    return `Неизвестный аргумент: ${String(arg)}`;
  }

  if (!reportOnly && limit === 0) {
    // Умолчания нет намеренно: «ограниченный» backfill без явного потолка
    // ограниченным не является, а молчаливое умолчание однажды окажется не тем.
    return 'Укажите --limit <число обращений> либо --report-only';
  }

  return { limit, reportOnly };
}

/** Печатает сводку. Только числа — ни одного адреса. */
function printReport(title: string, report: GeocodingReport): void {
  const rows: [string, number][] = [
    ['Всего адресов', report.totalAddresses],
    ['Точно найдено Photon', report.exactByPhoton],
    ['Неоднозначно', report.ambiguous],
    ['Не найдено', report.notFound],
    ['Отказ геокодера', report.providerFailed],
    ['Исправлено через подсказку DaData', report.correctedViaDadata],
    ['Точка поставлена руками', report.correctedManually],
    ['Ещё в очереди', report.pending],
    ['Адресов в кэше', report.cachedAddresses],
    ['Запросов сэкономил кэш', report.requestsSavedByCache],
  ];

  process.stdout.write(`\n${title}\n`);
  for (const [label, value] of rows) {
    process.stdout.write(`  ${label.padEnd(36, '.')} ${String(value)}\n`);
  }
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  if (typeof options === 'string') {
    process.stderr.write(`${options}\n`);
    return 2;
  }

  const config = loadConfig();
  const logger = createLogger(config);
  const db = createDatabase(config, logger);

  try {
    if (options.reportOnly) {
      printReport('Состояние геокодирования', await geocodingReport(db));
      return 0;
    }

    // Отказ до создания клиента и до единого обращения к базе очереди.
    if (!isPhotonConfigured(config)) {
      logger.error('PHOTON_URL не задан: собственный геокодер не настроен');
      return 3;
    }

    const before = await geocodingReport(db);
    printReport('До прохода', before);

    // Наполнение очереди уже импортированными заказами. Само по себе оно
    // не делает ни одного обращения к геокодеру — только ставит задания.
    const filled = await backfillGeocoding(db, { batchSize: 50 });
    logger.info(
      { scanned: filled.scanned, enqueued: filled.enqueued, exhausted: filled.exhaustedBatches },
      'очередь наполнена',
    );

    const deps: GeocodeWorkerDeps = {
      db,
      logger,
      client: new PhotonClient({ url: config.PHOTON_URL ?? null }),
      lock: { connectionString: config.DATABASE_URL, key: GEOCODE_LOCK_KEY },
      workerId: 'backfill',
      batchSize: BATCH_SIZE,
    };

    let requests = 0;
    let resolved = 0;
    let lowPrecision = 0;
    let failed = 0;
    let idlePasses = 0;
    let haltedReason: string | null = null;

    while (requests < options.limit) {
      const pass = await processGeocodingOnce(deps);
      requests += pass.requests;
      resolved += pass.resolved;
      lowPrecision += pass.lowPrecision;
      failed += pass.failed;

      if (pass.haltedReason !== null) {
        // Остановка относится ко всему геокодеру: продолжать бессмысленно.
        haltedReason = pass.haltedReason;
        break;
      }
      if (pass.skippedBusy || pass.skippedCooldown) {
        logger.warn({ pass }, 'проход пропущен: занято либо действует пауза');
        break;
      }
      if (pass.claimed === 0) {
        break;
      }
      idlePasses = pass.requests === 0 && pass.resolved === 0 ? idlePasses + 1 : 0;
      if (idlePasses >= MAX_IDLE_PASSES) {
        break;
      }
    }

    const after = await geocodingReport(db);
    printReport('После прохода', after);

    process.stdout.write('\nЗа этот проход\n');
    for (const [label, value] of [
      ['Фактических запросов к Photon', requests],
      ['Разрешено', resolved],
      ['Неоднозначно либо не найдено', lowPrecision],
      ['Отказов', failed],
      ['Поставлено в очередь', filled.enqueued],
    ] as [string, number][]) {
      process.stdout.write(`  ${label.padEnd(36, '.')} ${String(value)}\n`);
    }

    if (haltedReason !== null) {
      logger.error({ haltedReason }, 'геокодер остановлен: проход прекращён');
      return 4;
    }
    if (requests >= options.limit) {
      logger.warn({ limit: options.limit }, 'достигнут указанный предел обращений');
    }
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Наружу идёт только тип ошибки: её текст мог бы содержать адрес.
    process.stderr.write(`Ошибка: ${error instanceof Error ? error.name : 'неизвестная'}\n`);
    process.exitCode = 1;
  });
