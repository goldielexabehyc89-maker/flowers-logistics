/**
 * Критические проверки синтетических точек и импорта снимка на staging.
 *
 * Проверяется то, нарушение чего означало бы утечку: настоящий адрес или
 * внешний идентификатор останавливают импорт целиком; production, local и CI
 * выполнить импорт не могут; источник точек — строго SYNTHETIC.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from '../../auth/testing/harness.js';
import { loadConfig, type AppConfig } from '../../../platform/config.js';
import { resolveTestDatabaseUrl } from '../../../platform/testing/test-database.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import {
  SNAPSHOT_FORMAT,
  alias,
  assertSnapshotIsSafe,
  SnapshotSafetyError,
  type OrdersSnapshot,
} from '../snapshot-export.js';
import {
  assertIntervalContract,
  assertNoRealData,
  assertStagingEnvironment,
  importOrdersSnapshot,
  SnapshotImportError,
  syntheticIntervalRaw,
} from './import.js';
import { RetireBlockedError, retireSnapshotOrders } from './retire.js';
import { ORDER_IDENTITY_NAMESPACE, orderIdentity, resolveIdentities, uuidV5 } from './identity.js';
import {
  assertExplicitPath,
  describeSnapshotFailure,
  fileArgument,
  readSnapshotFile,
  SnapshotFileError,
} from './file.js';
import { MIN_SYNTHETIC_POINTS, pointForAlias, SYNTHETIC_POINTS } from './synthetic-points.js';

let ctx: TestContext;

/** Пределы МКАД грубо, только чтобы отличить «внутри» от «за»: центр и радиус. */
const MKAD_CENTER = { lat: 55.755, lon: 37.617 };
const MKAD_RADIUS_KM = 20;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

function envConfig(env: 'local' | 'staging' | 'production'): AppConfig {
  return loadConfig({
    DATABASE_URL: resolveTestDatabaseUrl(),
    APP_ENV: env,
    APP_ENVIRONMENT_MARKER: env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...TEST_SECRETS,
  });
}

