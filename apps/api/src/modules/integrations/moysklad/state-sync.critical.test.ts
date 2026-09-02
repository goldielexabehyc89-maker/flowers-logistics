/**
 * Критические проверки передачи состояния заказа в МойСклад.
 *
 * Защищаемые свойства (часть задания «Безопасность синхронизации»):
 *
 *  * узкая запись — только смена `state`, тело без адресов и телефонов;
 *  * идемпотентность — повтор события и повтор доставки сообщения не пишут дважды;
 *  * порядок по заказу и запрет регресса — «Доставляется» после «Завершен»
 *    не откатывает статус;
 *  * 401/403 не повторяются бесконечно (сразу DEAD);
 *  * 429 и временные 5xx переживаются лимитером и повторяются;
 *  * выключенный флаг не делает ни одной реальной записи;
 *  * активация маршрута ставит «Доставляется» всем НЕотменённым заказам листа.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../../auth/testing/harness.js';
import { MoyskladClient, MoyskladError } from './client.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from './config.js';
import { toDateColumn } from './delivery-date.js';
import {
  PermanentOutboxError,
  processOutboxOnce,
  type OutboxHandler,
} from '../../outbox/worker.js';
import {
  createMoyskladOrderStateHandler,
  enqueueOrderStateSync,
  enqueueRouteActivatedStateSync,
  ORDER_STATE_TOPIC,
  type OrderStateTarget,
} from './state-sync.js';

let ctx: TestContext;
const logger = pino({ level: 'silent' });

beforeAll(async () => {
  ctx = await createTestContext();
  // Общая тестовая база: другие файлы через доменные события тоже кладут
  // сообщения в outbox. Здесь очередь состояния изолируется, чтобы глобальный
  // проход обрабатывал ровно свои сообщения, а не чужие.
  await ctx.db.outboxProcessedMessage.deleteMany({});
  await ctx.db.outboxMessage.deleteMany({});
  await ctx.db.orderMoyskladState.deleteMany({});
});

afterAll(async () => {
  await closeTestContext(ctx);
});

const TOKEN = 'test-token-not-a-secret';

interface RecordedRequest {
  method: string;
  url: string;
  body: string | null;
}

/** Подменный сервер: записывает обращения и отвечает по сценарию. */
function recordingFetch(responder: (req: RecordedRequest) => Response): {
  fetch: typeof globalThis.fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: RecordedRequest = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    requests.push(req);
    return responder(req);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

function okResponse(): Response {
  return new Response(JSON.stringify({ id: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function controlledClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number): Promise<void> => {
      now += ms;
    },
  };
}

function makeClient(fetchImpl: typeof globalThis.fetch, enabled: boolean): MoyskladClient {
  const clock = controlledClock();
  return new MoyskladClient({
    config: {
      baseUrl: MOYSKLAD_BASE_URL,
      token: TOKEN,
      ids: MOYSKLAD_IDS,
      orderStateSyncEnabled: enabled,
    },
    fetch: fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    // Существующий лимитер 2/1/30: два запроса в секунду, один одновременно,
    // с резервом окна — тот же, что у чтений.
    rateLimit: { maxRequestsPerSecond: 2, maxConcurrency: 1, reserveRequests: 30, maxRetries: 3 },
  });
}

function makeHandler(client: MoyskladClient, enabled: boolean): OutboxHandler {
  return createMoyskladOrderStateHandler({ db: ctx.db, client, logger, enabled });
}

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${seq}`;
}

async function seedOrder(): Promise<{ id: string; externalId: string }> {
  const externalId = randomUUID();
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId,
      externalName: unique('SS'),
      externalUpdated: new Date('2028-07-01T00:00:00.000Z'),
      deliveryDate: toDateColumn('2028-07-10'),
      address: 'Москва, секретная улица, дом 7, кв. 42',
      recipient: 'Иван Секретный',
      storeId: MOYSKLAD_IDS.store,
      deliveryMethodId: MOYSKLAD_IDS.deliveryMethodDelivery,
      inScope: true,
      fulfillmentInScope: true,
      sourceArchived: false,
      sourceMissing: false,
    },
    select: { id: true, externalId: true },
  });
  return order;
}

async function enqueue(
  orderId: string,
  target: OrderStateTarget,
  dedupeKey: string,
): Promise<void> {
  await ctx.db.$transaction((tx) => enqueueOrderStateSync(tx, { orderId, target, dedupeKey }));
}

/** Прямой вызов обработчика с синтетическим сообщением: точный контроль порядка. */
async function callHandler(
  handler: OutboxHandler,
  orderId: string,
  target: OrderStateTarget,
  seqNum: number,
): Promise<void> {
  await handler({
    id: randomUUID(),
    topic: ORDER_STATE_TOPIC,
    idempotencyKey: unique('key'),
    payload: { orderId, target, seq: seqNum },
    attempts: 0,
    maxAttempts: 10,
  });
}

async function appliedSeqOf(orderId: string): Promise<number | null> {
  const row = await ctx.db.orderMoyskladState.findUnique({
    where: { orderId },
    select: { appliedSeq: true },
  });
  return row?.appliedSeq ?? null;
}

describe('узкая запись состояния', () => {
  it('шлёт PUT customerorder только со ссылкой на состояние, без адреса и телефона', async () => {
    const order = await seedOrder();
    const { fetch, requests } = recordingFetch(() => okResponse());
    const handler = makeHandler(makeClient(fetch, true), true);

    const dk = unique('dk');
    await enqueue(order.id, 'delivering', dk);
    await processOutboxOnce({ db: ctx.db, logger, handlers: { [ORDER_STATE_TOPIC]: handler } });

    // Сообщение именно этого заказа обработано (общая очередь может содержать
    // и чужие — проверяем своё поимённо).
    const message = await ctx.db.outboxMessage.findFirstOrThrow({ where: { idempotencyKey: dk } });
    expect(message.status).toBe('DONE');
    const mine = requests.filter((r) => r.url.endsWith(order.externalId));
    expect(mine).toHaveLength(1);
    const req = mine[0]!;
    expect(req.method).toBe('PUT');
    expect(req.url).toBe(`${MOYSKLAD_BASE_URL}/entity/customerorder/${order.externalId}`);
    // Тело — ровно ссылка на состояние «Доставляется» и ничего больше.
    const parsed = JSON.parse(req.body ?? '{}');
    expect(parsed.state.meta.href).toContain(MOYSKLAD_IDS.states.delivering);
    expect(Object.keys(parsed)).toEqual(['state']);
    // Ни адреса, ни получателя в запросе быть не может.
    expect(req.body).not.toContain('секретная');
    expect(req.body).not.toContain('Секретный');
    expect(await appliedSeqOf(order.id)).toBe(1);
  });

  it('клиент отвергает произвольную запись и запись при выключенном флаге', async () => {
    const { fetch } = recordingFetch(() => okResponse());
    // Обычный send остаётся только на чтение — PUT недоступен ни при каком флаге.
    await expect(makeClient(fetch, true).send('PUT', '/entity/customerorder/x')).rejects.toThrow(
      MoyskladError,
    );
    // Именованная запись при выключенном флаге тоже отвергается.
    await expect(
      makeClient(fetch, false).putCustomerOrderState(randomUUID(), MOYSKLAD_IDS.states.delivering),
    ).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
  });
});

describe('идемпотентность и порядок', () => {
  it('повторная постановка того же события не создаёт второго сообщения', async () => {
    const order = await seedOrder();
    const key = unique('dk');
    await enqueue(order.id, 'delivering', key);
    await enqueue(order.id, 'delivering', key);
    const count = await ctx.db.outboxMessage.count({ where: { idempotencyKey: key } });
    expect(count).toBe(1);
  });

  it('повторная доставка сообщения не пишет в МойСклад дважды', async () => {
    const order = await seedOrder();
    const { fetch, requests } = recordingFetch(() => okResponse());
    const handler = makeHandler(makeClient(fetch, true), true);

    await callHandler(handler, order.id, 'delivering', 1);
    // Тот же номер события ещё раз: appliedSeq уже 1 — второй записи нет.
    await callHandler(handler, order.id, 'delivering', 1);

    expect(requests).toHaveLength(1);
    expect(await appliedSeqOf(order.id)).toBe(1);
  });

  it('«Доставляется» после «Завершен» не откатывает статус', async () => {
    const order = await seedOrder();
    const { fetch, requests } = recordingFetch(() => okResponse());
    const handler = makeHandler(makeClient(fetch, true), true);

    // Сначала применяется «Завершен» (номер 2), затем приходит устаревшая
    // «Доставляется» (номер 1) — например, залежавшийся повтор.
    await callHandler(handler, order.id, 'completed', 2);
    await callHandler(handler, order.id, 'delivering', 1);

    // Наружу ушёл только «Завершен»; регресса к «Доставляется» не было.
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!.body ?? '{}').state.meta.href).toContain(
      MOYSKLAD_IDS.states.completed,
    );
    expect(await appliedSeqOf(order.id)).toBe(2);
  });
});

describe('обработка отказов', () => {
  it('401 не повторяется бесконечно — сообщение сразу уходит в DEAD', async () => {
    const order = await seedOrder();
    const { fetch, requests } = recordingFetch(() => new Response('no', { status: 401 }));
    const handler = makeHandler(makeClient(fetch, true), true);

    const dk = unique('dk');
    await enqueue(order.id, 'delivering', dk);
    await processOutboxOnce({ db: ctx.db, logger, handlers: { [ORDER_STATE_TOPIC]: handler } });

    // Именно это сообщение сразу в DEAD — попытки не изнашиваются часами.
    const message = await ctx.db.outboxMessage.findFirstOrThrow({ where: { idempotencyKey: dk } });
    expect(message.status).toBe('DEAD');
    expect(message.attempts).toBe(1);
    // По этому заказу — ровно один запрос: без шторма повторов по негодному ключу.
    expect(requests.filter((r) => r.url.endsWith(order.externalId))).toHaveLength(1);
    expect(await appliedSeqOf(order.id)).toBe(0);
  });

  it('прямой вызов на 403 бросает PermanentOutboxError, а на 500 — обычную ошибку', async () => {
    const order = await seedOrder();

    const forbidden = makeHandler(
      makeClient(recordingFetch(() => new Response('no', { status: 403 })).fetch, true),
      true,
    );
    await expect(callHandler(forbidden, order.id, 'delivering', 1)).rejects.toBeInstanceOf(
      PermanentOutboxError,
    );

    const server = makeHandler(
      makeClient(recordingFetch(() => new Response('err', { status: 500 })).fetch, true),
      true,
    );
    // 5xx — повторяемая ошибка: НЕ PermanentOutboxError, значит outbox повторит.
    await expect(callHandler(server, order.id, 'delivering', 1)).rejects.not.toBeInstanceOf(
      PermanentOutboxError,
    );
    // Ни один отказ не продвинул состояние: строки состояния так и не появилось.
    expect(await appliedSeqOf(order.id)).toBeNull();
  });

  it('временный 5xx переживается лимитером и на повторе записывает', async () => {
    const order = await seedOrder();
    let calls = 0;
    const { fetch, requests } = recordingFetch(() => {
      calls += 1;
      return calls === 1 ? new Response('err', { status: 500 }) : okResponse();
    });
    const handler = makeHandler(makeClient(fetch, true), true);

    await callHandler(handler, order.id, 'completed', 1);

    // Клиентский лимитер сам повторил после 500 и записал со второй попытки.
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(await appliedSeqOf(order.id)).toBe(1);
  });
});

describe('выключенный флаг', () => {
  it('не делает ни одной реальной записи, но сливает сообщение', async () => {
    const order = await seedOrder();
    const { fetch, requests } = recordingFetch(() => okResponse());
    const handler = makeHandler(makeClient(fetch, false), false);

    const dk = unique('dk');
    await enqueue(order.id, 'delivering', dk);
    await processOutboxOnce({ db: ctx.db, logger, handlers: { [ORDER_STATE_TOPIC]: handler } });

    // Сообщение слито (DONE), но НИ ОДНОГО обращения к живому аккаунту не было.
    const message = await ctx.db.outboxMessage.findFirstOrThrow({ where: { idempotencyKey: dk } });
    expect(message.status).toBe('DONE');
    expect(requests).toHaveLength(0);
    // appliedSeq не двигается: включив флаг позже, ничего задним числом не дошлём.
    expect(await appliedSeqOf(order.id)).toBe(0);
  });
});

describe('активация маршрута ставит «Доставляется» всем едущим заказам', () => {
  it('ставит событие каждому неотменённому заказу листа и пропускает отменённый', async () => {
    const user = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const going1 = await seedOrder();
    const going2 = await seedOrder();
    const cancelled = await seedOrder();
    await ctx.db.deliveryOrder.update({
      where: { id: cancelled.id },
      // Признак и автор пишутся вместе: этого требует ограничение целостности.
      data: { cancelledByLogistAt: new Date(), cancelledByLogistById: user.id },
    });

    const route = await ctx.db.deliveryRoute.create({
      data: {
        number: unique('R'),
        deliveryDate: toDateColumn('2028-07-10'),
        state: 'ACTIVE',
        vehicleType: 'CAR',
        createdById: user.id,
      },
      select: { id: true },
    });
    let position = 0;
    for (const order of [going1, going2, cancelled]) {
      position += 1;
      await ctx.db.routeOrder.create({
        data: { routeId: route.id, orderId: order.id, position, addedById: user.id },
      });
    }

    await ctx.db.$transaction((tx) => enqueueRouteActivatedStateSync(tx, route.id));

    const messages = await ctx.db.outboxMessage.findMany({
      where: { topic: ORDER_STATE_TOPIC, idempotencyKey: { contains: `route:${route.id}:` } },
      select: { payload: true },
    });
    const orderIds = messages.map((m) => (m.payload as { orderId: string }).orderId);
    expect(orderIds).toContain(going1.id);
    expect(orderIds).toContain(going2.id);
    // Отменённый заказ «Доставляется» не получает: он никуда не едет.
    expect(orderIds).not.toContain(cancelled.id);
  });
});

describe('статус сборки: доставка/самовывоз и запрет регресса', () => {
  it('доставка → «Ожидает отправку», самовывоз → «Готов к самовывозу»', async () => {
    const order = await seedOrder();
    const { fetch, requests } = recordingFetch(() => okResponse());
    const handler = makeHandler(makeClient(fetch, true), true);

    await enqueue(order.id, 'awaiting_shipment', unique('dk'));
    await processOutboxOnce({ db: ctx.db, logger, handlers: { [ORDER_STATE_TOPIC]: handler } });
    let mine = requests.filter((r) => r.url.endsWith(order.externalId));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toContain(MOYSKLAD_IDS.states.awaitingShipment);

    const pickup = await seedOrder();
    await enqueue(pickup.id, 'ready_for_pickup', unique('dk'));
    await processOutboxOnce({ db: ctx.db, logger, handlers: { [ORDER_STATE_TOPIC]: handler } });
    mine = requests.filter((r) => r.url.endsWith(pickup.externalId));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toContain(MOYSKLAD_IDS.states.readyForPickup);
  });

  it('стадия сборки НЕ откатывает более позднюю «Доставляется» (пересборка после отгрузки)', async () => {
    const order = await seedOrder();
    const { fetch, requests } = recordingFetch(() => okResponse());
    const handler = makeHandler(makeClient(fetch, true), true);

    // Доставка применена (ранг 2, seq 1).
    await callHandler(handler, order.id, 'delivering', 1);
    // Пересборка шлёт «Ожидает отправку» ПОЗЖЕ (больший seq), но ранг ниже —
    // регресс запрещён: записи нет.
    await callHandler(handler, order.id, 'awaiting_shipment', 2);

    const mine = requests.filter((r) => r.url.endsWith(order.externalId));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toContain(MOYSKLAD_IDS.states.delivering);
    // Финал/отмена (ранг 3) применяется поверх доставки — регрессом не считается.
    await callHandler(handler, order.id, 'completed', 3);
    const after = requests.filter((r) => r.url.endsWith(order.externalId));
    expect(after).toHaveLength(2);
    expect(after[1]!.body).toContain(MOYSKLAD_IDS.states.completed);
  });

  it('повтор того же события сборки идемпотентен (одна запись)', async () => {
    const order = await seedOrder();
    const { fetch, requests } = recordingFetch(() => okResponse());
    const handler = makeHandler(makeClient(fetch, true), true);

    await callHandler(handler, order.id, 'awaiting_shipment', 1);
    await callHandler(handler, order.id, 'awaiting_shipment', 1); // повтор того же seq
    const mine = requests.filter((r) => r.url.endsWith(order.externalId));
    expect(mine).toHaveLength(1);
  });
});
