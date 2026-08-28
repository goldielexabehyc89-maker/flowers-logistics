/**
 * Критические проверки ролей производственного контура.
 *
 * Роль, существующая в одном месте и отсутствующая в другом, — это не косметика:
 * администратор либо не сможет её назначить, либо назначит, а сервер отвергнет
 * запрос как несуществующее значение. Поэтому полное множество ролей
 * проверяется сразу во всех обязательных представлениях: перечисление
 * PostgreSQL, общий модуль, схема валидации API и форма интерфейса.
 *
 * Второе, что проверяется здесь, — граница логиста. Появление новых внутренних
 * ролей не должно дать логисту ни одного нового аккаунта: ни на создание,
 * ни на изменение, ни даже на просмотр в списке.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignableRoles,
  canAccessUserManagement,
  canAssignRoles,
  canManageUserWithRoles,
  isPlainCourier,
  ROLE_LABELS,
  ROLES,
  type Role,
} from '@fl/shared';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  uniquePhone,
  type TestContext,
} from '../auth/testing/harness.js';
import { createUser, freezeUser, getUser, listUsers, updateUser, type Actor } from './service.js';

let ctx: TestContext;

const META = { ip: '10.8.0.2', userAgent: 'vitest' };
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);

const adminActor = (userId: string): Actor => ({ userId, roles: ['ADMIN'] });
const logisticianActor = (userId: string): Actor => ({ userId, roles: ['LOGISTICIAN'] });

/** Новые роли производственного контура этого среза. */
const NEW_ROLES: readonly Role[] = ['FLORIST', 'MANAGER'];

/** Все внутренние роли: аккаунт с любой из них логисту недоступен. */
const INTERNAL_ROLES: readonly Role[] = [
  'ADMIN',
  'LOGISTICIAN',
  'WAREHOUSE',
  'FLORIST',
  'MANAGER',
  'SUPERVISOR',
];

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

