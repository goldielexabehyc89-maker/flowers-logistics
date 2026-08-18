/**
 * Возвраты и отмены во всех состояниях сразу.
 *
 * Проверять такой контур «по одному сценарию за раз» бесполезно: половина
 * ошибок видна только рядом — когда на одном экране лежат заказ, ждущий
 * курьера, заказ, уже принятый складом, отменённый в маршрутной ячейке и
 * отменённый после доставки. Скрипт создаёт их все.
 *
 * Состояния получаются НАСТОЯЩИМИ доменными операциями, а не записью полей:
 * иначе стенд показывал бы то, чего система не умеет.
 *
 * Fail closed. Скрипт отказывается работать где-либо, кроме локального
 * окружения с одноразовой базой.
 *
 *   npm run seed:e2e-returns
 */

import { randomUUID } from 'node:crypto';
import { moscowToday } from '@fl/shared';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { toDateColumn } from '../modules/integrations/moysklad/delivery-date.js';
import { hashSecretCode } from '../modules/auth/crypto.js';
import { recordDeliveryResult } from '../modules/delivery/service.js';
import { acceptReturn, decideCancel, markReturning } from '../modules/returns/service.js';
import { applyCancellation } from '../modules/integrations/moysklad/cancellation.js';
import type { AuthenticatedActor } from '../modules/auth/guards.js';

