/**
 * Постановка задачи автоматического распределения в outbox.
 *
 * Отдельный модуль без зависимостей от домена сборки: его вызывают доменные
 * операции (сборка, освобождение, готовность, согласованный отказ, появление
 * заказа), а сам движок распределения зависит от них — так замкнутого импорта
 * не возникает.
 *
 * Ключ уникален на каждое событие: воркер прогоняет идемпотентное
 * распределение, а не полагается на открытый браузер флориста.
 */

import { randomUUID } from 'node:crypto';
import type { TransactionClient } from '../auth/sessions.js';
import { enqueueOutbox } from '../outbox/producer.js';

export async function enqueueDispatch(tx: TransactionClient): Promise<void> {
  await enqueueOutbox(tx, {
    topic: 'florist.dispatch',
    idempotencyKey: `florist.dispatch:${randomUUID()}`,
    payload: {},
  });
}
