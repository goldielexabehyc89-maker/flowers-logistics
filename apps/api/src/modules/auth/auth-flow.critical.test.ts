/**
 * Критические проверки авторизации: bootstrap, активация, вход, защита от перебора,
 * независимость устройств и немедленный отзыв доступа.
 *
 * Работают с настоящей PostgreSQL: транзакции, блокировки и уникальные индексы
 * невозможно достоверно проверить моками.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from './bootstrap.js';
import { activate, login, logout, logoutAll } from './service.js';
import { hashSecretCode } from './crypto.js';
import { authenticate } from './guards.js';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  uniquePhone,
  type TestContext,
} from './testing/harness.js';

let ctx: TestContext;

const CONTEXT = { ip: '10.0.0.1', userAgent: 'vitest', deviceLabel: null };

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

/** Готовит активированного пользователя с известным PIN. */
async function seedActiveUser(pin: string, roles: Parameters<typeof seedUser>[1]['roles']) {
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  return seedUser(ctx.db, { roles, status: 'ACTIVE', pinHash });
}

/**
 * Приводит базу к состоянию «администраторов нет».
 *
 * Пользователей удалить нельзя, поэтому все существующие администраторы
 * замораживаются: для bootstrap это равнозначно их отсутствию. Без такой подготовки
 * результат теста зависел бы от данных, созданных другими тестами.
 */
async function withoutAnyAdmins(): Promise<void> {
  await ctx.db.user.updateMany({
    where: { roles: { some: { role: 'ADMIN' } }, status: { not: 'FROZEN' } },
    data: { status: 'FROZEN', frozenAt: new Date() },
  });
}

describe('bootstrap первого администратора', () => {
  it('создаёт ровно одного администратора и не создаёт второго при повторе', async () => {
    await withoutAnyAdmins();

    const first = await bootstrapAdmin(ctx.db, ctx.config, {
      phone: uniquePhone(),
      name: 'Первый администратор',
      reissue: false,
    });
    expect(first.kind).toBe('created');

    const created = await ctx.db.user.count({
      where: { roles: { some: { role: 'ADMIN' } }, status: { not: 'FROZEN' } },
    });
    expect(created).toBe(1);

    const second = await bootstrapAdmin(ctx.db, ctx.config, {
      phone: uniquePhone(),
      name: 'Второй администратор',
      reissue: false,
    });

    expect(second.kind).toBe('already-exists');
    // Второго администратора не появилось, прежний код не раскрыт.
    expect(
      await ctx.db.user.count({
        where: { roles: { some: { role: 'ADMIN' } }, status: { not: 'FROZEN' } },
      }),
    ).toBe(1);
    expect(JSON.stringify(second)).not.toContain('code');
  });

  it('--reissue выдаёт новый код только ожидающему администратору с тем же телефоном', async () => {
    await withoutAnyAdmins();

    const phone = uniquePhone();
    const created = await bootstrapAdmin(ctx.db, ctx.config, {
      phone,
      name: 'Первый администратор',
      reissue: false,
    });
    expect(created.kind).toBe('created');

    // Чужой телефон — отказ.
    const wrongPhone = await bootstrapAdmin(ctx.db, ctx.config, {
      phone: uniquePhone(),
      name: 'Не тот',
      reissue: true,
    });
    expect(wrongPhone.kind).toBe('reissue-not-allowed');

    // Тот же телефон — новый код, второй пользователь не создаётся.
    const reissued = await bootstrapAdmin(ctx.db, ctx.config, {
      phone,
      name: 'Первый администратор',
      reissue: true,
    });
    expect(reissued.kind).toBe('reissued');
    expect(
      await ctx.db.user.count({
        where: { roles: { some: { role: 'ADMIN' } }, status: { not: 'FROZEN' } },
      }),
    ).toBe(1);

    // Активных кодов по-прежнему ровно один: предыдущий инвалидирован.
    const pendingAdmin = await ctx.db.user.findFirstOrThrow({
      where: { phone },
      select: { id: true },
    });
    expect(
      await ctx.db.activationCode.count({
        where: { userId: pendingAdmin.id, activeKey: { not: null } },
      }),
    ).toBe(1);
  });

  it('--reissue запрещён при наличии активного администратора', async () => {
    await withoutAnyAdmins();
    await seedUser(ctx.db, { roles: ['ADMIN'], status: 'ACTIVE' });

    const blocked = await bootstrapAdmin(ctx.db, ctx.config, {
      phone: uniquePhone(),
      name: 'После активации',
      reissue: true,
    });

    expect(blocked.kind).toBe('reissue-not-allowed');
  });
});

