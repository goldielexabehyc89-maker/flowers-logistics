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
import { MAX_CODE_LENGTH } from './cell-code.js';
import { renderCellLabelSvg } from './qr.js';
import {
  CELL_READ_ROLES,
  CELL_WRITE_ROLES,
  MAX_LIMIT,
  changeStorageCellKind,
  createStorageCell,
  getStorageCell,
  listStorageCells,
  resolveStorageCell,
  setStorageCellActive,
  unknownOccupancy,
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
   * размещений нет, сюда передаётся `unknownOccupancy`, и смена типа честно
   * отказывает. Значения по умолчанию у параметра нет намеренно — иначе
   * следующий модуль мог бы молча не подключить проверку.
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

export async function registerWarehouseRoutes(
  app: AppServer,
  deps: WarehouseRouteDeps,
): Promise<void> {
  const cellDeps: CellDeps = { db: deps.db, occupancy: deps.occupancy ?? unknownOccupancy };

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
   * Печатная этикетка одной ячейки.
   *
   * SVG, а не PDF: он открывается и печатается из браузера без дополнительных
   * библиотек, а генерация остаётся детерминированной и проверяемой. Документ
   * самодостаточен — ни одной внешней ссылки, ни одного шрифта с чужого сервера.
   */
  app.get('/api/storage-cells/:id/label.svg', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, CELL_READ_ROLES);
    const { id } = idParamSchema.parse(request.params);

    const cell = await getStorageCell(deps.db, id);
    if (!isAdmin(actor) && !cell.isActive) {
      throw new AppError('NOT_FOUND', {
        message: 'storage cell is inactive',
        publicMessage: 'Ячейка выключена и в работе не используется.',
      });
    }

    // Кодируется РОВНО нормализованный код: ни идентификатора строки, ни адреса
    // сервиса. Этикетка обязана оставаться пригодной, даже если приложение
    // переедет на другой домен.
    return reply
      .header('content-type', 'image/svg+xml; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(renderCellLabelSvg(cell.normalizedCode));
  });
}
