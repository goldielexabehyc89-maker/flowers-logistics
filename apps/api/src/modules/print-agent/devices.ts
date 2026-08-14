/**
 * Реестр локальных обработчиков печати.
 *
 * ОДИН ОСНОВНОЙ ОБРАБОТЧИК НА ВСЮ СИСТЕМУ. Площадка одна (`FUL-010`), поля
 * «площадка» нет, `Depot` не используется (`FUL-004`). Новые задания получает
 * только основной; остальные зарегистрированные устройства существуют, чтобы
 * замена компьютера не начиналась с отзыва работающего.
 *
 * ИНВАРИАНТ ДЕРЖИТ БАЗА. `primaryKey` уникален и может содержать только
 * `PRIMARY`; CHECK запрещает основной статус у отозванного устройства.
 * Проверка в коде здесь не годилась бы: два одновременных «сделать основным»
 * прошли бы обе проверки и оставили бы два основных обработчика — то есть
 * два бланка на один букет.
 */

import type { Role } from '@fl/shared';
import { AppError } from '../../platform/errors.js';
import type { Database } from '../../platform/db.js';
import type { TransactionClient } from '../auth/sessions.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';

/** Постоянное значение `primaryKey`. Уникальный индекс делает его единственным. */
export const PRIMARY_SENTINEL = 'PRIMARY';

/**
 * Через сколько молчания устройство считается не в сети.
 *
 * Значение сравнивается с `lastSeenAt` ПРИ ЧТЕНИИ, а не выставляется таймером:
 * состояние, которое зависит от того, успел ли отработать фоновой процесс,
 * показывало бы «в сети» у выключенного компьютера ровно тогда, когда это
 * важнее всего — при разборе непечатающегося заказа.
 */
export const DEVICE_OFFLINE_AFTER_MS = 60_000;

export interface DeviceActor {
  userId: string;
  roles: readonly Role[];
}

export interface RequestContext {
  ip: string;
  userAgent: string | null;
}

export interface PrintDeviceView {
  id: string;
  name: string;
  state: string;
  isPrimary: boolean;
  /** Считается от `lastSeenAt`, а не хранится: см. `DEVICE_OFFLINE_AFTER_MS`. */
  online: boolean;
  os: string | null;
  agentVersion: string | null;
  /** Принтер по умолчанию на момент последней связи. Это отчёт, а не настройка. */
  defaultPrinterName: string | null;
  lastSeenAt: string | null;
  lastSucceededJobId: string | null;
  lastSucceededAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
  pairedAt: string;
  revokedAt: string | null;
}

const DEVICE_SELECT = {
  id: true,
  name: true,
  state: true,
  primaryKey: true,
  os: true,
  agentVersion: true,
  defaultPrinterName: true,
  lastSeenAt: true,
  lastSucceededJobId: true,
  lastSucceededAt: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  lastErrorAt: true,
  pairedAt: true,
  revokedAt: true,
} as const;

