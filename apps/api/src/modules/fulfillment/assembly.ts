/**
 * Назначение и сборка заказа.
 *
 * ЗАХВАТ АТОМАРЕН, И ЭТО ГЛАВНОЕ.
 *
 * «Взять в работу» — не «проверить, свободен ли заказ, и записать себя»: между
 * проверкой и записью успевает пройти второй флорист, и заказ окажется у двоих
 * сразу. Поэтому захват — ОДИН условный `UPDATE ... WHERE state = 'NEW'`.
 * Проигравший получает ноль изменённых строк, отвечает 409 и НЕ пишет ни аудита,
 * ни realtime: события «взял заказ» у того, кто его не взял, быть не должно.
 *
 * ВЕРСИЯ ПРОЦЕССА ОТДЕЛЬНАЯ.
 *
 * Общая колонка `version` принадлежит синхронизации и растёт при каждом внешнем
 * изменении заказа. Опирайся действия флориста на неё — обычный delta-проход
 * отменял бы «Собран» как «устаревшую версию», хотя ничего конкурирующего не
 * происходило. `fulfillmentProcessVersion` меняется только этим модулем.
 *
 * «СОБРАН» — ОДНА ТРАНЗАКЦИЯ.
 *
 * Проверка назначения и версии, фиксация состояния, ссылка на использованную
 * ревизию, неизменяемый снимок бланка, первоначальное задание печати, аудит
 * и событие происходят вместе или не происходят вовсе. Разорви их — и появится
 * собранный заказ без бланка, то есть букет, который нельзя принять на склад.
 */

import type { Role } from '@fl/shared';
import { AppError } from '../../platform/errors.js';
import type { Database } from '../../platform/db.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { writeAudit, type AuditAction } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { fromDateColumn } from '../integrations/moysklad/delivery-date.js';
import { effectiveMinutes } from './queue.js';
import {
  buildPrintFormSnapshot,
  snapshotHash,
  PRINT_TEMPLATE_VERSION,
  type StoredPosition,
} from './print-form.js';
import {
  FULFILLMENT_AUDIENCE,
  MIN_REASON_LENGTH,
  findActiveShift,
  type RequestContext,
} from './shifts.js';

export interface Actor {
  userId: string;
  roles: readonly Role[];
}

export interface ProcessResult {
  orderId: string;
  processState: string;
  processVersion: number;
  assigneeId: string | null;
}

function isAdmin(actor: Actor): boolean {
  return actor.roles.includes('ADMIN');
}

/** Заказ пригоден к сборке только целиком: область, источник и состав вместе. */
const ASSEMBLABLE = {
  fulfillmentInScope: true,
  sourceArchived: false,
  sourceMissing: false,
  fulfillmentCompositionState: 'READY',
} as const;

interface StoredOrder {
  id: string;
  externalName: string;
  fulfillmentProcessState: string;
  fulfillmentProcessVersion: number;
  fulfillmentAssigneeId: string | null;
  fulfillmentInScope: boolean;
  sourceArchived: boolean;
  sourceMissing: boolean;
  fulfillmentCompositionState: string;
}

async function readOrder(db: Database | TransactionClient, id: string): Promise<StoredOrder> {
  const order = await db.deliveryOrder.findUnique({
    where: { id },
    select: {
      id: true,
      externalName: true,
      fulfillmentProcessState: true,
      fulfillmentProcessVersion: true,
      fulfillmentAssigneeId: true,
      fulfillmentInScope: true,
      sourceArchived: true,
      sourceMissing: true,
      fulfillmentCompositionState: true,
    },
  });
  if (order === null) {
    throw new AppError('NOT_FOUND', { message: 'order not found' });
  }
  return order;
}

/**
 * Почему условный `UPDATE` не изменил ни одной строки.
 *
 * Причина выясняется ПОСЛЕ неудачи и только для сообщения человеку: решение
 * уже принято базой, и повторно «перепроверять» его нельзя — это вернуло бы
 * ровно ту гонку, от которой избавляет условная запись.
 */
function explainClaimFailure(order: StoredOrder): never {
  if (
    !order.fulfillmentInScope ||
    order.sourceArchived ||
    order.sourceMissing ||
    order.fulfillmentCompositionState !== 'READY'
  ) {
    throw new AppError('CONFLICT', {
      message: 'order is not assemblable',
      publicMessage:
        'Заказ нельзя взять в работу: состав ещё не подтверждён или заказ вне области.',
      conflict: { kind: 'ORDER_NOT_ASSEMBLABLE' },
    });
  }
  throw new AppError('CONFLICT', {
    message: 'order already claimed',
    publicMessage: 'Заказ уже взят другим флористом.',
    conflict: { kind: 'ORDER_ALREADY_CLAIMED' },
  });
}

