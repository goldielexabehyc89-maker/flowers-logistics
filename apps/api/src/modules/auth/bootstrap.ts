/**
 * Создание первого администратора.
 *
 * Логика отделена от CLI, чтобы её можно было проверить тестами: идемпотентность
 * и невозможность создать второго администратора — требования безопасности, а не удобства.
 */

import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { writeAudit } from '../audit/service.js';
import { generateFourDigitCode, hashSecretCode } from './crypto.js';
import { ACTIVATION_CODE_TTL_MS } from './service.js';

/** Ключ advisory-блокировки: два одновременных запуска не должны создать двух админов. */
const BOOTSTRAP_LOCK_KEY = 'flowers-logistics:bootstrap-admin';

export interface BootstrapOptions {
  phone: string;
  name: string;
  reissue: boolean;
}

export type BootstrapOutcome =
  | { kind: 'created'; userId: string; code: string; expiresAt: Date }
  | { kind: 'reissued'; userId: string; code: string; expiresAt: Date }
  | { kind: 'already-exists' }
  | { kind: 'reissue-not-allowed'; reason: string };

export async function bootstrapAdmin(
  db: Database,
  config: AppConfig,
  options: BootstrapOptions,
): Promise<BootstrapOutcome> {
  // Хеш считается до транзакции: argon2 намеренно медленный, держать на нём
  // блокировку таблицы незачем.
  const code = generateFourDigitCode();
  const codeHash = await hashSecretCode(code, config.AUTH_PIN_PEPPER);
  const expiresAt = new Date(Date.now() + ACTIVATION_CODE_TTL_MS);

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BOOTSTRAP_LOCK_KEY}))`;

    const activeAdmins = await tx.user.count({
      where: { status: 'ACTIVE', roles: { some: { role: 'ADMIN' } } },
    });

    const pendingAdmin = await tx.user.findFirst({
      where: { status: 'PENDING_ACTIVATION', roles: { some: { role: 'ADMIN' } } },
      select: { id: true, phone: true },
      orderBy: { createdAt: 'asc' },
    });

    // --- Повторный обычный запуск: второго администратора не создаём ---
    if (!options.reissue && (activeAdmins > 0 || pendingAdmin !== null)) {
      return { kind: 'already-exists' as const };
    }

    // --- Повторная выдача кода первому администратору ---
    if (options.reissue) {
      if (activeAdmins > 0) {
        return { kind: 'reissue-not-allowed' as const, reason: 'есть активный администратор' };
      }
      if (pendingAdmin === null) {
        return { kind: 'reissue-not-allowed' as const, reason: 'нет ожидающего администратора' };
      }
      if (pendingAdmin.phone !== options.phone) {
        return {
          kind: 'reissue-not-allowed' as const,
          reason: 'указан другой телефон, чем у ожидающего администратора',
        };
      }

      await tx.activationCode.updateMany({
        where: { userId: pendingAdmin.id, activeKey: { not: null } },
        data: { activeKey: null, invalidatedAt: new Date() },
      });

      await tx.activationCode.create({
        data: { userId: pendingAdmin.id, codeHash, expiresAt, activeKey: pendingAdmin.id },
      });

      await writeAudit(tx, {
        action: 'ACTIVATION_CODE_REISSUED',
        entityType: 'User',
        entityId: pendingAdmin.id,
        actorRoles: ['ADMIN'],
        newValue: { expiresAt: expiresAt.toISOString() },
        source: 'bootstrap',
      });

      return { kind: 'reissued' as const, userId: pendingAdmin.id, code, expiresAt };
    }

    // --- Первый запуск ---
    const user = await tx.user.create({
      data: {
        phone: options.phone,
        fullName: options.name,
        status: 'PENDING_ACTIVATION',
        roles: { create: [{ role: 'ADMIN' }] },
      },
      select: { id: true },
    });

    await tx.activationCode.create({
      data: { userId: user.id, codeHash, expiresAt, activeKey: user.id },
    });

    await writeAudit(tx, {
      action: 'ADMIN_BOOTSTRAPPED',
      entityType: 'User',
      entityId: user.id,
      actorRoles: ['ADMIN'],
      newValue: { fullName: options.name, roles: ['ADMIN'], status: 'PENDING_ACTIVATION' },
      source: 'bootstrap',
    });

    await writeAudit(tx, {
      action: 'ACTIVATION_CODE_ISSUED',
      entityType: 'User',
      entityId: user.id,
      actorRoles: ['ADMIN'],
      newValue: { expiresAt: expiresAt.toISOString() },
      source: 'bootstrap',
    });

    return { kind: 'created' as const, userId: user.id, code, expiresAt };
  });
}
