/**
 * Полный складской стенд: все состояния рабочего места кладовщика сразу.
 *
 * Проверять такое «по одному состоянию за раз» бесполезно. Половина ошибок
 * видна только рядом: лист без ячейки под листом с двумя, частично собранный
 * под полностью собранным, отменённая коробка среди обычного хранения. Скрипт
 * создаёт их все в одном дне.
 *
 * Состояния получаются НАСТОЯЩИМИ доменными операциями — приёмкой,
 * назначением полки, переносом, недоставкой, возвратом и отменой, — а не
 * записью полей: иначе стенд показывал бы то, чего система не умеет.
 *
 * Данные синтетические целиком: адреса, получатели, номера заказов и телефоны
 * выдуманы и ни на кого не указывают.
 *
 * Fail closed. Скрипт отказывается работать где-либо, кроме локального
 * окружения с одноразовой базой: коробки и курьеры с выдуманными данными
 * в staging или production выглядели бы настоящими.
 *
 *   npm run seed:e2e-warehouse-stand
 */

import { randomUUID } from 'node:crypto';
import { moscowToday } from '@fl/shared';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { toDateColumn } from '../modules/integrations/moysklad/delivery-date.js';
import { MOYSKLAD_IDS } from '../modules/integrations/moysklad/config.js';
import { hashSecretCode } from '../modules/auth/crypto.js';
import { receiveOrder } from '../modules/warehouse/placement.js';
import { bindRouteCell, pickOrderToRouteCell } from '../modules/warehouse/route-flow.js';
import { recordDeliveryResult } from '../modules/delivery/service.js';
import { acceptReturn, markReturning } from '../modules/returns/service.js';
import { applyCancellation } from '../modules/integrations/moysklad/cancellation.js';
import type { AuthenticatedActor } from '../modules/auth/guards.js';

/**
 * Общий PIN учётных записей стенда.
 *
 * Постоянное значение допустимо ровно потому, что скрипт fail closed:
 * в staging и production этих людей не существует.
 */
