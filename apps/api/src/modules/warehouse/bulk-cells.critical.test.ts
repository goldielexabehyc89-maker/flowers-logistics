/**
 * Партия складских ячеек.
 *
 * Ячейку нельзя удалить — её можно только выключить. Поэтому сотня ошибочных
 * кодов остаётся в справочнике навсегда, и цена ошибки здесь выше, чем
 * у одиночного создания. Проверяется ровно то, из-за чего это происходит:
 *
 *  * предпросмотр показывает то, что произойдёт, — до того как оно произошло,
 *    и сам ничего не создаёт;
 *  * уже существующие коды видны явно и НЕ переписываются;
 *  * повторы внутри ввода и негодные строки названы, а не отброшены молча;
 *  * партия создаётся целиком или не создаётся вовсе;
 *  * предел партии не обходится ни диапазоном, ни списком;
 *  * повторная отправка и пересекающиеся партии не заводят дублей;
 *  * права ровно те же, что у одиночного создания, и проверяются сервером;
 *  * одиночное создание работает как прежде.
 *
 * ВЛАДЕНИЕ ДАТАМИ: заказы здесь не создаются, дат доставки нет.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from '../auth/testing/harness.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import type { Role } from '@fl/shared';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import {
  CELL_WRITE_ROLES,
  createStorageCell,
  createStorageCellBatch,
  previewStorageCellBatch,
  unknownOccupancy,
  type CellDeps,
} from './service.js';
import { MAX_BULK_CELLS, expandRange, parseBatch, splitList } from './bulk-cells.js';

let ctx: TestContext;
let cells: CellDeps;
const CONTEXT = { ip: null, userAgent: null };

beforeAll(async () => {
  ctx = await createTestContext();
  cells = { db: ctx.db, occupancy: unknownOccupancy };
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let sequence = 0;

/**
 * Префикс, не пересекающийся ни с чужими файлами набора, ни с соседней
 * проверкой в этом файле: справочник ячеек общий на всю базу.
 */
function uniquePrefix(): string {
  sequence += 1;
  return `BC${process.hrtime.bigint() % 1_000_000n}X${sequence}-`;
}

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return { userId: user.id, roles, familyId: randomUUID() } as AuthenticatedActor;
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

async function call(
  url: string,
  token: string | null,
  payload: unknown,
): Promise<{ statusCode: number; json: () => unknown }> {
  return ctx.app.inject({
    method: 'POST',
    url,
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    payload,
  });
}

/**
 * Отказ операции — и именно то сообщение, которое увидит человек.
 *
 * Внутренний текст ошибки на английском в интерфейс не попадает, поэтому
 * проверять его бессмысленно: он может измениться, ничего не изменив
 * для кладовщика. Проверяется `publicMessage`.
 */
async function refusalOf(action: () => unknown): Promise<string> {
  try {
    await action();
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(AppError);
    return (error as AppError).publicMessage ?? '';
  }
  throw new Error('ожидался отказ, но операция прошла');
}

/** Сколько ячеек с этим префиксом есть в справочнике. */
async function countWithPrefix(prefix: string): Promise<number> {
  return ctx.db.storageCell.count({
    where: { normalizedCode: { startsWith: prefix.toUpperCase() } },
  });
}

// --- Диапазон ---------------------------------------------------------------

