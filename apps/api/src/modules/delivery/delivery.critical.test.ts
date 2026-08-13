/**
 * Критические проверки работы курьера (этап 6.6).
 *
 * Проверяется не «нажимается ли кнопка», а то, нарушение чего искажает
 * операционную правду: две действующие правды у одного заказа, результат
 * от чужого курьера, переписанная задним числом история, переименование
 * причины, задним числом изменившее уже сообщённое, и маршрут, оставшийся
 * активным после последнего результата.
 *
 * Даты подобраны так, чтобы не пересекаться с другими файлами набора.
 */

import { randomUUID } from 'node:crypto';
import { TEST_SECRETS } from '../../platform/testing/secrets.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import type { Role } from '@fl/shared';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import {
  DELIVERY_CANCEL_WINDOW_MS,
  cancelDeliveryResult,
  listActiveDeliveries,
  listDeliveryHistory,
  listFailureReasons,
  recordDeliveryResult,
  updateFailureReason,
  type DeliveryDeps,
} from './service.js';

let ctx: TestContext;
let deps: DeliveryDeps;
const CONTEXT = { ip: null, userAgent: null };

/** День вне диапазонов остальных файлов набора. */
const DAY = '2027-07-19';

beforeAll(async () => {
  ctx = await createTestContext();
  deps = { db: ctx.db };
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
  return { userId: user.id, roles, familyId: randomUUID() } as AuthenticatedActor;
}

async function seedOrder(overrides: Record<string, unknown> = {}): Promise<string> {
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: unique('D'),
      externalUpdated: new Date(),
      deliveryDate: toDateColumn(DAY),
      inScope: true,
      address: 'синтетический адрес',
      recipient: 'синтетический получатель',
      ...overrides,
    },
    select: { id: true },
  });
  return order.id;
}

/** Маршрут сразу в состоянии выданного: складской путь проверяется отдельно. */
async function seedActiveRoute(
  courierId: string,
  orderCount = 1,
): Promise<{ routeId: string; participations: string[]; orderIds: string[] }> {
  const creator = await actorFor(['ADMIN']);
  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: unique('RD'),
      deliveryDate: toDateColumn(DAY),
      state: 'ACTIVE',
      vehicleType: 'CAR',
      createdById: creator.userId,
      courierUserId: courierId,
    },
    select: { id: true },
  });

  const participations: string[] = [];
  const orderIds: string[] = [];
  for (let index = 0; index < orderCount; index += 1) {
    const orderId = await seedOrder();
    const participation = await ctx.db.routeOrder.create({
      data: {
        routeId: route.id,
        orderId,
        position: index + 1,
        addedById: creator.userId,
      },
      select: { id: true },
    });
    participations.push(participation.id);
    orderIds.push(orderId);
  }

  return { routeId: route.id, participations, orderIds };
}

async function reasonByCode(code: string): Promise<{ id: string; name: string }> {
  return ctx.db.deliveryFailureReason.findUniqueOrThrow({
    where: { code },
    select: { id: true, name: true },
  });
}

/**
 * Проверяет отказ по ПУБЛИЧНОМУ сообщению.
 *
 * `Error.message` у `AppError` — внутренний технический текст либо код; наружу
 * человеку уходит `publicMessage`, и проверять нужно именно его: именно его
 * прочитает курьер.
 */
async function expectRefusal(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    publicMessage: expect.stringMatching(pattern) as unknown as string,
  });
}

const routeState = async (routeId: string): Promise<string> =>
  (
    await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: routeId },
      select: { state: true },
    })
  ).state;

// --- 1. Справочник причин ----------------------------------------------------

