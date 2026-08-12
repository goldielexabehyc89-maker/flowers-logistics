/**
 * Справочник складских ячеек — этап 6.4.
 *
 * Границы решения владельца `FUL-003` и `FUL-004`: ячейка — физическое место
 * внутри склада, она не расширяет логистический `Depot`. Размещения заказов,
 * комплектование маршрутного листа и выдача сюда НЕ входят и появятся
 * отдельными срезами.
 *
 * Ячейками управляет только `ADMIN`. Кладовщик читает активные и разрешает
 * отсканированный код: без этого он не сможет положить заказ на полку,
 * но и завести новую полку сам не вправе.
 */

import { Prisma, type $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { normalizeCellCode } from './cell-code.js';

/** Читают справочник администратор и кладовщик; изменяет только администратор. */
export const CELL_READ_ROLES = ['ADMIN', 'WAREHOUSE'] as const;
export const CELL_WRITE_ROLES = ['ADMIN'] as const;

/** Кому адресуются события справочника. Тот же список, что и права на чтение. */
export const CELL_AUDIENCE = ['ADMIN', 'WAREHOUSE'] as const;

export type StorageCellKind = $Enums.StorageCellKind;

export const MAX_LIMIT = 500;

export interface StorageCellRow {
  id: string;
  code: string;
  normalizedCode: string;
  kind: StorageCellKind;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const CELL_SELECT = {
  id: true,
  code: true,
  normalizedCode: true,
  kind: true,
  isActive: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

// --- Занятость ячейки -------------------------------------------------------

/**
 * Что известно о содержимом ячейки.
 *
 * `UNKNOWN` — не «наверное пусто», а «модели размещений ещё нет». Разница
 * принципиальная: смена типа у занятой ячейки означала бы, что заказы,
 * лежащие в ней физически, вдруг считаются лежащими в маршрутной ячейке
 * несуществующего маршрута.
 */
export type CellOccupancy = 'EMPTY' | 'OCCUPIED' | 'UNKNOWN';

/**
 * Порт, через который модуль размещений сообщит о занятости ячейки.
 *
 * Он объявлен здесь и обязателен в зависимостях, а не спрятан внутри: пока
 * реализации нет, вызов физически не может «забыть» проверку и пройти мимо неё.
 */
export type OccupancyProbe = (
  client: Database | TransactionClient,
  cellId: string,
) => Promise<CellOccupancy>;

/**
 * Реализация по умолчанию до появления размещений.
 *
 * Отвечает «неизвестно» и тем самым закрывает смену типа. Ослаблять правило
 * до «раз размещений нет — значит пусто» нельзя: сегодня их нет, а завтра
 * появятся, и молчаливое допущение переживёт своё основание.
 */
export const unknownOccupancy: OccupancyProbe = async () => 'UNKNOWN';

export interface CellDeps {
  db: Database;
  occupancy: OccupancyProbe;
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

// --- Чтение -----------------------------------------------------------------

export interface ListInput {
  /** `null` — без сужения. Кладовщику сервер принудительно подставляет `true`. */
  isActive: boolean | null;
  kind: StorageCellKind | null;
  limit: number;
  offset: number;
}

export interface ListResult {
  items: StorageCellRow[];
  total: number;
  limit: number;
  offset: number;
  /** Счётчики по типам среди активных: сколько полок вообще заведено. */
  activeByKind: Record<StorageCellKind, number>;
}

export async function listStorageCells(db: Database, input: ListInput): Promise<ListResult> {
  const where = {
    ...(input.isActive === null ? {} : { isActive: input.isActive }),
    ...(input.kind === null ? {} : { kind: input.kind }),
  };

  const [items, total, active] = await Promise.all([
    db.storageCell.findMany({
      where,
      // Порядок по нормализованному коду: он уникален, поэтому сортировка
      // однозначна и страницы не разъезжаются.
      orderBy: { normalizedCode: 'asc' },
      take: input.limit,
      skip: input.offset,
      select: CELL_SELECT,
    }),
    db.storageCell.count({ where }),
    db.storageCell.groupBy({ by: ['kind'], where: { isActive: true }, _count: { _all: true } }),
  ]);

  const activeByKind: Record<StorageCellKind, number> = { STORAGE: 0, ROUTE: 0 };
  for (const row of active) {
    activeByKind[row.kind] = row._count._all;
  }

  return { items, total, limit: input.limit, offset: input.offset, activeByKind };
}

/**
 * Разрешение отсканированного кода.
 *
 * Поиск идёт по уникальному нормализованному коду и через `findUnique`:
 * неоднозначности здесь не бывает по устройству индекса, а выборка «первый
 * попавшийся» не может появиться даже случайно — такого запроса просто нет.
 *
 * `onlyActive` для кладовщика обязателен: выключенную полку ему предлагать
 * нельзя, иначе заказ уедет в ячейку, которую администратор уже вывел из работы.
 */
export async function resolveStorageCell(
  db: Database,
  scannedCode: string,
  options: { onlyActive: boolean },
): Promise<StorageCellRow> {
  const { normalizedCode } = normalizeCellCode(scannedCode);

  const cell = await db.storageCell.findUnique({
    where: { normalizedCode },
    select: CELL_SELECT,
  });

  if (cell === null) {
    throw new AppError('NOT_FOUND', {
      message: 'storage cell not found',
      publicMessage: 'Ячейка с таким кодом не найдена.',
    });
  }

  if (options.onlyActive && !cell.isActive) {
    throw new AppError('NOT_FOUND', {
      message: 'storage cell is inactive',
      publicMessage: 'Ячейка выключена и в работе не используется.',
    });
  }

  return cell;
}

export async function getStorageCell(db: Database, id: string): Promise<StorageCellRow> {
  const cell = await db.storageCell.findUnique({ where: { id }, select: CELL_SELECT });
  if (cell === null) {
    throw new AppError('NOT_FOUND', { message: 'storage cell not found' });
  }
  return cell;
}

// --- Изменения --------------------------------------------------------------

async function publishChange(tx: TransactionClient, cellId: string): Promise<void> {
  // В payload только идентификатор. Код ячейки — это то, что написано на полке
  // и напечатано на этикетке; рассылать его подписчикам незачем, клиент
  // перезапрашивает справочник сам.
  await publishRealtimeEvent(tx, {
    topic: 'storage_cell.changed',
    payload: { cellId },
    audienceRoles: [...CELL_AUDIENCE],
  });
}

export interface CreateInput {
  code: string;
  kind: StorageCellKind;
}

export async function createStorageCell(
  deps: CellDeps,
  actor: AuthenticatedActor,
  input: CreateInput,
  context: RequestContext,
): Promise<StorageCellRow> {
  const { code, normalizedCode } = normalizeCellCode(input.code);

  try {
    return await deps.db.$transaction(async (tx: TransactionClient) => {
      const created = await tx.storageCell.create({
        data: { code, normalizedCode, kind: input.kind, createdById: actor.userId },
        select: CELL_SELECT,
      });

      await writeAudit(tx, {
        action: 'STORAGE_CELL_CREATED',
        entityType: 'StorageCell',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        source: 'api',
        // Именно `cellCode`, а не `code`: слово `code` в этом проекте занято
        // одноразовыми кодами активации, и общая защита аудита обязана
        // продолжать отклонять его без исключений для складских полок.
        newValue: { cellCode: created.code, kind: created.kind, isActive: created.isActive },
        ip: context.ip,
        userAgent: context.userAgent,
      });

      await publishChange(tx, created.id);
      return created;
    });
  } catch (error) {
    // Гонка двух администраторов: оба проверили отсутствие кода и оба дошли
    // до вставки. Выигрывает один, второй нарушает уникальный индекс —
    // проверка «сначала найти, потом создать» такую гонку не ловит,
    // потому что параллельные транзакции не видят незафиксированных вставок.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError('CONFLICT', {
        message: 'storage cell code already exists',
        publicMessage: 'Ячейка с таким кодом уже существует.',
        conflict: { kind: 'CELL_CODE_TAKEN' },
      });
    }
    throw error;
  }
}

/** Общая часть изменения: блокировка строки и сверка ожидаемой версии. */
async function lockForUpdate(
  tx: TransactionClient,
  id: string,
  expectedVersion: number,
): Promise<StorageCellRow> {
  const rows = await tx.$queryRaw<StorageCellRow[]>`
    SELECT "id", "code", "normalizedCode", "kind", "isActive", "version", "createdAt", "updatedAt"
    FROM "StorageCell" WHERE "id" = ${id}::uuid FOR UPDATE
  `;
  const cell = rows[0];

  if (cell === undefined) {
    throw new AppError('NOT_FOUND', { message: 'storage cell not found' });
  }
  if (cell.version !== expectedVersion) {
    throw new AppError('CONFLICT', {
      message: 'optimistic lock conflict',
      publicMessage: 'Ячейка изменена другим пользователем. Обновите список и повторите.',
      conflict: { kind: 'STALE_VERSION' },
    });
  }
  return cell;
}

export interface ChangeKindInput {
  kind: StorageCellKind;
  expectedVersion: number;
}

/**
 * Смена типа ячейки.
 *
 * Разрешена только у ПУСТОЙ ячейки (`FUL-003`). Пока модуля размещений нет,
 * занятость неизвестна, и операция честно отказывает кодом
 * `CELL_OCCUPANCY_UNKNOWN`. Считать неизвестное пустым нельзя: ровно на этом
 * допущении заказы и уезжают не туда.
 */
export async function changeStorageCellKind(
  deps: CellDeps,
  actor: AuthenticatedActor,
  id: string,
  input: ChangeKindInput,
  context: RequestContext,
): Promise<StorageCellRow> {
  return deps.db.$transaction(async (tx: TransactionClient) => {
    const cell = await lockForUpdate(tx, id, input.expectedVersion);

    if (cell.kind === input.kind) {
      // Тип уже такой: менять нечего, и занятость спрашивать незачем.
      // Повтор не должен ни увеличивать версию, ни писать аудит и событие.
      return cell;
    }

    const occupancy = await deps.occupancy(tx, id);
    if (occupancy !== 'EMPTY') {
      throw new AppError('CONFLICT', {
        message: `storage cell occupancy is ${occupancy}`,
        publicMessage:
          occupancy === 'OCCUPIED'
            ? 'В ячейке есть заказы. Освободите её и повторите.'
            : 'Пока нельзя подтвердить, что ячейка пуста: учёт размещений ещё не введён.',
        conflict: { kind: occupancy === 'OCCUPIED' ? 'CELL_NOT_EMPTY' : 'CELL_OCCUPANCY_UNKNOWN' },
      });
    }

    const updated = await tx.storageCell.update({
      where: { id },
      data: { kind: input.kind, changedById: actor.userId, version: { increment: 1 } },
      select: CELL_SELECT,
    });

    await writeAudit(tx, {
      action: 'STORAGE_CELL_KIND_CHANGED',
      entityType: 'StorageCell',
      entityId: id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      oldValue: { kind: cell.kind },
      newValue: { kind: updated.kind, version: updated.version },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishChange(tx, id);
    return updated;
  });
}

export interface SetActiveInput {
  isActive: boolean;
  expectedVersion: number;
}

export async function setStorageCellActive(
  deps: CellDeps,
  actor: AuthenticatedActor,
  id: string,
  input: SetActiveInput,
  context: RequestContext,
): Promise<StorageCellRow> {
  return deps.db.$transaction(async (tx: TransactionClient) => {
    const cell = await lockForUpdate(tx, id, input.expectedVersion);

    if (cell.isActive === input.isActive) {
      return cell;
    }

    const updated = await tx.storageCell.update({
      where: { id },
      data: { isActive: input.isActive, changedById: actor.userId, version: { increment: 1 } },
      select: CELL_SELECT,
    });

    await writeAudit(tx, {
      action: input.isActive ? 'STORAGE_CELL_ACTIVATED' : 'STORAGE_CELL_DEACTIVATED',
      entityType: 'StorageCell',
      entityId: id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      oldValue: { isActive: cell.isActive },
      newValue: { isActive: updated.isActive, version: updated.version },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishChange(tx, id);
    return updated;
  });
}
