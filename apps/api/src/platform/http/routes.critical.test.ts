/**
 * Критические проверки маршрутов.
 *
 * Главная из них — отсутствие DELETE-маршрутов: сотрудники, курьеры и роли
 * не удаляются никогда, и это должно быть невозможно на уровне API, а не только
 * по договорённости.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecretCode } from '../../modules/auth/crypto.js';
import { login } from '../../modules/auth/service.js';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  uniquePhone,
  type TestContext,
} from '../../modules/auth/testing/harness.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

async function accessTokenFor(roles: Parameters<typeof seedUser>[1]['roles']): Promise<string> {
  const pin = '1234';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles, status: 'ACTIVE', pinHash });
  const session = await login(
    ctx,
    { phone: user.phone, pin },
    { ip: '10.7.0.1', userAgent: 'vitest', deviceLabel: null },
  );
  return session.accessToken;
}

describe('маршрутная таблица', () => {
  it('не содержит ни одного DELETE-маршрута', () => {
    const printed = ctx.app.printRoutes({ commonPrefix: false });
    expect(printed).not.toContain('DELETE');
  });

  it('DELETE по пользовательским ресурсам не обслуживается', async () => {
    const token = await accessTokenFor(['ADMIN']);
    const victim = await seedUser(ctx.db, { roles: ['COURIER'] });

    for (const url of [`/api/users/${victim.id}`, `/api/users/${victim.id}/roles`]) {
      const response = await ctx.app.inject({
        method: 'DELETE',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
    }

    // Пользователь на месте.
    await expect(ctx.db.user.findUniqueOrThrow({ where: { id: victim.id } })).resolves.toBeTruthy();
  });
});

describe('охрана запросов', () => {
  it('без токена управление пользователями недоступно', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/users' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('курьер и кладовщик получают 403 на управлении пользователями', async () => {
    for (const roles of [['COURIER'], ['WAREHOUSE']] as const) {
      const token = await accessTokenFor([...roles]);
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it('администратор и логист получают доступ к списку', async () => {
    for (const roles of [['ADMIN'], ['LOGISTICIAN']] as const) {
      const token = await accessTokenFor([...roles]);
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it('ответы авторизации не кэшируются', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { phone: uniquePhone(), pin: '1234' },
    });

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refresh-cookie httpOnly, SameSite=Strict и ограничена путём /api/auth', async () => {
    const pin = '1234';
    const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
    const user = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE', pinHash });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { phone: user.phone, pin },
    });

    expect(response.statusCode).toBe(200);

    const setCookie = response.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/auth');

    // Access-токен возвращается в теле и не кладётся в cookie.
    expect(response.json()).toHaveProperty('accessToken');
    expect(cookie).not.toContain(String(response.json().accessToken));
  });

  it('неверный PIN не создаёт временной блокировки: верный PIN сразу входит', async () => {
    const pin = '1234';
    const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
    const user = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE', pinHash });

    // Сколько бы неверных попыток ни было — временной блокировки нет.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const wrong = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { phone: user.phone, pin: '0000' },
      });
      // Отказ по учётным данным сохраняется, но это не 429: код/PIN просто неверны.
      expect(wrong.statusCode).not.toBe(429);
    }

    // Следующий ВЕРНЫЙ PIN входит немедленно, без ожидания.
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { phone: user.phone, pin },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveProperty('accessToken');

    // Блокировок учётных данных в системе не заводится.
    expect(await ctx.db.authLockout.count()).toBe(0);
  });

  it('ответ входа не содержит хешей и токена обновления', async () => {
    const pin = '1234';
    const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
    const user = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE', pinHash });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { phone: user.phone, pin },
    });

    const body = response.body;
    for (const forbidden of ['pinHash', 'refreshToken', 'tokenHash', 'successorTokenEnc']) {
      expect(body).not.toContain(forbidden);
    }
  });
});
