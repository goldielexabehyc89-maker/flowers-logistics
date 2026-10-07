/**
 * Счётчик «В сборке» у флориста (CORE-POSTCARD-MARKERS-AND-FLORIST-COUNTER-01).
 *
 * Защищаемое:
 *
 *  * в счётчик входят только заказы с датой ДОСТАВКИ не раньше вчерашнего
 *    московского дня: позавчера — нет; вчера, сегодня и будущее — да;
 *    заказ без даты сегодняшним не считается и не входит;
 *  * прежние условия сохранены: только свои заказы и только `IN_ASSEMBLY`;
 *  * «вчера» — календарный день Москвы, а не последние 24 часа, в том числе
 *    с 21:00 до 24:00 UTC, когда дата UTC отстаёт от московской на день;
 *  * граница сдвигается в полночь сама: тот же процесс, тот же заказ, другой
 *    момент — другое число, без перезапуска и без кеша;
 *  * меняется ТОЛЬКО число: старый заказ остаётся за флористом, в «Моих
 *    заказах» и в бейдже вкладки, флорист с ним по-прежнему занят для
 *    AUTO-раздачи, а закрытие смены видит всю оставленную работу.
 *
 * ВЛАДЕНИЕ ДАТАМИ: март 2031 и май 2026 (`platform/testing/test-days.ts`).
 * Май 2026 нужен ровно одной проверке маршрута с настоящими часами: это
 * заведомо прошедший день, которого счётчик уже никогда не учтёт.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@fl/shared';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from '../auth/testing/harness.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { snapshotHash, type FulfillmentSnapshot } from './composition.js';
import {
  closeOwnShift,
  countCurrentAssembly,
  currentAssemblyFloor,
  listActiveShifts,
  listAssignableFlorists,
  ownShift,
  startShift,
} from './shifts.js';
import { countActiveAssignments, readQueue } from './queue-service.js';
import { dispatchFlorists } from './dispatch.js';
import { floristDispatchStatus } from './dispatch-florist.js';
import { readFloristDispatchMode, saveFloristDispatchMode } from '../settings/service.js';

/** «Сегодня» проверок: 7 марта 2031 года по Москве. */
const TODAY = '2031-03-07';
const YESTERDAY_DAY = '2031-03-06';
const BEFORE_YESTERDAY_DAY = '2031-03-05';
const FUTURE_DAY = '2031-03-09';
/** 12:00 Москвы 7 марта. */
const NOW = new Date('2031-03-07T09:00:00.000Z');

/** Заведомо прошедший день для проверки маршрута с настоящими часами. */
const PAST_REAL_DAY = '2026-05-14';
/** Заведомо будущий день для той же проверки. */
const FUTURE_REAL_DAY = '2031-03-20';

const CONTEXT = { ip: null, userAgent: null };

let ctx: TestContext;
let admin: AuthenticatedActor;

beforeAll(async () => {
  ctx = await createTestContext();
  const adminUser = await seedUser(ctx.db, { roles: ['ADMIN'], fullName: 'Админ счётчика' });
  admin = { userId: adminUser.id, roles: ['ADMIN'], familyId: randomUUID() } as AuthenticatedActor;
});

afterAll(async () => {
  // Режим раздачи глобальный: оставить AUTO включённым — сломать очередь всем
  // следующим файлам общей базы.
  await setAuto(false);
  await closeTestContext(ctx);
});

