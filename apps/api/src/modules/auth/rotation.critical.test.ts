/**
 * Критические сценарии конкурентной ротации refresh-токена.
 *
 * Это самая тонкая часть авторизации: ошибка здесь либо разлогинивает пользователей
 * на ровном месте, либо оставляет украденный токен рабочим. Проверяются все сценарии,
 * утверждённые владельцем, включая предъявление устаревшего предка.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, refresh } from './service.js';
import { hashSecretCode, hashRefreshToken } from './crypto.js';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from './testing/harness.js';

let ctx: TestContext;

const CONTEXT = { ip: '10.9.0.1', userAgent: 'vitest', deviceLabel: null };

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

async function loginFresh(pin = '1234') {
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE', pinHash });
  const session = await login(ctx, { phone: user.phone, pin }, CONTEXT);
  return { user, session };
}

/** Количество живых (не отозванных и не ротированных) токенов в семье. */
async function activeBranches(userId: string): Promise<number> {
  return ctx.db.refreshSession.count({
    where: { userId, revokedAt: null, rotatedAt: null },
  });
}

describe('конкурентная ротация refresh-токена', () => {
  it('1. два одновременных запроса получают один и тот же токен и одну активную ветку', async () => {
    const { user, session } = await loginFresh();

    const [first, second] = await Promise.all([
      refresh(ctx, session.refreshToken, CONTEXT),
      refresh(ctx, session.refreshToken, CONTEXT),
    ]);

    expect(first.refreshToken).toBe(second.refreshToken);
    expect(first.refreshToken).not.toBe(session.refreshToken);
    expect(await activeBranches(user.id)).toBe(1);

    // Семья жива: повторное использование не сработало как атака.
    const revoked = await ctx.db.refreshSession.count({
      where: { userId: user.id, revokedReason: 'REFRESH_TOKEN_REUSE' },
    });
    expect(revoked).toBe(0);
  });

  it('2. повтор старого токена внутри grace возвращает того же преемника', async () => {
    const { user, session } = await loginFresh();

    const rotated = await refresh(ctx, session.refreshToken, CONTEXT);
    const replayed = await refresh(ctx, session.refreshToken, CONTEXT);

    expect(replayed.refreshToken).toBe(rotated.refreshToken);
    expect(await activeBranches(user.id)).toBe(1);
  });

  it('3. повтор старого токена после grace — reuse: вся семья отозвана и записан аудит', async () => {
    const { user, session } = await loginFresh();

    await refresh(ctx, session.refreshToken, CONTEXT);

    // Grace-окно истекло.
    await ctx.db.refreshSession.updateMany({
      where: { tokenHash: hashRefreshToken(session.refreshToken) },
      data: { graceUntil: new Date(Date.now() - 1000) },
    });

    await expect(refresh(ctx, session.refreshToken, CONTEXT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });

    const alive = await ctx.db.refreshSession.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(alive).toBe(0);

    const audit = await ctx.db.auditLog.findFirst({
      where: { actorUserId: user.id, action: 'AUTH_REFRESH_REUSE_DETECTED' },
    });
    expect(audit).not.toBeNull();
  });

  it('4. потерянный ответ первого запроса не лишает клиента доступа', async () => {
    const { session } = await loginFresh();

    // Клиент не получил ответ и повторяет запрос тем же токеном.
    const firstAnswer = await refresh(ctx, session.refreshToken, CONTEXT);
    const retry = await refresh(ctx, session.refreshToken, CONTEXT);

    expect(retry.refreshToken).toBe(firstAnswer.refreshToken);

    // Полученным токеном можно продолжать работу.
    const next = await refresh(ctx, retry.refreshToken, CONTEXT);
    expect(next.refreshToken).not.toBe(retry.refreshToken);
  });

  it('5. устройства независимы: отзыв одной семьи не трогает другую', async () => {
    const pin = '4444';
    const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
    const user = await seedUser(ctx.db, { roles: ['COURIER'], status: 'ACTIVE', pinHash });

    const phone = await ctx.db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { phone: true },
    });

    const deviceA = await login(ctx, { phone: phone.phone, pin }, CONTEXT);
    const deviceB = await login(ctx, { phone: phone.phone, pin }, CONTEXT);

    // Устройство A компрометируется повторным использованием после grace.
    await refresh(ctx, deviceA.refreshToken, CONTEXT);
    await ctx.db.refreshSession.updateMany({
      where: { tokenHash: hashRefreshToken(deviceA.refreshToken) },
      data: { graceUntil: new Date(Date.now() - 1000) },
    });
    await expect(refresh(ctx, deviceA.refreshToken, CONTEXT)).rejects.toThrow();

    // Устройство B продолжает работать.
    const stillWorks = await refresh(ctx, deviceB.refreshToken, CONTEXT);
    expect(stillWorks.refreshToken).not.toBe(deviceB.refreshToken);
  });

  it('6. устаревший предок после ротации преемника — reuse даже внутри grace', async () => {
    const { user, session } = await loginFresh();

    // Цепочка: session → first → second. Grace предка ещё не истёк.
    const first = await refresh(ctx, session.refreshToken, CONTEXT);
    await refresh(ctx, first.refreshToken, CONTEXT);

    const ancestor = await ctx.db.refreshSession.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(session.refreshToken) },
      select: { graceUntil: true },
    });
    expect(ancestor.graceUntil).not.toBeNull();
    expect((ancestor.graceUntil as Date).getTime()).toBeGreaterThan(Date.now());

    await expect(refresh(ctx, session.refreshToken, CONTEXT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });

    const alive = await ctx.db.refreshSession.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(alive).toBe(0);
  });

  it('копия преемника обесценивается при следующей ротации в этой же семье', async () => {
    // Название точное: очистка ленивая. Глобальной фоновой чистки просроченных
    // копий в этой ветке нет — она обязательна до staging (см. ROADMAP, пункт 1.4).
    const { session } = await loginFresh();

    const rotated = await refresh(ctx, session.refreshToken, CONTEXT);

    // После ротации преемника копия предка обесценивается.
    await refresh(ctx, rotated.refreshToken, CONTEXT);

    const ancestor = await ctx.db.refreshSession.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(session.refreshToken) },
      select: { successorTokenEnc: true },
    });
    expect(ancestor.successorTokenEnc).toBeNull();
  });

  it('неизвестный и отозванный токен отклоняются без побочных эффектов', async () => {
    await expect(refresh(ctx, 'совершенно-неизвестный-токен', CONTEXT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });

    const { session } = await loginFresh();
    await ctx.db.refreshSession.updateMany({
      where: { tokenHash: hashRefreshToken(session.refreshToken) },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
    });

    await expect(refresh(ctx, session.refreshToken, CONTEXT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
});
