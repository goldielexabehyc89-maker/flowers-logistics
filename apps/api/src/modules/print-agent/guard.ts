/**
 * Проверка доступа обработчика печати.
 *
 * ЭТО НЕ ПОЛЬЗОВАТЕЛЬСКАЯ ОХРАНА И НЕ ЕЁ ЧАСТНЫЙ СЛУЧАЙ. Пользовательский
 * `authenticate` (`auth/guards.ts`) проверяет JWT и возвращает человека с
 * ролями. Здесь проверяется токен устройства и возвращается компьютер, у
 * которого ролей нет вовсе.
 *
 * Два контура не пересекаются ни в одну сторону, и это проверяется тестами:
 *
 *   - пользовательский JWT не является токеном устройства. Его SHA-256 просто
 *     не встретится в `PrintAgentDevice.tokenHash`; специальной проверки «а не
 *     JWT ли это» нет намеренно — она была бы вторым, расходящимся со временем
 *     описанием того же правила;
 *   - токен устройства не является пользовательским доступом. Он не JWT,
 *     подписи не несёт, и `verifyAccessToken` вернёт по нему `null`.
 *
 * Отсюда следует главное: скомпрометированный токен устройства даёт ровно
 * право печатать выданные ему задания. Ни заказов, ни пользователей, ни
 * настроек он не открывает — не потому, что маршруты это запрещают, а потому,
 * что предъявить его пользовательским маршрутам нельзя.
 */

import { AppError } from '../../platform/errors.js';
import type { Database } from '../../platform/db.js';
import { extractDeviceToken, hashDeviceToken } from './crypto.js';

/**
 * Компьютер, от имени которого пришёл запрос.
 *
 * Ролей здесь нет намеренно: у устройства их не бывает. Единственное право,
 * которое оно имеет, — печатать то, что ему выдала очередь.
 */
export interface AuthenticatedDevice {
  deviceId: string;
  name: string;
  /** Основной обработчик получает новые задания; остальные — нет. */
  isPrimary: boolean;
}

/** Минимум, который нужен охране от объекта запроса. */
export interface DeviceAuthenticatableRequest {
  headers: { authorization?: string | undefined };
}

export interface DeviceAuthDependencies {
  db: Database;
}

/**
 * Отказ всегда выглядит одинаково.
 *
 * Нет токена, токен неизвестен, устройство отозвано — снаружи это один и тот
 * же 401 с одним и тем же текстом. Различать их означало бы подсказывать, что
 * предъявленный токен когда-то существовал.
 */
function rejected(reason: string): AppError {
  return new AppError('UNAUTHENTICATED', {
    message: reason,
    publicMessage: 'Устройство не распознано.',
  });
}

/**
 * Как часто обновляется отметка «был на связи».
 *
 * Обработчик опрашивает очередь постоянно, и запись на каждый запрос была бы
 * записью ради самой записи. Пяти секунд достаточно, чтобы «в сети» в
 * настройках оставалось честным.
 */
const LAST_SEEN_THROTTLE_MS = 5_000;

/**
 * Возвращает устройство запроса либо бросает 401.
 *
 * ОТЗЫВ ДЕЙСТВУЕТ НЕМЕДЛЕННО. Состояние читается из базы при каждом запросе,
 * а не кешируется: отозванный компьютер обязан потерять доступ в тот же миг,
 * а не когда истечёт какой-нибудь срок.
 */
export async function authenticateDevice(
  request: DeviceAuthenticatableRequest,
  deps: DeviceAuthDependencies,
): Promise<AuthenticatedDevice> {
  const token = extractDeviceToken(request.headers.authorization);
  if (token === null) {
    throw rejected('device token missing');
  }

  const device = await deps.db.printAgentDevice.findUnique({
    where: { tokenHash: hashDeviceToken(token) },
    select: { id: true, name: true, state: true, primaryKey: true, lastSeenAt: true },
  });

  if (device === null) {
    throw rejected('device token unknown');
  }

  // Отозванное устройство не получает и не подтверждает задания.
  if (device.state === 'REVOKED') {
    throw rejected('device revoked');
  }

  await touchLastSeen(deps.db, device.id, device.lastSeenAt);

  return {
    deviceId: device.id,
    name: device.name,
    isPrimary: device.primaryKey !== null,
  };
}

/**
 * Отмечает связь и возвращает отключённое устройство в состояние «на связи».
 *
 * Условие в WHERE, а не проверка «до»: параллельные опросы иначе перезаписали
 * бы отметку друг друга, а отозванное устройство нельзя оживить связью —
 * `REVOKED` сюда не попадает.
 */
async function touchLastSeen(
  db: Database,
  deviceId: string,
  lastSeenAt: Date | null,
): Promise<void> {
  const now = new Date();
  if (lastSeenAt !== null && now.getTime() - lastSeenAt.getTime() < LAST_SEEN_THROTTLE_MS) {
    return;
  }

  await db.printAgentDevice.updateMany({
    where: { id: deviceId, state: { in: ['CONNECTED', 'DISCONNECTED'] } },
    data: { state: 'CONNECTED', lastSeenAt: now },
  });
}