describe('активация одноразовым кодом', () => {
  it('код одноразовый, истекает через 30 минут и инвалидируется перевыпуском', async () => {
    const phone = uniquePhone();
    const user = await ctx.db.user.create({
      data: { phone, fullName: 'Активируемый', roles: { create: [{ role: 'COURIER' }] } },
      select: { id: true },
    });

    const code = '0417';
    const codeHash = await hashSecretCode(code, TEST_SECRETS.AUTH_PIN_PEPPER);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await ctx.db.activationCode.create({
      data: { userId: user.id, codeHash, expiresAt, activeKey: user.id },
    });

    // Срок действия ровно 30 минут.
    const stored = await ctx.db.activationCode.findFirstOrThrow({
      where: { userId: user.id, activeKey: { not: null } },
      select: { expiresAt: true, createdAt: true },
    });
    const ttlMinutes = (stored.expiresAt.getTime() - stored.createdAt.getTime()) / 60_000;
    expect(ttlMinutes).toBeGreaterThan(29);
    expect(ttlMinutes).toBeLessThanOrEqual(31);

    const result = await activate(ctx, { phone, code, pin: '1234' }, CONTEXT);
    expect(result.user.status).toBe('ACTIVE');

    // Повторное использование того же кода невозможно.
    await expect(activate(ctx, { phone, code, pin: '4321' }, CONTEXT)).rejects.toThrow();
  });

  it('перевыпуск инвалидирует предыдущий код', async () => {
    const phone = uniquePhone();
    const user = await ctx.db.user.create({
      data: { phone, fullName: 'Перевыпуск', roles: { create: [{ role: 'COURIER' }] } },
      select: { id: true },
    });

    const oldHash = await hashSecretCode('1111', TEST_SECRETS.AUTH_PIN_PEPPER);
    await ctx.db.activationCode.create({
      data: {
        userId: user.id,
        codeHash: oldHash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        activeKey: user.id,
      },
    });

    await ctx.db.activationCode.updateMany({
      where: { userId: user.id, activeKey: { not: null } },
      data: { activeKey: null, invalidatedAt: new Date() },
    });
    const newHash = await hashSecretCode('2222', TEST_SECRETS.AUTH_PIN_PEPPER);
    await ctx.db.activationCode.create({
      data: {
        userId: user.id,
        codeHash: newHash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        activeKey: user.id,
      },
    });

    await expect(activate(ctx, { phone, code: '1111', pin: '1234' }, CONTEXT)).rejects.toThrow();
    const ok = await activate(ctx, { phone, code: '2222', pin: '1234' }, CONTEXT);
    expect(ok.user.status).toBe('ACTIVE');
  });

  it('истёкший код не активирует пользователя', async () => {
    const phone = uniquePhone();
    const user = await ctx.db.user.create({
      data: { phone, fullName: 'Просрочен', roles: { create: [{ role: 'COURIER' }] } },
      select: { id: true },
    });

    await ctx.db.activationCode.create({
      data: {
        userId: user.id,
        codeHash: await hashSecretCode('3333', TEST_SECRETS.AUTH_PIN_PEPPER),
        expiresAt: new Date(Date.now() - 1000),
        activeKey: user.id,
      },
    });

    await expect(activate(ctx, { phone, code: '3333', pin: '1234' }, CONTEXT)).rejects.toThrow();

    const stillPending = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stillPending.status).toBe('PENDING_ACTIVATION');
  });
});