/**
 * «Взять в работу»: захват и перевод в сборку одним действием.
 *
 * Отдельного состояния «Назначен» нет намеренно (`FUL-002` §2.3).
 */
export async function claimOrder(
  db: Database,
  actor: Actor,
  orderId: string,
  context: RequestContext,
): Promise<ProcessResult> {
  const shift = await findActiveShift(db, actor.userId);
  if (shift === null) {
    throw new AppError('CONFLICT', {
      message: 'active shift required',
      publicMessage: 'Сначала начните смену: без неё новый заказ взять нельзя.',
      conflict: { kind: 'FLORIST_SHIFT_REQUIRED' },
    });
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.deliveryOrder.updateMany({
      // Всё условие целиком лежит в WHERE. Ни одной проверки «до» здесь нет
      // и быть не может: именно между проверкой и записью и происходит гонка.
      where: { id: orderId, fulfillmentProcessState: 'NEW', ...ASSEMBLABLE },
      data: {
        fulfillmentProcessState: 'IN_ASSEMBLY',
        fulfillmentAssigneeId: actor.userId,
        fulfillmentAssignedAt: new Date(),
        fulfillmentShiftId: shift.id,
        fulfillmentProcessVersion: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      // Проигравший не оставляет следов: ни аудита, ни события.
      explainClaimFailure(await readOrder(tx, orderId));
    }

    const order = await readOrder(tx, orderId);
    await writeProcessAudit(tx, 'ORDER_FULFILLMENT_CLAIMED', order, actor, context, {
      shiftId: shift.id,
    });
    await publishProcessEvent(tx, order, actor.userId);
    return toResult(order);
  });
}

/**
 * Отказ от заказа до состояния «Собран».
 *
 * Флорист вправе отказаться только от своего заказа. Администратор — от любого:
 * именно этим действием разбираются незавершённые назначения после
 * принудительного завершения смены.
 */
export async function releaseOrder(
  db: Database,
  actor: Actor,
  orderId: string,
  context: RequestContext,
): Promise<ProcessResult> {
  return db.$transaction(async (tx) => {
    const updated = await tx.deliveryOrder.updateMany({
      where: {
        id: orderId,
        fulfillmentProcessState: 'IN_ASSEMBLY',
        ...(isAdmin(actor) ? {} : { fulfillmentAssigneeId: actor.userId }),
      },
      data: {
        fulfillmentProcessState: 'NEW',
        fulfillmentAssigneeId: null,
        fulfillmentAssignedAt: null,
        fulfillmentShiftId: null,
        fulfillmentProcessVersion: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      const order = await readOrder(tx, orderId);
      if (order.fulfillmentProcessState !== 'IN_ASSEMBLY') {
        throw new AppError('CONFLICT', {
          message: 'order is not in assembly',
          publicMessage: 'Отказаться можно только от заказа, который в сборке.',
          conflict: { kind: 'ORDER_PROCESS_STATE_MISMATCH' },
        });
      }
      throw new AppError('CONFLICT', {
        message: 'order assigned to another florist',
        publicMessage: 'Заказ закреплён за другим флористом.',
        conflict: { kind: 'ORDER_NOT_ASSIGNED_TO_YOU' },
      });
    }

    const order = await readOrder(tx, orderId);
    await writeProcessAudit(tx, 'ORDER_FULFILLMENT_RELEASED', order, actor, context, {});
    await publishProcessEvent(tx, order, actor.userId);
    return toResult(order);
  });
}

/**
 * Переназначение заказа администратором.
 *
 * Целевой флорист обязан быть в активной смене: назначить заказ тому, кто
 * сегодня не работает, значит потерять заказ до конца дня (`FUL-002` §2.3).
 */
export async function reassignOrder(
  db: Database,
  actor: Actor,
  input: { orderId: string; floristId: string; reason?: string | null },
  context: RequestContext,
): Promise<ProcessResult> {
  const target = await db.user.findUnique({
    where: { id: input.floristId },
    select: { id: true, status: true, roles: { select: { role: true } } },
  });

  if (target === null || target.status !== 'ACTIVE') {
    throw new AppError('NOT_FOUND', {
      message: 'florist not found',
      publicMessage: 'Сотрудник не найден или заморожен.',
    });
  }

  const canAssemble = target.roles.some((row) => row.role === 'FLORIST' || row.role === 'ADMIN');
  if (!canAssemble) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'user is not a florist',
      publicMessage: 'Назначать заказы можно только флористам.',
    });
  }

  const shift = await findActiveShift(db, input.floristId);
  if (shift === null) {
    throw new AppError('CONFLICT', {
      message: 'target florist has no active shift',
      publicMessage: 'У выбранного флориста нет активной смены.',
      conflict: { kind: 'FLORIST_NOT_ON_SHIFT' },
    });
  }

  return db.$transaction(async (tx) => {
    const before = await readOrder(tx, input.orderId);
    const updated = await tx.deliveryOrder.updateMany({
      where: {
        id: input.orderId,
        fulfillmentProcessState: { in: ['NEW', 'IN_ASSEMBLY'] },
        ...ASSEMBLABLE,
      },
      data: {
        fulfillmentProcessState: 'IN_ASSEMBLY',
        fulfillmentAssigneeId: input.floristId,
        fulfillmentAssignedAt: new Date(),
        fulfillmentShiftId: shift.id,
        fulfillmentProcessVersion: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      explainClaimFailure(await readOrder(tx, input.orderId));
    }

    const order = await readOrder(tx, input.orderId);
    await writeProcessAudit(tx, 'ORDER_FULFILLMENT_REASSIGNED', order, actor, context, {
      fromUserId: before.fulfillmentAssigneeId,
      toUserId: input.floristId,
      ...(input.reason === undefined || input.reason === null ? {} : { reason: input.reason }),
    });

    await publishProcessEvent(tx, order, actor.userId);
    // Прежний исполнитель обязан узнать, что заказа у него больше нет,
    // не перезагружая страницу.
    if (before.fulfillmentAssigneeId !== null && before.fulfillmentAssigneeId !== input.floristId) {
      await publishPersonalProcessEvent(tx, order, before.fulfillmentAssigneeId);
    }
    await publishPersonalProcessEvent(tx, order, input.floristId);

    return toResult(order);
  });
}

export interface AssembleResult extends ProcessResult {
  printFormId: string;
  printJobId: string;
  snapshotHash: string;
}

/**
 * «Собран».
 *
 * Порядок шагов внутри транзакции обязателен: сначала доказать право и версию,
 * затем зафиксировать использованную ревизию, затем неизменяемый бланк, затем
 * первоначальное задание печати, и только после этого аудит и событие.
 */
export async function assembleOrder(
  db: Database,
  actor: Actor,
  input: { orderId: string; expectedProcessVersion: number },
  context: RequestContext,
): Promise<AssembleResult> {
  return db.$transaction(async (tx) => {
    // Блокировка строки на всю транзакцию: между проверкой и записью не должен
    // вклиниться ни повторный «Собран», ни переназначение.
    const locked = await tx.$queryRaw<
      {
        id: string;
        fulfillmentProcessState: string;
        fulfillmentProcessVersion: number;
        fulfillmentAssigneeId: string | null;
      }[]
    >`
      SELECT "id",
             "fulfillmentProcessState",
             "fulfillmentProcessVersion",
             "fulfillmentAssigneeId"
      FROM "DeliveryOrder"
      WHERE "id" = ${input.orderId}::uuid
      FOR UPDATE
    `;

    const current = locked[0];
    if (current === undefined) {
      throw new AppError('NOT_FOUND', { message: 'order not found' });
    }

    if (current.fulfillmentProcessState !== 'IN_ASSEMBLY') {
      throw new AppError('CONFLICT', {
        message: 'order is not in assembly',
        publicMessage: 'Завершить сборку можно только для заказа в сборке.',
        conflict: { kind: 'ORDER_PROCESS_STATE_MISMATCH' },
      });
    }

    // Эксклюзивность назначения: администратор не завершает сборку за флориста
    // молча — для этого есть переназначение на себя.
    if (current.fulfillmentAssigneeId !== actor.userId) {
      throw new AppError('CONFLICT', {
        message: 'order assigned to another florist',
        publicMessage: 'Заказ закреплён за другим флористом.',
        conflict: { kind: 'ORDER_NOT_ASSIGNED_TO_YOU' },
      });
    }

    if (current.fulfillmentProcessVersion !== input.expectedProcessVersion) {
      throw new AppError('CONFLICT', {
        message: 'stale process version',
        publicMessage: 'Заказ изменился, пока вы работали. Обновите карточку и повторите.',
        conflict: { kind: 'STALE_VERSION' },
      });
    }

    const order = await tx.deliveryOrder.findUniqueOrThrow({
      where: { id: input.orderId },
      select: {
        id: true,
        externalName: true,
        deliveryDate: true,
        intervalKind: true,
        intervalStartMinute: true,
        intervalEndMinute: true,
        manualIntervalStartMinute: true,
        manualIntervalEndMinute: true,
        fulfillmentCardText: true,
        fulfillmentDescription: true,
        fulfillmentCompositionState: true,
        fulfillmentInScope: true,
        sourceArchived: true,
        sourceMissing: true,
      },
    });

    if (
      order.fulfillmentCompositionState !== 'READY' ||
      !order.fulfillmentInScope ||
      order.sourceArchived ||
      order.sourceMissing
    ) {
      throw new AppError('CONFLICT', {
        message: 'order is not assemblable',
        publicMessage: 'Состав заказа не подтверждён: завершать сборку нечем.',
        conflict: { kind: 'ORDER_NOT_ASSEMBLABLE' },
      });
    }

    // Ревизия, по которой заказ фактически собран. Без неё бланк не построить
    // и последующее изменение не с чем сравнить.
    const revision = await tx.orderFulfillmentRevision.findFirst({
      where: { orderId: order.id },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });

    if (revision === null) {
      throw new AppError('CONFLICT', {
        message: 'no fulfillment revision',
        publicMessage: 'История состава пуста: завершать сборку нечем.',
        conflict: { kind: 'ORDER_NOT_ASSEMBLABLE' },
      });
    }

    const positions = (await tx.deliveryOrderPosition.findMany({
      where: { orderId: order.id },
      orderBy: { ordinal: 'asc' },
      select: {
        ordinal: true,
        name: true,
        quantity: true,
        characteristicLabel: true,
        assortmentKind: true,
        assortmentId: true,
        components: {
          orderBy: { ordinal: 'asc' },
          select: { ordinal: true, name: true, quantity: true },
        },
      },
    })) as unknown as StoredPosition[];

    const minutes = effectiveMinutes(order);
    const snapshot = buildPrintFormSnapshot({
      orderNumber: order.externalName,
      deliveryDate: order.deliveryDate === null ? null : fromDateColumn(order.deliveryDate),
      intervalStartMinute: minutes.startMinute,
      intervalEndMinute: minutes.endMinute,
      cardText: order.fulfillmentCardText,
      description: order.fulfillmentDescription,
      positions,
      ids: MOYSKLAD_IDS,
    });

    const printForm = await tx.orderPrintForm.create({
      data: {
        orderId: order.id,
        revisionId: revision.id,
        templateVersion: PRINT_TEMPLATE_VERSION,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        snapshotHash: snapshotHash(snapshot),
      },
      select: { id: true, snapshotHash: true },
    });

    // Ровно ОДНО первоначальное задание печати. Уникальность пары
    // «заказ + номер попытки» не даст создать второе с тем же номером.
    const job = await tx.orderPrintJob.create({
      data: { orderId: order.id, printFormId: printForm.id, attempt: 1, state: 'PENDING' },
      select: { id: true },
    });

    await tx.deliveryOrder.update({
      where: { id: order.id },
      data: {
        fulfillmentProcessState: 'ASSEMBLED',
        fulfillmentAssembledAt: new Date(),
        fulfillmentAssembledById: actor.userId,
        fulfillmentAssembledRevisionId: revision.id,
        fulfillmentProcessVersion: { increment: 1 },
      },
    });

    const after = await readOrder(tx, order.id);

    await writeProcessAudit(tx, 'ORDER_FULFILLMENT_ASSEMBLED', after, actor, context, {
      revisionId: revision.id,
      printFormId: printForm.id,
      templateVersion: PRINT_TEMPLATE_VERSION,
    });
    await writeAudit(tx, {
      action: 'ORDER_PRINT_JOB_CREATED',
      entityType: 'OrderPrintJob',
      entityId: job.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { orderId: order.id, printFormId: printForm.id, attempt: 1 },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishProcessEvent(tx, after, actor.userId);
    await publishPrintEvent(tx, job.id, order.id, 'CREATED');

    return {
      ...toResult(after),
      printFormId: printForm.id,
      printJobId: job.id,
      snapshotHash: printForm.snapshotHash,
    };
  });
}

/**
 * Возврат собранного заказа в работу.
 *
 * Только администратор и только с причиной (`FUL-002` §2.3). Отметки сборки
 * снимаются: инвариант базы не допускает «незавершённого» заказа со следами
 * завершения. История при этом не теряется — неизменяемый бланк, задания печати
 * и записи аудита остаются на месте.
 */
export async function reopenOrder(
  db: Database,
  actor: Actor,
  input: { orderId: string; reason: string },
  context: RequestContext,
): Promise<ProcessResult> {
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'reason required',
      publicMessage: 'Укажите причину возврата заказа в работу.',
    });
  }

  return db.$transaction(async (tx) => {
    const before = await readOrder(tx, input.orderId);

    const updated = await tx.deliveryOrder.updateMany({
      where: {
        id: input.orderId,
        fulfillmentProcessState: { in: ['ASSEMBLED', 'NEEDS_REVIEW'] },
      },
      data: {
        fulfillmentProcessState: 'IN_ASSEMBLY',
        fulfillmentAssembledAt: null,
        fulfillmentAssembledById: null,
        fulfillmentAssembledRevisionId: null,
        fulfillmentProcessVersion: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      throw new AppError('CONFLICT', {
        message: 'order is not assembled',
        publicMessage: 'Вернуть в работу можно только собранный заказ.',
        conflict: { kind: 'ORDER_PROCESS_STATE_MISMATCH' },
      });
    }

    const order = await readOrder(tx, input.orderId);
    await writeProcessAudit(tx, 'ORDER_FULFILLMENT_REOPENED', order, actor, context, {
      reason,
      previousState: before.fulfillmentProcessState,
    });
    await publishProcessEvent(tx, order, actor.userId);
    if (order.fulfillmentAssigneeId !== null) {
      await publishPersonalProcessEvent(tx, order, order.fulfillmentAssigneeId);
    }

    return toResult(order);
  });
}

function toResult(order: StoredOrder): ProcessResult {
  return {
    orderId: order.id,
    processState: order.fulfillmentProcessState,
    processVersion: order.fulfillmentProcessVersion,
    assigneeId: order.fulfillmentAssigneeId,
  };
}

/**
 * Аудит производственного действия.
 *
 * Номер заказа, состав, тексты и байты бланка сюда не попадают: журнал хранит
 * факт, идентификаторы, состояния и причину администратора.
 */
async function writeProcessAudit(
  tx: TransactionClient,
  action: AuditAction,
  order: StoredOrder,
  actor: Actor,
  context: RequestContext,
  newValue: Record<string, unknown>,
): Promise<void> {
  await writeAudit(tx, {
    action,
    entityType: 'DeliveryOrder',
    entityId: order.id,
    actorUserId: actor.userId,
    actorRoles: actor.roles,
    newValue: {
      processState: order.fulfillmentProcessState,
      processVersion: order.fulfillmentProcessVersion,
      ...newValue,
    },
    ip: context.ip,
    userAgent: context.userAgent,
  });
}

/** Общее событие очереди: ни номера, ни состава, ни имени исполнителя. */
async function publishProcessEvent(
  tx: TransactionClient,
  order: StoredOrder,
  actorUserId: string,
): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic: 'order.fulfillment_process_changed',
    payload: {
      orderId: order.id,
      processState: order.fulfillmentProcessState,
      processVersion: order.fulfillmentProcessVersion,
      assigned: order.fulfillmentAssigneeId !== null,
      actorUserId,
    },
    audienceRoles: [...FULFILLMENT_AUDIENCE],
  });
}

/** Персональное событие: заказ появился у флориста или исчез у него. */
async function publishPersonalProcessEvent(
  tx: TransactionClient,
  order: StoredOrder,
  userId: string,
): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic: 'order.fulfillment_process_changed',
    payload: {
      orderId: order.id,
      processState: order.fulfillmentProcessState,
      processVersion: order.fulfillmentProcessVersion,
      assigned: order.fulfillmentAssigneeId !== null,
    },
    audienceUserId: userId,
  });
}

/** Событие печати. Ни PDF, ни номера заказа. */
export async function publishPrintEvent(
  tx: TransactionClient,
  jobId: string,
  orderId: string,
  kind: 'CREATED' | 'RETRIED' | 'PRINTED',
): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic: 'print_job.changed',
    payload: { jobId, orderId, kind },
    audienceRoles: [...FULFILLMENT_AUDIENCE],
  });
}
