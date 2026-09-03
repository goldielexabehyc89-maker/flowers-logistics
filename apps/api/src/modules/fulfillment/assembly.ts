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
import { offerableConstraints } from './queue-service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { fromDateColumn } from '../integrations/moysklad/delivery-date.js';
import {
  enqueueOrderStateSync,
  type OrderStateTarget,
} from '../integrations/moysklad/state-sync.js';
import { effectiveMinutes } from './queue.js';
import {
  buildPrintFormSnapshot,
  snapshotHash,
  PRINT_TEMPLATE_VERSION,
  type StoredPosition,
} from './print-form.js';
import { recordQueueAvailability } from './stats-capture.js';
import { enqueueDispatch } from './dispatch-trigger.js';
import { readFloristDispatchMode } from '../settings/service.js';
import {
  FULFILLMENT_AUDIENCE,
  MIN_REASON_LENGTH,
  lockActiveShift,
  shiftRequired,
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

/**
 * Заказ пригоден к сборке только целиком: область, источник, состав и отмена.
 *
 * Отмена стоит здесь, а не проверкой «до»: между проверкой и записью заказ
 * успевает отмениться очередным проходом импорта, и флорист начинал бы
 * собирать букет, которого уже никто не ждёт.
 */
const ASSEMBLABLE = {
  fulfillmentInScope: true,
  sourceArchived: false,
  sourceMissing: false,
  fulfillmentCompositionState: 'READY',
  cancelledInSource: false,
  cancelledByLogistAt: null,
} as const;

interface StoredOrder {
  id: string;
  externalName: string;
  fulfillmentProcessState: string;
  fulfillmentProcessVersion: number;
  fulfillmentAssigneeId: string | null;
  fulfillmentShiftId: string | null;
  fulfillmentInScope: boolean;
  sourceArchived: boolean;
  sourceMissing: boolean;
  fulfillmentCompositionState: string;
  cancelledInSource: boolean;
  cancelledByLogistAt: Date | null;
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
      fulfillmentShiftId: true,
      fulfillmentInScope: true,
      sourceArchived: true,
      sourceMissing: true,
      fulfillmentCompositionState: true,
      cancelledInSource: true,
      cancelledByLogistAt: true,
    },
  });
  if (order === null) {
    throw new AppError('NOT_FOUND', { message: 'order not found' });
  }
  return order;
}

/**
 * Следующий номер попытки печати заказа.
 *
 * Общий счётчик для ВСЕХ путей: первоначального задания сборки, ручного повтора
 * и каждой последующей пересборки. Номер монотонен в пределах заказа — 1, 2,
 * 3… — и никогда не возвращается к единице: иначе уникальный индекс
 * `(orderId, attempt)` закономерно отклонил бы вторую сборку, и аварийный путь
 * пересборки просто не работал бы.
 *
 * Второго счётчика в `DeliveryOrder` не заводится: он был бы вторым источником
 * истины о том, что и так записано в самих заданиях.
 *
 * КОНКУРЕНТНОСТЬ. Строка заказа блокируется ДО чтения максимума: без этого два
 * одновременных повтора прочитали бы один и тот же максимум, выбрали бы один
 * номер, и один из них упал бы сырой ошибкой уникальности. Блокировка ставит
 * их в очередь, и номера получаются последовательными.
 *
 * Порядок блокировок соблюдён: `DeliveryOrder` берётся после `FloristShift`
 * и раньше строк печати (`shifts.ts`).
 */
export async function nextPrintAttempt(tx: TransactionClient, orderId: string): Promise<number> {
  await tx.$queryRaw`
    SELECT "id" FROM "DeliveryOrder" WHERE "id" = ${orderId}::uuid FOR UPDATE
  `;

  const last = await tx.orderPrintJob.findFirst({
    where: { orderId },
    orderBy: { attempt: 'desc' },
    select: { attempt: true },
  });

  return (last?.attempt ?? 0) + 1;
}

/**
 * Смена, под которой действует исполнитель.
 *
 * Берётся ПЕРВОЙ в транзакции — до строки заказа: порядок блокировок
 * `FloristShift → DeliveryOrder` зафиксирован в `shifts.ts`, и нарушать его
 * нельзя ни в одной операции.
 *
 * Закрытие смены обязано иметь последствия, а не только выключать кнопку:
 * иначе ушедший домой флорист мог бы прямым запросом завершить заказ, который
 * администратор уже собирался переназначить. Администратор от проверки
 * освобождён: разбор оставшихся назначений — его прямая обязанность.
 */
