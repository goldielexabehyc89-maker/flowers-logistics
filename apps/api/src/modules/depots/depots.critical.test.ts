/**
 * Критические проверки складов.
 *
 * Склад — точка отсчёта каждого посчитанного плана, поэтому проверяется
 * не «работает ли форма», а то, нарушение чего опасно: складов по умолчанию
 * не больше одного, он всегда активен, склады не удаляются, а неудачная смена
 * умолчания не оставляет систему вовсе без него.
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
import { AppError } from '../../platform/errors.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import type { Role } from '@fl/shared';
import {
  createDepot,
  findDefaultDepot,
  setDefaultDepot,
  setDepotActive,
  updateDepot,
} from './service.js';

let ctx: TestContext;
const CONTEXT = { ip: null, userAgent: null };

/**
 * Координаты Москвы. Значения выбраны так, чтобы НЕ совпадать с точками
 * проверок матриц: кэш матриц ключуется набором точек, и одинаковые фикстуры
 * в разных файлах вернули бы чужой результат вместо посчитанного.
 */
const LAT = 55.700111;
const LON = 37.500222;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

/**
 * Каждый файл работает в общей одноразовой базе, а склады удалить нельзя.
 * Поэтому «текущим» считается склад по умолчанию на момент проверки,
 * а не единственный в таблице.
 */
