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
import { appendEntry, balanceOf, reverseEntry } from './ledger.js';
import { buildCashReport } from './cash-report.js';
import { listHistory } from '../history/service.js';
import { ledgerEntryTitle } from '@fl/shared';

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
// --- Показатели кассового отчёта ----------------------------------------------

describe('итоги кассового отчёта', () => {
  const report = (overrides: Record<string, unknown> = {}) =>
    buildCashReport(ctx.db, {
      from: DAY,
      to: DAY,
      limit: 50,
      offset: 0,
      visibleLogistIds: null,
      ...overrides,
    });

  it('«Ожидается к сдаче» не гасит наличные одного курьера заработком другого', async () => {
    /*
     * Одной суммой отрицательный баланс одного курьера вычитался из
     * положительного другого: доплата, которую компания должна одному,
     * обнуляла деньги, лежащие в кармане у второго. Показатель, ради которого
     * логист открывает кассу, занижался ровно на эту величину.
     */
    const withCash = await actorFor(['COURIER']);
    const withBonus = await actorFor(['COURIER']);
    const admin = await actorFor(['ADMIN']);
    const before = BigInt((await report()).summary.expectedFromCouriersMinor);

    await ctx.db.$transaction(async (tx) => {
      await appendEntry(tx, {
        courierUserId: withCash.userId,
        kind: 'CASH_RECEIVED',
        amountMinor: 300_000n,
        operationDate: DAY,
        actorUserId: admin.userId,
        idempotencyKey: unique('expected-cash'),
      });
      await appendEntry(tx, {
        courierUserId: withBonus.userId,
        kind: 'BONUS',
        amountMinor: 300_000n,
        operationDate: DAY,
        actorUserId: admin.userId,
        reason: 'доплата за сложный адрес',
        idempotencyKey: unique('expected-bonus'),
      });
    });

    // Наличные первого курьера видны целиком, долг перед вторым их не гасит.
    expect(BigInt((await report()).summary.expectedFromCouriersMinor)).toBe(before + 300_000n);
  });

  it('итог кассы сужается выбранной кассой, как и таблица', async () => {
    const deskA = await actorFor(['LOGISTICIAN']);
    const deskB = await actorFor(['LOGISTICIAN']);
    await ctx.db.$transaction(async (tx) => {
      await appendCash(tx, {
        logistUserId: deskA.userId,
        kind: 'TAKEN_FROM_COMPANY',
        amountMinor: 100_000n,
        operationDate: DAY,
        actorUserId: deskA.userId,
        idempotencyKey: unique('desk-a'),
      });
      await appendCash(tx, {
        logistUserId: deskB.userId,
        kind: 'TAKEN_FROM_COMPANY',
        amountMinor: 900_000n,
        operationDate: DAY,
        actorUserId: deskB.userId,
        idempotencyKey: unique('desk-b'),
      });
    });

    const onlyA = await report({ logistUserId: deskA.userId });
    // Над таблицей одной кассы не может стоять сумма по всем.
    expect(onlyA.summary.cashOnHandMinor).toBe('100000');
    expect(onlyA.summary.closingMinor).toBe('100000');
    expect(onlyA.desks.map((desk) => desk.id)).toEqual([deskA.userId]);
  });

  it('деньги в кассе замороженного логиста остаются в итоге', async () => {
    /*
     * Список действующих логистов отвечает на вопрос «кому можно провести
     * операцию». Деньги замороженного человека физически существуют, и итог,
     * который их не считает, расходится с таблицей на том же экране.
     */
    const desk = await actorFor(['LOGISTICIAN']);
    await ctx.db.$transaction((tx) =>
      appendCash(tx, {
        logistUserId: desk.userId,
        kind: 'TAKEN_FROM_COMPANY',
        amountMinor: 700_000n,
        operationDate: DAY,
        actorUserId: desk.userId,
        idempotencyKey: unique('frozen-desk'),
      }),
    );
    const before = BigInt((await report()).summary.cashOnHandMinor);

    await ctx.db.user.update({ where: { id: desk.userId }, data: { status: 'FROZEN' } });

    expect(BigInt((await report()).summary.cashOnHandMinor)).toBe(before);
  });

  it('отбор по виду меняет показанное, а не остаток кассы', async () => {
    /*
     * Конец дня складывался из отобранных операций: стоило выбрать вид — и
     * «конец» показывал остаток, которого никогда не существовало.
     */
    const desk = await actorFor(['LOGISTICIAN']);
    await ctx.db.$transaction(async (tx) => {
      await appendCash(tx, {
        logistUserId: desk.userId,
        kind: 'TAKEN_FROM_COMPANY',
        amountMinor: 200_000n,
        operationDate: DAY,
        actorUserId: desk.userId,
        idempotencyKey: unique('filter-taken'),
      });
      await appendCash(tx, {
        logistUserId: desk.userId,
        kind: 'HANDED_TO_COMPANY',
        amountMinor: 50_000n,
        operationDate: DAY,
        actorUserId: desk.userId,
        idempotencyKey: unique('filter-handed'),
      });
    });

    const filtered = await report({ logistUserId: desk.userId, kind: 'TAKEN_FROM_COMPANY' });
    const group = filtered.days.find((day) => day.date === DAY)?.logists[0];
    // Показана одна операция, а остаток — настоящий: 2000 − 500 = 1500 ₽.
    expect(group?.entries).toHaveLength(1);
    expect(group?.closingMinor).toBe('150000');
  });
});
// --- История: чужие деньги ----------------------------------------------------

