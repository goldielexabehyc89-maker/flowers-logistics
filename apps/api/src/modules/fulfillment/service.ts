/**
 * Применение производственного снимка заказа.
 *
 * Выполняется в ТОЙ ЖЕ транзакции, что и применение логистического снимка:
 * заказ, его состав, ревизия, аудит и событие обязаны появиться вместе.
 * Отдельная транзакция дала бы состояние «заказ обновлён, состав от прошлой
 * версии» — самое опасное из возможных, потому что выглядит достоверно.
 *
 * Сеть сюда не заходит: состав получен ДО открытия транзакции. Держать
 * соединение с базой открытым на время HTTP нельзя.
 *
 * Идемпотентность считается по хешу производственного снимка, а НЕ по
 * `externalUpdated`. `updated` заказа меняется и от чужих логистических полей —
 * от адреса, интервала, статуса, — и признание его признаком изменения
 * создавало бы производственную ревизию там, где производственные данные
 * не менялись, а флориста уведомляло бы «Заказ изменён» без причины.
 */

import type { Prisma } from '../../generated/prisma/client.js';
import type { TransactionClient } from '../auth/sessions.js';
import { writeAudit, type AuditAction } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { diffSnapshots, snapshotHash, type FulfillmentSnapshot } from './composition.js';

/**
 * Кто видит производственные события.
 *
 * Логист в этот поток не входит: состав к логистике отношения не имеет, а
 * лишняя подписка означала бы лишний повод перезапросить список.
 */
const FULFILLMENT_AUDIENCE = ['ADMIN', 'FLORIST'] as const;

/**
 * После скольких неудач подряд состояние становится `FAILED`.
 *
 * `FAILED` не прекращает попытки — он делает заказ заметным. Разница между
 * «один раз не повезло» и «не получается уже который проход» должна быть видна
 * без чтения журналов.
 */
export const COMPOSITION_FAILURE_THRESHOLD = 3;

export type FulfillmentOutcome =
  /** Снимок совпал с подтверждённым: ни ревизии, ни аудита, ни события. */
  | 'UNCHANGED'
  /** Первый подтверждённый снимок заказа. */
  | 'IMPORTED'
  /** Снимок изменился: одна ревизия и замена проекции. */
  | 'CHANGED'
  /** Состав подтвердить не удалось: проекция не тронута, заказ ждёт повтора. */
  | 'UNCONFIRMED'
  /** Заказа нет в базе: он не относится ни к одной области. */
  | 'SKIPPED';

export interface ApplyFulfillmentResult {
  outcome: FulfillmentOutcome;
  changedFields: string[];
}

export interface ApplyFulfillmentInput {
  externalId: string;
  /** `updated` заказа: контекст ревизии, но не признак изменения. */
  externalUpdated: Date;
  /**
   * Тексты производственного снимка.
   *
   * Сохраняются ВСЕГДА, в том числе когда состав подтвердить не удалось: они
   * приходят вместе с карточкой заказа, уже проверены схемой и от позиций
   * не зависят. Благодаря этому очередь дозагрузки читает только позиции
   * и не тратит обращение на повторное чтение самого документа.
   */
  texts: { description: string | null; cardText: string | null };
  /** Подтверждённый снимок либо `null`, если подтвердить состав не удалось. */
  snapshot: FulfillmentSnapshot | null;
  /** Безопасный код отказа. Данных заказа не содержит. */
  failure: string | null;
}

interface StoredFulfillment {
  id: string;
  fulfillmentSnapshotHash: string | null;
  fulfillmentCompositionState: 'PENDING' | 'READY' | 'FAILED';
  fulfillmentCompositionAttempts: number;
}

