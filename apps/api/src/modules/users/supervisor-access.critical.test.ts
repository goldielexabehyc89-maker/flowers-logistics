/**
 * Серверная граница роли «Управляющий».
 *
 * Управляющий — операционный администратор: рабочие разделы и история ему
 * доступны. Но общие «Настройки», их запись, интеграции, секреты, печатные
 * точки, ячейки и изменение депо — нет. Проверяется САМ сервер, а не скрытие
 * кнопок: управляющий с настоящим токеном стучится в эндпоинты напрямую.
 *
 * Читать операционные значения, которые нужны рабочим экранам, ему можно
 * ровно двумя точечными GET — точки отгрузки и настройки планирования, — и
 * ничем больше из настроечного семейства.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecretCode } from '../auth/crypto.js';
import { login } from '../auth/service.js';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from '../auth/testing/harness.js';
import type { Role } from '@fl/shared';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

async function tokenFor(roles: Role[]): Promise<string> {
  const pin = '7315';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles, pinHash });
  const session = await login(
    ctx,
    { phone: user.phone, pin },
    { ip: null, userAgent: 'vitest', deviceLabel: null },
  );
  return session.accessToken;
}

async function status(
  token: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown,
): Promise<number> {
  const response = await ctx.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return response.statusCode;
}

describe('операционные разделы управляющему доступны', () => {
  it('читает рабочие данные, в том числе два точечных настроечных GET', async () => {
    const token = await tokenFor(['SUPERVISOR']);

    // Точки отгрузки — их рисует карта сделок; настройки планирования — их
    // читают маршрутные листы. Оба GET рабочим экранам необходимы.
    expect(await status(token, 'GET', '/api/depots')).toBe(200);
    expect(await status(token, 'GET', '/api/settings/planning')).toBe(200);

    // Управление сотрудниками и счётчик «Требуют решения» — операционные разделы.
    expect(await status(token, 'GET', '/api/users?status=ACTIVE&role=COURIER')).toBe(200);
    expect(await status(token, 'GET', '/api/logistics/resolutions/count')).toBe(200);
  });
});

describe('настройки, интеграции и секреты управляющему закрыты', () => {
  it('любая запись настроек и депо — 403, а не тихое применение', async () => {
    const token = await tokenFor(['SUPERVISOR']);

    // Проверка прав идёт ДО разбора тела: пустое тело всё равно даёт 403,
    // потому что до валидации дело не доходит.
    expect(await status(token, 'PUT', '/api/settings/planning/shift', {})).toBe(403);
    expect(await status(token, 'POST', '/api/depots', {})).toBe(403);
    expect(await status(token, 'POST', '/api/storage-cells', {})).toBe(403);
  });

  it('интеграции, очередь синхронизации и печатные точки — 403', async () => {
    const token = await tokenFor(['SUPERVISOR']);

    expect(await status(token, 'GET', '/api/outbox/failures')).toBe(403);
    expect(await status(token, 'GET', '/api/print-points')).toBe(403);
  });
});
