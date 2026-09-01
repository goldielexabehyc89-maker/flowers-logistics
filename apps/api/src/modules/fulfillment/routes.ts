/**
 * API раздела флориста.
 *
 * ПРАВА. Читают и работают `ADMIN` и `FLORIST`; все остальные роли получают
 * 403, аноним — 401. Административные действия — принудительное завершение
 * смены, переназначение и возврат собранного заказа в работу — доступны только
 * `ADMIN`. Скрытая кнопка защитой не считается: решение принимает сервер.
 *
 * ДЕНЬ СЧИТАЕТ СЕРВЕР. Клиент присылает `today`/`tomorrow`, а не дату: браузер
 * к вычислению московского дня не допускается вовсе (`TZ-001`).
 *
 * ДОКУМЕНТЫ. PDF отдаётся с безопасными заголовками и без кэширования: бланк
 * содержит состав заказа, и его копия в кэше прокси никому не нужна.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { authenticateWithRoles } from '../auth/guards.js';
import { MoyskladClient } from '../integrations/moysklad/client.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { AppError } from '../../platform/errors.js';
import { isCalendarDate } from '../integrations/moysklad/delivery-date.js';
import { readOrderCard } from './card.js';
import { MAX_SEARCH_LENGTH, countActiveAssignments, readQueue } from './queue-service.js';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from './paging.js';
import { requirePhoto } from './photo.js';
import {
  listPrintJobs,
  markPrinted,
  renderJobDocument,
  renderOrderDocument,
  renderOrderLabel,
  renderJobLabel,
  retryPrint,
} from './print.js';
import { assembleOrder, claimOrder, reassignOrder, releaseOrder, reopenOrder } from './assembly.js';
import {
  floristDispatchStatus,
  setDispatchReady,
  setFinishAfterCurrent,
  requestRefusal,
} from './dispatch-florist.js';
import { buildFloristStatistics } from './statistics.js';
import {
  FLORIST_ADMIN_ROLES,
  FLORIST_ROLES,
  MAX_REASON_LENGTH,
  MIN_REASON_LENGTH,
  closeOwnShift,
  forceCloseShift,
  listActiveShifts,
  listAssignableFlorists,
  ownShift,
  setShiftPrintPoint,
  startShift,
  type RequestContext,
} from './shifts.js';

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Некорректный id');

const idParamSchema = z.object({ id: uuid });

/**
 * Точка печати смены.
 *
 * `null` допустим намеренно: работа без печати — обычный случай, пока
 * принтеров нет ни одного.
 */
const printPointSchema = z.object({ printPointId: uuid.nullable() });
const shiftStartSchema = z.object({ printPointId: uuid.nullable().optional() });

/**
 * Страница списка.
 *
 * Слишком большой `limit` отклоняется, а не молча урезается: клиент, попросивший
 * весь день одним ответом, обязан узнать об отказе, а не получить страницу
 * и решить, что заказов больше нет.
 */
const pageQueryShape = {
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
};

const queueQuerySchema = z.object({
  day: z.enum(['today', 'tomorrow']).default('today'),
  scope: z.enum(['general', 'mine']).default('general'),
  /**
   * Область «Моих заказов»: работа или собранные.
   *
   * Умолчание `work` намеренно: клиент, не знающий о разделении, получает
   * рабочий список, а не смесь работы с собранным.
   */
  group: z.enum(['work', 'assembled']).default('work'),
  /** Галочка «Все»: добавить назначенные заказы к общей очереди. */
  all: z.enum(['true', 'false']).default('false'),
  /** Точный или частичный номер заказа внутри выбранных дня и области. */
  search: z.string().max(MAX_SEARCH_LENGTH).optional(),
  ...pageQueryShape,
});

const reasonSchema = z.string().trim().min(MIN_REASON_LENGTH).max(MAX_REASON_LENGTH);

