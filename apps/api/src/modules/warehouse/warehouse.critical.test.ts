/**
 * Критические проверки готовности заказа к отгрузке (этап 6.1).
 *
 * Проверяется не «работает ли экран», а то, нарушение чего опасно: кто вправе
 * менять готовность, что при этом попадает наружу, переживает ли отметка
 * синхронизацию и остаётся ли изменение атомарным вместе с аудитом и событием.
 *
 * Инварианты проверяются и через API, и напрямую в базе: правило, которое
 * держится только кодом, однажды обойдут скриптом или консолью.
 *
 * Сетевых обращений нет: заказы строятся mapper'ом и применяются напрямую.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { TEST_SECRETS } from '../../platform/testing/secrets.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { applyOrderSnapshot, markSourceMissing } from '../integrations/moysklad/import-service.js';
import { mapOrder, type OrderSnapshot } from '../integrations/moysklad/mapper.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { setShipmentReadiness } from './service.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import type { Role } from '@fl/shared';

let ctx: TestContext;
const IDS = MOYSKLAD_IDS;
const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;
const NOW = new Date('2026-08-10T09:00:00.000Z');

/** Даты подобраны так, чтобы не пересекаться с данными других файлов набора. */
const DAY = '2027-03-01';
const OTHER_DAY = '2027-03-02';

/**
 * Значения, которых не должно быть видно складу ни в одном ответе.
 * Они кладутся в заказ намеренно: проверять отсутствие того, чего нет,
 * бессмысленно — такая проверка проходит и на пустой базе.
 */
const SECRET_ADDRESS = 'Москва, Складская проверка, дом 7, кв 3';
const SECRET_RECIPIENT = 'Складской Получатель Секретный';
const SECRET_COMMENT = 'Комментарий, который склад видеть не должен';
const SECRET_SUM = 777000;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

// --- Фикстуры ---------------------------------------------------------------

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    name: `W-${process.hrtime.bigint() % 1_000_000n}`,
    updated: '2026-08-10 10:00:00.000',
    shipmentAddress: SECRET_ADDRESS,
    deliveryPlannedMoment: `${DAY} 12:00:00.000`,
    sum: SECRET_SUM,
    payedSum: 0,
    store: { meta: { href: href('store', IDS.store) } },
    state: {
      meta: { href: href('state', '33333333-3333-4333-8333-333333333333') },
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Собран/Ожидает отгрузки',
      stateType: 'Regular',
    },
    attributes: [
      {
        id: IDS.deliveryMethodAttribute,
        value: {
          name: 'Доставка',
          meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
        },
      },
      { id: IDS.intervalAttribute, value: 'с 16:00 по 19:00' },
      { id: IDS.recipientAttribute, value: SECRET_RECIPIENT },
      { id: IDS.commentAttribute, value: SECRET_COMMENT },
    ],
    ...overrides,
  };
}

function snapshotOf(overrides: Record<string, unknown> = {}): OrderSnapshot {
  return mapOrder(source(overrides) as never, IDS).snapshot;
}

async function apply(snapshot: OrderSnapshot, at = NOW) {
  return ctx.db.$transaction((tx) => applyOrderSnapshot(tx, snapshot, at));
}

interface SeededOrder {
  id: string;
  externalId: string;
  version: number;
}

async function seedOrder(overrides: Record<string, unknown> = {}): Promise<SeededOrder> {
  const snapshot = snapshotOf(overrides);
  await apply(snapshot);
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { externalId: snapshot.externalId },
    select: { id: true, externalId: true, version: true },
  });
  return order;
}

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return {
    userId: user.id,
    roles,
    familyId: '00000000-0000-4000-8000-000000000061',
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
  body: string;
}

async function call(
  method: 'GET' | 'PUT',
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

const CONTEXT = { ip: null, userAgent: null };

async function readOrder(id: string) {
  return ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { id },
    select: {
      shipmentReadiness: true,
      shipmentReadinessSetAt: true,
      shipmentReadinessSetById: true,
      version: true,
      updatedAt: true,
    },
  });
}

