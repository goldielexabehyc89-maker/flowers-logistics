/**
 * Структурированный адрес: два контракта живут рядом.
 *
 * Проверяется не «собирается ли строка», а безопасность перехода — то, из-за
 * чего заказ уехал бы не туда или пропал бы с карты:
 *
 *  * существующий заказ после очередной синхронизации остаётся прежним: ни
 *    адреса, ни координат, ни новых заданий;
 *  * выключатель решает судьбу только ВПЕРВЫЕ создаваемого заказа, а его
 *    выключение не ломает уже созданные заказы версии 2;
 *  * рабочий адрес нового контракта — только город, улица и дом; операционная
 *    строка источника запасным путём не служит;
 *  * детали не попадают ни в один запрос наружу;
 *  * правка деталей не трогает координаты и не создаёт задание, а смена дома
 *    создаёт ровно одно и повторяется идемпотентно;
 *  * ручная правка логиста сильнее любого источника;
 *  * неизвестная версия контракта даёт явную ошибку, а не молчаливый legacy.
 *
 * Заказы заводятся ТОЛЬКО настоящим путём импорта — `mapOrder` →
 * `applyOrderSnapshot`. Прямая запись новых колонок проверяла бы таблицу,
 * а не правила, ради которых всё и делается.
 *
 * ВЛАДЕНИЕ ДАТАМИ: файл забронировал ноябрь 2028 года
 * (`platform/testing/test-days.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import {
  composeAddressDetails,
  composeWorkingAddress,
  mapOrder,
  type OrderSnapshot,
} from '../integrations/moysklad/mapper.js';
import type { MoyskladOrderDto } from '../integrations/moysklad/dto.js';
import { applyOrderSnapshot } from '../integrations/moysklad/import-service.js';
import {
  addressState,
  automaticGeocodingAddress,
  contractVersionOf,
  effectiveAddress,
  geocodingAddress,
} from './address.js';
import { setLocalAddress } from './address-service.js';
import { normalizeAddress } from './geocoding/normalize.js';
import { PhotonClient } from '../integrations/photon/client.js';
import { assertNumericRequest, VroomError } from '../integrations/vroom/client.js';
import { matrixCacheKey } from '../geo/matrix/service.js';

const IDS = MOYSKLAD_IDS;
const DAY = '2028-11-14';
const NOW = new Date('2028-11-14T09:00:00.000Z');

const href = (kind: string, id: string): string =>
  `https://api.moysklad.ru/api/remap/1.2/entity/${kind}/${id}`;

const REGION_HREF = href('region', '33333333-3333-4333-8333-333333333333');
/** Названия регионов достаются отдельным чтением справочника — здесь готовые. */
const REGIONS = new Map([[REGION_HREF, 'Москва']]);

