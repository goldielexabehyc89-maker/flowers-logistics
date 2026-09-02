/**
 * Передача СОСТОЯНИЯ заказа в МойСклад по бизнес-событиям.
 *
 * Правило централизовано: статус уходит наружу не из экранов и не из UI-компонентов,
 * а из доменных событий — активации маршрута, доставки конкретного заказа и
 * подтверждённой отмены. Каждое событие СНАЧАЛА фиксируется в ERP (в той же
 * транзакции, что и постановка в outbox), и только потом надёжной очередью
 * отправляется наружу. Локальная работа от доступности МоегоСклада не зависит.
 *
 * Безопасность обеспечивается тремя слоями:
 *
 *  * идемпотентность — ключом события в outbox и таблицей обработанных сообщений;
 *  * порядок ПО ЗАКАЗУ и защита от регресса — монотонный `seq` в
 *    `OrderMoyskladState`: событие применяется, только если его номер больше
 *    уже применённого. Устаревший повтор «Доставляется» после отправленного
 *    «Завершен»/«Отменен» имеет меньший номер и отбрасывается;
 *  * узкая запись — клиент меняет только поле `state` и только при включённом
 *    флаге; всё прочее по-прежнему запрещено.
 *
 * Петли входящей синхронизации нет по построению: наружу пишем ТОЛЬКО из этих
 * доменных событий, а импорт, читающий наше же состояние обратно, никаких
 * событий не ставит.
 */

import type { Database } from '../../../platform/db.js';
import type { TransactionClient } from '../../auth/sessions.js';
import type { AppLogger } from '../../../platform/logging/logger.js';
import { enqueueOutbox } from '../../outbox/producer.js';
import { PermanentOutboxError, type OutboxHandler } from '../../outbox/worker.js';
import { MoyskladError, type MoyskladClient } from './client.js';
import { MOYSKLAD_IDS } from './config.js';

/** Тема outbox для передачи состояния заказа. */
export const ORDER_STATE_TOPIC = 'moysklad.order_state';

/**
 * Куда переводим заказ в источнике.
 *
 *  * `awaiting_shipment` — заказ ДОСТАВКИ собран, ждёт отправку;
 *  * `ready_for_pickup`  — заказ САМОВЫВОЗА собран, готов к выдаче;
 *  * `delivering`        — заказ вошёл в активную доставку (маршрут отгружен);
 *  * `completed`         — курьер отметил заказ доставленным;
 *  * `cancelled`         — логист подтвердил отмену.
 */
export type OrderStateTarget =
  'awaiting_shipment' | 'ready_for_pickup' | 'delivering' | 'completed' | 'cancelled';

const TARGETS: readonly OrderStateTarget[] = [
  'awaiting_shipment',
  'ready_for_pickup',
  'delivering',
  'completed',
  'cancelled',
];

/** UUID состояний из справочника МоегоСклада (не секрет, подтверждён аудитом). */
const STATE_ID: Record<OrderStateTarget, string> = {
  awaiting_shipment: MOYSKLAD_IDS.states.awaitingShipment,
  ready_for_pickup: MOYSKLAD_IDS.states.readyForPickup,
  delivering: MOYSKLAD_IDS.states.delivering,
  completed: MOYSKLAD_IDS.states.completed,
  cancelled: MOYSKLAD_IDS.states.cancelled,
};

/**
 * Ранг стадии заказа. Более поздняя стадия НЕ откатывается более ранней, даже
 * если ранняя пришла позже (пересборка после отгрузки). `seq` упорядочивает
 * события внутри одного ранга; ранг — между стадиями.
 *
 *  * сборка (ожидает отправку / готов к самовывозу) = 1;
 *  * доставка = 2;
 *  * завершение/отмена = 3.
 */
const RANK: Record<OrderStateTarget, number> = {
  awaiting_shipment: 1,
  ready_for_pickup: 1,
  delivering: 2,
  completed: 3,
  cancelled: 3,
};

/** Ранг по UUID уже применённого состояния — чтобы старые строки без ранга
 * (до миграции `appliedRank`) не откатывались собранной стадией без backfill. */