describe('диапазон', () => {
  it('ведущие нули и включительные границы', () => {
    expect(expandRange({ prefix: 'A-', from: 1, to: 3, pad: 3 })).toEqual([
      'A-001',
      'A-002',
      'A-003',
    ]);

    // «От 1 до 100» человек понимает как сто полок, а не девяносто девять.
    expect(expandRange({ prefix: 'A-', from: 1, to: 100, pad: 3 })).toHaveLength(100);
    expect(expandRange({ prefix: 'A-', from: 7, to: 7, pad: 2 })).toEqual(['A-07']);
    // Ноль допустим: у стеллажа бывает нулевая полка.
    expect(expandRange({ prefix: 'S', from: 0, to: 2, pad: 1 })).toEqual(['S0', 'S1', 'S2']);
  });

  it('число длиннее заданной ширины не обрезается', () => {
    // Обрезание дало бы два разных номера с одинаковым написанием — и вторая
    // полка молча пропала бы из партии как «дубль».
    expect(expandRange({ prefix: 'A-', from: 99, to: 101, pad: 2 })).toEqual([
      'A-99',
      'A-100',
      'A-101',
    ]);
  });

  it('бессмысленный диапазон отвергается, а не достраивается', () => {
    for (const range of [
      { prefix: 'A-', from: 10, to: 1, pad: 3 },
      { prefix: 'A-', from: -1, to: 5, pad: 3 },
      { prefix: 'A-', from: 1, to: 5, pad: 0 },
      { prefix: 'A-', from: 1, to: 5, pad: 9 },
      { prefix: 'A-', from: 1.5, to: 5, pad: 3 },
    ]) {
      expect(() => expandRange(range), JSON.stringify(range)).toThrow(AppError);
    }
  });

  it('предел партии не обходится диапазоном', async () => {
    // Не «обрезано до 500», а отказ с названным числом: обрезанный диапазон
    // человек прочитал бы как выполненный.
    await expect(
      refusalOf(() => expandRange({ prefix: 'A-', from: 1, to: MAX_BULK_CELLS + 1, pad: 4 })),
    ).resolves.toMatch(/не больше 500/);
    expect(expandRange({ prefix: 'A-', from: 1, to: MAX_BULK_CELLS, pad: 4 })).toHaveLength(
      MAX_BULK_CELLS,
    );
  });
});

// --- Готовый список ---------------------------------------------------------

describe('готовый список', () => {
  it('строки, запятые и точки с запятой — всё разделители', () => {
    // Список вставляют из таблицы, из письма и из заметки; каждый источник
    // разделяет по-своему.
    expect(splitList('A-1\nA-2,A-3; A-4\r\nA-5')).toEqual(['A-1', 'A-2', 'A-3', 'A-4', 'A-5']);
  });

  it('пустые строки и края отбрасываются', () => {
    // Перевод строки в конце вставки не должен выглядеть ошибкой ввода.
    expect(splitList('  A-1  \n\n\n  A-2 \n')).toEqual(['A-1', 'A-2']);
    expect(splitList('   \n , ; \n ')).toEqual([]);
  });
});

// --- Разбор -----------------------------------------------------------------

/** Управляющий символ внутри кода: попадает вставкой из чужой системы. */
const CONTROL_CHARACTER_CODE = `A\u0001B`;

describe('разбор партии', () => {
  it('повторы внутри ввода названы, а не отброшены молча', () => {
    const parsed = parseBatch(['A-1', 'A-2', 'a-1', 'A-2']);

    // Нормализация та же, что у скана: «a-1» и «A-1» — одна и та же полка.
    expect(parsed.codes.map((item) => item.code)).toEqual(['A-1', 'A-2']);
    expect(parsed.duplicates).toEqual(['a-1', 'A-2']);
    expect(parsed.invalid).toEqual([]);
  });

  it('негодные строки названы, и у каждой есть причина', () => {
    const parsed = parseBatch(['A-1', 'X'.repeat(200), CONTROL_CHARACTER_CODE, '   ']);

    expect(parsed.codes.map((item) => item.code)).toEqual(['A-1']);
    expect(parsed.invalid.map((item) => item.input)).toEqual([
      'X'.repeat(200),
      CONTROL_CHARACTER_CODE,
      '   ',
    ]);
    for (const item of parsed.invalid) {
      expect(item.reason.length, item.input).toBeGreaterThan(0);
    }
  });
});

// --- Предпросмотр -----------------------------------------------------------

