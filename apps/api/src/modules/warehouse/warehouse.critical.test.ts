/**
 * Критические проверки справочника складских ячеек (этап 6.4).
 *
 * Проверяется не «работает ли форма», а то, нарушение чего опасно: код ячейки
 * совпадает со сканом независимо от регистра, напечатанная этикетка не может
 * начать указывать на другую полку, ячейка не исчезает из истории, и тип
 * не меняется у ячейки, про которую неизвестно, пуста ли она.
 *
 * Инварианты проверяются и через сервис, и напрямую в базе: правило, которое
 * держится только кодом, однажды обойдут скриптом или консолью.
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
import { normalizeCellCode, MAX_CODE_LENGTH } from './cell-code.js';
import {
  changeStorageCellKind,
  createStorageCell,
  listStorageCells,
  resolveStorageCell,
  setStorageCellActive,
  unknownOccupancy,
  type CellDeps,
  type CellOccupancy,
} from './service.js';
import { encodeQrMatrix, dataModuleOrder, buildCodewords, renderCellLabelSvg } from './qr.js';

let ctx: TestContext;
let deps: CellDeps;
const CONTEXT = { ip: null, userAgent: null };

beforeAll(async () => {
  ctx = await createTestContext();
  deps = { db: ctx.db, occupancy: unknownOccupancy };
});

afterAll(async () => {
  await closeTestContext(ctx);
});

/** Ячейки не удаляются, поэтому каждый код уникален на весь прогон файла. */
let sequence = 0;
function uniqueCode(prefix = 'C'): string {
  sequence += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${sequence}`;
}

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return {
    userId: user.id,
    roles,
    familyId: '00000000-0000-4000-8000-000000000064',
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
  headers: Record<string, unknown>;
}

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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

async function seedCell(kind: 'STORAGE' | 'ROUTE' = 'STORAGE', code = uniqueCode()) {
  const actor = await actorFor(['ADMIN']);
  return createStorageCell(deps, actor, { code, kind }, CONTEXT);
}

async function auditCount(cellId: string): Promise<number> {
  return ctx.db.auditLog.count({ where: { entityType: 'StorageCell', entityId: cellId } });
}

async function cellEvents(cellId: string) {
  const rows = await ctx.db.realtimeEvent.findMany({
    where: { topic: 'storage_cell.changed' },
    select: { payload: true, audienceRoles: true, audienceUserId: true },
  });
  return rows.filter((row) => (row.payload as { cellId?: string }).cellId === cellId);
}

// --- 1. Код: форма, нормализация, точное разрешение скана --------------------

describe('код ячейки', () => {
  it('регистр и внешние пробелы не создают вторую полку', async () => {
    const code = uniqueCode('A');
    const created = await seedCell('STORAGE', code);

    for (const variant of [code.toLowerCase(), `  ${code}  `, ` ${code.toLowerCase()}\u00a0`]) {
      const actor = await actorFor(['ADMIN']);
      await expect(
        createStorageCell(deps, actor, { code: variant, kind: 'STORAGE' }, CONTEXT),
      ).rejects.toMatchObject({ code: 'CONFLICT', conflict: { kind: 'CELL_CODE_TAKEN' } });
    }

    // И скан любого из написаний находит РОВНО ту же ячейку.
    for (const scanned of [code, code.toLowerCase(), `  ${code} `]) {
      const resolved = await resolveStorageCell(ctx.db, scanned, { onlyActive: true });
      expect(resolved.id, scanned).toBe(created.id);
    }
  });

  it('исходное написание сохраняется для показа, сравнение идёт по верхнему регистру', async () => {
    const code = uniqueCode('mix').toLowerCase();
    const created = await seedCell('STORAGE', ` ${code} `);

    expect(created.code).toBe(code);
    expect(created.normalizedCode).toBe(code.toUpperCase());
  });

  it('пустой, слишком длинный и управляющий код отклоняются', () => {
    for (const bad of [
      '',
      '   ',
      '\u00a0',
      'A'.repeat(MAX_CODE_LENGTH + 1),
      'A\u0007B',
      'A\u200bB',
    ]) {
      expect(() => normalizeCellCode(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('неизвестный код не выбирает случайную ячейку', async () => {
    await seedCell();
    await expect(
      resolveStorageCell(ctx.db, uniqueCode('НЕТ'), { onlyActive: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('выключенная ячейка кладовщику не разрешается, администратору — да', async () => {
    const cell = await seedCell();
    const actor = await actorFor(['ADMIN']);
    await setStorageCellActive(
      deps,
      actor,
      cell.id,
      { isActive: false, expectedVersion: cell.version },
      CONTEXT,
    );

    await expect(resolveStorageCell(ctx.db, cell.code, { onlyActive: true })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );

    const forAdmin = await resolveStorageCell(ctx.db, cell.code, { onlyActive: false });
    expect(forAdmin.id).toBe(cell.id);
  });
});

// --- 2. Инварианты базы ------------------------------------------------------

describe('инварианты базы', () => {
  it('код неизменяем даже прямым запросом', async () => {
    const cell = await seedCell();

    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "StorageCell" SET "code" = 'ДРУГОЙ' WHERE "id" = '${cell.id}'::uuid`,
      ),
    ).rejects.toThrow();

    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "StorageCell" SET "normalizedCode" = 'ДРУГОЙ' WHERE "id" = '${cell.id}'::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('ячейка не удаляется ни через Prisma, ни прямым DELETE', async () => {
    const cell = await seedCell();

    await expect(ctx.db.storageCell.delete({ where: { id: cell.id } })).rejects.toThrow();
    await expect(
      ctx.db.$executeRawUnsafe(`DELETE FROM "StorageCell" WHERE "id" = '${cell.id}'::uuid`),
    ).rejects.toThrow();

    // И запись осталась на месте, а не «почти удалилась».
    await expect(
      ctx.db.storageCell.findUniqueOrThrow({ where: { id: cell.id } }),
    ).resolves.toBeDefined();
  });

  it('ненормализованный нормализованный код в базу не попадает', async () => {
    // Без этой проверки уникальный индекс перестал бы означать «одна полка —
    // одна запись»: рядом легально встали бы A-01 и a-01.
    await expect(
      ctx.db.$executeRawUnsafe(
        `INSERT INTO "StorageCell" ("id","code","normalizedCode","kind","createdById","updatedAt")
         SELECT gen_random_uuid(), 'x-1', 'x-1', 'STORAGE', "id", now() FROM "User" LIMIT 1`,
      ),
    ).rejects.toThrow();
  });

  it('пустой и управляющий код база не принимает', async () => {
    for (const bad of ["''", "'  A'", "E'A\\u0007B'"]) {
      await expect(
        ctx.db.$executeRawUnsafe(
          `INSERT INTO "StorageCell" ("id","code","normalizedCode","kind","createdById","updatedAt")
           SELECT gen_random_uuid(), ${bad}, 'ZZ-${Math.random().toString(36).slice(2, 8).toUpperCase()}', 'STORAGE', "id", now() FROM "User" LIMIT 1`,
        ),
        bad,
      ).rejects.toThrow();
    }
  });

  it('автор ячейки не удаляется каскадом', async () => {
    const actor = await actorFor(['ADMIN']);
    const cell = await createStorageCell(
      deps,
      actor,
      { code: uniqueCode(), kind: 'STORAGE' },
      CONTEXT,
    );

    await expect(ctx.db.user.delete({ where: { id: actor.userId } })).rejects.toThrow();
    expect(cell.id).toBeDefined();
  });
});