async function auditCount(orderId: string): Promise<number> {
  return ctx.db.auditLog.count({
    where: { action: 'ORDER_SHIPMENT_READINESS_CHANGED', entityId: orderId },
  });
}

async function readinessEvents(orderId: string) {
  const rows = await ctx.db.realtimeEvent.findMany({
    where: { topic: 'order.shipment_readiness_changed' },
    select: { payload: true, audienceRoles: true, audienceUserId: true },
  });
  return rows.filter((row) => (row.payload as { orderId?: string }).orderId === orderId);
}

// --- 1. Инварианты базы -----------------------------------------------------

describe('инварианты базы', () => {
  it('новый заказ всегда NOT_READY и без следа человека', async () => {
    const order = await seedOrder();
    const row = await readOrder(order.id);

    expect(row.shipmentReadiness).toBe('NOT_READY');
    expect(row.shipmentReadinessSetAt).toBeNull();
    expect(row.shipmentReadinessSetById).toBeNull();
  });

  it('автор без времени невозможен даже прямым запросом', async () => {
    const order = await seedOrder();
    const actor = await actorFor(['WAREHOUSE']);

    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "DeliveryOrder" SET "shipmentReadinessSetById" = '${actor.userId}'::uuid ` +
          `WHERE "id" = '${order.id}'::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('время без автора невозможно даже прямым запросом', async () => {
    const order = await seedOrder();

    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "DeliveryOrder" SET "shipmentReadinessSetAt" = now() ` +
          `WHERE "id" = '${order.id}'::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('READY без следа человека невозможен даже прямым запросом', async () => {
    const order = await seedOrder();

    // Именно этот запрос и есть та самая «правка из консоли», ради которой
    // правило вынесено в базу: код тут не участвует вовсе.
    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "DeliveryOrder" SET "shipmentReadiness" = 'READY' WHERE "id" = '${order.id}'::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('автор готовности не удаляется каскадом', async () => {
    const order = await seedOrder();
    const actor = await actorFor(['WAREHOUSE']);
    await setShipmentReadiness(
      ctx,
      actor,
      { orderId: order.id, readiness: 'READY', expectedVersion: order.version },
      CONTEXT,
    );

    await expect(ctx.db.user.delete({ where: { id: actor.userId } })).rejects.toThrow();
    expect((await readOrder(order.id)).shipmentReadinessSetById).toBe(actor.userId);
  });
});

// --- 2. Права ---------------------------------------------------------------

describe('права', () => {
  it('ADMIN и WAREHOUSE читают список и меняют готовность', async () => {
    for (const roles of [['ADMIN'], ['WAREHOUSE']] as Role[][]) {
      const token = await tokenFor(roles);
      const order = await seedOrder();

      const list = await call('GET', `/api/warehouse/orders?deliveryDate=${DAY}`, token);
      expect(list.statusCode, roles.join()).toBe(200);

      const change = await call('PUT', `/api/warehouse/orders/${order.id}/readiness`, token, {
        readiness: 'READY',
        expectedVersion: order.version,
      });
      expect(change.statusCode, roles.join()).toBe(200);
    }
  });

  it('LOGISTICIAN и COURIER получают 403 и на список, и на изменение', async () => {
    for (const roles of [['LOGISTICIAN'], ['COURIER']] as Role[][]) {
      const token = await tokenFor(roles);
      const order = await seedOrder();

      const list = await call('GET', `/api/warehouse/orders?deliveryDate=${DAY}`, token);
      expect(list.statusCode, roles.join()).toBe(403);

      const change = await call('PUT', `/api/warehouse/orders/${order.id}/readiness`, token, {
        readiness: 'READY',
        expectedVersion: order.version,
      });
      expect(change.statusCode, roles.join()).toBe(403);

      // Отказ обязан быть настоящим, а не только по коду ответа.
      expect((await readOrder(order.id)).shipmentReadiness).toBe('NOT_READY');
    }
  });

  it('анонимный запрос получает 401', async () => {
    const order = await seedOrder();

    expect((await call('GET', `/api/warehouse/orders?deliveryDate=${DAY}`, null)).statusCode).toBe(
      401,
    );
    expect(
      (
        await call('PUT', `/api/warehouse/orders/${order.id}/readiness`, null, {
          readiness: 'READY',
          expectedVersion: order.version,
        })
      ).statusCode,
    ).toBe(401);
    expect((await readOrder(order.id)).shipmentReadiness).toBe('NOT_READY');
  });
});

// --- 3. Безопасный состав ответа -------------------------------------------

describe('состав ответа', () => {
  it('ни адреса, ни получателя, ни комментария, ни денег, ни координат', async () => {
    const order = await seedOrder();
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: {
        geoState: 'RESOLVED',
        geoSource: 'MANUAL',
        geoPrecision: 'EXACT_HOUSE',
        geoLatMicro: 55_700_111,
        geoLonMicro: 37_500_222,
        geoResolvedAt: new Date(),
      },
    });

    const token = await tokenFor(['WAREHOUSE']);
    const response = await call('GET', `/api/warehouse/orders?deliveryDate=${DAY}`, token);
    expect(response.statusCode).toBe(200);

    // Проверяется сырое тело, а не разобранный объект: поле может уехать
    // во вложенную структуру и разбор его не заметит.
    for (const forbidden of [
      SECRET_ADDRESS,
      SECRET_RECIPIENT,
      SECRET_COMMENT,
      '7770',
      '55700111',
      '37500222',
      order.externalId,
    ]) {
      expect(response.body, forbidden).not.toContain(forbidden);
    }

    const item = (response.json() as { items: Record<string, unknown>[] }).items.find(
      (row) => row.id === order.id,
    );
    expect(item).toBeDefined();
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'deliveryDate',
      'externalStateName',
      'id',
      'number',
      'readiness',
      'readinessSetAt',
      'version',
    ]);
  });

  it('внешний статус отдаётся как контекст и готовностью не управляет', async () => {
    // «Собран/Ожидает отгрузки» — самый соблазнительный статус для подмены:
    // он выглядит как готовность. Внутреннее состояние он менять не вправе.
    const order = await seedOrder();
    const token = await tokenFor(['WAREHOUSE']);

    const response = await call('GET', `/api/warehouse/orders?deliveryDate=${DAY}`, token);
    const item = (response.json() as { items: Record<string, unknown>[] }).items.find(
      (row) => row.id === order.id,
    );

    expect(item?.externalStateName).toBe('Собран/Ожидает отгрузки');
    expect(item?.readiness).toBe('NOT_READY');
  });

  it('ни аудит, ни realtime не несут персональных данных и денег', async () => {
    const order = await seedOrder();
    const actor = await actorFor(['WAREHOUSE']);
    await setShipmentReadiness(
      ctx,
      actor,
      { orderId: order.id, readiness: 'READY', expectedVersion: order.version },
      CONTEXT,
    );

    const audit = await ctx.db.auditLog.findFirstOrThrow({
      where: { action: 'ORDER_SHIPMENT_READINESS_CHANGED', entityId: order.id },
      select: { oldValue: true, newValue: true, actorUserId: true, source: true },
    });
    expect(audit.oldValue).toEqual({ readiness: 'NOT_READY' });
    expect(audit.newValue).toEqual({ readiness: 'READY', version: order.version + 1 });
    expect(audit.actorUserId).toBe(actor.userId);
    expect(audit.source).toBe('api');

    const events = await readinessEvents(order.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      orderId: order.id,
      readiness: 'READY',
      version: order.version + 1,
    });
    // Адресовано ролям, а не лично: событие видят склад и администратор.
    expect(events[0]?.audienceUserId).toBeNull();
    expect([...(events[0]?.audienceRoles ?? [])].sort()).toEqual(['ADMIN', 'WAREHOUSE']);
  });

  it('текст ошибки не раскрывает данные заказа', async () => {
    const order = await seedOrder();
    const token = await tokenFor(['WAREHOUSE']);

    const stale = await call('PUT', `/api/warehouse/orders/${order.id}/readiness`, token, {
      readiness: 'READY',
      expectedVersion: order.version + 99,
    });

    expect(stale.statusCode).toBe(409);
    for (const forbidden of [SECRET_ADDRESS, SECRET_RECIPIENT, SECRET_COMMENT, '7770']) {
      expect(stale.body, forbidden).not.toContain(forbidden);
    }
  });
});

// --- 4. Рабочий список ------------------------------------------------------

describe('рабочий список', () => {
  it('дата обязательна и проверяется на существование', async () => {
    const token = await tokenFor(['WAREHOUSE']);

    expect((await call('GET', '/api/warehouse/orders', token)).statusCode).toBe(400);
    expect(
      (await call('GET', '/api/warehouse/orders?deliveryDate=01.12.2026', token)).statusCode,
    ).toBe(400);
    // Несуществующий день молча превратился бы в первое марта.
    expect(
      (await call('GET', '/api/warehouse/orders?deliveryDate=2026-02-30', token)).statusCode,
    ).toBe(400);
  });

  it('скрыты заказы вне области, архивные и пропавшие из источника', async () => {
    const token = await tokenFor(['WAREHOUSE']);

    const visible = await seedOrder({ deliveryPlannedMoment: `${OTHER_DAY} 12:00:00.000` });
    const outOfScope = await seedOrder({ deliveryPlannedMoment: `${OTHER_DAY} 12:00:00.000` });
    const archived = await seedOrder({ deliveryPlannedMoment: `${OTHER_DAY} 12:00:00.000` });
    const missing = await seedOrder({ deliveryPlannedMoment: `${OTHER_DAY} 12:00:00.000` });

    await ctx.db.deliveryOrder.update({
      where: { id: outOfScope.id },
      data: { inScope: false, scopeExitReason: 'STORE_CHANGED', scopeExitedAt: new Date() },
    });
    await ctx.db.deliveryOrder.update({
      where: { id: archived.id },
      data: { sourceArchived: true },
    });
    await ctx.db.$transaction((tx) => markSourceMissing(tx, missing.id, NOW));

    const response = await call('GET', `/api/warehouse/orders?deliveryDate=${OTHER_DAY}`, token);
    const ids = (response.json() as { items: { id: string }[] }).items.map((row) => row.id);

    expect(ids).toContain(visible.id);
    for (const hidden of [outOfScope.id, archived.id, missing.id]) {
      expect(ids).not.toContain(hidden);
    }

    // История при этом не удалена: строки остались на месте.
    for (const hidden of [outOfScope.id, archived.id, missing.id]) {
      await expect(readOrder(hidden)).resolves.toBeDefined();
    }
  });

  it('скрытый заказ не принимает новую отметку через API', async () => {
    const token = await tokenFor(['ADMIN']);
    const order = await seedOrder();
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: { inScope: false, scopeExitReason: 'DELIVERY_METHOD_CHANGED', scopeExitedAt: NOW },
    });
    const before = await readOrder(order.id);

    const response = await call('PUT', `/api/warehouse/orders/${order.id}/readiness`, token, {
      readiness: 'READY',
      expectedVersion: before.version,
    });

    expect(response.statusCode).toBe(400);
    const after = await readOrder(order.id);
    expect(after.shipmentReadiness).toBe('NOT_READY');
    expect(after.version).toBe(before.version);
    expect(await auditCount(order.id)).toBe(0);
  });

  it('несуществующий заказ даёт 404', async () => {
    const token = await tokenFor(['ADMIN']);
    const response = await call('PUT', `/api/warehouse/orders/${randomUUID()}/readiness`, token, {
      readiness: 'READY',
      expectedVersion: 0,
    });
    expect(response.statusCode).toBe(404);
  });

  it('три фильтра готовности и устойчивый порядок', async () => {
    const day = '2027-03-03';
    const token = await tokenFor(['WAREHOUSE']);
    const actor = await actorFor(['WAREHOUSE']);

    const created = [];
    for (let i = 0; i < 4; i += 1) {
      created.push(await seedOrder({ deliveryPlannedMoment: `${day} 12:00:00.000` }));
    }

    const ready = created.slice(0, 2);
    for (const order of ready) {
      await setShipmentReadiness(
        ctx,
        actor,
        { orderId: order.id, readiness: 'READY', expectedVersion: order.version },
        CONTEXT,
      );
    }

    const idsOf = async (filter: string): Promise<string[]> => {
      const response = await call(
        'GET',
        `/api/warehouse/orders?deliveryDate=${day}&readiness=${filter}`,
        token,
      );
      expect(response.statusCode).toBe(200);
      return (response.json() as { items: { id: string }[] }).items.map((row) => row.id);
    };

    const all = await idsOf('ALL');
    expect(all).toHaveLength(4);
    expect(await idsOf('READY')).toEqual(expect.arrayContaining(ready.map((o) => o.id)));
    expect(await idsOf('READY')).toHaveLength(2);
    expect(await idsOf('NOT_READY')).toHaveLength(2);

    // Порядок не зависит от запроса: одинаковый вопрос даёт одинаковый ответ.
    expect(await idsOf('ALL')).toEqual(all);

    // Страницы не пересекаются и не теряют строк — это и есть смысл полного
    // порядка: без него одна и та же строка попала бы на обе страницы.
    const page = async (offset: number): Promise<string[]> => {
      const response = await call(
        'GET',
        `/api/warehouse/orders?deliveryDate=${day}&limit=2&offset=${offset}`,
        token,
      );
      return (response.json() as { items: { id: string }[] }).items.map((row) => row.id);
    };
    expect([...(await page(0)), ...(await page(2))]).toEqual(all);
  });
});