const reopenSchema = z.object({ reason: reasonSchema });
const assignSchema = z.object({
  floristId: uuid,
  reason: reasonSchema.optional(),
});
const assembleSchema = z.object({
  /** Версия процесса, которую видел флорист: чужое изменение обязано отказать. */
  expectedProcessVersion: z.number().int().min(0),
});

const printQuerySchema = z.object({
  filter: z.enum(['attention', 'printed', 'all']).default('attention'),
  /** «Общие»: задания всех флористов за последние двое суток. */
  general: z.enum(['true', 'false']).default('false'),
  ...pageQueryShape,
});

const statDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается дата ГГГГ-ММ-ДД')
  .refine(isCalendarDate, 'Ожидается существующая дата');

const statisticsQuerySchema = z.object({
  from: statDateSchema,
  to: statDateSchema,
});

export interface FloristRouteDeps {
  db: Database;
  config: AppConfig;
  /**
   * Клиент МоегоСклада для проксирования фотографий.
   *
   * `undefined` означает «собрать из конфигурации», `null` — «интеграции нет».
   * Явный `null` нужен тестам: ни одного сетевого обращения оттуда быть не должно.
   */
  moysklad?: MoyskladClient | null;
}

interface IncomingRequest {
  ip: string;
  headers: { authorization?: string | undefined; 'user-agent'?: string | undefined };
}

function contextOf(request: IncomingRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
  };
}

/**
 * Клиент интеграции.
 *
 * Без токена клиент не создаётся вовсе: так ни одно обращение к МоемуСкладу
 * физически невозможно в окружении, где интеграция не настроена.
 */
function resolveClient(deps: FloristRouteDeps): MoyskladClient | null {
  if (deps.moysklad !== undefined) {
    return deps.moysklad;
  }
  if (deps.config.MOYSKLAD_TOKEN === undefined) {
    return null;
  }
  return new MoyskladClient({
    config: {
      baseUrl: MOYSKLAD_BASE_URL,
      token: deps.config.MOYSKLAD_TOKEN,
      ids: MOYSKLAD_IDS,
      // Флорист читает состав из МоегоСклада — записи состояния здесь нет.
      orderStateSyncEnabled: false,
    },
  });
}

