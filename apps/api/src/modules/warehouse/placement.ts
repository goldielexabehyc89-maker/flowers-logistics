/**
 * Фактическое движение заказов по складу — этап 6.5.
 *
 * Три операции одного домена: приёмка в ячейку, перенос в маршрутную ячейку
 * и выдача курьеру. Все три меняют ОДНУ вещь — где физически лежит заказ, —
 * поэтому живут вместе и пользуются общим порядком блокировок.
 *
 * Главная граница (`FUL-001`, `FUL-002`): склад НЕ проверяет и не требует ни
 * состояния «Собран», ни назначенного флориста, ни состояния печати. Вход —
 * физический QR: однозначный заказ и активная ячейка. Коробка уже стоит перед
 * кладовщиком, и отказать ему из-за чужого программного состояния значило бы
 * потерять её фактическое местоположение.
 *
 * Порядок блокировок повторяет уже принятый в проекте:
 *
 *   приёмка и изъятие:      DeliveryOrder → OrderPlacement → StorageCell
 *   комплектование, выдача: DeliveryRoute → RouteCellBinding/RouteIssueSession
 *                           → DeliveryOrder → OrderPlacement
 *
 * Смешивать две дорожки в одной транзакции нельзя: встречный порядок
 * `Order → Route` и `Route → Order` — это взаимная блокировка.
 */

