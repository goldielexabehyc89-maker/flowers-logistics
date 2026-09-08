/**
 * Фикстура браузерной регрессии: уже выданный покупателю самовывоз не попадает
 * в рабочую очередь флориста, даже оказавшись (по прежней ошибке) в состоянии
 * NEW с изменившимся составом.
 *
 * Готовит всё серверными операциями: флорист на активной смене, ручной режим
 * раздачи (чтобы у флориста была видимая «Очередь»), один выданный заказ
 * (`OrderPickupIssue`) в NEW и один обычный свободный заказ-контроль.
 *
 * Fail closed. Только локальное окружение с одноразовой базой.
 *
 *   npm run seed:e2e-issued-pickup-guard
 */

import { randomUUID } from 'node:crypto';
import { moscowToday } from '@fl/shared';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { toDateColumn } from '../modules/integrations/moysklad/delivery-date.js';
import { MOYSKLAD_IDS } from '../modules/integrations/moysklad/config.js';
import { hashSecretCode } from '../modules/auth/crypto.js';
import { startShift } from '../modules/fulfillment/shifts.js';
import { readFloristDispatchMode, saveFloristDispatchMode } from '../modules/settings/service.js';
import type { AuthenticatedActor } from '../modules/auth/guards.js';

const PIN = '4802';
const ALLOWED_DATABASES = ['fl_e2e', 'fl_ci', 'fl_test'];

function databaseNameOf(connectionString: string): string {
  try {
    return new URL(connectionString).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);

  if (config.APP_ENV !== 'local' || config.APP_ENVIRONMENT_MARKER !== 'local') {
    logger.error('фикстура guard выдачи создаётся только в локальном окружении');
    return 2;
  }
  const database = databaseNameOf(config.DATABASE_URL);
  if (!ALLOWED_DATABASES.includes(database)) {
    logger.error({ allowed: ALLOWED_DATABASES }, 'фикстура guard выдачи — только одноразовая база');
    return 2;
  }

  const db = createDatabase(config, logger);
  const context = { ip: null, userAgent: null };
  try {
    const admin = await db.user.findFirstOrThrow({
      where: { roles: { some: { role: 'ADMIN' } } },
      select: { id: true },
    });
    const adminActor = {
      userId: admin.id,
      roles: ['ADMIN'],
      familyId: randomUUID(),
    } as AuthenticatedActor;

    const stamp = String(Date.now() % 1_000_000).padStart(6, '0');
    const day = moscowToday(new Date());

    // Ручной режим: у флориста должна быть видимая «Очередь».
    const mode = await readFloristDispatchMode(db);
    if (mode.value.auto) {
      await saveFloristDispatchMode(db, adminActor, {
        value: { auto: false },
        expectedVersion: mode.version,
        ip: null,
        userAgent: null,
      });
    }

    const floristPhone = `+79${stamp}${String(Date.now() % 1000).padStart(3, '0')}`;
    const floristUser = await db.user.create({
      data: {
        phone: floristPhone,
        fullName: 'Флорист guard выдачи',
        status: 'ACTIVE',
        pinHash: await hashSecretCode(PIN, config.AUTH_PIN_PEPPER),
        roles: { create: [{ role: 'FLORIST' }] },
      },
      select: { id: true },
    });
    const floristActor = {
      userId: floristUser.id,
      roles: ['FLORIST'],
      familyId: randomUUID(),
    } as AuthenticatedActor;
    await startShift(db, floristActor, context);

    async function seedOrder(suffix: string): Promise<{ id: string; number: string }> {
      const number = `IG-${stamp}-${suffix}`;
      const order = await db.deliveryOrder.create({
        data: {
          externalId: randomUUID(),
          externalName: number,
          externalUpdated: new Date(),
          externalStateName: 'Самовывоз',
          deliveryDate: toDateColumn(day),
          deliveryDateRaw: `${day} 12:00:00.000`,
          intervalKind: 'RANGE',
          intervalStartMinute: 720,
          intervalEndMinute: 900,
          deliveryMethodId: MOYSKLAD_IDS.deliveryMethodPickup,
          storeId: MOYSKLAD_IDS.store,
          address: null,
          recipient: 'Выдуманный получатель guard',
          inScope: false,
          fulfillmentInScope: true,
          fulfillmentProcessState: 'NEW',
          fulfillmentCompositionState: 'READY',
          fulfillmentSnapshotHash: `ig-${stamp}-${suffix}`,
          fulfillmentCompositionSyncedAt: new Date(),
          fulfillmentRevisions: {
            create: {
              externalUpdated: new Date(),
              snapshot: { externalId: randomUUID(), positions: [] } as never,
              snapshotHash: `ig-${stamp}-${suffix}`,
              changedFields: ['positions'],
              reason: 'INITIAL_IMPORT',
            },
          },
        },
        select: { id: true },
      });
      return { id: order.id, number };
    }

    // Выданный покупателю самовывоз, по ошибке оставшийся в NEW (как 145588A).
    // Контрольного «свободного» заказа НЕ создаём: он был бы обычным NEW-заказом
    // в ОБЩЕЙ свободной очереди и полез бы в соседние тесты (группа ближайших
    // самовывозов). Достаточно проверить, что выданный заказ в очереди
    // отсутствует, а экран очереди при этом рабочий.
    const issued = await seedOrder('issued');
    await db.orderPickupIssue.create({
      data: { orderId: issued.id, issuedById: admin.id },
    });

    const lines: [string, string][] = [
      ['флорист', floristPhone],
      ['пин', PIN],
      ['заказ выдан', issued.number],
    ];
    for (const [key, value] of lines) {
      process.stdout.write(`${key}: ${value}\n`);
    }

    logger.info({ stamp }, 'фикстура guard выдачи создана');
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      'не удалось создать фикстуру guard выдачи:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