/** PIN курьера стенда. Допустим ровно потому, что скрипт fail closed. */
const COURIER_PIN = '5678';

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
    logger.error('стендовая фикстура создаётся только в локальном окружении');
    return 2;
  }
  const database = databaseNameOf(config.DATABASE_URL);
  if (!ALLOWED_DATABASES.includes(database)) {
    logger.error({ allowed: ALLOWED_DATABASES }, 'стендовая фикстура — только одноразовая база');
    return 2;
  }

  const db = createDatabase(config, logger);
  const context = { ip: null, userAgent: null };

  try {
    const admin = await db.user.findFirstOrThrow({
      where: { roles: { some: { role: 'ADMIN' } } },
      select: { id: true },
    });
    const adminActor: AuthenticatedActor = {
      userId: admin.id,
      roles: ['ADMIN'],
      familyId: randomUUID(),
    } as AuthenticatedActor;

    const stamp = String(Date.now() % 1_000_000).padStart(6, '0');
    const day = moscowToday(new Date());

    const cell = await db.storageCell.create({
      data: {
        code: `RS-${stamp}`,
        normalizedCode: `RS-${stamp}`,
        kind: 'STORAGE',
        createdById: admin.id,
      },
      select: { normalizedCode: true },
    });
    const routeCell = await db.storageCell.create({
      data: {
        code: `RR-${stamp}`,
        normalizedCode: `RR-${stamp}`,
        kind: 'ROUTE',
        createdById: admin.id,
      },
      select: { id: true, normalizedCode: true },
    });

    const courierPhone = `+79${stamp}${String(Date.now() % 1000).padStart(3, '0')}`;
    const courier = await db.user.create({
      data: {
        phone: courierPhone,
        fullName: 'Курьер стенда возвратов',
        status: 'ACTIVE',
        pinHash: await hashSecretCode(COURIER_PIN, config.AUTH_PIN_PEPPER),
        roles: { create: [{ role: 'COURIER' }] },
        courierProfile: { create: {} },
      },
      select: { id: true },
    });
    const courierActor: AuthenticatedActor = {
      userId: courier.id,
      roles: ['COURIER'],
      familyId: randomUUID(),
    } as AuthenticatedActor;

    const route = await db.deliveryRoute.create({
      data: {
        number: `RT-${stamp}`,
        deliveryDate: toDateColumn(day),
        state: 'ACTIVE',
        vehicleType: 'CAR',
        createdById: admin.id,
        courierUserId: courier.id,
      },
      select: { id: true, number: true },
    });

    let position = 0;
    async function seedOrder(suffix: string): Promise<{ id: string; number: string }> {
      const number = `RTN-${stamp}-${suffix}`;
      const order = await db.deliveryOrder.create({
        data: {
          externalId: randomUUID(),
          externalName: number,
          externalUpdated: new Date(),
          externalStateName: 'Новый',
          deliveryDate: toDateColumn(day),
          deliveryDateRaw: `${day} 12:00:00.000`,
          address: 'Москва, проверочный адрес возврата',
          recipient: 'Проверочный получатель',
          inScope: true,
          /*
           * Точка нужна, чтобы заказ было видно на обеих картах.
           *
           * Координаты фиксированные и синтетические: это центр Москвы,
           * а не чей-то настоящий адрес.
           */
          geoState: 'RESOLVED',
          geoSource: 'MANUAL',
          geoPrecision: 'EXACT_HOUSE',
          geoLatMicro: 55_751_244,
          geoLonMicro: 37_618_423,
          geoResolvedAt: new Date(),
          // Производственная область: после пересборки заказ обязан
          // появиться в очереди флориста.
          fulfillmentInScope: true,
          fulfillmentCompositionState: 'READY',
          fulfillmentSnapshotHash: `seed-${suffix}`,
          fulfillmentCompositionSyncedAt: new Date(),
        },
        select: { id: true },
      });
      return { id: order.id, number };
    }

    /** Заказ в маршруте: без участия недоставки не бывает. */
    async function attach(orderId: string): Promise<string> {
      position += 1;
      const participation = await db.routeOrder.create({
        data: { routeId: route.id, orderId, position, addedById: admin.id },
        select: { id: true },
      });
      return participation.id;
    }

    const reason = await db.deliveryFailureReason.findFirstOrThrow({
      where: { code: 'NO_ANSWER' },
      select: { id: true },
    });

    async function fail(routeOrderId: string): Promise<void> {
      await recordDeliveryResult(
        { db },
        courierActor,
        routeOrderId,
        { outcome: 'NOT_DELIVERED', reasonId: reason.id },
        context,
      );
    }

    async function cancelInSource(orderId: string): Promise<void> {
      await db.$transaction(async (tx) => {
        await applyCancellation(tx, {
          orderId,
          cancelled: true,
          previous: false,
          now: new Date(),
        });
      });
    }

    const report: string[] = [];

    /*
     * Сначала весь состав маршрута, и только потом результаты.
     *
     * Результат последнего оставшегося заказа завершает маршрут — ровно как
     * в жизни. Если добавлять заказы по одному, второй попадал бы уже
     * в завершённый лист.
     */
    const withCourier = await seedOrder('у-курьера');
    const returning = await seedOrder('везут');
    const accepted = await seedOrder('принят');
    const cancelledByLogist = await seedOrder('отменён-логистом');
    const afterDelivery = await seedOrder('отменён-после-доставки');
    const inDraftRoute = await seedOrder('отменён-в-черновике');

    const participations = {
      withCourier: await attach(withCourier.id),
      returning: await attach(returning.id),
      accepted: await attach(accepted.id),
      cancelledByLogist: await attach(cancelledByLogist.id),
      afterDelivery: await attach(afterDelivery.id),
    };

    // 1. Букет у курьера: задача логиста открыта, повторная доставка недоступна.
    await fail(participations.withCourier);
    report.push(`заказ: ${withCourier.number} — недоставлен, букет у курьера`);

    // 2. Курьер объявил, что везёт на склад.
    await fail(participations.returning);
    await markReturning({ db }, courierActor, returning.id);
    report.push(`заказ: ${returning.number} — возвращается на склад`);

    // 3. Склад принял: заказ снова пригоден для маршрута.
    await fail(participations.accepted);
    await acceptReturn(
      { db },
      adminActor,
      { orderNumber: accepted.number, cellCode: cell.normalizedCode },
      context,
    );
    report.push(`заказ: ${accepted.number} — принят складом в ячейку ${cell.normalizedCode}`);

    // 4. Логист отменил заказ: сообщение для МоегоСклада стоит в очереди.
    await fail(participations.cancelledByLogist);
    const task = await db.orderResolution.findUniqueOrThrow({
      where: { activeKey: cancelledByLogist.id },
      select: { id: true },
    });
    await decideCancel({ db }, adminActor, task.id, context);
    await acceptReturn(
      { db },
      adminActor,
      { orderNumber: cancelledByLogist.number, cellCode: cell.normalizedCode },
      context,
    );
    report.push(
      `заказ: ${cancelledByLogist.number} — отменён логистом и принят складом («не выдавать»)`,
    );

    // 5. Свободная сделка, отменённая в МоемСкладе.
    const freeCancelled = await seedOrder('отменён-свободный');
    await cancelInSource(freeCancelled.id);
    report.push(`заказ: ${freeCancelled.number} — отменён в МоемСкладе, свободная сделка`);

    // 6. Отменён, лёжа в маршрутной ячейке: требуется перемещение.
    const inRouteCell = await seedOrder('отменён-в-маршрутной');
    await db.orderPlacement.create({
      data: {
        orderId: inRouteCell.id,
        cellId: routeCell.id,
        source: 'RECEIVED',
        placedById: admin.id,
      },
    });
    await cancelInSource(inRouteCell.id);
    report.push(
      `заказ: ${inRouteCell.number} — отменён в маршрутной ячейке ${routeCell.normalizedCode}`,
    );

    // 7. Отменён уже ПОСЛЕ доставки: задача на коррекцию.
    await recordDeliveryResult(
      { db },
      courierActor,
      participations.afterDelivery,
      { outcome: 'DELIVERED' },
      context,
    );
    await cancelInSource(afterDelivery.id);
    report.push(`заказ: ${afterDelivery.number} — отменён после доставки, нужна коррекция`);

    /*
     * 8. Отменён, находясь В ЧЕРНОВИКЕ маршрута и в сборке у флориста.
     *
     * Ровно тот случай, ради которого снятие отмены существует: заказ
     * обязан вернуться нераспределённым, а не к прежнему маршруту
     * и прежнему флористу.
     */
    const floristPhone = `+79${stamp}${String((Date.now() + 7) % 1000).padStart(3, '0')}`;
    const florist = await db.user.create({
      data: {
        phone: floristPhone,
        fullName: 'Флорист стенда возвратов',
        status: 'ACTIVE',
        pinHash: await hashSecretCode(COURIER_PIN, config.AUTH_PIN_PEPPER),
        roles: { create: [{ role: 'FLORIST' }] },
      },
      select: { id: true },
    });
    const shift = await db.floristShift.create({
      data: { userId: florist.id, startedAt: new Date(), activeKey: florist.id },
      select: { id: true },
    });
    const draft = await db.deliveryRoute.create({
      data: {
        number: `DR-${stamp}`,
        deliveryDate: toDateColumn(day),
        state: 'DRAFT',
        vehicleType: 'CAR',
        createdById: admin.id,
      },
      select: { id: true, number: true },
    });
    await db.routeOrder.create({
      data: { routeId: draft.id, orderId: inDraftRoute.id, position: 1, addedById: admin.id },
    });
    await db.deliveryOrder.update({
      where: { id: inDraftRoute.id },
      data: {
        // Производственная область и подтверждённый состав: без них заказ
        // не появился бы в очереди флориста вовсе.
        fulfillmentInScope: true,
        fulfillmentCompositionState: 'READY',
        fulfillmentSnapshotHash: 'seed-hash',
        fulfillmentCompositionSyncedAt: new Date(),
        fulfillmentProcessState: 'IN_ASSEMBLY',
        fulfillmentAssigneeId: florist.id,
        fulfillmentAssignedAt: new Date(),
        fulfillmentShiftId: shift.id,
      },
    });
    await cancelInSource(inDraftRoute.id);
    report.push(`заказ: ${inDraftRoute.number} — отменён в черновике ${draft.number} и в сборке`);

    process.stdout.write(`маршрут: ${route.number}\n`);
    process.stdout.write(`черновик: ${draft.number}\n`);
    process.stdout.write(`курьер: ${courierPhone}\n`);
    process.stdout.write(`пин курьера: ${COURIER_PIN}\n`);
    process.stdout.write(`ячейка хранения: ${cell.normalizedCode}\n`);
    process.stdout.write(`маршрутная ячейка: ${routeCell.normalizedCode}\n`);
    /*
     * Значения читает и человек, и браузерная проверка.
     *
     * Поэтому ключи именованные, а не «заказ 1, заказ 2»: порядок строк
     * менялся бы вместе со сценарием, и проверка молча брала бы не тот заказ.
     */
    process.stdout.write(`флорист: ${floristPhone}\n`);
    process.stdout.write(`пин флориста: ${COURIER_PIN}\n`);
    process.stdout.write(`у курьера: ${withCourier.number}\n`);
    process.stdout.write(`возвращается: ${returning.number}\n`);
    process.stdout.write(`принят: ${accepted.number}\n`);
    process.stdout.write(`отменён логистом: ${cancelledByLogist.number}\n`);
    process.stdout.write(`отменён свободный: ${freeCancelled.number}\n`);
    process.stdout.write(`отменён в маршрутной: ${inRouteCell.number}\n`);
    process.stdout.write(`отменён после доставки: ${afterDelivery.number}\n`);
    process.stdout.write(`отменён в черновике: ${inDraftRoute.number}\n`);
    for (const line of report) {
      process.stdout.write(`${line}\n`);
    }

    logger.info({ route: route.number }, 'стендовая фикстура возвратов создана');
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      'не удалось создать стендовую фикстуру возвратов:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