interface DeviceRow {
  id: string;
  name: string;
  state: string;
  primaryKey: string | null;
  os: string | null;
  agentVersion: string | null;
  defaultPrinterName: string | null;
  lastSeenAt: Date | null;
  lastSucceededJobId: string | null;
  lastSucceededAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: Date | null;
  pairedAt: Date;
  revokedAt: Date | null;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function toDeviceView(row: DeviceRow, now: Date = new Date()): PrintDeviceView {
  const online =
    row.state !== 'REVOKED' &&
    row.lastSeenAt !== null &&
    now.getTime() - row.lastSeenAt.getTime() < DEVICE_OFFLINE_AFTER_MS;

  return {
    id: row.id,
    name: row.name,
    // Отозванное устройство остаётся отозванным; молчащее показывается
    // отключённым, даже если фоновой процесс ещё не переписал колонку.
    state: row.state === 'REVOKED' ? 'REVOKED' : online ? 'CONNECTED' : 'DISCONNECTED',
    isPrimary: row.primaryKey !== null,
    online,
    os: row.os,
    agentVersion: row.agentVersion,
    defaultPrinterName: row.defaultPrinterName,
    lastSeenAt: iso(row.lastSeenAt),
    lastSucceededJobId: row.lastSucceededJobId,
    lastSucceededAt: iso(row.lastSucceededAt),
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    lastErrorAt: iso(row.lastErrorAt),
    pairedAt: row.pairedAt.toISOString(),
    revokedAt: iso(row.revokedAt),
  };
}

/**
 * Реестр устройств.
 *
 * Отозванные показываются вместе с остальными: администратор, заменивший
 * компьютер, должен видеть, что старый именно отозван, а не исчез.
 */
export async function listDevices(db: Database): Promise<{ items: PrintDeviceView[] }> {
  const rows = (await db.printAgentDevice.findMany({
    // Основное первым, затем свежие по связи: список читают сверху вниз.
    orderBy: [{ primaryKey: { sort: 'asc', nulls: 'last' } }, { pairedAt: 'desc' }],
    select: DEVICE_SELECT,
  })) as DeviceRow[];

  const now = new Date();
  return { items: rows.map((row) => toDeviceView(row, now)) };
}

async function readDevice(db: Database, deviceId: string): Promise<DeviceRow> {
  const row = (await db.printAgentDevice.findUnique({
    where: { id: deviceId },
    select: DEVICE_SELECT,
  })) as DeviceRow | null;

  if (row === null) {
    throw new AppError('NOT_FOUND', { message: 'print agent device not found' });
  }
  return row;
}

/**
 * Назначение основного обработчика.
 *
 * Снятие прежнего и назначение нового — одна транзакция под advisory-блокировкой.
 * Без неё два запроса сняли бы флаг с одного и того же прежнего основного,
 * а затем оба попытались бы поставить его себе: уникальный индекс отклонил бы
 * второго сырой ошибкой, то есть 500 вместо понятного результата.
 *
 * Отозванное устройство основным не становится: CHECK базы это запрещает,
 * и проверка здесь нужна лишь для того, чтобы отказ был человеческим.
 */
export async function setPrimaryDevice(
  db: Database,
  actor: DeviceActor,
  deviceId: string,
  context: RequestContext,
): Promise<PrintDeviceView> {
  const updated = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('print-agent:primary'))`;

    const device = (await tx.printAgentDevice.findUnique({
      where: { id: deviceId },
      select: DEVICE_SELECT,
    })) as DeviceRow | null;

    if (device === null) {
      throw new AppError('NOT_FOUND', { message: 'print agent device not found' });
    }
    if (device.state === 'REVOKED') {
      throw new AppError('CONFLICT', {
        message: 'revoked device cannot be primary',
        publicMessage: 'Отозванное устройство нельзя сделать основным.',
      });
    }

    if (device.primaryKey !== null) {
      // Уже основное. Повторное нажатие не считается ошибкой и ничего не меняет.
      return device;
    }

    const previous = await tx.printAgentDevice.findFirst({
      where: { primaryKey: { not: null } },
      select: { id: true },
    });

    if (previous !== null) {
      await tx.printAgentDevice.update({
        where: { id: previous.id },
        data: { primaryKey: null },
      });
    }

    const row = (await tx.printAgentDevice.update({
      where: { id: deviceId },
      data: { primaryKey: PRIMARY_SENTINEL },
      select: DEVICE_SELECT,
    })) as DeviceRow;

    await writeAudit(tx, {
      action: 'PRINT_AGENT_DEVICE_PRIMARY_CHANGED',
      entityType: 'PrintAgentDevice',
      entityId: deviceId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      oldValue: previous === null ? null : { previousPrimaryDeviceId: previous.id },
      newValue: { deviceId },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    await publishDeviceEvent(tx, deviceId, 'PRIMARY_CHANGED');

    return row;
  });

  return toDeviceView(updated);
}

/**
 * Отзыв устройства.
 *
 * Немедленно закрывает доступ: охрана перечитывает состояние при каждом
 * запросе, поэтому отозванный компьютер теряет право получать и подтверждать
 * задания в тот же миг, а не когда истечёт какой-нибудь срок.
 *
 * Задания, которые устройство успело взять, возвращать в очередь автоматически
 * нельзя: взятое могло уже уйти на бумагу. Незапущенные (`CLAIMED`) — можно,
 * их точно не печатали; неоднозначные (`PRINTING`) уходят человеку.
 */
export async function revokeDevice(
  db: Database,
  actor: DeviceActor,
  deviceId: string,
  context: RequestContext,
): Promise<PrintDeviceView> {
  const updated = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('print-agent:primary'))`;