afterEach(async () => {
  await setAuto(false);
});

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${sequence}`;
}

async function setAuto(auto: boolean): Promise<void> {
  const current = await readFloristDispatchMode(ctx.db);
  if (current.value.auto === auto) {
    return;
  }
  await saveFloristDispatchMode(ctx.db, admin, {
    value: { auto },
    expectedVersion: current.version,
    ip: null,
    userAgent: null,
  });
}

function composition(externalId: string): FulfillmentSnapshot {
  return {
    externalId,
    description: 'Букет',
    cardText: null,
    positions: [],
  };
}

type ProcessState = 'NEW' | 'IN_ASSEMBLY' | 'ASSEMBLED' | 'NEEDS_REVIEW';

/**
 * Заказ производственной области с подтверждённым составом.
 *
 * `assignee` — флорист, за которым заказ числится; без него заказ свободный
 * (`NEW`). Собранные состояния требуют ревизии: её и ссылку на неё база
 * проверяет ограничением, поэтому они проставляются вторым шагом.
 */
async function seedOrder(options: {
  day: string | null;
  assignee?: string;
  state?: ProcessState;
}): Promise<{ id: string; number: string }> {
  const state: ProcessState =
    options.state ?? (options.assignee === undefined ? 'NEW' : 'IN_ASSEMBLY');
  const number = unique('AC');
  const externalId = randomUUID();
  const snap = composition(externalId);
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId,
      externalName: number,
      externalUpdated: new Date('2031-03-01T00:00:00.000Z'),
      deliveryDate: options.day === null ? null : toDateColumn(options.day),
      intervalKind: 'RANGE',
      intervalStartMinute: 600,
      intervalEndMinute: 840,
      inScope: true,
      fulfillmentInScope: true,
      fulfillmentDescription: snap.description,
      fulfillmentCardText: snap.cardText,
      fulfillmentSnapshotHash: snapshotHash(snap),
      fulfillmentCompositionState: 'READY',
      fulfillmentCompositionSyncedAt: new Date(),
      ...(state === 'NEW'
        ? {}
        : {
            fulfillmentProcessState: 'IN_ASSEMBLY' as const,
            fulfillmentAssigneeId: options.assignee ?? null,
            fulfillmentAssignedAt: new Date('2031-03-01T08:00:00.000Z'),
          }),
      fulfillmentRevisions: {
        create: {
          externalUpdated: new Date('2031-03-01T00:00:00.000Z'),
          snapshot: snap as never,
          snapshotHash: snapshotHash(snap),
          changedFields: ['externalId', 'description', 'positions'],
          reason: 'INITIAL_IMPORT',
        },
      },
    },
    select: { id: true, fulfillmentRevisions: { select: { id: true } } },
  });

  if (state === 'ASSEMBLED' || state === 'NEEDS_REVIEW') {
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: {
        fulfillmentProcessState: state,
        fulfillmentAssembledAt: new Date('2031-03-01T09:00:00.000Z'),
        fulfillmentAssembledById: options.assignee ?? null,
        fulfillmentAssembledRevisionId: order.fulfillmentRevisions[0]?.id ?? null,
      },
    });
  }

  return { id: order.id, number };
}

/** Флорист на активной смене. */
async function floristOnShift(name: string): Promise<AuthenticatedActor & { shiftId: string }> {
  const user = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: name });
  const actor = {
    userId: user.id,
    roles: ['FLORIST'],
    familyId: randomUUID(),
  } as AuthenticatedActor;
  await startShift(ctx.db, actor, CONTEXT);
  const shift = await ctx.db.floristShift.findFirstOrThrow({
    where: { activeKey: user.id },
    select: { id: true },
  });
  return Object.assign(actor, { shiftId: shift.id });
}

async function loginAs(roles: Role[]): Promise<{ token: string; userId: string }> {
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
  return { token: session.accessToken, userId: user.id };
}

async function get(
  url: string,
  token: string,
): Promise<{ statusCode: number; json: () => unknown }> {
  return ctx.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  }) as unknown as Promise<{ statusCode: number; json: () => unknown }>;
}

describe('граница счётчика — вчерашний день Москвы', () => {
  it('днём: вчера по Москве', () => {
    expect(currentAssemblyFloor(NOW)).toBe(YESTERDAY_DAY);
  });

  it('последняя миллисекунда московских суток и первая следующих', () => {
    // 23:59:59.999 Москвы 6 марта: «вчера» — 5 марта.
    expect(currentAssemblyFloor(new Date('2031-03-06T20:59:59.999Z'))).toBe(BEFORE_YESTERDAY_DAY);
    // 00:00 Москвы 7 марта: «вчера» уже 6 марта.
    expect(currentAssemblyFloor(new Date('2031-03-06T21:00:00.000Z'))).toBe(YESTERDAY_DAY);
  });

  it('дата UTC отстаёт от московской: граница считается от Москвы', () => {
    // 22:30 UTC 6 марта — это 01:30 Москвы 7 марта. Расчёт от даты UTC дал бы
    // «вчера = 5 марта» и засчитал бы позавчерашний заказ.
    const instant = new Date('2031-03-06T22:30:00.000Z');
    expect(instant.toISOString().slice(0, 10)).toBe('2031-03-06');
    expect(currentAssemblyFloor(instant)).toBe(YESTERDAY_DAY);
  });

  it('граница месяца и года — по календарю, а не вычитанием суток', () => {
    expect(currentAssemblyFloor(new Date('2031-03-01T09:00:00.000Z'))).toBe('2031-02-28');
    expect(currentAssemblyFloor(new Date('2031-01-01T09:00:00.000Z'))).toBe('2030-12-31');
  });
});

describe('что входит в счётчик «В сборке»', () => {
  it('позавчера — нет; вчера, сегодня, будущее — да; без даты — нет', async () => {
    const florist = await floristOnShift('Флорист дат');
    await seedOrder({ day: BEFORE_YESTERDAY_DAY, assignee: florist.userId });
    await seedOrder({ day: YESTERDAY_DAY, assignee: florist.userId });
    await seedOrder({ day: TODAY, assignee: florist.userId });
    await seedOrder({ day: FUTURE_DAY, assignee: florist.userId });
    await seedOrder({ day: null, assignee: florist.userId });

    expect(await countCurrentAssembly(ctx.db, florist.userId, NOW)).toBe(3);
  });

  it('по одному заказу на каждый случай — ровно ожидаемое число', async () => {
    const cases: { day: string | null; counted: boolean }[] = [
      { day: BEFORE_YESTERDAY_DAY, counted: false },
      { day: YESTERDAY_DAY, counted: true },
      { day: TODAY, counted: true },
      { day: FUTURE_DAY, counted: true },
      { day: null, counted: false },
    ];
    for (const item of cases) {
      const florist = await floristOnShift(`Флорист ${item.day ?? 'без даты'}`);
      await seedOrder({ day: item.day, assignee: florist.userId });
      expect(await countCurrentAssembly(ctx.db, florist.userId, NOW), String(item.day)).toBe(
        item.counted ? 1 : 0,
      );
    }
  });

  it('чужой флорист в счётчик не попадает', async () => {
    const mine = await floristOnShift('Свой флорист');
    const other = await floristOnShift('Чужой флорист');
    await seedOrder({ day: TODAY, assignee: mine.userId });
    await seedOrder({ day: TODAY, assignee: other.userId });
    await seedOrder({ day: YESTERDAY_DAY, assignee: other.userId });

    expect(await countCurrentAssembly(ctx.db, mine.userId, NOW)).toBe(1);
    expect(await countCurrentAssembly(ctx.db, other.userId, NOW)).toBe(2);
  });

  it('неподходящее состояние в счётчик не попадает, даже с сегодняшней датой', async () => {
    const florist = await floristOnShift('Флорист состояний');
    await seedOrder({ day: TODAY, assignee: florist.userId, state: 'IN_ASSEMBLY' });
    await seedOrder({ day: TODAY, assignee: florist.userId, state: 'ASSEMBLED' });
    await seedOrder({ day: TODAY, assignee: florist.userId, state: 'NEEDS_REVIEW' });
    // Свободный заказ того же дня никому не засчитывается.
    await seedOrder({ day: TODAY });

    expect(await countCurrentAssembly(ctx.db, florist.userId, NOW)).toBe(1);
  });
});

describe('переход через полночь Москвы', () => {
  it('тот же процесс, тот же заказ: в полночь позавчерашний выбывает сам', async () => {
    const florist = await floristOnShift('Флорист полуночи');
    // Заказ на 6 марта: до полуночи 6→7 он «сегодняшний», после — «вчерашний»,
    // ещё через сутки — «позавчерашний».
    await seedOrder({ day: YESTERDAY_DAY, assignee: florist.userId });
    // Заказ на 5 марта: учитывается ровно до полуночи 6→7.
    await seedOrder({ day: BEFORE_YESTERDAY_DAY, assignee: florist.userId });

    const lastMomentOfMarch6 = new Date('2031-03-06T20:59:59.999Z');
    const firstMomentOfMarch7 = new Date('2031-03-06T21:00:00.000Z');
    const firstMomentOfMarch8 = new Date('2031-03-07T21:00:00.000Z');

    expect(await countCurrentAssembly(ctx.db, florist.userId, lastMomentOfMarch6)).toBe(2);
    // Дата UTC здесь всё ещё 6 марта, а Москва уже живёт 7-м.
    expect(await countCurrentAssembly(ctx.db, florist.userId, firstMomentOfMarch7)).toBe(1);
    expect(await countCurrentAssembly(ctx.db, florist.userId, firstMomentOfMarch8)).toBe(0);

    // Список смен считает тем же правилом и от того же момента.
    const before = await listActiveShifts(ctx.db, lastMomentOfMarch6);
    const after = await listActiveShifts(ctx.db, firstMomentOfMarch7);
    expect(before.find((shift) => shift.userId === florist.userId)?.openAssignments).toBe(2);
    expect(after.find((shift) => shift.userId === florist.userId)?.openAssignments).toBe(1);
  });
});

describe('все показы счётчика согласованы', () => {
  it('своя смена, список смен и выбор флориста показывают одно и то же число', async () => {
    const florist = await floristOnShift('Флорист показов');
    await seedOrder({ day: BEFORE_YESTERDAY_DAY, assignee: florist.userId });
    await seedOrder({ day: TODAY, assignee: florist.userId });

    const own = await ownShift(ctx.db, florist.userId, NOW);
    const shifts = await listActiveShifts(ctx.db, NOW);
    const assignable = await listAssignableFlorists(ctx.db, NOW);

    expect(own?.openAssignments).toBe(1);
    expect(shifts.find((shift) => shift.userId === florist.userId)?.openAssignments).toBe(1);
    expect(assignable.find((item) => item.userId === florist.userId)?.openAssignments).toBe(1);
  });

  it('HTTP: маршруты считают от настоящих часов на каждый запрос', async () => {
    const florist = await loginAs(['FLORIST']);
    const floristActor = {
      userId: florist.userId,
      roles: ['FLORIST'],
      familyId: randomUUID(),
    } as AuthenticatedActor;
    await startShift(ctx.db, floristActor, CONTEXT);
    // Давно прошедший день не учитывается никогда, будущий — учитывается.
    await seedOrder({ day: PAST_REAL_DAY, assignee: florist.userId });
    await seedOrder({ day: FUTURE_REAL_DAY, assignee: florist.userId });
    const manager = await loginAs(['ADMIN']);

    const shifts = await get('/api/florist/shifts', manager.token);
    expect(shifts.statusCode).toBe(200);
    const row = (
      shifts.json() as { items: { userId: string; openAssignments: number }[] }
    ).items.find((item) => item.userId === florist.userId);
    expect(row?.openAssignments).toBe(1);

    const florists = await get('/api/florist/florists', manager.token);
    expect(florists.statusCode).toBe(200);
    const pick = (
      florists.json() as { items: { userId: string; openAssignments: number }[] }
    ).items.find((item) => item.userId === florist.userId);
    expect(pick?.openAssignments).toBe(1);

    const own = await get('/api/florist/shift', florist.token);
    expect(own.statusCode).toBe(200);
    expect((own.json() as { shift: { openAssignments: number } }).shift.openAssignments).toBe(1);
  });
});

describe('меняется только число', () => {
  it('старый заказ остаётся за флористом, в «Моих заказах» и в бейдже вкладки', async () => {
    const florist = await floristOnShift('Флорист старой работы');
    const old = await seedOrder({ day: BEFORE_YESTERDAY_DAY, assignee: florist.userId });
    const current = await seedOrder({ day: TODAY, assignee: florist.userId });

    expect(await countCurrentAssembly(ctx.db, florist.userId, NOW)).toBe(1);

    // Назначение и состояние не тронуты.
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: old.id },
      select: {
        fulfillmentAssigneeId: true,
        fulfillmentProcessState: true,
        fulfillmentAssignedAt: true,
      },
    });
    expect(stored.fulfillmentAssigneeId).toBe(florist.userId);
    expect(stored.fulfillmentProcessState).toBe('IN_ASSEMBLY');
    expect(stored.fulfillmentAssignedAt).not.toBeNull();

    // «Мои заказы» по-прежнему показывают оба заказа.
    const mine = await readQueue(
      ctx.db,
      { userId: florist.userId, roles: ['FLORIST'] },
      { day: 'today', scope: 'mine', group: 'work', includeAssigned: false, search: null },
      NOW,
    );
    const ids = mine.items.map((item) => item.id);
    expect(ids).toContain(old.id);
    expect(ids).toContain(current.id);

    // Бейдж вкладки «Мои заказы» считает список, а не счётчик «В сборке».
    expect(await countActiveAssignments(ctx.db, florist.userId)).toBe(2);
  });

  it('закрытие смены называет ВСЮ оставленную работу, а не число счётчика', async () => {
    const florist = await floristOnShift('Флорист закрытия');
    await seedOrder({ day: BEFORE_YESTERDAY_DAY, assignee: florist.userId });
    await seedOrder({ day: FUTURE_REAL_DAY, assignee: florist.userId });

    const closed = await closeOwnShift(ctx.db, florist, CONTEXT);
    expect(closed.openAssignments).toBe(2);

    const audit = await ctx.db.auditLog.findFirstOrThrow({
      where: { action: 'FLORIST_SHIFT_CLOSED', entityId: florist.shiftId },
      select: { newValue: true },
    });
    expect((audit.newValue as { openAssignments: number }).openAssignments).toBe(2);
  });

  it('AUTO: флорист со старым заказом по-прежнему занят, хотя счётчик равен нулю', async () => {
    const busy = await floristOnShift('Занят старым');
    const old = await seedOrder({ day: BEFORE_YESTERDAY_DAY, assignee: busy.userId });
    const free = await floristOnShift('Свободен');
    const order = await seedOrder({ day: TODAY });

    // Изоляция от накопленного в общей базе — тот же приём, что в
    // `dispatch.critical.test.ts`: готовность снимается со всех смен, все
    // чужие свободные заказы выводятся из раздачи.
    await ctx.db.floristShift.updateMany({
      where: { closedAt: null },
      data: { dispatchReadyAt: null },
    });
    await ctx.db.deliveryOrder.updateMany({
      where: { fulfillmentProcessState: 'NEW', id: { notIn: [order.id] } },
      data: { inScope: false, fulfillmentInScope: false },
    });
    // «Занятый» готов РАНЬШЕ: будь он свободен, заказ ушёл бы ему.
    await ctx.db.floristShift.update({
      where: { id: busy.shiftId },
      data: { dispatchReadyAt: new Date('2031-03-07T07:00:00.000Z') },
    });
    await ctx.db.floristShift.update({
      where: { id: free.shiftId },
      data: { dispatchReadyAt: new Date('2031-03-07T08:00:00.000Z') },
    });
    await setAuto(true);

    expect(await countCurrentAssembly(ctx.db, busy.userId, NOW)).toBe(0);
    const status = await floristDispatchStatus(ctx.db, busy, NOW);
    expect(status.activeOrder?.id).toBe(old.id);

    expect(await dispatchFlorists(ctx.db, NOW)).toBe(1);

    const assigned = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentAssigneeId: true, fulfillmentProcessState: true },
    });
    expect(assigned.fulfillmentProcessState).toBe('IN_ASSEMBLY');
    expect(assigned.fulfillmentAssigneeId).toBe(free.userId);

    const busyWork = await ctx.db.deliveryOrder.findMany({
      where: { fulfillmentAssigneeId: busy.userId },
      select: { id: true },
    });
    expect(busyWork.map((item) => item.id)).toEqual([old.id]);
  });
});
