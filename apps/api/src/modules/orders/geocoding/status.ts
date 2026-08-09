/**
 * Состояние интеграции геокодирования.
 *
 * Отдельный provider `dadata`, а не общая запись «карты»: подложка карты
 * и геокодер — разные сервисы с разными ключами и разными видами отказа.
 * Общая запись скрывала бы отказ одного за работоспособностью другого,
 * и дежурный видел бы «всё хорошо» при неработающем геокодировании.
 *
 * В `details` попадают только коды и числа. Ни ключей, ни адресов, ни координат,
 * ни заголовков, ни тел ответов провайдера здесь нет и быть не может: запись
 * читает администратор через API, а `state` виден вообще без авторизации.
 */

import type { $Enums } from '../../../generated/prisma/client.js';
import type { Database } from '../../../platform/db.js';

export const DADATA_PROVIDER = 'dadata';

export type DadataState = 'NOT_CONFIGURED' | 'CONFIGURED' | 'OK' | 'DEGRADED' | 'ERROR';

/** Значения деталей: только безопасные примитивы. */
export type StatusDetails = Record<string, string | number | boolean | null>;

export async function setDadataStatus(
  db: Database,
  state: DadataState,
  details: StatusDetails,
  now: Date = new Date(),
): Promise<void> {
  const pending = await db.orderGeocodeJob.count({
    where: { status: { in: ['PENDING', 'PROCESSING'] } },
  });

  await db.integrationStatus.upsert({
    where: { provider: DADATA_PROVIDER },
    create: {
      provider: DADATA_PROVIDER,
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
    await setDadataStatus(db, 'NOT_CONFIGURED', { reason: 'no-keys' }, now);
    return;
  }
  if (!config.enabled) {
    await setDadataStatus(db, 'CONFIGURED', { reason: 'geocoding-disabled' }, now);
    return;
  }
  await setDadataStatus(db, 'CONFIGURED', { reason: 'starting' }, now);
}
