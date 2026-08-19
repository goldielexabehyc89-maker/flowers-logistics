/**
 * Стенд прилавка самовывоза: все состояния очереди сразу.
 *
 * Очередь проверяется соседством, а не по одному заказу: вчерашний рядом
 * с завтрашним, снятая с полки коробка рядом с готовой, отменённый рядом
 * с выданным. Половина ошибок этого раздела видна только так.
 *
 * Состояния получаются НАСТОЯЩИМИ операциями — приёмкой, отменой источника,
 * снятием с хранения и выдачей, — а не записью полей: иначе стенд показывал
 * бы то, чего система не умеет.
 *
 * Данные синтетические целиком: номера заказов, телефоны и покупатели
 * выдуманы и ни на кого не указывают.
 *
 * Fail closed: только локальное окружение и одноразовая база.
 *
 *   npm run seed:e2e-pickup-stand
 */

import { randomUUID } from 'node:crypto';
import { moscowToday } from '@fl/shared';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { toDateColumn } from '../modules/integrations/moysklad/delivery-date.js';
import { MOYSKLAD_IDS } from '../modules/integrations/moysklad/config.js';
import { hashSecretCode } from '../modules/auth/crypto.js';
import { receiveOrder, withdrawOrder } from '../modules/warehouse/placement.js';
import { issueToCustomer } from '../modules/pickup/service.js';
import { applyCancellation } from '../modules/integrations/moysklad/cancellation.js';
import type { AuthenticatedActor } from '../modules/auth/guards.js';

/** Общий PIN учётных записей стенда. Допустим потому, что скрипт fail closed. */
const PIN = '1357';

const ALLOWED_DATABASES = ['fl_e2e', 'fl_ci', 'fl_test'];

