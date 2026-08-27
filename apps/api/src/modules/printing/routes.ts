/**
 * API печати: точки, подключение агента и выдача заданий.
 *
 * ТРИ РАЗНЫХ ПОСЕТИТЕЛЯ, три способа доказать право:
 *
 *  * администратор — обычная сессия и роль: заводит точки и выпускает коды;
 *  * флорист — обычная сессия: выбирает точку на свою смену;
 *  * агент — постоянный токен в заголовке: сессии у него нет и быть не может,
 *    он не человек и в браузере не живёт.
 *
 * Агент ходит ТОЛЬКО исходящими запросами. Входящих портов на компьютере
 * флориста мы не открываем: это чужая машина в чужой сети, и открытый порт
 * на ней — обязательство, которое некому выполнять.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { AppError } from '../../platform/errors.js';
import { authenticateWithRoles } from '../auth/guards.js';
import { claimNextDelivery, reportDelivery } from '../fulfillment/print.js';
import type { PrintFormSnapshot } from '../fulfillment/print-form.js';
import { renderLabelBitmap } from './raster.js';
import { encodeTsplJob } from './tspl.js';
import {
  HEARTBEAT_INTERVAL_MS,
  MAX_POINT_NAME_LENGTH,
  PRINT_ADMIN_ROLES,
  clearTestRequest,
  createPrintPoint,
  disconnectPrintPoint,
  issuePairingCode,
  listPrintPoints,
  listSelectablePoints,
  pairAgent,
  pointByAgentToken,
  recordHeartbeat,
  requestTestPrint,
} from './service.js';

export interface PrintRouteDeps {
  db: Database;
  config: AppConfig;
}

const idParamSchema = z.object({ id: z.string().uuid() });
const nameSchema = z.object({ name: z.string().min(1).max(MAX_POINT_NAME_LENGTH) });

const pairSchema = z.object({
  code: z.string().min(4).max(16),
  computerName: z.string().min(1).max(200),
  printerName: z.string().min(1).max(200),
});

const resultSchema = z.object({ outcome: z.enum(['sent', 'failed', 'unknown']) });
const heartbeatSchema = z.object({ error: z.string().max(1000).nullable().optional() });

function contextOf(request: { ip?: string; headers: Record<string, unknown> }): {
  ip: string | null;
  userAgent: string | null;
} {
  const agent = request.headers['user-agent'];
  return {
    ip: request.ip ?? null,
    userAgent: typeof agent === 'string' ? agent.slice(0, 300) : null,
  };
}

/**
 * Право агента.
 *
 * Токен приходит заголовком `Authorization: Bearer`. Ни cookie, ни сессии:
 * агент — служба на чужом компьютере, и вся его личность — это одна строка,
 * которую он хранит в защищённом хранилище Windows.
 */
async function authenticateAgent(
  db: Database,
  request: { headers: Record<string, unknown> },
): Promise<{ id: string; name: string; testRequestedAt: Date | null }> {
  const header = request.headers['authorization'];
  const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';

  if (token === '') {
    throw new AppError('UNAUTHENTICATED', { message: 'agent token is missing' });
  }

  return pointByAgentToken(db, token);
}

/** Текст тестовой наклейки. Ни заказа, ни ячейки за ней не стоит. */
function testLabel(pointName: string): { qrText: string; caption: string } {
  return { qrText: `TEST-${pointName}`.slice(0, 48), caption: 'ТЕСТ' };
}

/** Готовое задание принтера из снимка бланка. Второго снимка не заводится. */
function tsplForSnapshot(snapshot: PrintFormSnapshot): string {
  const bitmap = renderLabelBitmap({
    qrText: snapshot.orderNumber,
    caption: snapshot.orderNumber,
  });
  return Buffer.from(encodeTsplJob([bitmap])).toString('base64');
}

