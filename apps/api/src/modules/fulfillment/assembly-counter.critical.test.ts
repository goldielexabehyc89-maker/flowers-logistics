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
 *    момент — другое число, без перезапуска и без кеша; ответ со счётчиком
 *    называет, через сколько миллисекунд его перечитать;
 *  * меняется ТОЛЬКО число: старый заказ остаётся за флористом, в «Моих
 *    заказах» и в бейдже вкладки, флорист с ним по-прежнему занят для
 *    AUTO-раздачи, а закрытие смены видит всю оставленную работу.
 *
 * ИЗОЛЯЦИЯ. База общая для всех критических файлов, поэтому файл не трогает
 * ни одной чужой записи. Сценарий AUTO-раздачи идёт целиком внутри
 * транзакции, которая откатывается: и включённый AUTO, и готовность флористов,
 * и свободный заказ, и всё, что раздача успела бы назначить, исчезают вместе
 * с ней. Неизменность посторонних заказов, смен и режима раздачи проверяется
 * явно — отпечатком их строк до и после. Чтобы проверка не была пустой на
 * чистой базе, файл заводит две контрольные «чужие» записи ровно тех видов,
 * которые задевала прежняя изоляция массовыми обновлениями: свободный заказ,
 * который раздача вправе взять, и готовую к раздаче смену.
 *
 * ВЛАДЕНИЕ ДАТАМИ: март 2031 и май 2026 (`platform/testing/test-days.ts`).
 * Май 2026 нужен ровно одной проверке маршрута с настоящими часами: это
 * заведомо прошедший день, которого счётчик уже никогда не учтёт.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@fl/shared';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from '../auth/testing/harness.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import type { TransactionClient } from '../auth/sessions.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { SETTING_KEYS } from '../settings/service.js';
import { snapshotHash, type FulfillmentSnapshot } from './composition.js';
import {
  closeOwnShift,
  countCurrentAssembly,
  currentAssemblyFloor,
  currentAssemblyWindow,
  listActiveShifts,
  listAssignableFlorists,
  ownShift,
  startShift,
} from './shifts.js';
import { countActiveAssignments, listDispatchableOrderIds, readQueue } from './queue-service.js';
import { dispatchFloristsTx } from './dispatch.js';
import { floristDispatchStatus } from './dispatch-florist.js';

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

const DAY_MS = 24 * 60 * 60 * 1000;
const CONTEXT = { ip: null, userAgent: null };

let ctx: TestContext;
let admin: AuthenticatedActor;

/*
 * Свои записи файла. Всё, чего здесь нет, — чужое и обязано остаться
 * нетронутым. Смены опознаются по владельцу: их создаёт `startShift`.
 */
const ownOrderIds = new Set<string>();
const ownUserIds = new Set<string>();

/** Отпечаток посторонних записей на момент начала файла. */
let foreignAtStart: ForeignState;

/** Контрольные «чужие» записи: файл их создаёт, но своими не считает. */
let sentinel: { orderId: string; shiftId: string };