describe('справочник причин недоставки', () => {
  it('начальный набор из продуктового контракта присутствует и активен', async () => {
    const reasons = await listFailureReasons(ctx.db);
    const codes = reasons.map((reason) => reason.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        'NO_ANSWER',
        'RECIPIENT_ABSENT',
        'REFUSED',
        'WRONG_ADDRESS',
        'NO_ACCESS',
        'PAYMENT_PROBLEM',
        'DAMAGE',
        'OTHER',
      ]),
    );
    expect(reasons.find((reason) => reason.code === 'OTHER')?.requiresComment).toBe(true);
  });
});

// --- 2. Результат доставки ---------------------------------------------------

describe('окончательный результат', () => {
  it('«Доставлен» записывается без причины и время ставит сервер', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);
    const serverNow = new Date('2027-07-19T09:30:00.000Z');

    const result = await recordDeliveryResult(
      { db: ctx.db, clock: () => serverNow },
      courier,
      route.participations[0]!,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );

    expect(result.attempt.outcome).toBe('DELIVERED');
    expect(result.attempt.reasonName).toBeNull();
    // Часы устройства курьера доказательством не служат: сравнивается то,
    // что поставил сервер.
    expect(result.attempt.occurredAt.toISOString()).toBe(serverNow.toISOString());
  });

  it('«Не доставлен» без причины отвергается', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);

    await expectRefusal(
      recordDeliveryResult(
        deps,
        courier,
        route.participations[0]!,
        {
          outcome: 'NOT_DELIVERED',
        },
        CONTEXT,
      ),
      /причину/i,
    );
  });

  it('«Другое» без комментария отвергается, с комментарием проходит', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId, 2);
    const other = await reasonByCode('OTHER');

    await expectRefusal(
      recordDeliveryResult(
        deps,
        courier,
        route.participations[0]!,
        { outcome: 'NOT_DELIVERED', reasonId: other.id },
        CONTEXT,
      ),
      /комментарий/i,
    );

    const ok = await recordDeliveryResult(
      deps,
      courier,
      route.participations[0]!,
      { outcome: 'NOT_DELIVERED', reasonId: other.id, comment: 'дверь закрыта наглухо' },
      CONTEXT,
    );
    expect(ok.attempt.outcome).toBe('NOT_DELIVERED');
  });

  it('снимок названия причины переживает переименование справочника', async () => {
    const admin = await actorFor(['ADMIN']);
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);
    const reason = await reasonByCode('NO_ACCESS');

    const attempt = await recordDeliveryResult(
      deps,
      courier,
      route.participations[0]!,
      { outcome: 'NOT_DELIVERED', reasonId: reason.id },
      CONTEXT,
    );
    expect(attempt.attempt.reasonName).toBe(reason.name);

    const current = await ctx.db.deliveryFailureReason.findUniqueOrThrow({
      where: { id: reason.id },
      select: { version: true },
    });
    await updateFailureReason(
      deps,
      admin,
      reason.id,
      { name: `Домофон не работает ${Date.now()}`, expectedVersion: current.version },
      CONTEXT,
    );

    const stored = await ctx.db.deliveryAttempt.findUniqueOrThrow({
      where: { id: attempt.attempt.id },
      select: { reasonNameSnapshot: true },
    });
    // Переименование справочника не переписывает того, что курьер уже сообщил.
    expect(stored.reasonNameSnapshot).toBe(reason.name);
    const renamed = await ctx.db.deliveryFailureReason.findUniqueOrThrow({
      where: { id: reason.id },
      select: { name: true },
    });
    expect(stored.reasonNameSnapshot).not.toBe(renamed.name);
  });
});

// --- 3. Права и fail closed --------------------------------------------------

