/**
 * Заказ, прошедший ПОЛНЫЙ жизненный цикл, — для экрана «История заказа».
 *
 * Проверять историю на заказе, у которого случились два события, бессмысленно:
 * ошибки агрегации видны только там, где рядом лежат импорт, правка адреса,
 * работа флориста, две печати, склад, маршрутный лист, комплектование,
 * недоставка, возврат и решение логиста.
 *
 * Состояния получаются НАСТОЯЩИМИ доменными операциями, а не записью полей.
 * Это принципиально: история читает те же таблицы, что пишут сервисы, и
 * фикстура, набитая руками, показывала бы то, чего система не умеет.
 *
 * Fail closed. Скрипт отказывается работать где-либо, кроме локального
 * окружения с одноразовой базой.
 *
 *   npm run seed:e2e-order-history
 */

import { randomUUID } from 'node:crypto';
import { moscowToday } from '@fl/shared';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { toDateColumn } from '../modules/integrations/moysklad/delivery-date.js';
import { hashSecretCode } from '../modules/auth/crypto.js';
import { snapshotHash, type FulfillmentSnapshot } from '../modules/fulfillment/composition.js';
import { setLocalAddress } from '../modules/orders/address-service.js';
import { setManualInterval } from '../modules/orders/service.js';
import { startShift } from '../modules/fulfillment/shifts.js';
import { assembleOrder, claimOrder } from '../modules/fulfillment/assembly.js';
import { markPrinted, retryPrint } from '../modules/fulfillment/print.js';
import { receiveOrder } from '../modules/warehouse/placement.js';
import {
  bindRouteCell,
  checkOrderForIssue,
  confirmCourier,
  pickOrderToRouteCell,
  shipRoute,
} from '../modules/warehouse/route-flow.js';
import { addOrders, createEmptyDraft, setCourier } from '../modules/routing/service.js';
import { confirmRoute } from '../modules/routing/lifecycle.js';
import { recordDeliveryResult } from '../modules/delivery/service.js';
import {
  acceptReturn,
  decideRedeliverSameBouquet,
  markReturning,
} from '../modules/returns/service.js';
import type { AuthenticatedActor } from '../modules/auth/guards.js';

/** PIN-коды стенда. Допустимы ровно потому, что скрипт fail closed. */
const FLORIST_PIN = '3517';
const KEEPER_PIN = '3518';
const COURIER_PIN = '3519';

const ALLOWED_DATABASES = ['fl_e2e', 'fl_ci', 'fl_test'];