const RANK_BY_STATE_ID: Record<string, number> = {
  [MOYSKLAD_IDS.states.awaitingShipment]: 1,
  [MOYSKLAD_IDS.states.readyForPickup]: 1,
  [MOYSKLAD_IDS.states.delivering]: 2,
  [MOYSKLAD_IDS.states.completed]: 3,
  [MOYSKLAD_IDS.states.cancelled]: 3,
};

/**
 * Предел времени транзакции обработчика.
 *
 * Внутри неё удерживается блокировка заказа и выполняется сетевая запись, чтобы
 * события одного заказа не обгоняли друг друга. Лимитер МоегоСклада может
 * выдержать паузу на `429`, поэтому предел заметно больше обычного запроса; если
 * он всё же превышен, транзакция откатывается, и outbox повторит сообщение.
 */
const HANDLER_TX_TIMEOUT_MS = 30_000;

export interface EnqueueOrderStateInput {
  orderId: string;
  target: OrderStateTarget;
  /**
   * Ключ идемпотентности события. Повторная постановка того же события дубликата
   * не создаёт (`ON CONFLICT DO NOTHING`). Строится из бизнес-события, а не из
   * счётчика: повтор доменной операции не должен слать статус дважды.
   */
  dedupeKey: string;
}

/**
 * Ставит одно событие смены состояния в outbox в ТЕКУЩЕЙ транзакции.
 *
 * Здесь же выдаётся монотонный по заказу номер `seq`: он и задаёт порядок, и
 * защищает от регресса на стороне обработчика. Полезная нагрузка — только
 * идентификатор заказа, цель и номер: ни адреса, ни получателя, ни телефона.
 */
export async function enqueueOrderStateSync(
  tx: TransactionClient,
  input: EnqueueOrderStateInput,
): Promise<void> {
  const row = await tx.orderMoyskladState.upsert({
    where: { orderId: input.orderId },
    create: { orderId: input.orderId, enqueuedSeq: 1 },
    update: { enqueuedSeq: { increment: 1 } },
    select: { enqueuedSeq: true },
  });

  await enqueueOutbox(tx, {
    topic: ORDER_STATE_TOPIC,
    idempotencyKey: input.dedupeKey,
    payload: { orderId: input.orderId, target: input.target, seq: row.enqueuedSeq },
  });
}

/**
 * Событие «маршрут отгружен» → «Доставляется» для всех заказов, реально
 * входящих в активную доставку.
 *
 * Вызывается ОДИН раз из единственного доменного перехода маршрута в ACTIVE
 * (`activateRouteWithinTransaction`), которым пользуются оба пути — ручная
 * отгрузка логистом и выдача со склада. Отменённые заказы исключаются: они
 * никуда не едут, и «Доставляется» для них было бы ложью.
 */
export async function enqueueRouteActivatedStateSync(
  tx: TransactionClient,
  routeId: string,
): Promise<void> {
  const orders = await tx.routeOrder.findMany({
    where: {
      routeId,
      removedAt: null,
      order: { cancelledInSource: false, cancelledByLogistAt: null },
    },
    select: { orderId: true },
  });

  for (const { orderId } of orders) {
    await enqueueOrderStateSync(tx, {
      orderId,
      target: 'delivering',
      dedupeKey: `${ORDER_STATE_TOPIC}:delivering:route:${routeId}:order:${orderId}`,
    });
  }
}

export interface OrderStateHandlerDeps {
  db: Database;
  client: MoyskladClient;
  logger: AppLogger;
  /**
   * Разрешена ли реальная запись. На local и staging — `false`: обработчик
   * сливает сообщения без единого обращения к живому МоемуСкладу. Контракт
   * проверяется подменным сервером в тестах.
   */
  enabled: boolean;
}

interface ParsedMessage {
  orderId: string;
  target: OrderStateTarget;
  seq: number;
}

function parsePayload(payload: unknown): ParsedMessage {
  const value = (payload ?? {}) as { orderId?: unknown; target?: unknown; seq?: unknown };
  if (
    typeof value.orderId !== 'string' ||
    typeof value.target !== 'string' ||
    !TARGETS.includes(value.target as OrderStateTarget) ||
    typeof value.seq !== 'number' ||
    !Number.isInteger(value.seq)
  ) {
    // Сообщение неизвестной формы повторять бессмысленно — оно таким и останется.
    throw new PermanentOutboxError('некорректная полезная нагрузка moysklad.order_state');
  }
  return { orderId: value.orderId, target: value.target as OrderStateTarget, seq: value.seq };
}

