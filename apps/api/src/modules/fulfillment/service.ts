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
/**
 * Кому адресованы производственные события заказа.
 *
 * Склад включён: размещение и выдача начинаются с собранного заказа, и вкладки
 * склада обязаны видеть готовность без перезагрузки. Логист — потому что
 * признак «Собран» стоит в его карточке и на карте.
 */
const FULFILLMENT_AUDIENCE = ['ADMIN', 'FLORIST', 'WAREHOUSE', 'LOGISTICIAN'] as const;

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
  /**
   * Тот же снимок подтверждён снова после временного отказа.
   *
   * Продуктовые данные не изменились, поэтому ни ревизии, ни аудита, ни события
   * не создаётся: меняются только технические поля состояния.
   */
  | 'RESTORED'
  /** Состав подтвердить не удалось: проекция не тронута, заказ ждёт повтора. */
  | 'UNCONFIRMED'
  /** Результат устарел: пока он готовился, пришла более новая версия заказа. */
  | 'STALE'
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
   * Тексты внешней версии, к которой относится этот результат.
   *
   * При неподтверждённом составе они попадают в ОЖИДАЮЩИЕ поля, а не в
   * подтверждённые: снимок — это тексты и состав вместе, и записать новые
   * тексты рядом со старым составом значило бы собрать строку из двух версий.
   */
  texts: { description: string | null; cardText: string | null };
  /** Подтверждённый снимок либо `null`, если подтвердить состав не удалось. */
  snapshot: FulfillmentSnapshot | null;
  /** Безопасный код отказа. Данных заказа не содержит. */
  failure: string | null;
  /**
   * Версия, ожидавшая подтверждения на момент начала работы.
   *
   * Заполняется только очередью дозагрузки. Пока она ходила в сеть за позициями
   * версии B, delta могла записать версию C — и результат B обязан быть
   * отброшен, а не подтверждён как C и не затереть ожидающую C.
   *
   * `undefined` означает «проверка неприменима»: путь страницы сам держит
   * блокировку строки всю транзакцию, и подменить версию под ним некому.
   */
  expectedPendingVersion?: Date | null;
}

interface StoredFulfillment {
  id: string;
  fulfillmentSnapshotHash: string | null;
  fulfillmentCompositionState: 'PENDING' | 'READY' | 'FAILED';
  fulfillmentCompositionAttempts: number;
  fulfillmentPendingExternalUpdated: Date | null;
  /**
   * Шаг производственного процесса на момент применения снимка.
   *
   * Читается здесь, а не отдельным запросом: изменение состава СОБРАННОГО заказа
   * обязано перевести его в «Требует проверки» в той же транзакции, что и сам
   * снимок. Иначе между записью нового состава и сменой состояния существовал бы
   * промежуток, в котором заказ выглядит собранным по данным, которых уже нет.
   */
  fulfillmentProcessState: 'NEW' | 'IN_ASSEMBLY' | 'ASSEMBLED' | 'NEEDS_REVIEW';
}

export async function applyFulfillmentSnapshot(
  tx: TransactionClient,
  input: ApplyFulfillmentInput,
  now: Date,
): Promise<ApplyFulfillmentResult> {
  // Блокировка строки берётся здесь, а не подразумевается.
  //
  // На пути страницы строка уже заблокирована применением логистического
  // снимка в этой же транзакции, и повторный `FOR UPDATE` того же ключа тем же
  // соединением ничего не стоит. А вот очередь дозагрузки логистический снимок
  // не применяет — без блокировки её проверка версии была бы чтением без
  // защиты, то есть не проверкой вовсе.
  const rows = await tx.$queryRaw<StoredFulfillment[]>`
    SELECT "id",
           "fulfillmentSnapshotHash",
           "fulfillmentCompositionState",
           "fulfillmentCompositionAttempts",
           "fulfillmentPendingExternalUpdated",
           "fulfillmentProcessState"
    FROM "DeliveryOrder"
    WHERE "externalId" = ${input.externalId}::uuid
    FOR UPDATE
  `;
  const order = rows[0] ?? null;

  if (order === null) {
    // Заказ чужого склада в базу не попадает вовсе — сохранять его состав
    // тем более незачем.
    return { outcome: 'SKIPPED', changedFields: [] };
  }

  // Защита от устаревшего результата. Сравниваются моменты версий, а не ссылки:
  // `Date` из базы — новый объект при каждом чтении.
  if (input.expectedPendingVersion !== undefined) {
    const stored = order.fulfillmentPendingExternalUpdated;
    const expected = input.expectedPendingVersion;
    const same =
      stored === null
        ? expected === null
        : expected !== null && stored.getTime() === expected.getTime();
    if (!same) {
      return { outcome: 'STALE', changedFields: [] };
    }
  }

  if (input.snapshot === null) {
    return unconfirmed(tx, order, input, now);
  }

  return confirmed(tx, order, input.snapshot, input, now);
}

