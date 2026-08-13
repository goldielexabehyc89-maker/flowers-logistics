/**
 * Фикстура складского сквозного сценария.
 *
 * Браузерная проверка обязана пройти путь «принять → переместить → подтвердить
 * курьера → выдать → ACTIVE», а для него нужны две ячейки, курьер и
 * подтверждённый маршрутный лист с заказами. Настоящий маршрут строится
 * планированием по дорожному графу, которого в браузерной проверке нет,
 * поэтому лист создаётся напрямую — ровно как это делает `seed:e2e-plan`.
 *
 * Fail closed. Скрипт отказывается работать где-либо, кроме локального
 * окружения с одноразовой базой: ячейки и маршруты с выдуманными данными
 * в production или staging выглядели бы настоящими.
 *
 *   npm run seed:e2e-warehouse
 */

import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { toDateColumn } from '../modules/integrations/moysklad/delivery-date.js';
import { moscowToday } from '@fl/shared';
import { hashSecretCode } from '../modules/auth/crypto.js';

/**
 * PIN курьера фикстуры.
 *
 * Постоянное значение допустимо ровно потому, что скрипт fail closed отказывает
 * везде, кроме локальной одноразовой базы: в staging и production этого
 * пользователя не существует.
 */
const COURIER_PIN = '4321';

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
    logger.error('складская фикстура создаётся только в локальном окружении');
    return 2;
  }

  const database = databaseNameOf(config.DATABASE_URL);
  if (!ALLOWED_DATABASES.includes(database)) {
    logger.error(
      { allowed: ALLOWED_DATABASES },
      'складская фикстура создаётся только в одноразовой базе',
    );
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

    const stamp = String(Date.now() % 1_000_000).padStart(6, '0');
    const day = moscowToday(new Date());

    const storage = await db.storageCell.create({
      data: {
        code: `S-${stamp}`,
        normalizedCode: `S-${stamp}`,
        kind: 'STORAGE',
        createdById: admin.id,
      },
      select: { normalizedCode: true },
    });
    const routeCell = await db.storageCell.create({
      data: {
        code: `R-${stamp}`,
        normalizedCode: `R-${stamp}`,
        kind: 'ROUTE',
        createdById: admin.id,
      },
      select: { normalizedCode: true },
    });

    // Курьер фикстуры активен и имеет роль COURIER: подтверждение курьера
    // требует и того, и другого. PIN задаётся здесь же — тем же курьером
    // продолжается сценарий доставки, и заводить второго значило бы проверять
    // не тот маршрут.
    const courierPhone = `+79${stamp}${String(Date.now() % 1000).padStart(3, '0')}`;
    const courier = await db.user.create({
      data: {
        phone: courierPhone,
        fullName: 'Курьер складской проверки',
        status: 'ACTIVE',
        pinHash: await hashSecretCode(COURIER_PIN, config.AUTH_PIN_PEPPER),
        roles: { create: [{ role: 'COURIER' }] },
        courierProfile: { create: {} },
      },
      select: { id: true },
    });

    const route = await db.deliveryRoute.create({
      data: {
        number: `WH-${stamp}`,
        deliveryDate: toDateColumn(day),
        state: 'CONFIRMED',
        vehicleType: 'CAR',
        createdById: admin.id,
        courierUserId: courier.id,
      },
      select: { id: true, number: true },
    });

    const numbers: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const number = `WHO-${stamp}-${index + 1}`;
      const order = await db.deliveryOrder.create({
        data: {
          externalId: crypto.randomUUID(),
          externalName: number,
          externalUpdated: new Date(),
          externalStateName: 'Новый',
          deliveryDate: toDateColumn(day),
          deliveryDateRaw: `${day} 12:00:00.000`,
          address: 'Москва, проверочный складской адрес',
          recipient: 'Проверочный складской получатель',
          inScope: true,
        },
        select: { id: true },
      });
      await db.routeOrder.create({
        data: {
          routeId: route.id,
          orderId: order.id,
          position: index + 1,
          addedById: admin.id,
        },
      });
      numbers.push(number);
    }

    // Значения нужны браузерному сценарию, поэтому печатаются отдельными строками.
    process.stdout.write(`ячейка хранения: ${storage.normalizedCode}\n`);
    process.stdout.write(`маршрутная ячейка: ${routeCell.normalizedCode}\n`);
    process.stdout.write(`маршрут: ${route.number}\n`);
    process.stdout.write(`курьер: ${courierPhone}\n`);
    process.stdout.write(`пин курьера: ${COURIER_PIN}\n`);
    for (const number of numbers) {
      process.stdout.write(`заказ: ${number}\n`);
    }

    logger.info({ route: route.number }, 'складская фикстура создана');
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      'не удалось создать складскую фикстуру:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