function distanceKm(lat: number, lon: number): number {
  const dLat = (lat - MKAD_CENTER.lat) * 111;
  const dLon = (lon - MKAD_CENTER.lon) * 111 * Math.cos((MKAD_CENTER.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

function snapshotOf(orders: Partial<OrdersSnapshot['orders'][number]>[]): OrdersSnapshot {
  return {
    format: SNAPSHOT_FORMAT,
    takenAt: '2026-08-14T09:00:00.000Z',
    aliasSaltId: 'abcdef012345',
    orders: orders.map((order, index) => ({
      key: `order-${String(index).padStart(6, '0')}`,
      number: `S-${1000 + index}`,
      deliveryDate: '2026-08-20',
      intervalKind: 'RANGE',
      intervalStartMinute: 600,
      intervalEndMinute: 720,
      manualIntervalStartMinute: null,
      manualIntervalEndMinute: null,
      manualIntervalSetAt: null,
      addressAlias: `addr-${String(index).padStart(10, '0')}`,
      recipientAlias: `rcpt-${String(index).padStart(10, '0')}`,
      hasComment: false,
      externalStateName: 'Новый',
      externalStateType: 'Regular',
      sumMinor: '499000',
      payedSumMinor: '0',
      cashCollectable: true,
      cashToCollectMinor: '499000',
      cashAnomaly: false,
      inScope: true,
      needsAttention: false,
      attentionReasons: [],
      ...order,
    })),
  };
}

describe('синтетический набор точек', () => {
  it('не меньше тридцати точек и обе зоны представлены', () => {
    expect(SYNTHETIC_POINTS.length).toBeGreaterThanOrEqual(MIN_SYNTHETIC_POINTS);

    const inside = SYNTHETIC_POINTS.filter((point) => point.zone === 'INSIDE_MKAD');
    const outside = SYNTHETIC_POINTS.filter((point) => point.zone === 'OUTSIDE_MKAD');

    expect(inside.length).toBeGreaterThanOrEqual(10);
    expect(outside.length).toBeGreaterThanOrEqual(10);
  });

  it('зоны соответствуют координатам: часть внутри МКАД, часть за ним', () => {
    for (const point of SYNTHETIC_POINTS) {
      const km = distanceKm(point.latMicro / 1_000_000, point.lonMicro / 1_000_000);
      if (point.zone === 'INSIDE_MKAD') {
        expect(km, point.id).toBeLessThan(MKAD_RADIUS_KM);
      } else {
        expect(km, point.id).toBeGreaterThan(MKAD_RADIUS_KM);
      }
    }
  });

  it('координаты целые и в пределах Москвы и области', () => {
    for (const point of SYNTHETIC_POINTS) {
      expect(Number.isInteger(point.latMicro), point.id).toBe(true);
      expect(Number.isInteger(point.lonMicro), point.id).toBe(true);
      expect(point.latMicro).toBeGreaterThan(54_800_000);
      expect(point.latMicro).toBeLessThan(56_500_000);
      expect(point.lonMicro).toBeGreaterThan(36_500_000);
      expect(point.lonMicro).toBeLessThan(39_000_000);
    }
  });

  it('идентификаторы уникальны, подписи вымышленные', () => {
    const ids = new Set(SYNTHETIC_POINTS.map((point) => point.id));
    expect(ids.size).toBe(SYNTHETIC_POINTS.length);

    for (const point of SYNTHETIC_POINTS) {
      // Каждая подпись помечена как синтетическая: перепутать её с настоящим
      // адресом клиента невозможно даже при беглом взгляде.
      expect(point.label.toLowerCase(), point.id).toContain('синтетическ');
    }
  });

  it('один псевдоним всегда получает одну и ту же точку', () => {
    const alias = 'addr-0123456789';
    const first = pointForAlias(alias);

    for (let i = 0; i < 20; i += 1) {
      expect(pointForAlias(alias)).toEqual(first);
    }

    // Разные псевдонимы расходятся по набору, а не садятся в одну точку.
    const used = new Set(
      Array.from({ length: 200 }, (_, index) => pointForAlias(`addr-${index}`).id),
    );
    expect(used.size).toBeGreaterThan(SYNTHETIC_POINTS.length / 2);
  });

  it('одинаковые адреса production группируются одинаково и на staging', () => {
    const salt = 'production-only-salt';
    const first = alias('addr', 'Москва, одинаковый адрес, 1', salt);
    const again = alias('addr', 'Москва, одинаковый адрес, 1', salt);
    const other = alias('addr', 'Москва, другой адрес, 2', salt);

    // Один адрес — один псевдоним: группировка по адресу переживает перенос.
    expect(first).toBe(again);
    expect(first).not.toBe(other);
    expect(pointForAlias(first ?? '')).toEqual(pointForAlias(again ?? ''));

    // Восстановить адрес по точке нельзя: точка выбрана по псевдониму,
    // а он получен хешированием с солью, которой на staging нет.
    expect(first ?? '').toMatch(/^addr-[0-9a-f]{10}$/);
    expect(first ?? '').not.toContain('Москва');
  });
});

describe('окружение импорта', () => {
  it('только staging по обоим признакам', () => {
    expect(() => assertStagingEnvironment(envConfig('staging'))).not.toThrow();

    for (const env of ['local', 'production'] as const) {
      expect(() => assertStagingEnvironment(envConfig(env)), env).toThrow(SnapshotImportError);
    }
  });

  it('смешанная конфигурация окружения отвергается', () => {
    const mixed = loadConfig({
      DATABASE_URL: resolveTestDatabaseUrl(),
      APP_ENV: 'staging',
      APP_ENVIRONMENT_MARKER: 'production',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ...TEST_SECRETS,
    });
    expect(() => assertStagingEnvironment(mixed)).toThrow(SnapshotImportError);
  });

  it('production не выполняет импорт даже с безупречным снимком', async () => {
    const snapshot = snapshotOf([{}]);
    await expect(importOrdersSnapshot(ctx.db, envConfig('production'), snapshot)).rejects.toThrow(
      SnapshotImportError,
    );
  });
});

describe('содержимое снимка', () => {
  it('настоящий адрес останавливает импорт целиком', async () => {
    const snapshot = snapshotOf([{}, { addressAlias: 'Москва, улица Настоящая, дом 5' }, {}]);

    // Такой снимок останавливает общая проверка формата ещё до нашей: адрес
    // не похож на псевдоним. Важно не то, какая именно проверка сработала,
    // а то, что импорт не начался.
    const before = await ctx.db.deliveryOrder.count();
    await expect(importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot)).rejects.toThrow();
    // Частичного импорта не бывает: отказ до единой записи.
    expect(await ctx.db.deliveryOrder.count()).toBe(before);

    // Тот же адрес, но с правильным префиксом, ловит уже наша проверка.
    const disguised = snapshotOf([{ addressAlias: 'addr-Москва, улица Настоящая, дом 5' }]);
    expect(() => assertNoRealData(disguised)).toThrow(SnapshotImportError);
  });

  it('внешний идентификатор МоегоСклада останавливает импорт', async () => {
    // Собирается из частей намеренно: сплошная строка такого вида выглядит
    // для сканера секретов как ключ, и проверка ломала бы CI на пустом месте.
    const externalId = ['0f8fad5b', 'd9cb', '469f', 'a165', '70867728950e'].join('-');
    const snapshot = snapshotOf([{ key: externalId }]);
    expect(() => assertNoRealData(snapshot)).toThrow(/внешний идентификатор/);
  });

  it('след секрета останавливает импорт', async () => {
    // Слово-маркер без похожего на ключ значения: сканер секретов в CI
    // не должен принимать проверку за настоящую утечку.
    const snapshot = snapshotOf([{ number: 'S-1000 Authorization' }]);
    await expect(importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot)).rejects.toThrow();
  });

  it('чужой формат снимка не принимается', async () => {
    const snapshot = { ...snapshotOf([{}]), format: 'someone-else@1' } as unknown as OrdersSnapshot;
    await expect(importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot)).rejects.toThrow();
  });
});