function databaseNameOf(connectionString: string): string {
  try {
    return new URL(connectionString).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

function actorOf(userId: string, roles: AuthenticatedActor['roles']): AuthenticatedActor {
  return { userId, roles, familyId: randomUUID() } as AuthenticatedActor;
}

async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);

  if (config.APP_ENV !== 'local' || config.APP_ENVIRONMENT_MARKER !== 'local') {
    logger.error('фикстура истории создаётся только в локальном окружении');
    return 2;
  }
  const database = databaseNameOf(config.DATABASE_URL);
  if (!ALLOWED_DATABASES.includes(database)) {
    logger.error({ allowed: ALLOWED_DATABASES }, 'фикстура истории — только одноразовая база');
    return 2;
  }

  const db = createDatabase(config, logger);
  const deps = { db, config };
  const context = { ip: null, userAgent: null };

  try {
    const admin = await db.user.findFirstOrThrow({
      where: { roles: { some: { role: 'ADMIN' } } },
      select: { id: true },
    });
    const adminActor = actorOf(admin.id, ['ADMIN']);

    const stamp = String(Date.now() % 1_000_000).padStart(6, '0');
    const day = moscowToday(new Date());

    async function person(
      fullName: string,
      role: 'FLORIST' | 'WAREHOUSE' | 'COURIER',
      pin: string,
      suffix: string,
    ): Promise<{ id: string; phone: string }> {
      const phone = `+79${stamp}${suffix}`;
      const created = await db.user.create({
        data: {
          phone,
          fullName,
          status: 'ACTIVE',
          pinHash: await hashSecretCode(pin, config.AUTH_PIN_PEPPER),
          roles: { create: [{ role }] },
          ...(role === 'COURIER' ? { courierProfile: { create: {} } } : {}),
        },
        select: { id: true, phone: true },
      });
      return created;
    }

    const florist = await person('Флорист истории', 'FLORIST', FLORIST_PIN, '01');
    const keeper = await person('Кладовщик истории', 'WAREHOUSE', KEEPER_PIN, '02');
    const courier = await person('Курьер истории', 'COURIER', COURIER_PIN, '03');
    const floristActor = actorOf(florist.id, ['FLORIST']);
    const keeperActor = actorOf(keeper.id, ['WAREHOUSE']);
    const courierActor = actorOf(courier.id, ['COURIER']);

    // 1. Импорт заказа: состав подтверждён, значит он виден флористу.
    const number = `OH-${stamp}`;
    const composition: FulfillmentSnapshot = {
      externalId: randomUUID(),
      description: 'Собрать в крафт',
      cardText: 'С днём рождения!',
      positions: [
        {
          externalPositionId: randomUUID(),
          ordinal: 0,
          assortmentId: randomUUID(),
          assortmentKind: 'BUNDLE',
          assortmentKindRaw: 'bundle',
          name: 'Букет «История»',
          quantity: '1',
          uomId: null,
          uomName: null,
          characteristicLabel: null,
          components: [
            {
              externalComponentId: randomUUID(),
              ordinal: 0,
              assortmentId: randomUUID(),
              assortmentKind: 'PRODUCT',
              assortmentKindRaw: 'product',
              name: 'Роза красная',
              quantity: '11',
              uomId: null,
              uomName: null,
            },
          ],
        },
      ],
    };

    const order = await db.deliveryOrder.create({
      data: {
        externalId: composition.externalId,
        externalName: number,
        externalUpdated: new Date(),
        externalStateName: 'Новый',
        deliveryDate: toDateColumn(day),
        deliveryDateRaw: `${day} 12:00:00.000`,
        intervalKind: 'RANGE',
        intervalStartMinute: 600,
        intervalEndMinute: 840,
        address: 'Москва, Тверская улица, 1',
        recipient: 'Проверочный получатель',
        comment: 'Позвонить за час',
        inScope: true,
        // Точка нужна, чтобы заказ был пригоден для маршрута.
        geoState: 'RESOLVED',
        geoSource: 'MANUAL',
        geoPrecision: 'EXACT_HOUSE',
        geoLatMicro: 55_757_997,
        geoLonMicro: 37_614_069,
        geoResolvedAt: new Date(),
        fulfillmentInScope: true,
        fulfillmentDescription: composition.description,
        fulfillmentCardText: composition.cardText,
        fulfillmentSnapshotHash: snapshotHash(composition),
        fulfillmentCompositionState: 'READY',
        fulfillmentCompositionSyncedAt: new Date(),
        fulfillmentPositions: {
          create: composition.positions.map((position) => ({
            externalPositionId: position.externalPositionId,
            ordinal: position.ordinal,
            assortmentId: position.assortmentId,
            assortmentKind: position.assortmentKind,
            assortmentKindRaw: position.assortmentKindRaw,
            name: position.name,
            quantity: position.quantity,
            characteristicLabel: position.characteristicLabel,
            components: {
              create: position.components.map((component) => ({
                externalComponentId: component.externalComponentId,
                ordinal: component.ordinal,
                assortmentId: component.assortmentId,
                assortmentKind: component.assortmentKind,
                assortmentKindRaw: component.assortmentKindRaw,
                name: component.name,
                quantity: component.quantity,
              })),
            },
          })),
        },
        revisions: {
          create: {
            externalUpdated: new Date(),
            snapshot: composition as never,
            snapshotHash: snapshotHash(composition),
            changedFields: ['externalId', 'address', 'deliveryDate', 'positions'],
            reason: 'INITIAL_IMPORT',
          },
        },
        fulfillmentRevisions: {
          create: {
            externalUpdated: new Date(),
            snapshot: composition as never,
            snapshotHash: snapshotHash(composition),
            changedFields: ['externalId', 'description', 'cardText', 'positions'],
            reason: 'INITIAL_IMPORT',
          },
        },
      },
      select: { id: true, version: true },
    });

    // Обновление источника: изменилось отслеживаемое поле.
    await db.deliveryOrderRevision.create({
      data: {
        orderId: order.id,
        externalUpdated: new Date(),
        snapshot: composition as never,
        snapshotHash: `${snapshotHash(composition)}-2`,
        changedFields: ['comment'],
        reason: 'EXTERNAL_UPDATE',
      },
    });

    // 2. Логист правит адрес и интервал.
    await setLocalAddress(
      deps,
      adminActor,
      order.id,
      { address: 'Москва, Тверская улица, 1, подъезд 2' },
      context,
    );
    const afterAddress = await db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { version: true },
    });
    await setManualInterval(
      deps,
      adminActor,
      {
        orderId: order.id,
        startMinute: 660,
        endMinute: 780,
        version: afterAddress.version,
      },
      context,
    );

    // 3. Флорист: смена, захват, печать, повторная печать, «Собран».
    await startShift(db, floristActor, context);
    const claimed = await claimOrder(db, floristActor, order.id, context);
    const assembled = await assembleOrder(
      db,
      floristActor,
      { orderId: order.id, expectedProcessVersion: claimed.processVersion },
      context,
    );
    await markPrinted(db, floristActor, assembled.printJobId, context);
    // Повторная печать — отдельное задание и отдельная строка истории.
    const retried = await retryPrint(db, floristActor, assembled.printJobId, context);
    await markPrinted(db, floristActor, retried.id, context);

    // 4. Склад: приёмка в хранение.
    const storageCell = await db.storageCell.create({
      data: {
        code: `HS-${stamp}`,
        normalizedCode: `HS-${stamp}`,
        kind: 'STORAGE',
        createdById: admin.id,
      },
      select: { normalizedCode: true },
    });
    await receiveOrder(
      deps,
      keeperActor,
      { orderNumber: number, cellCode: storageCell.normalizedCode },
      context,
    );

    // 5. Логистика: черновик, заказ, курьер, подтверждение.
    const draft = await createEmptyDraft(
      deps,
      adminActor,
      { deliveryDate: day, vehicleType: 'CAR', creationKey: randomUUID() },
      context,
    );
    const added = await addOrders(
      deps,
      adminActor,
      draft.id,
      { orderIds: [order.id], expectedVersion: draft.version },
      context,
    );
    const withCourier = await setCourier(
      deps,
      adminActor,
      draft.id,
      { courierUserId: courier.id, expectedVersion: added.version },
      context,
    );
    await confirmRoute(
      deps,
      adminActor,
      draft.id,
      { expectedVersion: withCourier.version },
      context,
    );

    // 6. Склад: маршрутная ячейка, перенос коробки, комплектование, отгрузка.
    const routeCell = await db.storageCell.create({
      data: {
        code: `HR-${stamp}`,
        normalizedCode: `HR-${stamp}`,
        kind: 'ROUTE',
        createdById: admin.id,
      },
      select: { normalizedCode: true },
    });
    await bindRouteCell(
      deps,
      keeperActor,
      draft.id,
      { cellCode: routeCell.normalizedCode },
      context,
    );
    await pickOrderToRouteCell(
      deps,
      keeperActor,
      draft.id,
      { orderNumber: number, cellCode: routeCell.normalizedCode },
      context,
    );
    await confirmCourier(deps, keeperActor, draft.id, { courierUserId: courier.id }, context);
    await checkOrderForIssue(deps, keeperActor, draft.id, { orderNumber: number }, context);
    await shipRoute(deps, keeperActor, draft.id, context);

    // 7. Курьер: недоставка с причиной.
    const participation = await db.routeOrder.findFirstOrThrow({
      where: { orderId: order.id, removedAt: null },
      select: { id: true },
    });
    const reason = await db.deliveryFailureReason.findFirstOrThrow({
      where: { code: 'NO_ANSWER' },
      select: { id: true },
    });
    await recordDeliveryResult(
      deps,
      courierActor,
      participation.id,
      { outcome: 'NOT_DELIVERED', reasonId: reason.id },
      context,
    );

    // 8. Возврат: курьер везёт, склад принимает.
    await markReturning(deps, courierActor, order.id);
    await acceptReturn(
      deps,
      keeperActor,
      { orderNumber: number, cellCode: storageCell.normalizedCode },
      context,
    );

    // 9. Логист: решение «везём тот же букет».
    const resolution = await db.orderResolution.findFirstOrThrow({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    await decideRedeliverSameBouquet(deps, adminActor, resolution.id, context);

    // Значения нужны браузерному сценарию и ручной приёмке.
    process.stdout.write(`заказ истории: ${number}\n`);
    process.stdout.write(`идентификатор истории: ${order.id}\n`);
    process.stdout.write(`флорист истории: ${florist.phone}\n`);
    process.stdout.write(`пин флориста истории: ${FLORIST_PIN}\n`);
    process.stdout.write(`кладовщик истории: ${keeper.phone}\n`);
    process.stdout.write(`пин кладовщика истории: ${KEEPER_PIN}\n`);
    process.stdout.write(`курьер истории: ${courier.phone}\n`);
    process.stdout.write(`пин курьера истории: ${COURIER_PIN}\n`);
    process.stdout.write(`ячейка хранения истории: ${storageCell.normalizedCode}\n`);
    process.stdout.write(`маршрутная ячейка истории: ${routeCell.normalizedCode}\n`);
    process.stdout.write(`маршрут истории: ${draft.number}\n`);

    logger.info({ number }, 'фикстура истории заказа создана');
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      'не удалось создать фикстуру истории заказа:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