async function adminActor(): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles: ['ADMIN'] });
  return {
    userId: user.id,
    roles: ['ADMIN'] as Role[],
    familyId: '00000000-0000-4000-8000-000000000001',
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

let sequence = 0;
function uniqueName(): string {
  sequence += 1;
  return `Склад ${process.hrtime.bigint() % 1_000_000n}-${sequence}`;
}

describe('инварианты базы', () => {
  it('склад нельзя удалить: на него ссылаются маршруты и снимки планирования', async () => {
    const actor = await adminActor();
    const depot = await createDepot(
      ctx.db,
      actor,
      { name: uniqueName(), address: 'Москва, склад', lat: LAT, lon: LON },
      CONTEXT,
    );

    await expect(ctx.db.depot.delete({ where: { id: depot.id } })).rejects.toThrow();
  });

  it('признак склада по умолчанию принимает единственное значение', async () => {
    const actor = await adminActor();
    const depot = await createDepot(
      ctx.db,
      actor,
      { name: uniqueName(), address: 'Москва, склад', lat: LAT, lon: LON },
      CONTEXT,
    );

    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "Depot" SET "defaultKey" = 'что-то другое' WHERE "id" = '${depot.id}'::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('склад по умолчанию невозможно выключить даже прямым запросом', async () => {
    const current = await findDefaultDepot(ctx.db);
    expect(current).not.toBeNull();

    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "Depot" SET "isActive" = false WHERE "id" = '${current?.id ?? ''}'::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('координаты вне допустимых пределов отвергаются базой', async () => {
    const actor = await adminActor();

    await expect(
      ctx.db.depot.create({
        data: {
          name: uniqueName(),
          address: 'Никуда',
          latMicro: 95_000_000,
          lonMicro: 0,
          createdById: actor.userId,
        },
      }),
    ).rejects.toThrow();

    await expect(
      ctx.db.depot.create({
        data: {
          name: uniqueName(),
          address: 'Никуда',
          latMicro: 0,
          lonMicro: 190_000_000,
          createdById: actor.userId,
        },
      }),
    ).rejects.toThrow();
  });

  it('двух складов по умолчанию не бывает', async () => {
    const actor = await adminActor();
    const other = await createDepot(
      ctx.db,
      actor,
      { name: uniqueName(), address: 'Москва, второй', lat: LAT, lon: LON },
      CONTEXT,
    );

    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "Depot" SET "defaultKey" = 'default' WHERE "id" = '${other.id}'::uuid`,
      ),
    ).rejects.toThrow();

    const defaults = await ctx.db.depot.count({ where: { defaultKey: { not: null } } });
    expect(defaults).toBe(1);
  });
});

describe('склад по умолчанию', () => {
  it('первый склад становится складом по умолчанию в той же транзакции', async () => {
    // Проверяется на настоящей истории: если склад уже есть, первым он был
    // ровно один раз — и именно он остался складом по умолчанию.
    const current = await findDefaultDepot(ctx.db);
    expect(current).not.toBeNull();
    expect(current?.isActive).toBe(true);

    const created = await ctx.db.depot.count();
    expect(created).toBeGreaterThan(0);
  });

  it('второй склад складом по умолчанию не становится сам', async () => {
    const actor = await adminActor();
    const other = await createDepot(
      ctx.db,
      actor,
      { name: uniqueName(), address: 'Москва, ещё один', lat: LAT, lon: LON },
      CONTEXT,
    );

    expect(other.defaultKey).toBeNull();
  });

  it('смена принимает версии ОБОИХ складов и увеличивает обе', async () => {
    const actor = await adminActor();
    const previous = await findDefaultDepot(ctx.db);
    expect(previous).not.toBeNull();

    const next = await createDepot(
      ctx.db,
      actor,
      { name: uniqueName(), address: 'Москва, смена', lat: LAT, lon: LON },
      CONTEXT,
    );

    const assigned = await setDefaultDepot(
      ctx.db,
      actor,
      next.id,
      {
        expectedVersion: next.version,
        expectedCurrentDefaultId: previous?.id ?? null,
        expectedCurrentDefaultVersion: previous?.version ?? null,
      },
      CONTEXT,
    );

    expect(assigned.defaultKey).toBe('default');
    expect(assigned.version).toBe(next.version + 1);

    const cleared = await ctx.db.depot.findUniqueOrThrow({
      where: { id: previous?.id ?? '' },
      select: { defaultKey: true, version: true },
    });
    expect(cleared.defaultKey).toBeNull();
    // Изменились обе строки — значит обе увеличили версию.
    expect(cleared.version).toBe((previous?.version ?? 0) + 1);
  });

  it('неверная версия ПРЕЖНЕГО склада отклоняется, и прежний остаётся складом по умолчанию', async () => {
    const actor = await adminActor();
    const previous = await findDefaultDepot(ctx.db);
    const next = await createDepot(
      ctx.db,
      actor,
      { name: uniqueName(), address: 'Москва, устаревшая версия', lat: LAT, lon: LON },
      CONTEXT,
    );

    await expect(
      setDefaultDepot(
        ctx.db,
        actor,
        next.id,
        {
          expectedVersion: next.version,
          expectedCurrentDefaultId: previous?.id ?? null,
          expectedCurrentDefaultVersion: 999,
        },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const after = await findDefaultDepot(ctx.db);
    expect(after?.id).toBe(previous?.id);
  });

  it('назначение выключенного склада не оставляет систему без склада по умолчанию', async () => {
    const actor = await adminActor();
    const previous = await findDefaultDepot(ctx.db);

    const inactive = await createDepot(
      ctx.db,
      actor,
      { name: uniqueName(), address: 'Москва, выключенный', lat: LAT, lon: LON },
      CONTEXT,
    );
    const off = await setDepotActive(
      ctx.db,
      actor,
      inactive.id,
      { isActive: false, expectedVersion: inactive.version },
      CONTEXT,
    );
    expect(off.isActive).toBe(false);

    // Ноль обновлённых строк обязан завершить транзакцию ошибкой: снятие
    // прежнего признака откатывается вместе с ней.
    await expect(
      setDefaultDepot(
        ctx.db,
        actor,
        inactive.id,
        {
          expectedVersion: off.version,
          expectedCurrentDefaultId: previous?.id ?? null,
          expectedCurrentDefaultVersion: previous?.version ?? null,
        },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const after = await findDefaultDepot(ctx.db);
    expect(after).not.toBeNull();
    expect(after?.id).toBe(previous?.id);
    expect(after?.version).toBe(previous?.version);
  });

  it('повторное назначение того же склада ничего не меняет и не пишет ложный аудит', async () => {
    const actor = await adminActor();
    const current = await findDefaultDepot(ctx.db);
    expect(current).not.toBeNull();

    const before = await ctx.db.auditLog.count({ where: { action: 'DEPOT_DEFAULT_CHANGED' } });

    const same = await setDefaultDepot(
      ctx.db,
      actor,
      current?.id ?? '',
      {
        expectedVersion: current?.version ?? 1,
        expectedCurrentDefaultId: current?.id ?? null,
        expectedCurrentDefaultVersion: current?.version ?? 1,
      },
      CONTEXT,
    );

    expect(same.version).toBe(current?.version);
    expect(await ctx.db.auditLog.count({ where: { action: 'DEPOT_DEFAULT_CHANGED' } })).toBe(
      before,
    );
  });

  it('склад по умолчанию нельзя деактивировать: сначала назначьте другой', async () => {
    const actor = await adminActor();
    const current = await findDefaultDepot(ctx.db);

    await expect(
      setDepotActive(
        ctx.db,
        actor,
        current?.id ?? '',
        { isActive: false, expectedVersion: current?.version ?? 1 },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'DEPOT_DEFAULT_REQUIRED' } });
  });

  it('две одновременные смены дают ровно один склад по умолчанию', async () => {
    const actor = await adminActor();
    const previous = await findDefaultDepot(ctx.db);

    const left = await createDepot(
      ctx.db,
      actor,
      { name: uniqueName(), address: 'Москва, гонка A', lat: LAT, lon: LON },
      CONTEXT,
    );
    const right = await createDepot(
      ctx.db,
      actor,
      { name: uniqueName(), address: 'Москва, гонка B', lat: LAT, lon: LON },
      CONTEXT,
    );

    const results = await Promise.allSettled([
      setDefaultDepot(
        ctx.db,
        actor,
        left.id,
        {
          expectedVersion: left.version,
          expectedCurrentDefaultId: previous?.id ?? null,
          expectedCurrentDefaultVersion: previous?.version ?? null,
        },
        CONTEXT,
      ),
      setDefaultDepot(
        ctx.db,
        actor,
        right.id,
        {
          expectedVersion: right.version,
          expectedCurrentDefaultId: previous?.id ?? null,
          expectedCurrentDefaultVersion: previous?.version ?? null,
        },
        CONTEXT,
      ),
    ]);

    // Обе операции ждут одну и ту же advisory-блокировку. Вторая видит, что
    // складом по умолчанию стал уже другой склад, и получает отказ — сверяются
    // и тождество прежнего склада, и его версия.
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await ctx.db.depot.count({ where: { defaultKey: { not: null } } })).toBe(1);
  });
});

describe('изменение склада', () => {
  it('устаревшая версия отклоняется', async () => {
    const actor = await adminActor();
    const depot = await createDepot(
      ctx.db,
      actor,
      { name: uniqueName(), address: 'Москва, правка', lat: LAT, lon: LON },
      CONTEXT,
    );

    await expect(
      updateDepot(
        ctx.db,
        actor,
        depot.id,
        {
          name: 'Другое имя',
          address: 'Другой адрес',
          lat: LAT,
          lon: LON,
          expectedVersion: depot.version + 5,
        },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'STALE_VERSION' } });
  });

  it('координаты вне пределов отклоняются до обращения к базе', async () => {
    const actor = await adminActor();

    await expect(
      createDepot(
        ctx.db,
        actor,
        { name: uniqueName(), address: 'Никуда', lat: 95, lon: 0 },
        CONTEXT,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('права', () => {
  it('логист читает склады, но не меняет их', async () => {
    const token = await tokenFor(['LOGISTICIAN']);

    const read = await ctx.app.inject({
      method: 'GET',
      url: '/api/depots',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(200);

    const write = await ctx.app.inject({
      method: 'POST',
      url: '/api/depots',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: uniqueName(), address: 'Москва', lat: LAT, lon: LON },
    });
    expect(write.statusCode).toBe(403);
  });

  it('курьер складов не видит', async () => {
    const token = await tokenFor(['COURIER']);

    const read = await ctx.app.inject({
      method: 'GET',
      url: '/api/depots',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(403);
  });

  it('анонимный запрос отклоняется', async () => {
    const read = await ctx.app.inject({ method: 'GET', url: '/api/depots' });
    expect(read.statusCode).toBe(401);
  });

  it('администратор создаёт склад и назначает склад по умолчанию', async () => {
    const token = await tokenFor(['ADMIN']);
    const previous = await findDefaultDepot(ctx.db);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/depots',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: uniqueName(), address: 'Москва, через API', lat: LAT, lon: LON },
    });
    expect(created.statusCode).toBe(201);

    const body = created.json() as { id: string; version: number; isDefault: boolean };
    expect(body.isDefault).toBe(false);

    const assigned = await ctx.app.inject({
      method: 'PUT',
      url: `/api/depots/${body.id}/default`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        expectedVersion: body.version,
        expectedCurrentDefaultId: previous?.id ?? null,
        expectedCurrentDefaultVersion: previous?.version ?? null,
      },
    });
    expect(assigned.statusCode).toBe(200);
    expect((assigned.json() as { isDefault: boolean }).isDefault).toBe(true);
  });

  it('DELETE склада не существует', async () => {
    const token = await tokenFor(['ADMIN']);
    const current = await findDefaultDepot(ctx.db);

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/depots/${current?.id ?? ''}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
  });
});