const PIN = '2468';

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
    logger.error('складской стенд создаётся только в локальном окружении');
    return 2;
  }
  const database = databaseNameOf(config.DATABASE_URL);
  if (!ALLOWED_DATABASES.includes(database)) {
    logger.error({ allowed: ALLOWED_DATABASES }, 'складской стенд — только одноразовая база');
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
    let phoneSeq = 0;

    const actorOf = (userId: string, roles: AuthenticatedActor['roles']): AuthenticatedActor =>
      ({ userId, roles, familyId: randomUUID() }) as AuthenticatedActor;

    async function seedUser(
      name: string,
      roles: ('WAREHOUSE' | 'LOGISTICIAN' | 'COURIER' | 'MANAGER')[],
      courier: boolean,
    ): Promise<{ id: string; phone: string }> {
      phoneSeq += 1;
      const phone = `+79${stamp}${String(phoneSeq).padStart(3, '0')}`;
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

    const keeper = await seedUser('Кладовщик стенда', ['WAREHOUSE'], false);
    const logistician = await seedUser('Логист стенда', ['LOGISTICIAN'], false);
    const courierOne = await seedUser('Курьер стенда один', ['COURIER'], true);
    const courierTwo = await seedUser('Курьер стенда два', ['COURIER'], true);
    const manager = await seedUser('Менеджер самовывоза стенда', ['MANAGER'], false);

    const keeperActor = actorOf(keeper.id, ['WAREHOUSE']);
    const courierOneActor = actorOf(courierOne.id, ['COURIER']);
    const adminActor = actorOf(admin.id, ['ADMIN']);

    async function seedCell(prefix: string, kind: 'STORAGE' | 'ROUTE'): Promise<string> {
      const code = `${prefix}${stamp}`;
      const cell = await db.storageCell.create({
        data: { code, normalizedCode: code, kind, createdById: admin.id },
        select: { normalizedCode: true },
      });
      return cell.normalizedCode;
    }

    const storageA = await seedCell('SA-', 'STORAGE');
    const storageB = await seedCell('SB-', 'STORAGE');
    const routeCellA = await seedCell('RA-', 'ROUTE');
    const routeCellB = await seedCell('RB-', 'ROUTE');
    const routeCellC = await seedCell('RC-', 'ROUTE');

    let orderSeq = 0;
    async function seedOrder(
      suffix: string,
      options: { assembled?: boolean; pickup?: boolean } = {},
    ): Promise<{ id: string; number: string }> {
      orderSeq += 1;
      const number = `WS-${stamp}-${suffix}`;
      const order = await db.deliveryOrder.create({
        data: {
          externalId: randomUUID(),
          externalName: number,
          externalUpdated: new Date(),
          externalStateName: 'Новый',
          deliveryDate: toDateColumn(day),
          deliveryDateRaw: `${day} 1${orderSeq % 10}:00:00.000`,
          intervalKind: 'RANGE',
          intervalStartMinute: 600 + orderSeq * 10,
          intervalEndMinute: 840 + orderSeq * 10,
          // Самовывоз опознаётся только способом доставки, и логистическая
          // область на него не распространяется.
          ...(options.pickup === true
            ? {
                address: null,
                deliveryMethodId: MOYSKLAD_IDS.deliveryMethodPickup,
                storeId: MOYSKLAD_IDS.store,
                inScope: false,
              }
            : { address: 'Москва, выдуманная улица стенда, 1', inScope: true }),
          recipient: 'Выдуманный получатель стенда',
          fulfillmentInScope: true,
          fulfillmentCompositionState: 'READY',
          fulfillmentSnapshotHash: `stand-${stamp}-${orderSeq}`,
          fulfillmentCompositionSyncedAt: new Date(),
          /*
           * Ревизия состава нужна всегда: собранный заказ обязан помнить,
           * ПО КАКОЙ ревизии он собран, иначе бланк не построить.
           */
          fulfillmentRevisions: {
            create: {
              externalUpdated: new Date(),
              snapshot: { externalId: randomUUID(), positions: [] } as never,
              snapshotHash: `stand-${stamp}-${orderSeq}`,
              changedFields: ['positions'],
              reason: 'INITIAL_IMPORT',
            },
          },
        },
        select: { id: true, fulfillmentRevisions: { select: { id: true } } },
      });

      if (options.assembled === true) {
        await db.deliveryOrder.update({
          where: { id: order.id },
          data: {
            fulfillmentProcessState: 'ASSEMBLED',
            // Собранный заказ обязан помнить исполнителя: состояние без
            // назначения база не примет, и правильно.
            fulfillmentAssigneeId: admin.id,
            fulfillmentAssignedAt: new Date(),
            fulfillmentAssembledAt: new Date(),
            fulfillmentAssembledById: admin.id,
            fulfillmentAssembledRevisionId: order.fulfillmentRevisions[0]?.id ?? null,
          },
        });
      }

      return { id: order.id, number };
    }

    async function seedRoute(
      suffix: string,
      state: 'CONFIRMED' | 'ACTIVE',
      courierUserId: string | null,
    ): Promise<{ id: string; number: string }> {
      const route = await db.deliveryRoute.create({
        data: {
          number: `МЛ-${stamp}-${suffix}`,
          deliveryDate: toDateColumn(day),
          state,
          vehicleType: 'CAR',
          createdById: admin.id,
          ...(courierUserId === null ? {} : { courierUserId }),
        },
        select: { id: true, number: true },
      });
      return route;
    }

    async function attach(routeId: string, orderId: string, position: number): Promise<string> {
      const participation = await db.routeOrder.create({
        data: { routeId, orderId, position, addedById: admin.id },
        select: { id: true },
      });
      return participation.id;
    }

    /** Приёмка настоящей операцией: та же, что и у кладовщика на экране. */
    const receive = (orderNumber: string, cellCode: string): Promise<unknown> =>
      receiveOrder(flow, keeperActor, { orderNumber, cellCode }, context);

    const report: string[] = [];

    // --- 1. Лист без ячейки: заказы ещё не дошли до склада -------------------
    const routeNoCell = await seedRoute('1', 'CONFIRMED', courierOne.id);
    const awaiting = await seedOrder('ждёт-приёмки', { assembled: true });
    const notAssembled = await seedOrder('не-собран');
    await attach(routeNoCell.id, awaiting.id, 1);
    await attach(routeNoCell.id, notAssembled.id, 2);
    report.push(`МЛ ${routeNoCell.number}: без ячейки, курьер один`);
    report.push(`заказ ${awaiting.number}: собран флористом, ждёт приёмки складом`);
    report.push(`заказ ${notAssembled.number}: ещё не собран, размещения нет`);

    // --- 2. Полностью собранный лист: обе коробки в маршрутной ячейке --------
    const routeAssembled = await seedRoute('2', 'CONFIRMED', courierOne.id);
    const readyOne = await seedOrder('готов-1', { assembled: true });
    const readyTwo = await seedOrder('готов-2', { assembled: true });
    await attach(routeAssembled.id, readyOne.id, 1);
    await attach(routeAssembled.id, readyTwo.id, 2);
    await bindRouteCell(flow, keeperActor, routeAssembled.id, { cellCode: routeCellA }, context);
    for (const order of [readyOne, readyTwo]) {
      await receive(order.number, storageA);
      await pickOrderToRouteCell(
        flow,
        keeperActor,
        routeAssembled.id,
        { orderNumber: order.number, cellCode: routeCellA },
        context,
      );
    }
    report.push(`МЛ ${routeAssembled.number}: собран целиком, ячейка ${routeCellA}, курьер один`);

    // --- 3. Частично собранный лист с ДВУМЯ ячейками -------------------------
    const routePartial = await seedRoute('3', 'CONFIRMED', courierTwo.id);
    const partialOne = await seedOrder('в-ячейке-b', { assembled: true });
    const partialTwo = await seedOrder('в-ячейке-c', { assembled: true });
    const partialStored = await seedOrder('в-хранении', { assembled: true });
    await attach(routePartial.id, partialOne.id, 1);
    await attach(routePartial.id, partialTwo.id, 2);
    await attach(routePartial.id, partialStored.id, 3);
    await bindRouteCell(flow, keeperActor, routePartial.id, { cellCode: routeCellB }, context);
    await bindRouteCell(flow, keeperActor, routePartial.id, { cellCode: routeCellC }, context);
    await receive(partialOne.number, storageA);
    await pickOrderToRouteCell(
      flow,
      keeperActor,
      routePartial.id,
      { orderNumber: partialOne.number, cellCode: routeCellB },
      context,
    );
    await receive(partialTwo.number, storageA);
    await pickOrderToRouteCell(
      flow,
      keeperActor,
      routePartial.id,
      { orderNumber: partialTwo.number, cellCode: routeCellC },
      context,
    );
    /*
     * Третья коробка лежит в обычном хранении.
     *
     * Это и есть состояние «требуется перемещение»: заказ входит
     * в действующий лист, а стоит не на его полке. Пометку ставит сама
     * приёмка, а не отдельная запись поля.
     */
    await receive(partialStored.number, storageB);
    report.push(
      `МЛ ${routePartial.number}: собран частично, ячейки ${routeCellB} и ${routeCellC}, курьер два`,
    );
    report.push(`заказ ${partialStored.number}: в хранении ${storageB}, требуется перемещение`);

    // --- 4. Лист без курьера -------------------------------------------------
    const routeNoCourier = await seedRoute('4', 'CONFIRMED', null);
    const orphan = await seedOrder('без-курьера', { assembled: true });
    await attach(routeNoCourier.id, orphan.id, 1);
    await receive(orphan.number, storageA);
    report.push(`МЛ ${routeNoCourier.number}: курьер не назначен`);

    // --- 5. Свободные складские заказы --------------------------------------
    const stored = await seedOrder('просто-в-хранении', { assembled: true });
    await receive(stored.number, storageB);
    report.push(`заказ ${stored.number}: обычное хранение ${storageB}, вне листов`);

    const cancelled = await seedOrder('отменён', { assembled: true });
    await receive(cancelled.number, storageB);
    await db.$transaction(async (tx) => {
      await applyCancellation(tx, {
        orderId: cancelled.id,
        cancelled: true,
        previous: false,
        now: new Date(),
      });
    });
    report.push(`заказ ${cancelled.number}: отменён в источнике, лежит в ${storageB}`);

    const free = await seedOrder('без-размещения', { assembled: true });
    report.push(`заказ ${free.number}: собран, на складе не числится`);

    // --- 6. Возвраты: обязательство у курьера и уже принятый -----------------
    const routeReturns = await seedRoute('5', 'ACTIVE', courierOne.id);
    const returning = await seedOrder('везут-назад');
    const returned = await seedOrder('возврат-принят');
    const returningParticipation = await attach(routeReturns.id, returning.id, 1);
    const returnedParticipation = await attach(routeReturns.id, returned.id, 2);
    const reason = await db.deliveryFailureReason.findFirstOrThrow({
      where: { code: 'NO_ANSWER' },
      select: { id: true },
    });
    await recordDeliveryResult(
      { db },
      courierOneActor,
      returningParticipation,
      { outcome: 'NOT_DELIVERED', reasonId: reason.id },
      context,
    );
    await markReturning({ db }, courierOneActor, returning.id);
    await recordDeliveryResult(
      { db },
      courierOneActor,
      returnedParticipation,
      { outcome: 'NOT_DELIVERED', reasonId: reason.id },
      context,
    );
    await acceptReturn(
      { db },
      adminActor,
      { orderNumber: returned.number, cellCode: storageB },
      context,
    );
    report.push(`заказ ${returning.number}: букет у курьера один, обязательство возврата открыто`);
    report.push(`заказ ${returned.number}: возврат принят складом в ${storageB}`);

    // --- 7. Самовывоз для проверки realtime ----------------------------------
    const pickup = await seedOrder('самовывоз', { assembled: true, pickup: true });
    report.push(`заказ ${pickup.number}: самовывоз, размещения нет — появится у менеджера`);

    /*
     * Именованные строки: их читает и человек, и браузерная проверка.
     *
     * Порядок «заказ 1, заказ 2» менялся бы вместе со сценарием, и проверка
     * молча брала бы не тот заказ.
     */
    const lines: [string, string][] = [
      ['кладовщик', keeper.phone],
      ['логист', logistician.phone],
      ['курьер один', courierOne.phone],
      ['курьер два', courierTwo.phone],
      ['менеджер', manager.phone],
      ['пин', PIN],
      ['ячейка хранения A', storageA],
      ['ячейка хранения B', storageB],
      ['маршрутная ячейка A', routeCellA],
      ['маршрутная ячейка B', routeCellB],
      ['маршрутная ячейка C', routeCellC],
      ['мл без ячейки', routeNoCell.number],
      ['мл собран', routeAssembled.number],
      ['мл частично', routePartial.number],
      ['мл без курьера', routeNoCourier.number],
      ['мл возвратов', routeReturns.number],
      ['заказ ждёт приёмки', awaiting.number],
      ['заказ не собран', notAssembled.number],
      ['заказ готов 1', readyOne.number],
      ['заказ готов 2', readyTwo.number],
      ['заказ в ячейке B', partialOne.number],
      ['заказ в ячейке C', partialTwo.number],
      ['заказ требует перемещения', partialStored.number],
      ['заказ без курьера', orphan.number],
      ['заказ в хранении', stored.number],
      ['заказ отменён', cancelled.number],
      ['заказ без размещения', free.number],
      ['заказ возвращается', returning.number],
      ['заказ возврат принят', returned.number],
      ['заказ самовывоза', pickup.number],
    ];
    for (const [key, value] of lines) {
      process.stdout.write(`${key}: ${value}\n`);
    }
    for (const line of report) {
      process.stdout.write(`описание: ${line}\n`);
    }

    logger.info({ stamp }, 'складской стенд создан');
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      'не удалось создать складской стенд:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