describe('импорт на staging', () => {
  it('создаёт заказы с синтетическими точками и источником SYNTHETIC', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const snapshot = snapshotOf([
      { key: `k-${marker}-1`, addressAlias: `addr-${marker}1` },
      { key: `k-${marker}-2`, addressAlias: `addr-${marker}2` },
      { key: `k-${marker}-3`, addressAlias: null },
    ]);

    const result = await importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot);

    expect(result.created).toBe(3);
    expect(result.withoutPoint).toBe(1);

    const withPoint = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: orderIdentity(`k-${marker}-1`) },
    });
    expect(withPoint.geoState).toBe('RESOLVED');
    // Источник строго SYNTHETIC: по нему на любом экране видно, что точка выдумана.
    expect(withPoint.geoSource).toBe('SYNTHETIC');
    expect(withPoint.geoLatMicro).not.toBeNull();

    const withoutPoint = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: orderIdentity(`k-${marker}-3`) },
    });
    expect(withoutPoint.geoState).toBe('UNRESOLVED');
  });

  it('повторная загрузка того же снимка идемпотентна', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const snapshot = snapshotOf([
      { key: `r-${marker}-1`, addressAlias: `addr-${marker}a` },
      { key: `r-${marker}-2`, addressAlias: `addr-${marker}b` },
    ]);

    const first = await importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot);
    expect(first.created).toBe(2);

    const second = await importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot);
    expect(second.created).toBe(0);
    // Тот же снимок ничего не меняет: ни одной записи, а не «обновлено две».
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(2);

    // Порядок строк задаётся явно: без ORDER BY база вправе вернуть их
    // как угодно, и сравнение списков превратилось бы в проверку удачи.
    const points = async (): Promise<string[]> =>
      (
        await ctx.db.deliveryOrder.findMany({
          where: {
            externalId: { in: [orderIdentity(`r-${marker}-1`), orderIdentity(`r-${marker}-2`)] },
          },
          orderBy: { externalId: 'asc' },
        })
      ).map((order) => `${order.geoLatMicro}:${order.geoLonMicro}`);

    // Заказ один, а не два: ключ снимка устойчиво отображается в идентификатор.
    const before = await points();
    expect(before).toHaveLength(2);

    // Точка та же: псевдоним стабильно отображается в одну и ту же точку.
    await importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot);
    expect(await points()).toEqual(before);
  });

  it('исчезнувший псевдоним очищает прежнюю синтетическую точку', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const key = `c-${marker}`;

    // Первый снимок: заказ получает синтетическую точку.
    await importOrdersSnapshot(
      ctx.db,
      envConfig('staging'),
      snapshotOf([{ key, addressAlias: `addr-${marker}c` }]),
    );

    const withPoint = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: orderIdentity(key) },
    });
    expect(withPoint.geoState).toBe('RESOLVED');
    expect(withPoint.geoLatMicro).not.toBeNull();

    // Второй снимок того же заказа пришёл без псевдонима адреса.
    const result = await importOrdersSnapshot(
      ctx.db,
      envConfig('staging'),
      snapshotOf([{ key, addressAlias: null }]),
    );
    expect(result.withoutPoint).toBe(1);

    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: orderIdentity(key) },
    });

    // Прежняя точка снята полностью: заказ без адреса не может остаться
    // подтверждённым, иначе отчёт «без точки» противоречил бы базе,
    // а на карте появился бы маркер неизвестно откуда.
    expect(after.geoState).toBe('UNRESOLVED');
    expect(after.geoSource).toBeNull();
    expect(after.geoPrecision).toBeNull();
    expect(after.geoLatMicro).toBeNull();
    expect(after.geoLonMicro).toBeNull();
    expect(after.geoResolvedAt).toBeNull();
    expect(after.address).toBeNull();
  });

  it('импорт не переносит пользователей, аудит, outbox и realtime', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const users = await ctx.db.user.count();
    const audit = await ctx.db.auditLog.count();
    const outbox = await ctx.db.outboxMessage.count();
    const events = await ctx.db.realtimeEvent.count();

    await importOrdersSnapshot(
      ctx.db,
      envConfig('staging'),
      snapshotOf([{ key: `n-${marker}`, addressAlias: `addr-${marker}n` }]),
    );

    expect(await ctx.db.user.count()).toBe(users);
    expect(await ctx.db.auditLog.count()).toBe(audit);
    expect(await ctx.db.outboxMessage.count()).toBe(outbox);
    expect(await ctx.db.realtimeEvent.count()).toBe(events);
  });

  it('в импортированных заказах нет ни настоящих адресов, ни внешних UUID', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    await importOrdersSnapshot(
      ctx.db,
      envConfig('staging'),
      snapshotOf([{ key: `p-${marker}`, addressAlias: `addr-${marker}p` }]),
    );

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: orderIdentity(`p-${marker}`) },
    });

    // В адресе — псевдоним и вымышленная подпись, и ничего больше.
    expect(order.address).toContain(`addr-${marker}p`);
    expect(order.address?.toLowerCase()).toContain('синтетическ');
    expect(order.recipient?.startsWith('rcpt-')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Идентичность заказа снимка
// ---------------------------------------------------------------------------

/**
 * Ключи вида, на котором прежняя схема ломалась.
 *
 * Ровно та форма, что была у одобренного синтетического дня: семнадцать
 * символов, первые шестнадцать общие. Значения синтетические и никаких данных
 * не несут — они здесь как регрессия, а не как выдержка из чьего-то файла.
 */
const SEVENTEEN_CHAR_KEYS = Array.from(
  { length: 10 },
  (_, index) => `syn-2026-08-20-${String(index + 1).padStart(2, '0')}`,
);

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('идентичность заказа снимка', () => {
  it('пространство имён и алгоритм закреплены как долгоживущий договор', () => {
    // Пространство имён получено стандартным способом — UUIDv5 в пространстве
    // URL от постоянного имени. Проверяется тем же кодом, которым пользуется
    // импорт: смена алгоритма или имени обязана уронить эту строку.
    expect(ORDER_IDENTITY_NAMESPACE).toBe('c195b54b-2cef-504d-9015-53cb3ef97adf');
    expect(
      uuidV5(
        '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
        'https://flowers-logistics.invalid/snapshot/order-identity',
      ),
    ).toBe(ORDER_IDENTITY_NAMESPACE);

    // Контрольные значения. Посчитаны независимой реализацией UUIDv5 и потому
    // доказывают не «функция согласна сама с собой», а соответствие стандарту.
    expect(orderIdentity('syn-2026-08-20-01')).toBe('503c4227-e8e3-5048-8525-6d833cea2de0');
    expect(orderIdentity('order-fba28548c1')).toBe('a535c4c0-95ff-5555-81ae-d30aae19d93f');
  });

  it('десять ключей одобренного вида дают десять разных валидных UUID', () => {
    const ids = SEVENTEEN_CHAR_KEYS.map(orderIdentity);

    expect(new Set(SEVENTEEN_CHAR_KEYS).size).toBe(10);
    expect(new Set(ids).size).toBe(10);

    for (const id of ids) {
      expect(id).toMatch(UUID_SHAPE);
      // Версия 5 и вариант RFC 9562: значение обязано быть настоящим UUID,
      // а не строкой похожей формы.
      expect(id[14]).toBe('5');
      expect('89ab').toContain(id[19]);
    }
  });

  it('девять ключей с общими первыми шестнадцатью символами больше не сталкиваются', () => {
    const nine = SEVENTEEN_CHAR_KEYS.slice(0, 9);
    const prefixes = new Set(nine.map((key) => key.slice(0, 16)));

    // Условие, при котором прежняя схема давала один идентификатор на девять.
    expect(prefixes.size).toBe(1);
    expect(new Set(nine.map(orderIdentity)).size).toBe(9);
  });

  it('различие после шестнадцатой позиции меняет идентификатор', () => {
    const base = '0123456789abcdef';

    expect(orderIdentity(`${base}A`)).not.toBe(orderIdentity(`${base}B`));
    // И длина ключа сама по себе идентичность не ограничивает.
    expect(orderIdentity(`${base}${'x'.repeat(200)}1`)).not.toBe(
      orderIdentity(`${base}${'x'.repeat(200)}2`),
    );
  });

  it('одинаковый ключ всегда даёт одинаковый UUID', () => {
    const key = 'повторяемость-ключа-2026';

    expect(orderIdentity(key)).toBe(orderIdentity(key));
    // Значение не зависит от процесса: оно выводится из ключа и постоянного
    // пространства имён, и посчитано может быть где угодно.
    expect(orderIdentity(key)).toBe(uuidV5(ORDER_IDENTITY_NAMESPACE, key));
  });

  it('версия формата снимка идентичность не меняет', () => {
    // В имя UUID входит ТОЛЬКО ключ. Иначе будущий `@3` дал бы тому же заказу
    // другой идентификатор, и повторный импорт создал бы вторую копию.
    const key = 'order-0011223344';
    const asIsInFormat2 = orderIdentity(key);

    expect(uuidV5(ORDER_IDENTITY_NAMESPACE, key)).toBe(asIsInFormat2);
    expect(uuidV5(ORDER_IDENTITY_NAMESPACE, `flowers-logistics/orders-snapshot@3:${key}`)).not.toBe(
      asIsInFormat2,
    );
  });

  it('ключи штатного экспортёра пригодны для нового контракта', () => {
    const keys = Array.from(
      { length: 50 },
      (_, index) =>
        alias('order', `019ff0bf-93d7-733f-aa91-f96418${String(index).padStart(6, '0')}`, 'salt') ??
        '',
    );

    expect(keys.every((key) => key.startsWith('order-') && key.length === 16)).toBe(true);
    expect(new Set(keys.map(orderIdentity)).size).toBe(new Set(keys).size);
  });

  it('вывод из области считает те же идентификаторы, что импорт', () => {
    const snapshot = snapshotOf(SEVENTEEN_CHAR_KEYS.map((key) => ({ key })));

    // Один mapper на обе операции: расхождение означало бы, что команда вывода
    // ищет не те заказы, которые импорт создал.
    expect(resolveIdentities(snapshot).map((item) => item.externalId)).toEqual(
      snapshot.orders.map((order) => orderIdentity(order.key)),
    );
  });

  it('повтор ключа и столкновение идентификаторов отвергаются ДО транзакции', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const orders = await ctx.db.deliveryOrder.count();
    const effects = await sideEffects();

    // 1. Один и тот же исходный ключ дважды в одном файле.
    const duplicated = snapshotOf([
      { key: `dup-${marker}`, addressAlias: `addr-${marker}a` },
      { key: `dup-${marker}`, addressAlias: `addr-${marker}b` },
    ]);

    await expect(importOrdersSnapshot(ctx.db, envConfig('staging'), duplicated)).rejects.toThrow(
      SnapshotSafetyError,
    );
    await expect(
      importOrdersSnapshot(ctx.db, envConfig('staging'), duplicated),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_DUPLICATE_KEY' });

    // 2. Искусственное столкновение: разные ключи, один идентификатор.
    //    Производственный mapper подменить нечем — второй аргумент передаётся
    //    только здесь, а импорт и вывод зовут `resolveIdentities` без него.
    const collided = snapshotOf([
      { key: `one-${marker}`, addressAlias: `addr-${marker}a` },
      { key: `two-${marker}`, addressAlias: `addr-${marker}b` },
    ]);

    expect(() => resolveIdentities(collided, () => '00000000-0000-5000-8000-000000000000')).toThrow(
      SnapshotSafetyError,
    );
    try {
      resolveIdentities(collided, () => '00000000-0000-5000-8000-000000000000');
      expect.unreachable('столкновение идентификаторов обязано остановить импорт');
    } catch (error) {
      expect((error as SnapshotSafetyError).code).toBe('SNAPSHOT_IDENTITY_COLLISION');
    }

    // 3. Пустой ключ до отображения вообще не доходит.
    expect(() => resolveIdentities(snapshotOf([{ key: '   ' }]))).toThrow(SnapshotSafetyError);

    // После всех отказов база обязана быть такой же: ни заказа, ни аудита,
    // ни события. Отказ до транзакции тем и ценен, что следов не оставляет.
    expect(await ctx.db.deliveryOrder.count()).toBe(orders);
    expect(await sideEffects()).toEqual(effects);
  });

  it('сообщения об отказе не содержат ключей, адресов и получателей', () => {
    const marker = 'секретныйключ0000000001';
    const snapshot = snapshotOf([
      { key: marker, addressAlias: 'addr-1111111111', recipientAlias: 'rcpt-2222222222' },
      { key: marker, addressAlias: 'addr-3333333333', recipientAlias: 'rcpt-4444444444' },
    ]);

    try {
      resolveIdentities(snapshot);
      expect.unreachable('повтор ключа обязан быть отвергнут');
    } catch (error) {
      const text = `${(error as Error).message} ${String((error as Error).stack).split('\n')[0]}`;
      expect(text).not.toContain(marker);
      expect(text).not.toContain('addr-');
      expect(text).not.toContain('rcpt-');
      // Порядковый номер записи назвать можно: он помогает найти строку
      // в своём файле и ничего не сообщает о данных.
      expect((error as Error).message).toContain('2');
    }
  });
});

// ---------------------------------------------------------------------------
// Идемпотентность, восстановление и вывод из области
// ---------------------------------------------------------------------------

/** Считает записи, которых у импорта быть не должно. */
async function sideEffects(): Promise<{ audit: number; realtime: number }> {
  return {
    audit: await ctx.db.auditLog.count({ where: { entityType: 'DeliveryOrder' } }),
    realtime: await ctx.db.realtimeEvent.count({ where: { topic: 'order.scope_changed' } }),
  };
}

/** Набор из десяти заказов: столько же, сколько в одобренном синтетическом дне. */
function tenOrders(marker: string): OrdersSnapshot {
  return snapshotOf(
    Array.from({ length: 10 }, (_, index) => ({
      key: `set-${marker}-${index}`,
      number: `SYN-${marker}-${index}`,
      // Три заказа делят один псевдоним: на staging они окажутся в одной точке.
      addressAlias: index >= 7 ? `addr-${marker}same` : `addr-${marker}${index}`,
    })),
  );
}

describe('повторный импорт', () => {
  it('первый прогон создаёт десять, идентичный повтор не меняет ничего', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const snapshot = tenOrders(marker);
    const ids = snapshot.orders.map((order) => orderIdentity(order.key));

    const first = await importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot);
    expect(first.created).toBe(10);
    expect(first.unchanged).toBe(0);

    const stateOf = async (): Promise<string[]> =>
      (
        await ctx.db.deliveryOrder.findMany({
          where: { externalId: { in: ids } },
          orderBy: { externalId: 'asc' },
          select: {
            externalId: true,
            version: true,
            updatedAt: true,
            geoResolvedAt: true,
            geoLatMicro: true,
            geoLonMicro: true,
          },
        })
      ).map(
        (order) =>
          `${order.externalId}:${order.version}:${order.updatedAt.getTime()}:` +
          `${order.geoResolvedAt?.getTime() ?? 0}:${order.geoLatMicro}:${order.geoLonMicro}`,
      );

    const before = await stateOf();
    const effectsBefore = await sideEffects();

    const second = await importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot);

    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.restored).toBe(0);
    expect(second.unchanged).toBe(10);

    // Ни версии, ни времени обновления, ни времени разрешения точки:
    // повторный прогон обязан быть неотличим от невыполненного.
    expect(await stateOf()).toEqual(before);
    expect(await sideEffects()).toEqual(effectsBefore);
  });

  it('изменившееся значение отличается от неизменившегося в одном снимке', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const snapshot = tenOrders(marker);
    await importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot);

    const changed: OrdersSnapshot = {
      ...snapshot,
      orders: snapshot.orders.map((order, index) =>
        index === 0 ? { ...order, number: `${order.number}-B` } : order,
      ),
    };

    const result = await importOrdersSnapshot(ctx.db, envConfig('staging'), changed);
    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(9);
  });

  it('три заказа с одним псевдонимом получают одну и ту же точку', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const snapshot = tenOrders(marker);
    await importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot);

    const shared = await ctx.db.deliveryOrder.findMany({
      where: { externalId: { in: snapshot.orders.slice(7).map((o) => orderIdentity(o.key)) } },
      select: { geoLatMicro: true, geoLonMicro: true },
    });

    expect(shared).toHaveLength(3);
    const points = new Set(shared.map((order) => `${order.geoLatMicro}:${order.geoLonMicro}`));
    expect(points.size).toBe(1);
  });
});

