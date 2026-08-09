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
  TEST_SECRETS,
  type TestContext,
} from '../../auth/testing/harness.js';
import { loadConfig, type AppConfig } from '../../../platform/config.js';
import { resolveTestDatabaseUrl } from '../../../platform/testing/test-database.js';
import { SNAPSHOT_FORMAT, alias, type OrdersSnapshot } from '../snapshot-export.js';
import {
  assertNoRealData,
  assertStagingEnvironment,
  importOrdersSnapshot,
  pseudoUuid,
  SnapshotImportError,
} from './import.js';
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
      where: { externalId: pseudoUuid(`k-${marker}-1`) },
    });
    expect(withPoint.geoState).toBe('RESOLVED');
    // Источник строго SYNTHETIC: по нему на любом экране видно, что точка выдумана.
    expect(withPoint.geoSource).toBe('SYNTHETIC');
    expect(withPoint.geoLatMicro).not.toBeNull();

    const withoutPoint = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: pseudoUuid(`k-${marker}-3`) },
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
    expect(second.updated).toBe(2);

    // Заказ один, а не два: ключ снимка устойчиво отображается в идентификатор.
    const orders = await ctx.db.deliveryOrder.findMany({
      where: { externalId: { in: [pseudoUuid(`r-${marker}-1`), pseudoUuid(`r-${marker}-2`)] } },
    });
    expect(orders).toHaveLength(2);

    // Точка та же: псевдоним стабильно отображается в одну и ту же точку.
    const before = orders.map((order) => `${order.geoLatMicro}:${order.geoLonMicro}`);
    await importOrdersSnapshot(ctx.db, envConfig('staging'), snapshot);
    const after = (
      await ctx.db.deliveryOrder.findMany({
        where: { externalId: { in: [pseudoUuid(`r-${marker}-1`), pseudoUuid(`r-${marker}-2`)] } },
      })
    ).map((order) => `${order.geoLatMicro}:${order.geoLonMicro}`);
    expect(after).toEqual(before);
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
      where: { externalId: pseudoUuid(`p-${marker}`) },
    });

    // В адресе — псевдоним и вымышленная подпись, и ничего больше.
    expect(order.address).toContain(`addr-${marker}p`);
    expect(order.address?.toLowerCase()).toContain('синтетическ');
    expect(order.recipient?.startsWith('rcpt-')).toBe(true);
  });
});
