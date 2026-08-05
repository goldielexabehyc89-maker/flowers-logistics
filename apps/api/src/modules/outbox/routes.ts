/**
 * Административный доступ к очереди интеграции.
 *
 * Только `ADMIN`: очередь показывает, что и когда не удалось отправить наружу.
 * Исходный payload наружу не возвращается — он предназначен внешней системе,
 * а не интерфейсу, и может содержать больше, чем нужно администратору.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { AppError } from '../../platform/errors.js';
import { authenticateWithRoles } from '../auth/guards.js';
import { writeAudit } from '../audit/service.js';

const ADMIN_ONLY = ['ADMIN'] as const;

const idParamSchema = z.object({
  id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Некорректный id'),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

interface OutboxDeps {
  db: Database;
  config: AppConfig;
}

export async function registerOutboxRoutes(app: AppServer, deps: OutboxDeps): Promise<void> {
  app.get('/api/outbox/failures', async (request) => {
    await authenticateWithRoles(request, deps, ADMIN_ONLY);
    const { limit } = listQuerySchema.parse(request.query);

    const items = await deps.db.outboxMessage.findMany({
      where: { status: { in: ['ERROR', 'DEAD'] } },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      // payload сознательно не выбирается.
      select: {
        id: true,
        topic: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        lastError: true,
        nextAttemptAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return { items };
  });

  app.post('/api/outbox/failures/:id/retry', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ADMIN_ONLY);
    const { id } = idParamSchema.parse(request.params);

    return deps.db.$transaction(async (tx) => {
      const message = await tx.outboxMessage.findUnique({
        where: { id },
        select: { id: true, topic: true, status: true, attempts: true },
      });

      if (message === null) {
        throw new AppError('NOT_FOUND', { message: 'outbox message not found' });
      }

      if (message.status !== 'ERROR' && message.status !== 'DEAD') {
        throw new AppError('CONFLICT', {
          message: 'only failed messages can be retried',
          publicMessage: 'Повторить можно только сообщение с ошибкой.',
        });
      }

      await tx.outboxMessage.update({
        where: { id },
        data: {
          status: 'PENDING',
          // Счётчик попыток обнуляется: администратор осознанно даёт новый шанс,
          // иначе DEAD-сообщение немедленно вернулось бы в DEAD.
          attempts: 0,
          nextAttemptAt: new Date(),
          lockedAt: null,
          lockedBy: null,
        },
      });

      await writeAudit(tx, {
        action: 'OUTBOX_MESSAGE_RETRIED',
        entityType: 'OutboxMessage',
        entityId: id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        oldValue: { status: message.status, attempts: message.attempts },
        newValue: { status: 'PENDING', reason: 'manual-retry', topic: message.topic },
      });

      return { status: 'queued' };
    });
  });
}