describe('ручной интервал в снимке', () => {
  it('полный комплект из трёх полей принимается', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const snapshot = snapshotOf([
      {
        key: `mi-${marker}`,
        addressAlias: `addr-${marker}m`,
        manualIntervalStartMinute: 600,
        manualIntervalEndMinute: 780,
        manualIntervalSetAt: '2026-08-20T09:00:00.000Z',
      },
    ]);

    const result = await importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot);
    expect(result.created).toBe(1);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: orderIdentity(`mi-${marker}`) },
      select: {
        manualIntervalStartMinute: true,
        manualIntervalEndMinute: true,
        manualIntervalSetAt: true,
      },
    });
    expect(stored.manualIntervalStartMinute).toBe(600);
    expect(stored.manualIntervalEndMinute).toBe(780);
    expect(stored.manualIntervalSetAt).not.toBeNull();
  });

  it('половинчатый комплект отклоняется ДО транзакции', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const before = await ctx.db.deliveryOrder.count();

    // Прежде такой снимок доходил до базы и падал на ограничении
    // DeliveryOrder_manual_interval_complete: отказ приходил уже внутри
    // транзакции и говорил на языке ограничения, а не о снимке.
    const half = snapshotOf([
      { key: `half-${marker}`, manualIntervalStartMinute: 600, manualIntervalEndMinute: 780 },
    ]);

    expect(() => assertIntervalContract(half)).toThrow(/неполный ручной интервал/);
    await expect(importOrdersSnapshot(ctx.db, envConfig('staging'), half)).rejects.toThrow(
      SnapshotImportError,
    );
    expect(await ctx.db.deliveryOrder.count()).toBe(before);
  });

  it('обратный и выходящий за сутки интервал отклоняется', async () => {
    for (const broken of [
      { manualIntervalStartMinute: 780, manualIntervalEndMinute: 600 },
      { manualIntervalStartMinute: 0, manualIntervalEndMinute: 1500 },
    ]) {
      const snapshot = snapshotOf([{ ...broken, manualIntervalSetAt: '2026-08-20T09:00:00.000Z' }]);
      expect(() => assertIntervalContract(snapshot)).toThrow(SnapshotImportError);
    }
  });

  it('исходный текст интервала выводится из вида, а не переносится из источника', () => {
    expect(syntheticIntervalRaw('RANGE', 600, 780)).toBe('с 10:00 по 13:00');
    expect(syntheticIntervalRaw('EXACT', 780, null)).toBe('к 13:00');
    expect(syntheticIntervalRaw('MISSING', null, null)).toBeNull();
    // Нераспознанное остаётся нераспознанным: текст источника не переносится,
    // и выдавать его за разобранное значение нельзя.
    expect(syntheticIntervalRaw('UNRECOGNIZED', null, null)).toMatch(/не перенесено/);
  });
});