/**
 * Состав подтвердить не удалось.
 *
 * НИ ОДНО поле подтверждённой проекции не меняется: ни два текста, ни хеш,
 * ни позиции, ни ревизия. Подтверждённый снимок — это тексты И состав вместе,
 * поэтому записать сюда новые тексты значило бы собрать строку из двух внешних
 * версий сразу и выдать её за целую.
 *
 * Новая версия сохраняется отдельно, в ожидающих полях: очереди дозагрузки
 * этого достаточно, чтобы собрать снимок, не перечитывая документ заказа.
 *
 * Состояние `READY` при этом сохранить нельзя — заказ уже пришёл delta-проходом,
 * курсор уйдёт вперёд, и другого повода перечитать его не будет. Дозагрузка
 * идёт по состоянию, а не по изменению `updated`.
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
      // Ожидающая версия целиком: два проверенных текста и её момент.
      // Сырого ответа и JSON здесь нет.
      fulfillmentPendingDescription: input.texts.description,
      fulfillmentPendingCardText: input.texts.cardText,
      fulfillmentPendingExternalUpdated: input.externalUpdated,
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

/**
 * Тот же снимок подтверждён снова.
 *
 * Ни ревизии, ни аудита, ни realtime: продуктовые данные не менялись, а
 * уведомление «Заказ изменён» на неизменившемся заказе обесценивает само
 * уведомление. Проекция не пересоздаётся — она уже равна снимку.
 *
 * Уже подтверждённое и целое состояние не переписывается вовсе: перекрытие
 * delta-окна возвращает те же заказы каждые тридцать секунд, и «пустое»
 * обновление шло бы потоком, трогая `updatedAt` без причины.
 */
async function restore(
  tx: TransactionClient,
  order: StoredFulfillment,
  now: Date,
): Promise<ApplyFulfillmentResult> {
  const clean =
    order.fulfillmentCompositionState === 'READY' &&
    order.fulfillmentCompositionAttempts === 0 &&
    order.fulfillmentPendingExternalUpdated === null;

  if (clean) {
    return { outcome: 'UNCHANGED', changedFields: [] };
  }

  await tx.deliveryOrder.update({
    where: { id: order.id },
    data: {
      fulfillmentCompositionState: 'READY',
      fulfillmentCompositionSyncedAt: now,
      fulfillmentCompositionAttempts: 0,
      fulfillmentCompositionFailedAt: null,
      fulfillmentCompositionFailure: null,
      fulfillmentPendingDescription: null,
      fulfillmentPendingCardText: null,
      fulfillmentPendingExternalUpdated: null,
    },
  });

  return { outcome: 'RESTORED', changedFields: [] };
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

  // СОВПАЛ ХЕШ — ПРОДУКТОВЫХ ИЗМЕНЕНИЙ НЕТ, И НЕВАЖНО, В КАКОМ МЫ СОСТОЯНИИ.
  //
  // Раньше здесь дополнительно требовалось состояние `READY`, и это было
  // ошибкой. Последовательность «снимок A подтверждён → временный отказ
  // позиций → повтор снова подтвердил A» давала вторую ревизию A с пустым
  // списком изменений, запись `ORDER_FULFILLMENT_CHANGED` и realtime —
  // то есть будущее уведомление «Заказ изменён» на заказе, который не менялся.
  //
  // Совпадение полного хеша означает, что тексты и состав те же самые.
  // Восстановление — техническая запись, а не изменение.
  if (hash === order.fulfillmentSnapshotHash) {
    return restore(tx, order, now);
  }

  const previous = await previousSnapshot(tx, order.id);
  const changedFields = diffSnapshots(previous, snapshot);

  await replacePositions(tx, order.id, snapshot);

  await tx.deliveryOrder.update({
    where: { id: order.id },
    data: {
      // Подтверждённая версия становится целой одним движением: тексты, хеш
      // и состав — в одной транзакции с очисткой ожидающих полей. Инвариант
      // базы `READY_is_complete` не даст оставить их вместе.
      fulfillmentDescription: snapshot.description,
      fulfillmentCardText: snapshot.cardText,
      fulfillmentSnapshotHash: hash,
      fulfillmentCompositionState: 'READY',
      fulfillmentCompositionSyncedAt: now,
      fulfillmentCompositionAttempts: 0,
      fulfillmentCompositionFailedAt: null,
      fulfillmentCompositionFailure: null,
      fulfillmentPendingDescription: null,
      fulfillmentPendingCardText: null,
      fulfillmentPendingExternalUpdated: null,
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

  // ИЗМЕНЕНИЕ ПОСЛЕ СБОРКИ.
  //
  // Заказ уже собран, а данные приехали другие: продолжать считать его
  // собранным нельзя — к букету приложен бланк прежнего состава. Процесс
  // переводится в «Требует проверки» (`FUL-002` §2.6). Складскую приёмку это
  // не блокирует: физически переданный заказ обязан быть учтён.
  //
  // Использованная ревизия НЕ стирается: именно она доказывает, по каким
  // данным заказ собирали, и по ней же строится уже напечатанный бланк.
  //
  // Заказ В СБОРКЕ состояние не меняет: там достаточно уведомления «Заказ
  // изменён», а флорист продолжает работу по обновившейся карточке.
  if (order.fulfillmentProcessState === 'ASSEMBLED') {
    await tx.deliveryOrder.update({
      where: { id: order.id },
      data: {
        fulfillmentProcessState: 'NEEDS_REVIEW',
        fulfillmentProcessVersion: { increment: 1 },
      },
    });

    await writeOrderAudit(tx, 'ORDER_FULFILLMENT_REVIEW_REQUIRED', order.id, {
      changedFields,
      previousState: 'ASSEMBLED',
    });

    await publishRealtimeEvent(tx, {
      topic: 'order.fulfillment_process_changed',
      payload: { orderId: order.id, processState: 'NEEDS_REVIEW', assigned: true },
      audienceRoles: [...FULFILLMENT_AUDIENCE],
    });
  }

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
        uomId: position.uomId,
        uomName: position.uomName,
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
            uomId: component.uomId,
            uomName: component.uomName,
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