export async function registerFloristRoutes(app: AppServer, deps: FloristRouteDeps): Promise<void> {
  const client = resolveClient(deps);

  // --- Смена ----------------------------------------------------------------

  /**
   * Смена и число активных заказов флориста.
   *
   * `activeOrders` живёт РЯДОМ со сменой, а не внутри неё, и это не мелочь:
   * заказы остаются за человеком и после закрытия смены (`shifts.ts`), поэтому
   * число, спрятанное в `shift`, исчезало бы ровно тогда, когда важнее всего.
   * Запрос этого адреса выполняется на всех вкладках раздела, и счётчик виден
   * постоянно — в том числе там, где списка «Моих заказов» нет.
   */
  app.get('/api/florist/shift', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const [shift, activeOrders] = await Promise.all([
      ownShift(deps.db, actor.userId),
      countActiveAssignments(deps.db, actor.userId, deps.config.OPERATIONS_START_DATE),
    ]);
    return { shift, activeOrders };
  });

  /**
   * Начало смены. Здесь же выбирается точка печати.
   *
   * Выбор — часть начала работы, а не отдельная сессия со своим сроком жизни:
   * завершение смены снимает привязку само.
   */
  app.post('/api/florist/shift/start', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const body = shiftStartSchema.parse(request.body ?? {});
    return startShift(deps.db, actor, contextOf(request), {
      printPointId: body.printPointId ?? null,
    });
  });

  /**
   * Смена точки печати посреди смены.
   *
   * Флорист пересел за другой стол — наклейки должны пойти туда же. Тем же
   * маршрутом точка выбирается впервые, если смена была открыта до появления
   * печати: отдельного пути «сначала выбрать» не заводится.
   */
  app.post('/api/florist/shift/print-point', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const body = printPointSchema.parse(request.body ?? {});
    return {
      shift: await setShiftPrintPoint(deps.db, actor, body.printPointId, contextOf(request)),
    };
  });

  app.post('/api/florist/shift/close', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    return { shift: await closeOwnShift(deps.db, actor, contextOf(request)) };
  });

  /** Кто сейчас работает. Нужен администратору, чтобы понять, кому назначать. */
  app.get('/api/florist/shifts', async (request) => {
    await authenticateWithRoles(request, deps, FLORIST_ADMIN_ROLES);
    return { items: await listActiveShifts(deps.db) };
  });

  app.get('/api/florist/florists', async (request) => {
    await authenticateWithRoles(request, deps, FLORIST_ADMIN_ROLES);
    return { items: await listAssignableFlorists(deps.db) };
  });

  /**
   * Статистика смен флориста. ТОЛЬКО администратор: управляющему и остальным —
   * 403. Право проверяет сервер отдельным ролевым набором, а не скрытой кнопкой.
   */
  app.get('/api/florist/statistics', async (request) => {
    await authenticateWithRoles(request, deps, ['ADMIN']);
    const query = statisticsQuerySchema.parse(request.query);
    if (query.to < query.from) {
      throw new AppError('VALIDATION_FAILED', {
        publicMessage: 'Конец периода раньше его начала.',
      });
    }
    return buildFloristStatistics(deps.db, { from: query.from, to: query.to });
  });

  app.post('/api/florist/shifts/:id/force-close', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ADMIN_ROLES);
    const { id } = idParamSchema.parse(request.params);

    // Тело запроса не читается вовсе: причины у завершения смены нет.
    return forceCloseShift(deps.db, actor, { shiftId: id }, contextOf(request));
  });

  // --- Очередь и карточка ---------------------------------------------------

  app.get('/api/florist/queue', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const query = queueQuerySchema.parse(request.query);

    return readQueue(
      deps.db,
      { userId: actor.userId, roles: actor.roles },
      {
        day: query.day,
        scope: query.scope,
        group: query.group,
        includeAssigned: query.all === 'true',
        search: query.search ?? null,
        limit: query.limit,
        offset: query.offset,
        operationsStartDate: deps.config.OPERATIONS_START_DATE,
      },
    );
  });

  app.get('/api/florist/orders/:id', async (request) => {
    await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return { card: await readOrderCard(deps.db, id) };
  });

  // --- Автоматическое распределение (рабочее место флориста) ----------------

  /** Состояние распределения: режим, готовность, назначение, ожидающие. */
  app.get('/api/florist/dispatch/status', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    return floristDispatchStatus(deps.db, actor);
  });

  /** «Готов к заказам» / выход из готовности. */
  app.post('/api/florist/dispatch/ready', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { ready } = z.object({ ready: z.boolean() }).parse(request.body);
    await setDispatchReady(deps.db, actor, ready, contextOf(request));
    return { ok: true };
  });

  /** «Закончить после текущего». */
  app.post('/api/florist/dispatch/finish-after-current', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { value } = z.object({ value: z.boolean() }).parse(request.body);
    await setFinishAfterCurrent(deps.db, actor, value, contextOf(request));
    return { ok: true };
  });

  /** Запрос отказа от назначенного заказа с обязательной причиной. */
  app.post('/api/florist/orders/:id/refusal', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = z
      .object({
        reason: z.enum([
          'INSUFFICIENT_GOODS',
          'CANNOT_ASSEMBLE',
          'PHYSICALLY_IMPOSSIBLE',
          'WRONG_ASSIGNMENT',
          'OTHER',
        ]),
        comment: z.string().trim().max(1000).nullish(),
      })
      .parse(request.body);
    return requestRefusal(
      deps.db,
      actor,
      { orderId: id, reason: body.reason, comment: body.comment ?? null },
      contextOf(request),
    );
  });

  app.post('/api/florist/orders/:id/claim', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return claimOrder(deps.db, actor, id, contextOf(request));
  });

  app.post('/api/florist/orders/:id/release', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return releaseOrder(deps.db, actor, id, contextOf(request));
  });

  app.post('/api/florist/orders/:id/assign', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ADMIN_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = assignSchema.parse(request.body);

    return reassignOrder(
      deps.db,
      actor,
      { orderId: id, floristId: body.floristId, reason: body.reason ?? null },
      contextOf(request),
    );
  });

  app.post('/api/florist/orders/:id/assemble', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = assembleSchema.parse(request.body);

    return assembleOrder(
      deps.db,
      actor,
      { orderId: id, expectedProcessVersion: body.expectedProcessVersion },
      contextOf(request),
    );
  });

  app.post('/api/florist/orders/:id/reopen', async (request) => {
    // Флорист тоже возвращает собранный заказ на шаг назад — но только СВОЙ и
    // только на активной смене. Право флориста и ограничения проверяет
    // `reopenOrder`; администратор и управляющий сохраняют прежние права.
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = reopenSchema.parse(request.body);

    return reopenOrder(deps.db, actor, { orderId: id, reason: body.reason }, contextOf(request));
  });

  /**
   * Фотография номенклатуры.
   *
   * Байты проходят насквозь и нигде не сохраняются. Ответ не кэшируется и не
   * раскрывает источник; отсутствующее фото — обычный 404, который карточка
   * показывает как «Фото отсутствует».
   */
  app.get('/api/florist/assortment/:id/photo', async (request, reply) => {
    await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { id } = idParamSchema.parse(request.params);

    const photo = await requirePhoto({ db: deps.db, client }, id);

    return (
      reply
        .header('content-type', photo.contentType)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        // Показ, а не загрузка файла: имя источника наружу не уходит.
        .header('content-disposition', 'inline')
        .send(Buffer.from(photo.bytes))
    );
  });

  // --- Печать ---------------------------------------------------------------

  app.get('/api/florist/print-jobs', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const query = printQuerySchema.parse(request.query);
    return listPrintJobs(deps.db, {
      filter: query.filter,
      general: query.general === 'true',
      actorUserId: actor.userId,
      limit: query.limit,
      offset: query.offset,
    });
  });

  app.post('/api/florist/print-jobs/:id/retry', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return { job: await retryPrint(deps.db, actor, id, contextOf(request)) };
  });

  app.post('/api/florist/print-jobs/:id/printed', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return { job: await markPrinted(deps.db, actor, id, contextOf(request)) };
  });

  app.get('/api/florist/print-jobs/:id/document.pdf', async (request, reply) => {
    await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const document = await renderJobDocument(deps.db, id);
    return sendPdf(reply, document);
  });

  app.get('/api/florist/orders/:id/print-form.pdf', async (request, reply) => {
    await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const document = await renderOrderDocument(deps.db, id);
    return sendPdf(reply, document);
  });

  /*
   * Термоэтикетка 58×40 мм.
   *
   * Те же права, тот же снимок и то же задание, что и у бланка: этикетка —
   * другое представление одного документа, а не отдельная печать. Поэтому
   * отдельной отметки «этикетка напечатана» нет: историю ведёт задание.
   */
  app.get('/api/florist/print-jobs/:id/label.pdf', async (request, reply) => {
    await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const document = await renderJobLabel(deps.db, id);
    return sendPdf(reply, document);
  });

  app.get('/api/florist/orders/:id/label.pdf', async (request, reply) => {
    await authenticateWithRoles(request, deps, FLORIST_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const document = await renderOrderLabel(deps.db, id);
    return sendPdf(reply, document);
  });
}

/** Единственное место, где формируются заголовки печатного документа. */
function sendPdf(
  reply: {
    header: (name: string, value: string) => typeof reply;
    send: (payload: Buffer) => unknown;
  },
  document: { bytes: Uint8Array; fileName: string },
): unknown {
  return (
    reply
      .header('content-type', 'application/pdf')
      // Имя файла — только номер заказа: ни адреса, ни получателя.
      .header('content-disposition', `attachment; filename="${document.fileName}"`)
      // Бланк содержит состав заказа: копии в кэше прокси быть не должно.
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(document.bytes))
  );
}