function databaseNameOf(connectionString: string): string {
  try {
    return new URL(connectionString).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

/** День со сдвигом в московском календаре. */
function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);

  if (config.APP_ENV !== 'local' || config.APP_ENVIRONMENT_MARKER !== 'local') {
    logger.error('стенд самовывоза создаётся только в локальном окружении');
    return 2;
  }
  const database = databaseNameOf(config.DATABASE_URL);
  if (!ALLOWED_DATABASES.includes(database)) {
    logger.error({ allowed: ALLOWED_DATABASES }, 'стенд самовывоза — только одноразовая база');
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
    const today = moscowToday(new Date());

    const actorOf = (userId: string, roles: AuthenticatedActor['roles']): AuthenticatedActor =>
      ({ userId, roles, familyId: randomUUID() }) as AuthenticatedActor;

    const managerPhone = `+79${stamp}${'901'}`;
    const manager = await db.user.create({
      data: {
        phone: managerPhone,
        fullName: 'Менеджер прилавка стенда',
        status: 'ACTIVE',
        pinHash: await hashSecretCode(PIN, config.AUTH_PIN_PEPPER),
        roles: { create: [{ role: 'MANAGER' }] },
      },
      select: { id: true },
    });
    const keeperPhone = `+79${stamp}${'902'}`;
    const keeper = await db.user.create({
      data: {
        phone: keeperPhone,
        fullName: 'Кладовщик прилавка стенда',
        status: 'ACTIVE',
        pinHash: await hashSecretCode(PIN, config.AUTH_PIN_PEPPER),
        roles: { create: [{ role: 'WAREHOUSE' }] },
      },
      select: { id: true },
    });

    const managerActor = actorOf(manager.id, ['MANAGER']);
    const keeperActor = actorOf(keeper.id, ['WAREHOUSE']);

    async function seedCell(prefix: string): Promise<string> {
      const code = `${prefix}${stamp}`;
      const cell = await db.storageCell.create({
        data: { code, normalizedCode: code, kind: 'STORAGE', createdById: admin.id },
        select: { normalizedCode: true },
      });
      return cell.normalizedCode;
    }

    const cellA = await seedCell('PA-');
    const cellB = await seedCell('PB-');

    let sequence = 0;
    async function seedOrder(
      suffix: string,
      options: { day?: string | null; pickup?: boolean; assembled?: boolean } = {},
    ): Promise<{ id: string; number: string }> {
      sequence += 1;
      const number = `PU-${stamp}-${suffix}`;
      const day = options.day === undefined ? today : options.day;
      const pickup = options.pickup !== false;

      const order = await db.deliveryOrder.create({
        data: {
          externalId: randomUUID(),
          externalName: number,
          externalUpdated: new Date(),
          externalStateName: 'Новый',
          deliveryDate: day === null ? null : toDateColumn(day),
          deliveryDateRaw: day === null ? null : `${day} 12:00:00.000`,
          recipient: 'Выдуманный покупатель стенда',
          storeId: MOYSKLAD_IDS.store,
          ...(pickup
            ? { address: null, deliveryMethodId: MOYSKLAD_IDS.deliveryMethodPickup, inScope: false }
            : {
                address: 'Москва, выдуманная улица прилавка, 2',
                deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery,
                inScope: true,
              }),
          fulfillmentInScope: true,
          fulfillmentCompositionState: 'READY',
          fulfillmentSnapshotHash: `pickup-${stamp}-${sequence}`,
          fulfillmentCompositionSyncedAt: new Date(),
          fulfillmentRevisions: {
            create: {
              externalUpdated: new Date(),
              snapshot: { externalId: randomUUID(), positions: [] } as never,
              snapshotHash: `pickup-${stamp}-${sequence}`,
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

    const receive = (orderNumber: string, cellCode: string): Promise<unknown> =>
      receiveOrder(flow, keeperActor, { orderNumber, cellCode }, context);

    const report: string[] = [];

    // 1. Вчерашний, сегодняшний и завтрашний: одна очередь, разные дни.
    const yesterday = await seedOrder('вчера', { day: shiftDay(today, -1), assembled: true });
    await receive(yesterday.number, cellA);
    report.push(`${yesterday.number}: вчерашний, готов, ячейка ${cellA}`);

    const todayOrder = await seedOrder('сегодня', { assembled: true });
    await receive(todayOrder.number, cellA);
    report.push(`${todayOrder.number}: сегодняшний, готов, ячейка ${cellA}`);

    const tomorrow = await seedOrder('завтра', { day: shiftDay(today, 1), assembled: true });
    await receive(tomorrow.number, cellB);
    report.push(`${tomorrow.number}: завтрашний, готов, ячейка ${cellB}`);

    // 2. Коробку сняли с полки: заказ остаётся в очереди с честной причиной.
    const withoutCell = await seedOrder('без-ячейки', { assembled: true });
    await receive(withoutCell.number, cellB);
    await withdrawOrder(
      flow,
      keeperActor,
      { orderNumber: withoutCell.number, reason: 'WRITE_OFF' },
      context,
    );
    report.push(`${withoutCell.number}: в очереди, но фактической ячейки нет`);

    // 3. Отменённый: из очереди ушёл, коробка осталась на полке.
    const cancelled = await seedOrder('отменён', { assembled: true });
    await receive(cancelled.number, cellA);
    await db.$transaction(async (tx) => {
      await applyCancellation(tx, {
        orderId: cancelled.id,
        cancelled: true,
        previous: false,
        now: new Date(),
      });
    });
    report.push(`${cancelled.number}: отменён, коробка осталась в ${cellA}`);

    // 4. Пропавший источник: виден, но выдавать нельзя.
    const missing = await seedOrder('пропал', { assembled: true });
    await receive(missing.number, cellB);
    await db.deliveryOrder.update({
      where: { id: missing.id },
      data: { sourceMissing: true },
    });
    report.push(`${missing.number}: источник пропал, выдача заблокирована`);

    // 5. Уже выданный: справочный список, а не очередь.
    const issued = await seedOrder('выдан', { assembled: true });
    await receive(issued.number, cellA);
    await issueToCustomer(
      { db },
      managerActor,
      { orderNumber: issued.number, source: 'SCAN' },
      context,
    );
    report.push(`${issued.number}: уже выдан покупателю`);

    // 6. Обычная доставка: для отрицательной проверки сканирования.
    const delivery = await seedOrder('доставка', { pickup: false, assembled: true });
    await receive(delivery.number, cellB);
    report.push(`${delivery.number}: обычная доставка, в прилавок не попадает`);

    const lines: [string, string][] = [
      ['менеджер', managerPhone],
      ['кладовщик прилавка', keeperPhone],
      ['пин', PIN],
      ['ячейка A', cellA],
      ['ячейка B', cellB],
      ['заказ вчера', yesterday.number],
      ['заказ сегодня', todayOrder.number],
      ['заказ завтра', tomorrow.number],
      ['заказ без ячейки', withoutCell.number],
      ['заказ отменён', cancelled.number],
      ['заказ пропал', missing.number],
      ['заказ выдан', issued.number],
      ['заказ доставки', delivery.number],
    ];
    for (const [key, value] of lines) {
      process.stdout.write(`${key}: ${value}\n`);
    }
    for (const line of report) {
      process.stdout.write(`описание: ${line}\n`);
    }

    logger.info({ stamp }, 'стенд самовывоза создан');
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      'не удалось создать стенд самовывоза:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
