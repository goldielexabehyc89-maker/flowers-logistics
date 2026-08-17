/**
 * Ручное локальное исправление интервала доставки.
 *
 * Единственное изменение заказа, доступное человеку на этом этапе. Всё остальное —
 * дата, адрес, получатель, комментарий, суммы — принадлежит МоемуСкладу и здесь
 * не редактируется: расхождение с источником заказов дороже любого удобства.
 *
 * Запись идёт ТОЛЬКО в наши поля `manualInterval*`. В МойСклад ничего не уходит:
 * ни запроса, ни outbox-сообщения, ни webhook. Поэтому следующая синхронизация
 * исправление не затирает — она работает с полями источника.
 *
 * Повторное исправление заменяет предыдущее. Отдельного удаления нет намеренно:
 * пустой интервал — это уже «Требует внимания», и для него есть исходный путь.
 */

import { AppError } from '../../platform/errors.js';
import type { Database } from '../../platform/db.js';
import type { TransactionClient } from '../auth/sessions.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { effectiveAttentionReasons, type AttentionReason } from './attention.js';

/**
 * Кому видны события заказов.
 *
 * Курьер включён намеренно: адрес и интервал он видит в «Активных» и обязан
 * получить правку в дороге, а не после перезагрузки. Событие не несёт ни
 * адреса, ни получателя — только повод перечитать собственный список, и
 * чужие заказы курьеру от этого не открываются.
 */
const ORDER_AUDIENCE = ['ADMIN', 'LOGISTICIAN', 'COURIER'] as const;

/** Минуты от полуночи: сутки целиком. */
export const MIN_MINUTE = 0;
export const MAX_MINUTE = 24 * 60 - 1;

export interface SetIntervalInput {
  orderId: string;
  startMinute: number;
  endMinute: number;
  version: number;
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface SetIntervalResult {
  orderId: string;
  version: number;
  startMinute: number;
  endMinute: number;
  needsAttention: boolean;
  attentionReasons: AttentionReason[];
}

/**
 * Проверка границ интервала.
 *
 * Нулевая и обратная длительность отвергается: «с 16:00 по 16:00» невозможно
 * выполнить, а «с 19:00 по 16:00» либо опечатка, либо переход через полночь —
 * угадывать между ними нельзя ровно так же, как и при разборе текста источника.
 */
export function assertValidInterval(startMinute: number, endMinute: number): void {
  const invalid =
    !Number.isInteger(startMinute) ||
    !Number.isInteger(endMinute) ||
    startMinute < MIN_MINUTE ||
    endMinute > MAX_MINUTE ||
    endMinute <= startMinute;

  if (invalid) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'invalid manual interval',
      publicMessage: 'Окончание интервала должно быть позже начала и укладываться в сутки.',
    });
  }
}

/**
 * Сохраняет ручной интервал.
 *
 * Изменение карточки, аудит и realtime-событие пишутся одной транзакцией:
 * иначе возможна карточка без следа в истории или уведомление о несохранённом
 * изменении.
 */
export async function setManualInterval(
  deps: { db: Database },
  actor: AuthenticatedActor,
  input: SetIntervalInput,
  context: RequestContext,
): Promise<SetIntervalResult> {
  assertValidInterval(input.startMinute, input.endMinute);

  return deps.db.$transaction(async (tx: TransactionClient) => {
    const order = await tx.deliveryOrder.findUnique({
      where: { id: input.orderId },
      select: {
        id: true,
        version: true,
        inScope: true,
        attentionReasons: true,
        manualIntervalStartMinute: true,
        manualIntervalEndMinute: true,
        intervalKind: true,
      },
    });

    if (order === null) {
      throw new AppError('NOT_FOUND', { message: 'order not found' });
    }

    // Заказ вне нашей области не планируется и не исправляется: чужой склад
    // или отменённый способ доставки — не наша зона ответственности.
    if (!order.inScope) {
      throw new AppError('VALIDATION_FAILED', {
        message: 'order is out of scope',
        publicMessage: 'Заказ не относится к нашей доставке, интервал не изменяется.',
      });
    }

    // Причины пересчитываются от ИСХОДНОГО набора снимка. Хранить его отдельно
    // не нужно: интервальные причины добавляет только импорт, а ручное
    // исправление их лишь скрывает, поэтому объединение восстанавливает основу.
    const snapshotReasons = restoreSnapshotReasons(order.attentionReasons, order.intervalKind);
    const reasons = effectiveAttentionReasons(snapshotReasons, {
      startMinute: input.startMinute,
      endMinute: input.endMinute,
    });

    const updated = await tx.deliveryOrder.updateMany({
      where: { id: input.orderId, version: input.version },
      data: {
        manualIntervalStartMinute: input.startMinute,
        manualIntervalEndMinute: input.endMinute,
        manualIntervalSetAt: new Date(),
        needsAttention: reasons.length > 0,
        attentionReasons: reasons,
        version: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      throw new AppError('CONFLICT', {
        message: 'optimistic lock conflict',
        publicMessage: 'Заказ изменён другим пользователем. Обновите страницу и повторите.',
      });
    }

    const version = order.version + 1;

    await writeAudit(tx, {
      action: 'ORDER_INTERVAL_SET',
      entityType: 'DeliveryOrder',
      entityId: order.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      // Ни адреса, ни получателя: в аудите только сам факт и значения интервала.
      oldValue: {
        startMinute: order.manualIntervalStartMinute,
        endMinute: order.manualIntervalEndMinute,
      },
      newValue: {
        startMinute: input.startMinute,
        endMinute: input.endMinute,
        version,
        needsAttention: reasons.length > 0,
        attentionReasons: reasons,
      },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishRealtimeEvent(tx, {
      topic: 'order.updated',
      payload: {
        orderId: order.id,
        inScope: true,
        needsAttention: reasons.length > 0,
        manualInterval: true,
      },
      audienceRoles: [...ORDER_AUDIENCE],
    });

    return {
      orderId: order.id,
      version,
      startMinute: input.startMinute,
      endMinute: input.endMinute,
      needsAttention: reasons.length > 0,
      attentionReasons: reasons,
    };
  });
}

/**
 * Восстанавливает исходный набор причин снимка по сохранённой карточке.
 *
 * В карточке лежат ДЕЙСТВУЮЩИЕ причины: интервальная могла быть уже скрыта
 * предыдущим ручным исправлением. Признак `intervalKind` при этом остаётся
 * значением источника и не меняется никогда, поэтому по нему всегда видно,
 * какую именно причину дал бы импорт.
 */
function restoreSnapshotReasons(
  current: readonly AttentionReason[],
  intervalKind: string,
): AttentionReason[] {
  // Тип задан явно: без него filter сузил бы элемент до набора без интервальных
  // причин, и вернуть их в массив стало бы невозможно.
  const reasons: AttentionReason[] = current.filter(
    (reason) => reason !== 'MISSING_INTERVAL' && reason !== 'UNRECOGNIZED_INTERVAL',
  );

  if (intervalKind === 'MISSING') {
    reasons.push('MISSING_INTERVAL');
  } else if (intervalKind === 'UNRECOGNIZED') {
    reasons.push('UNRECOGNIZED_INTERVAL');
  }

  return reasons;
}
