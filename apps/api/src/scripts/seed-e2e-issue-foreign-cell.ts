/**
 * Фикстура браузерной проверки: заказ нового листа стоит в маршрутной ячейке
 * СТАРОГО листа.
 *
 * Ровно тот случай, ради которого место коробки стало сведением, а не запретом:
 * коробку приняли и поставили на полку одного листа, а заказ переехал в другой.
 * Экран выдачи обязан показать фактическую (старую) полку, принять правильный
 * QR и дать завершить отгрузку нового листа целиком.
 *
 * Состояние получается НАСТОЯЩИМИ доменными операциями — приёмкой, назначением
 * полки, переносом на неё, — а переезд заказа в новый лист повторяет то, что
 * делает логист: участие в старом листе закрывается, в новом открывается,
 * коробка при этом не двигается.
 *
 * Fail closed. Скрипт отказывается работать где-либо, кроме локального
 * окружения с одноразовой базой.
 *
 *   npm run seed:e2e-issue-foreign-cell
 */

import { randomUUID } from 'node:crypto';
import { moscowToday } from '@fl/shared';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { toDateColumn } from '../modules/integrations/moysklad/delivery-date.js';
import { hashSecretCode } from '../modules/auth/crypto.js';
import { receiveOrder } from '../modules/warehouse/placement.js';
import { bindRouteCell, pickOrderToRouteCell } from '../modules/warehouse/route-flow.js';
import type { AuthenticatedActor } from '../modules/auth/guards.js';

const PIN = '3690';