export async function applyFulfillmentSnapshot(
  tx: TransactionClient,
  input: ApplyFulfillmentInput,
  now: Date,
): Promise<ApplyFulfillmentResult> {
  // Строка уже заблокирована `FOR UPDATE` применением логистического снимка
  // в этой же транзакции, поэтому отдельная блокировка не берётся: тот же ключ
  // из того же соединения не нужен, а лишний `FOR UPDATE` только удлинил бы
  // удержание.
  const order = (await tx.deliveryOrder.findUnique({
    where: { externalId: input.externalId },
    select: {
      id: true,
      fulfillmentSnapshotHash: true,
      fulfillmentCompositionState: true,
      fulfillmentCompositionAttempts: true,
    },
  })) as StoredFulfillment | null;

  if (order === null) {
    // Заказ чужого склада в базу не попадает вовсе — сохранять его состав
    // тем более незачем.
    return { outcome: 'SKIPPED', changedFields: [] };
  }

  if (input.snapshot === null) {
    return unconfirmed(tx, order, input, now);
  }

  return confirmed(tx, order, input.snapshot, input, now);
}

/**
 * Состав подтвердить не удалось.
 *
 * Подтверждённая проекция НЕ затирается: последняя достоверная версия ценнее
 * свежей неполной. Но и состояние `READY` сохранить нельзя — заказ уже
 * пришёл delta-проходом, курсор уйдёт вперёд, и другого повода перечитать
 * его не будет. Поэтому состояние опускается до `PENDING`/`FAILED`, и
 * дозагрузка идёт по нему, а не по изменению `updated`.
 */
async function unconfirmed(
  tx: TransactionClient,
  order: StoredFulfillment,
  input: ApplyFulfillmentInput,
  now: Date,
): Promise<ApplyFulfillmentResult> {
  const attempts = order.fulfillmentCompositionAttempts + 1;
  const state = attempts >= COMPOSITION_FAILURE_THRESHOLD ? 'FAILED' : 'PENDING';

  await tx.deliveryOrder.update({
    where: { id: order.id },
    data: {
      // Тексты сохраняются даже без состава: они не зависят от позиций, а их
      // потеря означала бы, что дозагрузке пришлось бы перечитывать документ.
      fulfillmentDescription: input.texts.description,
      fulfillmentCardText: input.texts.cardText,
      fulfillmentCompositionState: state,
      fulfillmentCompositionAttempts: attempts,
      fulfillmentCompositionFailedAt: now,
      fulfillmentCompositionFailure: input.failure,
    },
  });

  // Аудит только при переходе в `FAILED`: писать запись на каждую неудачу
  // означало бы залить неизменяемый журнал повторами одной и той же проблемы.
  if (state === 'FAILED' && order.fulfillmentCompositionState !== 'FAILED') {
    await writeOrderAudit(tx, 'ORDER_FULFILLMENT_UNAVAILABLE', order.id, {
      attempts,
      failure: input.failure,
    });
  }

  return { outcome: 'UNCONFIRMED', changedFields: [] };
}

async function confirmed(
  tx: TransactionClient,
  order: StoredFulfillment,
  snapshot: FulfillmentSnapshot,
  input: ApplyFulfillmentInput,
  now: Date,
): Promise<ApplyFulfillmentResult> {
  const hash = snapshotHash(snapshot);
  const first = order.fulfillmentSnapshotHash === null;

  // Полная идемпотентность: тот же снимок при уже подтверждённом состоянии
  // не пишет ничего — ни строки, ни ревизии, ни события. В том числе не трогает
  // `updatedAt` заказа: перекрытие delta-окна возвращает те же заказы каждые
  // тридцать секунд, и «пустое» обновление шло бы потоком.
  if (hash === order.fulfillmentSnapshotHash && order.fulfillmentCompositionState === 'READY') {
    return { outcome: 'UNCHANGED', changedFields: [] };
  }

  const previous = await previousSnapshot(tx, order.id);
  const changedFields = diffSnapshots(previous, snapshot);

  await replacePositions(tx, order.id, snapshot);

  await tx.deliveryOrder.update({
    where: { id: order.id },
    data: {
      fulfillmentDescription: snapshot.description,
      fulfillmentCardText: snapshot.cardText,
      fulfillmentSnapshotHash: hash,
      fulfillmentCompositionState: 'READY',
      fulfillmentCompositionSyncedAt: now,
      fulfillmentCompositionAttempts: 0,
      fulfillmentCompositionFailedAt: null,
      fulfillmentCompositionFailure: null,
    },
  });

  await tx.orderFulfillmentRevision.create({
    data: {
      orderId: order.id,
      externalUpdated: input.externalUpdated,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      snapshotHash: hash,
      changedFields,
      reason: first ? 'INITIAL_IMPORT' : 'EXTERNAL_UPDATE',
    },
  });

  const action: AuditAction = first ? 'ORDER_FULFILLMENT_IMPORTED' : 'ORDER_FULFILLMENT_CHANGED';
  await writeOrderAudit(tx, action, order.id, {
    changedFields,
    positions: snapshot.positions.length,
    components: snapshot.positions.reduce((sum, p) => sum + p.components.length, 0),
  });

  await publishRealtimeEvent(tx, {
    topic: 'order.fulfillment_changed',
    // Ни названий, ни количеств, ни текста: клиент по событию перезапрашивает
    // карточку, а широковещательный канал не место для содержимого заказа.
    payload: { orderId: order.id, changedFields, first },
    audienceRoles: [...FULFILLMENT_AUDIENCE],
  });

  return { outcome: first ? 'IMPORTED' : 'CHANGED', changedFields };
}

