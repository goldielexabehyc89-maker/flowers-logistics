/**
 * Критические проверки кассы логиста (этап 7.2).
 *
 * Проверяется не «складываются ли числа», а то, нарушение чего означает
 * пропавшие наличные: половина передачи без второй половины, отрицательная
 * касса, две параллельные выдачи из одного остатка, повторный запрос,
 * отменённая наполовину передача и чужая касса.
 *
 * Даты подобраны так, чтобы не пересекаться с другими файлами набора.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import type { Role } from '@fl/shared';
import { appendCash, cashBalanceOf, reverseCash } from './cash.js';
import { recordTransfer, resolveDeskOwner, reverseTransfer } from './transfers.js';
import { balanceOf } from './ledger.js';
import { buildCashReport } from './cash-report.js';

let ctx: TestContext;

/** День вне диапазонов остальных файлов набора. */
const DAY = '2028-05-14';
const NEXT_DAY = '2028-05-15';

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${randomUUID().slice(0, 8)}`;
}

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return { userId: user.id, roles, familyId: randomUUID() } as AuthenticatedActor;
}

describe('передача наличных меняет обе стороны', () => {
  it('«курьер сдал» уменьшает долг курьера и увеличивает кассу логиста', async () => {
    const logist = await actorFor(['LOGISTICIAN']);
    const courier = await actorFor(['COURIER']);

    await ctx.db.$transaction((tx) =>
      recordTransfer(tx, logist, {
        kind: 'HANDED_BY_COURIER',
        courierUserId: courier.userId,
        logistUserId: logist.userId,
        amountMinor: 500_00n,
        operationDate: DAY,
        idempotencyKey: unique('transfer'),
      }),
    );

    expect(await cashBalanceOf(ctx.db, logist.userId, null)).toBe(500_00n);
    expect(await balanceOf(ctx.db, courier.userId, null)).toBe(-500_00n);

    // Обе записи связаны одним идентификатором передачи.
    const cash = await ctx.db.logistCashEntry.findFirstOrThrow({
      where: { logistUserId: logist.userId },
      select: { transferId: true },
    });
    const ledger = await ctx.db.courierLedgerEntry.findFirstOrThrow({
      where: { courierUserId: courier.userId },
      select: { transferId: true },
    });
    expect(cash.transferId).not.toBeNull();
    expect(ledger.transferId).toBe(cash.transferId);
  });

  it('«выдано курьеру» атомарно уменьшает кассу и увеличивает долг курьера', async () => {
    const logist = await actorFor(['LOGISTICIAN']);
    const courier = await actorFor(['COURIER']);

    await ctx.db.$transaction((tx) =>
      appendCash(tx, {
        logistUserId: logist.userId,
        kind: 'TAKEN_FROM_COMPANY',
        amountMinor: 1_000_00n,
        operationDate: DAY,
        actorUserId: logist.userId,
        idempotencyKey: unique('take'),
      }),
    );

    await ctx.db.$transaction((tx) =>
      recordTransfer(tx, logist, {
        kind: 'ISSUED_TO_COURIER',
        courierUserId: courier.userId,
        logistUserId: logist.userId,
        amountMinor: 300_00n,
        operationDate: DAY,
        idempotencyKey: unique('transfer'),
      }),
    );

    expect(await cashBalanceOf(ctx.db, logist.userId, null)).toBe(700_00n);
    expect(await balanceOf(ctx.db, courier.userId, null)).toBe(300_00n);
  });

  it('дополнительный расход курьера кассу не трогает', async () => {
    const logist = await actorFor(['LOGISTICIAN']);
    const courier = await actorFor(['COURIER']);

    await ctx.db.courierLedgerEntry.create({
      data: {
        courierUserId: courier.userId,
        kind: 'EXPENSE_OTHER',
        amountMinor: -150_00n,
        operationDate: new Date(`${DAY}T00:00:00.000Z`),
        actorUserId: logist.userId,
        reason: 'парковка',
        idempotencyKey: unique('expense'),
      },
    });

    expect(await cashBalanceOf(ctx.db, logist.userId, null)).toBe(0n);
    expect(await balanceOf(ctx.db, courier.userId, null)).toBe(-150_00n);
  });
});

describe('остаток кассы', () => {
  it('сдача в компанию уменьшает остаток, получение увеличивает', async () => {
    const logist = await actorFor(['LOGISTICIAN']);

    await ctx.db.$transaction((tx) =>
      appendCash(tx, {
        logistUserId: logist.userId,
        kind: 'TAKEN_FROM_COMPANY',
        amountMinor: 800_00n,
        operationDate: DAY,
        actorUserId: logist.userId,
        idempotencyKey: unique('take'),
      }),
    );
    expect(await cashBalanceOf(ctx.db, logist.userId, null)).toBe(800_00n);

    await ctx.db.$transaction((tx) =>
      appendCash(tx, {
        logistUserId: logist.userId,
        kind: 'HANDED_TO_COMPANY',
        amountMinor: 300_00n,
        operationDate: DAY,
        actorUserId: logist.userId,
        idempotencyKey: unique('hand'),
      }),
    );
    expect(await cashBalanceOf(ctx.db, logist.userId, null)).toBe(500_00n);
  });

  it('отрицательная касса запрещена', async () => {
    const logist = await actorFor(['LOGISTICIAN']);
    const courier = await actorFor(['COURIER']);

    await expect(
      ctx.db.$transaction((tx) =>
        recordTransfer(tx, logist, {
          kind: 'ISSUED_TO_COURIER',
          courierUserId: courier.userId,
          logistUserId: logist.userId,
          amountMinor: 100n,
          operationDate: DAY,
          idempotencyKey: unique('transfer'),
        }),
      ),
    ).rejects.toThrow(
      expect.objectContaining({
        publicMessage: expect.stringContaining('недостаточно наличных'),
      }) as Error,
    );

    // Ни одна сторона не записалась: половины передачи не существует.
    expect(await cashBalanceOf(ctx.db, logist.userId, null)).toBe(0n);
    expect(await balanceOf(ctx.db, courier.userId, null)).toBe(0n);
  });

  it('две параллельные выдачи не могут вместе превысить остаток', async () => {
    const logist = await actorFor(['LOGISTICIAN']);
    const first = await actorFor(['COURIER']);
    const second = await actorFor(['COURIER']);

    await ctx.db.$transaction((tx) =>
      appendCash(tx, {
        logistUserId: logist.userId,
        kind: 'TAKEN_FROM_COMPANY',
        amountMinor: 500_00n,
        operationDate: DAY,
        actorUserId: logist.userId,
        idempotencyKey: unique('take'),
      }),
    );

    const issue = (courierId: string): Promise<unknown> =>
      ctx.db.$transaction((tx) =>
        recordTransfer(tx, logist, {
          kind: 'ISSUED_TO_COURIER',
          courierUserId: courierId,
          logistUserId: logist.userId,
          amountMinor: 400_00n,
          operationDate: DAY,
          idempotencyKey: unique('transfer'),
        }),
      );

    const results = await Promise.allSettled([issue(first.userId), issue(second.userId)]);
    const fulfilled = results.filter((item) => item.status === 'fulfilled').length;

    // Ровно одна выдача проходит: вторая упирается в остаток.
    expect(fulfilled).toBe(1);
    expect(await cashBalanceOf(ctx.db, logist.userId, null)).toBe(100_00n);
  });

  it('остаток переносится между московскими днями', async () => {
    const logist = await actorFor(['LOGISTICIAN']);

    await ctx.db.$transaction((tx) =>
      appendCash(tx, {
        logistUserId: logist.userId,
        kind: 'TAKEN_FROM_COMPANY',
        amountMinor: 200_00n,
        operationDate: DAY,
        actorUserId: logist.userId,
        idempotencyKey: unique('take'),
      }),
    );
    await ctx.db.$transaction((tx) =>
      appendCash(tx, {
        logistUserId: logist.userId,
        kind: 'HANDED_TO_COMPANY',
        amountMinor: 50_00n,
        operationDate: NEXT_DAY,
        actorUserId: logist.userId,
        idempotencyKey: unique('hand'),
      }),
    );

    const report = await buildCashReport(ctx.db, {
      from: NEXT_DAY,
      to: NEXT_DAY,
      limit: 50,
      offset: 0,
      visibleLogistIds: [logist.userId],
    });

    const group = report.days[0]?.logists[0];
    // Вчерашние деньги не исчезают в полночь.
    expect(group?.openingMinor).toBe('20000');
    expect(group?.closingMinor).toBe('15000');
  });
});

describe('идемпотентность и отмены', () => {
  it('повтор одного запроса не создаёт дубль на обеих сторонах', async () => {
    const logist = await actorFor(['LOGISTICIAN']);
    const courier = await actorFor(['COURIER']);
    const key = unique('transfer');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await ctx.db.$transaction((tx) =>
        recordTransfer(tx, logist, {
          kind: 'HANDED_BY_COURIER',
          courierUserId: courier.userId,
          logistUserId: logist.userId,
          amountMinor: 250_00n,
          operationDate: DAY,
          idempotencyKey: key,
        }),
      );
    }

    expect(await ctx.db.logistCashEntry.count({ where: { logistUserId: logist.userId } })).toBe(1);
    expect(
      await ctx.db.courierLedgerEntry.count({ where: { courierUserId: courier.userId } }),
    ).toBe(1);
    expect(await cashBalanceOf(ctx.db, logist.userId, null)).toBe(250_00n);
  });

  it('отмена передачи создаёт обратные записи на обеих сторонах', async () => {
    const logist = await actorFor(['LOGISTICIAN']);
    const courier = await actorFor(['COURIER']);

    const result = await ctx.db.$transaction((tx) =>
      recordTransfer(tx, logist, {
        kind: 'HANDED_BY_COURIER',
        courierUserId: courier.userId,
        logistUserId: logist.userId,
        amountMinor: 400_00n,
        operationDate: DAY,
        idempotencyKey: unique('transfer'),
      }),
    );

    await ctx.db.$transaction((tx) =>
      reverseTransfer(tx, {
        transferId: result.transferId,
        actorUserId: logist.userId,
        reason: 'деньги пересчитали, сумма другая',
        operationDate: DAY,
      }),
    );

    expect(await cashBalanceOf(ctx.db, logist.userId, null)).toBe(0n);
    expect(await balanceOf(ctx.db, courier.userId, null)).toBe(0n);
    // Исходные записи остались: история не переписана.
    expect(await ctx.db.logistCashEntry.count({ where: { logistUserId: logist.userId } })).toBe(2);
  });

  it('одну запись кассы нельзя отменить дважды', async () => {
    const logist = await actorFor(['LOGISTICIAN']);

    const entry = await ctx.db.$transaction((tx) =>
      appendCash(tx, {
        logistUserId: logist.userId,
        kind: 'TAKEN_FROM_COMPANY',
        amountMinor: 100_00n,
        operationDate: DAY,
        actorUserId: logist.userId,
        idempotencyKey: unique('take'),
      }),
    );

    await ctx.db.$transaction((tx) =>
      reverseCash(tx, {
        entryId: entry.id,
        actorUserId: logist.userId,
        reason: 'взято по ошибке',
        operationDate: DAY,
      }),
    );

    await expect(
      ctx.db.$transaction((tx) =>
        reverseCash(tx, {
          entryId: entry.id,
          actorUserId: logist.userId,
          reason: 'повторная отмена',
          operationDate: DAY,
        }),
      ),
    ).rejects.toThrow(
      expect.objectContaining({ publicMessage: expect.stringContaining('уже отменена') }) as Error,
    );
  });

  it('запись кассы нельзя изменить или удалить', async () => {
    const logist = await actorFor(['LOGISTICIAN']);
    const entry = await ctx.db.$transaction((tx) =>
      appendCash(tx, {
        logistUserId: logist.userId,
        kind: 'TAKEN_FROM_COMPANY',
        amountMinor: 100_00n,
        operationDate: DAY,
        actorUserId: logist.userId,
        idempotencyKey: unique('take'),
      }),
    );

    await expect(
      ctx.db.logistCashEntry.update({ where: { id: entry.id }, data: { amountMinor: 1n } }),
    ).rejects.toThrow(/неизменяема/);
    await expect(ctx.db.logistCashEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /неизменяема/,
    );
  });
});

describe('права на кассу', () => {
  it('логист работает только со своей кассой', async () => {
    const logist = await actorFor(['LOGISTICIAN']);
    const other = await actorFor(['LOGISTICIAN']);

    expect(resolveDeskOwner(logist, undefined)).toBe(logist.userId);
    expect(resolveDeskOwner(logist, logist.userId)).toBe(logist.userId);
    expect(() => resolveDeskOwner(logist, other.userId)).toThrow(
      expect.objectContaining({
        publicMessage: expect.stringContaining('только со своей'),
      }) as Error,
    );
  });

  it('администратор обязан выбрать кассу, а автором остаётся сам', async () => {
    const admin = await actorFor(['ADMIN']);
    const logist = await actorFor(['LOGISTICIAN']);
    const courier = await actorFor(['COURIER']);

    expect(() => resolveDeskOwner(admin, undefined)).toThrow(
      expect.objectContaining({
        publicMessage: expect.stringContaining('Выберите логиста'),
      }) as Error,
    );

    await ctx.db.$transaction((tx) =>
      recordTransfer(tx, admin, {
        kind: 'HANDED_BY_COURIER',
        courierUserId: courier.userId,
        logistUserId: resolveDeskOwner(admin, logist.userId),
        amountMinor: 700_00n,
        operationDate: DAY,
        idempotencyKey: unique('transfer'),
      }),
    );

    const entry = await ctx.db.logistCashEntry.findFirstOrThrow({
      where: { logistUserId: logist.userId },
      select: { logistUserId: true, actorUserId: true },
    });

    // Деньги в кассе логиста, автор — администратор: это разные люди.
    expect(entry.logistUserId).toBe(logist.userId);
    expect(entry.actorUserId).toBe(admin.userId);
  });

  it('касса начинается с нуля: прошлых операций она не наследует', async () => {
    const logist = await actorFor(['LOGISTICIAN']);
    expect(await cashBalanceOf(ctx.db, logist.userId, null)).toBe(0n);
  });
});