describe('границы результата', () => {
  it('чужой курьер результат не сообщает', async () => {
    const owner = await actorFor(['COURIER']);
    const stranger = await actorFor(['COURIER']);
    const route = await seedActiveRoute(owner.userId);

    await expectRefusal(
      recordDeliveryResult(
        deps,
        stranger,
        route.participations[0]!,
        {
          outcome: 'DELIVERED',
        },
        CONTEXT,
      ),
      /назначенный курьер/i,
    );
  });

  it('логист и администратор не подменяют собой курьера', async () => {
    const courier = await actorFor(['COURIER']);
    const manager = await actorFor(['LOGISTICIAN']);
    const route = await seedActiveRoute(courier.userId);

    await expectRefusal(
      recordDeliveryResult(
        deps,
        manager,
        route.participations[0]!,
        {
          outcome: 'DELIVERED',
        },
        CONTEXT,
      ),
      /назначенный курьер/i,
    );
  });

  it('неактивный маршрут отказывает', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);
    await ctx.db.deliveryRoute.update({
      where: { id: route.routeId },
      data: { state: 'CONFIRMED' },
    });

    await expectRefusal(
      recordDeliveryResult(
        deps,
        courier,
        route.participations[0]!,
        {
          outcome: 'DELIVERED',
        },
        CONTEXT,
      ),
      /не выдан|отменён/i,
    );
  });

  it('снятое участие отказывает', async () => {
    const courier = await actorFor(['COURIER']);
    const remover = await actorFor(['ADMIN']);
    const route = await seedActiveRoute(courier.userId, 2);
    await ctx.db.routeOrder.update({
      where: { id: route.participations[0]! },
      data: {
        removedAt: new Date(),
        removedById: remover.userId,
        removalReason: 'RETURNED_TO_UNASSIGNED',
      },
    });

    await expectRefusal(
      recordDeliveryResult(
        deps,
        courier,
        route.participations[0]!,
        {
          outcome: 'DELIVERED',
        },
        CONTEXT,
      ),
      /не входит/i,
    );
  });
});

// --- 4. Одна правда: гонка и повтор -----------------------------------------

describe('двух действующих правд не бывает', () => {
  it('повтор того же результата не создаёт вторую запись', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);

    const first = await recordDeliveryResult(
      deps,
      courier,
      route.participations[0]!,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );
    const second = await recordDeliveryResult(
      deps,
      courier,
      route.participations[0]!,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );

    expect(second.unchanged).toBe(true);
    expect(second.attempt.id).toBe(first.attempt.id);
    expect(
      await ctx.db.deliveryAttempt.count({ where: { routeOrderId: route.participations[0]! } }),
    ).toBe(1);
  });

  it('другой результат поверх существующего — конфликт, а не подмена', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);
    const reason = await reasonByCode('REFUSED');

    await recordDeliveryResult(
      deps,
      courier,
      route.participations[0]!,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );

    await expectRefusal(
      recordDeliveryResult(
        deps,
        courier,
        route.participations[0]!,
        { outcome: 'NOT_DELIVERED', reasonId: reason.id },
        CONTEXT,
      ),
      /уже есть результат/i,
    );
  });

  it('два устройства одновременно дают ровно одну действующую правду', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);
    const reason = await reasonByCode('NO_ANSWER');

    // Гонка настоящая: обе транзакции стартуют одновременно и упираются
    // в уникальный индекс базы, а не в проверку в коде.
    const outcomes = await Promise.allSettled([
      recordDeliveryResult(
        deps,
        courier,
        route.participations[0]!,
        { outcome: 'DELIVERED' },
        CONTEXT,
      ),
      recordDeliveryResult(
        deps,
        courier,
        route.participations[0]!,
        { outcome: 'NOT_DELIVERED', reasonId: reason.id },
        CONTEXT,
      ),
    ]);

    const fulfilled = outcomes.filter((entry) => entry.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(
      await ctx.db.deliveryAttempt.count({
        where: { routeOrderId: route.participations[0]!, activeKey: { not: null } },
      }),
    ).toBe(1);
  });
});

// --- 5. Завершение маршрута --------------------------------------------------

