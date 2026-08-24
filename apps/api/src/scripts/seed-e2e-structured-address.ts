/**
 * Шесть заказов для проверки перехода на структурированный адрес.
 *
 * Проверять новый контракт на одном заказе бессмысленно: ошибки видны только
 * там, где рядом лежат заказ прежнего контракта и пять разных состояний
 * нового — полные детали, отсутствие деталей, отсутствие дома, ручная правка
 * логиста и дом, приехавший вторым сообщением.
 *
 * Заказы заводятся НАСТОЯЩИМ путём импорта: синтетический ответ МоегоСклада →
 * `mapOrder` → `applyOrderSnapshot`. Прямая запись новых колонок проверяла бы
 * таблицу, а не правила, ради которых всё и делается: версию контракта
 * выбирает импорт, и обойти его — значит не проверить ничего.
 *
 * Выключатель спрашивается один раз на заказ, в момент его создания. Поэтому
 * скрипт создаёт первый заказ с выключателем «выключено», а остальные — с
 * «включено», передавая значение прямо в импорт, а не полагаясь на окружение:
 * так одна фикстура показывает оба контракта рядом.
 *
 * Fail closed. Скрипт отказывается работать где-либо, кроме локального
 * окружения с одноразовой базой.
 *
 *   npm run seed:e2e-structured-address
 */

import { randomUUID } from 'node:crypto';
import { moscowToday } from '@fl/shared';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { MOYSKLAD_IDS } from '../modules/integrations/moysklad/config.js';
import { mapOrder, type RegionNames } from '../modules/integrations/moysklad/mapper.js';
import type { MoyskladOrderDto } from '../modules/integrations/moysklad/dto.js';
import { applyOrderSnapshot } from '../modules/integrations/moysklad/import-service.js';
import {
  addressDetailsOf,
  contractVersionOf,
  effectiveAddress,
  geocodingAddress,
  ORDER_ADDRESS_SELECT,
} from '../modules/orders/address.js';
import { setLocalAddress } from '../modules/orders/address-service.js';
import { setManualPoint } from '../modules/orders/geo.js';
import type { AuthenticatedActor } from '../modules/auth/guards.js';

const ALLOWED_DATABASES = ['fl_e2e', 'fl_ci', 'fl_test'];

const IDS = MOYSKLAD_IDS;
const REGION_HREF =
  'https://api.moysklad.ru/api/remap/1.2/entity/region/1f2e4d2c-0000-4000-8000-000000000001';
/**
 * Названия регионов приходят отдельным чтением справочника: МойСклад отдаёт
 * регион ссылкой без имени. Здесь оно уже готово — маппер в сеть не ходит.
 */
const REGIONS: RegionNames = new Map([[REGION_HREF, 'г. Москва']]);

const href = (kind: string, id: string): string =>
  `https://api.moysklad.ru/api/remap/1.2/entity/${kind}/${id}`;

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

interface Parts {
  postalCode?: string;
  region?: boolean;
  city?: string;
  street?: string;
  house?: string;
  apartment?: string;
  addInfo?: string;
}

/** Синтетический ответ МоегоСклада: того же вида, что приходит по сети. */
function dto(input: {
  externalId: string;
  number: string;
  day: string;
  address: string;
  parts?: Parts;
}): MoyskladOrderDto {
  const parts = input.parts;
  return {
    id: input.externalId,
    name: input.number,
    updated: `${input.day} 09:00:00.000`,
    moment: `${input.day} 08:00:00.000`,
    shipmentAddress: input.address,
    ...(parts === undefined
      ? {}
      : {
          shipmentAddressFull: {
            ...(parts.postalCode === undefined ? {} : { postalCode: parts.postalCode }),
            country: { meta: { href: href('country', '00000000-0000-4000-8000-00000000000c') } },
            ...(parts.region === true ? { region: { meta: { href: REGION_HREF } } } : {}),
            ...(parts.city === undefined ? {} : { city: parts.city }),
            ...(parts.street === undefined ? {} : { street: parts.street }),
            ...(parts.house === undefined ? {} : { house: parts.house }),
            ...(parts.apartment === undefined ? {} : { apartment: parts.apartment }),
            ...(parts.addInfo === undefined ? {} : { addInfo: parts.addInfo }),
          },
        }),
    deliveryPlannedMoment: `${input.day} 12:00:00.000`,
    sum: 499000,
    payedSum: 0,
    store: { meta: { href: href('store', IDS.store) } },
    state: {
      meta: { href: href('state', '22222222-2222-4222-8222-222222222222') },
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Новый',
      stateType: 'Regular',
    },
    attributes: [
      {
        id: IDS.deliveryMethodAttribute,
        value: {
          name: 'Доставка',
          meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
        },
      },
      { id: IDS.intervalAttribute, value: 'с 10:00 по 14:00' },
      { id: IDS.recipientAttribute, value: 'Проверочный получатель +70000000000' },
      { id: IDS.commentAttribute, value: 'Позвонить за час' },
    ],
  } as MoyskladOrderDto;
}

