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
      // Чужой склад выводит заказ из ОБЕИХ областей: mapper иного снимка
      // для другого склада не построит.
      inScope: false,
      fulfillmentInScope: false,
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
      // Чужой склад выводит заказ из ОБЕИХ областей: mapper иного снимка
      // для другого склада не построит.
      inScope: false,
      fulfillmentInScope: false,
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
      // Чужой склад выводит заказ из ОБЕИХ областей: mapper иного снимка
      // для другого склада не построит.
      inScope: false,
      fulfillmentInScope: false,
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

  it('staging принимает токен только вместе с явным режимом чтения', () => {
    const staging = {
      ...base,
      APP_ENV: 'staging',
      APP_ENVIRONMENT_MARKER: 'staging',
      MOYSKLAD_TOKEN: 'x',
    };

    // Допуск даёт только ЯВНОЕ значение.
    const config = loadConfig({ ...staging, MOYSKLAD_READ_ONLY: 'true' } as NodeJS.ProcessEnv);
    expect(config.MOYSKLAD_READ_ONLY).toBe('true');
    expect(config.moyskladAccess).toBe('staging-read-only');

    // Без него токен на staging не принимается.
    expect(() => loadConfig(staging as NodeJS.ProcessEnv)).toThrow(/MOYSKLAD_TOKEN/);

    // Объявленный режим записи останавливает запуск отдельной причиной.
    expect(() =>
      loadConfig({ ...staging, MOYSKLAD_READ_ONLY: 'false' } as NodeJS.ProcessEnv),
    ).toThrow(/MOYSKLAD_READ_ONLY=false не поддерживается/);
  });

  it('токен в local и CI останавливает запуск даже с явным режимом чтения', () => {
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'local',
        APP_ENVIRONMENT_MARKER: 'local',
        MOYSKLAD_TOKEN: 'x',
        MOYSKLAD_READ_ONLY: 'true',
      } as NodeJS.ProcessEnv),
    ).toThrow(/MOYSKLAD_TOKEN/);
  });

  it('смешанные маркеры не спасает даже режим чтения', () => {
    for (const [env, marker] of [
      ['staging', 'production'],
      ['production', 'staging'],
      ['staging', 'local'],
      ['local', 'staging'],
    ] as const) {
      expect(() =>
        loadConfig({
          ...base,
          APP_ENV: env,
          APP_ENVIRONMENT_MARKER: marker,
          MOYSKLAD_TOKEN: 'x',
          MOYSKLAD_READ_ONLY: 'true',
        } as NodeJS.ProcessEnv),
      ).toThrow(/MOYSKLAD_TOKEN/);
    }
  });

  it('включённая синхронизация без токена останавливает запуск и на staging', () => {
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: 'staging',
        APP_ENVIRONMENT_MARKER: 'staging',
        MOYSKLAD_READ_ONLY: 'true',
        MOYSKLAD_SYNC_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    ).toThrow(/требует MOYSKLAD_TOKEN/);
  });

  it('матрица окружений: где допущен живой контур, а где нет', async () => {
    const { isSyncAllowedEnvironment } = await import('../integrations/moysklad/worker.js');
    const { checkSyncOnceEnvironment } = await import('../integrations/moysklad/sync-once.js');

    const matrix = [
      { env: 'local', marker: 'local', allowed: false },
      { env: 'staging', marker: 'staging', allowed: true },
      { env: 'production', marker: 'production', allowed: true },
    ];

    for (const { env, marker, allowed } of matrix) {
      const config = loadConfig({
        ...base,
        APP_ENV: env,
        APP_ENVIRONMENT_MARKER: marker,
        ...(env === 'staging' ? { MOYSKLAD_READ_ONLY: 'true' } : {}),
        ...(allowed ? { MOYSKLAD_TOKEN: 'x', MOYSKLAD_SYNC_ENABLED: 'true' } : {}),
      } as NodeJS.ProcessEnv);

      expect(isSyncAllowedEnvironment(config), `${env}/${marker}`).toBe(allowed);
      expect(shouldRunAutomatically(config), `${env}/${marker}`).toBe(allowed);
      // Ручная команда и worker живут по ОДНОЙ проверке окружения: обойти
      // политику ручным запуском нельзя.
      expect(checkSyncOnceEnvironment(config) === null, `${env}/${marker}`).toBe(allowed);
    }
  });

  it('staging без токена остаётся ненастроенным, а не запускает worker', async () => {
    const { checkSyncOnceEnvironment } = await import('../integrations/moysklad/sync-once.js');
    const config = loadConfig({
      ...base,
      APP_ENV: 'staging',
      APP_ENVIRONMENT_MARKER: 'staging',
      MOYSKLAD_READ_ONLY: 'true',
    } as NodeJS.ProcessEnv);

    expect(config.MOYSKLAD_TOKEN).toBeUndefined();
    expect(shouldRunAutomatically(config)).toBe(false);
    // Команда отказывает по отсутствию токена, а не по окружению.
    expect(checkSyncOnceEnvironment(config)?.code).toBe(2);
    expect(checkSyncOnceEnvironment(config)?.reason).toContain('MOYSKLAD_TOKEN');
  });

  it('объявленный режим записи останавливает запуск в любом окружении', () => {
    for (const [env, marker] of [
      ['local', 'local'],
      ['staging', 'staging'],
      ['production', 'production'],
    ] as const) {
      expect(() =>
        loadConfig({
          ...base,
          APP_ENV: env,
          APP_ENVIRONMENT_MARKER: marker,
          MOYSKLAD_READ_ONLY: 'false',
        } as NodeJS.ProcessEnv),
      ).toThrow(/MOYSKLAD_READ_ONLY=false не поддерживается/);
    }
  });

  it('staging без явного режима чтения к живому контуру не допускается', () => {
    const staging = { ...base, APP_ENV: 'staging', APP_ENVIRONMENT_MARKER: 'staging' };

    // Молчание — это «контур не настраивают»: приложение стартует, но токен
    // и синхронизация не разрешены.
    const config = loadConfig(staging as NodeJS.ProcessEnv);
    expect(config.MOYSKLAD_READ_ONLY).toBeUndefined();
    expect(config.moyskladAccess).toBe('denied');

    expect(() => loadConfig({ ...staging, MOYSKLAD_TOKEN: 'x' } as NodeJS.ProcessEnv)).toThrow(
      /MOYSKLAD_TOKEN/,
    );
    expect(() =>
      loadConfig({ ...staging, MOYSKLAD_SYNC_ENABLED: 'true' } as NodeJS.ProcessEnv),
    ).toThrow(/MOYSKLAD_SYNC_ENABLED/);
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

    const body = response.json() as {
      items: {
        id: string;
        needsAttention: boolean;
        attentionReasons: string[];
        selectable?: boolean;
      }[];
    };
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: withoutDate.externalId },
    });

    const found = body.items.find((item) => item.id === order.id);
    expect(found).toBeDefined();
    /*
     * Заказ виден при любом выбранном дне, но «Требует внимания» ему больше
     * не ставится: вопрос к дате — не задача логиста, и красить им карточку
     * значит прятать за ней настоящие препятствия (адрес, точку, интервал).
     * Сама причина при этом сохраняется как сведение.
     */
    expect(found?.needsAttention).toBe(false);
    expect(found?.attentionReasons).toContain('MISSING_DELIVERY_DATE');
  });

  it('вышедшие из области не видны в активном списке, но доступны через inScope=false', async () => {
    const snapshot = snapshotOf();
    await apply(snapshot);
    await apply({
      ...snapshot,
      externalUpdated: '2026-08-06 12:00:00.000',
      storeId: '33333333-3333-4333-8333-333333333333',
      // Чужой склад выводит заказ из ОБЕИХ областей: mapper иного снимка
      // для другого склада не построит.
      inScope: false,
      fulfillmentInScope: false,
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

describe('ручной локальный интервал', () => {
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

  /** Заказ без распознанного интервала: именно он требует ручного исправления. */
  async function orderWithoutInterval() {
    const snapshot = snapshotOf({
      attributes: [
        {
          id: IDS.deliveryMethodAttribute,
          value: {
            name: 'Доставка',
            meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
          },
        },
        { id: IDS.intervalAttribute, value: 'позвонить заранее' },
        { id: IDS.recipientAttribute, value: 'Получатель Тестовый' },
      ],
    });
    await apply(snapshot);
    return ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
  }

  async function setInterval(
    token: string,
    orderId: string,
    body: Record<string, unknown>,
  ): Promise<{ statusCode: number; json: () => unknown }> {
    return ctx.app.inject({
      method: 'PUT',
      url: `/api/orders/${orderId}/interval`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  it('обычный интервал 10:00–14:00 сохраняется и становится рабочим', async () => {
    /*
     * Тот самый отказ «Проверьте правильность заполнения полей».
     *
     * Значения времени здесь ни при чём: 10:00–14:00 всегда были допустимы.
     * Отказ приходил из-за формы тела — окно заказа посылало `expectedVersion`
     * вместо `version`, схема отбрасывала чужой ключ и сообщала об отсутствии
     * обязательного поля. Проверка закрепляет ИМЯ поля версии: тело именно
     * этой формы обязано сохраняться.
     */
    const token = await tokenFor(['LOGISTICIAN']);
    const order = await orderWithoutInterval();

    const saved = await setInterval(token, order.id, {
      startMinute: 600,
      endMinute: 840,
      version: order.version,
    });
    expect(saved.statusCode).toBe(200);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.manualIntervalStartMinute).toBe(600);
    expect(stored.manualIntervalEndMinute).toBe(840);
    // Ручной интервал закрывает причину внимания: логист уже всё исправил.
    expect(stored.attentionReasons).not.toContain('UNRECOGNIZED_INTERVAL');

    // Рабочим он становится и в «Сделках», и на карте, и в «Активных».
    const deals = await ctx.app.inject({
      method: 'GET',
      url: `/api/deals?deliveryDate=${moscowToday(NOW)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const cards = (
      deals.json() as {
        items: { id: string; startMinute: number | null; endMinute: number | null }[];
      }
    ).items;
    const card = cards.find((item) => item.id === order.id);
    expect(card).toMatchObject({ startMinute: 600, endMinute: 840 });
  });

  it('тело без поля version отвергается, а не сохраняется молча', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const order = await orderWithoutInterval();

    const response = await setInterval(token, order.id, {
      startMinute: 600,
      endMinute: 840,
      // Именно так посылало окно заказа: чужой ключ вместо `version`.
      expectedVersion: order.version,
    });
    expect(response.statusCode).toBe(400);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.manualIntervalStartMinute).toBeNull();
  });

  it('курьеру ручной интервал недоступен, логисту — доступен', async () => {
    const order = await orderWithoutInterval();
    expect(order.needsAttention).toBe(true);
    expect(order.attentionReasons).toContain('UNRECOGNIZED_INTERVAL');

    const courier = await setInterval(await tokenFor(['COURIER']), order.id, {
      startMinute: 600,
      endMinute: 720,
      version: order.version,
    });
    expect(courier.statusCode).toBe(403);

    const logistician = await setInterval(await tokenFor(['LOGISTICIAN']), order.id, {
      startMinute: 600,
      endMinute: 720,
      version: order.version,
    });
    expect(logistician.statusCode).toBe(200);
  });

  it('корректный интервал снимает интервальную причину, остальные остаются', async () => {
    // Заказ без интервала И без адреса: ручным интервалом закрывается только первое.
    const snapshot = snapshotOf({
      shipmentAddress: null,
      attributes: [
        {
          id: IDS.deliveryMethodAttribute,
          value: {
            name: 'Доставка',
            meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
          },
        },
        { id: IDS.recipientAttribute, value: 'Получатель Тестовый' },
      ],
    });
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    expect(order.attentionReasons).toContain('MISSING_INTERVAL');
    expect(order.attentionReasons).toContain('MISSING_ADDRESS');

    const response = await setInterval(await tokenFor(['ADMIN']), order.id, {
      startMinute: 660,
      endMinute: 780,
      version: order.version,
    });
    expect(response.statusCode).toBe(200);

    const updated = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.attentionReasons).not.toContain('MISSING_INTERVAL');
    expect(updated.attentionReasons).toContain('MISSING_ADDRESS');
    expect(updated.needsAttention).toBe(true);
    // Исходное значение источника сохраняется: его никто не переписывает.
    expect(updated.intervalKind).toBe('MISSING');
    expect(updated.manualIntervalStartMinute).toBe(660);
    expect(updated.manualIntervalEndMinute).toBe(780);
  });

  it('ручной интервал переживает следующую синхронизацию', async () => {
    const snapshot = snapshotOf({
      attributes: [
        {
          id: IDS.deliveryMethodAttribute,
          value: {
            name: 'Доставка',
            meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
          },
        },
        { id: IDS.intervalAttribute, value: 'уточнить' },
        { id: IDS.recipientAttribute, value: 'Получатель Тестовый' },
      ],
    });
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });

    await setInterval(await tokenFor(['LOGISTICIAN']), order.id, {
      startMinute: 540,
      endMinute: 660,
      version: order.version,
    });

    // Приходит новая версия заказа: изменился адрес, интервал источника прежний.
    await apply({
      ...snapshot,
      address: 'Москва, уточнённый адрес',
      externalUpdated: '2026-08-06 12:00:00.000',
    });

    const synced = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(synced.manualIntervalStartMinute).toBe(540);
    expect(synced.manualIntervalEndMinute).toBe(660);
    expect(synced.attentionReasons).not.toContain('UNRECOGNIZED_INTERVAL');
    expect(synced.needsAttention).toBe(false);
    expect(synced.address).toBe('Москва, уточнённый адрес');
  });

  it('повторное исправление заменяет предыдущее', async () => {
    const order = await orderWithoutInterval();
    const token = await tokenFor(['LOGISTICIAN']);

    await setInterval(token, order.id, {
      startMinute: 600,
      endMinute: 720,
      version: order.version,
    });
    const afterFirst = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });

    await setInterval(token, order.id, {
      startMinute: 780,
      endMinute: 900,
      version: afterFirst.version,
    });

    const afterSecond = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterSecond.manualIntervalStartMinute).toBe(780);
    expect(afterSecond.manualIntervalEndMinute).toBe(900);
    expect(
      await ctx.db.auditLog.count({
        where: { entityId: order.id, action: 'ORDER_INTERVAL_SET' },
      }),
    ).toBe(2);
  });

  it('устаревшая версия отклоняется с 409', async () => {
    const order = await orderWithoutInterval();
    const token = await tokenFor(['LOGISTICIAN']);

    const first = await setInterval(token, order.id, {
      startMinute: 600,
      endMinute: 720,
      version: order.version,
    });
    expect(first.statusCode).toBe(200);

    const stale = await setInterval(token, order.id, {
      startMinute: 640,
      endMinute: 760,
      version: order.version,
    });
    expect(stale.statusCode).toBe(409);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.manualIntervalStartMinute).toBe(600);
  });

  it('обратный и нулевой интервал отклоняются', async () => {
    const order = await orderWithoutInterval();
    const token = await tokenFor(['LOGISTICIAN']);

    for (const body of [
      { startMinute: 720, endMinute: 600 },
      { startMinute: 600, endMinute: 600 },
      { startMinute: -1, endMinute: 600 },
      { startMinute: 600, endMinute: 24 * 60 },
    ]) {
      const response = await setInterval(token, order.id, { ...body, version: order.version });
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.manualIntervalStartMinute).toBeNull();
  });

  it('изменение, аудит и событие пишутся одной транзакцией', async () => {
    const order = await orderWithoutInterval();
    const eventsBefore = await ctx.db.realtimeEvent.count();

    await setInterval(await tokenFor(['LOGISTICIAN']), order.id, {
      startMinute: 600,
      endMinute: 720,
      version: order.version,
    });

    const audit = await ctx.db.auditLog.findFirstOrThrow({
      where: { entityId: order.id, action: 'ORDER_INTERVAL_SET' },
    });
    expect(audit.actorUserId).not.toBeNull();
    // Ни адреса, ни получателя в аудите нет: только факт и значения интервала.
    const serialized = JSON.stringify(audit.newValue);
    expect(serialized).not.toContain('Москва');
    expect(serialized).not.toContain('Получатель');

    expect(await ctx.db.realtimeEvent.count()).toBe(eventsBefore + 1);
    const event = await ctx.db.realtimeEvent.findFirstOrThrow({ orderBy: { id: 'desc' } });
    expect(event.topic).toBe('order.updated');
    expect(JSON.stringify(event.payload)).not.toContain('Москва');
  });

  it('конфликт версии не оставляет ни аудита, ни события', async () => {
    const order = await orderWithoutInterval();
    const token = await tokenFor(['LOGISTICIAN']);
    await setInterval(token, order.id, {
      startMinute: 600,
      endMinute: 720,
      version: order.version,
    });

    const auditsBefore = await ctx.db.auditLog.count({
      where: { entityId: order.id, action: 'ORDER_INTERVAL_SET' },
    });
    const eventsBefore = await ctx.db.realtimeEvent.count();

    const stale = await setInterval(token, order.id, {
      startMinute: 900,
      endMinute: 960,
      version: order.version,
    });
    expect(stale.statusCode).toBe(409);

    expect(
      await ctx.db.auditLog.count({ where: { entityId: order.id, action: 'ORDER_INTERVAL_SET' } }),
    ).toBe(auditsBefore);
    expect(await ctx.db.realtimeEvent.count()).toBe(eventsBefore);
  });

  it('заказ вне области не редактируется', async () => {
    const snapshot = snapshotOf();
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    await apply({
      ...snapshot,
      storeId: '33333333-3333-4333-8333-333333333333',
      // Чужой склад выводит заказ из ОБЕИХ областей: mapper иного снимка
      // для другого склада не построит.
      inScope: false,
      fulfillmentInScope: false,
      scopeExitReason: 'STORE_CHANGED',
      externalUpdated: '2026-08-06 13:00:00.000',
    });

    const response = await setInterval(await tokenFor(['LOGISTICIAN']), order.id, {
      startMinute: 600,
      endMinute: 720,
      version: order.version + 1,
    });
    expect(response.statusCode).toBe(400);
  });

  it('история карточки показывает ручные исправления без сырых снимков', async () => {
    const order = await orderWithoutInterval();
    const token = await tokenFor(['LOGISTICIAN']);
    await setInterval(token, order.id, {
      startMinute: 600,
      endMinute: 720,
      version: order.version,
    });

    const card = await ctx.app.inject({
      method: 'GET',
      url: `/api/orders/${order.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(card.statusCode).toBe(200);

    const body = card.json() as {
      order: { interval: { manualStartMinute: number | null } };
      revisions: Record<string, unknown>[];
      manualIntervalChanges: { startMinute: number; endMinute: number }[];
    };
    expect(body.order.interval.manualStartMinute).toBe(600);
    expect(body.manualIntervalChanges[0]?.startMinute).toBe(600);
    expect(body.manualIntervalChanges[0]?.endMinute).toBe(720);
    // Сырой снимок ревизии наружу не отдаётся.
    for (const revision of body.revisions) {
      expect(Object.keys(revision)).not.toContain('snapshot');
    }
  });
});

describe('поиск и дата по умолчанию', () => {
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

  async function list(token: string, query: string) {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/orders${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return response.json() as { items: { id: string; number: string }[]; total: number };
  }

  it('по умолчанию видны сегодняшние заказы и заказы без даты', async () => {
    const token = await tokenFor(['LOGISTICIAN']);

    // День берётся по реальным часам: сервер по умолчанию фильтрует по текущей
    // московской дате, а фиксированный NOW тестов с ней не совпадает.
    const today = snapshotOf({ deliveryPlannedMoment: `${moscowToday(new Date())} 12:00:00.000` });
    await apply(today);
    const noDate = snapshotOf({ deliveryPlannedMoment: null });
    await apply(noDate);
    const otherDay = snapshotOf({ deliveryPlannedMoment: '2026-09-15 12:00:00.000' });
    await apply(otherDay);

    const items = (await list(token, '')).items.map((item) => item.number);
    expect(items).toContain(
      (await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { externalId: today.externalId } }))
        .externalName,
    );
    expect(items).toContain(
      (await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { externalId: noDate.externalId } }))
        .externalName,
    );
    expect(items).not.toContain(
      (await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { externalId: otherDay.externalId } }))
        .externalName,
    );
  });

  it('поиск ищет по номеру, адресу и получателю и не ограничен днём', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const marker = `Уникальный-${Date.now()}`;
    const snapshot = snapshotOf({
      deliveryPlannedMoment: '2026-09-20 12:00:00.000',
      shipmentAddress: `Москва, ${marker}`,
    });
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });

    // По адресу — находится, несмотря на то что дата не сегодняшняя.
    expect(
      (await list(token, `?search=${encodeURIComponent(marker)}`)).items.map((i) => i.id),
    ).toContain(order.id);
    // По номеру — в другом регистре.
    expect(
      (
        await list(token, `?search=${encodeURIComponent(order.externalName.toLowerCase())}`)
      ).items.map((i) => i.id),
    ).toContain(order.id);
    // По получателю.
    expect(
      (await list(token, `?search=${encodeURIComponent('Получатель Тестовый')}`)).items.length,
    ).toBeGreaterThan(0);
  });
});

describe('производственная область не расширяет логистические выборки', () => {
  /** Заказ утверждённого склада с самовывозом: производственная область без логистической. */
  function pickupSnapshot(): OrderSnapshot {
    return snapshotOf({
      attributes: [
        {
          id: IDS.deliveryMethodAttribute,
          value: {
            name: 'Самовывоз',
            meta: { href: href('customentity', '76f4977e-d33e-11ef-0a80-03b6000e555e') },
          },
        },
        { id: IDS.intervalAttribute, value: 'с 16:00 по 19:00' },
        { id: IDS.recipientAttribute, value: 'Получатель Тестовый' },
      ],
    });
  }

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

  it('самовывоз сохраняется, но в списке логиста его нет', async () => {
    const snapshot = pickupSnapshot();
    const applied = await apply(snapshot);

    // Заказ именно СОХРАНЁН: производственная область его принимает.
    expect(applied.outcome).toBe('CREATED');
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    expect(order.inScope).toBe(false);
    expect(order.fulfillmentInScope).toBe(true);

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/orders?date=${order.deliveryDate?.toISOString().slice(0, 10) ?? ''}`,
      headers: { authorization: `Bearer ${await tokenFor(['ADMIN'])}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { id: string }[] };
    expect(body.items.some((row) => row.id === order.id)).toBe(false);
  });

  it('маршрутизация и геокодирование по-прежнему смотрят только на inScope', async () => {
    const { ineligibleReason } = await import('../routing/eligibility.js');
    const { isGeocodable } = await import('./geocoding/queue.js');

    const snapshot = pickupSnapshot();
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });

    const routeDate = order.deliveryDate?.toISOString().slice(0, 10) ?? '2026-08-07';
    expect(
      ineligibleReason(
        {
          inScope: order.inScope,
          sourceArchived: order.sourceArchived,
          sourceMissing: order.sourceMissing,
          deliveryDate: order.deliveryDate,
        },
        routeDate,
      ),
    ).toBe('OUT_OF_SCOPE');

    expect(
      isGeocodable({
        address: order.address,
        inScope: order.inScope,
        sourceArchived: order.sourceArchived,
        sourceMissing: order.sourceMissing,
        geoState: order.geoState,
        geoSource: order.geoSource,
      }),
    ).toBe(false);
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

describe('явно выбранный день и заказы без даты', () => {
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

  it('при ?deliveryDate заказ без даты остаётся видимым', async () => {
    const token = await tokenFor(['LOGISTICIAN']);
    const day = '2026-10-15';

    const onDay = snapshotOf({ deliveryPlannedMoment: `${day} 12:00:00.000` });
    await apply(onDay);
    const noDate = snapshotOf({ deliveryPlannedMoment: null });
    await apply(noDate);
    const otherDay = snapshotOf({ deliveryPlannedMoment: '2026-10-16 12:00:00.000' });
    await apply(otherDay);

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/orders?deliveryDate=${day}&limit=100`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);

    const numbers = (response.json() as { items: { number: string }[] }).items.map(
      (item) => item.number,
    );
    const nameOf = async (externalId: string): Promise<string> =>
      (await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { externalId } })).externalName;

    expect(numbers).toContain(await nameOf(onDay.externalId));
    // Заказ без распознанной даты обязан остаться в выборке: он в «Требует
    // внимания» именно потому, что даты у него нет.
    expect(numbers).toContain(await nameOf(noDate.externalId));
    expect(numbers).not.toContain(await nameOf(otherDay.externalId));
  });
});

describe('инвариант ручного интервала в базе', () => {
  /** Прямая запись в обход API: проверяется именно ограничение PostgreSQL. */
  async function writeManualInterval(
    orderId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await ctx.db.deliveryOrder.update({ where: { id: orderId }, data });
  }

  async function freshOrder(): Promise<string> {
    const snapshot = snapshotOf();
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
    });
    return order.id;
  }

  it('половинчатый интервал отклоняется базой', async () => {
    const orderId = await freshOrder();

    await expect(
      writeManualInterval(orderId, { manualIntervalStartMinute: 600 }),
    ).rejects.toThrow();
    await expect(writeManualInterval(orderId, { manualIntervalEndMinute: 720 })).rejects.toThrow();
    // Значения без отметки времени — тоже половинчатое состояние.
    await expect(
      writeManualInterval(orderId, {
        manualIntervalStartMinute: 600,
        manualIntervalEndMinute: 720,
      }),
    ).rejects.toThrow();
  });

  it('невозможный интервал отклоняется базой', async () => {
    const orderId = await freshOrder();

    for (const data of [
      { manualIntervalStartMinute: 720, manualIntervalEndMinute: 600 },
      { manualIntervalStartMinute: 600, manualIntervalEndMinute: 600 },
      { manualIntervalStartMinute: -1, manualIntervalEndMinute: 600 },
      { manualIntervalStartMinute: 600, manualIntervalEndMinute: 1440 },
    ]) {
      await expect(
        writeManualInterval(orderId, { ...data, manualIntervalSetAt: NOW }),
        JSON.stringify(data),
      ).rejects.toThrow();
    }
  });

  it('полный корректный интервал и полная очистка разрешены', async () => {
    const orderId = await freshOrder();

    await writeManualInterval(orderId, {
      manualIntervalStartMinute: 600,
      manualIntervalEndMinute: 720,
      manualIntervalSetAt: NOW,
    });
    await writeManualInterval(orderId, {
      manualIntervalStartMinute: null,
      manualIntervalEndMinute: null,
      manualIntervalSetAt: null,
    });

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(stored.manualIntervalStartMinute).toBeNull();
  });
});

describe('публичное состояние приложения', () => {
  it('без авторизации технических счётчиков нет', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/status' });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('pendingOperations');
    expect(response.body).not.toContain('lastErrorAt');
  });

  it('технические подробности доступны только администратору', async () => {
    const { hashSecretCode } = await import('../auth/crypto.js');
    const { login } = await import('../auth/service.js');
    const pin = '1234';
    const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);

    const tokenFor = async (roles: Parameters<typeof seedUser>[1]['roles']): Promise<string> => {
      const user = await seedUser(ctx.db, { roles, status: 'ACTIVE', pinHash });
      const session = await login(
        ctx,
        { phone: user.phone, pin },
        { ip: null, userAgent: 'vitest', deviceLabel: null },
      );
      return session.accessToken;
    };

    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/status/integrations' });
    expect(anonymous.statusCode).toBe(401);

    const logistician = await ctx.app.inject({
      method: 'GET',
      url: '/api/status/integrations',
      headers: { authorization: `Bearer ${await tokenFor(['LOGISTICIAN'])}` },
    });
    expect(logistician.statusCode).toBe(403);

    const admin = await ctx.app.inject({
      method: 'GET',
      url: '/api/status/integrations',
      headers: { authorization: `Bearer ${await tokenFor(['ADMIN'])}` },
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.body).toContain('pendingOperations');
  });
});

describe('снимок заказов для staging', () => {
  it('в снимке нет адресов, получателей, комментариев и внешних идентификаторов', async () => {
    const marker = `Секрет-${Date.now()}`;
    const snapshot = snapshotOf({
      shipmentAddress: `Москва, ${marker}`,
      attributes: [
        {
          id: IDS.deliveryMethodAttribute,
          value: {
            name: 'Доставка',
            meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
          },
        },
        { id: IDS.intervalAttribute, value: 'с 16:00 по 19:00' },
        { id: IDS.recipientAttribute, value: `Получатель ${marker}` },
        { id: IDS.commentAttribute, value: `Комментарий ${marker}` },
      ],
    });
    await apply(snapshot);
    await apply(snapshotOf({ deliveryPlannedMoment: null }));

    const { exportOrdersSnapshot, assertSnapshotIsSafe, alias } =
      await import('./snapshot-export.js');

    // Предел считается от фактического содержимого одноразовой базы, а не
    // задан числом: соседние сценарии копят строки, и заказ без даты, который
    // PostgreSQL сортирует последним, однажды выпал бы за `take` — проверка
    // молча превратилась бы в проверку удачи.
    const matching = await ctx.db.deliveryOrder.count({
      where: {
        inScope: true,
        sourceMissing: false,
        sourceArchived: false,
        OR: [
          { deliveryDate: { gte: new Date('2026-01-01T00:00:00.000Z') } },
          { deliveryDate: null },
        ],
      },
    });

    const exported = await exportOrdersSnapshot(ctx.db, {
      since: new Date('2026-01-01T00:00:00.000Z'),
      limit: matching + 10,
      aliasSalt: 'test-salt',
      now: NOW,
    });

    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain(marker);
    // Заказы без даты нужны для проверки «Требует внимания» и обязаны попасть
    // в снимок: нижняя граница даты не должна их отсекать.
    expect(exported.orders.some((row) => row.deliveryDate === null)).toBe(true);
    expect(serialized).not.toContain('Москва');
    expect(serialized).not.toContain(snapshot.externalId);

    // Псевдоним устойчив: одно значение — один и тот же псевдоним.
    expect(alias('addr', 'Москва, дом 1', 'test-salt')).toBe(
      alias('addr', 'Москва, дом 1', 'test-salt'),
    );
    expect(alias('addr', 'Москва, дом 1', 'test-salt')).not.toBe(
      alias('addr', 'Москва, дом 2', 'test-salt'),
    );

    // Соль в снимок не попадает — только её отпечаток.
    expect(serialized).not.toContain('test-salt');
    assertSnapshotIsSafe(exported);
  });

  it('самовывозы не попадают в снимок и не расходуют предел', async () => {
    const { exportOrdersSnapshot } = await import('./snapshot-export.js');

    // Самовывозы утверждённого склада: производственная область без логистической.
    const pickupIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const pickup = snapshotOf({
        deliveryPlannedMoment: '2026-09-01 12:00:00.000',
        attributes: [
          {
            id: IDS.deliveryMethodAttribute,
            value: {
              name: 'Самовывоз',
              meta: { href: href('customentity', '76f4977e-d33e-11ef-0a80-03b6000e555e') },
            },
          },
          { id: IDS.intervalAttribute, value: 'с 16:00 по 19:00' },
          { id: IDS.recipientAttribute, value: 'Получатель Тестовый' },
        ],
      });
      await apply(pickup);
      pickupIds.push(pickup.externalId);
    }

    // Один активный логистический заказ — тот, ради которого снимок и нужен.
    const delivery = snapshotOf({ deliveryPlannedMoment: '2026-09-02 12:00:00.000' });
    await apply(delivery);

    const pickupOrders = await ctx.db.deliveryOrder.findMany({
      where: { externalId: { in: pickupIds } },
      select: { externalName: true, fulfillmentInScope: true, inScope: true },
    });
    expect(pickupOrders).toHaveLength(6);
    expect(pickupOrders.every((row) => row.fulfillmentInScope && !row.inScope)).toBe(true);

    const deliveryOrder = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: delivery.externalId },
    });

    // Предел заведомо меньше числа самовывозов: если бы они попадали в выборку,
    // логистический заказ был бы вытеснен.
    const exported = await exportOrdersSnapshot(ctx.db, {
      since: new Date('2026-09-01T00:00:00.000Z'),
      limit: 3,
      aliasSalt: 'test-salt',
      now: NOW,
    });

    const numbers = exported.orders.map((row) => row.number);
    expect(numbers).toContain(deliveryOrder.externalName);
    for (const pickup of pickupOrders) {
      expect(numbers).not.toContain(pickup.externalName);
    }
  });

  it('импорт снимка чужого формата и снимка с настоящими данными отклоняется', async () => {
    const { assertSnapshotIsSafe, SNAPSHOT_FORMAT } = await import('./snapshot-export.js');

    expect(() =>
      assertSnapshotIsSafe({
        format: 'что-то другое' as typeof SNAPSHOT_FORMAT,
        takenAt: NOW.toISOString(),
        aliasSaltId: 'x',
        orders: [],
      }),
    ).toThrow(/формат/i);

    const withRealAddress = {
      format: SNAPSHOT_FORMAT,
      takenAt: NOW.toISOString(),
      aliasSaltId: 'x',
      orders: [
        {
          key: 'order-1',
          number: 'A-1',
          deliveryDate: '2026-08-07',
          intervalKind: 'RANGE',
          intervalStartMinute: 600,
          intervalEndMinute: 720,
          manualIntervalStartMinute: null,
          manualIntervalEndMinute: null,
          addressAlias: 'Москва, настоящая улица',
          recipientAlias: null,
          hasComment: false,
          externalStateName: null,
          externalStateType: null,
          sumMinor: '0',
          payedSumMinor: '0',
          cashCollectable: false,
          cashToCollectMinor: '0',
          cashAnomaly: false,
          inScope: true,
          needsAttention: false,
          attentionReasons: [],
        },
      ],
    };
    expect(() => assertSnapshotIsSafe(withRealAddress)).toThrow(/псевдоним/i);
  });
});