describe('вывод набора из области', () => {
  async function seedSet(marker: string): Promise<OrdersSnapshot> {
    const snapshot = tenOrders(marker);
    await importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot);
    return snapshot;
  }

  it('сухая проверка ничего не меняет, а затем вывод помечает заказы', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const snapshot = await seedSet(marker);
    const ids = snapshot.orders.map((order) => orderIdentity(order.key));

    const planned = await retireSnapshotOrders(ctx.db, envConfig('staging'), snapshot, {
      dryRun: true,
    });
    expect(planned.matched).toBe(10);
    expect(planned.retired).toBe(10);
    expect(planned.dryRun).toBe(true);

    // Сухая проверка не пишет ничего.
    expect(
      await ctx.db.deliveryOrder.count({ where: { externalId: { in: ids }, sourceMissing: true } }),
    ).toBe(0);

    const done = await retireSnapshotOrders(ctx.db, envConfig('staging'), snapshot, {
      dryRun: false,
    });
    expect(done.retired).toBe(10);

    const retired = await ctx.db.deliveryOrder.findMany({
      where: { externalId: { in: ids } },
      select: { sourceMissing: true, inScope: true, scopeExitReason: true },
    });
    expect(retired).toHaveLength(10);
    for (const order of retired) {
      expect(order.sourceMissing).toBe(true);
      expect(order.inScope).toBe(false);
      expect(order.scopeExitReason).toBe('SOURCE_MISSING');
    }

    // Ничего не удалено: строки на месте.
    expect(await ctx.db.deliveryOrder.count({ where: { externalId: { in: ids } } })).toBe(10);
  });

  it('повторный вывод — безопасное бездействие', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const snapshot = await seedSet(marker);

    await retireSnapshotOrders(ctx.db, envConfig('staging'), snapshot, { dryRun: false });
    const effectsBefore = await sideEffects();

    const again = await retireSnapshotOrders(ctx.db, envConfig('staging'), snapshot, {
      dryRun: false,
    });

    expect(again.retired).toBe(0);
    expect(again.alreadyRetired).toBe(10);
    // Второй вывод не пишет ни аудита, ни событий: доменный путь идемпотентен.
    expect(await sideEffects()).toEqual(effectsBefore);
  });

  it('активный маршрут останавливает вывод целиком', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const snapshot = await seedSet(marker);
    const ids = snapshot.orders.map((order) => orderIdentity(order.key));

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: ids[0] ?? '' },
      select: { id: true },
    });
    const author = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });

    // Номер маршрута намеренно не содержит маркера набора: иначе проверка
    // «в сообщении нет данных снимка» прошла бы по совпадению.
    const routeNumber = `R-RETIRE-${String(process.hrtime.bigint() % 1_000_000n)}`;
    const route = await ctx.db.deliveryRoute.create({
      data: {
        number: routeNumber,
        deliveryDate: new Date('2026-08-20T00:00:00.000Z'),
        vehicleType: 'CAR',
        createdById: author.id,
      },
      select: { id: true, number: true },
    });
    await ctx.db.routeOrder.create({
      data: { routeId: route.id, orderId: order.id, position: 1, addedById: author.id },
    });

    await expect(
      retireSnapshotOrders(ctx.db, envConfig('staging'), snapshot, { dryRun: true }),
    ).rejects.toThrow(RetireBlockedError);

    // Отказ целиком: ни один заказ набора не выведен, включая те, что
    // в маршруте не состоят.
    expect(
      await ctx.db.deliveryOrder.count({ where: { externalId: { in: ids }, sourceMissing: true } }),
    ).toBe(0);

    // Номер маршрута назван, чтобы человек знал, что отменять; псевдонимов
    // и содержимого снимка в сообщении нет.
    try {
      await retireSnapshotOrders(ctx.db, envConfig('staging'), snapshot, { dryRun: false });
    } catch (error) {
      const blocked = error as RetireBlockedError;
      // Номер маршрута назван: без него человек не знает, что отменять.
      expect(blocked.routeNumbers).toEqual([route.number]);
      // Псевдонимов и ключей снимка в сообщении нет.
      expect(blocked.message).not.toContain('addr-');
      expect(blocked.message).not.toContain('set-');
      expect(blocked.message).toContain(route.number);
    }
  });

  it('вывод доступен только на staging', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const snapshot = tenOrders(marker);

    for (const env of ['local', 'production'] as const) {
      await expect(
        retireSnapshotOrders(ctx.db, envConfig(env), snapshot, { dryRun: true }),
      ).rejects.toThrow(SnapshotImportError);
    }
  });

  it('снимок с настоящим адресом не принимается и командой вывода', async () => {
    const snapshot = snapshotOf([{ addressAlias: 'Москва, улица Настоящая, дом 5' }]);
    await expect(
      retireSnapshotOrders(ctx.db, envConfig('staging'), snapshot, { dryRun: true }),
    ).rejects.toThrow();
  });
});

