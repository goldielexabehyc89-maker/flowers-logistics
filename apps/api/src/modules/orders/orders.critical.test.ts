/**
 * Критические проверки импорта заказов и их API.
 *
 * Сетевых обращений нет: снимки строятся mapper'ом и применяются напрямую.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { loadConfig } from '../../platform/config.js';
import { TEST_SECRETS } from '../../platform/testing/secrets.js';
import { resolveTestDatabaseUrl } from '../../platform/testing/test-database.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { applyOrderSnapshot } from '../integrations/moysklad/import-service.js';
import { mapOrder, type OrderSnapshot } from '../integrations/moysklad/mapper.js';
import { shouldRunAutomatically } from '../integrations/moysklad/worker.js';
import { moscowToday } from './routes.js';

let ctx: TestContext;
const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;
const NOW = new Date('2026-08-06T09:00:00.000Z');

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    name: `A-${process.hrtime.bigint() % 1_000_000n}`,
    updated: '2026-08-06 10:00:00.000',
    shipmentAddress: 'Москва, тестовый адрес',
    deliveryPlannedMoment: `${moscowToday(NOW)} 12:00:00.000`,
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
      { id: IDS.recipientAttribute, value: 'Получатель Тестовый' },
    ],
    ...overrides,
  };
}

function snapshotOf(overrides: Record<string, unknown> = {}): OrderSnapshot {
  return mapOrder(source(overrides) as never, IDS).snapshot;
}

async function apply(snapshot: OrderSnapshot, at = NOW) {
  return ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, at));
}

describe('идемпотентность импорта', () => {
  it('повторная та же версия не создаёт ревизию, аудит и событие', async () => {
    const snapshot = snapshotOf();
    const first = await apply(snapshot);
    expect(first.outcome).toBe('CREATED');

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    const audits = await ctx.db.auditLog.count({ where: { entityId: order.id } });
    const events = await ctx.db.realtimeEvent.count();

    const second = await apply(snapshot);

    expect(second.outcome).toBe('UNCHANGED');
    expect(second.changedFields).toEqual([]);
    expect(await ctx.db.deliveryOrderRevision.count({ where: { orderId: order.id } })).toBe(1);
    expect(await ctx.db.auditLog.count({ where: { entityId: order.id } })).toBe(audits);
    expect(await ctx.db.realtimeEvent.count()).toBe(events);
    expect(
      (await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } })).version,
    ).toBe(1);
  });

  it('реальное изменение создаёт ревизию с точным changedFields', async () => {
    const snapshot = snapshotOf();
    await apply(snapshot);

    const changed = {
      ...snapshot,
      address: 'Москва, другой адрес',
      externalUpdated: '2026-08-06 11:00:00.000',
    };
    const result = await apply(changed);

    expect(result.outcome).toBe('UPDATED');
    expect(result.changedFields).toContain('address');
    expect(result.changedFields).toContain('externalUpdated');
    expect(result.changedFields).not.toContain('recipient');
  });
});

describe('область и ручной интервал', () => {
  it('импорт не перезаписывает ручной интервал логиста', async () => {
    const snapshot = snapshotOf();
    await apply(snapshot);

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: {
        manualIntervalStartMinute: 600,
        manualIntervalEndMinute: 720,
        manualIntervalSetAt: NOW,
      },
    });

    await apply({
      ...snapshot,
      intervalRaw: '09:00 - 11:00',
      intervalStartMinute: 540,
      intervalEndMinute: 660,
    });

    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.manualIntervalStartMinute).toBe(600);
    expect(after.manualIntervalEndMinute).toBe(720);
    expect(after.intervalStartMinute).toBe(540);
  });

  it('выход из области сохраняет историю и ставит причину', async () => {
    const snapshot = snapshotOf();
    await apply(snapshot);

    const exited = await apply({
      ...snapshot,
      externalUpdated: '2026-08-06 12:00:00.000',
      storeId: '33333333-3333-4333-8333-333333333333',
      inScope: false,
      scopeExitReason: 'STORE_CHANGED',
    });

    expect(exited.outcome).toBe('SCOPE_EXITED');
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    expect(order.inScope).toBe(false);
    expect(order.scopeExitReason).toBe('STORE_CHANGED');
    expect(order.scopeExitedAt).not.toBeNull();
    expect(await ctx.db.deliveryOrderRevision.count({ where: { orderId: order.id } })).toBe(2);
  });

  it('повторное нахождение вне области не накапливает PII чужого склада', async () => {
    const snapshot = snapshotOf();
    await apply(snapshot);
    const out = {
      ...snapshot,
      externalUpdated: '2026-08-06 12:00:00.000',
      storeId: '33333333-3333-4333-8333-333333333333',
      inScope: false,
      scopeExitReason: 'STORE_CHANGED' as const,
    };
    await apply(out);

    await apply({
      ...out,
      externalUpdated: '2026-08-06 13:00:00.000',
      address: 'Чужой склад, секретный адрес',
    });

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    expect(order.address).toBe('Москва, тестовый адрес');
    expect(order.address).not.toContain('секретный');
  });

  it('повторный вход в область очищает признаки выхода', async () => {
    const snapshot = snapshotOf();
    await apply(snapshot);
    await apply({
      ...snapshot,
      externalUpdated: '2026-08-06 12:00:00.000',
      storeId: '33333333-3333-4333-8333-333333333333',
      inScope: false,
      scopeExitReason: 'STORE_CHANGED',
    });

    const back = await apply({ ...snapshot, externalUpdated: '2026-08-06 14:00:00.000' });

    expect(back.outcome).toBe('SCOPE_ENTERED');
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    expect(order.inScope).toBe(true);
    expect(order.scopeExitReason).toBeNull();
    expect(order.scopeExitedAt).toBeNull();
    expect(order.sourceMissing).toBe(false);
  });
});

describe('аудит и realtime без PII', () => {
  it('запись аудита содержит факт и поля, но не значения', async () => {
    const snapshot = snapshotOf();
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });

    const audit = await ctx.db.auditLog.findFirstOrThrow({
      where: { entityId: order.id },
      orderBy: { occurredAt: 'desc' },
    });

    const serialized = JSON.stringify(audit.newValue);
    expect(audit.action).toBe('ORDER_IMPORTED');
    expect(audit.actorUserId).toBeNull();
    expect(serialized).toContain('changedFields');
    expect(serialized).not.toContain('Москва');
    expect(serialized).not.toContain('Получатель');
    expect(serialized).not.toContain('499000');
    expect(serialized).not.toContain(snapshot.externalName);
  });

  it('realtime адресуется ADMIN и LOGISTICIAN и не содержит PII', async () => {
    const snapshot = snapshotOf();
    await apply(snapshot);

    const event = await ctx.db.realtimeEvent.findFirstOrThrow({
      where: { topic: 'order.created' },
      orderBy: { id: 'desc' },
    });

    expect(event.audienceRoles).toEqual(['ADMIN', 'LOGISTICIAN']);
    expect(event.audienceRoles).not.toContain('COURIER');

    const payload = JSON.stringify(event.payload);
    expect(payload).not.toContain('Москва');
    expect(payload).not.toContain('Получатель');
    expect(payload).not.toContain(snapshot.externalName);
  });

  it('ошибка внутри транзакции откатывает карточку, ревизию, аудит и событие', async () => {
    const snapshot = snapshotOf();
    const events = await ctx.db.realtimeEvent.count();

    await expect(
      ctx.db.$transaction(async (tx) => {
        await applyOrderSnapshot(tx, snapshot, NOW);
        throw new Error('сбой после применения');
      }),
    ).rejects.toThrow();

    expect(await ctx.db.deliveryOrder.count({ where: { externalId: snapshot.externalId } })).toBe(
      0,
    );
    expect(await ctx.db.realtimeEvent.count()).toBe(events);
  });
});

describe('конфигурация fail closed', () => {
  const base = {
    DATABASE_URL: resolveTestDatabaseUrl(),
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...TEST_SECRETS,
  };

  it('токен вне production останавливает запуск', () => {
    expect(() =>
      loadConfig({
        ...base,
        APP_ENVIRONMENT_MARKER: 'staging',
        MOYSKLAD_TOKEN: 'x',
      } as NodeJS.ProcessEnv),
    ).toThrow(/MOYSKLAD_TOKEN/);
  });

  it('включённая синхронизация вне production останавливает запуск', () => {
    expect(() =>
      loadConfig({
        ...base,
        APP_ENVIRONMENT_MARKER: 'local',
        MOYSKLAD_SYNC_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    ).toThrow(/MOYSKLAD_SYNC_ENABLED/);
  });

  it('включённая синхронизация без токена останавливает запуск', () => {
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'production',
        APP_ENVIRONMENT_MARKER: 'production',
        MOYSKLAD_SYNC_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    ).toThrow(/требует MOYSKLAD_TOKEN/);
  });

  it('несовпадение APP_ENV и маркера останавливает запуск', () => {
    // Смешанная конфигурация — признак ошибки развёртывания. Продолжать
    // с рабочим токеном в такой ситуации нельзя ни в одну сторону.
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'staging',
        APP_ENVIRONMENT_MARKER: 'production',
        MOYSKLAD_TOKEN: 'x',
      } as NodeJS.ProcessEnv),
    ).toThrow(/MOYSKLAD_TOKEN/);

    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'production',
        APP_ENVIRONMENT_MARKER: 'staging',
        MOYSKLAD_TOKEN: 'x',
      } as NodeJS.ProcessEnv),
    ).toThrow(/MOYSKLAD_TOKEN/);
  });

  it('staging без токена запускается и worker не стартует', () => {
    const config = loadConfig({ ...base, APP_ENVIRONMENT_MARKER: 'staging' } as NodeJS.ProcessEnv);

    expect(config.MOYSKLAD_TOKEN).toBeUndefined();
    expect(config.MOYSKLAD_SYNC_ENABLED).toBe(false);
    expect(shouldRunAutomatically(config)).toBe(false);
  });

  it('production с токеном и выключенной синхронизацией допустим, но worker не стартует', () => {
    const config = loadConfig({
      ...base,
      APP_ENV: 'production',
      APP_ENVIRONMENT_MARKER: 'production',
      MOYSKLAD_TOKEN: 'x',
    } as NodeJS.ProcessEnv);

    expect(shouldRunAutomatically(config)).toBe(false);
  });

  it('worker стартует только при production, токене и включённой синхронизации', () => {
    const config = loadConfig({
      ...base,
      APP_ENV: 'production',
      APP_ENVIRONMENT_MARKER: 'production',
      MOYSKLAD_TOKEN: 'x',
      MOYSKLAD_SYNC_ENABLED: 'true',
    } as NodeJS.ProcessEnv);

    expect(shouldRunAutomatically(config)).toBe(true);
    expect(config.MOYSKLAD_SYNC_INTERVAL_SECONDS).toBe(30);
    expect(config.MOYSKLAD_SYNC_OVERLAP_SECONDS).toBe(300);
  });
});

describe('API заказов', () => {
  async function tokenFor(roles: Parameters<typeof seedUser>[1]['roles']): Promise<string> {
    const { hashSecretCode } = await import('../auth/crypto.js');
    const { login } = await import('../auth/service.js');
    const pin = '1234';
    const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
    const user = await seedUser(ctx.db, { roles, status: 'ACTIVE', pinHash });
    const session = await login(
      ctx,
      { phone: user.phone, pin },
      { ip: null, userAgent: 'vitest', deviceLabel: null },
    );
    return session.accessToken;
  }

  it('ADMIN и LOGISTICIAN допущены, COURIER — нет', async () => {
    for (const roles of [['ADMIN'], ['LOGISTICIAN']] as const) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/orders',
        headers: { authorization: `Bearer ${await tokenFor([...roles])}` },
      });
      expect(response.statusCode, roles.join()).toBe(200);
    }

    const courier = await ctx.app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { authorization: `Bearer ${await tokenFor(['COURIER'])}` },
    });
    expect(courier.statusCode).toBe(403);
  });

  it('деньги отдаются десятичными строками', async () => {
    const snapshot = snapshotOf({ sum: 499000, payedSum: 100000 });
    await apply(snapshot);

    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/orders/${order.id}`,
      headers: { authorization: `Bearer ${await tokenFor(['ADMIN'])}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      order: { money: Record<string, unknown> };
      revisions: unknown[];
    };
    expect(body.order.money['sum']).toBe('4990.00');
    expect(body.order.money['payed']).toBe('1000.00');
    expect(typeof body.order.money['sum']).toBe('string');
    // Сырой снимок ревизии наружу не отдаётся.
    expect(JSON.stringify(body.revisions)).not.toContain('snapshot');
    expect(JSON.stringify(body.revisions)).not.toContain('snapshotHash');
  });

  it('по умолчанию текущий день, но заказы без даты остаются видимыми', async () => {
    const withoutDate = snapshotOf({ deliveryPlannedMoment: undefined });
    await apply(withoutDate);

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/orders?limit=100',
      headers: { authorization: `Bearer ${await tokenFor(['ADMIN'])}` },
    });

    const body = response.json() as { items: { id: string; needsAttention: boolean }[] };
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: withoutDate.externalId },
    });

    const found = body.items.find((item) => item.id === order.id);
    expect(found).toBeDefined();
    expect(found?.needsAttention).toBe(true);
  });

  it('вышедшие из области не видны в активном списке, но доступны через inScope=false', async () => {
    const snapshot = snapshotOf();
    await apply(snapshot);
    await apply({
      ...snapshot,
      externalUpdated: '2026-08-06 12:00:00.000',
      storeId: '33333333-3333-4333-8333-333333333333',
      inScope: false,
      scopeExitReason: 'STORE_CHANGED',
    });

    const token = await tokenFor(['LOGISTICIAN']);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });

    const active = await ctx.app.inject({
      method: 'GET',
      url: '/api/orders?limit=100',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((active.json() as { items: { id: string }[] }).items.map((i) => i.id)).not.toContain(
      order.id,
    );

    const history = await ctx.app.inject({
      method: 'GET',
      url: '/api/orders?inScope=false&limit=100',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((history.json() as { items: { id: string }[] }).items.map((i) => i.id)).toContain(
      order.id,
    );
  });
});

describe('клиент остаётся read-only', () => {
  it('в модуле интеграции нет методов записи и управления webhooks', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');

    const dir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../integrations/moysklad',
    );
    const files = ['client.ts', 'sync.ts', 'filters.ts', 'import-service.ts'];

    for (const file of files) {
      const content = await readFile(path.join(dir, file), 'utf8');
      const code = content
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n');

      expect(code, file).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
      expect(code, file).not.toContain('entity/webhook');
    }
  });
});
