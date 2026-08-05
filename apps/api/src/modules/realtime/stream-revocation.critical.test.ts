/**
 * Критические проверки немедленного отзыва realtime-сессии.
 *
 * Открытый канал обязан перестать работать сразу, как только сессия перестала
 * быть действительной, и обязан выдавать события по АКТУАЛЬНЫМ правам, а не по
 * тем, что были в момент подключения. Отдельно проверяется, что сбой базы
 * в фоновом проходе не роняет процесс.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import type { Database } from '../../platform/db.js';
import { publishRealtimeEvent } from './events.js';
import { VISIBILITY_LAG_MS } from './reader.js';
import { startEventStream, type StreamWriter } from './routes.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

/** Приёмник, запоминающий всё записанное: позволяет проверить поток без сети. */
function recordingWriter(): StreamWriter & { chunks: string[]; ended: boolean } {
  const state = {
    chunks: [] as string[],
    ended: false,
    write(chunk: string) {
      state.chunks.push(chunk);
    },
    end() {
      state.ended = true;
    },
    onClose() {
      // Соединения нет: закрывать нечего.
    },
  };
  return state;
}

/** Слушатель сигналов, который ничего не делает: проходы идут по таймеру. */
const silentNotifier = {
  subscribe: () => () => undefined,
  start: () => undefined,
  stop: async () => undefined,
};

async function seedSession(userId: string): Promise<string> {
  const familyId = randomUUID();
  await ctx.db.refreshSession.create({
    data: { userId, familyId, tokenHash: `test-${randomUUID()}` },
  });
  return familyId;
}

async function currentMaxId(): Promise<bigint> {
  const row = await ctx.db.realtimeEvent.findFirst({
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  return row?.id ?? 0n;
}

/** Ждёт, пока условие выполнится: проходы потока асинхронны. */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('условие не выполнилось за отведённое время');
}

describe('актуальность прав в открытом потоке', () => {
  it('после снятия привилегированной роли события по старым правам не приходят', async () => {
    const user = await seedUser(ctx.db, { roles: ['ADMIN', 'COURIER'] });
    const familyId = await seedSession(user.id);
    const cursor = await currentMaxId();
    const writer = recordingWriter();

    const stream = startEventStream(
      { db: ctx.db, config: ctx.config, notifier: silentNotifier },
      { userId: user.id, familyId, sessionVersion: 0 },
      cursor,
      writer,
      { heartbeat: 60_000, poll: 50 },
    );

    try {
      // Роль ADMIN снимается ПОСЛЕ подключения: токен канала всё ещё описывает
      // прежний доступ, поэтому права обязаны перечитываться из базы.
      await ctx.db.userRoleAssignment.delete({
        where: { userId_role: { userId: user.id, role: 'ADMIN' } },
      });

      await ctx.db.$transaction(async (tx) => {
        await publishRealtimeEvent(tx, {
          topic: 'user.updated',
          payload: { marker: 'admin-only' },
          audienceRoles: ['ADMIN'],
        });
        await publishRealtimeEvent(tx, {
          topic: 'user.updated',
          payload: { marker: 'courier-visible' },
          audienceRoles: ['COURIER'],
        });
      });

      // Событиям нужно «отстояться» дольше окна видимости.
      await new Promise((resolve) => setTimeout(resolve, VISIBILITY_LAG_MS + 300));
      await waitFor(() => writer.chunks.join('').includes('courier-visible'));

      const written = writer.chunks.join('');
      expect(written).toContain('courier-visible');
      expect(written).not.toContain('admin-only');
    } finally {
      stream.stop();
    }
  });

  it('заморозка закрывает канал до выдачи новых событий', async () => {
    const user = await seedUser(ctx.db, { roles: ['COURIER'] });
    const familyId = await seedSession(user.id);
    const cursor = await currentMaxId();
    const writer = recordingWriter();

    const stream = startEventStream(
      { db: ctx.db, config: ctx.config, notifier: silentNotifier },
      { userId: user.id, familyId, sessionVersion: 0 },
      cursor,
      writer,
      { heartbeat: 60_000, poll: 50 },
    );

    try {
      await ctx.db.user.update({ where: { id: user.id }, data: { status: 'FROZEN' } });

      await ctx.db.$transaction(async (tx) =>
        publishRealtimeEvent(tx, {
          topic: 'user.updated',
          payload: { marker: 'after-freeze' },
          audienceRoles: ['COURIER'],
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, VISIBILITY_LAG_MS + 300));
      await waitFor(() => writer.ended);

      const written = writer.chunks.join('');
      expect(written).toContain('session-closed');
      // Ни одно новое событие не ушло клиенту: канал закрылся раньше.
      expect(written).not.toContain('after-freeze');
    } finally {
      stream.stop();
    }
  });
});

describe('устойчивость фоновых проходов', () => {
  it('временная ошибка базы не создаёт необработанный rejection и не рвёт поток', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);

    let calls = 0;
    // Первые проходы падают, дальше база «оживает».
    const flakyDb = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        calls += 1;
        if (calls <= 3) {
          throw new Error('соединение с базой временно недоступно');
        }
        return fn({});
      },
    } as unknown as Database;

    const writer = recordingWriter();
    const stream = startEventStream(
      { db: flakyDb, config: ctx.config, notifier: silentNotifier },
      { userId: randomUUID(), familyId: randomUUID(), sessionVersion: 0 },
      0n,
      writer,
      { heartbeat: 60_000, poll: 30 },
    );

    try {
      await waitFor(() => calls >= 3);
      // Микрозадачам нужно дать завершиться, иначе rejection ещё не всплыл бы.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(rejections).toHaveLength(0);
      // Поток не закрыт: следующий проход повторит попытку.
      expect(writer.ended).toBe(false);
    } finally {
      stream.stop();
      process.off('unhandledRejection', onRejection);
    }
  });
});