async function lockOwnShift(
  tx: TransactionClient,
  actor: Actor,
): Promise<{ id: string; printPointId: string | null } | null> {
  if (isAdmin(actor)) {
    return null;
  }

  const shift = await lockActiveShift(tx, actor.userId);
  if (shift === null) {
    throw shiftRequired();
  }
  return shift;
}

/**
 * Назначение относится к текущей смене исполнителя.
 *
 * Заказ, оставшийся от закрытой смены, не теряется и не возвращается в очередь
 * сам: его разбирает администратор — переназначением активному флористу либо
 * возвратом в общую очередь.
 */
function assertAssignmentShift(order: StoredOrder, shiftId: string | null): void {
  if (shiftId === null) {
    return;
  }
  if (order.fulfillmentShiftId !== shiftId) {
    throw new AppError('CONFLICT', {
      message: 'assignment belongs to a closed shift',
      publicMessage:
        'Заказ закреплён в другой, уже закрытой смене. Его должен переназначить администратор.',
      conflict: { kind: 'ORDER_ASSIGNMENT_SHIFT_CLOSED' },
    });
  }
}

/**
 * Почему условный `UPDATE` не изменил ни одной строки.
 *
 * Причина выясняется ПОСЛЕ неудачи и только для сообщения человеку: решение
 * уже принято базой, и повторно «перепроверять» его нельзя — это вернуло бы
 * ровно ту гонку, от которой избавляет условная запись.
 */
