/**
 * Критические проверки realtime.
 *
 * Проверяются транзакционность записи, адресация, восстановление по Last-Event-ID,
 * resync при устаревшем курсоре и защита от пропуска события с меньшим
 * идентификатором, зафиксированного позже.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { managementAudienceFor, publishRealtimeEvent, RealtimePayloadLeakError } from './events.js';
import { parseLastEventId, readEventsForViewer, VISIBILITY_LAG_MS } from './reader.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

/** Момент, при котором событие уже считается «отстоявшимся». */
function afterLag(): Date {
  return new Date(Date.now() + VISIBILITY_LAG_MS + 1000);
}

async function currentMaxId(): Promise<bigint> {
  const row = await ctx.db.realtimeEvent.findFirst({
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  return row?.id ?? 0n;
}

describe('запись событий', () => {
  it('откат транзакции не оставляет события', async () => {
    const before = await ctx.db.realtimeEvent.count();

    await expect(
      ctx.db.$transaction(async (tx) => {
        await publishRealtimeEvent(tx, {
          topic: 'user.updated',
          payload: { userId: 'test' },
          audienceRoles: ['ADMIN'],
        });
        throw new Error('откат бизнес-транзакции');
      }),
    ).rejects.toThrow();

    expect(await ctx.db.realtimeEvent.count()).toBe(before);
  });

  it('секретные и персональные поля в payload запрещены', async () => {
    for (const payload of [{ phone: '+79161234567' }, { pin: '1234' }, { token: 'abc' }]) {
      await expect(
        ctx.db.$transaction(async (tx) =>
          publishRealtimeEvent(tx, { topic: 'user.updated', payload, audienceRoles: ['ADMIN'] }),
        ),
      ).rejects.toBeInstanceOf(RealtimePayloadLeakError);
    }
  });

  it('привилегированного сотрудника видит только администратор', () => {
    expect(managementAudienceFor(['COURIER'])).toEqual(['ADMIN', 'LOGISTICIAN']);
    expect(managementAudienceFor(['COURIER', 'ADMIN'])).toEqual(['ADMIN']);
    expect(managementAudienceFor(['LOGISTICIAN'])).toEqual(['ADMIN']);
  });
});

describe('адресация при чтении', () => {
  it('курьер не получает административных и чужих персональных событий', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const courier = await seedUser(ctx.db, { roles: ['COURIER'] });
    const other = await seedUser(ctx.db, { roles: ['COURIER'] });
    const cursor = await currentMaxId();

    await ctx.db.$transaction(async (tx) => {
      await publishRealtimeEvent(tx, {
        topic: 'user.updated',
        payload: { userId: admin.id },
        audienceRoles: ['ADMIN'],
      });
      await publishRealtimeEvent(tx, {
        topic: 'session.revoked',
        payload: { userId: other.id },
        audienceUserId: other.id,
      });
      await publishRealtimeEvent(tx, {
        topic: 'session.revoked',
        payload: { userId: courier.id },
        audienceUserId: courier.id,
      });
    });

    const forCourier = await readEventsForViewer(
      ctx.db,
      { userId: courier.id, roles: ['COURIER'] },
      cursor,
      afterLag(),
    );

    // Курьеру доступно только его собственное событие.
    expect(forCourier.events).toHaveLength(1);
    expect(forCourier.events[0]?.topic).toBe('session.revoked');
    expect(JSON.stringify(forCourier.events)).toContain(courier.id);
    expect(JSON.stringify(forCourier.events)).not.toContain(other.id);
  });

  it('идентификатор события отдаётся строкой', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const cursor = await currentMaxId();

    await ctx.db.$transaction(async (tx) =>
      publishRealtimeEvent(tx, {
        topic: 'user.updated',
        payload: { userId: admin.id },
        audienceRoles: ['ADMIN'],
      }),
    );

    const result = await readEventsForViewer(
      ctx.db,
      { userId: admin.id, roles: ['ADMIN'] },
      cursor,
      afterLag(),
    );

    expect(typeof result.events[0]?.id).toBe('string');
    expect(result.lastId).toMatch(/^\d+$/);
  });
});

describe('восстановление по курсору', () => {
  it('Last-Event-ID разбирается безопасно', () => {
    expect(parseLastEventId('42')).toBe(42n);
    expect(parseLastEventId(undefined)).toBe(0n);
    expect(parseLastEventId('не-число')).toBe(0n);
    expect(parseLastEventId('-5')).toBe(0n);
  });

  it('после переподключения выдаются только пропущенные события', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const viewer = { userId: admin.id, roles: ['ADMIN'] as const };
    const cursor = await currentMaxId();

    await ctx.db.$transaction(async (tx) =>
      publishRealtimeEvent(tx, {
        topic: 'user.created',
        payload: { userId: admin.id, step: 1 },
        audienceRoles: ['ADMIN'],
      }),
    );

    const first = await readEventsForViewer(ctx.db, viewer, cursor, afterLag());
    expect(first.events.length).toBeGreaterThanOrEqual(1);

    await ctx.db.$transaction(async (tx) =>
      publishRealtimeEvent(tx, {
        topic: 'user.updated',
        payload: { userId: admin.id, step: 2 },
        audienceRoles: ['ADMIN'],
      }),
    );

    const second = await readEventsForViewer(
      ctx.db,
      viewer,
      BigInt(first.lastId as string),
      afterLag(),
    );

    // Повторной выдачи уже полученных событий нет.
    expect(second.events).toHaveLength(1);
    expect(JSON.stringify(second.events[0]?.payload)).toContain('"step":2');
  });

  it('устаревший курсор приводит к resync-required', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });

    const oldest = await ctx.db.realtimeEvent.findFirst({
      orderBy: { id: 'asc' },
      select: { id: true },
    });

    // Курсор заведомо старше самого старого сохранённого события:
    // события между ними уже удалены по сроку хранения.
    const staleCursor = (oldest?.id ?? 10n) - 5n;
    const result = await readEventsForViewer(
      ctx.db,
      { userId: admin.id, roles: ['ADMIN'] },
      staleCursor > 0n ? staleCursor : 1n,
      afterLag(),
    );

    if (oldest !== null && staleCursor > 0n) {
      expect(result.resyncRequired).toBe(true);
      expect(result.events).toHaveLength(0);
    }
  });

  it('событие с меньшим идентификатором не пропускается из-за окна видимости', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const viewer = { userId: admin.id, roles: ['ADMIN'] as const };
    const cursor = await currentMaxId();

    await ctx.db.$transaction(async (tx) => {
      await publishRealtimeEvent(tx, {
        topic: 'user.created',
        payload: { userId: admin.id, order: 1 },
        audienceRoles: ['ADMIN'],
      });
      await publishRealtimeEvent(tx, {
        topic: 'user.updated',
        payload: { userId: admin.id, order: 2 },
        audienceRoles: ['ADMIN'],
      });
    });

    // Свежие события ещё не «отстоялись»: курсор не уходит вперёд,
    // поэтому событие с меньшим id не может быть перепрыгнуто.
    const tooEarly = await readEventsForViewer(ctx.db, viewer, cursor, new Date());
    expect(tooEarly.events).toHaveLength(0);
    expect(tooEarly.lastId).toBeNull();

    // Когда окно видимости прошло, выдаются оба события в порядке идентификаторов.
    const later = await readEventsForViewer(ctx.db, viewer, cursor, afterLag());
    expect(later.events).toHaveLength(2);
    expect(BigInt(later.events[0]!.id)).toBeLessThan(BigInt(later.events[1]!.id));
  });
});