beforeAll(async () => {
  ctx = await createTestContext();
  const adminUser = await seedUser(ctx.db, { roles: ['ADMIN'], fullName: 'Админ счётчика' });
  ownUserIds.add(adminUser.id);
  admin = { userId: adminUser.id, roles: ['ADMIN'], familyId: randomUUID() } as AuthenticatedActor;
  sentinel = await seedSentinels();
  foreignAtStart = await foreignState();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${sequence}`;
}

// --- Контроль посторонних записей -------------------------------------------

interface ForeignState {
  orders: string;
  shifts: string;
  dispatchMode: string;
}

/**
 * Отпечаток всех чужих заказов, смен и записей режима раздачи.
 *
 * Строка таблицы целиком (`t::text`), включая `updatedAt`: любое изменение
 * любого поля чужой записи — и даже повторная запись тех же значений —
 * меняет отпечаток. Число строк входит в него же: удалённая или лишняя
 * чужая строка тоже видна.
 */
async function foreignState(): Promise<ForeignState> {
  const orderIds = [...ownOrderIds];
  const userIds = [...ownUserIds];
  const [orders] = await ctx.db.$queryRaw<{ n: bigint; digest: string }[]>`
    SELECT count(*)::bigint AS n,
           md5(coalesce(string_agg(t::text, '|' ORDER BY t."id"), '')) AS digest
    FROM "DeliveryOrder" t
    WHERE NOT (t."id" = ANY(${orderIds}::uuid[]))
  `;
  const [shifts] = await ctx.db.$queryRaw<{ n: bigint; digest: string }[]>`
    SELECT count(*)::bigint AS n,
           md5(coalesce(string_agg(t::text, '|' ORDER BY t."id"), '')) AS digest
    FROM "FloristShift" t
    WHERE NOT (t."userId" = ANY(${userIds}::uuid[]))
  `;
  const [mode] = await ctx.db.$queryRaw<{ n: bigint; digest: string }[]>`
    SELECT count(*)::bigint AS n,
           md5(coalesce(string_agg(t::text, '|' ORDER BY t."id"), '')) AS digest
    FROM "SystemSetting" t
    WHERE t."key" = ${SETTING_KEYS.floristDispatchMode}
  `;
  return {
    orders: `${orders?.n ?? 0n}:${orders?.digest ?? ''}`,
    shifts: `${shifts?.n ?? 0n}:${shifts?.digest ?? ''}`,
    dispatchMode: `${mode?.n ?? 0n}:${mode?.digest ?? ''}`,
  };
}

/** Признак намеренного отката: несёт результат наружу. */
class RolledBack<T> extends Error {
  readonly value: T;

  constructor(value: T) {
    super('проверочная транзакция откатывается намеренно');
    this.value = value;
  }
}

/**
 * Выполняет работу в транзакции и ОТКАТЫВАЕТ её, возвращая результат.
 *
 * Всё, что работа записала, — включая записи раздачи в чужие строки, —
 * исчезает вместе с транзакцией.
 */
async function insideRolledBackTransaction<T>(
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    await ctx.db.$transaction(
      async (tx) => {
        throw new RolledBack(await work(tx));
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.value as T;
    }
    throw error;
  }
  throw new Error('проверочная транзакция зафиксировалась вместо отката');
}

/**
 * Включает AUTO внутри транзакции теми же двумя шагами, что и сервис
 * настроек: снять признак текущей версии и вставить новую. Транзакция
 * откатывается — глобальный режим раздачи у остальных файлов не меняется.
 */
async function enableAutoInside(tx: TransactionClient): Promise<void> {
  const key = SETTING_KEYS.floristDispatchMode;
  const current = await tx.systemSetting.findUnique({
    where: { currentKey: key },
    select: { version: true, value: true },
  });
  if ((current?.value as { auto?: unknown } | undefined)?.auto === true) {
    return;
  }
  if (current !== null) {
    await tx.systemSetting.updateMany({ where: { currentKey: key }, data: { currentKey: null } });
  }
  await tx.systemSetting.create({
    data: {
      key,
      version: (current?.version ?? 0) + 1,
      value: { auto: true },
      currentKey: key,
      updatedById: admin.userId,
    },
  });
}

// --- Фикстуры -----------------------------------------------------------------

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
 *
 * `into` — транзакция, если заказ должен исчезнуть вместе с ней. Свои
 * постоянные заказы файл запоминает, чтобы отличать их от чужих; контрольный
 * «чужой» заказ (`foreign`) не запоминается.
 */
async function seedOrder(
  options: { day: string | null; assignee?: string; state?: ProcessState },
  placement: { into?: TransactionClient; foreign?: boolean } = {},
): Promise<{ id: string; number: string }> {
  const client = placement.into ?? null;
  const db = client ?? ctx.db;
  const state: ProcessState =
    options.state ?? (options.assignee === undefined ? 'NEW' : 'IN_ASSEMBLY');
  const number = unique('AC');
  const externalId = randomUUID();
  const snap = composition(externalId);
  const order = await db.deliveryOrder.create({
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
  if (client === null && placement.foreign !== true) {
    ownOrderIds.add(order.id);
  }

  if (state === 'ASSEMBLED' || state === 'NEEDS_REVIEW') {
    await db.deliveryOrder.update({
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

/** Флорист на активной смене. Готовности к раздаче у него нет. */
async function floristOnShift(name: string): Promise<AuthenticatedActor & { shiftId: string }> {
  const user = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: name });
  ownUserIds.add(user.id);
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
  ownUserIds.add(user.id);
  const session = await login(
    ctx,
    { phone: user.phone, pin },
    { ip: null, userAgent: 'vitest', deviceLabel: null },
  );
  return { token: session.accessToken, userId: user.id };
}

/**
 * Контрольные «чужие» записи.
 *
 *  * Свободный заказ сегодняшнего дня: раздача в момент `NOW` вправе его взять,
 *    а прежняя изоляция выводила такие заказы из области массовым обновлением.
 *  * Смена с выставленной готовностью: прежняя изоляция снимала готовность у
 *    всех смен. Флажок «закончить после текущего» исключает её из любой
 *    раздачи, поэтому в общей базе она никому ничего не перехватит.
 */
async function seedSentinels(): Promise<{ orderId: string; shiftId: string }> {
  const order = await seedOrder({ day: TODAY }, { foreign: true });
  const user = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: 'Чужая смена (контроль)' });
  const actor = {
    userId: user.id,
    roles: ['FLORIST'],
    familyId: randomUUID(),
  } as AuthenticatedActor;
  const { shift } = await startShift(ctx.db, actor, CONTEXT);
  await ctx.db.floristShift.update({
    where: { id: shift.id },
    data: {
      dispatchReadyAt: new Date('2031-03-07T05:00:00.000Z'),
      dispatchFinishAfterCurrent: true,
    },
  });
  return { orderId: order.id, shiftId: shift.id };
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

/** «Мои заказы» флориста в группе работы: состав списка по идентификаторам. */
async function mineWork(userId: string, now: Date): Promise<string[]> {
  const mine = await readQueue(
    ctx.db,
    { userId, roles: ['FLORIST'] },
    { day: 'today', scope: 'mine', group: 'work', includeAssigned: false, search: null },
    now,
  );
  return mine.items.map((item) => item.id).sort();
}

// --- Проверки -----------------------------------------------------------------

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

describe('окно счётчика: когда его перечитать', () => {
  it('23:59:00 Москвы — до сдвига ровно минута', () => {
    expect(currentAssemblyWindow(new Date('2031-03-06T20:59:00.000Z'))).toEqual({
      countedFrom: BEFORE_YESTERDAY_DAY,
      refreshInMs: 60_000,
    });
  });

  it('последняя миллисекунда суток — до сдвига одна миллисекунда', () => {
    expect(currentAssemblyWindow(new Date('2031-03-06T20:59:59.999Z'))).toEqual({
      countedFrom: BEFORE_YESTERDAY_DAY,
      refreshInMs: 1,
    });
  });

  it('00:00:00 Москвы — граница уже сдвинута, следующая через сутки', () => {
    expect(currentAssemblyWindow(new Date('2031-03-06T21:00:00.000Z'))).toEqual({
      countedFrom: YESTERDAY_DAY,
      refreshInMs: DAY_MS,
    });
  });

  it('дата UTC отстаёт: отсчёт идёт до московской полуночи, а не до UTC', () => {
    // 01:30 Москвы 7 марта — до полуночи 22 с половиной часа, а не полтора.
    expect(currentAssemblyWindow(new Date('2031-03-06T22:30:00.000Z'))).toEqual({
      countedFrom: YESTERDAY_DAY,
      refreshInMs: 22.5 * 60 * 60 * 1000,
    });
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

    expect(await countCurrentAssembly(ctx.db, florist.userId, NOW)).toBe(1);
  });
});

describe('переход через полночь Москвы', () => {
  it('23:59 → 00:00: позавчерашний выбывает сам, работа и занятость не меняются', async () => {
    const florist = await floristOnShift('Флорист полуночи');
    // Заказ на 6 марта: до полуночи 6→7 он «сегодняшний», после — «вчерашний»,
    // ещё через сутки — «позавчерашний».
    const march6 = await seedOrder({ day: YESTERDAY_DAY, assignee: florist.userId });
    // Заказ на 5 марта: учитывается ровно до полуночи 6→7.
    const march5 = await seedOrder({ day: BEFORE_YESTERDAY_DAY, assignee: florist.userId });

    const at2359 = new Date('2031-03-06T20:59:00.000Z');
    const lastMomentOfMarch6 = new Date('2031-03-06T20:59:59.999Z');
    const firstMomentOfMarch7 = new Date('2031-03-06T21:00:00.000Z');
    const firstMomentOfMarch8 = new Date('2031-03-07T21:00:00.000Z');

    expect(await countCurrentAssembly(ctx.db, florist.userId, at2359)).toBe(2);
    expect(await countCurrentAssembly(ctx.db, florist.userId, lastMomentOfMarch6)).toBe(2);
    // Дата UTC здесь всё ещё 6 марта, а Москва уже живёт 7-м.
    expect(await countCurrentAssembly(ctx.db, florist.userId, firstMomentOfMarch7)).toBe(1);
    expect(await countCurrentAssembly(ctx.db, florist.userId, firstMomentOfMarch8)).toBe(0);

    // Список смен считает тем же правилом и от того же момента.
    const before = await listActiveShifts(ctx.db, at2359);
    const after = await listActiveShifts(ctx.db, firstMomentOfMarch7);
    expect(before.find((shift) => shift.userId === florist.userId)?.openAssignments).toBe(2);
    expect(after.find((shift) => shift.userId === florist.userId)?.openAssignments).toBe(1);

    // Меняется только число: «Мои заказы», назначения и занятость для AUTO
    // по обе стороны полуночи одни и те же.
    const work = [march5.id, march6.id].sort();
    expect(await mineWork(florist.userId, at2359)).toEqual(work);
    expect(await mineWork(florist.userId, firstMomentOfMarch7)).toEqual(work);
    const busyBefore = await floristDispatchStatus(ctx.db, florist, at2359);
    const busyAfter = await floristDispatchStatus(ctx.db, florist, firstMomentOfMarch7);
    expect(busyBefore.activeOrder).not.toBeNull();
    expect(busyAfter.activeOrder).toEqual(busyBefore.activeOrder);
    const assignees = await ctx.db.deliveryOrder.findMany({
      where: { id: { in: work } },
      select: { fulfillmentAssigneeId: true, fulfillmentProcessState: true },
    });
    expect(
      assignees.every(
        (item) =>
          item.fulfillmentAssigneeId === florist.userId &&
          item.fulfillmentProcessState === 'IN_ASSEMBLY',
      ),
    ).toBe(true);
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

  it('HTTP: каждый ответ со счётчиком считает от настоящих часов и несёт окно', async () => {
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
    const logistician = await loginAs(['LOGISTICIAN']);

    // Граница по настоящим часам — до и после запросов: проверка не должна
    // зависеть от того, пришлась ли она на полночь.
    const floorBefore = currentAssemblyFloor(new Date());

    const shifts = await get('/api/florist/shifts', manager.token);
    const florists = await get('/api/florist/florists', manager.token);
    const own = await get('/api/florist/shift', florist.token);
    const reassembly = await get('/api/logistics/notifications/florists', logistician.token);

    const floorAfter = currentAssemblyFloor(new Date());

    type Counted = { assemblyCounter: { countedFrom: string; refreshInMs: number } };
    type Row = { userId?: string; id?: string; openAssignments: number };
    const responses = [shifts, florists, own, reassembly];
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      const window = (response.json() as Counted).assemblyCounter;
      expect([floorBefore, floorAfter]).toContain(window.countedFrom);
      expect(window.refreshInMs).toBeGreaterThan(0);
      expect(window.refreshInMs).toBeLessThanOrEqual(DAY_MS);
    }

    const rowOf = (body: unknown): Row | undefined =>
      (body as { items: Row[] }).items.find(
        (item) => item.userId === florist.userId || item.id === florist.userId,
      );
    expect(rowOf(shifts.json())?.openAssignments).toBe(1);
    expect(rowOf(florists.json())?.openAssignments).toBe(1);
    expect(rowOf(reassembly.json())?.openAssignments).toBe(1);
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
    expect(await mineWork(florist.userId, NOW)).toEqual([old.id, current.id].sort());

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

    // Занятость для AUTO читается своей выборкой, от счётчика не зависит.
    const status = await floristDispatchStatus(ctx.db, busy, NOW);
    expect(status.activeOrder?.id).toBe(old.id);

    const foreignBefore = await foreignState();

    /*
     * Раздача — внутри откатываемой транзакции.
     *
     * AUTO, готовность обоих флористов и свободный заказ существуют только
     * в ней. Раздача обходит ВСЕХ готовых флористов базы, поэтому могла бы
     * назначить и чужие заказы, — откат убирает и это. Готовность выставлена
     * «с начала эпохи»: раньше неё не готов никто, и порядок раздачи наших
     * двоих не зависит от накопленного в общей базе. «Занятый» готов раньше:
     * будь он свободен, первый заказ ушёл бы ему.
     */
    const outcome = await insideRolledBackTransaction(async (tx) => {
      await seedOrder({ day: TODAY }, { into: tx });
      await enableAutoInside(tx);
      await tx.floristShift.update({
        where: { id: busy.shiftId },
        data: { dispatchReadyAt: new Date(0) },
      });
      await tx.floristShift.update({
        where: { id: free.shiftId },
        data: { dispatchReadyAt: new Date(1_000) },
      });

      const counter = await countCurrentAssembly(tx, busy.userId, NOW);
      // Контрольный чужой заказ — настоящий кандидат раздачи: без отката
      // она была бы вправе его изменить.
      const candidates = await listDispatchableOrderIds(tx, NOW);
      const assigned = await dispatchFloristsTx(tx, NOW);
      const busyWork = await tx.deliveryOrder.findMany({
        where: { fulfillmentAssigneeId: busy.userId },
        select: { id: true },
      });
      const freeWork = await tx.deliveryOrder.count({
        where: { fulfillmentAssigneeId: free.userId, fulfillmentProcessState: 'IN_ASSEMBLY' },
      });
      return {
        counter,
        sentinelWasCandidate: candidates.includes(sentinel.orderId),
        assigned,
        busyWork: busyWork.map((item) => item.id),
        freeWork,
      };
    });

    expect(outcome.sentinelWasCandidate).toBe(true);
    expect(outcome.counter).toBe(0);
    expect(outcome.assigned).toBeGreaterThanOrEqual(1);
    // Занятый старым заказом не получил ничего, свободный — ровно один заказ.
    expect(outcome.busyWork).toEqual([old.id]);
    expect(outcome.freeWork).toBe(1);

    // После отката: чужие записи и режим раздачи не изменились ни на поле.
    expect(await foreignState()).toEqual(foreignBefore);
    const sentinelOrder = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: sentinel.orderId },
      select: {
        inScope: true,
        fulfillmentInScope: true,
        fulfillmentProcessState: true,
        fulfillmentAssigneeId: true,
      },
    });
    expect(sentinelOrder).toEqual({
      inScope: true,
      fulfillmentInScope: true,
      fulfillmentProcessState: 'NEW',
      fulfillmentAssigneeId: null,
    });
    const sentinelShift = await ctx.db.floristShift.findUniqueOrThrow({
      where: { id: sentinel.shiftId },
      select: { dispatchReadyAt: true, closedAt: true },
    });
    expect(sentinelShift.dispatchReadyAt).toEqual(new Date('2031-03-07T05:00:00.000Z'));
    expect(sentinelShift.closedAt).toBeNull();
    // И свои вернулись к исходному: готовности нет, у свободного нет заказов.
    const shifts = await ctx.db.floristShift.findMany({
      where: { id: { in: [busy.shiftId, free.shiftId] } },
      select: { dispatchReadyAt: true },
    });
    expect(shifts.every((shift) => shift.dispatchReadyAt === null)).toBe(true);
    expect(
      await ctx.db.deliveryOrder.count({ where: { fulfillmentAssigneeId: free.userId } }),
    ).toBe(0);
  });
});

describe('изоляция файла', () => {
  it('ни один чужой заказ, чужая смена и запись режима раздачи не изменились', async () => {
    expect(await foreignState()).toEqual(foreignAtStart);
  });
});
