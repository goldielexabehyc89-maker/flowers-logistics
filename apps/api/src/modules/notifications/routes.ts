/**
 * Вкладка «Уведомления» логистов: список, счётчик, персональное прочтение и
 * решение «На пересборку».
 *
 * Доступ — LOGISTICIAN, SUPERVISOR, ADMIN. Право проверяет сервер отдельно на
 * каждом маршруте, а не скрытая вкладка. Персональные данные (адрес, состав)
 * отдаются только внутри ответа авторизованному сотруднику.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { authenticateWithRoles } from '../auth/guards.js';
import {
  NOTIFICATION_ROLES,
  countUnread,
  decideReassembly,
  getNotification,
  listNotifications,
  listReassemblyFlorists,
  markRead,
} from './service.js';
import { decideRefusal } from '../fulfillment/dispatch-florist.js';

const idParamSchema = z.object({ id: z.string().uuid() });
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const reassemblySchema = z.object({ floristId: z.string().uuid() });
/** Решения по отказу принимают только руководители. */
const REFUSAL_DECISION_ROLES = ['ADMIN', 'SUPERVISOR'] as const;
const refusalDecisionSchema = z.object({
  action: z.enum(['REJECT', 'APPROVE', 'TRANSFER']),
  floristId: z.string().uuid().nullish(),
});

export interface NotificationDeps {
  db: Database;
  config: AppConfig;
}

function contextOf(request: { ip: string; headers: Record<string, unknown> }): {
  ip: string | null;
  userAgent: string | null;
} {
  const agent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof agent === 'string' ? agent.slice(0, 255) : null,
  };
}

export function registerNotificationRoutes(app: AppServer, deps: NotificationDeps): void {
  /** Список уведомлений с персональной отметкой прочтения и счётчиком. */
  app.get('/api/logistics/notifications', async (request) => {
    const actor = await authenticateWithRoles(request, deps, NOTIFICATION_ROLES);
    const query = listQuerySchema.parse(request.query);
    return listNotifications(deps.db, {
      userId: actor.userId,
      limit: query.limit,
      offset: query.offset,
    });
  });

  /** Только счётчик непрочитанного для бейджа вкладки. */
  app.get('/api/logistics/notifications/count', async (request) => {
    const actor = await authenticateWithRoles(request, deps, NOTIFICATION_ROLES);
    return { unread: await countUnread(deps.db, actor.userId) };
  });

  /** Флористы на активной смене — для выбора при назначении пересборки. */
  app.get('/api/logistics/notifications/florists', async (request) => {
    await authenticateWithRoles(request, deps, NOTIFICATION_ROLES);
    return { items: await listReassemblyFlorists(deps.db) };
  });

  /** Одно уведомление с живым состоянием заказа (для всплывающего окна). */
  app.get('/api/logistics/notifications/:id', async (request) => {
    const actor = await authenticateWithRoles(request, deps, NOTIFICATION_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const notification = await getNotification(deps.db, { userId: actor.userId, id });
    if (notification === null) {
      return { notification: null };
    }
    return { notification };
  });

  /** Персональная отметка «прочитано»: только для текущего пользователя. */
  app.post('/api/logistics/notifications/:id/read', async (request) => {
    const actor = await authenticateWithRoles(request, deps, NOTIFICATION_ROLES);
    const { id } = idParamSchema.parse(request.params);
    await markRead(deps.db, actor, id);
    return { ok: true };
  });

  /** Глобальное идемпотентное решение «На пересборку» с выбранным флористом. */
  app.post('/api/logistics/notifications/:id/reassembly', async (request) => {
    const actor = await authenticateWithRoles(request, deps, NOTIFICATION_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = reassemblySchema.parse(request.body);
    return decideReassembly(
      deps.db,
      actor,
      { notificationId: id, floristId: body.floristId },
      contextOf(request),
    );
  });

  /**
   * Решение по запросу отказа: только ADMIN и SUPERVISOR.
   *
   * Логист видит уведомление, но решает руководитель — сервер проверяет роль,
   * а не скрытая кнопка.
   */
  app.post('/api/logistics/notifications/:id/refusal-decision', async (request) => {
    const actor = await authenticateWithRoles(request, deps, REFUSAL_DECISION_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = refusalDecisionSchema.parse(request.body);
    return decideRefusal(
      deps.db,
      actor,
      { notificationId: id, action: body.action, floristId: body.floristId ?? null },
      contextOf(request),
    );
  });
}
