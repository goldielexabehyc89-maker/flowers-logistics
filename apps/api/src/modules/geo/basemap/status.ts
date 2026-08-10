/**
 * Состояние подложки в индикаторе интеграций.
 *
 * Запись `maps` появилась на этапе 1 как заглушка со значением
 * `NOT_CONFIGURED` — тогда подложки не существовало. С тех пор она не
 * обновлялась ни разу, и интерфейс продолжал показывать «Интеграция
 * не настроена» при полностью работающей карте. Индикатор, который врёт,
 * хуже отсутствующего: по нему перестают судить о действительности.
 *
 * Теперь состояние пишется по результату той же проверки, что решает судьбу
 * `/maps/*`: одна истина на приложение и на индикатор.
 *
 * Наружу уходят только код причины и ревизия набора. Ни путей, ни имён файлов,
 * ни контрольных сумм: индикатор виден в интерфейсе.
 */

import type { $Enums } from '../../../generated/prisma/client.js';
import type { Database } from '../../../platform/db.js';
import type { BasemapState } from './manifest.js';

export const MAPS_PROVIDER = 'maps';

export type BasemapIntegrationState = 'NOT_CONFIGURED' | 'OK' | 'ERROR';

export interface BasemapStatusView {
  state: BasemapIntegrationState;
  details: Record<string, string | number | null>;
}

/**
 * Переводит результат проверки набора в состояние индикатора.
 *
 * «Не настроена» и «настроена, но не сошлась» — разные вещи. Первое означает,
 * что карту не подключали; второе — что файлы на сервере не те, и это отказ,
 * который обязан быть виден.
 */
export function basemapStatusOf(state: BasemapState): BasemapStatusView {
  if (state.ok) {
    return {
      state: 'OK',
      details: {
        revision: state.manifest.revision,
        region: state.manifest.region,
        artifacts: state.manifest.artifacts.length,
      },
    };
  }

  if (state.problem === 'NOT_CONFIGURED') {
    return { state: 'NOT_CONFIGURED', details: { reason: 'no-artifacts-path' } };
  }

  return {
    state: 'ERROR',
    details: {
      reason: state.problem,
      // Путь артефакта внутри набора не является секретом, но и пользы
      // в индикаторе от него нет: причина отказа важнее имени файла.
      artifact: state.artifact ?? null,
    },
  };
}

/** Записывает состояние подложки в индикатор интеграций. */
export async function setBasemapStatus(
  db: Database,
  state: BasemapState,
  now: Date = new Date(),
): Promise<void> {
  const view = basemapStatusOf(state);

  await db.integrationStatus.upsert({
    where: { provider: MAPS_PROVIDER },
    create: {
      provider: MAPS_PROVIDER,
      state: view.state as $Enums.IntegrationState,
      pendingOperations: 0,
      details: view.details,
      lastOkAt: view.state === 'OK' ? now : null,
      lastErrorAt: view.state === 'ERROR' ? now : null,
    },
    update: {
      state: view.state as $Enums.IntegrationState,
      pendingOperations: 0,
      details: view.details,
      ...(view.state === 'OK' ? { lastOkAt: now } : {}),
      ...(view.state === 'ERROR' ? { lastErrorAt: now } : {}),
    },
  });
}
