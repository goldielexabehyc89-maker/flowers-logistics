/**
 * Критическая проверка гонки между сменой ролей и операцией логиста.
 *
 * Права проверялись до транзакции, поэтому логист мог успеть заморозить или сбросить
 * PIN пользователю, которому администратор в этот момент выдавал ADMIN. Теперь целевая
 * строка блокируется, и права перечитываются уже внутри транзакции.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import {
  freezeUser,
  reissueActivationCode,
  resetPin,
  unfreezeUser,
  updateUser,
  type Actor,
} from './service.js';

let ctx: TestContext;

const META = { ip: null, userAgent: 'vitest' };

const adminActor = (userId: string): Actor => ({ userId, roles: ['ADMIN'] });
const logisticianActor = (userId: string): Actor => ({ userId, roles: ['LOGISTICIAN'] });

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

describe('перепроверка прав внутри транзакции', () => {
  it('одновременная выдача роли ADMIN не позволяет логисту заморозить пользователя', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });

    const before = await ctx.db.user.findUniqueOrThrow({
      where: { id: courier.id },
      select: { version: true },
    });

    const [promotion, freeze] = await Promise.allSettled([
      updateUser(
        ctx,
        adminActor(admin.id),
        courier.id,
        { version: before.version, roles: ['COURIER', 'ADMIN'] },
        META,
      ),
      freezeUser(ctx, logisticianActor(logist.id), courier.id, META),
    ]);

    expect(promotion.status).toBe('fulfilled');

    const finalState = await ctx.db.user.findUniqueOrThrow({
      where: { id: courier.id },
      select: { status: true, roles: { select: { role: true } } },
    });
    const isPrivileged = finalState.roles.some((assignment) => assignment.role === 'ADMIN');
    expect(isPrivileged).toBe(true);

    // Заморозка законна, только если успела выполниться до выдачи роли.
    // Совпадение «пользователь привилегированный и при этом заморожен логистом»
    // означало бы обход матрицы прав.
    const frozenByLogistician = freeze.status === 'fulfilled' && finalState.status === 'FROZEN';
    expect(frozenByLogistician && isPrivileged).toBe(false);
  });

  it('после выдачи роли ADMIN логист получает отказ на всех операциях', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const target = await seedUser(ctx.db, { roles: ['COURIER'] });

    const before = await ctx.db.user.findUniqueOrThrow({
      where: { id: target.id },
      select: { version: true },
    });

    await updateUser(
      ctx,
      adminActor(admin.id),
      target.id,
      { version: before.version, roles: ['COURIER', 'ADMIN'] },
      META,
    );

    const actor = logisticianActor(logist.id);

    await expect(freezeUser(ctx, actor, target.id, META)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(unfreezeUser(ctx, actor, target.id, META)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(resetPin(ctx, actor, target.id, META)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(reissueActivationCode(ctx, actor, target.id, META)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    // Ни одна из отклонённых операций не оставила следов.
    const stored = await ctx.db.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(stored.status).toBe('ACTIVE');
    expect(
      await ctx.db.activationCode.count({ where: { userId: target.id, activeKey: { not: null } } }),
    ).toBe(0);
  });
});
