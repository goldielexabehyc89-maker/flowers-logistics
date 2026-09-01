/**
 * API складских ячеек.
 *
 * Права разделены намеренно. Читать справочник и разрешать отсканированный код
 * нужно кладовщику: без этого он не положит заказ на полку. Заводить полки,
 * менять их тип и выводить из работы может только администратор — это решение
 * уровня организации склада, а не рабочей смены.
 *
 * `DELETE` нет и не будет: ячейка деактивируется, но не стирается.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { AppError } from '../../platform/errors.js';
import { authenticateWithRoles, type AuthenticatedActor } from '../auth/guards.js';
import { expandRange, splitList } from './bulk-cells.js';
import { MAX_CODE_LENGTH } from './cell-code.js';
import { renderLabelsPdf, MAX_LABELS_PER_DOCUMENT } from '../printing/label-pdf.js';
import type { LabelContent } from '../printing/label.js';
import { listConfirmedRoutes, getRouteFlow, listPlacedOrders } from './views.js';
import {
  FLOW_ADMIN_ROLES,
  FLOW_ROLES,
  countActivePlacements,
  receiveOrder,
  withdrawOrder,
} from './placement.js';
import {
  bindRouteCell,
  cancelIssueSession,
  confirmCourier,
  checkOrderForIssue,
  pickOrderToRouteCell,
  resetIssueChecks,
  shipRoute,
} from './route-flow.js';
import { blockingFlags, resolveOrderByNumber } from './order-lookup.js';
import { readAssemblyBoard, readIssueBoard } from './assembly-board.js';
import { listAwaitingIntake, AWAITING_INTAKE_ROLES } from './awaiting.js';
import { readWarehouseManualEntry } from '../settings/service.js';
import { isCalendarDate } from '../integrations/moysklad/delivery-date.js';
import {
  CELL_READ_ROLES,
  CELL_WRITE_ROLES,
  MAX_LIMIT,
  changeStorageCellKind,
  createStorageCell,
  createStorageCellBatch,
  previewStorageCellBatch,
  getStorageCell,
  listStorageCells,
  resolveStorageCell,
  setStorageCellActive,
  type CellDeps,
  type OccupancyProbe,
  type RequestContext,
  type StorageCellRow,
} from './service.js';

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Некорректный id');

const idParamSchema = z.object({ id: uuid });

const kindSchema = z.enum(['STORAGE', 'ROUTE']);

const listQuerySchema = z.object({
  kind: kindSchema.optional(),
  isActive: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

const awaitingQuerySchema = z.object({
  /** Поиск по номеру: частичное совпадение без учёта регистра. */
  search: z.string().trim().max(120).optional(),
  /** Только счётчик вкладки: список не грузится, отдаётся полное число. */
  countOnly: z
    .enum(['0', '1'])
    .optional()
    .transform((value) => value === '1'),
});

const resolveQuerySchema = z.object({
  /** Сырое значение из сканера: нормализацию выполняет сервер. */
  code: z
    .string()
    .min(1)
    .max(MAX_CODE_LENGTH * 4),
});

const createSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(MAX_CODE_LENGTH * 4),
  kind: kindSchema,
});

const changeKindSchema = z.object({
  kind: kindSchema,
  expectedVersion: z.number().int().min(1),
});

const setActiveSchema = z.object({
  isActive: z.boolean(),
  expectedVersion: z.number().int().min(1),
});

interface WarehouseRouteDeps {
  db: Database;
  config: AppConfig;
  /**
   * Как узнать, пуста ли ячейка. Обязательная зависимость: пока модуля
   * По умолчанию подставляется фактический подсчёт активных размещений
   * (этап 6.5): смена типа снова стала возможной у пустой ячейки. Явная
   * подмена оставлена для тестов и для будущих реализаций.
   */
  occupancy?: OccupancyProbe;
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

function toView(cell: StorageCellRow) {
  return {
    id: cell.id,
    code: cell.code,
    normalizedCode: cell.normalizedCode,
    kind: cell.kind,
    isActive: cell.isActive,
    version: cell.version,
    createdAt: cell.createdAt.toISOString(),
    updatedAt: cell.updatedAt.toISOString(),
  };
}

/** Администратор видит и выключенные ячейки, кладовщик — только рабочие. */
function isAdmin(actor: AuthenticatedActor): boolean {
  return actor.roles.includes('ADMIN');
}

/**
 * Ввод партии: либо диапазон, либо готовый список.
 *
 * Два способа в одной схеме, а не два входа: и тот и другой дают на выходе
 * список кодов, и дальше их обрабатывает один и тот же разбор. Разведи мы их
 * по разным маршрутам — правила проверки однажды разошлись бы.
 */
const bulkSchema = z.object({
  kind: z.enum(['STORAGE', 'ROUTE']),
  range: z
    .object({
      prefix: z.string().max(MAX_CODE_LENGTH),
      from: z.number().int().min(0),
      to: z.number().int().min(0),
      pad: z.number().int().min(1).max(6),
    })
    .optional(),
  list: z.string().max(64_000).optional(),
});

/**
 * Ячейки, чьи этикетки печатаются одним документом.
 *
 * Предел тот же, что у партии создания: столько наклеек человек ещё способен
 * разложить за один раз, а рулон — выдержать без замены.
 */
const labelsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(MAX_LABELS_PER_DOCUMENT),
});

