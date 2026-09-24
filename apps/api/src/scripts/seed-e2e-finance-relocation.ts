/**
 * Доставка с километрами за МКАД ПРОШЛЫМ днём — предпосылка браузерной
 * проверки переноса дня учёта при отмене заказа в источнике.
 *
 * Сценарию нужна цепочка «начисление одним днём, правка километров другим,
 * отмена третьим». Правка и отмена делаются в самом сценарии настоящими
 * входами: правкой километров логиста и сигналом источника. А вот доставку
 * прошлым днём в браузере не отметить — лист и результат живут сегодняшним
 * днём. Поэтому доставка заводится здесь, теми же доменными функциями, что и
 * боевой путь: снимок расстояния и `accrueDeliveryResult`.
 *
 * Fail closed: только локальное окружение и одноразовая база.
 *
 *   npm run seed:e2e-finance-relocation
 */

import { randomUUID } from 'node:crypto';
import { moscowToday } from '@fl/shared';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { toDateColumn } from '../modules/integrations/moysklad/delivery-date.js';
import { hashSecretCode } from '../modules/auth/crypto.js';
import { accrueDeliveryResult } from '../modules/finance/accrual.js';
import { ensureBundledRing } from '../modules/finance/mkad-bundle.js';
import { saveDistanceSnapshot } from '../modules/finance/mkad.js';
import { activateLedger, readLedgerActivation } from '../modules/finance/tariffs.js';

/** PIN курьера стенда. Допустим ровно потому, что скрипт fail closed. */
const COURIER_PIN = '2468';

const ALLOWED_DATABASES = ['fl_e2e', 'fl_ci', 'fl_test'];

/** Сколько дней назад состоялась доставка: правка и отмена придут другими днями. */
const DAYS_AGO = 10;

/** Ставки снимка маршрута: 200 ₽ за заказ, 40 ₽ за километр. */
const PER_ORDER_MINOR = 20_000n;
const PER_KM_MINOR = 4_000n;
/** Наличные заказа: 3 000 ₽. */
const ORDER_SUM_MINOR = 300_000n;
/** 12,5 км за МКАД на момент доставки: 500 ₽. */
const DISTANCE_METERS = 12_500;

function databaseNameOf(connectionString: string): string {
  try {
    return new URL(connectionString).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

/** Календарный день на `days` дней раньше указанного. */
function daysBefore(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) - days))
    .toISOString()
    .slice(0, 10);
}

