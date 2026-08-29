/**
 * Критические проверки самовывоза (этап 6.7).
 *
 * Проверяется не «открывается ли раздел», а нарушение чего отдаёт коробку
 * не тому человеку или дважды:
 *
 *  * самовывоз опознаётся ТОЛЬКО точным UUID способа получения, а не названием
 *    и не «всё, что не доставка»;
 *  * выдать можно лишь однозначный номер с активным фактическим размещением;
 *  * выдача и закрытие размещения происходят вместе либо не происходят вовсе;
 *  * двойной клик и одновременные запросы не создают второго факта;
 *  * менеджер получает только свой раздел, кладовщик — не получает выдачу;
 *  * обычная доставка и складское движение от этого среза не меняются.
 *
 * ВЛАДЕНИЕ ДАТАМИ: июнь 2027 года.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { TEST_SECRETS } from '../../platform/testing/secrets.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { moscowToday, type Role } from '@fl/shared';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { createStorageCell, unknownOccupancy, type CellDeps } from '../warehouse/service.js';
import { receiveOrder, type FlowDeps } from '../warehouse/placement.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancelPickupLocally, isPickupOrder, issueToCustomer, type PickupDeps } from './service.js';
import { findPickupByNumber, listIssuedOfDay, listPickupQueue } from './views.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

let ctx: TestContext;
let pickup: PickupDeps;
let flow: FlowDeps;
let cells: CellDeps;
const CONTEXT = { ip: null, userAgent: null };

/** День, забронированный этим файлом. */
const DAY = '2027-06-15';

