/**
 * Состояние интеграции геокодирования.
 *
 * Отдельный provider `photon`, а не общая запись «карты»: подложка карты
 * и геокодер — разные сервисы с разными видами отказа. Общая запись скрывала
 * бы отказ одного за работоспособностью другого, и дежурный видел бы
 * «всё хорошо» при неработающем геокодировании.
 *
 * Провайдер называется по тому, кто действительно геокодирует. Раньше здесь
 * стояло имя DaData, и после перехода на собственный Photon это имя означало
 * бы неправду: дежурный читал бы состояние чужого сервиса вместо своего.
 *
 * В `details` попадают только коды и числа. Ни ключей, ни адресов, ни координат,
 * ни заголовков, ни тел ответов провайдера здесь нет и быть не может: запись
 * читает администратор через API, а `state` виден вообще без авторизации.
 */

import type { $Enums } from '../../../generated/prisma/client.js';
import type { Database } from '../../../platform/db.js';

export const GEOCODER_PROVIDER = 'photon';

export type GeocoderState = 'NOT_CONFIGURED' | 'CONFIGURED' | 'OK' | 'DEGRADED' | 'ERROR';

/** Значения деталей: только безопасные примитивы. */
export type StatusDetails = Record<string, string | number | boolean | null>;

export async function setGeocoderStatus(
  db: Database,
  state: GeocoderState,
  details: StatusDetails,
  now: Date = new Date(),
): Promise<void> {
  const pending = await db.orderGeocodeJob.count({
    where: { status: { in: ['PENDING', 'PROCESSING'] } },
  });

  await db.integrationStatus.upsert({
    where: { provider: GEOCODER_PROVIDER },
    create: {
      provider: GEOCODER_PROVIDER,
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
 * Отражает состояние при старте приложения.
 *
 * Настроенное, но выключенное геокодирование — это `CONFIGURED`, а не ошибка:
 * ничего не сломано, работа просто идёт вручную.
 */
export async function reportGeocodingStartupStatus(
  db: Database,
  config: { configured: boolean; enabled: boolean },
  now: Date = new Date(),
): Promise<void> {
  if (!config.configured) {
    await setGeocoderStatus(db, 'NOT_CONFIGURED', { reason: 'no-url' }, now);
    return;
  }
  if (!config.enabled) {
    await setGeocoderStatus(db, 'CONFIGURED', { reason: 'geocoding-disabled' }, now);
    return;
  }
  await setGeocoderStatus(db, 'CONFIGURED', { reason: 'starting' }, now);
}