async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);

  if (config.APP_ENV !== 'local' || config.APP_ENVIRONMENT_MARKER !== 'local') {
    logger.error('фикстура адресного контракта создаётся только в локальном окружении');
    return 2;
  }
  const database = databaseNameOf(config.DATABASE_URL);
  if (!ALLOWED_DATABASES.includes(database)) {
    logger.error({ allowed: ALLOWED_DATABASES }, 'фикстура адреса — только одноразовая база');
    return 2;
  }

  const db = createDatabase(config, logger);
  const context = { ip: null, userAgent: null };

  try {
    const admin = await db.user.findFirstOrThrow({
      where: { roles: { some: { role: 'ADMIN' } } },
      select: { id: true },
    });
    const logistActor = actorOf(admin.id, ['ADMIN']);

    const stamp = String(Date.now() % 1_000_000).padStart(6, '0');
    const day = moscowToday(new Date());

    /**
     * Импорт одного заказа.
     *
     * `v2` — положение выключателя в этот момент. У существующего заказа он
     * не спрашивается вовсе: версия уже записана в строке.
     */
    async function importOrder(order: MoyskladOrderDto, v2: boolean): Promise<void> {
      const { snapshot } = mapOrder(order, IDS, 'shipmentAddressFull', REGIONS);
      await db.$transaction((tx) =>
        applyOrderSnapshot(tx, snapshot, new Date(), {
          structuredAddressV2: v2,
          // Очередь в local никто не разбирает: заказ, навсегда застрявший
          // в «Определяется», врал бы логисту о том, что точка вот-вот будет.
          geocoding: false,
        }),
      );
    }

    async function orderOf(number: string): Promise<{ id: string; version: number }> {
      return db.deliveryOrder.findFirstOrThrow({
        where: { externalName: number },
        select: { id: true, version: true },
      });
    }

    /** Точка ставится настоящей операцией логиста, а не записью полей. */
    async function pin(number: string, lat: string, lon: string): Promise<void> {
      const order = await orderOf(number);
      await setManualPoint(
        { db },
        logistActor,
        order.id,
        {
          lat,
          lon,
          reason: 'Точка стенда: проверка показа адреса',
          expectedVersion: order.version,
        },
        context,
      );
    }

    const report: string[] = [];
    const publish = (label: string, value: string): void => {
      report.push(`${label}: ${value}`);
    };

    const numbers = {
      legacy: `SA-${stamp}-LEGACY`,
      full: `SA-${stamp}-FULL`,
      noDetails: `SA-${stamp}-NODETAILS`,
      noHouse: `SA-${stamp}-NOHOUSE`,
      manual: `SA-${stamp}-MANUAL`,
      late: `SA-${stamp}-LATE`,
    };

    // 1. Прежний контракт. Разобранные части у источника ЕСТЬ — и всё равно
    //    не записываются: версию выбирает импорт, а не наличие частей.
    await importOrder(
      dto({
        externalId: randomUUID(),
        number: numbers.legacy,
        day,
        address: 'Москва, Тверская улица, 1, кв. 12, домофон 12К',
        parts: {
          region: true,
          city: 'г. Москва',
          street: 'Тверская улица',
          house: '1',
          apartment: '12',
          addInfo: 'домофон 12К',
        },
      }),
      false,
    );
    await pin(numbers.legacy, '55.757997', '37.614069');

    // 2. Новый контракт со всеми деталями.
    await importOrder(
      dto({
        externalId: randomUUID(),
        number: numbers.full,
        day,
        address: 'Москва, Маленковская улица, 14, кв. 55, домофон 42, этаж 4',
        parts: {
          postalCode: '107113',
          region: true,
          city: 'г. Москва',
          street: 'Маленковская улица',
          house: '14',
          apartment: '55',
          addInfo: 'домофон 42, этаж 4',
        },
      }),
      true,
    );
    await pin(numbers.full, '55.804012', '37.677444');

    // 3. Новый контракт без деталей: второй строки на экранах быть не должно.
    await importOrder(
      dto({
        externalId: randomUUID(),
        number: numbers.noDetails,
        day,
        address: 'Москва, Русаковская улица, 26',
        parts: { city: 'г. Москва', street: 'Русаковская улица', house: '26' },
      }),
      true,
    );
    await pin(numbers.noDetails, '55.788312', '37.680123');

    // 4. Новый контракт без дома: рабочего адреса нет, и запасного пути тоже.
    await importOrder(
      dto({
        externalId: randomUUID(),
        number: numbers.noHouse,
        day,
        address: 'Москва, где-то на Русаковской, кв. 7',
        parts: {
          region: true,
          city: 'г. Москва',
          street: 'Русаковская улица',
          apartment: '7',
          addInfo: 'уточнить дом у получателя',
        },
      }),
      true,
    );

    // 5. Новый контракт с ручной правкой логиста: она сильнее источника.
    await importOrder(
      dto({
        externalId: randomUUID(),
        number: numbers.manual,
        day,
        address: 'Москва, Сокольнический Вал, 1, кв. 3',
        parts: {
          city: 'г. Москва',
          street: 'Сокольнический Вал',
          house: '1',
          apartment: '3',
          addInfo: 'вход со двора',
        },
      }),
      true,
    );
    const manualOrder = await orderOf(numbers.manual);
    await setLocalAddress(
      { db },
      { userId: admin.id },
      manualOrder.id,
      { address: 'Москва, Сокольническая площадь, 4' },
      context,
    );
    await pin(numbers.manual, '55.789421', '37.679012');

    // 6. Дом приехал вторым сообщением: заказ создан без него и дополнен.
    const lateId = randomUUID();
    await importOrder(
      dto({
        externalId: lateId,
        number: numbers.late,
        day,
        address: 'Москва, Стромынка',
        parts: { city: 'г. Москва', street: 'Стромынка', apartment: '19' },
      }),
      true,
    );
    await importOrder(
      dto({
        externalId: lateId,
        number: numbers.late,
        day,
        address: 'Москва, Стромынка, 21, кв. 19',
        parts: { city: 'г. Москва', street: 'Стромынка', house: '21', apartment: '19' },
      }),
      true,
    );
    await pin(numbers.late, '55.788901', '37.700123');

    /*
     * Отчёт.
     *
     * По каждому заказу — рабочий адрес, детали, ТОЧНАЯ строка, которая ушла
     * бы геокодеру, и версия контракта. Строка запроса важнее остальных: по
     * ней и видно, что детали наружу не уходят.
     */
    for (const [role, number] of Object.entries(numbers)) {
      const row = await db.deliveryOrder.findFirstOrThrow({
        where: { externalName: number },
        select: {
          id: true,
          ...ORDER_ADDRESS_SELECT,
          geoState: true,
          attentionReasons: true,
        },
      });

      publish(`${role} · заказ`, number);
      publish(`${role} · id`, row.id);
      publish(`${role} · контракт`, contractVersionOf(row));
      publish(`${role} · рабочий адрес`, effectiveAddress(row) ?? '—');
      publish(`${role} · детали`, addressDetailsOf(row) ?? '—');
      publish(`${role} · ушло бы геокодеру`, geocodingAddress(row) ?? '—');
      publish(`${role} · состояние точки`, row.geoState);
      publish(
        `${role} · требует внимания`,
        row.attentionReasons.length === 0 ? '—' : row.attentionReasons.join(', '),
      );

      // Отдельной строкой: заказ прежнего контракта новых колонок не получил.
      if (contractVersionOf(row) === 'LEGACY') {
        publish(
          `${role} · новые колонки`,
          row.structuredAddress === null && row.addressDetails === null
            ? 'пусты — заказ не изменился'
            : 'ЗАПОЛНЕНЫ — это ошибка перехода',
        );
      }
    }

    publish('день доставки', day);
    for (const line of report) {
      process.stdout.write(`${line}\n`);
    }

    logger.info({ orders: Object.keys(numbers).length }, 'фикстуры адресного контракта созданы');
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      'не удалось создать фикстуру адресного контракта:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
