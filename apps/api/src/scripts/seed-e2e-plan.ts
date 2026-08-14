/**
 * Готовое превью планирования для браузерной проверки.
 *
 * ЧЕСТНО О ГРАНИЦЕ. Скрипт НЕ считает маршруты. Настоящий расчёт требует
 * дорожного графа Valhalla — это гигабайты, которых в браузерной проверке нет
 * и быть не должно. Поэтому здесь создаётся то, что расчёт создал бы:
 * запуск в состоянии `PREVIEW` с неизменяемыми снимками входа и результата.
 *
 * Проверяется браузером именно то, что после расчёта: превью видно целиком,
 * неразмещённые заказы показаны отдельно, применение создаёт черновики.
 * Сам расчёт и контракт решателя доказываются направленными проверками
 * (`planning.critical.test.ts`, `solve.critical.test.ts`), где Valhalla
 * и VROOM подменены, а контракт проверяется по-настоящему.
 *
 * Fail closed: скрипт работает только в локальном окружении с одноразовой
 * базой. Выдуманное превью в production выглядело бы как посчитанное.
 *
 *   npm run seed:e2e-plan
 */

import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase, type Database } from '../platform/db.js';
import { toDateColumn } from '../modules/integrations/moysklad/delivery-date.js';
import { moscowToday } from '../modules/orders/routes.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  buildInputSnapshot,
  snapshotHash,
  type PlanInputSnapshot,
} from '../modules/planning/input.js';
import type { PlanResult } from '../modules/planning/solve.js';

/** Базы, где допустимо создавать проверочные данные. */
const ALLOWED_DATABASES = ['fl_e2e', 'fl_ci', 'fl_test'];

/** Смена и время обслуживания фикстуры. Браузерный сценарий знает те же числа. */
const SHIFT = { startMinute: 9 * 60, endMinute: 21 * 60 };
const SERVICE_TIME = { carMinutes: 10, footMinutes: 10 };

/** Координаты склада и точек. Значения выдуманы и в production не встречаются. */
const DEPOT = { latMicro: 55_751_244, lonMicro: 37_618_423 };
const POINTS = [
  { latMicro: 55_760_000, lonMicro: 37_600_000 },
  { latMicro: 55_770_000, lonMicro: 37_640_000 },
];

