/**
 * Критическая проверка совместимости со СЛЕДУЮЩЕЙ версией перечисления ролей.
 *
 * Проверяется ровно один сценарий отката: база уже расширена будущими значениями
 * `Role`, сотрудникам эти роли уже назначены, а работает эта — предыдущая —
 * версия приложения. Она обязана продолжать работать, а не падать с `P2023`.
 *
 * ОТДЕЛЬНАЯ БАЗА ОБЯЗАТЕЛЬНА.
 *
 * `ALTER TYPE ... ADD VALUE` необратим: удалить значение перечисления PostgreSQL
 * нельзя. Расширив общую тестовую базу, файл заразил бы все соседние сценарии
 * и сделал бы их результаты непроверяемыми. Поэтому здесь создаётся собственная
 * одноразовая база, а в конце удаляется целиком.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../platform/config.js';
import { createLogger } from '../../platform/logging/logger.js';
import { createDatabase, type Database } from '../../platform/db.js';
import { resolveTestDatabaseUrl } from '../../platform/testing/test-database.js';
import { splitRoleValues } from '../../platform/role-assignments.js';
import { testConfig, TEST_SECRETS } from '../auth/testing/harness.js';
import { hashSecretCode } from '../auth/crypto.js';
import { login } from '../auth/service.js';
import { authenticate } from '../auth/guards.js';
import { getUser, listUsers, updateUser, freezeUser, resetPin, type Actor } from './service.js';
import { assertCourierAssignable } from '../routing/service.js';

const run = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);

/** Значения, которых эта версия ещё не знает. Ровно те, что добавит следующий релиз. */
const FUTURE_ROLES = ['FLORIST', 'MANAGER'] as const;

const META = { ip: '10.9.0.1', userAgent: 'vitest' };
const CONTEXT = { ip: '10.9.0.1', userAgent: 'vitest', deviceLabel: null };

let db: Database;
let config: AppConfig;
let compatUrl: string;
let compatName: string;
let serverUrl: string;

interface Seeded {
  admin: string;
  logist: string;
  courier: string;
  onlyUnknown: string;
  courierPlusUnknown: string;
  adminPlusUnknown: string;
  /** Отдельный кандидат для маршрутизации: его не замораживают другие сценарии. */
  routingCandidate: string;
}

let seeded: Seeded;
let pin: string;

/** Заменяет имя базы в строке подключения. */
function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

async function sql(client: Database, statement: string): Promise<void> {
  await client.$executeRawUnsafe(statement);
}

/** Соединение к произвольной базе того же сервера. */
function openDatabase(url: string): Database {
  const local = testConfig({ DATABASE_URL: url });
  return createDatabase(local, createLogger(local));
}