/**
 * Заменяет проекцию состава целиком.
 *
 * Замена, а не сверка построчно: состав — это единое целое, и «обновить
 * изменившиеся, дописать новые, удалить пропавшие» здесь даёт ту же строку
 * состояния при вдвое большем числе способов ошибиться. Компоненты уходят
 * вместе с позициями по внешнему ключу `ON DELETE CASCADE`.
 *
 * Всё внутри одной транзакции: отказ на любом шаге откатывает и удаление,
 * поэтому половины состава в базе не бывает.
 */
async function replacePositions(
  tx: TransactionClient,
  orderId: string,
  snapshot: FulfillmentSnapshot,
): Promise<void> {
  await tx.deliveryOrderPosition.deleteMany({ where: { orderId } });

  for (const position of snapshot.positions) {
    await tx.deliveryOrderPosition.create({
      data: {
        orderId,
        externalPositionId: position.externalPositionId,
        ordinal: position.ordinal,
        assortmentId: position.assortmentId,
        assortmentKind: position.assortmentKind,
        assortmentKindRaw: position.assortmentKindRaw,
        name: position.name,
        quantity: position.quantity,
        characteristicLabel: position.characteristicLabel,
        components: {
          create: position.components.map((component) => ({
            externalComponentId: component.externalComponentId,
            ordinal: component.ordinal,
            assortmentId: component.assortmentId,
            assortmentKind: component.assortmentKind,
            assortmentKindRaw: component.assortmentKindRaw,
            name: component.name,
            quantity: component.quantity,
          })),
        },
      },
    });
  }
}

/** Последний производственный снимок заказа. Ревизии неизменяемы, поэтому он достоверен. */
async function previousSnapshot(
  tx: TransactionClient,
  orderId: string,
): Promise<FulfillmentSnapshot | null> {
  const revision = await tx.orderFulfillmentRevision.findFirst({
    where: { orderId },
    // Одинаковые миллисекунды реальны при пакетной обработке, поэтому
    // порядок доопределяется идентификатором.
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    select: { snapshot: true },
  });
  return revision === null ? null : (revision.snapshot as unknown as FulfillmentSnapshot);
}

/**
 * Аудит производственного действия.
 *
 * Значения полей состава сюда не попадают: они лежат в защищённой ревизии.
 * Здесь — факт, идентификатор заказа, перечень изменившихся частей снимка
 * и счётчики.
 */
async function writeOrderAudit(
  tx: TransactionClient,
  action: AuditAction,
  orderId: string,
  newValue: Record<string, unknown>,
): Promise<void> {
  await writeAudit(tx, {
    action,
    entityType: 'DeliveryOrder',
    entityId: orderId,
    actorUserId: null,
    source: 'worker',
    newValue,
  });
}
