/**
 * Эскалация «логист не реагирует на задачу более 30 минут».
 *
 * ЧТО СЧИТАЕТСЯ ЗАДАЧЕЙ ЛОГИСТА. Только `OrderResolution` — задачи, требующие
 * решения логиста после недоставки/отмены (вкладка «Требуют решения»). Обычные
 * уведомления и запросы отказа флориста (адресованы руководителю) сюда не
 * входят.
 *
 * КАК. Периодический проход (общий maintenance-раннер, НЕ клиентский таймер)
 * находит открытые задачи старше порога, ещё не эскалированные, и РОВНО ОДИН
 * РАЗ создаёт всплывающее уведомление руководителям (ADMIN/SUPERVISOR — логист
 * тут и есть тот, кто не отреагировал). Дедуп постоянный и серверный: отметка
 * `escalatedAt` ставится УСЛОВНОЙ записью, поэтому перезапуск сервера, повторный
 * проход воркера и обновление страницы повтора не создают. Решённая раньше
 * порога задача не эскалируется вовсе; после эскалации история сохраняется,
 * повторных окон нет.
 */

import type { Database } from '../../platform/db.js';
import { publishRealtimeEvent } from '../realtime/events.js';

/** Порог: задача без реакции дольше этого времени поднимается руководителю. */
export const ESCALATION_THRESHOLD_MS = 30 * 60 * 1000;

/** `kind` уведомления-эскалации в общей системе «Уведомления». */
export const LOGIST_TASK_ESCALATION_KIND = 'LOGIST_TASK_ESCALATION';

/** Кому всплывает эскалация: только руководителям. */
const ESCALATION_AUDIENCE = ['ADMIN', 'SUPERVISOR'] as const;

/**
 * Находит просроченные нерешённые задачи логиста и эскалирует каждую ровно раз.
 * Возвращает число созданных эскалаций (0 — эскалировать нечего).
 */
export async function escalateOverdueResolutions(
  db: Database,
  input: { now?: Date } = {},
): Promise<number> {
  const now = input.now ?? new Date();
  const threshold = new Date(now.getTime() - ESCALATION_THRESHOLD_MS);

  const overdue = await db.orderResolution.findMany({
    where: {
      activeKey: { not: null }, // открытая задача (одна на заказ)
      decidedAt: null,
      closedAt: null,
      createdAt: { lt: threshold },
      escalatedAt: null,
    },
    select: { id: true, orderId: true, kind: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });

  let escalated = 0;
  for (const task of overdue) {
    const done = await db.$transaction(async (tx) => {
      // Дедуп: условная отметка. 0 строк — уже эскалировано (гонка/повтор/рестарт).
      const claimed = await tx.orderResolution.updateMany({
        where: { id: task.id, escalatedAt: null },
        data: { escalatedAt: now },
      });
      if (claimed.count === 0) {
        return false;
      }
      const created = await tx.orderChangeNotification.create({
        data: {
          orderId: task.orderId,
          source: 'SYSTEM',
          categories: [],
          kind: LOGIST_TASK_ESCALATION_KIND,
          // Только неперсональные поля: номер заказа и состояние берутся при
          // показе из связей уведомления, а не из payload.
          payload: {
            resolutionId: task.id,
            taskKind: task.kind,
            taskCreatedAt: task.createdAt.toISOString(),
          } as unknown as object,
        },
        select: { id: true },
      });
      await publishRealtimeEvent(tx, {
        topic: 'notification.created',
        audienceRoles: [...ESCALATION_AUDIENCE],
        payload: {
          notificationId: created.id,
          orderId: task.orderId,
          kind: LOGIST_TASK_ESCALATION_KIND,
        },
      });
      return true;
    });
    if (done) {
      escalated += 1;
    }
  }
  return escalated;
}

/**
 * Идентификаторы эскалаций, которые руководителю ещё показать — задача открыта
 * и уведомление НЕ прочитано ИМ. Догоняющее окно: онлайн видит живое событие,
 * офлайн — этот список при входе; после прочтения (показа) повторов нет, значит
 * «не более одного раза на руководителя».
 */
export async function listPendingEscalationNotificationIds(
  db: Database,
  userId: string,
): Promise<string[]> {
  const rows = await db.orderChangeNotification.findMany({
    where: {
      kind: LOGIST_TASK_ESCALATION_KIND,
      reads: { none: { userId } },
      // Решённая/закрытая задача повторно не всплывает (activeKey уникален —
      // у заказа не более одной открытой задачи).
      order: { resolutions: { some: { activeKey: { not: null }, decidedAt: null } } },
    },
    select: { id: true },
    orderBy: { occurredAt: 'asc' },
    take: 100,
  });
  return rows.map((row) => row.id);
}