beforeAll(async () => {
  const testUrl = resolveTestDatabaseUrl();
  serverUrl = withDatabase(testUrl, 'postgres');

  // Имя одноразовое: файл может выполняться повторно, а расширенную базу
  // переиспользовать нельзя — она уже не чистая.
  compatName = `fl_role_compat_${process.hrtime.bigint().toString(36)}`;
  compatUrl = withDatabase(testUrl, compatName);

  const admin = openDatabase(serverUrl);
  try {
    await sql(admin, `CREATE DATABASE "${compatName}"`);
  } finally {
    await admin.$disconnect();
  }

  // Схема ставится штатной командой: проверять совместимость на схеме,
  // собранной руками, значило бы проверять не то, что поедет на сервер.
  await run('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, DATABASE_URL: compatUrl },
  });

  config = testConfig({ DATABASE_URL: compatUrl });
  db = createDatabase(config, createLogger(config));

  // Будущее расширение перечисления — то самое, которое сделает следующий релиз.
  for (const role of FUTURE_ROLES) {
    await sql(db, `ALTER TYPE "Role" ADD VALUE IF NOT EXISTS '${role}'`);
  }

  pin = '4321';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);

  const make = async (fullName: string, roles: readonly string[]): Promise<string> => {
    const phone = `+79${String(process.hrtime.bigint() % 1_000_000_000n).padStart(9, '0')}`;
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "User" ("id", "phone", "fullName", "status", "pinHash", "pinSetAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', $3, now(), now())
       RETURNING "id"::text AS id`,
      phone,
      fullName,
      pinHash,
    );
    const id = rows[0]?.id as string;
    for (const role of roles) {
      await db.$executeRawUnsafe(
        `INSERT INTO "UserRoleAssignment" ("userId", "role") VALUES ($1::uuid, $2::"Role")`,
        id,
        role,
      );
    }
    return id;
  };

  seeded = {
    admin: await make('Администратор', ['ADMIN']),
    logist: await make('Логист', ['LOGISTICIAN']),
    courier: await make('Обычный курьер', ['COURIER']),
    onlyUnknown: await make('Только будущая роль', ['FLORIST']),
    courierPlusUnknown: await make('Курьер и будущая роль', ['COURIER', 'FLORIST']),
    adminPlusUnknown: await make('Администратор и будущая роль', ['ADMIN', 'MANAGER']),
    routingCandidate: await make('Кандидат в курьеры и будущая роль', ['COURIER', 'FLORIST']),
  };
});

afterAll(async () => {
  if (db !== undefined) {
    await db.$disconnect();
  }
  if (compatName !== undefined) {
    const admin = openDatabase(serverUrl);
    try {
      // База одноразовая: она содержит необратимо расширенное перечисление
      // и не должна пережить прогон.
      await sql(admin, `DROP DATABASE IF EXISTS "${compatName}" WITH (FORCE)`);
    } finally {
      await admin.$disconnect();
    }
  }
});

const adminActor = (): Actor => ({ userId: seeded.admin, roles: ['ADMIN'] });
const logistActor = (): Actor => ({ userId: seeded.logist, roles: ['LOGISTICIAN'] });

describe('разбор значений роли', () => {
  it('известные и неизвестные значения разделяются, а не смешиваются', () => {
    expect(splitRoleValues(['COURIER', 'FLORIST', 'ADMIN'])).toEqual({
      known: ['COURIER', 'ADMIN'],
      hasUnsupportedRoles: true,
    });
    expect(splitRoleValues(['COURIER'])).toEqual({
      known: ['COURIER'],
      hasUnsupportedRoles: false,
    });
    expect(splitRoleValues(['FLORIST'])).toEqual({ known: [], hasUnsupportedRoles: true });
    expect(splitRoleValues([])).toEqual({ known: [], hasUnsupportedRoles: false });
  });
});

describe('чтение базы с будущими ролями', () => {
  it('база действительно содержит значения, которых эта версия не знает', async () => {
    const rows = await db.$queryRawUnsafe<{ value: string }[]>(
      `SELECT e.enumlabel AS value FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'Role' ORDER BY e.enumsortorder`,
    );
    const values = rows.map((row) => row.value);

    expect(values).toContain('FLORIST');
    expect(values).toContain('MANAGER');
    expect(databaseNameOf(compatUrl)).toBe(compatName);
    expect(compatName.startsWith('fl_role_compat_')).toBe(true);
  });

  it('администраторский список отдаётся полностью и без P2023', async () => {
    const result = await listUsers({ db, config }, adminActor(), { limit: 100, offset: 0 });

    expect(result.total).toBe(7);
    expect(result.items).toHaveLength(7);

    const byId = new Map(result.items.map((item) => [item.id, item]));

    // Известные роли на месте, неизвестные не подменены и не выданы за известные.
    expect(byId.get(seeded.courier)?.roles).toEqual(['COURIER']);
    expect(byId.get(seeded.courier)?.hasUnsupportedRoles).toBe(false);

    expect(byId.get(seeded.onlyUnknown)?.roles).toEqual([]);
    expect(byId.get(seeded.onlyUnknown)?.hasUnsupportedRoles).toBe(true);

    expect(byId.get(seeded.courierPlusUnknown)?.roles).toEqual(['COURIER']);
    expect(byId.get(seeded.courierPlusUnknown)?.hasUnsupportedRoles).toBe(true);

    expect(byId.get(seeded.adminPlusUnknown)?.roles).toEqual(['ADMIN']);
    expect(byId.get(seeded.adminPlusUnknown)?.hasUnsupportedRoles).toBe(true);

    // Имя неизвестной роли наружу не выносится ни в одном поле.
    expect(JSON.stringify(result.items)).not.toContain('FLORIST');
    expect(JSON.stringify(result.items)).not.toContain('MANAGER');
  });

  it('карточка каждой разновидности читается', async () => {
    for (const id of Object.values(seeded)) {
      const view = await getUser({ db, config }, adminActor(), id);
      expect(view.id).toBe(id);
    }
  });
});

describe('сессии и права', () => {
  it('пользователь со старой ролью входит и работает как раньше', async () => {
    const courier = await db.user.findUniqueOrThrow({
      where: { id: seeded.courier },
      select: { phone: true },
    });

    const result = await login({ db, config }, { phone: courier.phone, pin }, CONTEXT);

    expect(result.user.roles).toEqual(['COURIER']);
    expect(result.accessToken).toBeTruthy();
  });

  it('только неизвестная роль не даёт сессию и не называет роль', async () => {
    const user = await db.user.findUniqueOrThrow({
      where: { id: seeded.onlyUnknown },
      select: { phone: true },
    });

    await expect(login({ db, config }, { phone: user.phone, pin }, CONTEXT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });

    try {
      await login({ db, config }, { phone: user.phone, pin }, CONTEXT);
      expect.unreachable('вход обязан быть отклонён');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('FLORIST');
      expect((error as { publicMessage?: string }).publicMessage ?? '').not.toContain('FLORIST');
    }
  });

  it('смешанный набор даёт права только известной роли, и токен ими же ограничен', async () => {
    const user = await db.user.findUniqueOrThrow({
      where: { id: seeded.courierPlusUnknown },
      select: { phone: true },
    });

    const result = await login({ db, config }, { phone: user.phone, pin }, CONTEXT);
    expect(result.user.roles).toEqual(['COURIER']);

    // Тот же ответ даёт и guard: он читает роли из базы на каждом запросе.
    const actor = await authenticate(
      { headers: { authorization: `Bearer ${result.accessToken}` } },
      { db, config },
    );
    expect(actor.roles).toEqual(['COURIER']);
  });

  it('токен пользователя, оставшегося только с неизвестной ролью, отвергается', async () => {
    // Токен выдан, пока у пользователя была известная роль.
    const user = await db.user.findUniqueOrThrow({
      where: { id: seeded.courierPlusUnknown },
      select: { phone: true },
    });
    const issued = await login({ db, config }, { phone: user.phone, pin }, CONTEXT);

    // Затем известная роль исчезает: остаётся только неизвестная.
    await db.$executeRawUnsafe(
      `DELETE FROM "UserRoleAssignment" WHERE "userId" = $1::uuid AND "role" = 'COURIER'`,
      seeded.courierPlusUnknown,
    );

    await expect(
      authenticate({ headers: { authorization: `Bearer ${issued.accessToken}` } }, { db, config }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    // Возвращаем роль: остальные проверки рассчитывают на смешанный набор.
    await db.$executeRawUnsafe(
      `INSERT INTO "UserRoleAssignment" ("userId", "role") VALUES ($1::uuid, 'COURIER')`,
      seeded.courierPlusUnknown,
    );
  });
});

describe('логист не получает доступа к записи с неизвестной ролью', () => {
  it('не видит её в принудительной выборке', async () => {
    const result = await listUsers({ db, config }, logistActor(), { limit: 100, offset: 0 });
    const ids = result.items.map((item) => item.id);

    expect(ids).toContain(seeded.courier);
    expect(ids).not.toContain(seeded.courierPlusUnknown);
    expect(ids).not.toContain(seeded.onlyUnknown);
  });

  it('не открывает карточку и не изменяет её', async () => {
    await expect(
      getUser({ db, config }, logistActor(), seeded.courierPlusUnknown),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const version = (
      await db.user.findUniqueOrThrow({
        where: { id: seeded.courierPlusUnknown },
        select: { version: true },
      })
    ).version;

    await expect(
      updateUser({ db, config }, logistActor(), seeded.courierPlusUnknown, { version }, META),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      freezeUser({ db, config }, logistActor(), seeded.courierPlusUnknown, { version }, META),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('старая версия не затирает неизвестную роль', () => {
  it('администратору отказано в перезаписи ролей, строка не изменилась', async () => {
    const before = await db.$queryRawUnsafe<{ role: string }[]>(
      `SELECT "role"::text AS role FROM "UserRoleAssignment" WHERE "userId" = $1::uuid ORDER BY "role"`,
      seeded.courierPlusUnknown,
    );
    const versionBefore = (
      await db.user.findUniqueOrThrow({
        where: { id: seeded.courierPlusUnknown },
        select: { version: true },
      })
    ).version;

    await expect(
      updateUser(
        { db, config },
        adminActor(),
        seeded.courierPlusUnknown,
        { version: versionBefore, roles: ['COURIER'] },
        META,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const after = await db.$queryRawUnsafe<{ role: string }[]>(
      `SELECT "role"::text AS role FROM "UserRoleAssignment" WHERE "userId" = $1::uuid ORDER BY "role"`,
      seeded.courierPlusUnknown,
    );
    const versionAfter = (
      await db.user.findUniqueOrThrow({
        where: { id: seeded.courierPlusUnknown },
        select: { version: true },
      })
    ).version;

    // Состояние строки до и после отказа совпадает полностью.
    expect(after).toEqual(before);
    expect(after.map((row) => row.role)).toEqual(['COURIER', 'FLORIST']);
    expect(versionAfter).toBe(versionBefore);
  });

  it('операции, не трогающие роли, остаются доступными администратору', async () => {
    const version = (
      await db.user.findUniqueOrThrow({
        where: { id: seeded.courierPlusUnknown },
        select: { version: true },
      })
    ).version;

    // Переименование не читает и не переписывает назначения ролей.
    const renamed = await updateUser(
      { db, config },
      adminActor(),
      seeded.courierPlusUnknown,
      { version, fullName: 'Переименован старой версией' },
      META,
    );
    expect(renamed.fullName).toBe('Переименован старой версией');
    expect(renamed.hasUnsupportedRoles).toBe(true);
    expect(renamed.roles).toEqual(['COURIER']);

    // Заморозка и сброс PIN тоже не касаются ролей.
    const frozen = await freezeUser(
      { db, config },
      adminActor(),
      seeded.courierPlusUnknown,
      { version: renamed.version },
      META,
    );
    expect(frozen.status).toBe('FROZEN');

    const roles = await db.$queryRawUnsafe<{ role: string }[]>(
      `SELECT "role"::text AS role FROM "UserRoleAssignment" WHERE "userId" = $1::uuid ORDER BY "role"`,
      seeded.courierPlusUnknown,
    );
    expect(roles.map((row) => row.role)).toEqual(['COURIER', 'FLORIST']);
  });

  it('сброс PIN пользователю только с неизвестной ролью не ломается и не трогает роли', async () => {
    const version = (
      await db.user.findUniqueOrThrow({
        where: { id: seeded.onlyUnknown },
        select: { version: true },
      })
    ).version;

    const result = await resetPin(
      { db, config },
      adminActor(),
      seeded.onlyUnknown,
      { version },
      META,
    );
    expect(result.activationCode).toMatch(/^\d{4}$/);

    const roles = await db.$queryRawUnsafe<{ role: string }[]>(
      `SELECT "role"::text AS role FROM "UserRoleAssignment" WHERE "userId" = $1::uuid`,
      seeded.onlyUnknown,
    );
    expect(roles.map((row) => row.role)).toEqual(['FLORIST']);
  });
});

describe('маршрутизация и планирование', () => {
  it('кандидат с неизвестной ролью не падает и не считается обычным курьером', async () => {
    await db.$transaction(async (tx) => {
      // Логисту такой кандидат недоступен: неизвестная роль защищает аккаунт.
      await expect(
        assertCourierAssignable(
          tx,
          {
            userId: seeded.logist,
            familyId: 'f',
            phone: '+70000000000',
            fullName: 'Л',
            roles: ['LOGISTICIAN'],
          },
          seeded.routingCandidate,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      // Администратору — доступен, и разбор перечисления не падает.
      await expect(
        assertCourierAssignable(
          tx,
          {
            userId: seeded.admin,
            familyId: 'f',
            phone: '+70000000001',
            fullName: 'А',
            roles: ['ADMIN'],
          },
          seeded.routingCandidate,
        ),
      ).resolves.toBeUndefined();

      // Пользователь только с неизвестной ролью курьером не считается вовсе.
      await expect(
        assertCourierAssignable(
          tx,
          {
            userId: seeded.admin,
            familyId: 'f',
            phone: '+70000000001',
            fullName: 'А',
            roles: ['ADMIN'],
          },
          seeded.onlyUnknown,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });
});

describe('прежнее поведение сохранено', () => {
  it('последний активный администратор по-прежнему защищён', async () => {
    // В базе два администратора; замораживаем одного — второй остаётся.
    const version = (
      await db.user.findUniqueOrThrow({
        where: { id: seeded.adminPlusUnknown },
        select: { version: true },
      })
    ).version;

    const frozen = await freezeUser(
      { db, config },
      adminActor(),
      seeded.adminPlusUnknown,
      { version },
      META,
    );
    expect(frozen.status).toBe('FROZEN');

    // Теперь активный администратор один: заморозить его нельзя.
    const own = (
      await db.user.findUniqueOrThrow({
        where: { id: seeded.admin },
        select: { version: true },
      })
    ).version;

    await expect(
      freezeUser({ db, config }, adminActor(), seeded.admin, { version: own }, META),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