describe('автоматическое завершение маршрута', () => {
  it('первый результат оставляет ACTIVE, последний переводит в COMPLETED', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId, 2);

    const first = await recordDeliveryResult(
      deps,
      courier,
      route.participations[0]!,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );
    expect(first.routeCompleted).toBe(false);
    expect(first.remaining).toBe(1);
    expect(await routeState(route.routeId)).toBe('ACTIVE');

    const second = await recordDeliveryResult(
      deps,
      courier,
      route.participations[1]!,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );
    expect(second.routeCompleted).toBe(true);
    expect(second.remaining).toBe(0);
    expect(await routeState(route.routeId)).toBe('COMPLETED');

    // Завершение сопровождается переходом состояния — иначе история маршрута
    // умалчивала бы о том, как он закончился.
    const transition = await ctx.db.routeStateTransition.findFirst({
      where: { routeId: route.routeId, toState: 'COMPLETED' },
      select: { fromState: true },
    });
    expect(transition?.fromState).toBe('ACTIVE');
  });

  it('недоставка тоже завершает маршрут: незавершённых заказов не осталось', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);
    const reason = await reasonByCode('RECIPIENT_ABSENT');

    const result = await recordDeliveryResult(
      deps,
      courier,
      route.participations[0]!,
      { outcome: 'NOT_DELIVERED', reasonId: reason.id },
      CONTEXT,
    );

    expect(result.routeCompleted).toBe(true);
    expect(await routeState(route.routeId)).toBe('COMPLETED');
  });
});

// --- 6. Отмена и пять минут --------------------------------------------------

