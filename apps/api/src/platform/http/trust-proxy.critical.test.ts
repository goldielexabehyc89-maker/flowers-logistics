/**
 * Доверие к обратному прокси: чей адрес приложение считает адресом клиента.
 *
 * Прокси признаётся только по адресу, с которого он подключается
 * (`TRUST_PROXY=<адрес>`). Числа переходов нет: Fastify ≥ 5.12.1 по нему никому
 * не доверяет, а конфигурация такое значение отвергает при запуске.
 *
 * Проверяется на настоящем приложении и настоящей записи: неудачная попытка
 * входа сохраняет `AuthAttempt.ip` — тот самый адрес, который попадает в сессии
 * и аудит. Защищаемое:
 *
 *  * через доверенный прокси приложение берёт адрес клиента из X-Forwarded-For;
 *  * от недоверенного соединения поддельные X-Forwarded-* не принимаются;
 *  * значение, подставленное клиентом в X-Forwarded-For и сохранённое прокси
 *    левее настоящего адреса, адрес клиента не подменяет;
 *  * подделанные протокол и хост от недоверенного соединения тоже не приняты.
 *
 * Адреса синтетические: «прокси» — из частного диапазона, клиенты — из
 * документационных TEST-NET. Настоящий адрес прокси окружения в коде не живёт.
 */

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  uniquePhone,
  type TestContext,
} from '../../modules/auth/testing/harness.js';
import { parseTrustProxy } from '../config.js';

const PROXY = '10.77.0.1';
const CLIENT = '203.0.113.7';
const SPOOF = '198.51.100.23';
const STRANGER = '192.0.2.44';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ TRUST_PROXY: PROXY });
});

afterAll(async () => {
  await closeTestContext(ctx);
});

/** Неудачный вход от имени соединения `remoteAddress`; возвращает записанный адрес. */
async function recordedIp(
  remoteAddress: string,
  headers: Record<string, string> = {},
): Promise<string | null> {
  const phone = uniquePhone();
  const response = (await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress,
    headers,
    payload: { phone, pin: '0000' },
  })) as unknown as { statusCode: number };
  expect(response.statusCode).toBe(401);

  const attempt = await ctx.db.authAttempt.findFirstOrThrow({
    where: { phone },
    orderBy: { id: 'desc' },
    select: { ip: true },
  });
  return attempt.ip;
}

describe('адрес клиента за обратным прокси', () => {
  it('через доверенный прокси записывается настоящий адрес клиента', async () => {
    expect(await recordedIp(PROXY, { 'x-forwarded-for': CLIENT })).toBe(CLIENT);
  });

  it('от недоверенного соединения поддельный X-Forwarded-For не принят', async () => {
    expect(
      await recordedIp(STRANGER, {
        'x-forwarded-for': SPOOF,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'spoofed.example',
      }),
    ).toBe(STRANGER);
  });

  it('подставленный клиентом адрес левее настоящего не подменяет его', async () => {
    // Прокси, сохранивший пришедший заголовок, дописывает настоящий адрес
    // справа. Доверен ровно один переход — сам прокси, — поэтому берётся
    // крайний правый недоверенный адрес, а подставленный слева отбрасывается.
    expect(await recordedIp(PROXY, { 'x-forwarded-for': `${SPOOF}, ${CLIENT}` })).toBe(CLIENT);
  });

  it('соединение самого прокси без заголовка записывается его адресом', async () => {
    expect(await recordedIp(PROXY)).toBe(PROXY);
  });
});

describe('X-Forwarded-* за пределами адреса клиента', () => {
  it('протокол и хост принимаются только от доверенного прокси', async () => {
    const app = Fastify({ trustProxy: parseTrustProxy(PROXY) });
    app.get('/whoami', async (request) => ({
      ip: request.ip,
      protocol: request.protocol,
      host: request.host,
    }));
    try {
      const forged = {
        'x-forwarded-for': SPOOF,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'spoofed.example',
        host: 'app.internal',
      };

      const untrusted = await app.inject({
        method: 'GET',
        url: '/whoami',
        remoteAddress: STRANGER,
        headers: forged,
      });
      expect(untrusted.json()).toEqual({ ip: STRANGER, protocol: 'http', host: 'app.internal' });

      const trusted = await app.inject({
        method: 'GET',
        url: '/whoami',
        remoteAddress: PROXY,
        headers: { ...forged, 'x-forwarded-for': CLIENT },
      });
      expect(trusted.json()).toEqual({ ip: CLIENT, protocol: 'https', host: 'spoofed.example' });
    } finally {
      await app.close();
    }
  });
});