    const changed = await tx.printAgentDevice.updateMany({
      // Условие в WHERE, а не проверка «до»: повторный отзыв не должен
      // переписать время и автора первого.
      where: { id: deviceId, state: { in: ['CONNECTED', 'DISCONNECTED'] } },
      data: {
        state: 'REVOKED',
        revokedAt: new Date(),
        revokedById: actor.userId,
        // Отозванное устройство не может остаться основным: этого не допускает
        // и CHECK базы. Система остаётся без основного обработчика осознанно —
        // молча передать роль другому значило бы начать печатать на компьютере,
        // которого администратор для этого не выбирал.
        primaryKey: null,
      },
    });

    if (changed.count === 0) {
      const existing = await tx.printAgentDevice.findUnique({
        where: { id: deviceId },
        select: { id: true },
      });
      if (existing === null) {
        throw new AppError('NOT_FOUND', { message: 'print agent device not found' });
      }
      throw new AppError('CONFLICT', {
        message: 'device already revoked',
        publicMessage: 'Устройство уже отключено.',
      });
    }

    // Взятые, но ещё не отправленные на печать задания возвращаются в очередь:
    // они точно не печатались.
    await tx.orderPrintJob.updateMany({
      where: { deviceId, state: 'CLAIMED' },
      data: { state: 'PENDING', deviceId: null, claimedAt: null },
    });

    // Отправленные в печать — неоднозначны и уходят человеку.
    await tx.orderPrintJob.updateMany({
      where: { deviceId, state: 'PRINTING' },
      data: {
        state: 'NEEDS_REVIEW',
        lastErrorCode: 'DEVICE_REVOKED',
        lastErrorMessage: 'Устройство отключили, пока документ был в печати. Проверьте бумагу.',
        lastErrorAt: new Date(),
      },
    });

    const row = (await tx.printAgentDevice.findUniqueOrThrow({
      where: { id: deviceId },
      select: DEVICE_SELECT,
    })) as DeviceRow;

    await writeAudit(tx, {
      action: 'PRINT_AGENT_DEVICE_REVOKED',
      entityType: 'PrintAgentDevice',
      entityId: deviceId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { deviceId },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    await publishDeviceEvent(tx, deviceId, 'REVOKED');

    return row;
  });

  return toDeviceView(updated);
}

/** Устройство по идентификатору. Используется настройками после действий. */
export async function getDevice(db: Database, deviceId: string): Promise<PrintDeviceView> {
  return toDeviceView(await readDevice(db, deviceId));
}

/**
 * Событие изменения реестра устройств.
 *
 * Адресуется только ADMIN: устройствами управляет он. Ни токена, ни имени
 * принтера, ни кода привязки в payload нет — клиент перезапрашивает список сам.
 */
export async function publishDeviceEvent(
  tx: TransactionClient,
  deviceId: string,
  kind: 'PAIRED' | 'PRIMARY_CHANGED' | 'REVOKED',
): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic: 'print_agent.device_changed',
    payload: { deviceId, kind },
    audienceRoles: ['ADMIN'],
  });
}
