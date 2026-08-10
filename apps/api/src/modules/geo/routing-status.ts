/**
 * Состояние собственного маршрутизатора.
 *
 * Отдельная запись интеграции `valhalla`: подложка карты, геокодер
 * и маршрутизатор — три разных сервиса с разными видами отказа. Общая запись
 * скрывала бы отказ одного за работоспособностью другого, и дежурный видел бы
 * «всё хорошо» при неработающем расчёте.
 *
 * Недоступность маршрутизатора НЕ влияет на готовность приложения: ручные
 * маршруты — основной способ работы, а расчёт времени только ускоряет его.
 * Приложение, объявившее себя неготовым из-за необязательного сервиса,
 * было бы снято с балансировки и перестало бы работать вовсе.
 *
 * В `details` попадают только коды, версии и числа: ни адреса сервиса,
 * ни координат, ни тел ответов.
 */

import type { $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { ValhallaError, type ValhallaClient } from '../integrations/valhalla/client.js';

export const VALHALLA_PROVIDER = 'valhalla';

export type RoutingState = 'NOT_CONFIGURED' | 'CONFIGURED' | 'OK' | 'DEGRADED' | 'ERROR';

export type StatusDetails = Record<string, string | number | boolean | null>;

export async function setRoutingStatus(
  db: Database,
  state: RoutingState,
  details: StatusDetails,
  now: Date = new Date(),
): Promise<void> {
  const pending = await db.routeMatrixCache.count({ where: { status: 'PENDING' } });

  await db.integrationStatus.upsert({
    where: { provider: VALHALLA_PROVIDER },
    create: {
      provider: VALHALLA_PROVIDER,
      state: state as $Enums.IntegrationState,
      pendingOperations: pending,
      details,
      lastOkAt: state === 'OK' ? now : null,
      lastErrorAt: state === 'DEGRADED' || state === 'ERROR' ? now : null,
    },
    update: {
      state: state as $Enums.IntegrationState,
      pendingOperations: pending,
      details,
      ...(state === 'OK' ? { lastOkAt: now } : {}),
      ...(state === 'DEGRADED' || state === 'ERROR' ? { lastErrorAt: now } : {}),
    },
  });
}

/**
 * Идентичность дорожного графа — SHA-256 файла `tiles.tar`.
 *
 * Ровно 64 шестнадцатеричных символа. Проверка формата здесь не украшение:
 * прежде идентичностью считалось Unix-время изменения файла, и без явного
 * ограничения такое значение снова оказалось бы в ключе кэша, различая
 * одинаковые графы и не различая разные.
 */
export const GRAPH_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function isGraphSha256(value: string | null): value is string {
  return value !== null && GRAPH_SHA256_PATTERN.test(value.trim());
}

export interface RoutingProbeResult {
  state: RoutingState;
  /**
   * Метка времени набора тайлов из `/status`.
   *
   * ДИАГНОСТИКА. Признак того, что сервис прочитал набор, и ничего больше.
   * С идентичностью графа не сравнивается и в ключ кэша не входит: это время
   * файла, которое меняется от копирования и не меняется от подмены
   * содержимого.
   */
  tilesetLastModified: number | null;
  version: string | null;
  /** Идентичность графа, под которой работает приложение. */
  graphSha256: string | null;
}

/**
 * Проверяет готовность маршрутизатора.
 *
 * Что именно установлено, доказывается не здесь: содержимое `tiles.tar`
 * пересчитывается и сводится с манифестом и конфигурацией при выкатке, до того
 * как сервис вообще запускается. Приложению остаётся выяснить то, чего файл
 * на диске не говорит, — сервис отвечает и набор загружен.
 *
 * Сравнения `tileset_last_modified` с идентичностью графа здесь нет и быть
 * не может. Такое сравнение останавливало исправную выкатку после обычного
 * копирования набора и при этом пропустило бы подменённый файл с сохранённым
 * временем.
 */
export async function probeRouting(
  db: Database,
  client: Pick<ValhallaClient, 'configured' | 'status'>,
  expectedGraphSha256: string | null,
  now: Date = new Date(),
): Promise<RoutingProbeResult> {
  if (!client.configured) {
    await setRoutingStatus(db, 'NOT_CONFIGURED', { reason: 'no-url' }, now);
    return {
      state: 'NOT_CONFIGURED',
      tilesetLastModified: null,
      version: null,
      graphSha256: null,
    };
  }

  // Некорректная идентичность — отказ до любого сетевого запроса: результат
  // расчёта было бы некуда отнести, а ключ кэша получился бы бессмысленным.
  if (!isGraphSha256(expectedGraphSha256)) {
    await setRoutingStatus(db, 'ERROR', { reason: 'graph-sha-invalid' }, now);
    return { state: 'ERROR', tilesetLastModified: null, version: null, graphSha256: null };
  }

  const graphSha256 = expectedGraphSha256.trim();

  try {
    const status = await client.status();

    // Набор не загружен: сервис поднялся, но тайлов у него нет. Считать в таком
    // состоянии нельзя — это отказ готовности, а не отсутствие диагностики.
    if (status.tilesetLastModified === null) {
      await setRoutingStatus(
        db,
        'ERROR',
        { reason: 'tileset-not-loaded', version: status.version, graphSha256 },
        now,
      );
      return {
        state: 'ERROR',
        tilesetLastModified: null,
        version: status.version,
        graphSha256,
      };
    }

    // Поле есть не во всех сборках сервиса. Если оно есть, явное «тайлов нет»
    // — прямой отказ, а не повод довериться остальным полям.
    if (status.hasTiles === false) {
      await setRoutingStatus(
        db,
        'ERROR',
        { reason: 'tiles-unavailable', version: status.version, graphSha256 },
        now,
      );
      return {
        state: 'ERROR',
        tilesetLastModified: status.tilesetLastModified,
        version: status.version,
        graphSha256,
      };
    }

    await setRoutingStatus(
      db,
      'OK',
      {
        version: status.version,
        graphSha256,
        // Только для дежурного: по этому числу видно, когда набор появился
        // на диске. Решений оно не принимает.
        tilesetLastModified: status.tilesetLastModified,
      },
      now,
    );
    return {
      state: 'OK',
      tilesetLastModified: status.tilesetLastModified,
      version: status.version,
      graphSha256,
    };
  } catch (error) {
    const code = error instanceof ValhallaError ? error.code : 'TRANSPORT_ERROR';
    await setRoutingStatus(db, 'DEGRADED', { code }, now);
    return { state: 'DEGRADED', tilesetLastModified: null, version: null, graphSha256 };
  }
}

/**
 * Ворота расчёта.
 *
 * `computeMatrix` обязан вызвать `verifyGraph()` перед любой работой. Здесь
 * проверка выполняется один раз на процесс и запоминается: подтверждать граф
 * на каждую матрицу значило бы добавлять сетевой запрос к каждому расчёту.
 *
 * Неудача НЕ запоминается: следующий вызов попробует снова, потому что граф
 * могли поставить правильно, пока приложение работало.
 */
export function createGraphGate(deps: {
  db: Database;
  client: Pick<ValhallaClient, 'configured' | 'status'>;
  expectedGraphSha256: string | null;
  now?: () => Date;
}): { verifyGraph: () => Promise<void>; reset: () => void } {
  let verified = false;

  return {
    reset() {
      verified = false;
    },
    async verifyGraph() {
      if (verified) {
        return;
      }

      const clock = deps.now ?? ((): Date => new Date());
      const result = await probeRouting(deps.db, deps.client, deps.expectedGraphSha256, clock());

      if (result.state !== 'OK') {
        throw new AppError('SERVICE_UNAVAILABLE', {
          message: `routing graph is not verified: ${result.state}`,
          publicMessage:
            'Расчёт времени в пути недоступен: дорожный граф не подтверждён. ' +
            'Ручные маршруты продолжают работать.',
        });
      }

      verified = true;
    },
  };
}

/** Подтверждён ли маршрутизатор прямо сейчас. Читает сохранённое состояние. */
export async function isRoutingVerified(db: Database): Promise<boolean> {
  const status = await db.integrationStatus.findUnique({
    where: { provider: VALHALLA_PROVIDER },
    select: { state: true },
  });
  return status?.state === 'OK';
}