describe('видимость денег в истории', () => {
  const history = (visibleLogistIds: string[] | null) =>
    listHistory(ctx.db, {
      from: DAY,
      to: DAY,
      limit: 50,
      offset: 0,
      visibleLogistIds,
    });

  const kindsOf = async (visibleLogistIds: string[] | null, id: string): Promise<string[]> => {
    const page = await history(visibleLogistIds);
    return page.days
      .flatMap((day) => day.payments)
      .filter((payment) => payment.id === id)
      .map((payment) => payment.kind);
  };

  it('логист не видит в истории движения чужой кассы', async () => {
    /*
     * История отвечает на вопрос «что произошло», но чужая касса — чужие
     * деньги: на своём экране логист их не видит, и вторая дверь к тем же
     * записям сводила бы правило на нет.
     */
    const mine = await actorFor(['LOGISTICIAN']);
    const foreign = await actorFor(['LOGISTICIAN']);
    const foreignMove = await ctx.db.$transaction((tx) =>
      appendCash(tx, {
        logistUserId: foreign.userId,
        kind: 'TAKEN_FROM_COMPANY',
        amountMinor: 400_000n,
        operationDate: DAY,
        actorUserId: foreign.userId,
        idempotencyKey: unique('history-foreign'),
      }),
    );

    expect(await kindsOf([mine.userId], foreignMove.id)).toEqual([]);
    // Администратору видно всё, и запись названа как движение кассы.
    expect(await kindsOf(null, foreignMove.id)).toEqual(['DESK_TAKEN_FROM_COMPANY']);
  });

  it('свою кассу логист в истории видит', async () => {
    const mine = await actorFor(['LOGISTICIAN']);
    const ownMove = await ctx.db.$transaction(async (tx) => {
      await appendCash(tx, {
        logistUserId: mine.userId,
        kind: 'TAKEN_FROM_COMPANY',
        amountMinor: 120_000n,
        operationDate: DAY,
        actorUserId: mine.userId,
        idempotencyKey: unique('history-own-take'),
      });
      return appendCash(tx, {
        logistUserId: mine.userId,
        kind: 'HANDED_TO_COMPANY',
        amountMinor: 120_000n,
        operationDate: DAY,
        actorUserId: mine.userId,
        idempotencyKey: unique('history-own'),
      });
    });

    expect(await kindsOf([mine.userId], ownMove.id)).toEqual(['DESK_HANDED_TO_COMPANY']);
  });

  it('отмена в истории названа по отменённой операции, а не «корректировкой»', async () => {
    /*
     * У обратной записи собственный вид всегда `ADJUSTMENT`. Без вида
     * отменяемой операции отмена начального долга и отмена расхода читались бы
     * в ленте одинаково, и понять, что именно сняли, было бы нельзя.
     */
    const courier = await actorFor(['COURIER']);
    const admin = await actorFor(['ADMIN']);
    const debt = await ctx.db.$transaction((tx) =>
      appendEntry(tx, {
        courierUserId: courier.userId,
        kind: 'OPENING_DEBT',
        amountMinor: 500_000n,
        operationDate: DAY,
        actorUserId: admin.userId,
        reason: 'долг до перехода на учёт',
        idempotencyKey: unique('history-debt'),
      }),
    );
    const reversal = await ctx.db.$transaction((tx) =>
      reverseEntry(tx, {
        entryId: debt.id,
        actorUserId: admin.userId,
        reason: 'внесён ошибочно',
        operationDate: DAY,
      }),
    );

    const page = await history(null);
    const shown = page.days
      .flatMap((day) => day.payments)
      .find((payment) => payment.id === reversal.id);
    expect(shown?.reversesKind).toBe('OPENING_DEBT');
    expect(ledgerEntryTitle({ kind: shown!.kind, reversesKind: shown!.reversesKind })).toBe(
      'Отмена: Начальный долг',
    );
  });
});