describe('предпросмотр показывает последствия заранее', () => {
  it('различает новые, существующие, повторы и негодные', async () => {
    const prefix = uniquePrefix();
    const admin = await actorFor(['ADMIN']);
    await createStorageCell(cells, admin, { code: `${prefix}001`, kind: 'STORAGE' }, CONTEXT);

    const preview = await previewStorageCellBatch(ctx.db, [
      `${prefix}001`, // уже существует
      `${prefix}002`, // будет создана
      `${prefix.toLowerCase()}002`, // повтор внутри ввода, другой регистр
      'Y'.repeat(200), // негодная строка
    ]);

    expect(preview.willCreate.map((item) => item.code)).toEqual([`${prefix}002`]);
    expect(preview.existing.map((item) => item.code)).toEqual([`${prefix}001`]);
    expect(preview.duplicates).toEqual([`${prefix.toLowerCase()}002`]);
    expect(preview.invalid).toHaveLength(1);
    expect(preview.total).toBe(2);
  });

  it('предпросмотр ничего не создаёт', async () => {
    const prefix = uniquePrefix();

    await previewStorageCellBatch(ctx.db, [`${prefix}001`, `${prefix}002`]);

    expect(await countWithPrefix(prefix)).toBe(0);
  });

  it('слишком большая партия отвергается и на предпросмотре', async () => {
    const prefix = uniquePrefix();
    const codes = Array.from({ length: MAX_BULK_CELLS + 1 }, (_, index) => `${prefix}${index}`);

    // Иначе человек увидел бы разрешающий предпросмотр и отказ при сохранении.
    await expect(refusalOf(() => previewStorageCellBatch(ctx.db, codes))).resolves.toMatch(
      /не больше 500/,
    );
  });
});

// --- Создание ---------------------------------------------------------------

describe('создание партии', () => {
  it('диапазон с ведущими нулями создаётся целиком', async () => {
    const prefix = uniquePrefix();
    const admin = await actorFor(['ADMIN']);

    const result = await createStorageCellBatch(
      cells,
      admin,
      { codes: expandRange({ prefix, from: 1, to: 10, pad: 3 }), kind: 'STORAGE' },
      CONTEXT,
    );

    expect(result).toEqual({ created: 10, skippedExisting: 0, duplicates: 0, invalid: 0 });

    const stored = await ctx.db.storageCell.findMany({
      where: { normalizedCode: { startsWith: prefix.toUpperCase() } },
      select: { code: true, kind: true, isActive: true, createdById: true },
      orderBy: { code: 'asc' },
    });
    expect(stored).toHaveLength(10);
    expect(stored[0]?.code).toBe(`${prefix}001`);
    expect(stored[9]?.code).toBe(`${prefix}010`);
    expect(stored.every((cell) => cell.kind === 'STORAGE')).toBe(true);
    expect(stored.every((cell) => cell.isActive)).toBe(true);
    expect(stored.every((cell) => cell.createdById === admin.userId)).toBe(true);
  });

  it('существующие коды пропускаются и НЕ переписываются', async () => {
    const prefix = uniquePrefix();
    const admin = await actorFor(['ADMIN']);
    const before = await createStorageCell(
      cells,
      admin,
      { code: `${prefix}001`, kind: 'ROUTE' },
      CONTEXT,
    );

    const result = await createStorageCellBatch(
      cells,
      admin,
      { codes: [`${prefix.toLowerCase()}001`, `${prefix}002`], kind: 'STORAGE' },
      CONTEXT,
    );

    expect(result.created).toBe(1);
    expect(result.skippedExisting).toBe(1);

    // Тип существующей полки не переписан: на ней висит наклейка, и менять её
    // физический смысл «заодно» с созданием соседних значило бы тихо
    // переставить ячейку из хранения в маршрутную.
    const kept = await ctx.db.storageCell.findUniqueOrThrow({
      where: { id: before.id },
      select: { code: true, kind: true, version: true },
    });
    expect(kept.kind).toBe('ROUTE');
    expect(kept.code).toBe(`${prefix}001`);
    expect(kept.version).toBe(before.version);
  });

  it('повторная отправка того же запроса не заводит дублей', async () => {
    const prefix = uniquePrefix();
    const admin = await actorFor(['ADMIN']);
    const codes = expandRange({ prefix, from: 1, to: 5, pad: 2 });

    const first = await createStorageCellBatch(cells, admin, { codes, kind: 'STORAGE' }, CONTEXT);
    const second = await createStorageCellBatch(cells, admin, { codes, kind: 'STORAGE' }, CONTEXT);

    expect(first.created).toBe(5);
    expect(second).toEqual({ created: 0, skippedExisting: 5, duplicates: 0, invalid: 0 });
    expect(await countWithPrefix(prefix)).toBe(5);
  });

  it('повторы и негодные строки внутри партии не мешают годным', async () => {
    const prefix = uniquePrefix();
    const admin = await actorFor(['ADMIN']);

    const result = await createStorageCellBatch(
      cells,
      admin,
      {
        codes: [`${prefix}001`, `${prefix}001`, 'Z'.repeat(200), `${prefix}002`],
        kind: 'STORAGE',
      },
      CONTEXT,
    );

    expect(result).toEqual({ created: 2, skippedExisting: 0, duplicates: 1, invalid: 1 });
    expect(await countWithPrefix(prefix)).toBe(2);
  });

  it('пустая партия отвергается, а не создаёт ноль ячеек молча', async () => {
    const admin = await actorFor(['ADMIN']);

    // Молчаливое «создано 0» человек прочитал бы как успех.
    await expect(
      createStorageCellBatch(cells, admin, { codes: ['   ', ''], kind: 'STORAGE' }, CONTEXT),
    ).rejects.toThrow(AppError);
  });

  it('предел партии не обходится списком', async () => {
    const prefix = uniquePrefix();
    const admin = await actorFor(['ADMIN']);
    const codes = Array.from({ length: MAX_BULK_CELLS + 1 }, (_, index) => `${prefix}${index}`);

    await expect(
      refusalOf(() => createStorageCellBatch(cells, admin, { codes, kind: 'STORAGE' }, CONTEXT)),
    ).resolves.toMatch(/не больше 500/);
    expect(await countWithPrefix(prefix)).toBe(0);
  });
});

