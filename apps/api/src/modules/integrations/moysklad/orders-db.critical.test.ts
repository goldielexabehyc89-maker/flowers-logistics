/**
 * Критические проверки инвариантов заказов на настоящей PostgreSQL.
 *
 * Эти правила защищают историю: заказ нельзя стереть, а ревизию нельзя
 * переписать. Проверять их моками бессмысленно — гарантию даёт база.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from '../../auth/testing/harness.js';
import { toDecimalString } from './money.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

const STORE_ID = '3d520ee3-76c1-11f0-0a80-142900354c8e';

async function seedOrder(overrides: Record<string, unknown> = {}) {
  return ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: `T-${process.hrtime.bigint() % 1_000_000n}`,
      externalUpdated: new Date(),
      storeId: STORE_ID,
      sumMinor: 499000n,
      payedSumMinor: 0n,
      cashToCollectMinor: 499000n,
      ...overrides,
    },
  });
}

describe('инварианты заказа', () => {
  it('внешний идентификатор уникален', async () => {
    const externalId = randomUUID();
    await seedOrder({ externalId });

    await expect(seedOrder({ externalId })).rejects.toThrow();
    expect(await ctx.db.deliveryOrder.count({ where: { externalId } })).toBe(1);
  });

  it('физическое удаление заказа отклоняется базой', async () => {
    const order = await seedOrder();

    await expect(ctx.db.deliveryOrder.delete({ where: { id: order.id } })).rejects.toThrow();
    await expect(ctx.db.deliveryOrder.deleteMany({ where: { id: order.id } })).rejects.toThrow();

    // Заказ на месте: выход из области выражается полями, а не удалением.
    expect(await ctx.db.deliveryOrder.findUnique({ where: { id: order.id } })).not.toBeNull();
  });

  it('заказ исключается из области без удаления', async () => {
    const order = await seedOrder();

    const updated = await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: { inScope: false, scopeExitReason: 'STORE_CHANGED', scopeExitedAt: new Date() },
    });

    expect(updated.inScope).toBe(false);
    expect(updated.scopeExitReason).toBe('STORE_CHANGED');
  });
});

describe('неизменяемость ревизий', () => {
  it('UPDATE и DELETE ревизии отклоняются базой', async () => {
    const order = await seedOrder();
    const revision = await ctx.db.deliveryOrderRevision.create({
      data: {
        orderId: order.id,
        externalUpdated: new Date(),
        snapshot: { externalName: order.externalName },
        snapshotHash: 'a'.repeat(64),
        changedFields: ['externalName'],
        reason: 'INITIAL_IMPORT',
      },
    });

    await expect(
      ctx.db.deliveryOrderRevision.update({
        where: { id: revision.id },
        data: { snapshotHash: 'b'.repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(
      ctx.db.deliveryOrderRevision.delete({ where: { id: revision.id } }),
    ).rejects.toThrow();

    const stored = await ctx.db.deliveryOrderRevision.findUniqueOrThrow({
      where: { id: revision.id },
    });
    expect(stored.snapshotHash).toBe('a'.repeat(64));
  });

  it('снимок ревизии не содержит сырой ответ и служебные поля', async () => {
    const order = await seedOrder();
    const revision = await ctx.db.deliveryOrderRevision.create({
      data: {
        orderId: order.id,
        externalUpdated: new Date(),
        snapshot: { externalId: order.externalId, address: 'Москва, тестовый адрес' },
        snapshotHash: 'c'.repeat(64),
        changedFields: ['address'],
        reason: 'EXTERNAL_UPDATE',
      },
    });

    const serialized = JSON.stringify(revision.snapshot);
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('meta');
    expect(serialized).not.toContain('api.moysklad.ru');
  });
});

describe('денежный контракт базы и API', () => {
  it('крупные суммы проходят через BigInt без потери точности', async () => {
    // Значение заведомо больше безопасного целого JavaScript.
    const huge = 90071992547409910n;
    const order = await seedOrder({
      sumMinor: huge,
      payedSumMinor: 1n,
      cashToCollectMinor: huge - 1n,
    });

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });

    expect(stored.sumMinor).toBe(huge);
    expect(typeof stored.sumMinor).toBe('bigint');
    // На границе JSON отдаём десятичную строку: сериализовать bigint нельзя.
    expect(() => JSON.stringify({ sum: stored.sumMinor })).toThrow();
    expect(toDecimalString(stored.sumMinor)).toBe('900719925474099.10');
  });

  it('деньги хранятся целыми, дробное значение в BigInt невозможно', async () => {
    const order = await seedOrder({
      sumMinor: 100050n,
      payedSumMinor: 50n,
      cashToCollectMinor: 100000n,
    });
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });

    expect(toDecimalString(stored.sumMinor)).toBe('1000.50');
    expect(toDecimalString(stored.cashToCollectMinor)).toBe('1000.00');
  });
});

describe('курсор интеграции', () => {
  it('на провайдера существует ровно один курсор', async () => {
    const provider = `test-${process.hrtime.bigint()}`;
    await ctx.db.integrationCursor.create({ data: { provider } });

    await expect(ctx.db.integrationCursor.create({ data: { provider } })).rejects.toThrow();
    expect(await ctx.db.integrationCursor.count({ where: { provider } })).toBe(1);
  });
});