/**
 * Наклейка ячейки: QR несёт нормализованный код, подпись — его же.
 *
 * Подпись и QR берут ОДНО значение. Разойдись они, сканер и человек читали бы
 * с одной наклейки разные полки.
 */
function cellLabel(normalizedCode: string): LabelContent {
  return { qrText: normalizedCode, caption: normalizedCode };
}

/** Единственное место, где формируются заголовки документа этикеток. */
async function sendLabels(
  reply: {
    header: (name: string, value: string) => typeof reply;
    send: (payload: Buffer) => unknown;
  },
  labels: readonly LabelContent[],
  fileName: string,
): Promise<unknown> {
  const bytes = await renderLabelsPdf(labels);
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  return reply
    .header('content-type', 'application/pdf')
    .header('content-disposition', `attachment; filename="${safe}.pdf"`)
    .header('cache-control', 'no-store')
    .send(Buffer.from(bytes));
}

/** Один список кодов из любого способа ввода. */
function codesOf(body: z.infer<typeof bulkSchema>): string[] {
  const fromRange = body.range === undefined ? [] : expandRange(body.range);
  const fromList = body.list === undefined ? [] : splitList(body.list);
  return [...fromRange, ...fromList];
}

export async function registerWarehouseRoutes(
  app: AppServer,
  deps: WarehouseRouteDeps,
): Promise<void> {
  // Занятость ячейки теперь известна по-настоящему: это и есть та реализация,
  // ради которой в срезе 6.4 был заведён порт. `unknownOccupancy` остаётся
  // запасным поведением, если модуль подключат без неё.
  const cellDeps: CellDeps = {
    db: deps.db,
    occupancy:
      deps.occupancy ??
      (async (client, cellId) =>
        (await countActivePlacements(client, cellId)) === 0 ? 'EMPTY' : 'OCCUPIED'),
  };

  app.get('/api/storage-cells', async (request) => {
    const actor = await authenticateWithRoles(request, deps, CELL_READ_ROLES);
    const query = listQuerySchema.parse(request.query);

    // Ограничение выборки принудительное и серверное: скрыть выключенные
    // ячейки на клиенте означало бы отдать их тому, кто откроет ответ напрямую.
    const isActive = isAdmin(actor)
      ? query.isActive === undefined
        ? null
        : query.isActive === 'true'
      : true;

    const result = await listStorageCells(deps.db, {
      isActive,
      kind: query.kind ?? null,
      limit: query.limit,
      offset: query.offset,
    });

    return { ...result, items: result.items.map(toView) };
  });

  /**
   * Разрешение отсканированного кода.
   *
   * Отдельная операция, а не поиск по списку: сканер присылает одну строку,
   * и ответ обязан быть либо ровно одной ячейкой, либо честным отказом.
   */
  app.get('/api/storage-cells/resolve', async (request) => {
    const actor = await authenticateWithRoles(request, deps, CELL_READ_ROLES);
    const { code } = resolveQuerySchema.parse(request.query);

    return toView(await resolveStorageCell(deps.db, code, { onlyActive: !isAdmin(actor) }));
  });

  app.post('/api/storage-cells', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, CELL_WRITE_ROLES);
    const body = createSchema.parse(request.body);

    const created = await createStorageCell(cellDeps, actor, body, contextOf(request));
    return reply.code(201).send(toView(created));
  });

  /*
   * Партия ячеек.
   *
   * Права РОВНО те же, что у одиночного создания, и проверяются здесь, на
   * сервере: спрятанная кнопка защитой не является — запрос отправляют
   * и мимо интерфейса.
   */
  app.post('/api/storage-cells/bulk/preview', async (request) => {
    await authenticateWithRoles(request, deps, CELL_WRITE_ROLES);
    const body = bulkSchema.parse(request.body);

    return previewStorageCellBatch(deps.db, codesOf(body));
  });

  app.post('/api/storage-cells/bulk', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, CELL_WRITE_ROLES);
    const body = bulkSchema.parse(request.body);

    const result = await createStorageCellBatch(
      cellDeps,
      actor,
      { codes: codesOf(body), kind: body.kind },
      contextOf(request),
    );
    return reply.code(201).send(result);
  });

  /**
   * Смена типа. Кода среди изменяемых полей нет: он неизменяем, и это
   * подпирается триггером базы, а не только отсутствием поля в схеме запроса.
   */
  app.put('/api/storage-cells/:id/kind', async (request) => {
    const actor = await authenticateWithRoles(request, deps, CELL_WRITE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = changeKindSchema.parse(request.body);

    return toView(await changeStorageCellKind(cellDeps, actor, id, body, contextOf(request)));
  });

  app.put('/api/storage-cells/:id/active', async (request) => {
    const actor = await authenticateWithRoles(request, deps, CELL_WRITE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = setActiveSchema.parse(request.body);

    return toView(await setStorageCellActive(cellDeps, actor, id, body, contextOf(request)));
  });

  /**
   * Печатная этикетка одной ячейки — та же наклейка 58×40 мм, что у заказа.
   *
   * PDF, а не SVG: наклейку печатают на термопринтере рулоном, и размер
   * страницы обязан быть физическим. Прежний SVG растягивался под лист
   * и на ленту не годился.
   *
   * Кодируется РОВНО нормализованный код: ни идентификатора строки, ни адреса
   * сервиса. Этикетка обязана оставаться пригодной, даже если приложение
   * переедет на другой домен.
   */
  app.get('/api/storage-cells/:id/label.pdf', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, CELL_READ_ROLES);
    const { id } = idParamSchema.parse(request.params);

    const cell = await getStorageCell(deps.db, id);
    if (!isAdmin(actor) && !cell.isActive) {
      throw new AppError('NOT_FOUND', {
        message: 'storage cell is inactive',
        publicMessage: 'Ячейка выключена и в работе не используется.',
      });
    }

    return sendLabels(reply, [cellLabel(cell.normalizedCode)], `cell-${cell.normalizedCode}`);
  });

  /**
   * Этикетки нескольких ячеек одним документом.
   *
   * Одна страница — одна наклейка, порядок — порядок присланных
   * идентификаторов: кладовщик снимает ленту сверху вниз и раскладывает
   * наклейки по полкам, поэтому произвольная перестановка превратила бы
   * понятную последовательность в поиск.
   *
   * POST, а не GET: список ячеек бывает в сотни строк, и в адресную строку
   * он не помещается.
   */
  app.post('/api/storage-cells/labels.pdf', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, CELL_READ_ROLES);
    const body = labelsSchema.parse(request.body);

    const cells = await deps.db.storageCell.findMany({
      where: { id: { in: body.ids } },
      select: { id: true, normalizedCode: true, isActive: true },
    });

    const byId = new Map(cells.map((cell) => [cell.id, cell]));
    const ordered = body.ids.flatMap((id) => {
      const cell = byId.get(id);
      if (cell === undefined) {
        return [];
      }
      // Кладовщику выключенные полки не показываются нигде — и в печати тоже.
      return !isAdmin(actor) && !cell.isActive ? [] : [cell];
    });

    if (ordered.length === 0) {
      throw new AppError('NOT_FOUND', {
        message: 'no cells to print',
        publicMessage: 'Печатать нечего: ячейки не найдены.',
      });
    }

    return sendLabels(
      reply,
      ordered.map((cell) => cellLabel(cell.normalizedCode)),
      `cells-${ordered.length}`,
    );
  });
}

