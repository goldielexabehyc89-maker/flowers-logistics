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

export interface RoutingProbeResult {
  state: RoutingState;
  /** Ревизия набора тайлов, о которой сообщил сервис. */
  tilesetLastModified: number | null;
  version: string | null;
  /** Заявленная в конфигурации ревизия совпала с фактической. */
  revisionMatches: boolean | null;
}

/**
 * Проверяет маршрутизатор и сверяет ревизию графа.
 *
 * Несовпадение ревизии — это отказ, а не мелочь: конфигурация утверждает одно,
 * сервис отвечает по другим дорожным данным, и любой расчёт лёг бы в кэш
 * под чужим ключом. Считать в таком состоянии нельзя.
 */
export async function probeRouting(
  db: Database,
  client: Pick<ValhallaClient, 'configured' | 'status'>,
  expectedRevision: string | null,
  now: Date = new Date(),
): Promise<RoutingProbeResult> {
  if (!client.configured) {
    await setRoutingStatus(db, 'NOT_CONFIGURED', { reason: 'no-url' }, now);
    return {
      state: 'NOT_CONFIGURED',
      tilesetLastModified: null,
      version: null,
      revisionMatches: null,
    };
  }

  if (expectedRevision === null || expectedRevision.trim() === '') {
    await setRoutingStatus(db, 'ERROR', { reason: 'no-graph-revision' }, now);
    return { state: 'ERROR', tilesetLastModified: null, version: null, revisionMatches: null };
  }

  try {
    const status = await client.status();
    const actual = status.tilesetLastModified === null ? null : String(status.tilesetLastModified);

    // Сервис не сообщил ревизию набора тайлов — подтвердить граф нечем.
    //
    // Это не «неизвестно, но, наверное, тот же»: без подтверждения любой расчёт
    // лёг бы в кэш под ключом с заявленной ревизией, пережив смену дорожных
    // данных. Отсутствие подтверждения — такой же отказ, как несовпадение.
    if (actual === null) {
      await setRoutingStatus(
        db,
        'ERROR',
        { reason: 'graph-revision-unknown', version: status.version },
        now,
      );
      return {
        state: 'ERROR',
        tilesetLastModified: null,
        version: status.version,
        revisionMatches: null,
      };
    }

    // Ревизия из конфигурации задаётся человеком при установке графа. Сервис
    // подтверждает её своим `tileset_last_modified`; расхождение означает,
    // что установлен другой граф.
    if (actual !== expectedRevision) {
      await setRoutingStatus(
        db,
        'ERROR',
        { reason: 'graph-revision-mismatch', version: status.version },
        now,
      );
      return {
        state: 'ERROR',
        tilesetLastModified: status.tilesetLastModified,
        version: status.version,
        revisionMatches: false,
      };
    }

    await setRoutingStatus(db, 'OK', { version: status.version }, now);
    return {
      state: 'OK',
      tilesetLastModified: status.tilesetLastModified,
      version: status.version,
      revisionMatches: true,
    };
  } catch (error) {
    const code = error instanceof ValhallaError ? error.code : 'TRANSPORT_ERROR';
    await setRoutingStatus(db, 'DEGRADED', { code }, now);
    return { state: 'DEGRADED', tilesetLastModified: null, version: null, revisionMatches: null };
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
  expectedRevision: string | null;
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
      const result = await probeRouting(deps.db, deps.client, deps.expectedRevision, clock());

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
