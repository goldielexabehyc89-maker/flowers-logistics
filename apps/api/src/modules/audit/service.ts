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
  // Системные действия синхронизации заказов. Автор — не пользователь,
  // поэтому actorUserId у них пуст, а source = 'worker'.
  'ORDER_IMPORTED',
  'ORDER_SYNCED',
  'ORDER_SCOPE_ENTERED',
  'ORDER_SCOPE_EXITED',
  'ORDER_SOURCE_MISSING',
  'ORDER_SOURCE_RESTORED',
  // Ручное локальное исправление интервала логистом или администратором:
  // единственное изменение заказа, у которого есть человек-автор.
  'ORDER_INTERVAL_SET',
  // Ручные маршруты-черновики. Значения полей маршрута в аудит не попадают:
  // только идентификаторы, позиции, транспорт и технические состояния.
  'ROUTE_CREATED',
  'ROUTE_ORDERS_ADDED',
  'ROUTE_ORDERS_RETURNED',
  'ROUTE_ORDERS_MOVED',
  'ROUTE_ORDERS_REORDERED',
  'ROUTE_COURIER_ASSIGNED',
  'ROUTE_COURIER_UNASSIGNED',
  // Конфликт распределённого заказа обнаруживает синхронизация, автор — не человек.
  'ROUTE_ORDER_CONFLICT_DETECTED',
  // Жизненный цикл маршрута и блокировка редактора. Heartbeat не аудируется
  // намеренно: раз в тридцать секунд он превратил бы журнал в шум.
  'ROUTE_CONFIRMED',
  'ROUTE_RETURNED_TO_DRAFT',
  'ROUTE_CANCELLED',
  'ROUTE_EDIT_LOCK_ACQUIRED',
  'ROUTE_EDIT_LOCK_RELEASED',
  'ROUTE_EDIT_LOCK_TAKEN_OVER',
  // Геоданные заказа. Ни адрес, ни координаты в аудит не попадают:
  // там только состояние и версия.
  'ORDER_GEO_POINT_SET',
  'ORDER_GEO_INVALIDATED',
  // Автоматическое геокодирование. Автор — не человек, координат и адресов
  // в записи нет: только состояние, источник, версия и технический код отказа.
  'ORDER_GEO_RESOLVED',
  'ORDER_GEO_LOW_PRECISION',
  'ORDER_GEO_FAILED',
  // Склады. В аудит попадают название, координаты и признаки — адресов клиентов
  // здесь нет, а адрес склада является служебным и персональным не считается.
  'DEPOT_CREATED',
  'DEPOT_UPDATED',
  'DEPOT_DEFAULT_CHANGED',
  'DEPOT_DEACTIVATED',
  'DEPOT_ACTIVATED',
  // Справочник складских ячеек (этап 6.4). Код ячейки — надпись на полке,
  // а не персональные данные: он нужен администратору, чтобы понять, о какой
  // ячейке речь. Заказов, адресов и людей в этих записях нет.
  'STORAGE_CELL_CREATED',
  'STORAGE_CELL_KIND_CHANGED',
  'STORAGE_CELL_ACTIVATED',
  'STORAGE_CELL_DEACTIVATED',
  // Общие настройки планирования: смена и время обслуживания.
  'SETTING_UPDATED',
  // Планирование маршрутов. Ни адресов, ни координат заказов: только
  // идентификаторы, количества, состояния и безопасные коды отказа.
  'ROUTE_PLAN_REQUESTED',
  'ROUTE_PLAN_COMPUTED',
  'ROUTE_PLAN_FAILED',
  'ROUTE_PLAN_APPLIED',
  'ROUTE_PLAN_EXPIRED',
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