const orderNumberSchema = z.string().min(1).max(256);
const cellCodeSchema = z
  .string()
  .min(1)
  .max(MAX_CODE_LENGTH * 4);
const reasonSchema = z.string().trim().min(3).max(500);

const dateQuerySchema = z.object({
  deliveryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается дата в формате ГГГГ-ММ-ДД')
    .refine(isCalendarDate, 'Ожидается существующая дата'),
});

const placedQuerySchema = z.object({
  cellId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const receiveSchema = z.object({
  orderNumber: orderNumberSchema,
  cellCode: cellCodeSchema,
  /** Явное согласие положить заказ сразу в маршрутную ячейку. */
  allowRouteCell: z.boolean().optional(),
});

const withdrawSchema = z.object({
  orderNumber: orderNumberSchema,
  // Причина есть у изъятия отменённого букета — пересборка или списание, ровно
  // два значения, свободный текст нельзя посчитать. У простого «снять с
  // хранения» причины нет: коробку убрали с полки, особого исхода за этим нет.
  reason: z.enum(['REASSEMBLY', 'WRITE_OFF']).optional(),
});
const bindSchema = z.object({ cellCode: cellCodeSchema });
const pickSchema = z.object({
  orderNumber: orderNumberSchema,
  cellCode: cellCodeSchema,
  /** Назначить свободную маршрутную полку этому листу тем же действием. */
  bindIfFree: z.boolean().optional(),
});
const confirmCourierSchema = z.object({ courierUserId: uuid });
const cancelIssueSchema = z.object({
  reason: reasonSchema,
  /** Кому передать остаток. Без значения назначение маршрута не меняется. */
  nextCourierUserId: uuid.optional(),
});

/**
 * Складской поток: приёмка, комплектование и выдача.
 *
 * Регистрируется отдельной функцией, чтобы справочник ячеек и движение заказов
 * оставались читаемыми по отдельности. Права одинаковы у обеих групп, кроме
 * отмены выдачи: её выполняет только администратор.
 */
export async function registerWarehouseFlowRoutes(
  app: AppServer,
  deps: WarehouseRouteDeps,
): Promise<void> {
  const flowDeps = { db: deps.db };

  /** Что сейчас физически лежит на складе. */
  /**
   * Настройки рабочего места кладовщика.
   *
   * Отдельный запрос, а не общий экран настроек: у кладовщика нет прав
   * на настройки планирования, а знать, показывать ли поле ручного ввода,
   * он обязан. Значение читается, но не меняется — менять его может
   * только администратор в своём разделе.
   */
  app.get('/api/warehouse/settings', async (request) => {
    await authenticateWithRoles(request, deps, FLOW_ROLES);
    const manualEntry = await readWarehouseManualEntry(deps.db);
    return { manualEntry: manualEntry.value.enabled };
  });

  app.get('/api/warehouse/placements', async (request) => {
    await authenticateWithRoles(request, deps, FLOW_ROLES);
    const query = placedQuerySchema.parse(request.query);

    return listPlacedOrders(deps.db, {
      cellId: query.cellId ?? null,
      limit: query.limit,
      offset: query.offset,
    });
  });

  /**
   * «Ожидают приёмки»: собранные заказы без ячейки.
   *
   * Роли шире складского потока: раздел видит и менеджер выдачи (`MANAGER`).
   * Право проверяет сервер — скрытая вкладка чужой запрос не остановит. Сама
   * приёмка идёт прежним путём `POST /api/warehouse/placements`.
   */
  app.get('/api/warehouse/awaiting', async (request) => {
    await authenticateWithRoles(request, deps, AWAITING_INTAKE_ROLES);
    const query = awaitingQuerySchema.parse(request.query);
    return listAwaitingIntake(deps.db, { search: query.search, countOnly: query.countOnly });
  });

  /**
   * Контекст отсканированного заказа до выбора ячейки.
   *
   * Нужен вкладке «Склад»: пока человек не отсканировал ячейку, база
   * не меняется, но интерфейс уже обязан показать, входит ли заказ
   * в подтверждённый маршрут и есть ли у листа маршрутная ячейка.
   */
  app.get('/api/warehouse/scan/order', async (request) => {
    await authenticateWithRoles(request, deps, FLOW_ROLES);
    const { number } = z.object({ number: orderNumberSchema }).parse(request.query);

    const order = await resolveOrderByNumber(deps.db, number);
    const placement = await deps.db.orderPlacement.findFirst({
      where: { orderId: order.id, releasedAt: null },
      select: { requiresRelocation: true, cell: { select: { id: true, code: true, kind: true } } },
    });
    const participation = await deps.db.routeOrder.findFirst({
      where: { orderId: order.id, removedAt: null },
      select: {
        route: {
          select: {
            id: true,
            number: true,
            state: true,
            cellBindings: {
              where: { releasedAt: null },
              select: { cell: { select: { id: true, code: true } } },
            },
          },
        },
      },
    });

    const route = participation?.route ?? null;
    return {
      orderId: order.id,
      orderNumber: order.number,
      // Признаки берутся общей функцией: отменённый заказ обязан быть
      // назван отменённым и здесь, а не только в списке размещений.
      blockedBy: blockingFlags(order),
      needsAttention: order.needsAttention,
      currentCell:
        placement === null
          ? null
          : {
              id: placement.cell.id,
              code: placement.cell.code,
              kind: placement.cell.kind,
              requiresRelocation: placement.requiresRelocation,
            },
      route:
        route === null || route.state !== 'CONFIRMED'
          ? null
          : {
              id: route.id,
              number: route.number,
              // Ячеек у листа может быть несколько: экран показывает все,
              // потому что положить коробку можно в любую из них.
              routeCells: route.cellBindings.map((binding) => binding.cell),
            },
    };
  });

  /** Приёмка одной атомарной парой сканов. */
  app.post('/api/warehouse/placements', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLOW_ROLES);
    const body = receiveSchema.parse(request.body);

    return receiveOrder(
      flowDeps,
      actor,
      {
        orderNumber: body.orderNumber,
        cellCode: body.cellCode,
        ...(body.allowRouteCell === undefined ? {} : { allowRouteCell: body.allowRouteCell }),
      },
      contextOf(request),
    );
  });

  /** Изъятие со склада без выдачи: брак, отмена, возврат флористу. */
  app.post('/api/warehouse/placements/withdraw', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLOW_ROLES);
    const body = withdrawSchema.parse(request.body);

    return withdrawOrder(flowDeps, actor, body, contextOf(request));
  });

  /** Подтверждённые маршрутные листы выбранного московского дня. */
  app.get('/api/warehouse/routes', async (request) => {
    await authenticateWithRoles(request, deps, FLOW_ROLES);
    const { deliveryDate } = dateQuerySchema.parse(request.query);

    return { items: await listConfirmedRoutes(deps.db, deliveryDate) };
  });

  /**
   * Доска сборки: активные и собранные листы одним ответом.
   *
   * Порядок и разделение считает сервер по полному набору — клиент
   * упорядочил бы только загруженную страницу.
   */
  app.get('/api/warehouse/assembly', async (request) => {
    await authenticateWithRoles(request, deps, FLOW_ROLES);
    return readAssemblyBoard(deps.db);
  });

  /** Доска выдачи: курьеры, их листы и заказы. */
  app.get('/api/warehouse/issue-board', async (request) => {
    await authenticateWithRoles(request, deps, FLOW_ROLES);
    return { couriers: await readIssueBoard(deps.db) };
  });

  app.get('/api/warehouse/routes/:id', async (request) => {
    await authenticateWithRoles(request, deps, FLOW_ROLES);
    const { id } = idParamSchema.parse(request.params);

    const view = await getRouteFlow(deps.db, id);
    if (view === null) {
      throw new AppError('NOT_FOUND', { message: 'route not found' });
    }
    return view;
  });

  app.put('/api/warehouse/routes/:id/cell', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLOW_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = bindSchema.parse(request.body);

    return bindRouteCell(flowDeps, actor, id, body, contextOf(request));
  });

  app.post('/api/warehouse/routes/:id/pick', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLOW_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = pickSchema.parse(request.body);

    return pickOrderToRouteCell(flowDeps, actor, id, body, contextOf(request));
  });

  app.post('/api/warehouse/routes/:id/courier', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLOW_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = confirmCourierSchema.parse(request.body);

    return confirmCourier(flowDeps, actor, id, body, contextOf(request));
  });

  app.post('/api/warehouse/routes/:id/issue/check', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLOW_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = z.object({ orderNumber: orderNumberSchema }).parse(request.body);

    return checkOrderForIssue(flowDeps, actor, id, body, contextOf(request));
  });

  /** Сброс проверки: очищается только прогресс. */
  app.post('/api/warehouse/routes/:id/issue/checks/reset', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLOW_ROLES);
    const { id } = idParamSchema.parse(request.params);

    return resetIssueChecks(flowDeps, actor, id, contextOf(request));
  });

  /** Отгрузка ОДНОГО листа целиком одной транзакцией. */
  app.post('/api/warehouse/routes/:id/ship', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLOW_ROLES);
    const { id } = idParamSchema.parse(request.params);

    return shipRoute(flowDeps, actor, id, contextOf(request));
  });

  app.post('/api/warehouse/routes/:id/issue/cancel', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FLOW_ADMIN_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = cancelIssueSchema.parse(request.body);

    return cancelIssueSession(
      flowDeps,
      actor,
      id,
      {
        reason: body.reason,
        ...(body.nextCourierUserId === undefined
          ? {}
          : { nextCourierUserId: body.nextCourierUserId }),
      },
      contextOf(request),
    );
  });
}
