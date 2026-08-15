/**
 * Проверки отчётного состояния подсказок адреса.
 *
 * Защищаемое свойство одно и стоило доверия к панели: отчёт совпадает
 * с фактом. Прежняя запись `dadata` осталась от переименованного кода, никем
 * не обновлялась и показывала «Не настроена», пока подсказки работали.
 *
 * Отдельно проверяется, что наружу не уходит ни ключ, ни запрос, ни адрес:
 * `state` этой записи виден вообще без авторизации.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../../auth/testing/harness.js';
import { TEST_SECRETS } from '../../../platform/testing/secrets.js';
import { hashSecretCode } from '../../auth/crypto.js';
import { login } from '../../auth/service.js';
import {
  reportSuggestionsStartupStatus,
  setSuggestionsStatus,
  SUGGESTIONS_PROVIDER,
} from './status.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

async function adminToken(): Promise<string> {
  const pin = '1234';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles: ['ADMIN'], pinHash });
  const session = await login(
    ctx,
    { phone: user.phone, pin },
    { ip: null, userAgent: 'vitest', deviceLabel: null },
  );
  return session.accessToken;
}

async function currentRow(): Promise<{
  state: string;
  details: unknown;
  lastOkAt: Date | null;
} | null> {
  return ctx.db.integrationStatus.findUnique({
    where: { provider: SUGGESTIONS_PROVIDER },
    select: { state: true, details: true, lastOkAt: true },
  });
}

describe('состояние подсказок адреса', () => {
  it('без ключа и разрешённого окружения — «не настроена»', async () => {
    await reportSuggestionsStartupStatus(ctx.db, { allowed: false });

    const row = await currentRow();
    expect(row?.state).toBe('NOT_CONFIGURED');
    expect(row?.lastOkAt).toBeNull();
  });

  it('настроенные подсказки при старте не выдаются за работающие', async () => {
    // `OK` авансом означал бы, что панель подтверждает работоспособность,
    // которую никто не проверял.
    await reportSuggestionsStartupStatus(ctx.db, { allowed: true });

    const row = await currentRow();
    expect(row?.state).toBe('CONFIGURED');
    expect(row?.lastOkAt).toBeNull();
  });

  it('успешная выдача подсказок переводит запись в «работает»', async () => {
    await setSuggestionsStatus(ctx.db, 'OK', { reason: 'suggestions-served', returned: 2 });

    const row = await currentRow();
    expect(row?.state).toBe('OK');
    expect(row?.lastOkAt).not.toBeNull();
  });

  it('отказ провайдера виден дежурному', async () => {
    await setSuggestionsStatus(ctx.db, 'ERROR', { reason: 'provider-failed' });

    const row = await currentRow();
    expect(row?.state).toBe('ERROR');
  });

  it('в деталях нет ни ключа, ни запроса, ни адреса', async () => {
    await setSuggestionsStatus(ctx.db, 'OK', { reason: 'suggestions-served', returned: 3 });

    const row = await currentRow();
    const details = JSON.stringify(row?.details ?? {});
    for (const forbidden of ['key', 'token', 'query', 'address', 'Москва', 'secret']) {
      expect(details.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });

  it('панель интеграций отдаёт запись администратору', async () => {
    await setSuggestionsStatus(ctx.db, 'OK', { reason: 'suggestions-served', returned: 1 });
    const token = await adminToken();

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/status/integrations',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { integrations: { provider: string; state: string }[] };
    const dadata = body.integrations.find((row) => row.provider === SUGGESTIONS_PROVIDER);
    expect(dadata?.state).toBe('OK');
  });
});
