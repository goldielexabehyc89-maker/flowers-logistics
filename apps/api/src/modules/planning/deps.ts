/**
 * Сборка зависимостей планирования.
 *
 * Одна фабрика на два потребителя: HTTP-слой (постановка, превью, применение)
 * и фоновый исполнитель (расчёт). Разные наборы зависимостей разошлись бы:
 * один считал бы по одному графу, другой — по другому, и объяснить разницу
 * было бы нечем.
 *
 * Клиенты создаются без единого сетевого обращения: адрес запоминается,
 * запрос выполняется только при вызове. Поэтому фабрику можно звать и там,
 * где расчёт никогда не понадобится.
 */

import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import type { AppLogger } from '../../platform/logging/logger.js';
import { ValhallaClient } from '../integrations/valhalla/client.js';
import { VroomClient } from '../integrations/vroom/client.js';
import { createGraphGate } from '../geo/routing-status.js';
import { newMatrixWorkerId, type MatrixDeps } from '../geo/matrix/service.js';
import { createSolverGate } from './solver-status.js';
import { newPlanningWorkerId, type PlanningDeps } from './service.js';
import { testMatrix, testSolver } from './test-solver.js';

/** Содержимое подменного графа и версия подменного решателя. */
const TEST_GRAPH_SHA256 = 'e2e'.padEnd(64, '0');
const TEST_SOLVER_VERSION = '0.0.0-test';

export interface PlanningDepsOptions {
  db: Database;
  config: AppConfig;
  logger: AppLogger;
  /** Владелец аренды расчёта. Задаётся исполнителем; HTTP-слой аренд не берёт. */
  workerId?: string;
}

export function createPlanningDeps(options: PlanningDepsOptions): PlanningDeps {
  const { db, config, logger } = options;

  /*
   * Проверочное окружение: внешние сервисы подменяются, путь приложения нет.
   *
   * Браузерная приёмка обязана идти через настоящий серверный контракт —
   * постановку, ожидание, превью и применение. Подменяются ровно два внешних
   * сервиса, у которых в проверке нет ни графа, ни контейнера. Конфигурация
   * не позволяет включить это вне локального окружения.
   */
  if (config.PLANNING_TEST_SOLVER) {
    const matrixStub = testMatrix();
    return {
      db,
      logger,
      matrix: {
        db,
        logger,
        valhalla: matrixStub,
        // Содержимое графа подделывается вместе с ним: настоящего графа нет,
        // и снимок результата обязан честно ссылаться на ту же подделку.
        graphSha256: config.VALHALLA_GRAPH_SHA256 ?? TEST_GRAPH_SHA256,
        maxPoints: config.MATRIX_MAX_POINTS,
        ttlSeconds: config.MATRIX_CACHE_TTL_SECONDS,
        workerId: newMatrixWorkerId(),
      },
      vroom: testSolver(),
      // Пробная задача проверяет живой образ решателя, которого здесь нет.
      verifySolver: async () => undefined,
      solverVersion: config.VROOM_VERSION ?? TEST_SOLVER_VERSION,
      workerId: options.workerId ?? newPlanningWorkerId(),
    };
  }

  const valhalla = new ValhallaClient({ baseUrl: config.VALHALLA_URL ?? null });
  const graphGate = createGraphGate({
    db,
    client: valhalla,
    expectedGraphSha256: config.VALHALLA_GRAPH_SHA256 ?? null,
  });

  const matrix: MatrixDeps = {
    db,
    logger,
    valhalla: {
      matrix: (points, costing) => valhalla.matrix(points, costing as 'auto' | 'pedestrian'),
      verifyGraph: graphGate.verifyGraph,
    },
    graphSha256: config.VALHALLA_GRAPH_SHA256 ?? null,
    maxPoints: config.MATRIX_MAX_POINTS,
    ttlSeconds: config.MATRIX_CACHE_TTL_SECONDS,
    workerId: newMatrixWorkerId(),
  };

  const vroom = new VroomClient({ baseUrl: config.VROOM_URL ?? null });
  const solverGate = createSolverGate({
    db,
    client: vroom,
    declaredVersion: config.VROOM_VERSION ?? null,
  });

  return {
    db,
    logger,
    matrix,
    vroom,
    verifySolver: solverGate.verifySolver,
    solverVersion: config.VROOM_VERSION ?? null,
    workerId: options.workerId ?? newPlanningWorkerId(),
  };
}