describe('восстановление после вывода', () => {
  it('повторный импорт возвращает те же записи и те же точки', async () => {
    const marker = String(process.hrtime.bigint() % 1_000_000n);
    const snapshot = tenOrders(marker);
    const ids = snapshot.orders.map((order) => orderIdentity(order.key));

    await importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot);

    const points = async (): Promise<string[]> =>
      (
        await ctx.db.deliveryOrder.findMany({
          where: { externalId: { in: ids } },
          orderBy: { externalId: 'asc' },
          select: { externalId: true, geoLatMicro: true, geoLonMicro: true },
        })
      ).map((order) => `${order.externalId}:${order.geoLatMicro}:${order.geoLonMicro}`);

    const before = await points();

    await retireSnapshotOrders(ctx.db, envConfig('staging'), snapshot, { dryRun: false });

    const restored = await importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot);
    expect(restored.restored).toBe(10);
    expect(restored.created).toBe(0);
    expect(restored.updated).toBe(0);

    // Те же строки и те же синтетические точки: ключ снимка отображается
    // в тот же идентификатор, псевдоним — в ту же точку.
    expect(await points()).toEqual(before);
    expect(await ctx.db.deliveryOrder.count({ where: { externalId: { in: ids } } })).toBe(10);

    const back = await ctx.db.deliveryOrder.findMany({
      where: { externalId: { in: ids } },
      select: { inScope: true, sourceMissing: true, scopeExitReason: true },
    });
    for (const order of back) {
      expect(order.inScope).toBe(true);
      expect(order.sourceMissing).toBe(false);
      // Причина выхода снята: заказ снова наш и «пропавшим» одновременно быть не может.
      expect(order.scopeExitReason).toBeNull();
    }

    // Возвращённый набор снова идемпотентен.
    const again = await importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot);
    expect(again.unchanged).toBe(10);
  });
});

