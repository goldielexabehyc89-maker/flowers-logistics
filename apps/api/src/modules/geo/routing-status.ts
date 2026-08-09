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
    // Ревизия из конфигурации задаётся человеком при установке графа. Сервис
    // подтверждает её своим `tileset_last_modified`; расхождение означает,
    // что установлен другой граф.
    const matches = actual === null ? null : actual === expectedRevision;

    if (matches === false) {
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
      revisionMatches: matches,
    };
  } catch (error) {
    const code = error instanceof ValhallaError ? error.code : 'TRANSPORT_ERROR';
    await setRoutingStatus(db, 'DEGRADED', { code }, now);
    return { state: 'DEGRADED', tilesetLastModified: null, version: null, revisionMatches: null };
  }
}