export async function registerPrintingRoutes(app: AppServer, deps: PrintRouteDeps): Promise<void> {
  // --- Администратор ---------------------------------------------------------

  app.get('/api/print-points', async (request) => {
    await authenticateWithRoles(request, deps, PRINT_ADMIN_ROLES);
    return { items: await listPrintPoints(deps.db) };
  });

  app.post('/api/print-points', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, PRINT_ADMIN_ROLES);
    const body = nameSchema.parse(request.body);
    const point = await createPrintPoint(deps.db, actor, body, contextOf(request));
    return reply.code(201).send({ point });
  });

  /**
   * Код подключения. Возвращается РОВНО ОДИН раз.
   *
   * Ответ помечается как не подлежащий кэшированию: одноразовый код не должен
   * осесть ни в кэше браузера, ни в промежуточном узле.
   */
  app.post('/api/print-points/:id/pairing-code', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, PRINT_ADMIN_ROLES);
    const { id } = idParamSchema.parse(request.params);

    const issued = await issuePairingCode(
      deps.db,
      actor,
      id,
      deps.config.AUTH_PIN_PEPPER,
      contextOf(request),
    );

    return reply.header('cache-control', 'no-store').send(issued);
  });

  app.post('/api/print-points/:id/test', async (request) => {
    const actor = await authenticateWithRoles(request, deps, PRINT_ADMIN_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return { point: await requestTestPrint(deps.db, actor, id, contextOf(request)) };
  });

  app.post('/api/print-points/:id/disconnect', async (request) => {
    const actor = await authenticateWithRoles(request, deps, PRINT_ADMIN_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return { point: await disconnectPrintPoint(deps.db, actor, id, contextOf(request)) };
  });

  // --- Флорист ---------------------------------------------------------------

  /**
   * Точки, которые можно выбрать на смену.
   *
   * Отдельный маршрут от административного списка: флористу не нужно и нельзя
   * видеть состояние подключения чужих компьютеров, ошибки агентов и очереди.
   */
  app.get('/api/florist/print-points', async (request) => {
    await authenticateWithRoles(request, deps, ['ADMIN', 'FLORIST'] as const);
    const points = await listSelectablePoints(deps.db);
    return {
      items: points.map((point) => ({ id: point.id, name: point.name, state: point.state })),
    };
  });

  // --- Агент -----------------------------------------------------------------

  /**
   * Подключение по одноразовому коду.
   *
   * Единственный путь агента без токена. В ответе — постоянный токен, который
   * агент сохраняет у себя; на сервере остаётся только его хеш.
   */
  app.post('/api/print-agent/pair', async (request, reply) => {
    const body = pairSchema.parse(request.body);
    const paired = await pairAgent(deps.db, body, deps.config.AUTH_PIN_PEPPER);
    return reply.header('cache-control', 'no-store').send(paired);
  });

  /**
   * Опрос очереди.
   *
   * Один запрос делает три вещи: отмечает, что агент жив, отдаёт тестовый
   * отпечаток, если его просили, и выдаёт следующее задание в аренду.
   * Разделять это на три запроса значило бы утроить трафик ради стройности.
   *
   * Тестовый отпечаток идёт ПЕРВЫМ: у принтера стоит человек и ждёт бумагу.
   */
  app.post('/api/print-agent/poll', async (request) => {
    const point = await authenticateAgent(deps.db, request);
    const body = heartbeatSchema.parse(request.body ?? {});
    await recordHeartbeat(deps.db, point.id, { error: body.error ?? null });

    if (point.testRequestedAt !== null) {
      // Отметка гасится сразу: тестовый отпечаток — диагностика, человек стоит
      // рядом и нажмёт ещё раз, если бумага не вышла. Копить их незачем.
      await clearTestRequest(deps.db, point.id);
      const bitmap = renderLabelBitmap(testLabel(point.name));
      return {
        heartbeatMs: HEARTBEAT_INTERVAL_MS,
        job: {
          kind: 'TEST' as const,
          jobId: null,
          tspl: Buffer.from(encodeTsplJob([bitmap])).toString('base64'),
        },
      };
    }

    const claimed = await claimNextDelivery(deps.db, point.id);
    if (claimed === null) {
      return { heartbeatMs: HEARTBEAT_INTERVAL_MS, job: null };
    }

    return {
      heartbeatMs: HEARTBEAT_INTERVAL_MS,
      job: {
        kind: 'ORDER_LABEL' as const,
        jobId: claimed.jobId,
        attempt: claimed.attempt,
        tspl: tsplForSnapshot(claimed.snapshot),
      },
    };
  });

  /**
   * Итог задания.
   *
   * `unknown` — не отговорка, а важный исход: агент мог отдать задание спулеру
   * и не успеть сообщить об этом. Такое задание не повторяется автоматически.
   */
  app.post('/api/print-agent/jobs/:id/result', async (request) => {
    const point = await authenticateAgent(deps.db, request);
    const { id } = idParamSchema.parse(request.params);
    const body = resultSchema.parse(request.body);

    return reportDelivery(deps.db, { pointId: point.id, jobId: id, outcome: body.outcome });
  });
}
