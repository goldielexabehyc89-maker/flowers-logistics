/**
 * Фикстура браузерной проверки вкладки «Логистика → Уведомления».
 *
 * Смешанный список: обычное изменение заказа (поля + состав), карантин
 * «Нет цветов» (флорист/причина/комментарий, БЕЗ полей и состава) и запись
 * неизвестного/неполного формата (kind без payload-полей). Именно карантинная и
 * неполная записи роняли весь интерфейс на `payload.fields.length`; проверка
 * пустого списка это не ловила.
 *
 * Fail closed. Скрипт отказывается работать где-либо, кроме локального окружения
 * с одноразовой базой.
 *
 *   npm run seed:e2e-notifications-mixed
 */

import { randomUUID } from 'node:crypto';
import { moscowToday } from '@fl/shared';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { toDateColumn } from '../modules/integrations/moysklad/delivery-date.js';
import { hashSecretCode } from '../modules/auth/crypto.js';

const PIN = '5731';
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
    logger.error('фикстура уведомлений создаётся только в локальном окружении');
    return 2;
  }
  const database = databaseNameOf(config.DATABASE_URL);
  if (!ALLOWED_DATABASES.includes(database)) {
    logger.error({ allowed: ALLOWED_DATABASES }, 'фикстура уведомлений — только одноразовая база');
    return 2;
  }

  const db = createDatabase(config, logger);
  try {
    const admin = await db.user.findFirstOrThrow({
      where: { roles: { some: { role: 'ADMIN' } } },
      select: { id: true },
    });
    const stamp = String(Date.now() % 1_000_000).padStart(6, '0');
    const day = moscowToday(new Date());

    const logistPhone = `+79${stamp}${String(Date.now() % 1000).padStart(3, '0')}`;
    await db.user.create({
      data: {
        phone: logistPhone,
        fullName: 'Логист уведомлений',
        status: 'ACTIVE',
        pinHash: await hashSecretCode(PIN, config.AUTH_PIN_PEPPER),
        roles: { create: [{ role: 'LOGISTICIAN' }] },
      },
      select: { id: true },
    });

    async function seedOrder(suffix: string): Promise<{ id: string; number: string }> {
      const number = `NF-${stamp}-${suffix}`;
      const order = await db.deliveryOrder.create({
        data: {
          externalId: randomUUID(),
          externalName: number,
          externalUpdated: new Date(),
          externalStateName: 'Новый',
          deliveryDate: toDateColumn(day),
          address: 'Москва, выдуманная улица уведомлений, 1',
          recipient: 'Выдуманный получатель',
          inScope: true,
        },
        select: { id: true },
      });
      return { id: order.id, number };
    }

    // Обычное изменение: поля + состав есть — общий компонент рисует его как раньше.
    const changeOrder = await seedOrder('change');
    await db.orderChangeNotification.create({
      data: {
        orderId: changeOrder.id,
        source: 'MOYSKLAD_SYNC',
        categories: ['ADDRESS', 'INTERVAL'],
        kind: 'INFO',
        payload: {
          fields: [
            { category: 'ADDRESS', label: 'Адрес', old: 'ул. Старая, 1', new: 'ул. Новая, 2' },
            { category: 'INTERVAL', label: 'Интервал', old: '10:00–12:00', new: '14:00–16:00' },
          ],
          composition: null,
        } as unknown as object,
      },
    });

    // Карантин «Нет цветов»: НЕТ полей и состава — раньше рушил интерфейс.
    const quarantineOrder = await seedOrder('quarantine');
    await db.orderChangeNotification.create({
      data: {
        orderId: quarantineOrder.id,
        source: 'FLORIST',
        categories: [],
        kind: 'NO_FLOWERS_QUARANTINE',
        payload: {
          floristId: admin.id,
          floristName: 'Флорист карантина',
          reason: 'INSUFFICIENT_GOODS',
          comment: 'не хватило пионов',
        } as unknown as object,
      },
    });

    // Неизвестный/неполный формат: kind без payload-полей — безопасная карточка.
    const unknownOrder = await seedOrder('unknown');
    await db.orderChangeNotification.create({
      data: {
        orderId: unknownOrder.id,
        source: 'MOYSKLAD_SYNC',
        categories: [],
        kind: 'FUTURE_UNKNOWN_KIND',
        payload: {} as unknown as object,
      },
    });

    const lines: [string, string][] = [
      ['логист', logistPhone],
      ['пин', PIN],
      ['заказ изменение', changeOrder.number],
      ['заказ карантин', quarantineOrder.number],
      ['заказ неизвестный', unknownOrder.number],
    ];
    for (const [key, value] of lines) {
      process.stdout.write(`${key}: ${value}\n`);
    }

    logger.info({ stamp }, 'фикстура смешанных уведомлений создана');
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      'не удалось создать фикстуру уведомлений:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
