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

export interface PlanningDepsOptions {
  db: Database;
  config: AppConfig;
  logger: AppLogger;
  /** Владелец аренды расчёта. Задаётся исполнителем; HTTP-слой аренд не берёт. */
  workerId?: string;
}

export function createPlanningDeps(options: PlanningDepsOptions): PlanningDeps {
  const { db, config, logger } = options;

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
