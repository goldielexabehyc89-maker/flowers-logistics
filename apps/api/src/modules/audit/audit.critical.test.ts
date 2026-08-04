/**
 * Критическая проверка защиты аудита от записи секретов.
 *
 * Аудит читают администраторы и выгружают в отчёты. Попадание туда PIN, кода
 * активации или токена означало бы утечку, которую невозможно отозвать:
 * записи аудита неизменяемы и не удаляются.
 */

import { describe, expect, it, vi } from 'vitest';
import { AuditSecretLeakError, writeAudit } from './service.js';
import type { TransactionClient } from '../auth/sessions.js';

/** Заглушка транзакции: проверяется отказ до обращения к базе. */
function fakeTx(): { tx: TransactionClient; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue({});
  return { tx: { auditLog: { create } } as unknown as TransactionClient, create };
}

describe('защита аудита от секретов', () => {
  it('отклоняет запись с секретным полем и не обращается к базе', async () => {
    const forbiddenFields = [
      { pin: '1234' },
      { pinHash: 'argon2id$...' },
      { code: '9137' },
      { codeHash: 'argon2id$...' },
      { token: 'abc' },
      { refreshToken: 'abc' },
      { successorTokenEnc: 'abc' },
      { password: 'abc' },
      { apiKey: 'abc' },
    ];

    for (const value of forbiddenFields) {
      const { tx, create } = fakeTx();

      await expect(
        writeAudit(tx, {
          action: 'USER_UPDATED',
          entityType: 'User',
          entityId: 'test',
          newValue: value,
        }),
      ).rejects.toBeInstanceOf(AuditSecretLeakError);

      expect(create).not.toHaveBeenCalled();
    }
  });

  it('находит секрет во вложенном объекте', async () => {
    const { tx, create } = fakeTx();

    await expect(
      writeAudit(tx, {
        action: 'USER_UPDATED',
        entityType: 'User',
        newValue: { changes: { profile: { credentials: { pinHash: 'argon2id$...' } } } },
      }),
    ).rejects.toBeInstanceOf(AuditSecretLeakError);

    expect(create).not.toHaveBeenCalled();
  });

  it('находит секрет внутри массива', async () => {
    const { tx, create } = fakeTx();

    await expect(
      writeAudit(tx, {
        action: 'USER_UPDATED',
        entityType: 'User',
        newValue: { devices: [{ label: 'Телефон' }, { token: 'abc' }] },
      }),
    ).rejects.toBeInstanceOf(AuditSecretLeakError);

    expect(create).not.toHaveBeenCalled();
  });

  it('отклоняет циклическое и чрезмерно глубокое значение', async () => {
    const cyclic: Record<string, unknown> = { name: 'узел' };
    cyclic['self'] = cyclic;

    await expect(
      writeAudit(fakeTx().tx, { action: 'USER_UPDATED', entityType: 'User', newValue: cyclic }),
    ).rejects.toBeInstanceOf(AuditSecretLeakError);

    let deep: Record<string, unknown> = { value: 1 };
    for (let level = 0; level < 12; level += 1) {
      deep = { nested: deep };
    }

    await expect(
      writeAudit(fakeTx().tx, { action: 'USER_UPDATED', entityType: 'User', newValue: deep }),
    ).rejects.toBeInstanceOf(AuditSecretLeakError);
  });

  it('пропускает допустимую вложенность без секретов', async () => {
    const { tx, create } = fakeTx();

    await writeAudit(tx, {
      action: 'USER_UPDATED',
      entityType: 'User',
      newValue: { changes: { profile: { fullName: 'Иван' }, roles: ['COURIER'] } },
    });

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('проверяет и старое, и новое значение', async () => {
    const { tx } = fakeTx();

    await expect(
      writeAudit(tx, {
        action: 'USER_UPDATED',
        entityType: 'User',
        oldValue: { pin: '0000' },
        newValue: { fullName: 'Нормальное поле' },
      }),
    ).rejects.toBeInstanceOf(AuditSecretLeakError);
  });

  it('пропускает обычные значения и передаёт снимок ролей автора', async () => {
    const { tx, create } = fakeTx();

    await writeAudit(tx, {
      action: 'USER_FROZEN',
      entityType: 'User',
      entityId: 'user-1',
      actorUserId: 'admin-1',
      actorRoles: ['ADMIN'],
      oldValue: { status: 'ACTIVE' },
      newValue: { status: 'FROZEN' },
      ip: '10.0.0.1',
    });

    expect(create).toHaveBeenCalledTimes(1);
    const argument = create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(argument.data).toMatchObject({
      action: 'USER_FROZEN',
      actorRoles: ['ADMIN'],
      source: 'api',
    });
  });
});