import { Prisma, type $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { normalizeCellCode } from './cell-code.js';
import { blockingFlags, resolveOrderByNumber, type ResolvedOrder } from './order-lookup.js';

/** Складские операции доступны кладовщику и администратору. */
export const FLOW_ROLES = ['ADMIN', 'WAREHOUSE'] as const;
/** Отмена сессии выдачи — только администратор. */
export const FLOW_ADMIN_ROLES = ['ADMIN'] as const;

/** Складские события. Логист видит их в маршрутных листах и «Сделках». */
export const FLOW_AUDIENCE = ['ADMIN', 'WAREHOUSE', 'LOGISTICIAN'] as const;

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface FlowDeps {
  db: Database;
}

// --- Общие помощники ---------------------------------------------------------

interface LockedCell {
  id: string;
  code: string;
  normalizedCode: string;
  kind: $Enums.StorageCellKind;
  isActive: boolean;
}

/**
 * Ячейка по отсканированному коду.
 *
 * `requireActive` обязателен для приёма нового заказа: выключенная полка
 * выведена администратором из работы, и класть туда нельзя. Но забрать заказ
 * из выключенной ячейки можно всегда — иначе он остался бы там навсегда.
 */
async function resolveCell(
  tx: TransactionClient,
  scannedCode: string,
  options: { requireActive: boolean },
): Promise<LockedCell> {
  const { normalizedCode } = normalizeCellCode(scannedCode);

  const cell = await tx.storageCell.findUnique({
    where: { normalizedCode },
    select: { id: true, code: true, normalizedCode: true, kind: true, isActive: true },
  });

  if (cell === null) {
    throw new AppError('NOT_FOUND', {
      message: 'storage cell not found',
      publicMessage: 'Ячейка с таким кодом не найдена.',
    });
  }
  if (options.requireActive && !cell.isActive) {
    throw new AppError('CONFLICT', {
      message: 'storage cell is inactive',
      publicMessage: 'Ячейка выключена: положить в неё заказ нельзя.',
      conflict: { kind: 'CELL_INACTIVE' },
    });
  }
  return cell;
}

/** Блокирует строку заказа: с неё начинается любая складская транзакция. */
async function lockOrder(tx: TransactionClient, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "DeliveryOrder" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
}

interface ActivePlacement {
  id: string;
  cellId: string;
  requiresRelocation: boolean;
}

async function activePlacement(
  tx: TransactionClient,
  orderId: string,
): Promise<ActivePlacement | null> {
  const rows = await tx.$queryRaw<ActivePlacement[]>`
    SELECT "id", "cellId", "requiresRelocation"
    FROM "OrderPlacement"
    WHERE "orderId" = ${orderId}::uuid AND "releasedAt" IS NULL
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function publishPlacement(
  tx: TransactionClient,
  payload: Record<string, string | number | boolean | null>,
): Promise<void> {
  // Ни номера заказа, ни кода ячейки, ни адреса: только идентификаторы
  // и вид действия. Клиент перезапрашивает список сам.
  await publishRealtimeEvent(tx, {
    topic: 'warehouse.placement_changed',
    payload,
    audienceRoles: [...FLOW_AUDIENCE],
  });
}

/** Ошибка гонки двух одновременных сканирований одного заказа. */
function placementRace(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new AppError('CONFLICT', {
      message: 'concurrent placement',
      publicMessage: 'Заказ в этот момент размещает другой сотрудник. Обновите экран и повторите.',
      conflict: { kind: 'PLACEMENT_RACE' },
    });
  }
  throw error;
}

// --- Занятость ячейки --------------------------------------------------------

/**
 * Фактическая занятость ячейки для справочника ячеек.
 *
 * Это и есть та реализация, ради которой в срезе 6.4 был заведён порт:
 * теперь тип ячейки можно менять, и «пусто» означает пусто на самом деле.
 */
export async function countActivePlacements(
  client: Database | TransactionClient,
  cellId: string,
): Promise<number> {
  return client.orderPlacement.count({ where: { cellId, releasedAt: null } });
}

// --- Приёмка -----------------------------------------------------------------

export interface ReceiveInput {
  /** Отсканированный номер заказа. */
  orderNumber: string;
  /** Отсканированный код ячейки. */
  cellCode: string;
  /**
   * Разрешает класть в маршрутную ячейку сразу при приёмке. Без него ячейка
   * типа `ROUTE` при обычной приёмке отвергается: попасть туда заказ должен
   * осознанно, а не потому, что рядом лежала не та наклейка.
   */
  allowRouteCell?: boolean;
}

export interface PlacementResult {
  orderId: string;
  orderNumber: string;
  cellId: string;
  cellCode: string;
  cellKind: $Enums.StorageCellKind;
  placementId: string;
  /** Операция ничего не изменила: заказ уже лежал именно здесь. */
  unchanged: boolean;
  /** Признаки, из-за которых заказ не пойдёт в обычное комплектование и выдачу. */
  blockedBy: string[];
}

/**
 * Приёмка заказа в ячейку одной атомарной парой сканов.
 *
 * Пара приходит ОДНОЙ командой намеренно: между сканом заказа и сканом ячейки
 * человек может уйти, и промежуточная запись «принят, но неизвестно куда»
 * означала бы заказ, которого нет ни на полке, ни в руках (`FUL-003`).
 *
 * Повтор той же пары идемпотентен: сканер часто срабатывает дважды.
 */
export async function receiveOrder(
  deps: FlowDeps,
  actor: AuthenticatedActor,
  input: ReceiveInput,
  context: RequestContext,
): Promise<PlacementResult> {
  return deps.db
    .$transaction(async (tx: TransactionClient) => {
      const order = await resolveOrderByNumber(tx, input.orderNumber);
      await lockOrder(tx, order.id);

      const cell = await resolveCell(tx, input.cellCode, { requireActive: true });

      if (cell.kind === 'ROUTE' && input.allowRouteCell !== true) {
        throw new AppError('CONFLICT', {
          message: 'route cell requires explicit choice',
          publicMessage:
            'Это маршрутная ячейка. Подтвердите, что заказ кладётся сразу в маршрутный лист.',
          conflict: { kind: 'ROUTE_CELL_REQUIRES_CHOICE' },
        });
      }

      const current = await activePlacement(tx, order.id);

      if (current !== null && current.cellId === cell.id) {
        // Тот же заказ в той же ячейке: повтор скана ничего не меняет.
        return {
          result: toResult(order, cell, current.id, true),
          changed: false,
        };
      }

      const now = new Date();
      if (current !== null) {
        await tx.orderPlacement.update({
          where: { id: current.id },
          data: {
            releasedAt: now,
            releasedById: actor.userId,
            releaseReason: 'MOVED_TO_STORAGE',
            movedToCellId: cell.id,
          },
        });
      }

      const created = await tx.orderPlacement.create({
        data: {
          orderId: order.id,
          cellId: cell.id,
          fromCellId: current === null ? null : current.cellId,
          source: current === null ? 'RECEIVED' : 'MOVED',
          placedAt: now,
          placedById: actor.userId,
        },
        select: { id: true },
      });

      await writeAudit(tx, {
        action: current === null ? 'WAREHOUSE_ORDER_RECEIVED' : 'WAREHOUSE_ORDER_MOVED',
        entityType: 'OrderPlacement',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        source: 'api',
        oldValue: current === null ? null : { cellId: current.cellId },
        newValue: { orderId: order.id, cellId: cell.id, cellKind: cell.kind },
        ip: context.ip,
        userAgent: context.userAgent,
      });

      await publishPlacement(tx, {
        orderId: order.id,
        cellId: cell.id,
        action: current === null ? 'RECEIVED' : 'MOVED',
      });

      return { result: toResult(order, cell, created.id, false), changed: true };
    })
    .then((outcome) => outcome.result)
    .catch(placementRace);
}

function toResult(
  order: ResolvedOrder,
  cell: LockedCell,
  placementId: string,
  unchanged: boolean,
): PlacementResult {
  return {
    orderId: order.id,
    orderNumber: order.number,
    cellId: cell.id,
    cellCode: cell.code,
    cellKind: cell.kind,
    placementId,
    unchanged,
    blockedBy: blockingFlags(order),
  };
}

// --- Изъятие -----------------------------------------------------------------

export interface WithdrawInput {
  orderNumber: string;
  reason: string;
}

/**
 * Изъятие заказа со склада без выдачи: брак, отмена, возврат флористу.
 *
 * Нужно затем, чтобы отменённый или требующий пересборки заказ имел штатный
 * выход из ячейки. Без него единственным способом «убрать» его осталась бы
 * выдача курьеру, то есть ложь в истории.
 */
export async function withdrawOrder(
  deps: FlowDeps,
  actor: AuthenticatedActor,
  input: WithdrawInput,
  context: RequestContext,
): Promise<{ orderId: string; orderNumber: string; withdrawn: boolean }> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'withdraw reason is required',
      publicMessage: 'Укажите причину изъятия: от 3 до 500 символов.',
    });
  }

  return deps.db.$transaction(async (tx: TransactionClient) => {
    const order = await resolveOrderByNumber(tx, input.orderNumber);
    await lockOrder(tx, order.id);

    const current = await activePlacement(tx, order.id);
    if (current === null) {
      // Повтор изъятия: заказа на складе уже нет, и это не ошибка.
      return { orderId: order.id, orderNumber: order.number, withdrawn: false };
    }

    await tx.orderPlacement.update({
      where: { id: current.id },
      data: {
        releasedAt: new Date(),
        releasedById: actor.userId,
        releaseReason: 'WITHDRAWN',
      },
    });

    await writeAudit(tx, {
      action: 'WAREHOUSE_ORDER_WITHDRAWN',
      entityType: 'OrderPlacement',
      entityId: current.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      oldValue: { cellId: current.cellId },
      newValue: { orderId: order.id, reason },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishPlacement(tx, { orderId: order.id, cellId: null, action: 'WITHDRAWN' });

    return { orderId: order.id, orderNumber: order.number, withdrawn: true };
  });
}
