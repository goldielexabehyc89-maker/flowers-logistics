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
import type { Role } from '@fl/shared';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { createStorageCell, unknownOccupancy, type CellDeps } from '../warehouse/service.js';
import { receiveOrder, type FlowDeps } from '../warehouse/placement.js';
import { isPickupOrder, issueToCustomer, type PickupDeps } from './service.js';
import { findPickupByNumber, listPickupsOfDay } from './views.js';

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

    const result = await issueToCustomer(pickup, manager, { orderNumber: order.number }, CONTEXT);

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
    await issueToCustomer(pickup, manager, { orderNumber: order.number }, CONTEXT);

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
    await issueToCustomer(pickup, manager, { orderNumber: order.number }, CONTEXT);

    await expect(
      issueToCustomer(pickup, manager, { orderNumber: order.number }, CONTEXT),
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
      issueToCustomer(pickup, manager, { orderNumber: order.number }, CONTEXT),
      issueToCustomer(pickup, manager, { orderNumber: order.number }, CONTEXT),
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
      issueToCustomer(pickup, manager, { orderNumber: notPlaced.number }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_PLACED' } });

    // Обычная доставка: этот раздел не про неё.
    const delivery = await placed({ deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery });
    await expect(
      issueToCustomer(pickup, manager, { orderNumber: delivery.order.number }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_PICKUP' } });

    // Способ получения не указан вовсе.
    const unknownMethod = await placed({ deliveryMethodId: null });
    await expect(
      issueToCustomer(pickup, manager, { orderNumber: unknownMethod.order.number }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_PICKUP' } });

    // Источник архивирован или пропал: заказ мог быть отменён.
    const archived = await placed({ sourceArchived: true });
    await expect(
      issueToCustomer(pickup, manager, { orderNumber: archived.order.number }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_BLOCKED' } });

    const missing = await placed({ sourceMissing: true });
    await expect(
      issueToCustomer(pickup, manager, { orderNumber: missing.order.number }, CONTEXT),
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
      issueToCustomer(pickup, manager, { orderNumber: shared }, CONTEXT),
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

  it('выданный заказ уходит из ожидающих и появляется среди выданных', async () => {
    const day = '2027-06-16';
    const { order } = await placed({ day });
    const manager = await actorFor(['MANAGER']);

    const before = await listPickupsOfDay(ctx.db, day);
    expect(before.waiting.map((row) => row.orderNumber)).toContain(order.number);
    expect(before.issued.map((row) => row.orderNumber)).not.toContain(order.number);

    await issueToCustomer(pickup, manager, { orderNumber: order.number }, CONTEXT);

    const after = await listPickupsOfDay(ctx.db, day);
    expect(after.waiting.map((row) => row.orderNumber)).not.toContain(order.number);
    const issued = after.issued.find((row) => row.orderNumber === order.number);
    expect(issued?.blockers).toContain('ALREADY_ISSUED');
    expect(issued?.issuedAt).not.toBeNull();
  });

  it('список дня не смешивает соседние дни и чужие способы получения', async () => {
    const day = '2027-06-17';
    const mine = await placed({ day });
    const otherDay = await placed({ day: '2027-06-18' });
    const delivery = await placed({ day, deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery });

    const view = await listPickupsOfDay(ctx.db, day);
    const numbers = view.waiting.map((row) => row.orderNumber);

    expect(numbers).toContain(mine.order.number);
    expect(numbers).not.toContain(otherDay.order.number);
    expect(numbers).not.toContain(delivery.order.number);
  });
});

// --- 4. Права ----------------------------------------------------------------

describe('права раздела', () => {
  it('MANAGER и ADMIN работают, остальные роли получают 403, аноним — 401', async () => {
    const { order } = await placed();

    for (const roles of [['MANAGER'], ['ADMIN']] as Role[][]) {
      const token = await tokenFor(roles);
      expect((await call('GET', '/api/pickup/orders', token)).statusCode).toBe(200);
      expect((await call('GET', `/api/pickup/scan?number=${order.number}`, token)).statusCode).toBe(
        200,
      );
    }

    for (const roles of [['WAREHOUSE'], ['FLORIST'], ['LOGISTICIAN'], ['COURIER']] as Role[][]) {
      const token = await tokenFor(roles);
      expect((await call('GET', '/api/pickup/orders', token)).statusCode).toBe(403);
      expect(
        (await call('POST', '/api/pickup/issues', token, { orderNumber: order.number })).statusCode,
      ).toBe(403);
    }

    expect((await call('GET', '/api/pickup/orders', null)).statusCode).toBe(401);
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

    await issueToCustomer(pickup, manager, { orderNumber: order.number }, CONTEXT);

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
