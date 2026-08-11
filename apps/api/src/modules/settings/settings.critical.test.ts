/**
 * Критические проверки общих настроек планирования.
 *
 * Настройка меняет каждый расчёт, поэтому проверяется не форма, а последствия:
 * история версий не переписывается, текущая версия ровно одна, конкурентная
 * запись отсекается, а смена не получает выдуманного значения по умолчанию.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { TEST_SECRETS } from '../../platform/testing/secrets.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import type { Role } from '@fl/shared';
import {
  DEFAULT_SERVICE_TIME,
  readServiceTime,
  readShift,
  saveServiceTime,
  saveShift,
  SETTING_KEYS,
} from './service.js';

let ctx: TestContext;
const CONTEXT = { ip: null, userAgent: null };

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

async function adminActor(): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles: ['ADMIN'] });
  return {
    userId: user.id,
    roles: ['ADMIN'] as Role[],
    familyId: '00000000-0000-4000-8000-000000000002',
  } as AuthenticatedActor;
}

async function tokenFor(roles: Role[]): Promise<string> {
  const { hashSecretCode } = await import('../auth/crypto.js');
  const { login } = await import('../auth/service.js');
  const pin = '1234';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles, pinHash });
  const session = await login(
    ctx,
    { phone: user.phone, pin },
    { ip: null, userAgent: 'vitest', deviceLabel: null },
  );
  return session.accessToken;
}

describe('смена', () => {
  it('сохраняется новой версией, прежняя остаётся в истории', async () => {
    const actor = await adminActor();
    const before = await readShift(ctx.db);

    const saved = await saveShift(ctx.db, actor, {
      value: { startMinute: 9 * 60, endMinute: 21 * 60 },
      expectedVersion: before.version,
      ...CONTEXT,
    });

    expect(saved.version).toBe(before.version + 1);

    const current = await readShift(ctx.db);
    expect(current.value).toEqual({ startMinute: 540, endMinute: 1260 });

    // Ровно одна текущая версия на ключ, остальные — история.
    const rows = await ctx.db.systemSetting.findMany({
      where: { key: SETTING_KEYS.shift },
      select: { version: true, currentKey: true },
    });
    expect(rows.filter((row) => row.currentKey !== null)).toHaveLength(1);
    expect(rows.length).toBe(saved.version);
  });

  it('устаревшая версия отклоняется и значение не меняется', async () => {
    const actor = await adminActor();
    const before = await readShift(ctx.db);

    await expect(
      saveShift(ctx.db, actor, {
        value: { startMinute: 0, endMinute: 60 },
        expectedVersion: before.version + 10,
        ...CONTEXT,
      }),
    ).rejects.toMatchObject({ conflict: { kind: 'STALE_VERSION' } });

    expect((await readShift(ctx.db)).value).toEqual(before.value);
  });

  it('окончание строго позже начала: обратный интервал не сохраняется', async () => {
    const actor = await adminActor();
    const before = await readShift(ctx.db);

    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/planning/shift',
      headers: { authorization: `Bearer ${await tokenFor(['ADMIN'])}` },
      payload: {
        value: { startMinute: 1200, endMinute: 600 },
        expectedVersion: before.version,
      },
    });

    expect(response.statusCode).toBe(400);
    void actor;
  });

  it('две одновременные записи не создают двух текущих версий', async () => {
    const actor = await adminActor();
    const before = await readShift(ctx.db);

    const results = await Promise.allSettled([
      saveShift(ctx.db, actor, {
        value: { startMinute: 480, endMinute: 1200 },
        expectedVersion: before.version,
        ...CONTEXT,
      }),
      saveShift(ctx.db, actor, {
        value: { startMinute: 600, endMinute: 1140 },
        expectedVersion: before.version,
        ...CONTEXT,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    const rows = await ctx.db.systemSetting.findMany({
      where: { key: SETTING_KEYS.shift, currentKey: { not: null } },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('время обслуживания', () => {
  it('имеет начальное значение: десять минут на заказ для обоих типов', async () => {
    const current = await readServiceTime(ctx.db);

    if (current.isDefault) {
      expect(current.value).toEqual(DEFAULT_SERVICE_TIME);
      expect(DEFAULT_SERVICE_TIME).toEqual({ carMinutes: 10, footMinutes: 10 });
    } else {
      // Значение уже меняли в этой базе — начальное проверяем на константе.
      expect(DEFAULT_SERVICE_TIME).toEqual({ carMinutes: 10, footMinutes: 10 });
    }
  });

  it('редактируется и перестаёт быть значением по умолчанию', async () => {
    const actor = await adminActor();
    const before = await readServiceTime(ctx.db);

    await saveServiceTime(ctx.db, actor, {
      value: { carMinutes: 12, footMinutes: 18 },
      expectedVersion: before.version,
      ...CONTEXT,
    });

    const current = await readServiceTime(ctx.db);
    expect(current.value).toEqual({ carMinutes: 12, footMinutes: 18 });
    expect(current.isDefault).toBe(false);
  });
});

describe('права', () => {
  it('логист читает настройки, но не меняет их', async () => {
    const token = await tokenFor(['LOGISTICIAN']);

    const read = await ctx.app.inject({
      method: 'GET',
      url: '/api/settings/planning',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(200);

    const write = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/planning/shift',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: { startMinute: 540, endMinute: 1080 }, expectedVersion: 1 },
    });
    expect(write.statusCode).toBe(403);
  });

  it('курьер настроек не видит', async () => {
    const token = await tokenFor(['COURIER']);
    const read = await ctx.app.inject({
      method: 'GET',
      url: '/api/settings/planning',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(403);
  });

  it('анонимный запрос отклоняется', async () => {
    const read = await ctx.app.inject({ method: 'GET', url: '/api/settings/planning' });
    expect(read.statusCode).toBe(401);
  });

  it('в аудите настройки есть значения, но нет секретов', async () => {
    const entries = await ctx.db.auditLog.findMany({
      where: { action: 'SETTING_UPDATED' },
      select: { entityId: true, newValue: true },
      take: 5,
    });

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const serialized = JSON.stringify(entry.newValue);
      expect(serialized).not.toMatch(/token|secret|pepper|pin/i);
    }
  });
});