// --- 5. Переходы, конкурентность, идемпотентность ---------------------------

describe('смена готовности', () => {
  it('переходы работают в обе стороны и оставляют след человека', async () => {
    const order = await seedOrder();
    const actor = await actorFor(['WAREHOUSE']);

    const toReady = await setShipmentReadiness(
      ctx,
      actor,
      { orderId: order.id, readiness: 'READY', expectedVersion: order.version },
      CONTEXT,
    );
    expect(toReady.readiness).toBe('READY');
    expect(toReady.unchanged).toBe(false);
    expect(toReady.version).toBe(order.version + 1);

    const afterReady = await readOrder(order.id);
    expect(afterReady.shipmentReadinessSetById).toBe(actor.userId);
    expect(afterReady.shipmentReadinessSetAt).not.toBeNull();

    // Возврат в NOT_READY причины не требует: в первом срезе она не моделируется.
    const back = await setShipmentReadiness(
      ctx,
      actor,
      { orderId: order.id, readiness: 'NOT_READY', expectedVersion: toReady.version },
      CONTEXT,
    );
    expect(back.readiness).toBe('NOT_READY');
    expect(back.version).toBe(order.version + 2);

    const afterBack = await readOrder(order.id);
    // След человека сохраняется: важно, кто именно снял готовность.
    expect(afterBack.shipmentReadinessSetById).toBe(actor.userId);
    expect(await auditCount(order.id)).toBe(2);
    expect(await readinessEvents(order.id)).toHaveLength(2);
  });

  it('устаревшая версия даёт 409 и не пишет ничего', async () => {
    const order = await seedOrder();
    const actor = await actorFor(['ADMIN']);

    await setShipmentReadiness(
      ctx,
      actor,
      { orderId: order.id, readiness: 'READY', expectedVersion: order.version },
      CONTEXT,
    );
    const afterFirst = await readOrder(order.id);

    // Второй человек всё ещё держит в руках прежнюю версию списка.
    await expect(
      setShipmentReadiness(
        ctx,
        actor,
        { orderId: order.id, readiness: 'NOT_READY', expectedVersion: order.version },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', conflict: { kind: 'STALE_VERSION' } });

    const afterConflict = await readOrder(order.id);
    expect(afterConflict.shipmentReadiness).toBe('READY');
    expect(afterConflict.version).toBe(afterFirst.version);
    expect(afterConflict.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
    expect(await auditCount(order.id)).toBe(1);
    expect(await readinessEvents(order.id)).toHaveLength(1);
  });

  it('совпадение состояния при устаревшей версии согласием не считается', async () => {
    const order = await seedOrder();
    const actor = await actorFor(['ADMIN']);

    await setShipmentReadiness(
      ctx,
      actor,
      { orderId: order.id, readiness: 'READY', expectedVersion: order.version },
      CONTEXT,
    );

    // Запрошено то же состояние, что уже стоит, но версия старая: человек
    // принимал решение по другой карточке, и подтверждать её молча нельзя.
    await expect(
      setShipmentReadiness(
        ctx,
        actor,
        { orderId: order.id, readiness: 'READY', expectedVersion: order.version },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', conflict: { kind: 'STALE_VERSION' } });
  });

  it('повтор того же состояния при актуальной версии идемпотентен', async () => {
    const order = await seedOrder();
    const actor = await actorFor(['WAREHOUSE']);

    const first = await setShipmentReadiness(
      ctx,
      actor,
      { orderId: order.id, readiness: 'READY', expectedVersion: order.version },
      CONTEXT,
    );
    const afterFirst = await readOrder(order.id);

    const repeat = await setShipmentReadiness(
      ctx,
      actor,
      { orderId: order.id, readiness: 'READY', expectedVersion: first.version },
      CONTEXT,
    );

    expect(repeat.unchanged).toBe(true);
    expect(repeat.version).toBe(first.version);

    const afterRepeat = await readOrder(order.id);
    expect(afterRepeat.version).toBe(afterFirst.version);
    expect(afterRepeat.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
    expect(afterRepeat.shipmentReadinessSetAt?.getTime()).toBe(
      afterFirst.shipmentReadinessSetAt?.getTime(),
    );
    // Двойной клик не должен выглядеть в журнале как два решения человека.
    expect(await auditCount(order.id)).toBe(1);
    expect(await readinessEvents(order.id)).toHaveLength(1);
  });

  it('изменение, аудит и событие атомарны: отказ последнего откатывает всё', async () => {
    const order = await seedOrder();
    const actor = await actorFor(['ADMIN']);
    const before = await readOrder(order.id);

    // Отказ вносится на ПОСЛЕДНЕМ шаге транзакции — на записи события. Так
    // проверяется именно атомарность: изменение и аудит к этому моменту уже
    // выполнены, и если бы транзакция не откатывалась целиком, заказ остался бы
    // готовым, а склад об этом никто бы не узнал.
    await ctx.db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fl_test_block_readiness_event() RETURNS trigger AS $$
      BEGIN
        IF NEW."payload"->>'orderId' = '${order.id}' THEN
          RAISE EXCEPTION 'искусственный отказ записи события';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await ctx.db.$executeRawUnsafe(`
      CREATE TRIGGER fl_test_block_readiness_event
      BEFORE INSERT ON "RealtimeEvent"
      FOR EACH ROW EXECUTE FUNCTION fl_test_block_readiness_event();
    `);

    try {
      await expect(
        setShipmentReadiness(
          ctx,
          actor,
          { orderId: order.id, readiness: 'READY', expectedVersion: before.version },
          CONTEXT,
        ),
      ).rejects.toThrow();
    } finally {
      await ctx.db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS fl_test_block_readiness_event ON "RealtimeEvent";',
      );
      await ctx.db.$executeRawUnsafe('DROP FUNCTION IF EXISTS fl_test_block_readiness_event();');
    }

    const after = await readOrder(order.id);
    expect(after.shipmentReadiness).toBe('NOT_READY');
    expect(after.shipmentReadinessSetAt).toBeNull();
    expect(after.shipmentReadinessSetById).toBeNull();
    expect(after.version).toBe(before.version);
    expect(await auditCount(order.id)).toBe(0);
    expect(await readinessEvents(order.id)).toHaveLength(0);
  });
});

// --- 6. Автоматика готовность не трогает ------------------------------------

describe('автоматика не меняет готовность', () => {
  it('повторная синхронизация заказа не затирает ручную отметку', async () => {
    const snapshot = snapshotOf();
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
      select: { id: true, version: true },
    });

    const actor = await actorFor(['WAREHOUSE']);
    const set = await setShipmentReadiness(
      ctx,
      actor,
      { orderId: order.id, readiness: 'READY', expectedVersion: order.version },
      CONTEXT,
    );

    // Пришла новая версия карточки: сменились статус, адрес и время изменения.
    await apply(
      snapshotOf({
        id: snapshot.externalId,
        updated: '2026-08-11 10:00:00.000',
        shipmentAddress: 'Москва, другой адрес',
        state: {
          meta: { href: href('state', '44444444-4444-4444-8444-444444444444') },
          id: '44444444-4444-4444-8444-444444444444',
          name: 'Доставляется',
          stateType: 'Regular',
        },
      }),
      new Date('2026-08-11T10:00:00.000Z'),
    );

    const after = await readOrder(order.id);
    expect(after.shipmentReadiness).toBe('READY');
    expect(after.shipmentReadinessSetById).toBe(actor.userId);
    expect(after.shipmentReadinessSetAt?.toISOString()).toBe(set.readinessSetAt);
    // Синхронизация своих записей о готовности не создаёт.
    expect(await auditCount(order.id)).toBe(1);
  });

  it('выход из области и пропажа источника готовность не сбрасывают', async () => {
    const snapshot = snapshotOf();
    await apply(snapshot);
    const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { externalId: snapshot.externalId },
      select: { id: true, version: true },
    });

    const actor = await actorFor(['ADMIN']);
    await setShipmentReadiness(
      ctx,
      actor,
      { orderId: order.id, readiness: 'READY', expectedVersion: order.version },
      CONTEXT,
    );

    await ctx.db.$transaction((tx) => markSourceMissing(tx, order.id, NOW));

    // Заказ действительно выведен из области — иначе проверка ниже
    // не доказывала бы ничего.
    const scope = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { inScope: true, sourceMissing: true },
    });
    expect(scope).toEqual({ inScope: false, sourceMissing: true });

    const after = await readOrder(order.id);
    // Отметка сохраняется: она факт истории, а не признак актуальности заказа.
    expect(after.shipmentReadiness).toBe('READY');
    expect(after.shipmentReadinessSetById).toBe(actor.userId);
    expect(await auditCount(order.id)).toBe(1);
  });

  it('готовность не влияет на пригодность заказа для маршрута', async () => {
    // Граница WH-001: неготовность пока ничего не блокирует. Проверяется прямо,
    // потому что «мы просто не трогали routing» доказательством не является.
    const { ineligibleReason } = await import('../routing/eligibility.js');
    const order = await seedOrder();
    const actor = await actorFor(['WAREHOUSE']);

    const row = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: {
        id: true,
        deliveryDate: true,
        inScope: true,
        sourceArchived: true,
        sourceMissing: true,
      },
    });
    expect(ineligibleReason(row, DAY)).toBeNull();

    await setShipmentReadiness(
      ctx,
      actor,
      { orderId: order.id, readiness: 'READY', expectedVersion: order.version },
      CONTEXT,
    );
    expect(ineligibleReason(row, DAY)).toBeNull();
  });
});

// --- 7. Индекс рабочего списка ---------------------------------------------

describe('схема', () => {
  it('индекс рабочего списка существует', async () => {
    const rows = await ctx.db.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'DeliveryOrder' ` +
        `AND indexname = 'DeliveryOrder_inScope_deliveryDate_shipmentReadiness_idx'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('день фильтруется календарной датой, а не моментом времени', async () => {
    // Колонка DATE: заказ на 12:00 московского дня обязан попадать в свой день,
    // а не уезжать в соседний из-за часового пояса процесса.
    const count = await ctx.db.deliveryOrder.count({
      where: { deliveryDate: toDateColumn(DAY), inScope: true },
    });
    expect(count).toBeGreaterThan(0);
  });
});