/**
 * Обработчик outbox: переводит состояние заказа в МоемСкладе.
 *
 * Идемпотентность и порядок: под блокировкой заказа читается `appliedSeq`, и
 * событие с номером не больше применённого пропускается — это и защита от
 * повторной записи, и защита от регресса. Успех фиксирует новый `appliedSeq`
 * в той же транзакции, что и запись наружу; повторная доставка того же
 * сообщения увидит уже применённый номер и второй записи не сделает.
 */
export function createMoyskladOrderStateHandler(deps: OrderStateHandlerDeps): OutboxHandler {
  /** Применяет одно событие в границах переданной транзакции. */
  const apply = async (
    tx: TransactionClient,
    orderId: string,
    target: OrderStateTarget,
    stateId: string,
    seq: number,
  ) => {
    // Блокировка заказа: события одного заказа не обрабатываются одновременно
    // и не обгоняют друг друга даже при нескольких воркерах.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`moysklad-order-state:${orderId}`}))`;

    const state = await tx.orderMoyskladState.findUnique({
      where: { orderId },
      select: { appliedSeq: true, appliedRank: true, lastStateId: true },
    });

    const rank = RANK[target];
    // Эффективный применённый ранг: у строк, синхронизированных ДО миграции
    // `appliedRank`, он выводится из последнего записанного UUID — так старую
    // «Доставляется» не откатит запоздавшая или пересобранная стадия сборки.
    const appliedRank =
      state === null
        ? 0
        : state.appliedRank > 0
          ? state.appliedRank
          : (RANK_BY_STATE_ID[state.lastStateId ?? ''] ?? 0);
    const appliedSeq = state?.appliedSeq ?? 0;

    // Регресс запрещён: более ранняя стадия не перезаписывает более позднюю.
    // Внутри одного ранга порядок держит seq.
    if (rank < appliedRank) {
      return;
    }
    if (rank === appliedRank && seq <= appliedSeq) {
      return;
    }

    const order = await tx.deliveryOrder.findUnique({
      where: { id: orderId },
      select: { externalId: true },
    });
    if (order === null) {
      throw new PermanentOutboxError('заказ для синхронизации состояния не найден');
    }

    await deps.client.putCustomerOrderState(order.externalId, stateId);

    await tx.orderMoyskladState.upsert({
      where: { orderId },
      create: {
        orderId,
        enqueuedSeq: seq,
        appliedSeq: seq,
        appliedRank: rank,
        lastStateId: stateId,
      },
      update: { appliedSeq: seq, appliedRank: rank, lastStateId: stateId },
    });
  };

  return async (message, tx) => {
    const { orderId, target, seq } = parsePayload(message.payload);

    if (!deps.enabled) {
      // Узкая синхронизация выключена (local/staging): реальной записи нет.
      // Сообщение считается обработанным — очередь не копит мусор, а живой
      // аккаунт не трогается.
      deps.logger.debug(
        { outbox: { topic: message.topic } },
        'узкая синхронизация состояния выключена — пропуск без записи',
      );
      return;
    }

    const stateId = STATE_ID[target];

    try {
      // Запись идёт В ТОЙ ЖЕ транзакции, в которой воркер держит сообщение:
      // отправка наружу, отметка обработки и новый `appliedSeq` фиксируются
      // атомарно. Прямой вызов без воркера (в тестах) открывает свою транзакцию.
      if (tx !== undefined) {
        await apply(tx, orderId, target, stateId, seq);
      } else {
        await deps.db.$transaction((own) => apply(own, orderId, target, stateId, seq), {
          timeout: HANDLER_TX_TIMEOUT_MS,
        });
      }
    } catch (error) {
      if (
        error instanceof MoyskladError &&
        (error.code === 'UNAUTHORIZED' ||
          error.code === 'FORBIDDEN' ||
          error.code === 'METHOD_NOT_ALLOWED' ||
          error.code === 'NOT_CONFIGURED')
      ) {
        // Окончательный отказ источника: повтор с тем же ключом ничего не изменит.
        throw new PermanentOutboxError(`МойСклад отклонил запись состояния: ${error.code}`);
      }
      // 429 и временные 5xx уже пережиты лимитером; всё остальное — обычный
      // повтор outbox с backoff.
      throw error;
    }
  };
}
