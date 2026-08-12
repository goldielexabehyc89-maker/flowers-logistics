/**
 * Нагрузочный пилот логистики: операторская команда.
 *
 * Отвечает на вопрос недели: выдерживает ли собранный стек матриц и решателя
 * рабочий день склада. Ничего не планирует и ничего не пишет: вызывает те же
 * функции, что и боевой расчёт, и печатает измерения.
 *
 *   npm run logistics:pilot -- --generate 10,30,59 --profile CAR --repeats 2
 *   npm run logistics:pilot -- --snapshot /абсолютный/путь/snapshot.json
 *
 * Операторская команда запускает СОБРАННЫЙ файл: в production-образе нет
 * ни TS-исходников, ни `tsx`, ни devDependencies, ни доступа к реестру npm.
 * Исходный вариант для локальной разработки назван отдельно суффиксом `:dev`.
 * Скрытого выбора по окружению нет — это разные, честно названные команды.
 *
 * В вывод не попадает ничего, кроме измерений: ни координат, ни адресов,
 * ни псевдонимов, ни тел ответов маршрутизатора и решателя.
 */

import { readFile } from 'node:fs/promises';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { ValhallaClient } from '../modules/integrations/valhalla/client.js';
import { VroomClient } from '../modules/integrations/vroom/client.js';
import {
  computeMatrix,
  newMatrixWorkerId,
  type MatrixDeps,
} from '../modules/geo/matrix/service.js';
import { createGraphGate } from '../modules/geo/routing-status.js';
import {
  buildDayFromSnapshotShape,
  buildSyntheticDay,
  PILOT_MAX_POINTS,
  runPilotScenario,
  type PilotScenario,
  type PilotScenarioReport,
} from '../modules/planning/pilot.js';
import type { $Enums } from '../generated/prisma/client.js';

const USAGE = [
  'Использование:',
  '  npm run logistics:pilot -- --generate 10,30,59 [--profile CAR|FOOT] [--repeats 2] [--seed 20260820]',
  '  npm run logistics:pilot -- --snapshot <абсолютный путь к orders-snapshot@2>',
  '',
  'Команде нужны настроенные VALHALLA_URL, VROOM_URL и VALHALLA_GRAPH_SHA256.',
].join('\n');

interface Args {
  sizes: number[];
  profiles: $Enums.VehicleType[];
  repeats: number;
  seed: number | undefined;
  snapshotPath: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key !== undefined && key.startsWith('--') && value !== undefined) {
      values.set(key.slice(2), value);
    }
  }

  const generate = values.get('generate');
  const sizes =
    generate === undefined
      ? [10, 30, PILOT_MAX_POINTS - 1]
      : generate
          .split(',')
          .map((part) => Number.parseInt(part.trim(), 10))
          .filter((size) => Number.isInteger(size) && size > 0);

  if (sizes.length === 0) {
    throw new Error(USAGE);
  }

  const profileArg = (values.get('profile') ?? 'CAR').toUpperCase();
  if (profileArg !== 'CAR' && profileArg !== 'FOOT' && profileArg !== 'BOTH') {
    throw new Error(USAGE);
  }

  const repeats = Number.parseInt(values.get('repeats') ?? '2', 10);
  const seedValue = values.get('seed');
  const seed = seedValue === undefined ? undefined : Number.parseInt(seedValue, 10);

  return {
    sizes,
    profiles: profileArg === 'BOTH' ? ['CAR', 'FOOT'] : [profileArg],
    repeats: Number.isInteger(repeats) && repeats >= 2 ? repeats : 2,
    seed: seed === undefined || Number.isNaN(seed) ? undefined : seed,
    snapshotPath: values.get('snapshot') ?? null,
  };
}