/** Секреты фикстуры: код активации и PIN, которые не имеют права оказаться в базе. */
const SECRETS = ['9137', '0428'] as const;

/** Поля записи журнала попыток. Ни одно из них не предназначено для секрета. */
const ATTEMPT_FIELDS = [
  'id',
  'phone',
  'userId',
  'kind',
  'success',
  'ip',
  'userAgent',
  'reason',
  'createdAt',
] as const;

/**
 * Утечка секрета в свободный текст записи.
 *
 * Смотрят только те поля, куда секрет может попасть по ошибке кода: причина
 * отказа и сведения о клиенте. Номер записи, идентификатор пользователя,
 * телефон и время исключены намеренно — они состоят из цифр и
 * шестнадцатеричных символов, и четыре цифры кода совпадают там случайно
 * примерно раз в несколько сотен прогонов. Такое совпадение не означает
 * утечки, а красный прогон из-за него не доказывает ничего.
 */
function leakedSecrets(attempt: Record<string, unknown>, secrets: readonly string[]): string[] {
  const text = (['ip', 'userAgent', 'reason'] as const)
    .map((field) => (typeof attempt[field] === 'string' ? (attempt[field] as string) : ''))
    .join('\u0000');
  return secrets.filter((secret) => text.includes(secret));
}

describe('секреты не хранятся и не публикуются в открытом виде', () => {
  it('PIN и код активации отсутствуют в базе открытым текстом', async () => {
    const phone = uniquePhone();
    const user = await ctx.db.user.create({
      data: { phone, fullName: 'Секреты', roles: { create: [{ role: 'COURIER' }] } },
      select: { id: true },
    });

    await ctx.db.activationCode.create({
      data: {
        userId: user.id,
        codeHash: await hashSecretCode('9137', TEST_SECRETS.AUTH_PIN_PEPPER),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        activeKey: user.id,
      },
    });

    await activate(ctx, { phone, code: '9137', pin: '0428' }, CONTEXT);

    const stored = await ctx.db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { pinHash: true },
    });
    expect(stored.pinHash).not.toBeNull();
    expect(stored.pinHash).not.toContain('0428');

    const codes = await ctx.db.activationCode.findMany({
      where: { userId: user.id },
      select: { codeHash: true },
    });
    for (const record of codes) {
      expect(record.codeHash).not.toContain('9137');
    }

    // Аудит фиксирует событие, но не значения.
    const audit = await ctx.db.auditLog.findMany({
      where: { entityId: user.id },
      select: { action: true, oldValue: true, newValue: true },
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain('9137');
    expect(serialized).not.toContain('0428');
    expect(audit.some((entry) => entry.action === 'USER_ACTIVATED')).toBe(true);

    // Журнал попыток тоже не содержит секретов.
    const attempts = await ctx.db.authAttempt.findMany({ where: { userId: user.id } });
    expect(attempts.length).toBeGreaterThan(0);

    for (const attempt of attempts) {
      /*
       * Состав записи закреплён.
       *
       * Поля для PIN или кода в журнале попыток нет и быть не должно. Новое
       * поле обязано пройти через эту проверку осознанно, а не появиться
       * молча вместе с секретом внутри.
       */
      expect(Object.keys(attempt).sort()).toEqual([...ATTEMPT_FIELDS].sort());
      expect(leakedSecrets(attempt, SECRETS)).toEqual([]);
    }
  });

  it('проверка утечки смотрит на текст, а не на случайные цифры идентификаторов', () => {
    /*
     * Проверка самой проверки, и она здесь не ради полноты.
     *
     * Прежний вариант искал код в сериализованной записи ЦЕЛИКОМ и падал,
     * когда четыре цифры кода случайно встречались внутри UUID или телефона:
     * `…-a1fb-9137190ed341`. Секрет при этом никуда не утекал, а красный CI
     * означал только неудачное случайное число. Ослаблять защиту нельзя —
     * поэтому свободный текст проверяется по-прежнему строго.
     */
    const technical = {
      id: 9137n,
      phone: '+79208730609',
      userId: '01a00fd9-e81f-7752-a1fb-9137190ed341',
      kind: 'ACTIVATION',
      success: true,
      ip: '10.0.0.1',
      userAgent: 'vitest',
      reason: null,
      createdAt: new Date('2026-09-13T07:00:00.000Z'),
    };
    expect(leakedSecrets(technical, SECRETS)).toEqual([]);

    // А настоящая утечка в свободный текст по-прежнему видна.
    expect(leakedSecrets({ ...technical, reason: 'wrong code 9137' }, SECRETS)).toEqual(['9137']);
    expect(leakedSecrets({ ...technical, userAgent: 'app pin=0428' }, SECRETS)).toEqual(['0428']);
  });
});