describe('исправление результата', () => {
  it('курьер отменяет свой результат в пятиминутном окне и снова открывает заказ', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);
    const at = new Date('2027-07-19T10:00:00.000Z');

    const recorded = await recordDeliveryResult(
      { db: ctx.db, clock: () => at },
      courier,
      route.participations[0]!,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );
    expect(await routeState(route.routeId)).toBe('COMPLETED');

    const cancelled = await cancelDeliveryResult(
      { db: ctx.db, clock: () => new Date(at.getTime() + DELIVERY_CANCEL_WINDOW_MS - 1000) },
      courier,
      recorded.attempt.id,
      {},
      CONTEXT,
    );

    expect(cancelled.kind).toBe('COURIER_SELF');
    expect(cancelled.routeReopened).toBe(true);
    expect(cancelled.remaining).toBe(1);
    // Маршрут снова активен: незавершённый заказ вернулся курьеру.
    expect(await routeState(route.routeId)).toBe('ACTIVE');
  });

  it('после пяти минут курьер уже не отменяет', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);
    const at = new Date('2027-07-19T11:00:00.000Z');

    const recorded = await recordDeliveryResult(
      { db: ctx.db, clock: () => at },
      courier,
      route.participations[0]!,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );

    await expectRefusal(
      cancelDeliveryResult(
        { db: ctx.db, clock: () => new Date(at.getTime() + DELIVERY_CANCEL_WINDOW_MS + 1000) },
        courier,
        recorded.attempt.id,
        {},
        CONTEXT,
      ),
      /пяти минут/i,
    );
  });

  it('логист исправляет позже, но только с причиной', async () => {
    const courier = await actorFor(['COURIER']);
    const manager = await actorFor(['LOGISTICIAN']);
    const route = await seedActiveRoute(courier.userId);
    const at = new Date('2027-07-19T12:00:00.000Z');
    const later = new Date(at.getTime() + 60 * 60 * 1000);

    const recorded = await recordDeliveryResult(
      { db: ctx.db, clock: () => at },
      courier,
      route.participations[0]!,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );

    await expectRefusal(
      cancelDeliveryResult(
        { db: ctx.db, clock: () => later },
        manager,
        recorded.attempt.id,
        {},
        CONTEXT,
      ),
      /причин/i,
    );

    const fixed = await cancelDeliveryResult(
      { db: ctx.db, clock: () => later },
      manager,
      recorded.attempt.id,
      { reason: 'курьер отметил не тот заказ' },
      CONTEXT,
    );
    expect(fixed.kind).toBe('MANAGER_CORRECTION');
  });

  it('чужой результат курьер не отменяет', async () => {
    const courier = await actorFor(['COURIER']);
    const stranger = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);

    const recorded = await recordDeliveryResult(
      deps,
      courier,
      route.participations[0]!,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );

    await expectRefusal(
      cancelDeliveryResult(deps, stranger, recorded.attempt.id, {}, CONTEXT),
      /чужой результат/i,
    );
  });

  it('история не переписывается: содержимое попытки неизменяемо', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);

    const recorded = await recordDeliveryResult(
      deps,
      courier,
      route.participations[0]!,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );

    // Это и есть попытка «исправить задним числом». База обязана отказать.
    await expect(
      ctx.db.deliveryAttempt.update({
        where: { id: recorded.attempt.id },
        data: { outcome: 'NOT_DELIVERED' },
      }),
    ).rejects.toThrow(/неизменяем/i);

    await expect(
      ctx.db.deliveryAttempt.delete({ where: { id: recorded.attempt.id } }),
    ).rejects.toThrow();

    await cancelDeliveryResult(deps, courier, recorded.attempt.id, {}, CONTEXT);

    // Отменённая попытка остаётся в истории со своим прежним содержимым.
    const stored = await ctx.db.deliveryAttempt.findUniqueOrThrow({
      where: { id: recorded.attempt.id },
      select: { outcome: true, activeKey: true, cancellation: { select: { kind: true } } },
    });
    expect(stored.outcome).toBe('DELIVERED');
    expect(stored.activeKey).toBeNull();
    expect(stored.cancellation?.kind).toBe('COURIER_SELF');

    // И действующей снова стать не может.
    await expect(
      ctx.db.deliveryAttempt.update({
        where: { id: recorded.attempt.id },
        data: { activeKey: route.participations[0]! },
      }),
    ).rejects.toThrow(/действующей/i);
  });

  it('повторная отмена ничего не меняет', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);

    const recorded = await recordDeliveryResult(
      deps,
      courier,
      route.participations[0]!,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );
    await cancelDeliveryResult(deps, courier, recorded.attempt.id, {}, CONTEXT);

    await expectRefusal(
      cancelDeliveryResult(deps, courier, recorded.attempt.id, {}, CONTEXT),
      /уже отменён/i,
    );
    expect(
      await ctx.db.deliveryAttemptCancellation.count({ where: { attemptId: recorded.attempt.id } }),
    ).toBe(1);
  });
});

// --- 7. Видимость и маскирование --------------------------------------------

describe('видимость активных доставок', () => {
  it('курьер видит только свои маршруты', async () => {
    const mine = await actorFor(['COURIER']);
    const other = await actorFor(['COURIER']);
    const own = await seedActiveRoute(mine.userId);
    await seedActiveRoute(other.userId);

    const view = await listActiveDeliveries(deps, mine);
    const ids = view.routes.map((route) => route.routeId);

    expect(ids).toContain(own.routeId);
    expect(view.routes.every((route) => route.courier?.id === mine.userId)).toBe(true);
  });

  it('логист видит чужие активные маршруты и может отфильтровать по курьеру', async () => {
    const courier = await actorFor(['COURIER']);
    const manager = await actorFor(['LOGISTICIAN']);
    const route = await seedActiveRoute(courier.userId);

    const all = await listActiveDeliveries(deps, manager);
    expect(all.routes.map((entry) => entry.routeId)).toContain(route.routeId);

    const filtered = await listActiveDeliveries(deps, manager, { courierUserId: courier.userId });
    expect(filtered.routes.every((entry) => entry.courier?.id === courier.userId)).toBe(true);
  });

  it('фильтр маршрута сужает объединённый список', async () => {
    const courier = await actorFor(['COURIER']);
    const first = await seedActiveRoute(courier.userId);
    await seedActiveRoute(courier.userId);

    const filtered = await listActiveDeliveries(deps, courier, { routeId: first.routeId });

    expect(filtered.routes).toHaveLength(1);
    expect(filtered.routes[0]?.routeId).toBe(first.routeId);
  });
});