// --- Целостность партии -----------------------------------------------------

/**
 * Тот же справочник, но запись ячейки ломается на заданном по счёту вызове.
 *
 * Сбой посреди партии — не выдумка: связь с базой рвётся, диск кончается,
 * соседняя транзакция держит блокировку. Проверяется именно откат, поэтому
 * ошибка вносится внутрь транзакции, а не перед ней.
 */
function breakingAfter(successes: number): CellDeps {
  let created = 0;

  /**
   * Клиент, у которого запись ячейки ломается на заданном по счёту вызове.
   *
   * Подмена ставится и на транзакционный клиент, и на обычный: иначе проверка
   * молчала бы ровно в том случае, ради которого написана, — если бы партия
   * однажды перестала создаваться одной транзакцией, подмена просто не
   * сработала бы, и отказ выглядел бы как «ошибки нет».
   */
  function breakable<T extends object>(client: T): T {
    return new Proxy(client, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;

        if (property === '$transaction') {
          return (handler: (tx: object) => Promise<unknown>) =>
            (value as (run: (tx: object) => Promise<unknown>) => Promise<unknown>).call(
              target,
              (tx) => handler(breakable(tx)),
            );
        }

        if (property !== 'storageCell') {
          return typeof value === 'function' ? value.bind(target) : value;
        }

        const model = value as Record<string, unknown>;
        return new Proxy(model, {
          get(modelTarget, modelProperty, modelReceiver) {
            const member = Reflect.get(modelTarget, modelProperty, modelReceiver) as unknown;
            if (modelProperty !== 'create') {
              return typeof member === 'function' ? member.bind(modelTarget) : member;
            }
            return async (args: unknown) => {
              created += 1;
              if (created > successes) {
                throw new Error('связь со справочником потеряна');
              }
              return (member as (input: unknown) => Promise<unknown>).call(modelTarget, args);
            };
          },
        });
      },
    });
  }

  return { db: breakable(ctx.db) as unknown as Database, occupancy: unknownOccupancy };
}

