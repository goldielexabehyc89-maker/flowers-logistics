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
import {
  decideRefusal,
  listPendingRefusalNotificationIds,
} from '../fulfillment/dispatch-florist.js';
import { listPendingEscalationNotificationIds } from './escalation.js';
import {
  NO_FLOWERS_ROLES,
  countOpenNoFlowersQuarantines,
  getNoFlowersByNotificationId,
  listNoFlowersQuarantines,
  listPendingNoFlowersNotificationIds,
  returnFromQuarantine,
} from '../fulfillment/no-flowers.js';

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
   * Догоняющий список НЕрешённых отказов для всплывающих окон руководителя.
   *
   * Живое событие видит только тот, кто был онлайн в момент отказа. Кто вошёл
   * позже, получает открытые (`PENDING`) отказы здесь и показывает их окнами —
   * решённые сюда не попадают и повторно не всплывают. Только ADMIN/SUPERVISOR:
   * решение по отказу принимают они.
   */
  app.get('/api/logistics/notifications/pending-refusals', async (request) => {
    await authenticateWithRoles(request, deps, REFUSAL_DECISION_ROLES);
    return { notificationIds: await listPendingRefusalNotificationIds(deps.db) };
  });

  /**
   * Догоняющие эскалации задач логиста для всплывающих окон руководителя.
   *
   * Живое событие видит только тот, кто был онлайн. Кто вошёл позже — получает
   * здесь ещё не прочитанные ИМ эскалации открытых задач и показывает их окном.
   * После прочтения (показа) повтора нет — «не более одного раза». Только
   * ADMIN/SUPERVISOR: логист и есть тот, кто не отреагировал.
   */
  app.get('/api/logistics/notifications/pending-escalations', async (request) => {
    const actor = await authenticateWithRoles(request, deps, REFUSAL_DECISION_ROLES);
    return { notificationIds: await listPendingEscalationNotificationIds(deps.db, actor.userId) };
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

  /**
   * Вкладка «Решения»: постоянный список карантина «Нет цветов» и счётчик.
   *
   * Доступ — менеджер выдачи (основной), а также ADMIN и SUPERVISOR. Право
   * проверяет сервер, а не скрытая вкладка.
   */
  app.get('/api/logistics/no-flowers/quarantines', async (request) => {
    await authenticateWithRoles(request, deps, NO_FLOWERS_ROLES);
    const { items, total } = await listNoFlowersQuarantines(deps.db);
    return { items, total };
  });

  /** Только счётчик открытых карантинов — для бейджа вкладки «Решения». */
  app.get('/api/logistics/no-flowers/count', async (request) => {
    await authenticateWithRoles(request, deps, NO_FLOWERS_ROLES);
    return { open: await countOpenNoFlowersQuarantines(deps.db) };
  });

  /** Карантин по идентификатору уведомления — для всплывающего окна. */
  app.get('/api/logistics/no-flowers/notification/:id', async (request) => {
    await authenticateWithRoles(request, deps, NO_FLOWERS_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return { quarantine: await getNoFlowersByNotificationId(deps.db, id) };
  });

  /**
   * Персональная отметка «прочитано» карантина для ответственного.
   *
   * Показ окна помечает его прочитанным, поэтому догоняющий запрос его больше
   * не вернёт — «не более одного раза». Задачу это НЕ закрывает: карантин
   * остаётся во вкладке «Решения» до возврата в очередь.
   */
  app.post('/api/logistics/no-flowers/notification/:id/read', async (request) => {
    const actor = await authenticateWithRoles(request, deps, NO_FLOWERS_ROLES);
    const { id } = idParamSchema.parse(request.params);
    await markRead(deps.db, actor, id);
    return { ok: true };
  });

  /** Возврат заказа из карантина в очередь (в конец). Идемпотентно. */
  app.post('/api/logistics/no-flowers/quarantines/:id/return', async (request) => {
    const actor = await authenticateWithRoles(request, deps, NO_FLOWERS_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return returnFromQuarantine(deps.db, actor, id, contextOf(request));
  });

  /**
   * Догоняющие окна карантина «Нет цветов» для ответственных при входе.
   *
   * Кто был офлайн в момент отказа, получает здесь ещё не прочитанные ИМ
   * карантины открытых задач и показывает окном один раз. Только
   * MANAGER/ADMIN/SUPERVISOR.
   */
  app.get('/api/logistics/notifications/pending-no-flowers', async (request) => {
    const actor = await authenticateWithRoles(request, deps, NO_FLOWERS_ROLES);
    return { notificationIds: await listPendingNoFlowersNotificationIds(deps.db, actor.userId) };
  });
}