describe('полное множество ролей', () => {
  it('совпадает в PostgreSQL, общем модуле, схеме API и форме интерфейса', async () => {
    // 1. Перечисление в живой базе — источник, который нельзя подделать кодом.
    const rows = await ctx.db.$queryRawUnsafe<{ value: string }[]>(
      `SELECT e.enumlabel AS value
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'Role'
        ORDER BY e.enumsortorder`,
    );
    const inDatabase = rows.map((row) => row.value);

    expect(inDatabase).toEqual([...ROLES]);

    // 2. Новые значения добавлены именно в КОНЕЦ: порядок существующих не сдвинут.
    expect(inDatabase.slice(0, 4)).toEqual(['ADMIN', 'LOGISTICIAN', 'COURIER', 'WAREHOUSE']);
    expect(inDatabase.slice(4)).toEqual(['FLORIST', 'MANAGER', 'SUPERVISOR']);

    // 3. У каждой роли есть русская подпись: без неё интерфейс покажет пустую строку.
    for (const role of ROLES) {
      expect(ROLE_LABELS[role]).toBeTruthy();
    }

    // 4. Схема валидации API и форма назначения ролей выводятся из того же
    //    перечня, а не переписаны рядом. Проверяется по исходникам: рукописная
    //    копия — это ровно тот способ разойтись, который здесь запрещён.
    const routes = await readFile(
      path.join(REPOSITORY_ROOT, 'apps/api/src/modules/users/routes.ts'),
      'utf8',
    );
    const form = await readFile(
      path.join(REPOSITORY_ROOT, 'apps/web/src/screens/users/UserFormModal.tsx'),
      'utf8',
    );
    const usersScreen = await readFile(
      path.join(REPOSITORY_ROOT, 'apps/web/src/screens/users/UsersScreen.tsx'),
      'utf8',
    );

    expect(routes).toContain('z.enum(ROLES)');
    expect(routes).not.toMatch(/z\.enum\(\[\s*'ADMIN'/);
    // Назначаемые роли выводятся из общей матрицы прав по РОЛЯМ актора, а не
    // переписываются рядом: список для управляющего обязан отличаться от списка
    // администратора, а хардкод «роли администратора» этого бы не дал.
    expect(usersScreen).toContain('assignableRoles(actorRoles)');
    // Форма перебирает переданный ей перечень, а не собственную копию ролей.
    expect(form).toContain('assignable.map(');
    expect(form).not.toMatch(/ASSIGNABLE_BY_ADMIN/);
    expect(form).not.toMatch(/const\s+\w*ROLES\w*\s*(?::[^=]+)?=\s*\[\s*'ADMIN'/);
  });

  it('администратору доступны все роли, логисту — только курьер', () => {
    expect(assignableRoles(['ADMIN'])).toEqual([...ROLES]);
    expect(assignableRoles(['LOGISTICIAN'])).toEqual(['COURIER']);

    for (const role of NEW_ROLES) {
      expect(assignableRoles(['LOGISTICIAN'])).not.toContain(role);
      // Назначать роли вправе только администратор.
      expect(canAssignRoles([role])).toBe(false);
    }
    expect(canAssignRoles(['ADMIN'])).toBe(true);
    expect(canAssignRoles(['LOGISTICIAN'])).toBe(false);
  });

  it('курьер с внутренней ролью перестаёт быть обычным курьером', () => {
    expect(isPlainCourier(['COURIER'])).toBe(true);

    for (const role of INTERNAL_ROLES) {
      expect(isPlainCourier(['COURIER', role])).toBe(false);
      expect(canManageUserWithRoles(['LOGISTICIAN'], ['COURIER', role])).toBe(false);
      // Администратору доступен любой набор.
      expect(canManageUserWithRoles(['ADMIN'], ['COURIER', role])).toBe(true);
    }
  });

  it('роли производственного контура не имеют доступа к управлению пользователями', () => {
    for (const role of ['WAREHOUSE', 'FLORIST', 'MANAGER', 'COURIER'] as const) {
      expect(canAccessUserManagement([role])).toBe(false);
      expect(canManageUserWithRoles([role], ['COURIER'])).toBe(false);
      expect(assignableRoles([role])).toEqual([]);
    }
    expect(canAccessUserManagement(['ADMIN'])).toBe(true);
    expect(canAccessUserManagement(['LOGISTICIAN'])).toBe(true);
  });
});

describe('администратор и новые роли', () => {
  it('создаёт флориста и менеджера, роли сохраняются и возвращаются API', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const actor = adminActor(admin.id);

    for (const role of NEW_ROLES) {
      const created = await createUser(
        ctx,
        actor,
        { phone: uniquePhone(), fullName: `Сотрудник ${role}`, roles: [role] },
        META,
      );

      expect(created.user.roles).toEqual([role]);

      // Роль действительно легла в базу, а не только в ответ.
      const stored = await ctx.db.userRoleAssignment.findMany({
        where: { userId: created.user.id },
        select: { role: true },
      });
      expect(stored.map((item) => item.role)).toEqual([role]);

      // И возвращается чтением через API-слой.
      const read = await getUser(ctx, actor, created.user.id);
      expect(read.roles).toEqual([role]);
    }
  });

  it('изменяет набор ролей, включая комбинацию с курьером', async () => {
    const admin = await seedUser(ctx.db, { roles: ['ADMIN'] });
    const actor = adminActor(admin.id);

    const created = await createUser(
      ctx,
      actor,
      { phone: uniquePhone(), fullName: 'Флорист станет курьером', roles: ['FLORIST'] },
      META,
    );

    const updated = await updateUser(
      ctx,
      actor,
      created.user.id,
      { version: created.user.version, roles: ['FLORIST', 'COURIER'] },
      META,
    );

    expect([...updated.roles].sort()).toEqual(['COURIER', 'FLORIST']);
  });
});

describe('граница логиста не сдвинулась', () => {
  it('логист не создаёт пользователя с новой ролью', async () => {
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const actor = logisticianActor(logist.id);

    for (const roles of [
      ['FLORIST'],
      ['MANAGER'],
      ['COURIER', 'FLORIST'],
      ['COURIER', 'MANAGER'],
    ]) {
      await expect(
        createUser(
          ctx,
          actor,
          { phone: uniquePhone(), fullName: 'Недопустимый', roles: roles as Role[] },
          META,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('логист не изменяет и не замораживает аккаунт с новой ролью', async () => {
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const actor = logisticianActor(logist.id);

    for (const roles of [['FLORIST'], ['MANAGER'], ['COURIER', 'FLORIST']]) {
      const target = await seedUser(ctx.db, { roles: roles as Role[] });

      await expect(
        updateUser(ctx, actor, target.id, { version: target.version, fullName: 'Чужой' }, META),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      await expect(
        freezeUser(ctx, actor, target.id, { version: target.version }, META),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      await expect(getUser(ctx, actor, target.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('принудительная выборка логиста не показывает аккаунты с новыми ролями', async () => {
    const logist = await seedUser(ctx.db, { roles: ['LOGISTICIAN'] });
    const florist = await seedUser(ctx.db, { roles: ['FLORIST'] });
    const manager = await seedUser(ctx.db, { roles: ['MANAGER'] });
    const courierFlorist = await seedUser(ctx.db, { roles: ['COURIER', 'FLORIST'] });
    const plainCourier = await seedUser(ctx.db, { roles: ['COURIER'] });

    /*
     * Список собирается постранично, а не одной страницей.
     *
     * Прежде проверка запрашивала первые 200 записей и молча полагалась
     * на то, что общая тестовая база меньше страницы. База растёт вместе
     * с набором тестов, список отсортирован по имени — и созданный здесь
     * курьер просто переставал попадать на первую страницу. Проверка падала
     * не потому, что граница логиста сдвинулась, а потому, что данных стало
     * больше.
     */
    const ids: string[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await listUsers(ctx, logisticianActor(logist.id), { limit: 200, offset });
      ids.push(...page.items.map((item) => item.id));
      if (ids.length >= page.total || page.items.length === 0) {
        break;
      }
    }

    expect(ids).toContain(plainCourier.id);
    for (const hidden of [florist.id, manager.id, courierFlorist.id]) {
      expect(ids).not.toContain(hidden);
    }

    // Фильтр по новой роли тоже ничего не раскрывает.
    for (const role of NEW_ROLES) {
      const filtered = await listUsers(ctx, logisticianActor(logist.id), {
        role,
        limit: 200,
        offset: 0,
      });
      expect(filtered.items).toHaveLength(0);
    }
  });

  it('новые роли сами не получают доступ к users API', async () => {
    for (const role of NEW_ROLES) {
      const user = await seedUser(ctx.db, { roles: [role] });
      const actor: Actor = { userId: user.id, roles: [role] };

      await expect(listUsers(ctx, actor, { limit: 10, offset: 0 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(
        createUser(
          ctx,
          actor,
          { phone: uniquePhone(), fullName: 'Никто', roles: ['COURIER'] },
          META,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });
});