describe('партия целиком или ничего', () => {
  it('сбой на середине не оставляет частично созданной партии', async () => {
    const prefix = uniquePrefix();
    const admin = await actorFor(['ADMIN']);

    await expect(
      createStorageCellBatch(
        breakingAfter(3),
        admin,
        { codes: expandRange({ prefix, from: 1, to: 10, pad: 3 }), kind: 'STORAGE' },
        CONTEXT,
      ),
    ).rejects.toThrow('связь со справочником потеряна');

    // Половина стеллажа хуже, чем его отсутствие: человек не знает, с какого
    // места продолжать, а повторная попытка упёрлась бы в созданные коды.
    expect(await countWithPrefix(prefix)).toBe(0);

    // И журнал не сообщает о том, чего не произошло.
    expect(
      await ctx.db.auditLog.count({
        where: { action: 'STORAGE_CELL_CREATED', actorUserId: admin.userId },
      }),
    ).toBe(0);

    // Повтор здоровым путём проходит целиком.
    const retry = await createStorageCellBatch(
      cells,
      admin,
      { codes: expandRange({ prefix, from: 1, to: 10, pad: 3 }), kind: 'STORAGE' },
      CONTEXT,
    );
    expect(retry.created).toBe(10);
  });

  it('пересекающиеся партии не создают одну полку дважды', async () => {
    const prefix = uniquePrefix();
    const first = await actorFor(['ADMIN']);
    const second = await actorFor(['ADMIN']);

    const shared = expandRange({ prefix: `${prefix}S`, from: 1, to: 4, pad: 2 });
    const onlyFirst = expandRange({ prefix: `${prefix}A`, from: 1, to: 4, pad: 2 });
    const onlySecond = expandRange({ prefix: `${prefix}B`, from: 1, to: 4, pad: 2 });

    const outcomes = await Promise.allSettled([
      createStorageCellBatch(
        cells,
        first,
        { codes: [...onlyFirst, ...shared], kind: 'STORAGE' },
        CONTEXT,
      ),
      createStorageCellBatch(
        cells,
        second,
        { codes: [...shared, ...onlySecond], kind: 'STORAGE' },
        CONTEXT,
      ),
    ]);

    /*
     * Обе партии успеть не обязаны: отбор существующих идёт внутри транзакции,
     * и вторая может упереться в уникальность общих кодов. Требование другое —
     * что бы ни случилось, полка не задваивается, а отказавшая партия не
     * оставляет после себя ни одного своего кода.
     */
    const codes = await ctx.db.storageCell.findMany({
      where: { normalizedCode: { startsWith: prefix.toUpperCase() } },
      select: { normalizedCode: true },
    });
    expect(new Set(codes.map((cell) => cell.normalizedCode)).size).toBe(codes.length);
    expect(
      codes.filter((cell) => cell.normalizedCode.includes(`${prefix}S`.toUpperCase())),
    ).toHaveLength(shared.length);

    const exclusive = [onlyFirst, onlySecond];
    for (const [index, outcome] of outcomes.entries()) {
      const own = exclusive[index] ?? [];
      const present = await ctx.db.storageCell.count({
        where: { normalizedCode: { in: own.map((code) => code.toUpperCase()) } },
      });
      expect(present, `партия ${index}`).toBe(outcome.status === 'fulfilled' ? own.length : 0);
    }
  });
});

// --- Журнал и одиночное создание -------------------------------------------

describe('журнал и одиночное создание', () => {
  it('партия оставляет одну запись журнала — с количеством, без кодов', async () => {
    const prefix = uniquePrefix();
    const admin = await actorFor(['ADMIN']);
    const eventsBefore = await ctx.db.realtimeEvent.count({
      where: { topic: 'storage_cell.changed' },
    });

    await createStorageCellBatch(
      cells,
      admin,
      {
        codes: [...expandRange({ prefix, from: 1, to: 4, pad: 2 }), 'W'.repeat(200)],
        kind: 'ROUTE',
      },
      CONTEXT,
    );

    // Пятьсот отдельных строк утопили бы журнал и всё равно не ответили бы,
    // кто и когда завёл этот стеллаж.
    const entries = await ctx.db.auditLog.findMany({
      where: { action: 'STORAGE_CELL_CREATED', actorUserId: admin.userId },
      select: { entityType: true, entityId: true, newValue: true },
    });
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry?.entityType).toBe('StorageCell');
    expect(entry?.entityId).toBeNull();

    const value = entry?.newValue as Record<string, unknown>;
    expect(value['batch']).toBe(true);
    expect(value['kind']).toBe('ROUTE');
    expect(value['requested']).toBe(4);
    expect(value['created']).toBe(4);
    expect(value['skippedExisting']).toBe(0);

    // Кодов в записи нет: их видно в справочнике, а журнал читают все
    // административные экраны.
    expect(JSON.stringify(value)).not.toContain(prefix);

    /*
     * И событие на партию тоже одно.
     *
     * В рассылке изменения ячейки лежит только идентификатор — подписчик
     * перезапрашивает справочник целиком. Четыреста девяносто девять лишних
     * событий не изменили бы ни одного экрана, зато прошли бы через
     * `NOTIFY` внутри той же транзакции.
     */
    const events = await ctx.db.realtimeEvent.findMany({
      where: { topic: 'storage_cell.changed' },
      orderBy: { id: 'desc' },
      take: 1,
      select: { payload: true },
    });
    expect(await ctx.db.realtimeEvent.count({ where: { topic: 'storage_cell.changed' } })).toBe(
      eventsBefore + 1,
    );
    expect((events[0]?.payload as Record<string, unknown>)['created']).toBe(4);
  });

  it('одиночное создание работает как прежде', async () => {
    const prefix = uniquePrefix();
    const admin = await actorFor(['ADMIN']);

    const created = await createStorageCell(
      cells,
      admin,
      { code: `${prefix}ONE`, kind: 'STORAGE' },
      CONTEXT,
    );

    expect(created.code).toBe(`${prefix}ONE`);
    expect(created.kind).toBe('STORAGE');
    expect(created.isActive).toBe(true);

    // И по-прежнему отвергает повтор кода, отличающийся только регистром.
    await expect(
      createStorageCell(
        cells,
        admin,
        { code: `${prefix.toLowerCase()}one`, kind: 'STORAGE' },
        CONTEXT,
      ),
    ).rejects.toThrow();

    // Запись журнала у одиночного создания осталась поштучной и с кодом.
    const entry = await ctx.db.auditLog.findFirstOrThrow({
      where: { action: 'STORAGE_CELL_CREATED', actorUserId: admin.userId },
      orderBy: { id: 'desc' },
      select: { entityId: true, newValue: true },
    });
    expect(entry.entityId).toBe(created.id);
    expect((entry.newValue as Record<string, unknown>)['cellCode']).toBe(created.code);
  });
});

