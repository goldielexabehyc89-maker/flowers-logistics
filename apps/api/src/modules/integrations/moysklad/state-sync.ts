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
import { MoyskladClient, MoyskladError } from './client.js';
import { MOYSKLAD_IDS } from './config.js';

/** Тема outbox для передачи состояния заказа. */
export const ORDER_STATE_TOPIC = 'moysklad.order_state';

/**
 * Куда переводим заказ в источнике.
 *
 *  * `delivering` — заказ вошёл в активную доставку (маршрут отгружен);
 *  * `completed`  — курьер отметил заказ доставленным;
 *  * `cancelled`  — логист подтвердил отмену.
 */
export type OrderStateTarget = 'delivering' | 'completed' | 'cancelled';

const TARGETS: readonly OrderStateTarget[] = ['delivering', 'completed', 'cancelled'];

/** UUID состояний из справочника МоегоСклада (не секрет, подтверждён аудитом). */
const STATE_ID: Record<OrderStateTarget, string> = {
  delivering: MOYSKLAD_IDS.states.delivering,
  completed: MOYSKLAD_IDS.states.completed,
  cancelled: MOYSKLAD_IDS.states.cancelled,
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
  const apply = async (tx: TransactionClient, orderId: string, stateId: string, seq: number) => {
    // Блокировка заказа: события одного заказа не обрабатываются одновременно
    // и не обгоняют друг друга даже при нескольких воркерах.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`moysklad-order-state:${orderId}`}))`;

    const state = await tx.orderMoyskladState.findUnique({
      where: { orderId },
      select: { appliedSeq: true },
    });

    if (state !== null && seq <= state.appliedSeq) {
      // Устаревшее или уже применённое событие: без регресса и без второй записи.
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
      create: { orderId, enqueuedSeq: seq, appliedSeq: seq, lastStateId: stateId },
      update: { appliedSeq: seq, lastStateId: stateId },
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
        await apply(tx, orderId, stateId, seq);
      } else {
        await deps.db.$transaction((own) => apply(own, orderId, stateId, seq), {
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
