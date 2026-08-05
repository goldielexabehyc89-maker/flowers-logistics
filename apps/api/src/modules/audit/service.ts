/**
 * Неизменяемый аудит.
 *
 * Запись аудита создаётся В ТОЙ ЖЕ транзакции, что и само изменение: иначе возможна
 * ситуация «действие выполнено, следа нет» или наоборот. Изменять и удалять записи
 * запрещено триггерами базы (см. миграцию `audit_immutability_guards`).
 *
 * Секретные значения — PIN, коды активации, токены, хеши — в аудит не попадают никогда.
 */

import type { Role } from '@fl/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import type { TransactionClient } from '../auth/sessions.js';

export const AUDIT_ACTIONS = [
  'ADMIN_BOOTSTRAPPED',
  'ACTIVATION_CODE_ISSUED',
  'ACTIVATION_CODE_REISSUED',
  'USER_ACTIVATED',
  'AUTH_LOGIN_SUCCEEDED',
  'AUTH_LOGOUT',
  'AUTH_LOGOUT_ALL',
  'AUTH_REFRESH_REUSE_DETECTED',
  'USER_CREATED',
  'USER_UPDATED',
  'USER_ROLES_CHANGED',
  'USER_FROZEN',
  'USER_UNFROZEN',
  'PIN_RESET',
  'OUTBOX_MESSAGE_RETRIED',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditSource = 'api' | 'bootstrap' | 'worker';

export interface AuditEntryInput {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
  /** Снимок ролей автора на момент действия: позже роли могут измениться. */
  actorRoles?: readonly Role[];
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  source?: AuditSource;
}

/**
 * Поля, которые не должны попасть в аудит ни при каких обстоятельствах.
 * Проверка выполняется на записи, а не только на ревью: набор полей объекта
 * со временем меняется, и «случайно передали весь объект» — реальный сценарий.
 */
const FORBIDDEN_AUDIT_FIELDS =
  /^(pin|pinhash|pin_hash|code|codehash|code_hash|token|tokenhash|token_hash|accesstoken|refreshtoken|successortokenenc|password|secret|pepper|apikey|credential)$/i;

export class AuditSecretLeakError extends Error {
  constructor(reason: string) {
    super(`Запись в аудит отклонена: ${reason}`);
    this.name = 'AuditSecretLeakError';
  }
}

/** Глубина, дальше которой значение считается непригодным для аудита. */
const MAX_AUDIT_DEPTH = 8;

/**
 * Рекурсивно проверяет объект на секретные имена полей.
 *
 * Проверки верхнего уровня недостаточно: значения аудита собираются из вложенных
 * структур, и `{ changes: { pinHash: '…' } }` попал бы в неизменяемый журнал,
 * откуда его нельзя ни удалить, ни исправить.
 *
 * Циклические ссылки и слишком глубокие структуры отклоняются: аудит должен быть
 * простым и предсказуемым, а не воспроизводить произвольный граф объектов.
 */
function assertNoSecrets(value: unknown, path: string, depth: number, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object') {
    return;
  }

  if (depth > MAX_AUDIT_DEPTH) {
    throw new AuditSecretLeakError(`значение вложено глубже ${MAX_AUDIT_DEPTH} уровней (${path})`);
  }

  if (seen.has(value)) {
    throw new AuditSecretLeakError(`обнаружена циклическая ссылка (${path})`);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`, depth + 1, seen));
    return;
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (FORBIDDEN_AUDIT_FIELDS.test(key)) {
      throw new AuditSecretLeakError(`секретное поле «${childPath}»`);
    }
    assertNoSecrets(item, childPath, depth + 1, seen);
  }
}

function assertAuditValueIsSafe(
  value: Record<string, unknown> | null | undefined,
  label: string,
): void {
  if (value === null || value === undefined) {
    return;
  }
  assertNoSecrets(value, label, 0, new WeakSet<object>());
}

/** Записывает событие аудита. Вызывается только внутри транзакции изменения. */
export async function writeAudit(tx: TransactionClient, entry: AuditEntryInput): Promise<void> {
  // Проверка выполняется до любого обращения к базе.
  assertAuditValueIsSafe(entry.oldValue, 'oldValue');
  assertAuditValueIsSafe(entry.newValue, 'newValue');

  await tx.auditLog.create({
    data: {
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      actorUserId: entry.actorUserId ?? null,
      actorRoles: [...(entry.actorRoles ?? [])],
      // Значения аудита — произвольный JSON-объект; Prisma ожидает свой тип InputJsonObject.
      ...(entry.oldValue === null || entry.oldValue === undefined
        ? {}
        : { oldValue: entry.oldValue as Prisma.InputJsonObject }),
      ...(entry.newValue === null || entry.newValue === undefined
        ? {}
        : { newValue: entry.newValue as Prisma.InputJsonObject }),
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      source: entry.source ?? 'api',
    },
  });
}