// --- Права ------------------------------------------------------------------

describe('права на партию', () => {
  it('список ролей тот же, что у одиночного создания', () => {
    expect([...CELL_WRITE_ROLES]).toEqual(['ADMIN']);
  });

  it('аноним и чужие роли не создают и не смотрят предпросмотр', async () => {
    const prefix = uniquePrefix();
    const body = { kind: 'STORAGE', range: { prefix, from: 1, to: 3, pad: 2 } };

    const strangers: (string | null)[] = [
      null,
      await tokenFor(['WAREHOUSE']),
      await tokenFor(['FLORIST']),
      await tokenFor(['COURIER']),
      await tokenFor(['LOGISTICIAN']),
    ];

    for (const token of strangers) {
      for (const url of ['/api/storage-cells/bulk/preview', '/api/storage-cells/bulk']) {
        const response = await call(url, token, body);
        // Спрятанная кнопка защитой не является: запрос отправляют и мимо
        // интерфейса. Решает сервер.
        expect([401, 403], `${url} ${token === null ? 'аноним' : 'роль'}`).toContain(
          response.statusCode,
        );
      }
    }

    expect(await countWithPrefix(prefix)).toBe(0);
  });

  it('администратор получает предпросмотр и создаёт партию', async () => {
    const prefix = uniquePrefix();
    const token = await tokenFor(['ADMIN']);
    const body = { kind: 'STORAGE', range: { prefix, from: 1, to: 3, pad: 2 } };

    const preview = await call('/api/storage-cells/bulk/preview', token, body);
    expect(preview.statusCode).toBe(200);
    expect((preview.json() as { total: number }).total).toBe(3);
    expect(await countWithPrefix(prefix)).toBe(0);

    const created = await call('/api/storage-cells/bulk', token, body);
    expect(created.statusCode).toBe(201);
    expect((created.json() as { created: number }).created).toBe(3);
    expect(await countWithPrefix(prefix)).toBe(3);
  });

  it('диапазон и вставленный список складываются в одну партию', async () => {
    const prefix = uniquePrefix();
    const token = await tokenFor(['ADMIN']);

    const response = await call('/api/storage-cells/bulk', token, {
      kind: 'STORAGE',
      range: { prefix, from: 1, to: 3, pad: 2 },
      list: `${prefix}90, ${prefix}91\n${prefix}03`,
    });

    expect(response.statusCode).toBe(201);
    // `${prefix}03` уже пришёл из диапазона — это повтор внутри ввода.
    expect(response.json()).toMatchObject({ created: 5, duplicates: 1, invalid: 0 });
    expect(await countWithPrefix(prefix)).toBe(5);
  });
});