/** Базы, где допустимо создавать проверочные данные. */
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
    logger.error('фикстура выдачи из чужой ячейки создаётся только в локальном окружении');
    return 2;
  }
  const database = databaseNameOf(config.DATABASE_URL);
  if (!ALLOWED_DATABASES.includes(database)) {
    logger.error({ allowed: ALLOWED_DATABASES }, 'фикстура — только одноразовая база');
    return 2;
  }

  const db = createDatabase(config, logger);
  const context = { ip: null, userAgent: null };
  const flow = { db };

  try {
    const admin = await db.user.findFirstOrThrow({
      where: { roles: { some: { role: 'ADMIN' } } },
      select: { id: true },
    });

    const stamp = String(Date.now() % 1_000_000).padStart(6, '0');
    const day = moscowToday(new Date());

    const actorOf = (userId: string, roles: AuthenticatedActor['roles']): AuthenticatedActor =>
      ({ userId, roles, familyId: randomUUID() }) as AuthenticatedActor;

    async function seedUser(
      name: string,
      roles: ('WAREHOUSE' | 'COURIER')[],
      courier: boolean,
    ): Promise<{ id: string; phone: string }> {
      const phone = `+79${stamp}${String(Date.now() % 1000).padStart(3, '0')}`;
      const user = await db.user.create({
        data: {
          phone,
          fullName: name,
          status: 'ACTIVE',
          pinHash: await hashSecretCode(PIN, config.AUTH_PIN_PEPPER),
          roles: { create: roles.map((role) => ({ role })) },
          ...(courier ? { courierProfile: { create: {} } } : {}),
        },
        select: { id: true },
      });
      return { id: user.id, phone };
    }

    const keeper = await seedUser('Кладовщик чужой ячейки', ['WAREHOUSE'], false);
    const courier = await seedUser('Курьер нового листа', ['COURIER'], true);
    const keeperActor = actorOf(keeper.id, ['WAREHOUSE']);

    async function seedCell(prefix: string): Promise<string> {
      const code = `${prefix}${stamp}`;
      const cell = await db.storageCell.create({
        data: { code, normalizedCode: code, kind: 'ROUTE', createdById: admin.id },
        select: { normalizedCode: true },
      });
      return cell.normalizedCode;
    }
    async function seedStorage(prefix: string): Promise<string> {
      const code = `${prefix}${stamp}`;
      const cell = await db.storageCell.create({
        data: { code, normalizedCode: code, kind: 'STORAGE', createdById: admin.id },
        select: { normalizedCode: true },
      });
      return cell.normalizedCode;
    }

    async function seedOrder(suffix: string): Promise<{ id: string; number: string }> {
      const number = `FC-${stamp}-${suffix}`;
      const order = await db.deliveryOrder.create({
        data: {
          externalId: randomUUID(),
          externalName: number,
          externalUpdated: new Date(),
          externalStateName: 'Новый',
          deliveryDate: toDateColumn(day),
          deliveryDateRaw: `${day} 12:00:00.000`,
          intervalKind: 'RANGE',
          intervalStartMinute: 720,
          intervalEndMinute: 900,
          address: 'Москва, выдуманная улица чужой ячейки, 1',
          recipient: 'Выдуманный получатель чужой ячейки',
          inScope: true,
          fulfillmentInScope: true,
          fulfillmentCompositionState: 'READY',
          fulfillmentSnapshotHash: `fc-${stamp}`,
          fulfillmentCompositionSyncedAt: new Date(),
          fulfillmentRevisions: {
            create: {
              externalUpdated: new Date(),
              snapshot: { externalId: randomUUID(), positions: [] } as never,
              snapshotHash: `fc-${stamp}`,
              changedFields: ['positions'],
              reason: 'INITIAL_IMPORT',
            },
          },
        },
        select: { id: true, fulfillmentRevisions: { select: { id: true } } },
      });
      await db.deliveryOrder.update({
        where: { id: order.id },
        data: {
          fulfillmentProcessState: 'ASSEMBLED',
          fulfillmentAssigneeId: admin.id,
          fulfillmentAssignedAt: new Date(),
          fulfillmentAssembledAt: new Date(),
          fulfillmentAssembledById: admin.id,
          fulfillmentAssembledRevisionId: order.fulfillmentRevisions[0]?.id ?? null,
        },
      });
      return { id: order.id, number };
    }

    async function seedRoute(
      suffix: string,
      courierUserId: string | null,
    ): Promise<{ id: string; number: string }> {
      return db.deliveryRoute.create({
        data: {
          number: `МЛ-FC-${stamp}-${suffix}`,
          deliveryDate: toDateColumn(day),
          state: 'CONFIRMED',
          vehicleType: 'CAR',
          createdById: admin.id,
          ...(courierUserId === null ? {} : { courierUserId }),
        },
        select: { id: true, number: true },
      });
    }

    const storage = await seedStorage('SFC-');
    const oldCell = await seedCell('ROLD-');

    // Старый лист: коробку приняли и поставили на его маршрутную полку.
    const oldSheet = await seedRoute('старый', courier.id);
    const order = await seedOrder('переехал');
    await db.routeOrder.create({
      data: { routeId: oldSheet.id, orderId: order.id, position: 1, addedById: admin.id },
    });
    await bindRouteCell(flow, keeperActor, oldSheet.id, { cellCode: oldCell }, context);
    await receiveOrder(
      flow,
      keeperActor,
      { orderNumber: order.number, cellCode: storage },
      context,
    );
    await pickOrderToRouteCell(
      flow,
      keeperActor,
      oldSheet.id,
      { orderNumber: order.number, cellCode: oldCell },
      context,
    );

    // Заказ переезжает в новый лист: участие в старом закрывается, в новом
    // открывается. Коробка не двигается — она по-прежнему в ячейке старого листа.
    const newSheet = await seedRoute('новый', courier.id);
    await db.routeOrder.updateMany({
      where: { routeId: oldSheet.id, orderId: order.id, removedAt: null },
      data: {
        removedAt: new Date(),
        removedById: admin.id,
        removalReason: 'MOVED_TO_ANOTHER_ROUTE',
        movedToRouteId: newSheet.id,
      },
    });
    await db.routeOrder.create({
      data: { routeId: newSheet.id, orderId: order.id, position: 1, addedById: admin.id },
    });

    const lines: [string, string][] = [
      ['кладовщик', keeper.phone],
      ['курьер', courier.phone],
      ['пин', PIN],
      ['мл старый', oldSheet.number],
      ['мл новый', newSheet.number],
      ['ячейка старого листа', oldCell],
      ['заказ', order.number],
    ];
    for (const [key, value] of lines) {
      process.stdout.write(`${key}: ${value}\n`);
    }

    logger.info({ stamp }, 'фикстура выдачи из чужой ячейки создана');
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      'не удалось создать фикстуру выдачи из чужой ячейки:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
