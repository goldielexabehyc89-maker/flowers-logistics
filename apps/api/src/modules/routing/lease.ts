/**
 * Мягкая блокировка редактора маршрута.
 *
 * Задача — не «запретить», а сделать конкурентное редактирование заметным.
 * Жёсткая блокировка на уровне базы для этого не годится: она держала бы открытой
 * транзакцию всё время, пока человек думает над порядком доставки, и один забытый
 * вкладыш заблокировал бы маршрут навсегда.
 *
 * Поэтому блокировка мягкая:
 *  - она истекает сама (90 секунд без сердцебиения);
 *  - её можно безопасно перехватить с причиной и подтверждением;
 *  - между запросами не удерживается ни соединение, ни транзакция PostgreSQL.
 *
 * Держатель — пара «пользователь + семья сессий устройства». Один и тот же человек
 * с двух устройств считается двумя редакторами: иначе второе устройство молча
 * перетирало бы правки первого, и человек не понял бы, куда делся его порядок.
 * Семья сессий наружу не возвращается никогда — это идентификатор устройства.
 *
 * Время только серверное: клиент не передаёт срок действия и не может его продлить,
 * подкрутив часы.
 */

import { AppError } from '../../platform/errors.js';
import type { Database } from '../../platform/db.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import type { Role } from '@fl/shared';

/** Сколько живёт аренда без сердцебиения. */
export const LEASE_TTL_MS = 90_000;
/** Рекомендуемый интервал сердцебиения клиента: втрое чаще истечения. */
export const LEASE_HEARTBEAT_MS = 30_000;

const ROUTE_AUDIENCE: readonly Role[] = ['ADMIN', 'LOGISTICIAN'];
const MIN_REASON = 3;
const MAX_REASON = 500;

export interface LeaseRow {
  routeId: string;
  holderUserId: string;
  holderFamilyId: string;
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
  releasedAt: Date | null;
  version: number;
}

export interface LeaseView {
  locked: boolean;
  heldByCurrentSession: boolean;
  holder: { id: string; fullName: string } | null;
  expiresAt: string | null;
  leaseVersion: number | null;
}

export interface LeaseDeps {
  db: Database;
  now?: () => Date;
}

const clockOf = (deps: LeaseDeps): (() => Date) => deps.now ?? (() => new Date());

/** Аренда активна, пока не освобождена и не истекла. */
export function isActive(lease: LeaseRow | null, now: Date): boolean {
  return lease !== null && lease.releasedAt === null && lease.expiresAt > now;
}

function heldBy(lease: LeaseRow | null, actor: AuthenticatedActor, now: Date): boolean {
  return (
    isActive(lease, now) &&
    lease?.holderUserId === actor.userId &&
    lease.holderFamilyId === actor.familyId
  );
}