type Full = NonNullable<MoyskladOrderDto['shipmentAddressFull']>;

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let sequence = 0;
/** Номер заказа, не повторяющийся между прогонами: заказы не удаляются. */
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${sequence}`;
}

interface Parts {
  postalCode?: string;
  city?: string;
  street?: string;
  house?: string;
  apartment?: string;
  addInfo?: string;
  region?: boolean;
}

function full(parts: Parts): Full {
  return {
    ...(parts.postalCode === undefined ? {} : { postalCode: parts.postalCode }),
    country: { meta: { href: href('country', '00000000-0000-4000-8000-00000000000c') } },
    ...(parts.region === true ? { region: { meta: { href: REGION_HREF } } } : {}),
    ...(parts.city === undefined ? {} : { city: parts.city }),
    ...(parts.street === undefined ? {} : { street: parts.street }),
    ...(parts.house === undefined ? {} : { house: parts.house }),
    ...(parts.apartment === undefined ? {} : { apartment: parts.apartment }),
    ...(parts.addInfo === undefined ? {} : { addInfo: parts.addInfo }),
  };
}

/** Синтетический ответ МоегоСклада: того же вида, что приходит по сети. */
function dto(input: {
  externalId: string;
  number: string;
  address?: string;
  parts?: Parts;
  comment?: string;
}): MoyskladOrderDto {
  return {
    id: input.externalId,
    name: input.number,
    updated: '2028-11-14 10:00:00.000',
    moment: '2028-11-14 09:00:00.000',
    shipmentAddress: input.address ?? 'Москва, операционная строка источника',
    ...(input.parts === undefined ? {} : { shipmentAddressFull: full(input.parts) }),
    deliveryPlannedMoment: `${DAY} 12:00:00.000`,
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
      { id: IDS.intervalAttribute, value: 'с 16:00 по 19:00' },
      { id: IDS.recipientAttribute, value: 'Получатель Проверочный +70000000000' },
      { id: IDS.commentAttribute, value: input.comment ?? 'позвонить за час' },
    ],
  } as MoyskladOrderDto;
}

function snapshotOf(order: MoyskladOrderDto): OrderSnapshot {
  return mapOrder(order, IDS, 'shipmentAddressFull', REGIONS).snapshot;
}

/** Импорт настоящим путём. `v2` — положение выключателя в этот момент. */
async function importOrder(order: MoyskladOrderDto, options: { v2: boolean }): Promise<void> {
  await ctx.db.$transaction((tx) =>
    applyOrderSnapshot(tx, snapshotOf(order), NOW, {
      structuredAddressV2: options.v2,
      geocoding: true,
    }),
  );
}

const ORDER_COLUMNS = {
  id: true,
  address: true,
  geocodeAddress: true,
  localAddress: true,
  structuredAddress: true,
  addressDetails: true,
  addressContractVersion: true,
  geoState: true,
  geoSource: true,
  geoLatMicro: true,
  geoLonMicro: true,
  geoGeneration: true,
  needsAttention: true,
  attentionReasons: true,
} as const;

async function readOrder(number: string): Promise<{
  id: string;
  address: string | null;
  geocodeAddress: string | null;
  localAddress: string | null;
  structuredAddress: string | null;
  addressDetails: string | null;
  addressContractVersion: number | null;
  geoState: string;
  geoSource: string | null;
  geoLatMicro: number | null;
  geoLonMicro: number | null;
  geoGeneration: number;
  needsAttention: boolean;
  attentionReasons: string[];
}> {
  return ctx.db.deliveryOrder.findFirstOrThrow({
    where: { externalName: number },
    select: ORDER_COLUMNS,
  });
}

async function jobCount(orderId: string): Promise<number> {
  return ctx.db.orderGeocodeJob.count({ where: { orderId } });
}

async function eventKinds(orderId: string): Promise<string[]> {
  const rows = await ctx.db.orderStructuredAddressEvent.findMany({
    where: { orderId },
    orderBy: { kind: 'asc' },
    select: { kind: true },
  });
  return rows.map((row) => row.kind);
}

describe('сборка значений нового контракта', () => {
  it('рабочий адрес — только город, улица и дом', () => {
    const parts = full({
      postalCode: '107113',
      region: true,
      city: 'г. Москва',
      street: 'ул. Маленковская',
      house: 'д. 14 к. 1',
      apartment: '55',
      addInfo: 'м. Сокольники, подъезд 3',
    });

    const working = composeWorkingAddress(parts);
    expect(working).toBe('г. Москва, ул. Маленковская, д. 14 к. 1');
    // Ни индекса, ни страны, ни региона, ни квартиры: геокодер ищет дом,
    // а не квартиру в нём, и лишние слова уводят поиск на соседний город.
    expect(working).not.toContain('107113');
    expect(working).not.toContain('55');
    expect(working).not.toContain('Сокольники');
  });

  it('без города, улицы или дома рабочего адреса нет вовсе', () => {
    const base = { city: 'г. Москва', street: 'ул. Маленковская', house: 'д. 14' };
    expect(composeWorkingAddress(full({ ...base, city: undefined }))).toBeNull();
    expect(composeWorkingAddress(full({ ...base, street: undefined }))).toBeNull();
    expect(composeWorkingAddress(full({ ...base, house: undefined }))).toBeNull();
    expect(composeWorkingAddress(undefined)).toBeNull();
  });

  it('детали собираются из непустых частей и пустых подписей не оставляют', () => {
    expect(
      composeAddressDetails(
        full({ region: true, apartment: '55', addInfo: 'м. Сокольники, подъезд 3, этаж 4' }),
        REGIONS,
      ),
    ).toBe('Регион: Москва · Кв./офис: 55 · Другое: м. Сокольники, подъезд 3, этаж 4');

    expect(composeAddressDetails(full({ apartment: '55' }), REGIONS)).toBe('Кв./офис: 55');
    expect(composeAddressDetails(full({}), REGIONS)).toBeNull();

    // Название региона не выдумывается: неизвестная ссылка — это отсутствие
    // названия, а не повод показать человеку идентификатор справочника.
    expect(composeAddressDetails(full({ region: true }))).toBeNull();
  });

  it('поле источника `comment` в детали не попадает', () => {
    // В интерфейсе МоегоСклада «Другое» — это `addInfo`. Склейка с отдельным
    // полем `comment` приписала бы человеку слова, которых он не писал.
    const details = composeAddressDetails(
      { ...full({ addInfo: 'домофон 42' }), comment: 'звонить с 9 до 18' },
      REGIONS,
    );
    expect(details).toBe('Другое: домофон 42');
    expect(details).not.toContain('звонить');
  });
});

describe('выключатель решает судьбу только новых заказов', () => {
  it('выключатель погашен — новый заказ живёт по прежним правилам', async () => {
    const number = unique('LEG');
    await importOrder(
      dto({
        externalId: randomUUID(),
        number,
        address: 'Москва, ул. Маленковская, д. 14, кв. 55',
        parts: { city: 'г. Москва', street: 'ул. Маленковская', house: 'д. 14', apartment: '55' },
      }),
      { v2: false },
    );

    const row = await readOrder(number);
    expect(row.addressContractVersion).toBeNull();
    // Кандидаты в снимке были — и всё равно не записаны: версию выбирает
    // импорт, а не наличие разобранных частей у источника.
    expect(row.structuredAddress).toBeNull();
    expect(row.addressDetails).toBeNull();
    expect(contractVersionOf(row)).toBe('LEGACY');
    expect(effectiveAddress(row)).toBe('Москва, ул. Маленковская, д. 14, кв. 55');
    expect(addressState({ ...row, addressConflict: false }).details).toBeNull();
  });

  it('выключатель включён — новый заказ получает версию 2', async () => {
    const number = unique('V2');
    await importOrder(
      dto({
        externalId: randomUUID(),
        number,
        address: 'Москва, ул. Маленковская, д. 14, кв. 55, домофон 42',
        parts: {
          region: true,
          city: 'г. Москва',
          street: 'ул. Маленковская',
          house: 'д. 14',
          apartment: '55',
          addInfo: 'домофон 42',
        },
      }),
      { v2: true },
    );

    const row = await readOrder(number);
    expect(row.addressContractVersion).toBe(2);
    expect(contractVersionOf(row)).toBe('V2');
    expect(row.structuredAddress).toBe('г. Москва, ул. Маленковская, д. 14');
    expect(row.addressDetails).toBe('Регион: Москва · Кв./офис: 55 · Другое: домофон 42');
    // Рабочим стал разобранный адрес, а не операционная строка источника.
    expect(effectiveAddress(row)).toBe('г. Москва, ул. Маленковская, д. 14');
    // Единицу не записывает никто: legacy — это отсутствие версии.
    expect(row.addressContractVersion).not.toBe(1);
  });

  it('очередная синхронизация не переводит старый заказ на новый контракт', async () => {
    const number = unique('KEEP');
    const externalId = randomUUID();
    const parts = { city: 'г. Москва', street: 'ул. Маленковская', house: 'д. 14' };
    await importOrder(
      dto({ externalId, number, address: 'Москва, ул. Маленковская, д. 14', parts }),
      { v2: false },
    );
    const before = await readOrder(number);
    const jobsBefore = await jobCount(before.id);

    // Прошёл ещё один импорт — уже при ВКЛЮЧЁННОМ выключателе и с новыми
    // данными источника, то есть путь обновления действительно отработал.
    await importOrder(
      dto({
        externalId,
        number,
        address: 'Москва, ул. Маленковская, д. 14',
        parts: { ...parts, apartment: '55', addInfo: 'домофон 42' },
        comment: 'позвонить за два часа',
      }),
      { v2: true },
    );
    const after = await readOrder(number);

    expect(after.addressContractVersion).toBeNull();
    expect(after.structuredAddress).toBeNull();
    expect(after.addressDetails).toBeNull();
    expect(after.address).toBe(before.address);
    expect(after.geocodeAddress).toBe(before.geocodeAddress);
    expect(after.geoState).toBe(before.geoState);
    expect(after.geoGeneration).toBe(before.geoGeneration);
    expect(await jobCount(before.id)).toBe(jobsBefore);
    // Истории нового контракта у старого заказа не заводится.
    expect(await eventKinds(before.id)).toEqual([]);
  });

  it('выключение выключателя не ломает уже созданный заказ версии 2', async () => {
    const number = unique('V2OFF');
    const externalId = randomUUID();
    await importOrder(
      dto({
        externalId,
        number,
        parts: { city: 'г. Москва', street: 'ул. Маленковская', house: 'д. 14', apartment: '55' },
      }),
      { v2: true },
    );

    // Выключатель погашен, синхронизация продолжается.
    await importOrder(
      dto({
        externalId,
        number,
        parts: { city: 'г. Москва', street: 'ул. Маленковская', house: 'д. 16', apartment: '55' },
      }),
      { v2: false },
    );

    const row = await readOrder(number);
    expect(row.addressContractVersion).toBe(2);
    expect(row.structuredAddress).toBe('г. Москва, ул. Маленковская, д. 16');
    expect(effectiveAddress(row)).toBe('г. Москва, ул. Маленковская, д. 16');
  });

  it('неизвестная версия контракта — явная ошибка, а не молчаливый legacy', () => {
    expect(() => contractVersionOf({ addressContractVersion: 1 })).toThrow(/версия/i);
    expect(() => contractVersionOf({ addressContractVersion: 3 })).toThrow(/версия/i);
    expect(contractVersionOf({ addressContractVersion: null })).toBe('LEGACY');
    expect(contractVersionOf({})).toBe('LEGACY');
  });
});

describe('что уходит наружу у нового контракта', () => {
  it('операционная строка источника запасным путём не служит', async () => {
    const number = unique('NOHOUSE');
    await importOrder(
      dto({
        externalId: randomUUID(),
        number,
        address: 'Москва, где-то там, кв. 55',
        // Дома в разобранном адресе нет: собирать рабочий адрес не из чего.
        parts: { city: 'г. Москва', street: 'ул. Маленковская', addInfo: 'домофон 42' },
      }),
      { v2: true },
    );

    const row = await readOrder(number);
    expect(row.structuredAddress).toBeNull();
    // Ни показать, ни отправить в геокодер операционную строку нельзя —
    // включая собранный по прежним правилам `geocodeAddress`.
    expect(effectiveAddress(row)).toBeNull();
    expect(geocodingAddress(row)).toBeNull();
    expect(automaticGeocodingAddress(row)).toBeNull();
    // Заказ виден человеку по существующей причине, а не по новой.
    expect(row.attentionReasons).toContain('GEOCODING_ADDRESS_INCOMPLETE');
    expect(await jobCount(row.id)).toBe(0);
  });

  it('детали не входят ни в один запрос наружу', async () => {
    const number = unique('DETAILS');
    await importOrder(
      dto({
        externalId: randomUUID(),
        number,
        parts: {
          region: true,
          city: 'г. Москва',
          street: 'ул. Маленковская',
          house: 'д. 14',
          apartment: '55',
          addInfo: 'домофон 42, этаж 4',
        },
      }),
      { v2: true },
    );

    const row = await readOrder(number);
    expect(row.addressDetails).toBe('Регион: Москва · Кв./офис: 55 · Другое: домофон 42, этаж 4');

    // Обе функции запроса — и операторская, и автоматическая — отдают ровно
    // рабочий адрес. Именно их значение уходит в очередь, к провайдеру,
    // в ключ кэша матрицы и во вход решателя.
    for (const outgoing of [geocodingAddress(row), automaticGeocodingAddress(row)]) {
      expect(outgoing).toBe('г. Москва, ул. Маленковская, д. 14');
      expect(outgoing).not.toContain('Регион');
      expect(outgoing).not.toContain('Кв./офис');
      expect(outgoing).not.toContain('55');
      expect(outgoing).not.toContain('домофон');
    }

    // В самой очереди адреса нет вовсе: только ссылка на заказ и поколение.
    const job = await ctx.db.orderGeocodeJob.findFirstOrThrow({
      where: { orderId: row.id },
      select: { orderId: true, geoGeneration: true, lastErrorCode: true },
    });
    expect(job.geoGeneration).toBe(row.geoGeneration);
    expect(JSON.stringify(job)).not.toContain('домофон');
  });

  it('ручная правка логиста сильнее разобранного адреса', async () => {
    const number = unique('MANUAL');
    await importOrder(
      dto({
        externalId: randomUUID(),
        number,
        parts: { city: 'г. Москва', street: 'ул. Маленковская', house: 'д. 14', apartment: '55' },
      }),
      { v2: true },
    );
    const created = await readOrder(number);

    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    await setLocalAddress(
      { db: ctx.db },
      { userId: logist.id },
      created.id,
      { address: 'Москва, Тверская улица, 1' },
      { ip: null, userAgent: null },
    );

    const row = await readOrder(number);
    expect(effectiveAddress(row)).toBe('Москва, Тверская улица, 1');
    expect(geocodingAddress(row)).toBe('Москва, Тверская улица, 1');
    expect(automaticGeocodingAddress(row)).toBe('Москва, Тверская улица, 1');
    // Правка отменяет адрес, но не детали: они описывают ту же точку доставки
    // и по-прежнему нужны курьеру у двери.
    expect(addressState({ ...row, addressConflict: false }).details).toBe('Кв./офис: 55');
  });

  it('legacy и новый контракт работают рядом и не мешают друг другу', async () => {
    const legacyNumber = unique('BOTH-LEG');
    const v2Number = unique('BOTH-V2');
    const parts = { city: 'г. Москва', street: 'ул. Маленковская', house: 'д. 14', apartment: '7' };

    await importOrder(
      dto({
        externalId: randomUUID(),
        number: legacyNumber,
        address: 'Москва, ул. Маленковская, д. 14, кв. 7',
        parts,
      }),
      { v2: false },
    );
    await importOrder(dto({ externalId: randomUUID(), number: v2Number, parts }), { v2: true });

    const legacy = await readOrder(legacyNumber);
    const modern = await readOrder(v2Number);

    expect(effectiveAddress(legacy)).toBe('Москва, ул. Маленковская, д. 14, кв. 7');
    expect(addressState({ ...legacy, addressConflict: false }).contract).toBe('LEGACY');
    expect(addressState({ ...legacy, addressConflict: false }).details).toBeNull();

    expect(effectiveAddress(modern)).toBe('г. Москва, ул. Маленковская, д. 14');
    expect(addressState({ ...modern, addressConflict: false }).contract).toBe('V2');
    expect(addressState({ ...modern, addressConflict: false }).details).toBe('Кв./офис: 7');
  });
});

describe('координаты и задания нового контракта', () => {
  it('изменение только деталей не трогает точку и не создаёт задание', async () => {
    const number = unique('SAMEHOUSE');
    const externalId = randomUUID();
    const parts = { city: 'г. Москва', street: 'ул. Маленковская', house: 'д. 14' };
    await importOrder(dto({ externalId, number, parts }), { v2: true });

    const created = await readOrder(number);
    // Точка уже найдена: именно её и нельзя терять из-за квартиры.
    await ctx.db.deliveryOrder.update({
      where: { id: created.id },
      data: {
        geoState: 'RESOLVED',
        geoSource: 'PHOTON',
        geoPrecision: 'EXACT_HOUSE',
        geoResolvedAt: NOW,
        geoLatMicro: 55_757_997,
        geoLonMicro: 37_614_069,
      },
    });
    const before = await readOrder(number);
    const jobsBefore = await jobCount(created.id);

    await importOrder(
      dto({ externalId, number, parts: { ...parts, apartment: '55', addInfo: 'домофон 42' } }),
      { v2: true },
    );

    const after = await readOrder(number);
    expect(after.addressDetails).toBe('Кв./офис: 55 · Другое: домофон 42');
    expect(after.structuredAddress).toBe(before.structuredAddress);
    expect(after.geoState).toBe('RESOLVED');
    expect(after.geoSource).toBe('PHOTON');
    expect(after.geoLatMicro).toBe(before.geoLatMicro);
    expect(after.geoLonMicro).toBe(before.geoLonMicro);
    expect(after.geoGeneration).toBe(before.geoGeneration);
    expect(await jobCount(created.id)).toBe(jobsBefore);

    // История различает событие: изменились детали, а не адрес. Слитая строка
    // заставляла бы гадать, надо ли перепроверять маршрут.
    expect(await eventKinds(created.id)).toEqual(['DETAILS']);
  });

  it('смена дома создаёт ровно одно задание, а повтор снимка — ни одного', async () => {
    const number = unique('MOVE');
    const externalId = randomUUID();
    await importOrder(
      dto({
        externalId,
        number,
        parts: { city: 'г. Москва', street: 'ул. Маленковская', house: 'д. 14' },
      }),
      { v2: true },
    );
    const created = await readOrder(number);
    const jobsAfterCreate = await jobCount(created.id);

    const moved = dto({
      externalId,
      number,
      parts: { city: 'г. Москва', street: 'ул. Маленковская', house: 'д. 16' },
    });
    await importOrder(moved, { v2: true });
    const afterMove = await readOrder(number);

    expect(afterMove.structuredAddress).toBe('г. Москва, ул. Маленковская, д. 16');
    expect(await jobCount(created.id)).toBe(jobsAfterCreate + 1);
    expect(afterMove.geoGeneration).toBe(created.geoGeneration + 1);
    expect(afterMove.geoState).toBe('PENDING');

    // Тот же снимок ещё раз: ни задания, ни нового поколения.
    await importOrder(moved, { v2: true });
    const afterRepeat = await readOrder(number);
    expect(await jobCount(created.id)).toBe(jobsAfterCreate + 1);
    expect(afterRepeat.geoGeneration).toBe(afterMove.geoGeneration);

    expect(await eventKinds(created.id)).toEqual(['ADDRESS']);
  });

  it('дом, появившийся позже, ставит заказ в очередь', async () => {
    const number = unique('LATE');
    const externalId = randomUUID();
    await importOrder(
      dto({ externalId, number, parts: { city: 'г. Москва', street: 'ул. Маленковская' } }),
      { v2: true },
    );
    const created = await readOrder(number);
    expect(created.structuredAddress).toBeNull();
    expect(created.attentionReasons).toContain('GEOCODING_ADDRESS_INCOMPLETE');
    expect(await jobCount(created.id)).toBe(0);

    await importOrder(
      dto({
        externalId,
        number,
        parts: { city: 'г. Москва', street: 'ул. Маленковская', house: 'д. 14' },
      }),
      { v2: true },
    );

    const after = await readOrder(number);
    expect(after.structuredAddress).toBe('г. Москва, ул. Маленковская, д. 14');
    expect(await jobCount(created.id)).toBe(1);
    expect(after.attentionReasons).not.toContain('GEOCODING_ADDRESS_INCOMPLETE');
  });
});

describe('переход не задевает прежние заказы', () => {
  it('новые колонки пусты у всех заказов прежнего контракта', async () => {
    const legacy = await ctx.db.deliveryOrder.count({ where: { addressContractVersion: null } });
    const dirty = await ctx.db.deliveryOrder.count({
      where: {
        addressContractVersion: null,
        OR: [{ structuredAddress: { not: null } }, { addressDetails: { not: null } }],
      },
    });

    // В общей базе критических проверок лежат заказы всех остальных файлов —
    // ни один из них про новый контракт не знает. Так и выглядит «миграция
    // не изменила ни одной строки»: колонки добавлены и остались пустыми.
    expect(legacy).toBeGreaterThan(0);
    expect(dirty).toBe(0);
  });

  it('импорт без выключателя не добавляет заданий сверх прежнего правила', async () => {
    const number = unique('NOJOB');
    const before = await ctx.db.orderGeocodeJob.count();

    // Разобранные части у источника есть, но контракт прежний, а источник
    // запроса — операционная строка: автоматическому геокодированию взяться
    // неоткуда, ровно как и до перехода.
    await ctx.db.$transaction((tx) =>
      applyOrderSnapshot(
        tx,
        mapOrder(
          dto({
            externalId: randomUUID(),
            number,
            address: 'Москва, ул. Маленковская, д. 14',
            parts: { city: 'г. Москва', street: 'ул. Маленковская', house: 'д. 14' },
          }),
          IDS,
          'shipmentAddress',
          REGIONS,
        ).snapshot,
        NOW,
        { structuredAddressV2: false, geocoding: true },
      ),
    );

    const row = await readOrder(number);
    expect(row.geoState).toBe('UNRESOLVED');
    expect(await ctx.db.orderGeocodeJob.count()).toBe(before);
  });
});

describe('детали не покидают приложение', () => {
  /** Синтетический заказ версии 2 в памяти: базы этим проверкам не нужно. */
  const order = {
    address: 'Москва, ул. Маленковская, д. 14, кв. 55, домофон 42',
    localAddress: null,
    geocodeAddress: '107113, Россия, Москва, ул. Маленковская, д. 14',
    structuredAddress: 'г. Москва, ул. Маленковская, д. 14',
    addressDetails: 'Регион: Москва · Кв./офис: 55 · Другое: домофон 42',
    addressContractVersion: 2,
  };

  it('в запрос Photon уходит рабочий адрес и ни одной детали', async () => {
    const calls: string[] = [];
    const client = new PhotonClient({
      url: 'http://photon.internal:2322/api',
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ features: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
    });

    const query = geocodingAddress(order);
    expect(query).not.toBeNull();
    await client.search(query ?? '');

    const requested = new URL(calls[0] ?? '');
    expect(requested.searchParams.get('q')).toBe('г. Москва, ул. Маленковская, д. 14');
    // Проверяется ВЕСЬ адрес запроса целиком, а не только параметр поиска:
    // деталям неоткуда взяться ни в пути, ни в любом другом параметре.
    const whole = calls[0] ?? '';
    for (const secret of ['Регион', 'Кв.%2Fофис', '55', 'домофон', '107113']) {
      expect(whole, secret).not.toContain(secret);
    }
  });

  it('ключ кэша геокодирования считается от запроса, а не от показанного адреса', () => {
    // Кэш хранится по нормализованному ЗАПРОСУ. Считай он ключ от адреса
    // для человека, одна лишь смена квартиры делала бы промах и оплачивала
    // повторный поиск того же дома.
    const key = normalizeAddress(geocodingAddress(order) ?? '');
    expect(key).not.toContain('55');
    expect(key).not.toContain('домофон');
    expect(key).toBe(normalizeAddress('г. Москва, ул. Маленковская, д. 14'));
  });

  it('решатель не принимает детали ни под каким именем', () => {
    // Запрос VROOM состоит из чисел и индексов. Любая строка, кроме профиля
    // и типа машины, — это утечка, и она отвергается до сети.
    expect(() =>
      assertNumericRequest({ jobs: [{ id: 1, addressDetails: order.addressDetails }] }),
    ).toThrow(VroomError);
    expect(() => assertNumericRequest({ jobs: [{ id: 1, address: order.address }] })).toThrow(
      VroomError,
    );
    expect(() =>
      assertNumericRequest({ jobs: [{ id: 1, description: order.addressDetails }] }),
    ).toThrow(VroomError);
    // А законный запрос по индексам проходит.
    expect(() =>
      assertNumericRequest({
        jobs: [{ id: 1, location_index: 0, service: 300 }],
        vehicles: [{ id: 1, profile: 'car', start_index: 0 }],
      }),
    ).not.toThrow();
  });

  it('ключ матрицы строится от координат: адреса в нём нет вовсе', () => {
    const points = [
      { lat: 55.757997, lon: 37.614069 },
      { lat: 55.751244, lon: 37.618423 },
    ];
    const key = matrixCacheKey({
      graphSha256: 'a'.repeat(64),
      profile: 'CAR',
      trafficMode: 'FREE_FLOW',
      points,
    });

    // Ключ — это дорожный граф, профиль, режим и точки. Ни адреса, ни деталей
    // в нём нет: два заказа с разными квартирами в одном доме считаются
    // одной точкой, и второй раз матрицу за них никто не платит.
    expect(key).toBe(
      matrixCacheKey({
        graphSha256: 'a'.repeat(64),
        profile: 'CAR',
        trafficMode: 'FREE_FLOW',
        points,
      }),
    );
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('расхождение с правкой логиста считается по рабочему адресу источника', async () => {
    const number = unique('CONFLICT');
    const externalId = randomUUID();
    const parts = { city: 'г. Москва', street: 'ул. Маленковская', house: 'д. 14' };
    await importOrder(dto({ externalId, number, address: 'Москва, дом 14', parts }), { v2: true });
    const created = await readOrder(number);

    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    await setLocalAddress(
      { db: ctx.db },
      { userId: logist.id },
      created.id,
      { address: 'Москва, Тверская улица, 1' },
      { ip: null, userAgent: null },
    );

    // В МоёмСкладе поправили квартиру и переписали операционную строку.
    // Дом тот же — расхождения нет, и заказ логиста не беспокоят.
    await importOrder(
      dto({
        externalId,
        number,
        address: 'Москва, дом 14, кв. 55, домофон 42',
        parts: { ...parts, apartment: '55', addInfo: 'домофон 42' },
      }),
      { v2: true },
    );
    const afterDetails = await readOrder(number);
    expect(afterDetails.attentionReasons).not.toContain('ADDRESS_CONFLICT');
    expect(afterDetails.localAddress).toBe('Москва, Тверская улица, 1');

    // А смена ДОМА — это уже расхождение: два адреса разошлись, и выбрать
    // между ними обязан человек.
    await importOrder(
      dto({
        externalId,
        number,
        address: 'Москва, дом 16, кв. 55, домофон 42',
        parts: { ...parts, house: 'д. 16', apartment: '55', addInfo: 'домофон 42' },
      }),
      { v2: true },
    );
    const afterMove = await readOrder(number);
    expect(afterMove.attentionReasons).toContain('ADDRESS_CONFLICT');
    // Правка логиста при этом не затёрта: выбор за ним.
    expect(afterMove.localAddress).toBe('Москва, Тверская улица, 1');
  });
});