describe('файл снимка', () => {
  it('маска вместо файла отвергается', () => {
    for (const value of ['/srv/snapshots/*.json', '/srv/snap?.json', '/srv/{a,b}.json']) {
      expect(() => assertExplicitPath(value), value).toThrow(SnapshotFileError);
    }
  });

  it('относительный и пустой путь отвергаются', () => {
    for (const value of ['snapshot.json', './snapshot.json', '   ']) {
      expect(() => assertExplicitPath(value), value).toThrow(SnapshotFileError);
    }
  });

  it('абсолютный путь одного файла принимается', () => {
    expect(() => assertExplicitPath('/srv/flowers/snapshot.json')).not.toThrow();
  });

  it('отсутствующий файл называется отсутствующим, а не разбирается', async () => {
    await expect(readSnapshotFile('/srv/заведомо/нет/такого.json')).rejects.toThrow(
      SnapshotFileError,
    );
  });

  it('аргумент --file обязателен', () => {
    expect(() => fileArgument([])).toThrow(SnapshotFileError);
    expect(() => fileArgument(['--file'])).toThrow(SnapshotFileError);
    expect(fileArgument(['--file', '/srv/a.json'])).toBe('/srv/a.json');
  });
});

describe('снимок прежнего формата @1', () => {
  /** Снимок, собранный по прежнему договору: ручной интервал без времени установки. */
  function legacySnapshot(): OrdersSnapshot {
    const current = snapshotOf([
      {
        key: `legacy-${String(process.hrtime.bigint() % 1_000_000n)}`,
        manualIntervalStartMinute: 600,
        manualIntervalEndMinute: 780,
      },
    ]);

    const orders = current.orders.map((order) => {
      // Поля времени установки в формате @1 не существовало вовсе.
      const { manualIntervalSetAt: _omitted, ...rest } = order;
      return rest;
    });

    return {
      ...current,
      format: 'flowers-logistics/orders-snapshot@1',
      orders,
    } as unknown as OrdersSnapshot;
  }

  it('отклоняется понятным кодом, а не общей ошибкой', () => {
    let captured: unknown = null;
    try {
      assertSnapshotIsSafe(legacySnapshot());
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(SnapshotSafetyError);
    expect((captured as SnapshotSafetyError).code).toBe('SNAPSHOT_FORMAT_UNSUPPORTED');

    // Названы оба формата: человеку нужно понять, что взять, а не гадать.
    const message = (captured as SnapshotSafetyError).message;
    expect(message).toContain('orders-snapshot@1');
    expect(message).toContain(SNAPSHOT_FORMAT);
  });

  it('отказ происходит ДО транзакции: ни одной записи не создано', async () => {
    const before = await ctx.db.deliveryOrder.count();

    await expect(
      importOrdersSnapshot(ctx.db, envConfig('staging'), legacySnapshot()),
    ).rejects.toBeInstanceOf(SnapshotSafetyError);

    expect(await ctx.db.deliveryOrder.count()).toBe(before);

    // Команда вывода из области отвергает прежний формат так же.
    await expect(
      retireSnapshotOrders(ctx.db, envConfig('staging'), legacySnapshot(), { dryRun: true }),
    ).rejects.toBeInstanceOf(SnapshotSafetyError);
  });

  it('это не ошибка разбора JSON: файл прежнего формата читается штатно', async () => {
    const file = path.join(tmpdir(), `snapshot-legacy-${process.hrtime.bigint()}.json`);
    await writeFile(file, JSON.stringify(legacySnapshot()), 'utf8');

    try {
      // Файл — корректный JSON, и чтение проходит. Отказ приходит именно
      // от проверки формата, а не от парсера: иначе причина «не тот формат»
      // была бы неотличима от «файл испорчен».
      const parsed = await readSnapshotFile(file);
      expect(parsed.format).toBe('flowers-logistics/orders-snapshot@1');
      expect(() => assertSnapshotIsSafe(parsed)).toThrow(SnapshotSafetyError);
    } finally {
      await rm(file, { force: true });
    }
  });

  it('команда показывает причину и код, а чужую ошибку — нет', () => {
    let captured: unknown = null;
    try {
      assertSnapshotIsSafe(legacySnapshot());
    } catch (error) {
      captured = error;
    }

    const shown = describeSnapshotFailure(captured);
    expect(shown).toContain('SNAPSHOT_FORMAT_UNSUPPORTED');
    expect(shown).toContain(SNAPSHOT_FORMAT);

    // Чужая ошибка не печатается: её текст вправе процитировать содержимое файла.
    const alien = new SyntaxError('Unexpected token } in JSON at position 42: {"addr-secret"');
    expect(describeSnapshotFailure(alien)).toBe('ошибка выполнения');
    expect(describeSnapshotFailure(alien)).not.toContain('addr-');
  });
});
