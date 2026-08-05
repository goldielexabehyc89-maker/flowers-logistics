/**
 * Обработчики очереди.
 *
 * На этапе 1 внешних интеграций нет: единственный обработчик — внутренний,
 * без сети. Он существует, чтобы механика очереди (повторы, backoff, DEAD,
 * идемпотентность) была реально проверена, а не описана на словах.
 * Настоящие обработчики МоегоСклада появятся после исследования его API.
 */

import type { AppLogger } from '../../platform/logging/logger.js';
import type { OutboxHandler } from './worker.js';

/**
 * Тестовый обработчик. Сетевых вызовов не делает.
 * Если в payload есть `shouldFail: true`, обработчик падает — так проверяются
 * повторы и переход в DEAD без обращения к внешним системам.
 */
export function createTestPingHandler(logger: AppLogger): OutboxHandler {
  return async (message) => {
    const payload = (message.payload ?? {}) as { shouldFail?: unknown };

    if (payload.shouldFail === true) {
      throw new Error('тестовый обработчик намеренно завершился ошибкой');
    }

    logger.debug(
      { outbox: { id: message.id, topic: message.topic } },
      'обработано сообщение outbox',
    );
  };
}