/** Строка человеческой сводки. Только числа: ни одной строки данных. */
function summarize(report: PilotScenarioReport): string {
  const solveMs = report.solves.map((solve) => solve.solveMs);
  const best = solveMs.length === 0 ? 0 : Math.min(...solveMs);
  const worst = solveMs.length === 0 ? 0 : Math.max(...solveMs);
  const verdict = report.gatesPassed
    ? 'ворота пройдены'
    : `ОТКАЗ: ${report.failure ?? 'неизвестно'}`;

  return [
    `${report.label.padEnd(16)}`,
    `точек ${String(report.pointCount).padStart(3)}`,
    `профиль ${report.profile.padEnd(10)}`,
    `матрица ${String(report.matrix.coldMs).padStart(6)}/${String(report.matrix.warmMs).padStart(6)} мс`,
    `кэш ${report.matrix.coldCached ? 'да' : 'нет'}/${report.matrix.warmCached ? 'да' : 'нет'}`,
    `решение ${String(best).padStart(6)}–${String(worst).padStart(6)} мс`,
    `маршрутов ${String(report.routes).padStart(2)}`,
    `неразмещённых ${String(report.unassigned).padStart(3)}`,
    `детерминизм ${report.deterministic ? 'да' : 'НЕТ'}`,
    verdict,
  ].join(' | ');
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config);

  // Окружение проверяется ДО создания базы и клиентов: пилот без графа
  // и решателя не имеет смысла, а половина запуска хуже честного отказа.
  if (config.VALHALLA_URL === undefined || config.VROOM_URL === undefined) {
    logger.error('пилоту нужны VALHALLA_URL и VROOM_URL: расчёт маршрутов не настроен');
    return 2;
  }
  if (config.VALHALLA_GRAPH_SHA256 === undefined) {
    logger.error('пилоту нужен VALHALLA_GRAPH_SHA256: без ревизии графа результат некуда отнести');
    return 2;
  }

  const snapshotOrders =
    args.snapshotPath === null
      ? null
      : ((JSON.parse(await readFile(args.snapshotPath, 'utf8')) as { orders: unknown[] })
          .orders as never[]);

  const db = createDatabase(config, logger);
  const valhalla = new ValhallaClient({ baseUrl: config.VALHALLA_URL });
  const vroom = new VroomClient({ baseUrl: config.VROOM_URL });
  const graphGate = createGraphGate({
    db,
    client: valhalla,
    expectedGraphSha256: config.VALHALLA_GRAPH_SHA256,
  });

  const matrixDeps: MatrixDeps = {
    db,
    logger,
    valhalla: {
      matrix: (points, costing) => valhalla.matrix(points, costing as 'auto' | 'pedestrian'),
      verifyGraph: graphGate.verifyGraph,
    },
    graphSha256: config.VALHALLA_GRAPH_SHA256,
    maxPoints: config.MATRIX_MAX_POINTS,
    ttlSeconds: config.MATRIX_CACHE_TTL_SECONDS,
    workerId: newMatrixWorkerId(),
  };

  try {
    const reports: PilotScenarioReport[] = [];

    for (const profile of args.profiles) {
      for (const size of args.sizes) {
        const scenario: PilotScenario = {
          label: `${size} заказов`,
          orderCount: size,
          vehicleType: profile,
          repeats: args.repeats,
          ...(args.seed === undefined ? {} : { seed: args.seed }),
        };

        const day =
          snapshotOrders === null
            ? buildSyntheticDay({
                orderCount: size,
                vehicleType: profile,
                graphSha256: config.VALHALLA_GRAPH_SHA256,
                ...(args.seed === undefined ? {} : { seed: args.seed }),
              })
            : buildDayFromSnapshotShape(
                { orders: snapshotOrders },
                {
                  orderCount: size,
                  vehicleType: profile,
                  graphSha256: config.VALHALLA_GRAPH_SHA256,
                  ...(args.seed === undefined ? {} : { seed: args.seed }),
                },
              );

        reports.push(
          await runPilotScenario(
            {
              matrix: (points, vehicleType) =>
                computeMatrix(matrixDeps, { points, profile: vehicleType }),
              solve: (request) => vroom.solve(request),
            },
            scenario,
            day,
          ),
        );
      }
    }

    const allPassed = reports.every((report) => report.gatesPassed);

    // Машиночитаемый итог — в stdout, человеческая сводка — в stderr:
    // первый уходит в файл и в документацию, вторая читается глазами.
    process.stdout.write(
      `${JSON.stringify(
        {
          format: 'flowers-logistics/logistics-pilot@1',
          maxPoints: PILOT_MAX_POINTS,
          scenarios: reports,
          allGatesPassed: allPassed,
        },
        null,
        2,
      )}\n`,
    );
    for (const report of reports) {
      process.stderr.write(`${summarize(report)}\n`);
    }

    return allPassed ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // Наружу выходит только текст нашей ошибки: адреса, координаты и тела
    // ответов внешних сервисов в вывод не попадают.
    process.stderr.write(`${error instanceof Error ? error.message : 'пилот не выполнен'}\n`);
    process.exit(2);
  });