describe('история и московская граница дня', () => {
  it('со следующего московского дня курьер теряет PII, но не номер и результат', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);
    const at = new Date(`${DAY}T09:00:00.000Z`);

    await recordDeliveryResult(
      { db: ctx.db, clock: () => at },
      courier,
      route.participations[0]!,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );

    const sameDay = await listDeliveryHistory({ db: ctx.db, clock: () => at }, courier, {
      date: DAY,
    });
    const mineToday = sameDay.items.find((item) => item.routeNumber !== undefined);
    expect(mineToday?.masked).toBe(false);
    expect(mineToday?.address).not.toBeNull();

    // Следующий московский день: 21:00 UTC — это уже завтра в Москве.
    const nextDay = new Date(`${DAY}T21:30:00.000Z`);
    const later = await listDeliveryHistory({ db: ctx.db, clock: () => nextDay }, courier, {
      date: DAY,
    });
    const masked = later.items[0];
    expect(masked?.masked).toBe(true);
    expect(masked?.address).toBeNull();
    expect(masked?.recipient).toBeNull();
    // Номер, результат и серверное время остаются: без них история бесполезна.
    expect(masked?.orderNumber).toBeTruthy();
    expect(masked?.outcome).toBe('DELIVERED');
    expect(masked?.occurredAt).toBeInstanceOf(Date);
  });

  it('логист PII не теряет: маскирование адресовано курьеру', async () => {
    const courier = await actorFor(['COURIER']);
    const manager = await actorFor(['LOGISTICIAN']);
    const route = await seedActiveRoute(courier.userId);
    const at = new Date(`${DAY}T09:10:00.000Z`);

    await recordDeliveryResult(
      { db: ctx.db, clock: () => at },
      courier,
      route.participations[0]!,
      { outcome: 'DELIVERED' },
      CONTEXT,
    );

    const view = await listDeliveryHistory(
      { db: ctx.db, clock: () => new Date(`${DAY}T21:30:00.000Z`) },
      manager,
      { date: DAY, courierUserId: courier.userId },
    );
    expect(view.items[0]?.masked).toBe(false);
    expect(view.items[0]?.address).not.toBeNull();
  });
});

// --- 8. Права HTTP-слоя ------------------------------------------------------

/**
 * Токены кешируются по набору ролей: каждый вход считает argon2, а набор
 * проверок прав перебирает роли в цикле.
 */
const tokenCache = new Map<string, string>();

async function tokenFor(roles: Role[]): Promise<string> {
  const key = [...roles].sort().join(',');
  const cached = tokenCache.get(key);
  if (cached !== undefined) return cached;

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

  tokenCache.set(key, session.accessToken);
  return session.accessToken;
}

interface Injected {
  statusCode: number;
  json: () => unknown;
}

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  token: string | null,
  payload?: unknown,
): Promise<Injected> {
  return ctx.app.inject({
    method,
    url,
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    ...(payload === undefined ? {} : { payload }),
  }) as unknown as Promise<Injected>;
}

