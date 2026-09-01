/**
 * Автоматическое распределение свободных заказов флористам.
 *
 * Запускается по событиям (готовность, появление заказа, завершение сборки,
 * согласованный отказ, завершённая пересборка, освобождение флориста) через
 * общий outbox-воркер — не по опросу браузера. Обработчик идемпотентен:
 * повторный прогон назначает лишь то, что свободно сейчас.
 *
 * Порядок заказов — единый серверный `sortQueue` (тот же, что видит флорист
 * в ручном режиме). Свободный флорист выбирается по «дольше всех готов без
 * работы», при равенстве — детерминированно (готовность → начало смены → id).
 * Весь прогон под транзакционной advisory-блокировкой: два параллельных
 * запуска не выдадут один заказ дважды и не дадут одному флористу два заказа.
 */

import type { Database } from '../../platform/db.js';
import type { TransactionClient } from '../auth/sessions.js';
import { readFloristDispatchMode } from '../settings/service.js';
import type { OutboxHandler } from '../outbox/worker.js';
import { autoAssignTx } from './assembly.js';
import { listDispatchableOrderIds } from './queue-service.js';

/** Ключ advisory-блокировки распределения: один на весь процесс. */
const DISPATCH_LOCK_KEY = 918_273_645;

const DISPATCH_CONTEXT = { ip: null, userAgent: null };

/** Флористы, готовые принять автозаказ, в порядке приоритета выдачи. */
async function availableFlorists(tx: TransactionClient): Promise<{ id: string; userId: string }[]> {
  const shifts = await tx.floristShift.findMany({
    where: {
      activeKey: { not: null },
      dispatchReadyAt: { not: null },
      dispatchFinishAfterCurrent: false,
      user: { status: 'ACTIVE', roles: { some: { role: 'FLORIST' } } },
    },
    // Дольше всех готов — первым; при равенстве детерминированно.
    orderBy: [{ dispatchReadyAt: 'asc' }, { startedAt: 'asc' }, { userId: 'asc' }],
    select: { id: true, userId: true },
  });

  const available: { id: string; userId: string }[] = [];
  for (const shift of shifts) {
    // Занят обычным заказом или пересборкой — пропускаем.
    const active = await tx.deliveryOrder.count({
      where: {
        fulfillmentAssigneeId: shift.userId,
        fulfillmentProcessState: { in: ['IN_ASSEMBLY', 'NEEDS_REVIEW'] },
      },
    });
    if (active > 0) {
      continue;
    }
    // Есть открытый запрос отказа — заказ ждёт решения, нового не даём.
    const pendingRefusal = await tx.orderRefusalRequest.count({
      where: { floristId: shift.userId, state: 'PENDING' },
    });
    if (pendingRefusal > 0) {
      continue;
    }
    available.push(shift);
  }
  return available;
}

/**
 * Раздаёт свободные заказы готовым флористам ВНУТРИ уже открытой транзакции.
 * Так распределение и запись в журнал outbox фиксируются вместе.
 */
export async function dispatchFloristsTx(
  tx: TransactionClient,
  now: Date = new Date(),
  operationsStartDate?: string | undefined,
): Promise<number> {
  {
    // Сериализуем весь прогон: два параллельных запуска не спорят за заказы.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DISPATCH_LOCK_KEY})`;

    const mode = await readFloristDispatchMode(tx);
    if (!mode.value.auto) {
      return 0;
    }

    const florists = await availableFlorists(tx);
    if (florists.length === 0) {
      return 0;
    }

    // Кандидаты раздачи — ТОТ ЖЕ список и порядок, что видит руководитель в
    // свободной очереди: одна функция, одна граница операций, одна сортировка.
    const orderIds = await listDispatchableOrderIds(tx, now, operationsStartDate);
    if (orderIds.length === 0) {
      return 0;
    }

    let assigned = 0;
    // Уже разобранные заказы: каждый флорист берёт верхний ещё свободный.
    const taken = new Set<string>();
    for (const florist of florists) {
      for (const orderId of orderIds) {
        if (taken.has(orderId)) {
          continue;
        }
        // В рамках этой попытки заказ не возвращается тому, чей отказ одобрен.
        const refused = await tx.orderRefusalRequest.count({
          where: { orderId, floristId: florist.userId, state: 'APPROVED' },
        });
        if (refused > 0) {
          continue;
        }
        const ok = await autoAssignTx(
          tx,
          { orderId, floristId: florist.userId, shiftId: florist.id, operationsStartDate },
          DISPATCH_CONTEXT,
        );
        // Успех — занят этим флористом; неуспех — заказ уже перехвачен,
        // в обоих случаях другим он больше не предлагается в этом прогоне.
        taken.add(orderId);
        if (ok) {
          assigned += 1;
          break;
        }
      }
    }
    return assigned;
  }
}

/** Раздаёт заказы в собственной транзакции (прямой вызов и тесты). */
export async function dispatchFlorists(
  db: Database,
  now: Date = new Date(),
  operationsStartDate?: string | undefined,
): Promise<number> {
  return db.$transaction((tx) => dispatchFloristsTx(tx, now, operationsStartDate));
}

/**
 * Обработчик outbox: запускает распределение в транзакции воркера.
 *
 * Граница операций передаётся из конфигурации (`config.OPERATIONS_START_DATE`) —
 * ровно та же, что у свободной очереди в маршрутах. Так кандидаты раздачи и
 * видимая очередь строятся по одному и тому же набору заказов.
 */
export function createDispatchHandler(operationsStartDate: string): OutboxHandler {
  return async (_message, tx) => {
    if (tx === undefined) {
      return;
    }
    await dispatchFloristsTx(tx, new Date(), operationsStartDate);
  };
}