/** Блокирует строку аренды. Вызывается ПОСЛЕ блокировки самого маршрута. */
export async function lockLease(tx: TransactionClient, routeId: string): Promise<LeaseRow | null> {
  const rows = await tx.$queryRaw<LeaseRow[]>`
    SELECT "routeId", "holderUserId", "holderFamilyId", "acquiredAt", "heartbeatAt",
           "expiresAt", "releasedAt", "version"
    FROM "RouteEditLease"
    WHERE "routeId" = ${routeId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Требует, чтобы операцию выполнял текущий держатель аренды.
 *
 * Разделение причин отказа намеренное: «возьмите блокировку» и «маршрут занят
 * другим человеком» требуют от интерфейса разного поведения.
 */
export async function requireLease(
  tx: TransactionClient,
  routeId: string,
  actor: AuthenticatedActor,
  now: Date,
): Promise<void> {
  const lease = await lockLease(tx, routeId);

  if (!isActive(lease, now)) {
    throw new AppError('CONFLICT', {
      message: 'edit lease required',
      publicMessage: 'Возьмите маршрут в работу, чтобы его редактировать.',
      conflict: { kind: 'EDIT_LOCK_REQUIRED' },
    });
  }

  if (!heldBy(lease, actor, now)) {
    throw new AppError('CONFLICT', {
      message: 'edit lease held by other session',
      publicMessage: 'Маршрут сейчас редактирует другой пользователь.',
      conflict: { kind: 'EDIT_LOCK_HELD_BY_OTHER' },
    });
  }
}

/**
 * Выдаёт аренду внутри уже открытой транзакции.
 *
 * Используется и обычным acquire, и операциями, которые обязаны сразу открыть
 * маршрут инициатору: созданием черновика и возвратом из подтверждённого.
 */
export async function grantLease(
  tx: TransactionClient,
  routeId: string,
  actor: AuthenticatedActor,
  now: Date,
): Promise<LeaseRow> {
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);

  return tx.routeEditLease.upsert({
    where: { routeId },
    create: {
      routeId,
      holderUserId: actor.userId,
      holderFamilyId: actor.familyId,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
    },
    update: {
      holderUserId: actor.userId,
      holderFamilyId: actor.familyId,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
      releasedAt: null,
      version: { increment: 1 },
    },
  });
}

/** Освобождает аренду внутри транзакции. Строка остаётся, меняется только состояние. */
export async function releaseLeaseRow(
  tx: TransactionClient,
  routeId: string,
  now: Date,
): Promise<void> {
  await tx.routeEditLease.updateMany({
    where: { routeId, releasedAt: null },
    data: { releasedAt: now, version: { increment: 1 } },
  });
}

async function publishLease(
  tx: TransactionClient,
  topic: 'route.edit_lock_changed' | 'route.edit_lock_taken_over',
  routeId: string,
  holderUserId: string | null,
): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic,
    // Ни семьи сессий, ни причины, ни номера маршрута: клиент перезапрашивает карточку.
    payload: { routeId, holderUserId },
    audienceRoles: [...ROUTE_AUDIENCE],
  });
}

// --- Публичные операции -----------------------------------------------------

export interface AcquireResult {
  lease: LeaseRow;
  /** Аренда была свободна или истекла и досталась запросившему. */
  granted: boolean;
}

/**
 * Берёт маршрут в работу.
 *
 * Свободная и истёкшая аренда достаются запросившему без причины и без перехвата.
 * Повторный запрос той же семьёй сессий идемпотентно продлевает срок — так работает
 * обычное «вернулся в вкладку». Активная чужая аренда даёт 409: перехват выполняется
 * отдельной осознанной командой.
 */
export async function acquireLease(
  deps: LeaseDeps,
  actor: AuthenticatedActor,
  routeId: string,
  context: { ip: string | null; userAgent: string | null },
): Promise<AcquireResult> {
  const now = clockOf(deps)();

  return deps.db.$transaction(async (tx) => {
    const route = await lockRouteForLease(tx, routeId);
    // Блокировка нужна только черновику: подтверждённый маршрут не редактируется.
    if (route.state !== 'DRAFT') {
      throw new AppError('CONFLICT', {
        message: 'route is not a draft',
        publicMessage: 'Маршрут больше не черновик: редактирование недоступно.',
        conflict: { kind: 'ROUTE_NOT_DRAFT' },
      });
    }

    const current = await lockLease(tx, routeId);

    if (isActive(current, now) && !heldBy(current, actor, now)) {
      throw new AppError('CONFLICT', {
        message: 'edit lease held by other session',
        publicMessage: 'Маршрут сейчас редактирует другой пользователь.',
        conflict: { kind: 'EDIT_LOCK_HELD_BY_OTHER' },
      });
    }

    const extending = heldBy(current, actor, now);
    const lease = await grantLease(tx, routeId, actor, now);

    // Продление той же сессии — рутина, в аудите ей не место: иначе журнал
    // заполнится записями о том, что человек не закрывал вкладку.
    if (!extending) {
      await writeAudit(tx, {
        action: 'ROUTE_EDIT_LOCK_ACQUIRED',
        entityType: 'DeliveryRoute',
        entityId: routeId,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        source: 'api',
        newValue: { leaseVersion: lease.version },
        ip: context.ip,
        userAgent: context.userAgent,
      });
      await publishLease(tx, 'route.edit_lock_changed', routeId, actor.userId);
    }

    return { lease, granted: !extending };
  });
}

/**
 * Продлевает аренду.
 *
 * Ни аудита, ни бизнес-события, ни изменения версии маршрута: сердцебиение приходит
 * каждые тридцать секунд и не является событием предметной области.
 */
export async function heartbeatLease(
  deps: LeaseDeps,
  actor: AuthenticatedActor,
  routeId: string,
): Promise<LeaseRow> {
  const now = clockOf(deps)();

  return deps.db.$transaction(async (tx) => {
    const current = await lockLease(tx, routeId);

    if (!isActive(current, now)) {
      throw new AppError('CONFLICT', {
        message: 'edit lease expired',
        publicMessage: 'Блокировка истекла. Возьмите маршрут в работу заново.',
        conflict: { kind: 'EDIT_LOCK_STALE' },
      });
    }

    if (!heldBy(current, actor, now)) {
      throw new AppError('CONFLICT', {
        message: 'edit lease held by other session',
        publicMessage: 'Маршрут сейчас редактирует другой пользователь.',
        conflict: { kind: 'EDIT_LOCK_HELD_BY_OTHER' },
      });
    }

    return tx.routeEditLease.update({
      where: { routeId },
      data: { heartbeatAt: now, expiresAt: new Date(now.getTime() + LEASE_TTL_MS) },
    });
  });
}

export async function releaseLease(
  deps: LeaseDeps,
  actor: AuthenticatedActor,
  routeId: string,
  context: { ip: string | null; userAgent: string | null },
): Promise<void> {
  const now = clockOf(deps)();

  await deps.db.$transaction(async (tx) => {
    const current = await lockLease(tx, routeId);

    if (!isActive(current, now)) {
      // Освобождать нечего: истёкшая аренда уже никого не держит.
      return;
    }

    if (!heldBy(current, actor, now)) {
      throw new AppError('CONFLICT', {
        message: 'edit lease held by other session',
        publicMessage: 'Эту блокировку удерживает другой пользователь.',
        conflict: { kind: 'EDIT_LOCK_HELD_BY_OTHER' },
      });
    }

    await releaseLeaseRow(tx, routeId, now);

    await writeAudit(tx, {
      action: 'ROUTE_EDIT_LOCK_RELEASED',
      entityType: 'DeliveryRoute',
      entityId: routeId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      ip: context.ip,
      userAgent: context.userAgent,
    });
    await publishLease(tx, 'route.edit_lock_changed', routeId, null);
  });
}

export interface TakeoverInput {
  confirm: boolean;
  reason: string;
  expectedLeaseVersion: number;
}

/**
 * Перехват активной чужой аренды.
 *
 * Требует явного подтверждения, короткой причины и версии аренды, которую видел
 * перехватывающий: иначе перехват стал бы случайным кликом, а прежний редактор
 * не понял бы, почему его правки перестали сохраняться.
 */
export async function takeoverLease(
  deps: LeaseDeps,
  actor: AuthenticatedActor,
  routeId: string,
  input: TakeoverInput,
  context: { ip: string | null; userAgent: string | null },
): Promise<LeaseRow> {
  const now = clockOf(deps)();

  if (!input.confirm) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'takeover requires confirmation',
      publicMessage: 'Перехват требует подтверждения.',
    });
  }
  assertReason(input.reason);

  return deps.db.$transaction(async (tx) => {
    const route = await lockRouteForLease(tx, routeId);
    if (route.state !== 'DRAFT') {
      throw new AppError('CONFLICT', {
        message: 'route is not a draft',
        publicMessage: 'Маршрут больше не черновик: редактирование недоступно.',
        conflict: { kind: 'ROUTE_NOT_DRAFT' },
      });
    }

    const current = await lockLease(tx, routeId);

    if (!isActive(current, now)) {
      // Истёкшую аренду перехватывать не нужно — она берётся обычным acquire.
      throw new AppError('CONFLICT', {
        message: 'lease is not active',
        publicMessage: 'Блокировка уже неактивна. Возьмите маршрут в работу обычным способом.',
        conflict: { kind: 'EDIT_LOCK_STALE' },
      });
    }

    // Перехват собственной активной аренды перехватом не является: он создал бы
    // ложную запись в аудите, увеличил версию и отправил уведомление самому себе.
    // Возвращаем текущую аренду как есть — операция идемпотентна.
    //
    // Второе устройство того же человека под это правило не подпадает: там другая
    // семья сессий, и перехват настоящий.
    if (heldBy(current, actor, now) && current !== null) {
      return current;
    }

    if (current?.version !== input.expectedLeaseVersion) {
      throw new AppError('CONFLICT', {
        message: 'stale lease version',
        publicMessage: 'Блокировка уже изменилась. Обновите страницу и повторите.',
        conflict: { kind: 'EDIT_LOCK_STALE' },
      });
    }

    const previousHolder = current.holderUserId;
    const lease = await grantLease(tx, routeId, actor, now);

    await writeAudit(tx, {
      action: 'ROUTE_EDIT_LOCK_TAKEN_OVER',
      entityType: 'DeliveryRoute',
      entityId: routeId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      // Причина остаётся в защищённом аудите и в realtime не уходит.
      oldValue: { holderUserId: previousHolder, leaseVersion: input.expectedLeaseVersion },
      newValue: { holderUserId: actor.userId, leaseVersion: lease.version, reason: input.reason },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishLease(tx, 'route.edit_lock_taken_over', routeId, actor.userId);
    // Прежний держатель узнаёт лично: общее событие он мог бы и не связать с собой.
    await publishRealtimeEvent(tx, {
      topic: 'route.edit_lock_taken_over',
      payload: { routeId, holderUserId: actor.userId },
      audienceUserId: previousHolder,
    });

    return lease;
  });
}

export function assertReason(reason: string): void {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON || trimmed.length > MAX_REASON) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'reason length is out of range',
      publicMessage: `Причина должна содержать от ${MIN_REASON} до ${MAX_REASON} символов.`,
    });
  }
}

/** Состояние блокировки для карточки маршрута. */
export function describeLease(
  lease: (LeaseRow & { holder?: { id: string; fullName: string } }) | null,
  actor: AuthenticatedActor,
  now: Date,
): LeaseView {
  if (!isActive(lease, now) || lease === null) {
    return {
      locked: false,
      heldByCurrentSession: false,
      holder: null,
      expiresAt: null,
      leaseVersion: null,
    };
  }

  return {
    locked: true,
    heldByCurrentSession: heldBy(lease, actor, now),
    // Ни телефона, ни семьи сессий: только кто именно держит маршрут.
    holder: lease.holder ?? null,
    expiresAt: lease.expiresAt.toISOString(),
    leaseVersion: lease.version,
  };
}

interface RouteStateRow {
  id: string;
  state: 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
}

/** Блокирует маршрут перед работой с арендой: порядок Route → Lease единый. */
async function lockRouteForLease(tx: TransactionClient, routeId: string): Promise<RouteStateRow> {
  const rows = await tx.$queryRaw<RouteStateRow[]>`
    SELECT "id", "state" FROM "DeliveryRoute" WHERE "id" = ${routeId}::uuid FOR UPDATE
  `;
  const route = rows[0];
  if (route === undefined) {
    throw new AppError('NOT_FOUND', { message: 'route not found' });
  }
  return route;
}