function explainClaimFailure(order: StoredOrder): never {
  // Отмена называется отдельно: «состав не подтверждён» отправило бы флориста
  // искать несуществующую проблему в составе.
  if (order.cancelledInSource || order.cancelledByLogistAt !== null) {
    throw new AppError('CONFLICT', {
      message: 'order is cancelled',
      publicMessage: 'Заказ отменён: собирать его не нужно.',
      conflict: { kind: 'ORDER_CANCELLED' },
    });
  }
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
  return db.$transaction(async (tx) => {
    // Смена блокируется ДО заказа и внутри той же транзакции: иначе между
    // проверкой «смена активна» и записью назначения администратор успевал бы
    // закрыть смену, и заказ оказался бы закреплён за ушедшим человеком.
    const shift = await lockActiveShift(tx, actor.userId);
    if (shift === null) {
      throw shiftRequired();
    }

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
    // Взятие убрало строку из общей очереди — фиксируем переход доступности.
    await recordQueueAvailability(tx);
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
    /*
     * В режиме авто-раздачи прямое освобождение флористом запрещено.
     *
     * Единственный путь отказа здесь — «Отказаться» с причиной (/refusal): для
     * «Нет цветов» это карантин, для остальных — согласование руководителем.
     * Прямой возврат «в очередь» без причины тут же вернул бы заказ автораздачей
     * тому же человеку — ровно тот дефект, из-за которого точки входа сводятся
     * к одному endpoint. Разбор застрявших назначений остаётся у администратора,
     * а в ручном режиме поведение освобождения не меняется.
     */
    const mode = await readFloristDispatchMode(tx);
    if (mode.value.auto && !isAdmin(actor)) {
      throw new AppError('CONFLICT', {
        message: 'release is not allowed in auto dispatch mode',
        publicMessage: 'В режиме авто-раздачи откажитесь от заказа с указанием причины.',
        conflict: { kind: 'RELEASE_REQUIRES_REFUSAL' },
      });
    }

    // Порядок блокировок: сначала смена, потом заказ.
    const shift = await lockOwnShift(tx, actor);
    const shiftId = shift?.id ?? null;

    const updated = await tx.deliveryOrder.updateMany({
      where: {
        id: orderId,
        fulfillmentProcessState: 'IN_ASSEMBLY',
        ...(isAdmin(actor)
          ? {}
          : // Отпустить можно только СВОЙ заказ и только в той смене, в которой
            // он взят: назначение, оставшееся от закрытой смены, разбирает
            // администратор.
            { fulfillmentAssigneeId: actor.userId, fulfillmentShiftId: shiftId }),
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
      if (order.fulfillmentProcessState === 'IN_ASSEMBLY') {
        assertAssignmentShift(order, order.fulfillmentAssigneeId === actor.userId ? shiftId : null);
      }
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
    // Возврат вернул строку в общую очередь — фиксируем переход доступности.
    await recordQueueAvailability(tx);
    // Освободившийся заказ и освободившийся флорист — повод раздать заново.
    await enqueueDispatch(tx);
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

  return db.$transaction(async (tx) => {
    // Смена целевого флориста блокируется ДО заказа и внутри транзакции:
    // назначение обязано относиться к смене, которая в этот момент точно
    // открыта, иначе заказ достался бы человеку, уже закончившему день.
    const shift = await lockActiveShift(tx, input.floristId);
    if (shift === null) {
      throw new AppError('CONFLICT', {
        message: 'target florist has no active shift',
        publicMessage: 'У выбранного флориста нет активной смены.',
        conflict: { kind: 'FLORIST_NOT_ON_SHIFT' },
      });
    }

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

/**
 * Назначение ПЕРЕСБОРКИ конкретному флористу.
 *
 * Отличается от `reassignOrder` тем, что работает по заказу, который уже прошёл
 * сборку (`ASSEMBLED`/`NEEDS_REVIEW`), и открывает НОВЫЙ круг сборки
 * (`assemblyRound + 1`) — как `decideReassemble`, но не в общую свободную
 * очередь, а сразу выбранному флористу. Физическое состояние заказа не
 * трогается: размещения, маршрутные ячейки, лист и курьер остаются как были —
 * их отвязывает сравнение кругов, а не эта операция. «Собран» нового круга
 * штатно создаёт новый бланк и печать через `assembleOrder`.
 *
 * Идемпотентность обеспечивает вызывающий (одно решение на уведомление) плюс
 * условный `updateMany` по состоянию: второй заход застаёт заказ уже в
 * `IN_ASSEMBLY` и получает 0 строк.
 */
export async function assignReassembly(
  db: Database,
  actor: Actor,
  input: { orderId: string; floristId: string },
  context: RequestContext,
): Promise<{ result: ProcessResult; assemblyRound: number; floristId: string }> {
  return db.$transaction((tx) => assignReassemblyTx(tx, actor, input, context));
}

/**
 * Тело назначения пересборки внутри уже открытой транзакции.
 *
 * Отдельная точка нужна вызывающему решению «На пересборку»: оно создаёт запись
 * решения и назначает пересборку ОДНОЙ транзакцией, чтобы гонка двух логистов
 * и повторное нажатие не создали две пересборки — сериализует их условный
 * `updateMany` по состоянию заказа (проигравший получает 0 строк) и уникальность
 * записи решения.
 */
export async function assignReassemblyTx(
  tx: TransactionClient,
  actor: Actor,
  input: { orderId: string; floristId: string },
  context: RequestContext,
): Promise<{ result: ProcessResult; assemblyRound: number; floristId: string }> {
  const target = await tx.user.findUnique({
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
      publicMessage: 'Пересборку можно назначить только флористу.',
    });
  }

  {
    const shift = await lockActiveShift(tx, input.floristId);
    if (shift === null) {
      throw new AppError('CONFLICT', {
        message: 'target florist has no active shift',
        publicMessage: 'У выбранного флориста нет активной смены.',
        conflict: { kind: 'FLORIST_NOT_ON_SHIFT' },
      });
    }

    const before = await readOrder(tx, input.orderId);
    const updated = await tx.deliveryOrder.updateMany({
      where: {
        id: input.orderId,
        // Пересборка возможна только у уже собранного заказа.
        fulfillmentProcessState: { in: ['ASSEMBLED', 'NEEDS_REVIEW'] },
      },
      data: {
        fulfillmentProcessState: 'IN_ASSEMBLY',
        fulfillmentAssigneeId: input.floristId,
        fulfillmentAssignedAt: new Date(),
        fulfillmentShiftId: shift.id,
        // Новый круг сборки. Прежние бланк, печать, размещение и история
        // остаются — их «отвязывает» сравнение кругов, а не эта запись.
        assemblyRound: { increment: 1 },
        // Отметки завершённой сборки снимаются: заказ снова в работе.
        fulfillmentAssembledAt: null,
        fulfillmentAssembledById: null,
        fulfillmentAssembledRevisionId: null,
        fulfillmentProcessVersion: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      // Заказ не в собранном состоянии (например, пересборка уже назначена
      // другим логистом и заказ снова в работе) — честный конфликт.
      throw new AppError('CONFLICT', {
        message: 'order is not in an assembled state for reassembly',
        publicMessage: 'Заказ не в состоянии, из которого назначают пересборку.',
        conflict: { kind: 'REASSEMBLY_STATE_CONFLICT' },
      });
    }

    const refreshed = await tx.deliveryOrder.findUniqueOrThrow({
      where: { id: input.orderId },
      select: { assemblyRound: true },
    });
    const order = await readOrder(tx, input.orderId);

    await writeProcessAudit(tx, 'ORDER_FULFILLMENT_REASSEMBLY_ASSIGNED', order, actor, context, {
      toUserId: input.floristId,
      ...(before.fulfillmentAssigneeId === null
        ? {}
        : { fromUserId: before.fulfillmentAssigneeId }),
      assemblyRound: refreshed.assemblyRound,
    });

    await publishProcessEvent(tx, order, actor.userId);
    if (before.fulfillmentAssigneeId !== null && before.fulfillmentAssigneeId !== input.floristId) {
      await publishPersonalProcessEvent(tx, order, before.fulfillmentAssigneeId);
    }
    await publishPersonalProcessEvent(tx, order, input.floristId);

    return {
      result: toResult(order),
      assemblyRound: refreshed.assemblyRound,
      floristId: input.floristId,
    };
  }
}

/**
 * Атомарное автоматическое назначение свободного заказа флористу.
 *
 * Система (а не сам флорист) назначает верхний заказ выбранному флористу: то же
 * условное состояние `NEW → IN_ASSEMBLY`, что и у ручного захвата, поэтому два
 * распределения не выдадут один заказ дважды — проигравший получит 0 строк и
 * `false`. «Собран» остаётся отдельным действием (`assembleOrder`). Автор в
 * аудите — система (`null`). Смена флориста должна быть заблокирована ВЫШЕ по
 * стеку (порядок блокировок: FloristShift → DeliveryOrder).
 */
export async function autoAssignTx(
  tx: TransactionClient,
  input: {
    orderId: string;
    floristId: string;
    shiftId: string;
    operationsStartDate?: string | undefined;
  },
  context: RequestContext,
): Promise<boolean> {
  /*
   * Финальная проверка кандидата — В ТОЙ ЖЕ транзакции и по ТОМУ ЖЕ правилу,
   * что и свободная очередь: `offerableConstraints` (граница операций, статус не
   * «Принят, Не оплачен», производственная область, источник не пропал и не
   * архивирован, состав готов) плюс «не отменён» и «по-прежнему свободен».
   * Предикат один — свободная очередь, список кандидатов и это назначение не
   * могут разойтись. Условная запись атомарна: если заказ уже перехвачен или
   * перестал подходить, обновится 0 строк и назначение не состоится.
   */
  const updated = await tx.deliveryOrder.updateMany({
    where: {
      id: input.orderId,
      fulfillmentProcessState: 'NEW',
      fulfillmentAssigneeId: null,
      cancelledInSource: false,
      cancelledByLogistAt: null,
      ...offerableConstraints(input.operationsStartDate),
    },
    data: {
      fulfillmentProcessState: 'IN_ASSEMBLY',
      fulfillmentAssigneeId: input.floristId,
      fulfillmentAssignedAt: new Date(),
      fulfillmentShiftId: input.shiftId,
      fulfillmentProcessVersion: { increment: 1 },
    },
  });
  if (updated.count === 0) {
    return false;
  }

  const order = await readOrder(tx, input.orderId);
  await writeAudit(tx, {
    action: 'ORDER_FULFILLMENT_AUTO_ASSIGNED',
    entityType: 'DeliveryOrder',
    entityId: order.id,
    actorUserId: null,
    actorRoles: [],
    newValue: {
      processState: order.fulfillmentProcessState,
      processVersion: order.fulfillmentProcessVersion,
      toUserId: input.floristId,
    },
    ip: context.ip,
    userAgent: context.userAgent,
    source: 'worker',
  });
  // Заказ уходит из свободной очереди у руководителей и появляется карточкой
  // у назначенного флориста — оба без перезагрузки.
  await publishProcessEvent(tx, order, null);
  await publishPersonalProcessEvent(tx, order, input.floristId);
  return true;
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
    // Смена — первой: собрать заказ после подтверждённого закрытия смены нельзя,
    // и решает это блокировка, а не порядок нажатий.
    const shift = await lockOwnShift(tx, actor);
    const shiftId = shift?.id ?? null;

    /*
     * Точка печати — из активной смены ИСПОЛНИТЕЛЯ, в том числе администратора.
     *
     * `lockOwnShift` освобождает администратора от ТРЕБОВАНИЯ смены и потому
     * возвращает для него `null`. Но точку печати его собственной активной
     * смены учитывать всё равно нужно: иначе заказ, собранный администратором
     * с выбранной точкой, не попадает в автоматическую печать — ровно так
     * задание 138612CRM получило `printPointId=null`, хотя точка была выбрана
     * за двадцать секунд до сборки.
     *
     * Обычному флористу смена уже под блокировкой — повторного запроса нет.
     * Для администратора читается его активная смена по `activeKey`; чтение
     * без `FOR UPDATE`, поэтому порядок блокировок `FloristShift → DeliveryOrder`
     * не нарушается. Смена точки задним числом старых заданий не меняет:
     * значение фиксируется только у создаваемого сейчас задания.
     */
    const shiftPrintPointId =
      shift?.printPointId ??
      (isAdmin(actor)
        ? ((
            await tx.floristShift.findUnique({
              where: { activeKey: actor.userId },
              select: { printPointId: true },
            })
          )?.printPointId ?? null)
        : null);

    // Блокировка строки на всю транзакцию: между проверкой и записью не должен
    // вклиниться ни повторный «Собран», ни переназначение.
    const locked = await tx.$queryRaw<
      {
        id: string;
        fulfillmentProcessState: string;
        fulfillmentProcessVersion: number;
        fulfillmentAssigneeId: string | null;
        fulfillmentShiftId: string | null;
      }[]
    >`
      SELECT "id",
             "fulfillmentProcessState",
             "fulfillmentProcessVersion",
             "fulfillmentAssigneeId",
             "fulfillmentShiftId"
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

    // Назначение обязано относиться к ТЕКУЩЕЙ смене исполнителя: заказ,
    // оставшийся от закрытой смены, завершает не он, а администратор — после
    // переназначения.
    assertAssignmentShift(current as StoredOrder, shiftId);

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
        assemblyRound: true,
        // Способ получения решает исходящий статус сборки: доставка → «Ожидает
        // отправку», самовывоз → «Готов к самовывозу».
        deliveryMethodId: true,
        // Деньги в МОМЕНТ сборки: синхронизация переписывает sumMinor позже,
        // поэтому статистика берёт зафиксированное здесь значение, а не живое.
        sumMinor: true,
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
        // Единица замораживается в бланке ВМЕСТЕ с количеством: без неё
        // «2» и «2 м» на бумаге неразличимы, а переименование единицы
        // в каталоге меняло бы уже напечатанный документ.
        uomName: true,
        characteristicLabel: true,
        assortmentKind: true,
        assortmentId: true,
        components: {
          orderBy: { ordinal: 'asc' },
          select: { ordinal: true, name: true, quantity: true, uomName: true },
        },
      },
    })) as StoredPosition[];

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
        // Бланк принадлежит кругу сборки: после пересборки нужен новый.
        assemblyRound: order.assemblyRound,
        templateVersion: PRINT_TEMPLATE_VERSION,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        snapshotHash: snapshotHash(snapshot),
      },
      select: { id: true, snapshotHash: true },
    });

    /*
     * Точка печати берётся из СМЕНЫ, а не из запроса клиента.
     *
     * Клиент мог бы прислать чужую точку, и наклейка вышла бы у соседнего
     * стола. Выбор точки — часть начала работы, он хранится в смене, и здесь
     * только читается.
     *
     * ПЕЧАТЬ НЕ БЛОКИРУЕТ СБОРКУ. Нет выбранной точки, выключен компьютер,
     * кончилась лента — «Собран» всё равно сохраняется. Иначе неисправность
     * принтера останавливала бы работу цеха, а собранный букет оставался бы
     * несобранным в системе. Наклейку в этом случае печатают руками той же
     * кнопкой, что и раньше: ручной путь никуда не делся.
     *
     * Интерфейс при этом спрашивает точку ДО нажатия — но именно спрашивает,
     * а не запрещает.
     *
     * Значение вычислено выше, до блокировки заказа: оно берётся из активной
     * смены исполнителя и одинаково для флориста и администратора.
     */
    const printPointId = shiftPrintPointId;

    // Ровно ОДНО первоначальное задание печати на эту сборку.
    //
    // Номер попытки берётся общим счётчиком, а не единицей: после возврата
    // заказа в работу и повторной сборки единица уже занята прежним заданием,
    // и уникальный индекс `(orderId, attempt)` закономерно отклонил бы всю
    // транзакцию — аварийный путь пересборки просто не работал бы.
    //
    // ЭТО ЖЕ ЗАДАНИЕ и забирает Windows-агент: второй очереди у печати нет.
    // Признак автоматической доставки ставится здесь, в той же транзакции,
    // что и «Собран», — поэтому «собран, но печатать нечего» невозможно.
    const job = await tx.orderPrintJob.create({
      data: {
        orderId: order.id,
        printFormId: printForm.id,
        attempt: await nextPrintAttempt(tx, order.id),
        state: 'PENDING',
        printPointId,
        deliveryState: printPointId === null ? null : 'QUEUED',
      },
      select: { id: true, attempt: true },
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
      // Накопление вперёд для статистики смен: смена исполнителя и деньги в
      // момент сборки. У администратора без смены shiftId пуст; сумма строкой,
      // так как bigint в JSON аудита недопустим.
      shiftId,
      assembledSumMinor: order.sumMinor.toString(),
      // Круг сборки: статистика считает пересборку (round > 1) отдельной
      // выполненной работой и отличает её от первой сборки.
      assemblyRound: order.assemblyRound,
    });
    await writeAudit(tx, {
      action: 'ORDER_PRINT_JOB_CREATED',
      entityType: 'OrderPrintJob',
      entityId: job.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { orderId: order.id, printFormId: printForm.id, attempt: job.attempt },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishProcessEvent(tx, after, actor.userId);
    await publishPrintEvent(tx, job.id, order.id, 'CREATED');

    /*
     * Исходящий статус сборки в МойСклад — через ту же очередь синхронизации
     * (`moysklad.order_state`), в ЭТОЙ ЖЕ транзакции, а не прямым запросом.
     * Доставка → «Ожидает отправку»; самовывоз → «Готов к самовывозу». Иной или
     * неизвестный способ — без записи (не гадаем статус). Ключ идемпотентности
     * несёт круг сборки: повтор «Собран» того же круга дубликата не создаёт, а
     * новый круг — своё событие. Порядок и запрет регресса держит seq+ранг.
     */
    const assembledTarget: OrderStateTarget | null =
      order.deliveryMethodId === MOYSKLAD_IDS.deliveryMethodPickup
        ? 'ready_for_pickup'
        : order.deliveryMethodId === MOYSKLAD_IDS.deliveryMethodDelivery
          ? 'awaiting_shipment'
          : null;
    if (assembledTarget !== null) {
      await enqueueOrderStateSync(tx, {
        orderId: order.id,
        target: assembledTarget,
        dedupeKey: `moysklad.order_state:${order.id}:assembled:round:${order.assemblyRound}`,
      });
    }

    // Флорист освободился после «Собран» — раздаём ему следующий заказ.
    await enqueueDispatch(tx);

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

    // Администратор и управляющий возвращают любой собранный заказ — их права
    // не меняются. Флорист же возвращает только СВОЙ заказ и только на активной
    // смене: это один шаг назад в его собственной работе, а не разбор чужих
    // назначений. Смена берётся под блокировку ПЕРВОЙ — порядок блокировок
    // `FloristShift → DeliveryOrder` тот же, что и у остальных операций.
    const isManager = actor.roles.includes('ADMIN') || actor.roles.includes('SUPERVISOR');
    if (!isManager) {
      // Чужой заказ — это отказ доступа (403), и он проверяется ПЕРВЫМ: флорист
      // не должен даже узнавать о состоянии смены по чужому заказу. Проверка —
      // по прочитанной строке, без блокировки, поэтому порядок блокировок
      // `FloristShift → DeliveryOrder` не нарушается.
      if (before.fulfillmentAssigneeId !== actor.userId) {
        throw new AppError('FORBIDDEN', {
          message: 'order is not assigned to this florist',
          publicMessage: 'Вернуть в работу можно только свой собранный заказ.',
        });
      }
      // Свой заказ, но только на активной смене: смена берётся под блокировку.
      const shift = await lockActiveShift(tx, actor.userId);
      if (shift === null) {
        throw shiftRequired();
      }
    }

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
  actorUserId: string | null,
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
    // SUPERVISOR и MANAGER добавлены ради живого обновления «Ожидают приёмки»:
    // как только заказ становится «Собран», карточка появляется у склада без
    // F5. Payload несёт лишь идентификатор и состояние — ни номера, ни состава,
    // ни имени флориста, поэтому расширение аудитории ничего не раскрывает.
    audienceRoles: [...FULFILLMENT_AUDIENCE, 'SUPERVISOR', 'MANAGER'],
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
  kind: 'CREATED' | 'RETRIED' | 'PRINTED' | 'DELIVERY',
): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic: 'print_job.changed',
    payload: { jobId, orderId, kind },
    audienceRoles: [...FULFILLMENT_AUDIENCE],
  });
}
