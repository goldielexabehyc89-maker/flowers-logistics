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
import { receiveOrder, withdrawOrder } from '../modules/warehouse/placement.js';
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
  decideCancel,
  decideReassemble,
  decideRedeliverSameBouquet,
  markReturning,
} from '../modules/returns/service.js';
import { applyCancellation } from '../modules/integrations/moysklad/cancellation.js';
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
      /*
       * Российский номер — одиннадцать цифр.
       *
       * С коротким номером пользователь заводился, но войти не мог: вход
       * нормализует телефон и такого просто не находил.
       */
      const phone = `+79${stamp}${suffix}`;
      if (phone.length !== 12) {
        throw new Error(`некорректный проверочный телефон: ${phone}`);
      }
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

    const florist = await person('Флорист истории', 'FLORIST', FLORIST_PIN, '001');
    const keeper = await person('Кладовщик истории', 'WAREHOUSE', KEEPER_PIN, '002');
    const courier = await person('Курьер истории', 'COURIER', COURIER_PIN, '003');
    const floristActor = actorOf(florist.id, ['FLORIST']);
    const keeperActor = actorOf(keeper.id, ['WAREHOUSE']);
    const courierActor = actorOf(courier.id, ['COURIER']);

    /*
     * Шаги разнесены во времени намеренно.
     *
     * Сервисы склада, флориста и заказов часов не принимают: время события —
     * это момент, когда оно действительно произошло. Поэтому между этапами
     * стоит пауза: порядок остаётся настоящим, а на экране строки перестают
     * сливаться в одну секунду. Подменять сам порядок ради вида нельзя.
     */
    const STEP_PAUSE_MS = 1200;
    const pause = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, STEP_PAUSE_MS));
    };

    let cellCounter = 0;
    async function cell(kind: 'STORAGE' | 'ROUTE'): Promise<string> {
      cellCounter += 1;
      const code = `H${kind === 'STORAGE' ? 'S' : 'R'}-${stamp}-${cellCounter}`;
      const created = await db.storageCell.create({
        data: { code, normalizedCode: code, kind, createdById: admin.id },
        select: { normalizedCode: true },
      });
      return created.normalizedCode;
    }

    function compositionFor(suffix: string): FulfillmentSnapshot {
      return {
        externalId: randomUUID(),
        description: `Собрать в крафт (${suffix})`,
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
    }

    /** Импорт заказа: своя история у каждого сценария, данные не смешиваются. */
    async function importOrder(suffix: string): Promise<{ id: string; number: string }> {
      const composition = compositionFor(suffix);
      const number = `OH-${stamp}-${suffix}`;
      const created = await db.deliveryOrder.create({
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
        select: { id: true, externalName: true },
      });
      return { id: created.id, number: created.externalName };
    }

    /** Правки логиста: адрес и интервал — с настоящими старыми значениями. */
    async function logistEdits(orderId: string): Promise<void> {
      const before = await db.deliveryOrder.findUniqueOrThrow({
        where: { id: orderId },
        select: { version: true },
      });
      await setLocalAddress(
        deps,
        adminActor,
        orderId,
        { address: 'Москва, Тверская улица, 1, подъезд 2' },
        context,
      );
      await pause();
      const afterAddress = await db.deliveryOrder.findUniqueOrThrow({
        where: { id: orderId },
        select: { version: true },
      });
      await setManualInterval(
        deps,
        adminActor,
        { orderId, startMinute: 660, endMinute: 780, version: afterAddress.version },
        context,
      );
      if (before.version === afterAddress.version) {
        throw new Error('правка адреса не изменила версию заказа');
      }
    }

    /** Круг сборки: захват, «Собран», печать и повторная печать. */
    async function floristRound(orderId: string): Promise<void> {
      const claimed = await claimOrder(db, floristActor, orderId, context);
      await pause();
      const assembled = await assembleOrder(
        db,
        floristActor,
        { orderId, expectedProcessVersion: claimed.processVersion },
        context,
      );
      await markPrinted(db, floristActor, assembled.printJobId, context);
      await pause();
      const retried = await retryPrint(db, floristActor, assembled.printJobId, context);
      await markPrinted(db, floristActor, retried.id, context);
    }

    /** Лист под ключ: черновик, курьер, подтверждение, полка и отгрузка. */
    async function routeAndShip(
      orderId: string,
      number: string,
    ): Promise<{ routeId: string; routeNumber: string; participationId: string }> {
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
        { orderIds: [orderId], expectedVersion: draft.version },
        context,
      );
      const withCourier = await setCourier(
        deps,
        adminActor,
        draft.id,
        { courierUserId: courier.id, expectedVersion: added.version },
        context,
      );
      await pause();
      await confirmRoute(
        deps,
        adminActor,
        draft.id,
        { expectedVersion: withCourier.version },
        context,
      );

      const routeCell = await cell('ROUTE');
      await bindRouteCell(deps, keeperActor, draft.id, { cellCode: routeCell }, context);
      await pause();
      await pickOrderToRouteCell(
        deps,
        keeperActor,
        draft.id,
        { orderNumber: number, cellCode: routeCell },
        context,
      );
      await confirmCourier(deps, keeperActor, draft.id, { courierUserId: courier.id }, context);
      await checkOrderForIssue(deps, keeperActor, draft.id, { orderNumber: number }, context);
      await pause();
      await shipRoute(deps, keeperActor, draft.id, context);

      const participation = await db.routeOrder.findFirstOrThrow({
        where: { orderId, routeId: draft.id },
        select: { id: true },
      });
      return { routeId: draft.id, routeNumber: draft.number, participationId: participation.id };
    }

    const failureReason = await db.deliveryFailureReason.findFirstOrThrow({
      where: { code: 'NO_ANSWER' },
      select: { id: true },
    });

    async function deliver(participationId: string): Promise<void> {
      await recordDeliveryResult(
        deps,
        courierActor,
        participationId,
        { outcome: 'DELIVERED' },
        context,
      );
    }

    async function fail(participationId: string): Promise<void> {
      await recordDeliveryResult(
        deps,
        courierActor,
        participationId,
        { outcome: 'NOT_DELIVERED', reasonId: failureReason.id },
        context,
      );
    }

    /** Возврат букета: курьер везёт, склад принимает на полку хранения. */
    async function returnToWarehouse(orderId: string, number: string): Promise<string> {
      await markReturning(deps, courierActor, orderId);
      await pause();
      const storage = await cell('STORAGE');
      await acceptReturn(deps, keeperActor, { orderNumber: number, cellCode: storage }, context);
      return storage;
    }

    async function pendingResolution(orderId: string): Promise<string> {
      const resolution = await db.orderResolution.findFirstOrThrow({
        where: { orderId, decision: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      return resolution.id;
    }

    const report: string[] = [];
    function publish(key: string, value: string): void {
      report.push(`${key}: ${value}`);
    }

    await startShift(db, floristActor, context);

    /*
     * СЦЕНАРИЙ 1. Успешная доставка.
     *
     * Самый частый исход: собрали, отгрузили, доставили. Он и должен читаться
     * в истории как прямая линия без единой пометки об отмене.
     */
    const delivered = await importOrder('DLV');
    await pause();
    await logistEdits(delivered.id);
    await pause();
    await floristRound(delivered.id);
    await pause();
    const deliveredStorage = await cell('STORAGE');
    await receiveOrder(
      deps,
      keeperActor,
      { orderNumber: delivered.number, cellCode: deliveredStorage },
      context,
    );
    await pause();
    const deliveredRoute = await routeAndShip(delivered.id, delivered.number);
    await pause();
    await deliver(deliveredRoute.participationId);
    publish('успешная доставка: заказ', delivered.number);
    publish('успешная доставка: id', delivered.id);
    publish('успешная доставка: маршрут', deliveredRoute.routeNumber);

    /*
     * СЦЕНАРИЙ 2. Повторная доставка ТЕМ ЖЕ букетом.
     *
     * Заказ не доставлен, букет вернулся на склад целым, логист решил везти
     * его снова. Пересборки нет: второй круг сборки в истории появиться не
     * должен, а вот второй маршрут и вторая выдача — обязаны.
     */
    const redelivery = await importOrder('RDL');
    await pause();
    await floristRound(redelivery.id);
    await pause();
    const redeliveryStorage = await cell('STORAGE');
    await receiveOrder(
      deps,
      keeperActor,
      { orderNumber: redelivery.number, cellCode: redeliveryStorage },
      context,
    );
    await pause();
    const redeliveryFirstRoute = await routeAndShip(redelivery.id, redelivery.number);
    await pause();
    await fail(redeliveryFirstRoute.participationId);
    await pause();
    await returnToWarehouse(redelivery.id, redelivery.number);
    await pause();
    await decideRedeliverSameBouquet(
      deps,
      adminActor,
      await pendingResolution(redelivery.id),
      context,
    );
    await pause();
    const redeliverySecondRoute = await routeAndShip(redelivery.id, redelivery.number);
    await pause();
    await deliver(redeliverySecondRoute.participationId);
    publish('повторная доставка: заказ', redelivery.number);
    publish('повторная доставка: id', redelivery.id);
    publish(
      'повторная доставка: маршруты',
      `${redeliveryFirstRoute.routeNumber}, ${redeliverySecondRoute.routeNumber}`,
    );

    /*
     * СЦЕНАРИЙ 3. Пересборка.
     *
     * Букет вернулся негодным: логист отправляет заказ на новый круг сборки.
     * В истории обязаны стоять рядом первый круг и второй — с новой печатью
     * и новой отметкой «Собран», а прежние строки никуда не деваются.
     */
    const reassembly = await importOrder('RAS');
    await pause();
    await floristRound(reassembly.id);
    await pause();
    const reassemblyStorage = await cell('STORAGE');
    await receiveOrder(
      deps,
      keeperActor,
      { orderNumber: reassembly.number, cellCode: reassemblyStorage },
      context,
    );
    await pause();
    const reassemblyFirstRoute = await routeAndShip(reassembly.id, reassembly.number);
    await pause();
    await fail(reassemblyFirstRoute.participationId);
    await pause();
    await returnToWarehouse(reassembly.id, reassembly.number);
    await pause();
    await decideReassemble(deps, adminActor, await pendingResolution(reassembly.id), context);
    await pause();
    // Коробка уходит с полки на пересборку: это отдельное складское событие.
    await withdrawOrder(
      deps,
      keeperActor,
      { orderNumber: reassembly.number, reason: 'REASSEMBLY' },
      context,
    );
    await pause();
    await floristRound(reassembly.id);
    await pause();
    const reassemblySecondStorage = await cell('STORAGE');
    await receiveOrder(
      deps,
      keeperActor,
      { orderNumber: reassembly.number, cellCode: reassemblySecondStorage },
      context,
    );
    await pause();
    const reassemblySecondRoute = await routeAndShip(reassembly.id, reassembly.number);
    publish('пересборка: заказ', reassembly.number);
    publish('пересборка: id', reassembly.id);
    publish(
      'пересборка: маршруты',
      `${reassemblyFirstRoute.routeNumber}, ${reassemblySecondRoute.routeNumber}`,
    );

    /*
     * СЦЕНАРИЙ 4. Отмена из МоегоСклада и её снятие.
     *
     * Сигнал приходит извне: тем же доменным проходом, что и импорт. Обе
     * строки обязаны остаться в истории — и отмена, и её снятие.
     */
    const sourceCancel = await importOrder('CNS');
    await pause();
    await floristRound(sourceCancel.id);
    await pause();
    await db.$transaction(async (tx) => {
      await applyCancellation(tx, {
        orderId: sourceCancel.id,
        cancelled: true,
        previous: false,
        now: new Date(),
      });
    });
    await pause();
    await db.$transaction(async (tx) => {
      await applyCancellation(tx, {
        orderId: sourceCancel.id,
        cancelled: false,
        previous: true,
        now: new Date(),
      });
    });
    publish('отмена источника: заказ', sourceCancel.number);
    publish('отмена источника: id', sourceCancel.id);

    /*
     * СЦЕНАРИЙ 5. Отмена логистом после недоставки.
     *
     * Решение принимает человек, и история обязана назвать его вместе с ролью.
     */
    const logistCancel = await importOrder('CNL');
    await pause();
    await floristRound(logistCancel.id);
    await pause();
    const logistCancelStorage = await cell('STORAGE');
    await receiveOrder(
      deps,
      keeperActor,
      { orderNumber: logistCancel.number, cellCode: logistCancelStorage },
      context,
    );
    await pause();
    const logistCancelRoute = await routeAndShip(logistCancel.id, logistCancel.number);
    await pause();
    await fail(logistCancelRoute.participationId);
    await pause();
    await decideCancel(deps, adminActor, await pendingResolution(logistCancel.id), context);
    publish('отмена логистом: заказ', logistCancel.number);
    publish('отмена логистом: id', logistCancel.id);

    /*
     * СЦЕНАРИЙ 6. Списание.
     *
     * Возврат и списание — РАЗНЫЕ события: сначала букет вернулся на склад,
     * и только потом его сняли с хранения в списание.
     */
    const writeOff = await importOrder('WOF');
    await pause();
    await floristRound(writeOff.id);
    await pause();
    const writeOffStorage = await cell('STORAGE');
    await receiveOrder(
      deps,
      keeperActor,
      { orderNumber: writeOff.number, cellCode: writeOffStorage },
      context,
    );
    await pause();
    const writeOffRoute = await routeAndShip(writeOff.id, writeOff.number);
    await pause();
    await fail(writeOffRoute.participationId);
    await pause();
    const writeOffReturnCell = await returnToWarehouse(writeOff.id, writeOff.number);
    await pause();
    await withdrawOrder(
      deps,
      keeperActor,
      { orderNumber: writeOff.number, reason: 'WRITE_OFF' },
      context,
    );
    publish('списание: заказ', writeOff.number);
    publish('списание: id', writeOff.id);
    publish('списание: ячейка возврата', writeOffReturnCell);

    // Значения нужны браузерному сценарию и ручной приёмке.
    publish('флорист истории', florist.phone);
    publish('пин флориста истории', FLORIST_PIN);
    publish('кладовщик истории', keeper.phone);
    publish('пин кладовщика истории', KEEPER_PIN);
    publish('курьер истории', courier.phone);
    publish('пин курьера истории', COURIER_PIN);
    for (const line of report) {
      process.stdout.write(`${line}\n`);
    }

    logger.info({ orders: report.length }, 'фикстуры истории заказа созданы');
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