beforeAll(async () => {
  ctx = await createTestContext();
  pickup = { db: ctx.db };
  flow = { db: ctx.db };
  cells = { db: ctx.db, occupancy: unknownOccupancy };
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${sequence}`;
}

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return {
    userId: user.id,
    roles,
    familyId: '00000000-0000-4000-8000-000000000065',
    fullName: 'Тестовый пользователь',
    phone: user.phone,
  } as AuthenticatedActor;
}

async function tokenFor(roles: Role[]): Promise<string> {
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
  return session.accessToken;
}

interface Injected {
  statusCode: number;
  json: () => unknown;
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  token: string | null,
  payload?: unknown,
): Promise<Injected> {
  const response = await ctx.app.inject({
    method,
    url,
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    ...(payload === undefined ? {} : { payload }),
  });
  return { statusCode: response.statusCode, json: () => response.json() };
}

interface SeedOptions {
  deliveryMethodId?: string | null;
  fulfillmentInScope?: boolean;
  sourceArchived?: boolean;
  sourceMissing?: boolean;
  number?: string;
  day?: string;
}

async function seedOrder(options: SeedOptions = {}): Promise<{ id: string; number: string }> {
  const number = options.number ?? unique('PU');
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: crypto.randomUUID(),
      externalName: number,
      externalUpdated: new Date('2027-06-01T00:00:00.000Z'),
      deliveryDate: toDateColumn(options.day ?? DAY),
      address: null,
      recipient: 'Проверочный Покупатель',
      storeId: MOYSKLAD_IDS.store,
      deliveryMethodId:
        options.deliveryMethodId === undefined
          ? MOYSKLAD_IDS.deliveryMethodPickup
          : options.deliveryMethodId,
      inScope: false,
      fulfillmentInScope: options.fulfillmentInScope ?? true,
      sourceArchived: options.sourceArchived ?? false,
      sourceMissing: options.sourceMissing ?? false,
    },
    select: { id: true, externalName: true },
  });
  return { id: order.id, number: order.externalName };
}

async function seedCell(): Promise<{ id: string; code: string }> {
  const admin = await actorFor(['ADMIN']);
  const cell = await createStorageCell(
    cells,
    admin,
    { code: unique('S'), kind: 'STORAGE' },
    CONTEXT,
  );
  return { id: cell.id, code: cell.code };
}

/** Заказ, принятый кладовщиком на полку: обычный складской путь. */
async function placed(options: SeedOptions = {}): Promise<{
  order: { id: string; number: string };
  cell: { id: string; code: string };
}> {
  const order = await seedOrder(options);
  const cell = await seedCell();
  const keeper = await actorFor(['WAREHOUSE']);
  await receiveOrder(flow, keeper, { orderNumber: order.number, cellCode: cell.code }, CONTEXT);
  return { order, cell };
}

async function activeCellOf(orderId: string): Promise<string | null> {
  const row = await ctx.db.orderPlacement.findFirst({
    where: { orderId, releasedAt: null },
    select: { cellId: true },
  });
  return row?.cellId ?? null;
}

async function setManualEntry(enabled: boolean): Promise<void> {
  const { readWarehouseManualEntry, saveWarehouseManualEntry } =
    await import('../settings/service.js');
  const admin = await actorFor(['ADMIN']);
  const current = await readWarehouseManualEntry(ctx.db);
  if (current.value.enabled === enabled) {
    return;
  }
  await saveWarehouseManualEntry(ctx.db, admin, {
    value: { enabled },
    expectedVersion: current.version,
    ip: null,
    userAgent: null,
  });
}

// --- 1. Идентичность самовывоза ----------------------------------------------

describe('идентичность самовывоза', () => {
  it('опознаётся точным UUID, а не названием и не «всё кроме доставки»', () => {
    const inScope = { fulfillmentInScope: true };

    expect(isPickupOrder({ deliveryMethodId: MOYSKLAD_IDS.deliveryMethodPickup, ...inScope })).toBe(
      true,
    );
    // Доставка, третье значение справочника и отсутствующий способ — не самовывоз.
    expect(
      isPickupOrder({ deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery, ...inScope }),
    ).toBe(false);
    expect(
      isPickupOrder({ deliveryMethodId: '00000000-0000-4000-8000-0000000000ff', ...inScope }),
    ).toBe(false);
    expect(isPickupOrder({ deliveryMethodId: null, ...inScope })).toBe(false);

    // Вне производственной области выдавать нечего даже с верным UUID.
    expect(
      isPickupOrder({
        deliveryMethodId: MOYSKLAD_IDS.deliveryMethodPickup,
        fulfillmentInScope: false,
      }),
    ).toBe(false);
  });

  it('UUID самовывоза отличается от доставки и остаётся стабильной константой', () => {
    expect(MOYSKLAD_IDS.deliveryMethodPickup).toBe('76f4977e-d33e-11ef-0a80-03b6000e555e');
    expect(MOYSKLAD_IDS.deliveryMethodPickup).not.toBe(MOYSKLAD_IDS.deliveryMethodDelivery);
  });

  it('логистическая область самовывоз не подхватывает', async () => {
    const { order } = await placed();

    const row = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { inScope: true, fulfillmentInScope: true },
    });
    expect(row.inScope).toBe(false);
    expect(row.fulfillmentInScope).toBe(true);
  });
});

// --- 2. Выдача ---------------------------------------------------------------

describe('выдача покупателю', () => {
  it('закрывает размещение и создаёт неизменяемый факт одной операцией', async () => {
    const { order, cell } = await placed();
    const manager = await actorFor(['MANAGER']);

    const result = await issueToCustomer(
      pickup,
      manager,
      { orderNumber: order.number, source: 'SCAN' },
      CONTEXT,
    );

    expect(result).toMatchObject({ orderId: order.id, cellId: cell.id, cellCode: cell.code });
    expect(await activeCellOf(order.id)).toBeNull();

    const placement = await ctx.db.orderPlacement.findFirstOrThrow({
      where: { orderId: order.id },
      select: { releaseReason: true, releasedById: true, movedToCellId: true, cellId: true },
    });
    expect(placement).toMatchObject({
      releaseReason: 'ISSUED_TO_CUSTOMER',
      releasedById: manager.userId,
      // Целевой ячейки нет: заказ ушёл со склада, а не переехал на полку.
      movedToCellId: null,
      // История ячейки осталась: строка по-прежнему помнит, откуда его забрали.
      cellId: cell.id,
    });

    const issue = await ctx.db.orderPickupIssue.findUniqueOrThrow({
      where: { orderId: order.id },
      select: { issuedById: true, cellId: true, issuedAt: true },
    });
    expect(issue).toMatchObject({ issuedById: manager.userId, cellId: cell.id });
    expect(issue.issuedAt).toBeInstanceOf(Date);
  });

  it('факт выдачи не редактируется и не удаляется', async () => {
    const { order } = await placed();
    const manager = await actorFor(['MANAGER']);
    await issueToCustomer(pickup, manager, { orderNumber: order.number, source: 'SCAN' }, CONTEXT);

    const issue = await ctx.db.orderPickupIssue.findUniqueOrThrow({
      where: { orderId: order.id },
      select: { id: true },
    });

    await expect(
      ctx.db.orderPickupIssue.update({
        where: { id: issue.id },
        data: { issuedAt: new Date('2020-01-01T00:00:00.000Z') },
      }),
    ).rejects.toThrow(/неизменяем/);
    await expect(ctx.db.orderPickupIssue.delete({ where: { id: issue.id } })).rejects.toThrow(
      /неизменяем/,
    );
  });

  it('повтор выдачи отказывает штатно и второго факта не создаёт', async () => {
    const { order } = await placed();
    const manager = await actorFor(['MANAGER']);
    await issueToCustomer(pickup, manager, { orderNumber: order.number, source: 'SCAN' }, CONTEXT);

    await expect(
      issueToCustomer(pickup, manager, { orderNumber: order.number, source: 'SCAN' }, CONTEXT),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      conflict: { kind: 'PICKUP_ALREADY_ISSUED' },
    });

    expect(await ctx.db.orderPickupIssue.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('два одновременных запроса дают ровно одну выдачу', async () => {
    const { order } = await placed();
    const manager = await actorFor(['MANAGER']);

    const results = await Promise.allSettled([
      issueToCustomer(pickup, manager, { orderNumber: order.number, source: 'SCAN' }, CONTEXT),
      issueToCustomer(pickup, manager, { orderNumber: order.number, source: 'SCAN' }, CONTEXT),
    ]);

    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(await ctx.db.orderPickupIssue.count({ where: { orderId: order.id } })).toBe(1);
    expect(await ctx.db.orderPlacement.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('заказ без фактической ячейки, доставка, архив и пропажа отказывают', async () => {
    const manager = await actorFor(['MANAGER']);

    // Принят не был: выдавать нечего.
    const notPlaced = await seedOrder();
    await expect(
      issueToCustomer(pickup, manager, { orderNumber: notPlaced.number, source: 'SCAN' }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_PLACED' } });

    // Обычная доставка: этот раздел не про неё.
    const delivery = await placed({ deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery });
    await expect(
      issueToCustomer(
        pickup,
        manager,
        { orderNumber: delivery.order.number, source: 'SCAN' },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_PICKUP' } });

    // Способ получения не указан вовсе.
    const unknownMethod = await placed({ deliveryMethodId: null });
    await expect(
      issueToCustomer(
        pickup,
        manager,
        { orderNumber: unknownMethod.order.number, source: 'SCAN' },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_PICKUP' } });

    // Источник архивирован или пропал: заказ мог быть отменён.
    const archived = await placed({ sourceArchived: true });
    await expect(
      issueToCustomer(
        pickup,
        manager,
        { orderNumber: archived.order.number, source: 'SCAN' },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_BLOCKED' } });

    const missing = await placed({ sourceMissing: true });
    await expect(
      issueToCustomer(
        pickup,
        manager,
        { orderNumber: missing.order.number, source: 'SCAN' },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_BLOCKED' } });

    // Ни у одного отказавшего заказа размещение не закрылось.
    for (const seeded of [delivery, unknownMethod, archived, missing]) {
      expect(await activeCellOf(seeded.order.id)).toBe(seeded.cell.id);
    }
  });

  it('неоднозначный номер отказывает и ничего не выдаёт', async () => {
    const shared = unique('DUP');
    const first = await placed({ number: shared });
    // Двойник заводится ПОСЛЕ приёмки: сама приёмка на неоднозначный номер
    // уже отказала бы, и проверка выдачи до дела бы не дошла.
    await seedOrder({ number: shared });
    const manager = await actorFor(['MANAGER']);

    await expect(
      issueToCustomer(pickup, manager, { orderNumber: shared, source: 'SCAN' }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NUMBER_AMBIGUOUS' } });

    expect(await activeCellOf(first.order.id)).toBe(first.cell.id);
    expect(await ctx.db.orderPickupIssue.count({ where: { orderId: first.order.id } })).toBe(0);
  });
});

// --- 3. Чтение раздела -------------------------------------------------------

describe('карточка и списки', () => {
  it('карточка называет ячейку, сборку и печать, а причины отказа перечисляет', async () => {
    const { order, cell } = await placed();

    const card = await findPickupByNumber(ctx.db, order.number);
    expect(card).toMatchObject({
      orderNumber: order.number,
      isPickup: true,
      cellCode: cell.code,
      blockers: [],
    });

    const delivery = await placed({ deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery });
    expect((await findPickupByNumber(ctx.db, delivery.order.number)).blockers).toContain(
      'NOT_PICKUP',
    );

    const notPlaced = await seedOrder();
    expect((await findPickupByNumber(ctx.db, notPlaced.number)).blockers).toContain('NOT_PLACED');
  });

  it('выданный заказ уходит из очереди и попадает в справку выданных', async () => {
    const day = '2027-06-16';
    const { order } = await placed({ day });
    const manager = await actorFor(['MANAGER']);

    const before = await listPickupQueue(ctx.db, { limit: 200 });
    expect(before.items.map((row) => row.orderNumber)).toContain(order.number);

    await issueToCustomer(pickup, manager, { orderNumber: order.number, source: 'SCAN' }, CONTEXT);

    const after = await listPickupQueue(ctx.db, { limit: 200 });
    expect(after.items.map((row) => row.orderNumber)).not.toContain(order.number);

    // Справка спрашивается за день ВЫДАЧИ: заказ отдали сейчас, а привезти
    // его собирались в июне 2027 года.
    const issued = await listIssuedOfDay(ctx.db, moscowToday(new Date()));
    const row = issued.issued.find((item) => item.orderNumber === order.number);
    expect(row?.blockers).toContain('ALREADY_ISSUED');
    expect(row?.issuedAt).not.toBeNull();
  });

  it('очередь не смотрит на день и не берёт чужие способы получения', async () => {
    const mine = await placed({ day: '2027-06-17' });
    const otherDay = await placed({ day: '2027-06-18' });
    const delivery = await placed({
      day: '2027-06-17',
      deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery,
    });

    const view = await listPickupQueue(ctx.db, { limit: 200 });
    const numbers = view.items.map((row) => row.orderNumber);

    // Оба дня стоят в ОДНОЙ очереди: покупатель приходит когда придёт.
    expect(numbers).toContain(mine.order.number);
    expect(numbers).toContain(otherDay.order.number);
    expect(numbers).not.toContain(delivery.order.number);
  });
});

/**
 * Выдача с заданным моментом.
 *
 * Служба берёт время из системных часов и подменить их нечем, а факт выдачи
 * запрещено править после создания. Поэтому размещение закрывается и факт
 * заводится напрямую — ровно то, что делает служба, но с нужным моментом.
 */
async function issuedAtMoment(orderId: string, moment: Date): Promise<void> {
  const placement = await ctx.db.orderPlacement.findFirstOrThrow({
    where: { orderId, releasedAt: null },
    select: { id: true, cellId: true },
  });
  const keeper = await actorFor(['WAREHOUSE']);

  await ctx.db.orderPlacement.update({
    where: { id: placement.id },
    data: {
      releasedAt: moment,
      releasedById: keeper.userId,
      releaseReason: 'ISSUED_TO_CUSTOMER',
    },
  });
  await ctx.db.orderPickupIssue.create({
    data: {
      orderId,
      placementId: placement.id,
      cellId: placement.cellId,
      issuedAt: moment,
      issuedById: keeper.userId,
    },
  });
}

describe('«Выданы сегодня» считаются по факту выдачи', () => {
  /*
   * Дата доставки и день выдачи — разные вещи, и путать их дорого: пока список
   * строился по плановой дате, заказ, за которым пришли сегодня, показывался
   * в чужом дне, а сегодняшний список не сходился с кассой.
   */
  const DAY = '2027-07-14';
  const MOSCOW_NOON = new Date('2027-07-14T09:00:00.000Z');

  it('вчерашний заказ, выданный сегодня, в сегодняшнем списке есть', async () => {
    const { order } = await placed({ day: '2027-07-13' });
    await issuedAtMoment(order.id, MOSCOW_NOON);

    const view = await listIssuedOfDay(ctx.db, DAY);
    expect(view.issued.map((row) => row.orderNumber)).toContain(order.number);
  });

  it('будущий заказ, выданный сегодня, в сегодняшнем списке есть', async () => {
    const { order } = await placed({ day: '2027-09-01' });
    await issuedAtMoment(order.id, MOSCOW_NOON);

    const view = await listIssuedOfDay(ctx.db, DAY);
    expect(view.issued.map((row) => row.orderNumber)).toContain(order.number);
  });

  it('сегодняшний заказ, выданный в другой день, в сегодняшнем списке отсутствует', async () => {
    const { order } = await placed({ day: DAY });
    await issuedAtMoment(order.id, new Date('2027-07-12T09:00:00.000Z'));

    const view = await listIssuedOfDay(ctx.db, DAY);
    expect(view.issued.map((row) => row.orderNumber)).not.toContain(order.number);

    // И при этом он на месте в СВОЁМ дне: история выдач не потеряна.
    const own = await listIssuedOfDay(ctx.db, '2027-07-12');
    expect(own.issued.map((row) => row.orderNumber)).toContain(order.number);
  });

  it('границы московских суток разделяют дни без пересечения и без щели', async () => {
    // 00:00:00 по Москве — это 21:00 UTC предыдущих суток.
    const first = await placed({ day: DAY });
    await issuedAtMoment(first.order.id, new Date('2027-07-13T21:00:00.000Z'));

    const last = await placed({ day: DAY });
    await issuedAtMoment(last.order.id, new Date('2027-07-14T20:59:59.999Z'));

    const justBefore = await placed({ day: DAY });
    await issuedAtMoment(justBefore.order.id, new Date('2027-07-13T20:59:59.999Z'));

    const justAfter = await placed({ day: DAY });
    await issuedAtMoment(justAfter.order.id, new Date('2027-07-14T21:00:00.000Z'));

    const numbers = (await listIssuedOfDay(ctx.db, DAY)).issued.map((row) => row.orderNumber);
    expect(numbers).toContain(first.order.number);
    expect(numbers).toContain(last.order.number);
    expect(numbers).not.toContain(justBefore.order.number);
    expect(numbers).not.toContain(justAfter.order.number);

    // Соседние дни забирают ровно то, что не попало в этот.
    const previous = (await listIssuedOfDay(ctx.db, '2027-07-13')).issued.map(
      (row) => row.orderNumber,
    );
    expect(previous).toContain(justBefore.order.number);
    const next = (await listIssuedOfDay(ctx.db, '2027-07-15')).issued.map((row) => row.orderNumber);
    expect(next).toContain(justAfter.order.number);
  });

  it('часовой пояс среды на разбиение по дням не влияет', async () => {
    const { order } = await placed({ day: DAY });
    await issuedAtMoment(order.id, new Date('2027-07-14T20:30:00.000Z'));

    // 20:30 UTC — это 23:30 по Москве того же дня, но уже следующий день
    // в любом поясе восточнее. Список обязан отвечать одинаково.
    const previousTz = process.env.TZ;
    try {
      for (const zone of ['UTC', 'Asia/Vladivostok', 'America/Los_Angeles']) {
        process.env.TZ = zone;
        const numbers = (await listIssuedOfDay(ctx.db, DAY)).issued.map((row) => row.orderNumber);
        expect(numbers, zone).toContain(order.number);
        const next = (await listIssuedOfDay(ctx.db, '2027-07-15')).issued.map(
          (row) => row.orderNumber,
        );
        expect(next, zone).not.toContain(order.number);
      }
    } finally {
      /*
       * Пояс возвращается ОБЯЗАТЕЛЬНО и именно так.
       *
       * Файлы одного набора делят процесс: оставленный чужой пояс сдвинул бы
       * даты в соседних тестах, а `process.env.TZ = undefined` записал бы туда
       * строку «undefined» — это хуже, чем не трогать вовсе.
       */
      if (previousTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTz;
      }
    }
  });

  it('рабочая очередь по-прежнему не смотрит на день', async () => {
    const stale = await placed({ day: '2027-01-05' });
    const future = await placed({ day: '2027-12-31' });

    const numbers = (await listPickupQueue(ctx.db, { limit: 200 })).items.map(
      (row) => row.orderNumber,
    );
    expect(numbers).toContain(stale.order.number);
    expect(numbers).toContain(future.order.number);
  });
});

// --- 4. Права ----------------------------------------------------------------

describe('права раздела', () => {
  it('MANAGER и ADMIN работают, остальные роли получают 403, аноним — 401', async () => {
    const { order } = await placed();

    for (const roles of [['MANAGER'], ['ADMIN']] as Role[][]) {
      const token = await tokenFor(roles);
      expect((await call('GET', '/api/pickup/orders', token)).statusCode).toBe(200);
      expect((await call('GET', '/api/pickup/issued', token)).statusCode).toBe(200);
      expect((await call('GET', `/api/pickup/scan?number=${order.number}`, token)).statusCode).toBe(
        200,
      );
    }

    for (const roles of [['WAREHOUSE'], ['FLORIST'], ['LOGISTICIAN'], ['COURIER']] as Role[][]) {
      const token = await tokenFor(roles);
      for (const url of ['/api/pickup/orders', '/api/pickup/issued']) {
        expect((await call('GET', url, token)).statusCode, `${roles.join()} ${url}`).toBe(403);
      }
      expect(
        (
          await call('POST', '/api/pickup/issues', token, {
            orderNumber: order.number,
            source: 'SCAN',
          })
        ).statusCode,
      ).toBe(403);
    }

    for (const url of ['/api/pickup/orders', '/api/pickup/issued']) {
      expect((await call('GET', url, null)).statusCode, url).toBe(401);
    }
  });

  it('способ действия обязателен: «не сказали» выдачей не считается', async () => {
    const { order } = await placed();
    const token = await tokenFor(['MANAGER']);

    // Без явного `source` запрос не проходит проверку схемы: значение
    // по умолчанию превратило бы выключенную настройку в украшение.
    const response = await call('POST', '/api/pickup/issues', token, {
      orderNumber: order.number,
    });
    expect(response.statusCode).toBe(400);
    expect(await ctx.db.orderPickupIssue.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('лишние поля запроса ничего не решают', async () => {
    const { order, cell } = await placed();
    const token = await tokenFor(['MANAGER']);

    /*
     * Клиент присылает всё, что придумает: чужую ячейку, снятую отмену,
     * готовый факт выдачи. Сервер берёт из тела только номер и способ,
     * остальное отбрасывает схемой.
     */
    const response = await call('POST', '/api/pickup/issues', token, {
      orderNumber: order.number,
      source: 'SCAN',
      cellId: '00000000-0000-4000-8000-000000000999',
      cancelled: false,
      issuedAt: '2000-01-01T00:00:00.000Z',
      blockers: [],
    });
    expect(response.statusCode).toBe(200);

    const issue = await ctx.db.orderPickupIssue.findUniqueOrThrow({
      where: { orderId: order.id },
      select: { cellId: true, issuedAt: true },
    });
    // Ячейка взята из фактического размещения, а не из тела запроса.
    expect(issue.cellId).toBe(cell.id);
    expect(issue.issuedAt.getUTCFullYear()).toBeGreaterThan(2000);
  });

  it('менеджер не получает ни склада, ни флориста, ни логистики, ни настроек', async () => {
    const token = await tokenFor(['MANAGER']);

    for (const url of [
      '/api/warehouse/placements?limit=10',
      '/api/storage-cells?limit=10',
      '/api/florist/queue',
      '/api/routes?limit=10',
      '/api/orders?limit=10',
      '/api/users?limit=10',
      '/api/settings/planning',
    ]) {
      const response = await call('GET', url, token);
      expect(response.statusCode, url).toBe(403);
    }
  });

  it('кладовщик не может выдать заказ покупателю', async () => {
    const { order } = await placed();
    const token = await tokenFor(['WAREHOUSE']);

    const response = await call('POST', '/api/pickup/issues', token, {
      orderNumber: order.number,
    });

    expect(response.statusCode).toBe(403);
    expect(await ctx.db.orderPickupIssue.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('в ответах раздела нет адреса, получателя и комментария', async () => {
    const { order } = await placed();
    const token = await tokenFor(['MANAGER']);

    const card = await call('GET', `/api/pickup/scan?number=${order.number}`, token);
    const day = await call('GET', '/api/pickup/orders', token);

    for (const response of [card, day]) {
      const body = JSON.stringify(response.json());
      expect(body).not.toContain('Проверочный Покупатель');
      expect(body).not.toContain('адрес');
      expect(body).not.toContain('recipient');
    }
  });
});

// --- 5. Аудит и realtime -----------------------------------------------------

describe('след выдачи', () => {
  it('аудит и событие не несут номера заказа и кода ячейки', async () => {
    const { order, cell } = await placed();
    const manager = await actorFor(['MANAGER']);

    await issueToCustomer(pickup, manager, { orderNumber: order.number, source: 'SCAN' }, CONTEXT);

    const entry = await ctx.db.auditLog.findFirstOrThrow({
      where: { action: 'PICKUP_ORDER_ISSUED', actorUserId: manager.userId },
      orderBy: { occurredAt: 'desc' },
      select: { newValue: true, entityType: true },
    });
    const audit = JSON.stringify(entry.newValue);
    expect(entry.entityType).toBe('OrderPickupIssue');
    expect(audit).toContain(order.id);
    expect(audit).not.toContain(order.number);
    expect(audit).not.toContain(cell.code);

    const event = await ctx.db.realtimeEvent.findFirstOrThrow({
      where: { topic: 'pickup.issued' },
      orderBy: { occurredAt: 'desc' },
      select: { payload: true, audienceRoles: true },
    });
    const payload = JSON.stringify(event.payload);
    expect(payload).not.toContain(order.number);
    expect(payload).not.toContain(cell.code);
    expect([...event.audienceRoles].sort()).toEqual(['ADMIN', 'MANAGER']);
  });
});

// --- Локальная отмена самовывоза ---------------------------------------------

/** Есть ли строка состояния синхронизации у заказа. `null` — событий не было. */
async function moyskladStateOf(orderId: string): Promise<{ enqueuedSeq: number } | null> {
  return ctx.db.orderMoyskladState.findUnique({
    where: { orderId },
    select: { enqueuedSeq: true },
  });
}

async function isInQueue(orderNumber: string): Promise<boolean> {
  const page = await listPickupQueue(ctx.db, { limit: 200 });
  return page.items.some((item) => item.orderNumber === orderNumber);
}

describe('локальная отмена самовывоза', () => {
  it('убирает карточку из очереди, сохраняя заказ, данные и историю', async () => {
    const { order } = await placed();
    const manager = await actorFor(['MANAGER']);

    expect(await isInQueue(order.number)).toBe(true);

    const result = await cancelPickupLocally(
      pickup,
      manager,
      { orderNumber: order.number },
      CONTEXT,
    );
    expect(result.alreadyCancelled).toBe(false);

    // Ушёл из очереди.
    expect(await isInQueue(order.number)).toBe(false);

    // Сам заказ, его импортированные данные и статус на месте: локальная отмена
    // их не трогает.
    const kept = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { cancelledInSource: true, cancelledByLogistAt: true, externalStateId: true },
    });
    expect(kept.cancelledInSource).toBe(false);
    expect(kept.cancelledByLogistAt).toBeNull();
    expect(kept.externalStateId).toBeNull();

    // В истории заказа — явная строка «Самовывоз отменён локально».
    const cancellation = await ctx.db.orderPickupCancellation.findUnique({
      where: { orderId: order.id },
      select: { cancelledById: true, cancelledAt: true },
    });
    expect(cancellation?.cancelledById).toBe(manager.userId);
    expect(cancellation?.cancelledAt).toBeInstanceOf(Date);
  });

  it('повтор отмены идемпотентен: тот же итог, без второй записи', async () => {
    const { order } = await placed();
    const manager = await actorFor(['MANAGER']);

    const first = await cancelPickupLocally(
      pickup,
      manager,
      { orderNumber: order.number },
      CONTEXT,
    );
    const second = await cancelPickupLocally(
      pickup,
      manager,
      { orderNumber: order.number },
      CONTEXT,
    );
    expect(first.alreadyCancelled).toBe(false);
    expect(second.alreadyCancelled).toBe(true);
    expect(second.cancellationId).toBe(first.cancellationId);

    const count = await ctx.db.orderPickupCancellation.count({ where: { orderId: order.id } });
    expect(count).toBe(1);
  });

  it('переживает повторную синхронизацию: заказ остаётся скрытым', async () => {
    const { order } = await placed();
    const manager = await actorFor(['MANAGER']);
    await cancelPickupLocally(pickup, manager, { orderNumber: order.number }, CONTEXT);
    expect(await isInQueue(order.number)).toBe(false);

    // Импорт обновил заказ (пришла delta): отмена — отдельная строка, её импорт
    // не трогает, поэтому заказ по-прежнему вне очереди.
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: { externalUpdated: new Date('2027-06-20T00:00:00.000Z') },
    });
    expect(await isInQueue(order.number)).toBe(false);
  });

  it('терминальный исход один: отменённый нельзя выдать, выданный нельзя отменить', async () => {
    // Отмена, затем выдача — выдача отказывает.
    const a = await placed();
    const manager = await actorFor(['MANAGER']);
    await cancelPickupLocally(pickup, manager, { orderNumber: a.order.number }, CONTEXT);
    await expect(
      issueToCustomer(pickup, manager, { orderNumber: a.order.number, source: 'CARD' }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'PICKUP_CANCELLED_LOCALLY' } });

    // Выдача, затем отмена — отмена отказывает.
    const b = await placed();
    await issueToCustomer(
      pickup,
      manager,
      { orderNumber: b.order.number, source: 'CARD' },
      CONTEXT,
    );
    await expect(
      cancelPickupLocally(pickup, manager, { orderNumber: b.order.number }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'PICKUP_ALREADY_ISSUED' } });
  });

  it('одновременные выдача и отмена дают ровно один итог', async () => {
    const { order } = await placed();
    const manager = await actorFor(['MANAGER']);

    const results = await Promise.allSettled([
      issueToCustomer(pickup, manager, { orderNumber: order.number, source: 'CARD' }, CONTEXT),
      cancelPickupLocally(pickup, manager, { orderNumber: order.number }, CONTEXT),
    ]);

    const issued = await ctx.db.orderPickupIssue.count({ where: { orderId: order.id } });
    const cancelled = await ctx.db.orderPickupCancellation.count({ where: { orderId: order.id } });
    // Ровно один терминальный факт: либо выдача, либо отмена, но не оба.
    expect(issued + cancelled).toBe(1);
    // Один из запросов победил, второй — понятный конфликт, а не второй факт.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('выдача с карточки не требует ручного ввода, но не обходит готовность', async () => {
    // Ручной ввод выключен — карточная выдача всё равно работает для готового.
    await setManualEntry(false);
    const { order, cell } = await placed();
    const manager = await actorFor(['MANAGER']);
    const result = await issueToCustomer(
      pickup,
      manager,
      { orderNumber: order.number, source: 'CARD' },
      CONTEXT,
    );
    expect(result.cellCode).toBe(cell.code);

    // А неготовый (без фактической ячейки) — отказ по складской проверке.
    const notPlaced = await seedOrder();
    await expect(
      issueToCustomer(pickup, manager, { orderNumber: notPlaced.number, source: 'CARD' }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_PLACED' } });
  });

  it('право такое же, как у выдачи: посторонний получает 403', async () => {
    const { order } = await placed();
    for (const roles of [['WAREHOUSE'], ['FLORIST'], ['COURIER'], ['LOGISTICIAN']] as const) {
      const token = await tokenFor([...roles]);
      const denied = await call('POST', '/api/pickup/cancellations', token, {
        orderNumber: order.number,
      });
      expect(denied.statusCode, roles.join(',')).toBe(403);
    }
    // Аноним — 401.
    const anon = await call('POST', '/api/pickup/cancellations', null, {
      orderNumber: order.number,
    });
    expect(anon.statusCode).toBe(401);

    // Разрешённые роли проходят.
    for (const roles of [['MANAGER'], ['ADMIN'], ['SUPERVISOR']] as const) {
      const fresh = await placed();
      const token = await tokenFor([...roles]);
      const ok = await call('POST', '/api/pickup/cancellations', token, {
        orderNumber: fresh.order.number,
      });
      expect(ok.statusCode, roles.join(',')).toBe(200);
    }
  });
});

// --- Время доставки на карточке ----------------------------------------------

describe('карточка: время доставки', () => {
  async function intervalOf(orderId: string, orderNumber: string) {
    const card = await findPickupByNumber(ctx.db, orderNumber);
    expect(card.orderId).toBe(orderId);
    return card.deliveryInterval;
  }

  it('точное время', async () => {
    const order = await seedOrder();
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: { intervalKind: 'EXACT', intervalStartMinute: 600, intervalEndMinute: null },
    });
    expect(await intervalOf(order.id, order.number)).toMatchObject({
      kind: 'EXACT',
      startMinute: 600,
    });
  });

  it('диапазон', async () => {
    const order = await seedOrder();
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: { intervalKind: 'RANGE', intervalStartMinute: 600, intervalEndMinute: 720 },
    });
    expect(await intervalOf(order.id, order.number)).toMatchObject({
      kind: 'RANGE',
      startMinute: 600,
      endMinute: 720,
    });
  });

  it('отсутствующее время', async () => {
    const order = await seedOrder();
    // По умолчанию intervalKind = MISSING.
    expect(await intervalOf(order.id, order.number)).toMatchObject({ kind: 'MISSING' });
  });

  it('нераспознанное время сохраняет исходную строку', async () => {
    const order = await seedOrder();
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: { intervalKind: 'UNRECOGNIZED', intervalRaw: 'после обеда' },
    });
    expect(await intervalOf(order.id, order.number)).toMatchObject({
      kind: 'UNRECOGNIZED',
      raw: 'после обеда',
    });
  });

  it('ручной интервал логиста сильнее источника', async () => {
    const order = await seedOrder();
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: {
        intervalKind: 'RANGE',
        intervalStartMinute: 600,
        intervalEndMinute: 720,
        manualIntervalStartMinute: 900,
        manualIntervalEndMinute: 1020,
        manualIntervalSetAt: new Date(),
      },
    });
    expect(await intervalOf(order.id, order.number)).toMatchObject({
      kind: 'RANGE',
      startMinute: 900,
      endMinute: 1020,
    });
  });
});

// --- Защита МоегоСклада ------------------------------------------------------

describe('самовывоз не пишет в МойСклад', () => {
  it('выдача и локальная отмена не создают ни задачи состояния, ни строки синхронизации', async () => {
    const before = await ctx.db.outboxMessage.count({ where: { topic: 'moysklad.order_state' } });

    const manager = await actorFor(['MANAGER']);

    const issuedOrder = await placed();
    await issueToCustomer(
      pickup,
      manager,
      { orderNumber: issuedOrder.order.number, source: 'CARD' },
      CONTEXT,
    );

    const cancelledOrder = await placed();
    await cancelPickupLocally(
      pickup,
      manager,
      { orderNumber: cancelledOrder.order.number },
      CONTEXT,
    );

    // Ни у выданного, ни у локально отменённого нет строки состояния синхронизации:
    // задача order_state не ставилась, состояние в МойСклад не уходило.
    expect(await moyskladStateOf(issuedOrder.order.id)).toBeNull();
    expect(await moyskladStateOf(cancelledOrder.order.id)).toBeNull();

    // Общее число задач синхронизации состояния не изменилось.
    const after = await ctx.db.outboxMessage.count({ where: { topic: 'moysklad.order_state' } });
    expect(after).toBe(before);
  });

  it('модуль самовывоза не связан с синхронизацией состояния и клиентом МоегоСклада', async () => {
    // Флаг MOYSKLAD_ORDER_STATE_SYNC_ENABLED живёт в клиенте МоегоСклада,
    // которого модуль самовывоза не касается вовсе: включение флага изменить
    // поведение выдачи и отмены не может по построению. Доказывается по исходнику.
    const source = await readFile(path.join(MODULE_DIR, 'service.js'), 'utf8').catch(() =>
      readFile(path.join(MODULE_DIR, 'service.ts'), 'utf8'),
    );
    expect(source).not.toContain('state-sync');
    expect(source).not.toContain('enqueueOrderStateSync');
    expect(source).not.toContain('orderMoyskladState');
    expect(source).not.toContain('MoyskladClient');
    expect(source).not.toContain('MOYSKLAD_ORDER_STATE_SYNC_ENABLED');
  });
});