function databaseNameOf(connectionString: string): string {
  try {
    return new URL(connectionString).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

async function seedOrder(
  db: Database,
  day: string,
  index: number,
  point: { latMicro: number; lonMicro: number } | null,
): Promise<{ id: string; number: string; version: number; geoGeneration: number }> {
  const number = `E2E-PLAN-${String((Date.now() + index) % 1_000_000).padStart(6, '0')}`;

  const order = await db.deliveryOrder.create({
    data: {
      externalId: crypto.randomUUID(),
      externalName: number,
      externalUpdated: new Date(),
      externalStateName: 'Новый',
      externalStateType: 'Regular',
      deliveryDate: toDateColumn(day),
      deliveryDateRaw: `${day} 12:00:00.000`,
      intervalRaw: 'с 12:00 по 18:00',
      intervalKind: 'RANGE',
      intervalStartMinute: 12 * 60,
      intervalEndMinute: 18 * 60,
      address: `Москва, проверочный адрес планирования ${index + 1}`,
      recipient: 'Проверочный Получатель',
      sumMinor: 100000n,
      payedSumMinor: 0n,
      inScope: true,
      version: 1,
      ...(point === null
        ? {}
        : {
            geoState: 'RESOLVED' as const,
            geoSource: 'SYNTHETIC' as const,
            geoPrecision: 'EXACT_HOUSE' as const,
            geoLatMicro: point.latMicro,
            geoLonMicro: point.lonMicro,
            geoResolvedAt: new Date(),
          }),
    },
    select: { id: true, externalName: true, version: true, geoGeneration: true },
  });

  return {
    id: order.id,
    number: order.externalName,
    version: order.version,
    geoGeneration: order.geoGeneration,
  };
}

async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);

  /**
   * Создать только предпосылки: склад, настройки и заказы дня.
   *
   * Нужно браузерной проверке, которая ставит расчёт сама через настоящий API.
   */
  const withoutRun = process.argv.includes('--without-run');

  if (config.APP_ENV !== 'local' || config.APP_ENVIRONMENT_MARKER !== 'local') {
    logger.error('проверочное превью создаётся только в локальном окружении');
    return 2;
  }

  const database = databaseNameOf(config.DATABASE_URL);
  if (!ALLOWED_DATABASES.includes(database)) {
    logger.error(
      { allowed: ALLOWED_DATABASES },
      'проверочное превью создаётся только в одноразовой базе',
    );
    return 2;
  }

  const db = createDatabase(config, logger);

  try {
    const admin = await db.user.findFirst({
      where: { roles: { some: { role: 'ADMIN' } } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    if (admin === null) {
      logger.error('администратор не найден: сначала выполните bootstrap:admin');
      return 2;
    }

    // Склад. Если его ещё нет, он же становится складом по умолчанию —
    // ровно как в первом сценарии настройки.
    const existing = await db.depot.findUnique({ where: { defaultKey: 'default' } });
    const depot =
      existing ??
      (await db.depot.create({
        data: {
          name: 'Склад проверки',
          address: 'Москва, проверочный склад',
          latMicro: DEPOT.latMicro,
          lonMicro: DEPOT.lonMicro,
          defaultKey: 'default',
          createdById: admin.id,
        },
      }));

    // Настройки приводятся ровно к тем значениям, которые набирает браузерный
    // сценарий. Оставить чужие нельзя: снимок расчёта хранит использованные
    // значения, и расхождение с действующими означало бы устаревший вход —
    // применение отказало бы там, где проверяется совсем другое.
    for (const [key, value] of [
      ['planning.shift', SHIFT],
      ['planning.serviceTime', SERVICE_TIME],
    ] as const) {
      const current = await db.systemSetting.findUnique({ where: { currentKey: key } });

      if (current !== null && JSON.stringify(current.value) === JSON.stringify(value)) {
        continue;
      }

      await db.$transaction(async (tx) => {
        await tx.systemSetting.updateMany({
          where: { currentKey: key },
          data: { currentKey: null },
        });
        await tx.systemSetting.create({
          data: {
            key,
            version: (current?.version ?? 0) + 1,
            value,
            currentKey: key,
            updatedById: admin.id,
          },
        });
      });
    }

    const day = moscowToday(new Date());

    // Незавершённый запуск этого дня снимается: один день — один активный
    // расчёт, и повторный прогон фикстуры не должен упираться в собственный
    // след от прошлого запуска.
    await db.routePlanRun.updateMany({
      where: { deliveryDate: toDateColumn(day), activeDateKey: { not: null } },
      data: {
        state: 'EXPIRED',
        activeDateKey: null,
        lockedUntil: null,
        lockedBy: null,
        failureCode: 'SEED_REPLACED',
      },
    });

    // Три заказа: два уходят в маршрут, третий остаётся неразмещённым —
    // сценарий обязан увидеть их отдельным блоком, а не догадываться.
    const assigned = [
      await seedOrder(db, day, 0, POINTS[0] ?? DEPOT),
      await seedOrder(db, day, 1, POINTS[1] ?? DEPOT),
    ];
    const unassigned = await seedOrder(db, day, 2, POINTS[0] ?? DEPOT);

    // Четвёртый заказ того же дня с подтверждённой точкой, НЕ входящий
    // в неизменяемый снимок расчёта. Он нужен браузерной проверке как
    // доказательство: расчёт берёт ровно выбранное, а посторонний заказ
    // не попадает ни в превью, ни в созданные черновики.
    const foreign = await seedOrder(db, day, 3, POINTS[1] ?? DEPOT);

    /*
     * Только предпосылки, без готового превью.
     *
     * Браузерная проверка считает по-настоящему: она сама ставит запуск через
     * `/api/route-plans`. Готовое превью удерживало бы день уникальным
     * `activeDateKey`, и настоящий расчёт упёрся бы в «день уже считается» —
     * фикстура мешала бы доказывать ровно то, ради чего создана.
     */
    if (withoutRun) {
      logger.info('предпосылки расчёта созданы, готовое превью не создавалось');
      process.stdout.write(`неразмещённый: ${unassigned.number}\n`);
      process.stdout.write(`неразмещённый id: ${unassigned.id}\n`);
      for (const order of assigned) {
        process.stdout.write(`в маршруте: ${order.number}\n`);
        process.stdout.write(`в маршруте id: ${order.id}\n`);
      }
      process.stdout.write(`посторонний: ${foreign.number}\n`);
      process.stdout.write(`посторонний id: ${foreign.id}\n`);
      return 0;
    }

    const run = await db.routePlanRun.create({
      data: {
        deliveryDate: toDateColumn(day),
        state: 'COMPUTING',
        activeDateKey: toDateColumn(day),
        requestedById: admin.id,
        lockedUntil: new Date(Date.now() + 60_000),
        lockedBy: 'seed',
      },
      select: { id: true },
    });

    const slot = await db.routePlanVehicleSlot.create({
      data: {
        runId: run.id,
        slotIndex: 1,
        vehicleType: 'CAR',
        capacityOrders: 20,
        shiftStartMinute: SHIFT.startMinute,
        shiftEndMinute: SHIFT.endMinute,
        startDepotId: depot.id,
        endDepotId: depot.id,
      },
      select: { id: true },
    });

    const snapshot: PlanInputSnapshot = buildInputSnapshot({
      deliveryDate: day,
      graphSha256: '0f'.repeat(32),
      trafficMode: 'STATIC',
      maxPoints: 60,
      shift: SHIFT,
      shiftVersion: 1,
      serviceTime: SERVICE_TIME,
      serviceTimeVersion: 1,
      depots: [
        {
          id: depot.id,
          name: depot.name,
          address: depot.address,
          latMicro: depot.latMicro,
          lonMicro: depot.lonMicro,
          isActive: depot.isActive,
          defaultKey: depot.defaultKey,
          version: depot.version,
        },
      ],
      orders: [...assigned, unassigned].map((order, index) => ({
        id: order.id,
        version: order.version,
        geoGeneration: order.geoGeneration,
        geoState: 'RESOLVED' as const,
        geoLatMicro: (index < 2 ? POINTS[index] : POINTS[0])?.latMicro ?? DEPOT.latMicro,
        geoLonMicro: (index < 2 ? POINTS[index] : POINTS[0])?.lonMicro ?? DEPOT.lonMicro,
        intervalKind: 'RANGE' as const,
        intervalStartMinute: 12 * 60,
        intervalEndMinute: 18 * 60,
        manualIntervalStartMinute: null,
        manualIntervalEndMinute: null,
      })),
      slots: [
        {
          slotIndex: 1,
          courierUserId: null,
          vehicleType: 'CAR',
          capacityOrders: 20,
          shiftStartMinute: SHIFT.startMinute,
          shiftEndMinute: SHIFT.endMinute,
          startDepotId: depot.id,
          endDepotId: depot.id,
        },
      ],
      slotIds: [slot.id],
    });

    const plan: PlanResult = {
      routes: [
        {
          slotId: slot.id,
          slotIndex: 1,
          vehicleType: 'CAR',
          courierUserId: null,
          startDepotId: depot.id,
          endDepotId: depot.id,
          stops: assigned.map((order, index) => ({
            orderId: order.id,
            position: index + 1,
            arrivalMinute: 12 * 60 + index * 30,
          })),
          travelSeconds: 1800,
          serviceSeconds: 1200,
          distanceMeters: 12000,
        },
      ],
      unassignedOrderIds: [unassigned.id],
    };

    await db.routePlanInputSnapshot.create({
      data: {
        runId: run.id,
        payload: snapshot as unknown as Prisma.InputJsonObject,
        payloadHash: snapshotHash(snapshot),
      },
    });

    await db.routePlanResultSnapshot.create({
      data: {
        runId: run.id,
        graphSha256: snapshot.graphSha256,
        matrixKeys: { CAR: 'seed' } as unknown as Prisma.InputJsonObject,
        solverVersion: '1.15.0',
        request: { jobs: [], vehicles: [], matrices: {} } as unknown as Prisma.InputJsonObject,
        response: { code: 0 } as unknown as Prisma.InputJsonObject,
        plan: plan as unknown as Prisma.InputJsonObject,
      },
    });

    await db.routePlanRun.update({
      where: { id: run.id },
      data: { state: 'PREVIEW', lockedUntil: null, lockedBy: null },
    });

    logger.info({ runId: run.id }, 'проверочное превью создано');
    // Значения нужны браузерному сценарию, поэтому печатаются отдельными строками.
    process.stdout.write(`запуск: ${run.id}\n`);
    process.stdout.write(`неразмещённый: ${unassigned.number}\n`);
    process.stdout.write(`неразмещённый id: ${unassigned.id}\n`);
    for (const order of assigned) {
      process.stdout.write(`в маршруте: ${order.number}\n`);
      process.stdout.write(`в маршруте id: ${order.id}\n`);
    }
    // Посторонний заказ дня: он обязан остаться вне расчёта и вне черновиков.
    process.stdout.write(`посторонний: ${foreign.number}\n`);
    process.stdout.write(`посторонний id: ${foreign.id}\n`);

    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      'не удалось создать проверочное превью:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