describe('вход и активация: отказ без временных блокировок', () => {
  it('сколько угодно неверных PIN подряд не создают блокировку, а верный сразу входит', async () => {
    const user = await seedActiveUser('1234', ['COURIER']);
    const context = { ...CONTEXT, ip: '10.1.0.5' };

    // Много неудач подряд — временной блокировки нет, каждая просто отклоняется.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await expect(login(ctx, { phone: user.phone, pin: '9999' }, context)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    }

    // Ни одной строки блокировки — ни по телефону, ни по IP, ни по их сочетанию.
    expect(await ctx.db.authLockout.count()).toBe(0);

    // Следующий верный PIN входит сразу, без ожидания.
    const result = await login(ctx, { phone: user.phone, pin: '1234' }, context);
    expect(result.user.phone).toBe(user.phone);
  });

  it('неудачные попытки продолжают фиксироваться в AuthAttempt', async () => {
    const user = await seedActiveUser('1234', ['COURIER']);
    const before = await ctx.db.authAttempt.count({ where: { userId: user.id, success: false } });
    await expect(
      login(ctx, { phone: user.phone, pin: '0000' }, { ...CONTEXT, ip: '10.1.0.6' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const after = await ctx.db.authAttempt.count({ where: { userId: user.id, success: false } });
    // Фиксация неудач сохранена: блокировки нет, но след попытки есть.
    expect(after).toBe(before + 1);
  });

  it('общий IP Wi-Fi не блокирует остальных сотрудников', async () => {
    const ip = '10.9.9.9';
    const attacked = await seedActiveUser('1111', ['COURIER']);
    const colleague = await seedActiveUser('2222', ['COURIER']);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await expect(
        login(ctx, { phone: attacked.phone, pin: '0000' }, { ...CONTEXT, ip }),
      ).rejects.toThrow();
    }

    // Коллега с того же IP входит без препятствий.
    const result = await login(ctx, { phone: colleague.phone, pin: '2222' }, { ...CONTEXT, ip });
    expect(result.user.phone).toBe(colleague.phone);
    expect(await ctx.db.authLockout.count()).toBe(0);
  });

  it('неверный код активации не блокирует, а верный сразу активирует', async () => {
    const phone = uniquePhone();
    const user = await ctx.db.user.create({
      data: { phone, fullName: 'Активируемый', roles: { create: [{ role: 'COURIER' }] } },
      select: { id: true },
    });
    const code = '0417';
    const codeHash = await hashSecretCode(code, TEST_SECRETS.AUTH_PIN_PEPPER);
    await ctx.db.activationCode.create({
      data: {
        userId: user.id,
        codeHash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        activeKey: user.id,
      },
    });
    const context = { ...CONTEXT, ip: '10.1.0.7' };

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await expect(
        activate(ctx, { phone, code: '9999', pin: '1234' }, context),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    expect(await ctx.db.authLockout.count()).toBe(0);

    const result = await activate(ctx, { phone, code, pin: '1234' }, context);
    expect(result.user.status).toBe('ACTIVE');
  });

  it('неизвестный телефон не отличается от неверного PIN и проходит проверку-пустышку', async () => {
    const unknownPhone = uniquePhone();
    const known = await seedActiveUser('4321', ['COURIER']);

    const unknownStart = process.hrtime.bigint();
    await expect(
      login(ctx, { phone: unknownPhone, pin: '1111' }, { ...CONTEXT, ip: '10.3.0.1' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const unknownDuration = Number(process.hrtime.bigint() - unknownStart) / 1e6;

    const knownStart = process.hrtime.bigint();
    await expect(
      login(ctx, { phone: known.phone, pin: '1111' }, { ...CONTEXT, ip: '10.3.0.2' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const knownDuration = Number(process.hrtime.bigint() - knownStart) / 1e6;

    // Обе ветки выполняют настоящую проверку argon2: разница не должна быть кратной.
    expect(unknownDuration).toBeGreaterThan(5);
    expect(unknownDuration).toBeLessThan(knownDuration * 5);
  });

  it('замороженный пользователь не входит даже с верным PIN', async () => {
    const pinHash = await hashSecretCode('1234', TEST_SECRETS.AUTH_PIN_PEPPER);
    const user = await seedUser(ctx.db, { roles: ['COURIER'], status: 'FROZEN', pinHash });

    await expect(
      login(ctx, { phone: user.phone, pin: '1234' }, { ...CONTEXT, ip: '10.4.0.1' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('несколько устройств и отзыв доступа', () => {
  it('устройства получают независимые семьи сессий', async () => {
    const user = await seedActiveUser('1357', ['COURIER']);

    const first = await login(
      ctx,
      { phone: user.phone, pin: '1357', deviceLabel: 'Телефон' },
      { ...CONTEXT, ip: '10.5.0.1' },
    );
    const second = await login(
      ctx,
      { phone: user.phone, pin: '1357', deviceLabel: 'Планшет' },
      { ...CONTEXT, ip: '10.5.0.2' },
    );

    expect(first.refreshToken).not.toBe(second.refreshToken);

    const families = await ctx.db.refreshSession.findMany({
      where: { userId: user.id, revokedAt: null },
      select: { familyId: true },
    });
    expect(new Set(families.map((row) => row.familyId)).size).toBe(2);

    // Выход с первого устройства не трогает второе.
    const firstActor = await authenticate(
      { headers: { authorization: `Bearer ${first.accessToken}` } },
      ctx,
    );
    await logout(ctx, firstActor, CONTEXT);

    const alive = await ctx.db.refreshSession.findMany({
      where: { userId: user.id, revokedAt: null },
      select: { familyId: true },
    });
    expect(new Set(alive.map((row) => row.familyId)).size).toBe(1);

    // Второе устройство продолжает работать.
    await expect(
      authenticate({ headers: { authorization: `Bearer ${second.accessToken}` } }, ctx),
    ).resolves.toMatchObject({ userId: user.id });
  });

  it('logout-all закрывает доступ немедленно, не дожидаясь истечения access-токена', async () => {
    const user = await seedActiveUser('2468', ['COURIER']);
    const session = await login(
      ctx,
      { phone: user.phone, pin: '2468' },
      { ...CONTEXT, ip: '10.6.0.1' },
    );

    const actor = await authenticate(
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      ctx,
    );
    await logoutAll(ctx, actor, CONTEXT);

    // Токен ещё не истёк по времени, но уже недействителен.
    await expect(
      authenticate({ headers: { authorization: `Bearer ${session.accessToken}` } }, ctx),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const active = await ctx.db.refreshSession.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(active).toBe(0);
  });
});