describe('права проверяет сервер, а не навигация', () => {
  it('аноним не получает ни одного раздела доставки', async () => {
    for (const url of [
      '/api/delivery/active',
      '/api/delivery/history',
      '/api/delivery/failure-reasons',
    ]) {
      const response = await call('GET', url, null);
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('склад и флорист к доставке не допускаются', async () => {
    for (const roles of [['WAREHOUSE'], ['FLORIST']] as Role[][]) {
      const token = await tokenFor(roles);
      const response = await call('GET', '/api/delivery/active', token);
      expect(response.statusCode, roles.join(',')).toBe(403);
    }
  });

  it('справочник причин меняют только логист и администратор', async () => {
    const reason = await reasonByCode('DAMAGE');
    const current = await ctx.db.deliveryFailureReason.findUniqueOrThrow({
      where: { id: reason.id },
      select: { version: true },
    });

    const courier = await call(
      'PUT',
      `/api/delivery/failure-reasons/${reason.id}`,
      await tokenFor(['COURIER']),
      {
        isActive: true,
        expectedVersion: current.version,
      },
    );
    expect(courier.statusCode).toBe(403);

    const manager = await call(
      'PUT',
      `/api/delivery/failure-reasons/${reason.id}`,
      await tokenFor(['LOGISTICIAN']),
      {
        isActive: true,
        expectedVersion: current.version,
      },
    );
    expect(manager.statusCode).toBe(200);
  });

  it('курьер не смотрит чужой список подстановкой параметра', async () => {
    const stranger = await actorFor(['COURIER']);
    const route = await seedActiveRoute(stranger.userId);
    const token = await tokenFor(['COURIER']);

    // Параметр `courierUserId` для курьера не действует: сервер всегда
    // подставляет его самого.
    const response = await call(
      'GET',
      `/api/delivery/active?courierUserId=${stranger.userId}`,
      token,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as { routes: { routeId: string }[] };
    expect(body.routes.map((entry) => entry.routeId)).not.toContain(route.routeId);
  });
});

// --- 9. Совместимость со схемой ---------------------------------------------

describe('расширяющая миграция не ломает прежний код', () => {
  it('`COMPLETED` добавлен в КОНЕЦ перечисления', async () => {
    const rows = await ctx.db.$queryRawUnsafe<{ label: string; sort: number }[]>(
      `SELECT e.enumlabel AS label, e.enumsortorder::float8 AS sort
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'RouteState' ORDER BY e.enumsortorder`,
    );
    const labels = rows.map((row) => row.label);

    // Порядок объявления — то, чем PostgreSQL сравнивает значения. Вставка
    // в середину сдвинула бы уже записанные строки, и прежний клиент прочитал
    // бы не то, что записывал.
    expect(labels).toEqual(['DRAFT', 'CONFIRMED', 'CANCELLED', 'ACTIVE', 'COMPLETED']);
  });

  it('прежние запросы к маршрутам и заказам работают против расширенной схемы', async () => {
    const courier = await actorFor(['COURIER']);
    const route = await seedActiveRoute(courier.userId);

    // Ровно те выборки, которые делает код предыдущей версии: он ничего
    // не знает ни о попытках, ни о новых колонках.
    const legacyRoute = await ctx.db.deliveryRoute.findUniqueOrThrow({
      where: { id: route.routeId },
      select: { id: true, number: true, state: true, version: true, courierUserId: true },
    });
    expect(legacyRoute.state).toBe('ACTIVE');

    const legacyOrders = await ctx.db.routeOrder.findMany({
      where: { routeId: route.routeId, removedAt: null },
      select: { id: true, position: true, orderId: true },
    });
    expect(legacyOrders).toHaveLength(1);

    // И ни одна существующая колонка не стала обязательной: заказ создаётся
    // прежним набором полей.
    const order = await ctx.db.deliveryOrder.create({
      data: {
        externalId: randomUUID(),
        externalName: unique('LEGACY'),
        externalUpdated: new Date(),
        deliveryDate: toDateColumn(DAY),
        inScope: true,
      },
      select: { id: true },
    });
    expect(order.id).toBeTruthy();
  });

  it('справочник причин заполнен миграцией, а не кодом приложения', async () => {
    // Восемь причин появляются вместе со схемой: пустой справочник сделал бы
    // недоставку невозможной сразу после выкатки.
    expect(await ctx.db.deliveryFailureReason.count()).toBeGreaterThanOrEqual(8);
  });
});