async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);

  if (config.APP_ENV !== 'local' || config.APP_ENVIRONMENT_MARKER !== 'local') {
    logger.error('фикстура переноса дня учёта создаётся только в локальном окружении');
    return 2;
  }
  const database = databaseNameOf(config.DATABASE_URL);
  if (!ALLOWED_DATABASES.includes(database)) {
    logger.error({ allowed: ALLOWED_DATABASES }, 'фикстура — только для одноразовой базы');
    return 2;
  }

  const db = createDatabase(config, logger);
  try {
    const admin = await db.user.findFirst({
      where: { roles: { some: { role: 'ADMIN' } } },
      select: { id: true },
    });
    if (admin === null) {
      logger.error('нет ни одного администратора: сначала выполните bootstrap:admin');
      return 2;
    }

    const deliveryDay = daysBefore(moscowToday(new Date()), DAYS_AGO);

    /*
     * Учёт обязан покрывать день доставки: иначе начислений не будет вовсе, и
     * сценарий доказывал бы отсутствие данных. Включение — тем же доменным
     * путём с аудитом, что и у администратора.
     */
    const activation = await readLedgerActivation(db);
    if (activation.activeFrom === null || activation.activeFrom > deliveryDay) {
      await db.$transaction((tx) =>
        activateLedger(tx, {
          activeFrom: deliveryDay,
          actorUserId: admin.id,
          actorRoles: ['ADMIN'],
          ip: null,
          userAgent: null,
        }),
      );
    }

    // Кольцо МКАД из поставки: снимок расстояния и правка километров ссылаются на него.
    const ring = await ensureBundledRing(db);

    const stamp = String(Date.now() % 1_000_000).padStart(6, '0');
    const courierPhone = `+79${stamp}${String(Date.now() % 1000).padStart(3, '0')}`;
    const courier = await db.user.create({
      data: {
        phone: courierPhone,
        fullName: 'Курьер переноса учёта',
        status: 'ACTIVE',
        pinHash: await hashSecretCode(COURIER_PIN, config.AUTH_PIN_PEPPER),
        roles: { create: [{ role: 'COURIER' }] },
        courierProfile: { create: {} },
      },
      select: { id: true },
    });

    /*
     * Тариф ровно на день доставки: снимок маршрута ссылается на версию, а
     * однодневная версия не пересекается с тарифами соседних сценариев.
     */
    const tariff = await db.courierTariffVersion.create({
      data: {
        kind: 'REGULAR',
        effectiveFrom: toDateColumn(deliveryDay),
        effectiveTo: toDateColumn(deliveryDay),
        perOrderWalkMinor: PER_ORDER_MINOR,
        perOrderCarMinor: PER_ORDER_MINOR,
        perKmMinor: PER_KM_MINOR,
        createdById: admin.id,
      },
      select: { id: true },
    });

    const orderNumber = `FIN-${stamp}`;
    const order = await db.deliveryOrder.create({
      data: {
        // Внешние идентификаторы выдуманы намеренно: настоящих заказов здесь нет.
        externalId: randomUUID(),
        externalName: orderNumber,
        externalUpdated: new Date(),
        externalStateName: 'Доставляется',
        externalStateType: 'Regular',
        deliveryDate: toDateColumn(deliveryDay),
        deliveryDateRaw: `${deliveryDay} 12:00:00.000`,
        intervalRaw: 'с 12:00 по 18:00',
        intervalKind: 'RANGE',
        intervalStartMinute: 12 * 60,
        intervalEndMinute: 18 * 60,
        address: 'Москва, проверочный адрес переноса учёта',
        recipient: 'Проверочный Получатель',
        sumMinor: ORDER_SUM_MINOR,
        payedSumMinor: 0n,
        cashCollectable: true,
        cashToCollectMinor: ORDER_SUM_MINOR,
        paymentTypeName: 'Наличные/карта на ТТ',
        inScope: true,
        version: 1,
      },
      select: { id: true },
    });

    /*
     * Черновик, а не активный маршрут: начислению состояние листа безразлично
     * (оно читает только дату доставки), а экран листов показывает лишь
     * подтверждённые, отгруженные и завершённые.
     */
    const route = await db.deliveryRoute.create({
      data: {
        number: `RFIN-${stamp}`,
        deliveryDate: toDateColumn(deliveryDay),
        state: 'DRAFT',
        vehicleType: 'CAR',
        createdById: admin.id,
        courierUserId: courier.id,
      },
      select: { id: true },
    });
    const participation = await db.routeOrder.create({
      data: { routeId: route.id, orderId: order.id, position: 1, addedById: admin.id },
      select: { id: true },
    });
    await db.routeTariffSnapshot.create({
      data: {
        routeId: route.id,
        tariffVersionId: tariff.id,
        vehicleType: 'CAR',
        perOrderMinor: PER_ORDER_MINOR,
        perKmMinor: PER_KM_MINOR,
        deliveryDate: toDateColumn(deliveryDay),
      },
    });

    // Расстояние известно ДО доставки: километры начисляет сама доставка.
    await saveDistanceSnapshot(db, {
      routeOrderId: participation.id,
      ringVersionId: ring.ringVersionId,
      graphSha256: null,
      meters: DISTANCE_METERS,
      insideMkad: false,
      source: 'MANUAL',
      actorUserId: admin.id,
      reason: 'проверочные километры за МКАД',
    });

    const attempt = await db.deliveryAttempt.create({
      data: {
        routeOrderId: participation.id,
        orderId: order.id,
        routeId: route.id,
        outcome: 'DELIVERED',
        courierUserId: courier.id,
        activeKey: participation.id,
        occurredAt: new Date(`${deliveryDay}T11:00:00.000Z`),
      },
      select: { id: true },
    });

    const covering = await readLedgerActivation(db);
    await db.$transaction((tx) =>
      accrueDeliveryResult(tx, covering, {
        attemptId: attempt.id,
        routeOrderId: participation.id,
        routeId: route.id,
        orderId: order.id,
        courierUserId: courier.id,
        actorUserId: courier.id,
        outcome: 'DELIVERED',
      }),
    );

    // Начислено ровно три записи: наличные, оплата за заказ и километры.
    const accrued = await db.courierLedgerEntry.count({ where: { orderId: order.id } });
    if (accrued !== 3) {
      logger.error({ accrued }, 'доставка начислила не три записи: фикстура неполна');
      return 1;
    }

    // Значения нужны браузерному сценарию, поэтому печатаются отдельными строками.
    process.stdout.write(`курьер: ${courierPhone}\n`);
    process.stdout.write(`курьер id: ${courier.id}\n`);
    process.stdout.write(`заказ: ${orderNumber}\n`);
    process.stdout.write(`день доставки: ${deliveryDay}\n`);
    process.stdout.write(`участие: ${participation.id}\n`);

    logger.info({ order: orderNumber, deliveryDay }, 'фикстура переноса дня учёта создана');
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      'не удалось создать фикстуру переноса дня учёта:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