// --- 3. Типы и многоместность ------------------------------------------------

describe('типы ячеек', () => {
  it('оба типа создаются, активны и нигде не ограничены одним заказом', async () => {
    const storage = await seedCell('STORAGE');
    const route = await seedCell('ROUTE');

    expect(storage.kind).toBe('STORAGE');
    expect(route.kind).toBe('ROUTE');
    expect(storage.isActive).toBe(true);
    expect(route.isActive).toBe(true);

    // Вместимость не моделируется вовсе: у строки нет ни одного поля,
    // которое могло бы молча ограничить полку одним заказом.
    const columns = await ctx.db.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'StorageCell'`,
    );
    const names = columns.map((row) => row.column_name);
    expect(names).not.toContain('capacity');
    expect(names).not.toContain('maxOrders');
    expect(names.sort()).toEqual([
      'changedById',
      'code',
      'createdAt',
      'createdById',
      'id',
      'isActive',
      'kind',
      'normalizedCode',
      'updatedAt',
      'version',
    ]);
  });

  it('тип не меняется, пока пустоту подтвердить нечем', async () => {
    const cell = await seedCell('STORAGE');
    const actor = await actorFor(['ADMIN']);

    await expect(
      changeStorageCellKind(
        deps,
        actor,
        cell.id,
        { kind: 'ROUTE', expectedVersion: cell.version },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', conflict: { kind: 'CELL_OCCUPANCY_UNKNOWN' } });

    const after = await ctx.db.storageCell.findUniqueOrThrow({ where: { id: cell.id } });
    expect(after.kind).toBe('STORAGE');
    expect(after.version).toBe(cell.version);
    expect(await auditCount(cell.id)).toBe(1); // только создание
  });

  it('тип не меняется у занятой ячейки', async () => {
    const cell = await seedCell('STORAGE');
    const actor = await actorFor(['ADMIN']);
    const occupied: CellDeps = {
      db: ctx.db,
      occupancy: async (): Promise<CellOccupancy> => 'OCCUPIED',
    };

    await expect(
      changeStorageCellKind(
        occupied,
        actor,
        cell.id,
        { kind: 'ROUTE', expectedVersion: cell.version },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', conflict: { kind: 'CELL_NOT_EMPTY' } });

    expect((await ctx.db.storageCell.findUniqueOrThrow({ where: { id: cell.id } })).kind).toBe(
      'STORAGE',
    );
  });

  it('контракт пустоты рабочий: с подтверждением пустоты тип меняется', async () => {
    // Проверяется именно ПОРТ, а не выдуманное размещение: следующий модуль
    // подставит настоящую проверку, и операция обязана заработать без правок.
    const cell = await seedCell('STORAGE');
    const actor = await actorFor(['ADMIN']);
    const empty: CellDeps = { db: ctx.db, occupancy: async (): Promise<CellOccupancy> => 'EMPTY' };

    const changed = await changeStorageCellKind(
      empty,
      actor,
      cell.id,
      { kind: 'ROUTE', expectedVersion: cell.version },
      CONTEXT,
    );

    expect(changed.kind).toBe('ROUTE');
    expect(changed.version).toBe(cell.version + 1);
    expect(await cellEvents(cell.id)).toHaveLength(2);
  });
});

// --- 4. Конкурентность, аудит и realtime ------------------------------------

describe('изменения', () => {
  it('устаревшая версия даёт 409 и не пишет ничего', async () => {
    const cell = await seedCell();
    const actor = await actorFor(['ADMIN']);

    await setStorageCellActive(
      deps,
      actor,
      cell.id,
      { isActive: false, expectedVersion: cell.version },
      CONTEXT,
    );
    const afterFirst = await ctx.db.storageCell.findUniqueOrThrow({ where: { id: cell.id } });
    const auditBefore = await auditCount(cell.id);
    const eventsBefore = (await cellEvents(cell.id)).length;

    await expect(
      setStorageCellActive(
        deps,
        actor,
        cell.id,
        { isActive: true, expectedVersion: cell.version },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', conflict: { kind: 'STALE_VERSION' } });

    const afterConflict = await ctx.db.storageCell.findUniqueOrThrow({ where: { id: cell.id } });
    expect(afterConflict.version).toBe(afterFirst.version);
    expect(afterConflict.isActive).toBe(false);
    expect(await auditCount(cell.id)).toBe(auditBefore);
    expect((await cellEvents(cell.id)).length).toBe(eventsBefore);
  });

  it('деактивация и включение атомарны с аудитом и событием', async () => {
    const cell = await seedCell();
    const actor = await actorFor(['ADMIN']);

    const off = await setStorageCellActive(
      deps,
      actor,
      cell.id,
      { isActive: false, expectedVersion: cell.version },
      CONTEXT,
    );
    const on = await setStorageCellActive(
      deps,
      actor,
      cell.id,
      { isActive: true, expectedVersion: off.version },
      CONTEXT,
    );

    expect(on.isActive).toBe(true);
    expect(on.version).toBe(cell.version + 2);

    const actions = await ctx.db.auditLog.findMany({
      where: { entityType: 'StorageCell', entityId: cell.id },
      orderBy: { id: 'asc' },
      select: { action: true },
    });
    expect(actions.map((row) => row.action)).toEqual([
      'STORAGE_CELL_CREATED',
      'STORAGE_CELL_DEACTIVATED',
      'STORAGE_CELL_ACTIVATED',
    ]);
    expect(await cellEvents(cell.id)).toHaveLength(3);
  });

  it('повтор того же состояния идемпотентен', async () => {
    const cell = await seedCell();
    const actor = await actorFor(['ADMIN']);

    const repeat = await setStorageCellActive(
      deps,
      actor,
      cell.id,
      { isActive: true, expectedVersion: cell.version },
      CONTEXT,
    );

    expect(repeat.version).toBe(cell.version);
    expect(await auditCount(cell.id)).toBe(1);
    expect(await cellEvents(cell.id)).toHaveLength(1);
  });

  it('изменение, аудит и событие откатываются вместе', async () => {
    const cell = await seedCell();
    const actor = await actorFor(['ADMIN']);

    // Отказ вносится на последнем шаге транзакции — на записи события.
    await ctx.db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fl_test_block_cell_event() RETURNS trigger AS $$
      BEGIN
        IF NEW."payload"->>'cellId' = '${cell.id}' THEN
          RAISE EXCEPTION 'искусственный отказ записи события';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await ctx.db.$executeRawUnsafe(`
      CREATE TRIGGER fl_test_block_cell_event
      BEFORE INSERT ON "RealtimeEvent"
      FOR EACH ROW EXECUTE FUNCTION fl_test_block_cell_event();
    `);

    try {
      await expect(
        setStorageCellActive(
          deps,
          actor,
          cell.id,
          { isActive: false, expectedVersion: cell.version },
          CONTEXT,
        ),
      ).rejects.toThrow();
    } finally {
      await ctx.db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS fl_test_block_cell_event ON "RealtimeEvent";',
      );
      await ctx.db.$executeRawUnsafe('DROP FUNCTION IF EXISTS fl_test_block_cell_event();');
    }

    const after = await ctx.db.storageCell.findUniqueOrThrow({ where: { id: cell.id } });
    expect(after.isActive).toBe(true);
    expect(after.version).toBe(cell.version);
    expect(await auditCount(cell.id)).toBe(1);
  });

  it('событие адресовано складу и не раскрывает код ячейки', async () => {
    const cell = await seedCell();
    const events = await cellEvents(cell.id);

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ cellId: cell.id });
    expect(JSON.stringify(events[0]?.payload)).not.toContain(cell.normalizedCode);
    expect(events[0]?.audienceUserId).toBeNull();
    expect([...(events[0]?.audienceRoles ?? [])].sort()).toEqual(['ADMIN', 'WAREHOUSE']);
  });
});

// --- 5. Права ----------------------------------------------------------------

describe('права', () => {
  it('администратор читает и изменяет', async () => {
    const token = await tokenFor(['ADMIN']);

    const created = await call('POST', '/api/storage-cells', token, {
      code: uniqueCode('ADM'),
      kind: 'STORAGE',
    });
    expect(created.statusCode).toBe(201);
    const cell = created.json() as { id: string; version: number; normalizedCode: string };

    expect((await call('GET', '/api/storage-cells', token)).statusCode).toBe(200);
    expect(
      (await call('GET', `/api/storage-cells/resolve?code=${cell.normalizedCode}`, token))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await call('PUT', `/api/storage-cells/${cell.id}/active`, token, {
          isActive: false,
          expectedVersion: cell.version,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('кладовщик читает и разрешает скан, но не изменяет', async () => {
    const token = await tokenFor(['WAREHOUSE']);
    const cell = await seedCell();

    expect((await call('GET', '/api/storage-cells', token)).statusCode).toBe(200);
    expect(
      (await call('GET', `/api/storage-cells/resolve?code=${cell.normalizedCode}`, token))
        .statusCode,
    ).toBe(200);
    expect((await call('GET', `/api/storage-cells/${cell.id}/label.svg`, token)).statusCode).toBe(
      200,
    );

    expect(
      (await call('POST', '/api/storage-cells', token, { code: uniqueCode(), kind: 'STORAGE' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call('PUT', `/api/storage-cells/${cell.id}/kind`, token, {
          kind: 'ROUTE',
          expectedVersion: cell.version,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call('PUT', `/api/storage-cells/${cell.id}/active`, token, {
          isActive: false,
          expectedVersion: cell.version,
        })
      ).statusCode,
    ).toBe(403);

    // Отказ настоящий, а не только по коду ответа.
    expect((await ctx.db.storageCell.findUniqueOrThrow({ where: { id: cell.id } })).isActive).toBe(
      true,
    );
  });

  it('кладовщик не видит выключенные ячейки даже прямым запросом', async () => {
    const token = await tokenFor(['WAREHOUSE']);
    const cell = await seedCell();
    const actor = await actorFor(['ADMIN']);
    await setStorageCellActive(
      deps,
      actor,
      cell.id,
      { isActive: false, expectedVersion: cell.version },
      CONTEXT,
    );

    // Клиент просит показать выключенные — сервер всё равно отдаёт только рабочие.
    const list = await call('GET', '/api/storage-cells?isActive=false&limit=500', token);
    const ids = (list.json() as { items: { id: string }[] }).items.map((row) => row.id);
    expect(ids).not.toContain(cell.id);

    expect(
      (await call('GET', `/api/storage-cells/resolve?code=${cell.normalizedCode}`, token))
        .statusCode,
    ).toBe(404);
    expect((await call('GET', `/api/storage-cells/${cell.id}/label.svg`, token)).statusCode).toBe(
      404,
    );
  });

  it('остальные роли получают 403, аноним — 401', async () => {
    const cell = await seedCell();

    for (const roles of [['LOGISTICIAN'], ['COURIER'], ['FLORIST'], ['MANAGER']] as Role[][]) {
      const token = await tokenFor(roles);
      expect((await call('GET', '/api/storage-cells', token)).statusCode, roles.join()).toBe(403);
      expect(
        (await call('GET', `/api/storage-cells/resolve?code=${cell.normalizedCode}`, token))
          .statusCode,
        roles.join(),
      ).toBe(403);
      expect(
        (await call('POST', '/api/storage-cells', token, { code: uniqueCode(), kind: 'STORAGE' }))
          .statusCode,
        roles.join(),
      ).toBe(403);
    }

    expect((await call('GET', '/api/storage-cells', null)).statusCode).toBe(401);
    expect((await call('GET', `/api/storage-cells/${cell.id}/label.svg`, null)).statusCode).toBe(
      401,
    );
  });

  it('комбинированная роль следует матрице прав, а не одной строке', async () => {
    // Кладовщик, которому дополнительно выдали ADMIN, обязан получить права
    // администратора: решение принимает НАБОР ролей.
    const token = await tokenFor(['WAREHOUSE', 'ADMIN']);
    expect(
      (await call('POST', '/api/storage-cells', token, { code: uniqueCode('MIX'), kind: 'ROUTE' }))
        .statusCode,
    ).toBe(201);

    // А курьер с ролью флориста складского API по-прежнему не получает.
    const foreign = await tokenFor(['COURIER', 'FLORIST']);
    expect((await call('GET', '/api/storage-cells', foreign)).statusCode).toBe(403);
  });

  it('удаления в API нет', async () => {
    const token = await tokenFor(['ADMIN']);
    const cell = await seedCell();

    const response = await call('DELETE', `/api/storage-cells/${cell.id}`, token);
    expect([404, 405]).toContain(response.statusCode);
  });
});

// --- 6. Список ---------------------------------------------------------------

describe('список', () => {
  it('счётчики активных по типам и устойчивый порядок', async () => {
    await seedCell('STORAGE');
    await seedCell('ROUTE');

    const first = await listStorageCells(ctx.db, {
      isActive: true,
      kind: null,
      limit: 500,
      offset: 0,
    });
    expect(first.activeByKind.STORAGE).toBeGreaterThan(0);
    expect(first.activeByKind.ROUTE).toBeGreaterThan(0);

    const codes = first.items.map((row) => row.normalizedCode);
    expect([...codes].sort()).toEqual(codes);

    const second = await listStorageCells(ctx.db, {
      isActive: true,
      kind: null,
      limit: 500,
      offset: 0,
    });
    expect(second.items.map((row) => row.id)).toEqual(first.items.map((row) => row.id));
  });
});

// --- 7. Этикетка -------------------------------------------------------------

describe('QR-этикетка', () => {
  it('таблица версий согласована со стандартом', () => {
    // Общее число кодовых слов обязано быть суммой данных и коррекции:
    // расхождение здесь дало бы правдоподобный, но нечитаемый код.
    for (const text of ['A', 'A'.repeat(20), 'A'.repeat(48)]) {
      const { spec } = buildCodewords(text);
      const blocks = spec.blocks.reduce((sum, [count]) => sum + count, 0);
      const data = spec.blocks.reduce((sum, [count, size]) => sum + count * size, 0);
      expect(data + blocks * spec.eccPerBlock, text).toBe(spec.totalCodewords);
    }
  });

  it('матрица читается обратно: данные, маска и обход согласованы', () => {
    const masks = [
      (r: number, c: number) => (r + c) % 2 === 0,
      (r: number) => r % 2 === 0,
      (_r: number, c: number) => c % 3 === 0,
      (r: number, c: number) => (r + c) % 3 === 0,
      (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
      (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
      (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
    ];

    for (const text of ['A-01', 'СКЛАД-ПОЛКА-12', 'R-2026-08-12-003', 'X'.repeat(48)]) {
      const matrix = encodeQrMatrix(text);
      const size = matrix.length;
      const { spec, codewords } = buildCodewords(text);
      expect(size, text).toBe(17 + 4 * spec.version);

      const reserved = reservedModules(size);
      const mask = readFormatMask(matrix);
      const rule = masks[mask];
      expect(rule, text).toBeDefined();

      const bits: number[] = [];
      for (const [row, col] of dataModuleOrder(size, reserved)) {
        const raw = (matrix[row] ?? [])[col] === true;
        bits.push((rule !== undefined && rule(row, col) ? !raw : raw) ? 1 : 0);
      }

      const read: number[] = [];
      for (let i = 0; i + 8 <= bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j += 1) {
          byte = (byte << 1) | (bits[i + j] ?? 0);
        }
        read.push(byte);
      }

      expect(read.slice(0, codewords.length), text).toEqual(codewords);
    }
  });

  it('служебные узоры стоят там, где их ищет сканер', () => {
    const matrix = encodeQrMatrix('A-01');
    const size = matrix.length;

    for (const [row, col] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ] as const) {
      expect((matrix[row] ?? [])[col]).toBe(true);
      expect((matrix[row + 1] ?? [])[col + 1]).toBe(false);
      expect((matrix[row + 3] ?? [])[col + 3]).toBe(true);
    }

    // Синхронизирующая дорожка чередуется.
    for (let i = 8; i < size - 8; i += 1) {
      expect((matrix[6] ?? [])[i], `строка ${i}`).toBe(i % 2 === 0);
      expect((matrix[i] ?? [])[6], `столбец ${i}`).toBe(i % 2 === 0);
    }

    // Тёмный модуль обязателен и всегда в одном месте.
    expect((matrix[size - 8] ?? [])[8]).toBe(true);
  });

  it('генерация детерминированная, разные коды дают разные этикетки', () => {
    expect(renderCellLabelSvg('A-01')).toBe(renderCellLabelSvg('A-01'));
    expect(renderCellLabelSvg('A-01')).not.toBe(renderCellLabelSvg('A-02'));
  });

  it('этикетка несёт только код: ни UUID, ни ссылок, ни персональных данных', async () => {
    const token = await tokenFor(['ADMIN']);
    const cell = await seedCell('STORAGE', uniqueCode('QR'));

    const response = await call('GET', `/api/storage-cells/${cell.id}/label.svg`, token);
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'])).toContain('image/svg+xml');

    // Внутреннего идентификатора строки в документе нет.
    expect(response.body).not.toContain(cell.id);
    // Внешних адресов нет: единственный http-адрес — пространство имён SVG.
    const urls = response.body.match(/https?:\/\/[^"'\s]+/g) ?? [];
    expect(urls).toEqual(['http://www.w3.org/2000/svg']);
    expect(response.body).not.toMatch(/<script|xlink:href|<image/i);
    // Подпись под кодом — сам код, чтобы этикетку можно было прочитать глазами.
    expect(response.body).toContain(cell.normalizedCode);
  });
});

/** Функциональные модули: их положение задаётся стандартом, а не нашим кодом. */
function reservedModules(size: number): boolean[][] {
  const alignment: Record<number, number[]> = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
  };
  const version = (size - 17) / 4;
  const res = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (row: number, col: number): void => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const y = row + r;
        const x = col + c;
        if (y >= 0 && y < size && x >= 0 && x < size) {
          (res[y] ?? [])[x] = true;
        }
      }
    }
  };
  mark(0, 0);
  mark(0, size - 7);
  mark(size - 7, 0);
  for (let i = 0; i < size; i += 1) {
    (res[6] ?? [])[i] = true;
    (res[i] ?? [])[6] = true;
  }
  for (const row of alignment[version] ?? []) {
    for (const col of alignment[version] ?? []) {
      const near =
        (row === 6 && col === 6) ||
        (row === 6 && col === size - 7) ||
        (row === size - 7 && col === 6);
      if (near) {
        continue;
      }
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          (res[row + r] ?? [])[col + c] = true;
        }
      }
    }
  }
  for (let i = 0; i <= 8; i += 1) {
    (res[8] ?? [])[i] = true;
    (res[i] ?? [])[8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    (res[8] ?? [])[size - 1 - i] = true;
    (res[size - 1 - i] ?? [])[8] = true;
  }
  return res;
}

/** Обратное чтение информации о формате: номер выбранной маски. */
function readFormatMask(matrix: readonly boolean[][]): number {
  const bit = (r: number, c: number): number => ((matrix[r] ?? [])[c] === true ? 1 : 0);
  let bits = 0;
  for (let i = 0; i <= 5; i += 1) {
    bits |= bit(i, 8) << i;
  }
  bits |= bit(7, 8) << 6;
  bits |= bit(8, 8) << 7;
  bits |= bit(8, 7) << 8;
  for (let i = 9; i < 15; i += 1) {
    bits |= bit(8, 14 - i) << i;
  }
  return ((bits ^ 0b101010000010010) >> 10) & 0b111;
}
